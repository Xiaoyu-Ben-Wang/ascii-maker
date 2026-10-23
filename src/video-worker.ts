// Renders every frame of a video with the engine and encodes the result. One worker per export; terminate it to cancel.
import * as mb from 'mediabunny';
import { inputFormats } from './app/video.ts';
import { gpuOrCpu } from './engine/gpu.ts';
import { lockPalette, type HighlightMask, type Params } from './engine/index.ts';
import type { Crop } from './worker.ts';

export interface VideoJob {
  file: File; width: number; height: number; crop: Crop; params: Params; mask?: HighlightMask;
  format: 'mp4' | 'webm'; audio: boolean; gpu: boolean;
  /** Encoder quality, 0 (smallest) to 1 (best). */
  quality: number;
}

export type VideoWorkerMessage =
  | { type: 'progress'; progress: number; frame: number }
  | { type: 'done'; blob: Blob; frames: number; ms: number }
  | { type: 'error'; message: string };

const post = (msg: VideoWorkerMessage) => (self as unknown as Worker).postMessage(msg);
const createCanvas = (w: number, h: number) => new OffscreenCanvas(w, h);
const renderAny = gpuOrCpu();

self.onmessage = async (e: MessageEvent<VideoJob>) => {
  const job = e.data;
  const { width: w, height: h } = job;
  const t0 = performance.now();
  const input = new mb.Input({ source: new mb.BlobSource(job.file), formats: inputFormats(mb) });
  try {
    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: job.format === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat(), target });
    // Frames stay on the GPU: decoded into this canvas, uploaded from it, and rendered into a bitmap. Pixels are
    // read back only for the first frame's dither palette and for the CPU fallback.
    const srcCanvas = new OffscreenCanvas(w, h);
    const src = srcCanvas.getContext('2d')!;
    src.imageSmoothingQuality = 'high';
    const frameIn = { width: w, height: h, image: srcCanvas, read: () => src.getImageData(0, 0, w, h) };
    const out = new OffscreenCanvas(w, h);
    const outCtx = out.getContext('2d')!;
    let locked: Params | null = null;
    let frame = 0;

    const conversion = await mb.Conversion.init({
      input, output, tracks: 'primary', showWarnings: false,
      video: {
        crop: { left: job.crop.x, top: job.crop.y, width: job.crop.w, height: job.crop.h },
        width: w, height: h, fit: 'fill', codec: job.format === 'mp4' ? 'avc' : 'vp9', quality: new mb.Quality(job.quality), forceTranscode: true,
        process: (sample) => {
          sample.draw(src, 0, 0, w, h);
          // The first frame fixes an "auto" dither palette so colors don't flicker frame to frame.
          locked ??= job.params.style === 'dither' && job.params.palette === 'auto' ? lockPalette(frameIn.read(), job.params) : job.params;
          const { r } = renderAny.bitmap(frameIn, locked, { createCanvas, mask: job.mask, frame: frame++ }, job.gpu);
          outCtx.drawImage(r.bitmap, 0, 0, w, h);
          r.bitmap.close();
          return out;
        },
      },
      audio: job.audio ? {} : { discard: true },
    });
    if (!conversion.isValid) throw new Error(conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ') || 'nothing to convert');
    let last = 0;
    conversion.onProgress = (progress) => {
      const now = performance.now();
      if (now - last < 100 && progress < 1) return;
      last = now;
      post({ type: 'progress', progress, frame });
    };
    await conversion.execute();
    const blob = new Blob([target.buffer!], { type: job.format === 'mp4' ? 'video/mp4' : 'video/webm' });
    post({ type: 'done', blob, frames: frame, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    input.dispose();
  }
};
