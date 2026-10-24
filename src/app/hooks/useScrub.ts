import { useEffect, useRef, useState } from 'react';
import type { Renderer } from '../lib/renderer.ts';
import { closeLater, type Library } from './useCatalog.ts';

/**
 * Video scrubbing: the scrubber moves at once, and the frame under it is decoded and rendered once it settles.
 * Returns the time to show for the active video and a setter for it.
 */
export function useScrub(renderer: Renderer | null, library: Library, notify: (text: string) => void) {
  const [scrub, setScrub] = useState<{ id: number; time: number } | null>(null);
  /** Frame swaps commit in order, so a slow decode never lands after a newer one. */
  const swaps = useRef<Promise<void>>(Promise.resolve());
  const { imagesRef, replaceFrame, active } = library;

  useEffect(() => {
    if (!scrub || !renderer) return;
    const video = imagesRef.current.find((i) => i.id === scrub.id)?.video;
    if (!video) return;
    const { id, time } = scrub;
    let cancelled = false;
    const live = () => (cancelled ? undefined : imagesRef.current.find((i) => i.id === id));
    const t = setTimeout(() => {
      swaps.current = swaps.current.then(async () => {
        if (cancelled) return;
        const bitmap = await video.frameAt(time);
        if (!live()) { bitmap.close(); return; }
        await renderer.addSource(id, bitmap);
        const now = live();
        if (!now) { bitmap.close(); return; }
        if (now.bitmap) closeLater(now.bitmap);
        replaceFrame(id, bitmap, time);
      }).catch((e) => notify(`Could not decode that frame: ${e instanceof Error ? e.message : e}`));
    }, 100);
    return () => { cancelled = true; clearTimeout(t); };
  }, [scrub, renderer, imagesRef, replaceFrame, notify]);

  const time = active?.video ? (scrub?.id === active.id ? scrub.time : active.time ?? 0) : 0;
  return { time, setTime: (id: number, t: number) => setScrub({ id, time: t }) };
}
