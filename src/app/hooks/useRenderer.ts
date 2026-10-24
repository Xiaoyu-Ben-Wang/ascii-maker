import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Renderer } from '../lib/renderer.ts';
import { KEYS, load, save } from '../lib/storage.ts';

/**
 * The render workers. `gen` changes whenever every view should re-request its render (a crashed worker came back,
 * or GPU rendering was switched). `seed` hands a new Renderer the current sources.
 */
export function useRenderer(notify: (text: string) => void, seed: RefObject<(r: Renderer) => void>) {
  const [gpu, setGpu] = useState(() => load(KEYS.gpu) !== 0);
  const gpuRef = useRef(gpu);
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const [gen, setGen] = useState(0);

  useEffect(() => {
    const r = new Renderer(() => {
      notify('Renderer restarted');
      setGen((g) => g + 1);
    }, gpuRef.current);
    seed.current(r);
    setRenderer(r);
    return () => { r.terminate(); setRenderer(null); };
  }, [notify, seed]);

  const toggleGpu = useCallback(() => {
    const on = !gpuRef.current;
    gpuRef.current = on;
    setGpu(on);
    save(KEYS.gpu, on ? 1 : 0);
    renderer?.setGpu(on);
    setGen((g) => g + 1);
  }, [renderer]);

  return { renderer, gen, gpu, toggleGpu };
}
