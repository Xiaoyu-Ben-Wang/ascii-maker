import { useCallback, useEffect, useRef, useState } from 'react';
import { frameFor, type SizeName } from '../../engine/index.ts';
import { download, extensionOf, uniqueName, zip } from '../lib/files.ts';
import { CanceledError, type Renderer, type VideoProgress } from '../lib/renderer.ts';
import { encodableFormats, evenSize, type VideoFormat } from '../lib/video.ts';
import type { Img } from './useCatalog.ts';

export const IMAGE_FORMATS = [
  { value: 'image/png', label: 'PNG' },
  { value: 'image/jpeg', label: 'JPEG' },
  { value: 'image/webp', label: 'WebP' },
];

export interface ExportSettings {
  size: SizeName;
  format: string;
  /** JPEG/WebP quality, 10..100. */
  quality: number;
  /** PNG zlib level, 0..9. */
  pngLevel: number;
  videoFormat: VideoFormat;
  videoQuality: number;
  keepAudio: boolean;
}

const DEFAULT_SETTINGS: ExportSettings = { size: 'source', format: 'image/png', quality: 92, pngLevel: 5, videoFormat: 'mp4', videoQuality: 50, keepAudio: true };

/** Progress of the running export: a label and 0..1, or null while it can't be measured. */
export interface Job { label: string; value: number | null }

/** Rejects with CanceledError as soon as `signal` aborts, without waiting for `p`. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CanceledError());
    signal.addEventListener('abort', () => reject(new CanceledError()), { once: true });
    p.then(resolve, reject);
  });
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function useExport(renderer: Renderer | null, images: Img[], active: Img | null, notify: (text: string) => void, ensure: (id: number) => Promise<Img | null>) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const update = useCallback((patch: Partial<ExportSettings>) => setSettings((s) => ({ ...s, ...patch })), []);
  const [job, setJob] = useState<Job | null>(null);
  const abort = useRef<AbortController | null>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  // Which video formats this browser can encode, checked for the active (or first) video.
  const sampleVideo = active?.kind === 'video' ? active : images.find((i) => i.kind === 'video') ?? null;
  const [encodable, setEncodable] = useState<VideoFormat[] | null>(null);
  const sampleW = sampleVideo?.width ?? 0, sampleH = sampleVideo?.height ?? 0;
  useEffect(() => {
    if (!sampleW) return;
    let live = true;
    const f = frameFor(sampleW, sampleH, settings.size);
    encodableFormats(f.width, f.height).then((ok) => {
      if (!live) return;
      setEncodable(ok);
      setSettings((s) => (ok.includes(s.videoFormat) || !ok.length ? s : { ...s, videoFormat: ok[0] }));
    });
    return () => { live = false; };
  }, [sampleW, sampleH, settings.size]);

  /** Renders one image, or every frame of a video, at the export size, with its own look. */
  const render = useCallback(async (item: Img, signal: AbortSignal, onFrame?: (v: VideoProgress, total: number) => void) => {
    const img = await abortable(ensure(item.id), signal);
    if (!img) throw new Error(`could not open ${item.name}`);
    const p = img.look.params;
    const s = settings;
    const f = frameFor(img.width, img.height, s.size);
    if (img.video) {
      const { width, height } = evenSize(f.width, f.height);
      const ok = await encodableFormats(width, height);
      const format = ok.includes(s.videoFormat) ? s.videoFormat : ok[0];
      if (!format) throw new Error('this browser cannot encode video');
      const total = Math.max(1, Math.round(img.video.info.duration * img.video.info.fps));
      const r = await renderer!.exportVideo(
        { sourceId: img.id, file: img.video.file, width, height, crop: f.crop, params: p, format, audio: s.keepAudio, quality: s.videoQuality / 100 },
        (v) => onFrame?.(v, Math.max(total, v.frame)), signal);
      return { blob: r.blob, width, height, ms: r.ms, name: `${img.name}-${p.style}.${format}` };
    }
    const r = await abortable(renderer!.export({ sourceId: img.id, width: f.width, height: f.height, crop: f.crop, params: p, mime: s.format, quality: s.quality / 100, pngLevel: s.pngLevel }), signal);
    return { ...r, name: `${img.name}-${p.style}.${extensionOf(s.format)}` };
  }, [renderer, settings, ensure]);

  const run = useCallback(async (initial: Job, body: (signal: AbortSignal) => Promise<string>) => {
    if (!renderer || abort.current) return;
    const ac = new AbortController();
    abort.current = ac;
    setJob(initial);
    try {
      notify(await body(ac.signal));
    } catch (e) {
      notify(e instanceof CanceledError ? 'Export canceled' : `Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      abort.current = null;
      setJob(null);
    }
  }, [renderer, notify]);

  const exportOne = useCallback((img: Img) => run({ label: img.kind === 'video' ? 'Starting…' : 'Rendering…', value: img.kind === 'video' ? 0 : null }, async (signal) => {
    const r = await render(img, signal, (v, total) => setJob({ label: `Frame ${v.frame} / ${total}`, value: v.progress }));
    download(r.blob, r.name);
    return `Exported ${r.width}×${r.height} in ${seconds(r.ms)}`;
  }), [run, render]);

  /** Exports the given creations (default: all), each with its own look, as a .zip. */
  const exportAll = useCallback((ids?: ReadonlySet<number>) => {
    const list = ids ? imagesRef.current.filter((i) => ids.has(i.id)) : imagesRef.current;
    if (!list.length) return;
    const n = list.length;
    const t0 = performance.now();
    return run({ label: `1 / ${n}`, value: 0 }, async (signal) => {
      const files: { name: string; blob: Blob }[] = [];
      const taken = new Set<string>();
      for (const [i, img] of list.entries()) {
        if (!imagesRef.current.some((x) => x.id === img.id)) continue;
        setJob({ label: `${i + 1} / ${n}`, value: i / n });
        const r = await render(img, signal, (v, total) => setJob({ label: `${i + 1} / ${n} · frame ${v.frame} / ${total}`, value: (i + v.progress) / n }));
        files.push({ name: uniqueName(r.name, taken), blob: r.blob });
      }
      setJob({ label: 'Zipping…', value: 1 });
      download(await abortable(zip(files), signal), 'ascii-maker.zip');
      return `Exported ${files.length} files in ${seconds(performance.now() - t0)}`;
    });
  }, [run, render]);

  const cancel = useCallback(() => abort.current?.abort(), []);

  return { settings, update, encodable, hasVideo: !!sampleVideo, job, exportOne, exportAll, cancel };
}

export type Exporter = ReturnType<typeof useExport>;
