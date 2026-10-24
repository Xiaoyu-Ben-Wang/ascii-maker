import { useCallback, useRef, useState } from 'react';
import { PaintMask } from '../lib/mask.ts';
import type { Renderer } from '../lib/renderer.ts';

/** One painted highlight mask per image, kept in sync with the renderer. */
export function useMasks(renderer: Renderer | null) {
  const masks = useRef(new Map<number, PaintMask>());
  const painted = useRef(new Set<number>());
  /** Bumped whenever a mask changes, so the preview and the mask controls refresh. */
  const [gen, setGen] = useState(0);

  const get = useCallback((id: number, width: number, height: number) => {
    let m = masks.current.get(id);
    if (!m) masks.current.set(id, (m = new PaintMask(width, height)));
    return m;
  }, []);

  const read = useCallback((id: number) => masks.current.get(id)?.read() ?? null, []);

  const commit = useCallback((id: number) => {
    const data = read(id);
    if (data) painted.current.add(id);
    else painted.current.delete(id);
    renderer?.setMask(id, data);
    setGen((g) => g + 1);
  }, [renderer, read]);

  const undo = useCallback((id: number) => {
    masks.current.get(id)?.undoLast();
    commit(id);
  }, [commit]);

  const drop = useCallback((id: number) => {
    masks.current.delete(id);
    painted.current.delete(id);
  }, []);

  const isPainted = (id: number) => painted.current.has(id);

  return { get, read, commit, undo, drop, isPainted, gen };
}
