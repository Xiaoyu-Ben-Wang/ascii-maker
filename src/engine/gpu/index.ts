import type { Params } from '../params.ts';
import type { RGBAImage } from '../pixels.ts';
import { render, type RenderOptions, type RenderResult } from '../render.ts';
import { GpuFailure, GpuRenderer, type BitmapResult, type Source } from './renderer.ts';

export { GpuRenderer, type BitmapResult, type ImageInput, type Source } from './renderer.ts';

const pixelsOf = (src: Source): RGBAImage => ('image' in src ? src.read() : src);

function bitmapOf(r: RenderResult): BitmapResult {
  const c = new OffscreenCanvas(r.width, r.height);
  c.getContext('2d')!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
  return { width: r.width, height: r.height, bitmap: c.transferToImageBitmap(), text: r.text };
}

/**
 * Renders on the GPU while `enabled` and available, otherwise on the CPU. A failed GPU render is redone on the
 * CPU, and after a GPU failure every later render is too. Each call reports which one it used. `data` returns
 * pixels (for encoding); `bitmap` returns an ImageBitmap (for display), which skips the GPU read-back.
 */
export function gpuOrCpu() {
  let gpu: GpuRenderer | null | undefined;
  const run = <T>(src: Source, p: Params, opts: RenderOptions, enabled: boolean, onGpu: (g: GpuRenderer) => T, onCpu: (r: RenderResult) => T) => {
    if (enabled && gpu !== null) {
      try {
        gpu ??= GpuRenderer.create();
        if (gpu) return { r: onGpu(gpu), gpu: true };
      } catch (err) {
        if (err instanceof GpuFailure) {
          console.warn('GPU rendering failed; using the CPU from now on.', err);
          gpu = null;
        }
      }
    }
    return { r: onCpu(render(pixelsOf(src), p, opts)), gpu: false };
  };
  return {
    data: (src: Source, p: Params, opts: RenderOptions, enabled: boolean) => run(src, p, opts, enabled, (g) => g.render(src, p, opts), (r) => r),
    bitmap: (src: Source, p: Params, opts: RenderOptions, enabled: boolean) => run(src, p, opts, enabled, (g) => g.renderBitmap(src, p, opts), bitmapOf),
  };
}
