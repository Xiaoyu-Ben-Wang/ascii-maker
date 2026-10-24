// Runs the engine off the main thread. Each source bitmap is sent once; renders come back as transferable bitmaps.
import { gpuOrCpu } from '../engine/gpu/index.ts';
import { RenderCache, cropMask, type Crop, type HighlightMask } from '../engine/index.ts';
import { encodePng } from '../engine/png.ts';
import { STALE, type ExportJob, type RenderJob, type RenderRequest, type RenderResponse } from './protocol.ts';

const sources = new Map<number, ImageBitmap>();
/** Bumped when a source's pixels are replaced (a new video frame), so cached intermediates are not reused. */
const versions = new Map<number, number>();
const masks = new Map<number, HighlightMask>();
const cache = new RenderCache(192);
const renderer = gpuOrCpu();
const createCanvas = (w: number, h: number) => new OffscreenCanvas(w, h);
let gpuEnabled = true;

/** The cropped source resampled to the few sizes the editor uses, LRU within a byte budget. */
const sized = new Map<string, ImageData>();
const SIZED_BUDGET = 160 * 1024 * 1024;
let sizedBytes = 0;

const sizedKey = (id: number, w: number, h: number, c: Crop) => `${id}:${w}x${h}@${c.x},${c.y},${c.w},${c.h}`;

function forget(key: string) {
  const img = sized.get(key);
  if (img) { sizedBytes -= img.data.byteLength; sized.delete(key); }
}

function forgetSource(id: number) {
  for (const k of [...sized.keys()]) if (k.startsWith(`${id}:`)) forget(k);
}

function sourceAt(id: number, width: number, height: number, crop: Crop): ImageData {
  const key = sizedKey(id, width, height, crop);
  let img = sized.get(key);
  if (img) {
    sized.delete(key);
  } else {
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sources.get(id)!, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
    img = ctx.getImageData(0, 0, width, height);
    sizedBytes += img.data.byteLength;
    while (sizedBytes > SIZED_BUDGET && sized.size) forget(sized.keys().next().value!);
  }
  sized.set(key, img);
  return img;
}

function maskFor(id: number, crop: Crop): HighlightMask | undefined {
  const m = masks.get(id), src = sources.get(id);
  return m && src ? cropMask(m, src.width, src.height, crop) : undefined;
}

const post = (msg: RenderResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

function preview(msg: RenderJob, t0: number) {
  const img = sourceAt(msg.sourceId, msg.width, msg.height, msg.crop);
  const sourceKey = `${msg.sourceId}.${versions.get(msg.sourceId) ?? 0}:${msg.crop.x},${msg.crop.y},${msg.crop.w},${msg.crop.h}`;
  const opts = { createCanvas, targetWidth: msg.targetWidth, cache, sourceKey, mask: maskFor(msg.sourceId, msg.crop) };
  const { r, gpu } = renderer.bitmap(img, msg.params, opts, gpuEnabled);
  post({ type: 'rendered', reqId: msg.reqId, bitmap: r.bitmap, text: r.text, ms: performance.now() - t0, gpu }, [r.bitmap]);
}

async function exportImage(msg: ExportJob, t0: number) {
  const img = sourceAt(msg.sourceId, msg.width, msg.height, msg.crop);
  const { r, gpu } = renderer.data(img, msg.params, { createCanvas, mask: maskFor(msg.sourceId, msg.crop) }, gpuEnabled);
  // Full-size buffers are large; don't keep them around.
  forget(sizedKey(msg.sourceId, msg.width, msg.height, msg.crop));
  let blob: Blob;
  if (msg.mime === 'image/png') {
    blob = new Blob([encodePng(r.data, r.width, r.height, msg.pngLevel) as Uint8Array<ArrayBuffer>], { type: 'image/png' });
  } else {
    const c = new OffscreenCanvas(r.width, r.height);
    c.getContext('2d')!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
    blob = await c.convertToBlob({ type: msg.mime, quality: msg.quality });
  }
  post({ type: 'exported', reqId: msg.reqId, blob, width: r.width, height: r.height, text: r.text, ms: performance.now() - t0, gpu });
}

self.onmessage = async (e: MessageEvent<RenderRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'source':
      if (sources.has(msg.sourceId)) {
        sources.get(msg.sourceId)!.close();
        forgetSource(msg.sourceId);
        versions.set(msg.sourceId, (versions.get(msg.sourceId) ?? 0) + 1);
      }
      sources.set(msg.sourceId, msg.bitmap);
      return;
    case 'mask':
      if (msg.mask) masks.set(msg.sourceId, msg.mask);
      else masks.delete(msg.sourceId);
      return;
    case 'gpu':
      gpuEnabled = msg.enabled;
      return;
    case 'drop':
      sources.get(msg.sourceId)?.close();
      sources.delete(msg.sourceId);
      masks.delete(msg.sourceId);
      versions.delete(msg.sourceId);
      forgetSource(msg.sourceId);
      return;
  }
  try {
    if (!sources.has(msg.sourceId)) throw new Error(STALE);
    const t0 = performance.now();
    if (msg.type === 'render') preview(msg, t0);
    else await exportImage(msg, t0);
  } catch (err) {
    post({ type: 'error', reqId: msg.reqId, message: err instanceof Error ? err.message : String(err) });
  }
};
