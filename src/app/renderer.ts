import type { Params } from '../engine/index.ts';
import type { Crop, WorkerRequest, WorkerResponse } from '../worker.ts';

export type Rendered = Extract<WorkerResponse, { type: 'rendered' }>;
type Exported = Extract<WorkerResponse, { type: 'exported' }>;
type Job = Extract<WorkerRequest, { type: 'render' }>;
type ExportJob = Extract<WorkerRequest, { type: 'export' }>;
export type PreviewArgs = Omit<Job, 'type' | 'reqId'>;

/** Long edge of the copies the thumbnail workers render from. */
const THUMB_SOURCE = 1280;

/** One worker with "latest wins" channels: a newer request replaces that channel's queued one (which resolves null). */
class Lane {
  private worker!: Worker;
  private reqId = 0;
  private waiters = new Map<number, (r: WorkerResponse) => void>();
  private busy = false;
  private queue = new Map<string, { args: PreviewArgs; resolve: (r: Rendered | null) => void }>();
  private onCrash: () => void;
  private priority: string | null;
  /** True while a respawned worker is being re-seeded with sources; jobs wait in the queue. */
  paused = false;

  constructor(onCrash: () => void, priority: string | null = null) {
    this.onCrash = onCrash;
    this.priority = priority;
    this.spawn();
  }

  private spawn() {
    this.worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const cb = this.waiters.get(e.data.reqId);
      this.waiters.delete(e.data.reqId);
      cb?.(e.data);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      // Settle everything in flight, then start over with a fresh worker (the owner re-sends sources).
      const waiting = [...this.waiters];
      this.waiters.clear();
      this.worker.terminate();
      this.paused = true;
      this.spawn();
      for (const [reqId, cb] of waiting) cb({ type: 'error', reqId, message: 'renderer crashed' });
      this.onCrash();
    };
  }

  terminate() {
    this.worker.terminate();
    for (const q of this.queue.values()) q.resolve(null);
    this.queue.clear();
    for (const [reqId, cb] of this.waiters) cb({ type: 'error', reqId, message: 'stale source' });
    this.waiters.clear();
  }

  post(msg: WorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }

  drop(sourceId: number) {
    for (const [ch, q] of this.queue) if (q.args.sourceId === sourceId) { q.resolve(null); this.queue.delete(ch); }
    this.post({ type: 'drop', sourceId });
  }

  send(msg: Omit<Job, 'reqId'> | Omit<ExportJob, 'reqId'>): Promise<WorkerResponse> {
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
    if (r.type === 'error') {
      if (r.message !== 'stale source' && r.message !== 'renderer crashed') console.error(r.message);
      resolve(null);
    } else resolve(r as Rendered);
    this.pump();
  }
}

/**
 * Render workers: one "main" worker holds full-resolution sources for the editor preview and exports, and a small pool
 * renders grid thumbnails in parallel from downscaled copies. Each image belongs to one pool lane (id % lanes).
 */
export class Renderer {
  static MAIN = 'main';
  private main: Lane;
  private pool: Lane[];
  /** Caller-owned source bitmaps, kept so a crashed worker can be re-seeded. */
  private sources = new Map<number, ImageBitmap>();
  /** Thumbnail-copy scale per source, to map full-resolution crops onto the copies. */
  private thumbScale = new Map<number, number>();
  private onRestart: () => void;

  /** `onRestart` runs after a crashed worker has been re-seeded; callers should re-request their renders. */
  constructor(onRestart: () => void) {
    this.onRestart = onRestart;
    this.main = new Lane(() => this.reseed(this.main, true), Renderer.MAIN);
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    this.pool = Array.from({ length: n }, (_, i) => {
      const lane: Lane = new Lane(() => this.reseed(lane, false, i));
      return lane;
    });
  }

  private async reseed(lane: Lane, full: boolean, index = 0) {
    for (const [id, bitmap] of this.sources) {
      if (!full && id % this.pool.length !== index) continue;
      try {
        const copy = full ? await createImageBitmap(bitmap) : await this.thumbCopy(id, bitmap);
        if (this.sources.has(id)) lane.post({ type: 'source', sourceId: id, bitmap: copy }, [copy]);
        else copy.close();
      } catch { /* source was closed meanwhile */ }
    }
    lane.resume();
    this.onRestart();
  }

  private thumbCopy(sourceId: number, bitmap: ImageBitmap) {
    const k = Math.min(1, THUMB_SOURCE / Math.max(bitmap.width, bitmap.height));
    this.thumbScale.set(sourceId, k);
    return createImageBitmap(bitmap, { resizeWidth: Math.max(1, Math.round(bitmap.width * k)), resizeHeight: Math.max(1, Math.round(bitmap.height * k)), resizeQuality: 'high' });
  }

  terminate() {
    this.main.terminate();
    this.pool.forEach((l) => l.terminate());
  }

  private lane(sourceId: number) {
    return this.pool[sourceId % this.pool.length];
  }

  /** Copies are made from `bitmap`; the caller keeps ownership and must call dropSource before closing it. */
  async addSource(sourceId: number, bitmap: ImageBitmap) {
    this.sources.set(sourceId, bitmap);
    const [full, small] = await Promise.all([createImageBitmap(bitmap), this.thumbCopy(sourceId, bitmap)]);
    if (!this.sources.has(sourceId)) { full.close(); small.close(); return; } // removed while copying
    this.main.post({ type: 'source', sourceId, bitmap: full }, [full]);
    this.lane(sourceId).post({ type: 'source', sourceId, bitmap: small }, [small]);
  }

  dropSource(sourceId: number) {
    this.sources.delete(sourceId);
    this.thumbScale.delete(sourceId);
    this.main.drop(sourceId);
    this.lane(sourceId).drop(sourceId);
  }

  /** Main-view preview; resolves null when superseded. */
  preview(args: PreviewArgs): Promise<Rendered | null> {
    return this.main.preview(Renderer.MAIN, args);
  }

  /** Grid thumbnail, rendered by the pool from the downscaled copy; resolves null when superseded. */
  thumb(args: PreviewArgs): Promise<Rendered | null> {
    const k = this.thumbScale.get(args.sourceId) ?? 1;
    const c = args.crop;
    const crop = { x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k };
    return this.lane(args.sourceId).preview(`thumb:${args.sourceId}`, { ...args, crop });
  }

  async export(args: Omit<ExportJob, 'type' | 'reqId'>): Promise<Exported> {
    const r = await this.main.send({ type: 'export', ...args });
    if (r.type === 'error') throw new Error(r.message);
    return r as Exported;
  }
}

export type { Crop };
