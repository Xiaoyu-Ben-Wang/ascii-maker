// Renders every frame of a video and encodes the result. One worker per export; terminating it cancels.
import * as mb from 'mediabunny';
import { VIDEO_FORMATS, inputFormats } from '../app/lib/video.ts';
import { gpuOrCpu } from '../engine/gpu/index.ts';
import { lockPalette, usesDither, type Params } from '../engine/index.ts';
import type { VideoJob, VideoMessage } from './protocol.ts';

const post = (msg: VideoMessage) => (self as unknown as Worker).postMessage(msg);
const createCanvas = (w: number, h: number) => new OffscreenCanvas(w, h);
const renderer = gpuOrCpu();

self.onmessage = async (e: MessageEvent<VideoJob>) => {
  const job = e.data;
  const { width: w, height: h } = job;
  const format = VIDEO_FORMATS.find((f) => f.value === job.format)!;
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
        width: w, height: h, fit: 'fill', codec: format.codec, quality: new mb.Quality(job.quality), forceTranscode: true,
        process: (sample) => {
          sample.draw(src, 0, 0, w, h);
          locked ??= usesDither(job.params) && job.params.palette === 'auto' ? lockPalette(frameIn.read(), job.params) : job.params;
          const { r } = renderer.bitmap(frameIn, locked, { createCanvas, mask: job.mask, frame: frame++ }, job.gpu);
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
    post({ type: 'done', blob: new Blob([target.buffer!], { type: format.mime }), frames: frame, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    input.dispose();
  }
};
