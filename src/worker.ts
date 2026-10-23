// Runs the engine off the main thread. Each source bitmap is sent once; renders come back as transferable bitmaps.
import { RenderCache, render, type HighlightMask, type Params } from './engine/index.ts';
import { encodePng } from './engine/png.ts';

/** Region of the source to use, in source pixels. */
export interface Crop { x: number; y: number; w: number; h: number }

export type WorkerRequest =
  | { type: 'source'; sourceId: number; bitmap: ImageBitmap }
  | { type: 'drop'; sourceId: number }
  | { type: 'mask'; sourceId: number; mask: HighlightMask | null }
  | { type: 'render'; reqId: number; sourceId: number; width: number; height: number; crop: Crop; targetWidth: number; params: Params }
  | { type: 'export'; reqId: number; sourceId: number; width: number; height: number; crop: Crop; params: Params; mime: string; quality: number; pngLevel: number };

export type WorkerResponse =
  | { type: 'rendered'; reqId: number; bitmap: ImageBitmap; text?: string; ms: number }
  | { type: 'exported'; reqId: number; blob: Blob; width: number; height: number; text?: string; ms: number }
  | { type: 'error'; reqId: number; message: string };

const sources = new Map<number, ImageBitmap>();
const masks = new Map<number, HighlightMask>();
const sized = new Map<string, ImageData>();
/** Byte budget for resized sources; enough for the active image's draft + preview plus a batch of thumbnails. */
const SIZED_BUDGET = 160 * 1024 * 1024;
let sizedBytes = 0;
function forget(key: string) {
  const img = sized.get(key);
  if (img) { sizedBytes -= img.data.byteLength; sized.delete(key); }
}
const cache = new RenderCache(192);

const keyOf = (id: number, w: number, h: number, c: Crop) => `${id}:${w}x${h}@${c.x},${c.y},${c.w},${c.h}`;

/** The cropped source resampled to width×height, memoized for the few sizes the editor uses. */
function sourceAt(id: number, width: number, height: number, crop: Crop): ImageData {
  const key = keyOf(id, width, height, crop);
  let img = sized.get(key);
  if (img) {
    sized.delete(key); // re-insert below to mark as most recently used
  } else {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sources.get(id)!, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
    img = ctx.getImageData(0, 0, width, height);
    sizedBytes += img.data.byteLength;
    while (sizedBytes > SIZED_BUDGET && sized.size) forget(sized.keys().next().value!);
  }
  sized.set(key, img);
  return img;
}

const createCanvas = (w: number, h: number) => new OffscreenCanvas(w, h);

/** The source's mask with the crop mapped into mask pixels (the mask spans the whole source). */
function maskFor(id: number, crop: Crop): HighlightMask | undefined {
  const m = masks.get(id), src = sources.get(id);
  if (!m || !src) return undefined;
  const kx = m.width / src.width, ky = m.height / src.height;
  return { ...m, region: { x: crop.x * kx, y: crop.y * ky, w: crop.w * kx, h: crop.h * ky } };
}

function toCanvas(data: Uint8ClampedArray, w: number, h: number) {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return c;
}

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'source') {
    sources.get(msg.sourceId)?.close();
    sources.set(msg.sourceId, msg.bitmap);
    return;
  }
  if (msg.type === 'mask') {
    if (msg.mask) masks.set(msg.sourceId, msg.mask);
    else masks.delete(msg.sourceId);
    return;
  }
  if (msg.type === 'drop') {
    sources.get(msg.sourceId)?.close();
    sources.delete(msg.sourceId);
    masks.delete(msg.sourceId);
    for (const k of [...sized.keys()]) if (k.startsWith(`${msg.sourceId}:`)) forget(k);
    return;
  }
  try {
    if (!sources.has(msg.sourceId)) throw new Error('stale source');
    const t0 = performance.now();
    const img = sourceAt(msg.sourceId, msg.width, msg.height, msg.crop);
    const mask = maskFor(msg.sourceId, msg.crop);
    if (msg.type === 'render') {
      const sourceKey = `${msg.sourceId}:${msg.crop.x},${msg.crop.y},${msg.crop.w},${msg.crop.h}`;
      const r = render(img, msg.params, { createCanvas, targetWidth: msg.targetWidth, cache, sourceKey, mask });
      const bitmap = toCanvas(r.data, r.width, r.height).transferToImageBitmap();
      post({ type: 'rendered', reqId: msg.reqId, bitmap, text: r.text, ms: performance.now() - t0 }, [bitmap]);
    } else {
      const r = render(img, msg.params, { createCanvas, mask });
      forget(keyOf(msg.sourceId, msg.width, msg.height, msg.crop)); // full-size buffers are large; don't keep them around
      const blob = msg.mime === 'image/png'
        ? new Blob([encodePng(r.data, r.width, r.height, msg.pngLevel) as Uint8Array<ArrayBuffer>], { type: 'image/png' })
        : await toCanvas(r.data, r.width, r.height).convertToBlob({ type: msg.mime, quality: msg.quality });
      post({ type: 'exported', reqId: msg.reqId, blob, width: r.width, height: r.height, text: r.text, ms: performance.now() - t0 });
    }
  } catch (err) {
    post({ type: 'error', reqId: msg.reqId, message: err instanceof Error ? err.message : String(err) });
  }
};
