import { useEffect, useRef, useState } from 'react';
import type { Frame, Params } from '../../engine/index.ts';
import type { Renderer } from '../lib/renderer.ts';
import type { Img } from './useImages.ts';

export interface Preview { id: number; bitmap: ImageBitmap; text?: string; ms: number; gpu: boolean }

/**
 * The active image rendered at the export resolution, so zooming never changes how it looks. Setting changes are
 * debounced so a slider drag renders once it settles. `refresh` re-renders when it changes.
 */
export function usePreview(renderer: Renderer | null, active: Img | null, frame: Frame | null, params: Params, enabled: boolean, refresh: unknown) {
  const [result, setResult] = useState<Preview | null>(null);
  const rendered = useRef(params);

  useEffect(() => {
    if (!active || !frame || !renderer || !enabled) return;
    let cancelled = false;
    const id = active.id;
    const t = setTimeout(() => {
      rendered.current = params;
      renderer.preview({ sourceId: id, width: frame.width, height: frame.height, crop: frame.crop, targetWidth: frame.width, params }).then((res) => {
        if (!res || cancelled) { res?.bitmap.close(); return; }
        setResult((prev) => {
          if (prev && prev.bitmap !== res.bitmap) prev.bitmap.close();
          return { id, bitmap: res.bitmap, text: res.text, ms: res.ms, gpu: res.gpu };
        });
      });
    }, params === rendered.current ? 0 : 100);
    return () => { cancelled = true; clearTimeout(t); };
  }, [active, frame, params, renderer, enabled, refresh]);

  // The bitmap is consumed by the canvas that shows it, so drop it when that canvas unmounts.
  useEffect(() => {
    if (!enabled) setResult((prev) => { prev?.bitmap.close(); return null; });
  }, [enabled]);

  return result && result.id === active?.id ? result : null;
}
