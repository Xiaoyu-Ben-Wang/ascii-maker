import { cropMask, type HighlightMask } from '../../engine/index.ts';
import {
  CRASHED, STALE, type ExportJob, type Exported, type RenderJob, type RenderRequest, type RenderResponse, type Rendered, type VideoJob, type VideoMessage,
} from '../../workers/protocol.ts';

export type PreviewArgs = Omit<RenderJob, 'reqId'>;
export type VideoExportArgs = Omit<VideoJob, 'mask' | 'gpu'> & { sourceId: number };
export interface VideoProgress { progress: number; frame: number }
export class CanceledError extends Error { constructor() { super('canceled'); } }

/** Long edge of the copies the thumbnail workers render from. */
const THUMB_SOURCE = 1280;
const MAIN = 'main';

/** One worker with "latest wins" channels: a newer request replaces that channel's queued one, which resolves null. */
class Lane {
  private worker!: Worker;
  private reqId = 0;
  private waiters = new Map<number, (r: RenderResponse) => void>();
  private queue = new Map<string, { args: PreviewArgs; resolve: (r: Rendered | null) => void }>();
  private busy = false;
  /** While a respawned worker is being re-seeded with sources, jobs wait in the queue. */
  private paused = false;
  private onCrash: () => void;
  private priority: string | null;
  private gpu: boolean;

  constructor(onCrash: () => void, priority: string | null, gpu: boolean) {
    this.onCrash = onCrash;
    this.priority = priority;
    this.gpu = gpu;
    this.spawn();
  }

  private spawn() {
    this.worker = new Worker(new URL('../../workers/render.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({ type: 'gpu', enabled: this.gpu } satisfies RenderRequest);
    this.worker.onmessage = (e: MessageEvent<RenderResponse>) => {
      const cb = this.waiters.get(e.data.reqId);
      this.waiters.delete(e.data.reqId);
      cb?.(e.data);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      const waiting = [...this.waiters];
      this.waiters.clear();
      this.worker.terminate();
      this.paused = true;
      this.spawn();
      for (const [reqId, cb] of waiting) cb({ type: 'error', reqId, message: CRASHED });
      this.onCrash();
    };
  }

  setGpu(enabled: boolean) {
    this.gpu = enabled;
    this.post({ type: 'gpu', enabled });
  }

  terminate() {
    this.worker.terminate();
    for (const q of this.queue.values()) q.resolve(null);
    this.queue.clear();
    for (const [reqId, cb] of this.waiters) cb({ type: 'error', reqId, message: STALE });
    this.waiters.clear();
  }

  post(msg: RenderRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }

  drop(sourceId: number) {
    for (const [ch, q] of this.queue) if (q.args.sourceId === sourceId) { q.resolve(null); this.queue.delete(ch); }
    this.post({ type: 'drop', sourceId });
  }

  send(msg: Omit<Extract<RenderRequest, { type: 'render' | 'export' }>, 'reqId'>): Promise<RenderResponse> {
    const reqId = ++this.reqId;
    return new Promise((resolve) => {
      this.waiters.set(reqId, resolve);
      this.worker.postMessage({ ...msg, reqId });
    });
  }

  preview(channel: string, args: PreviewArgs): Promise<Rendered | null> {
    return new Promise((resolve) => {
      this.queue.get(channel)?.resolve(null);
      this.queue.set(channel, { args, resolve });
      this.pump();
    });
  }

  resume() {
    this.paused = false;
    this.pump();
  }

  private async pump() {
    if (this.busy || this.paused || !this.queue.size) return;
    const channel = this.priority && this.queue.has(this.priority) ? this.priority : this.queue.keys().next().value!;
    const { args, resolve } = this.queue.get(channel)!;
    this.queue.delete(channel);
    this.busy = true;
    const r = await this.send({ type: 'render', ...args });
    this.busy = false;
    if (r.type === 'rendered') resolve(r);
    else {
      if (r.type === 'error' && r.message !== STALE && r.message !== CRASHED) console.error(r.message);
      resolve(null);
    }
    this.pump();
  }
}

/**
 * Render workers: a main worker holds full-resolution sources for the editor preview and exports, and a small pool
 * renders grid thumbnails in parallel from downscaled copies. Each image belongs to one pool lane (id % lanes).
 */
export class Renderer {
  private main: Lane;
  private pool: Lane[];
  /** Caller-owned source bitmaps, kept so a crashed worker can be re-seeded. */
  private sources = new Map<number, ImageBitmap>();
  private masks = new Map<number, HighlightMask>();
  /** Scale of each thumbnail copy, to map full-resolution crops onto it. */
  private thumbScale = new Map<number, number>();
  private onRestart: () => void;
  private gpu: boolean;

  /** `onRestart` runs once a crashed worker has been re-seeded; callers should then re-request their renders. */
  constructor(onRestart: () => void, gpu = true) {
    this.onRestart = onRestart;
    this.gpu = gpu;
    this.main = new Lane(() => this.reseed(this.main, true), MAIN, gpu);
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    this.pool = Array.from({ length: n }, (_, i) => {
      const lane: Lane = new Lane(() => this.reseed(lane, false, i), null, gpu);
      return lane;
    });
  }

  private async reseed(lane: Lane, full: boolean, index = 0) {
    for (const [id, bitmap] of this.sources) {
      if (!full && id % this.pool.length !== index) continue;
      try {
        const copy = full ? await createImageBitmap(bitmap) : await this.thumbCopy(id, bitmap);
        // A source replaced meanwhile (a new video frame) was already posted by its own addSource.
        if (this.sources.get(id) === bitmap) lane.post({ type: 'source', sourceId: id, bitmap: copy }, [copy]);
        else copy.close();
        const mask = this.masks.get(id);
        if (mask) lane.post({ type: 'mask', sourceId: id, mask });
      } catch { /* the source was closed meanwhile */ }
    }
    lane.resume();
    this.onRestart();
  }

  private thumbCopy(sourceId: number, bitmap: ImageBitmap) {
    const k = Math.min(1, THUMB_SOURCE / Math.max(bitmap.width, bitmap.height));
    this.thumbScale.set(sourceId, k);
    return createImageBitmap(bitmap, { resizeWidth: Math.max(1, Math.round(bitmap.width * k)), resizeHeight: Math.max(1, Math.round(bitmap.height * k)), resizeQuality: 'high' });
  }

  private lane(sourceId: number) {
    return this.pool[sourceId % this.pool.length];
  }

  terminate() {
    this.main.terminate();
    this.pool.forEach((l) => l.terminate());
  }

  setGpu(enabled: boolean) {
    this.gpu = enabled;
    this.main.setGpu(enabled);
    this.pool.forEach((l) => l.setGpu(enabled));
  }

  /** Workers get copies of `bitmap`; the caller keeps it and must call dropSource before closing it. */
  async addSource(sourceId: number, bitmap: ImageBitmap) {
    this.sources.set(sourceId, bitmap);
    const [full, small] = await Promise.all([createImageBitmap(bitmap), this.thumbCopy(sourceId, bitmap)]);
    if (!this.sources.has(sourceId)) { full.close(); small.close(); return; }
    this.main.post({ type: 'source', sourceId, bitmap: full }, [full]);
    this.lane(sourceId).post({ type: 'source', sourceId, bitmap: small }, [small]);
  }

  setMask(sourceId: number, mask: HighlightMask | null) {
    if (mask) this.masks.set(sourceId, mask);
    else this.masks.delete(sourceId);
    this.main.post({ type: 'mask', sourceId, mask });
    this.lane(sourceId).post({ type: 'mask', sourceId, mask });
  }

  dropSource(sourceId: number) {
    this.sources.delete(sourceId);
    this.masks.delete(sourceId);
    this.thumbScale.delete(sourceId);
    this.main.drop(sourceId);
    this.lane(sourceId).drop(sourceId);
  }

  /** Resolves null when superseded. */
  preview(args: PreviewArgs): Promise<Rendered | null> {
    return this.main.preview(MAIN, args);
  }

  /** Rendered from the downscaled copy; resolves null when superseded. */
  thumb(args: PreviewArgs): Promise<Rendered | null> {
    const k = this.thumbScale.get(args.sourceId) ?? 1;
    const c = args.crop;
    return this.lane(args.sourceId).preview(`thumb:${args.sourceId}`, { ...args, crop: { x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k } });
  }

  async export(args: Omit<ExportJob, 'reqId'>): Promise<Exported> {
    const r = await this.main.send({ type: 'export', ...args });
    if (r.type === 'error') throw new Error(r.message);
    return r as Exported;
  }

  /** Renders and encodes every frame in a worker of its own; aborting stops it and rejects with CanceledError. */
  exportVideo({ sourceId, ...job }: VideoExportArgs, onProgress: (p: VideoProgress) => void, signal?: AbortSignal) {
    const m = this.masks.get(sourceId), src = this.sources.get(sourceId);
    const mask = m && src ? cropMask(m, src.width, src.height, job.crop) : undefined;
    return new Promise<{ blob: Blob; frames: number; ms: number }>((resolve, reject) => {
      if (signal?.aborted) return reject(new CanceledError());
      const worker = new Worker(new URL('../../workers/video.ts', import.meta.url), { type: 'module' });
      const stop = () => { worker.terminate(); signal?.removeEventListener('abort', cancel); };
      const cancel = () => { stop(); reject(new CanceledError()); };
      signal?.addEventListener('abort', cancel);
      worker.onmessage = (e: MessageEvent<VideoMessage>) => {
        const d = e.data;
        if (d.type === 'progress') onProgress(d);
        else if (d.type === 'done') { stop(); resolve(d); }
        else { stop(); reject(new Error(d.message)); }
      };
      worker.onerror = (e) => { e.preventDefault(); stop(); reject(new Error(e.message || 'video export crashed')); };
      worker.postMessage({ ...job, mask, gpu: this.gpu } satisfies VideoJob);
    });
  }
}
