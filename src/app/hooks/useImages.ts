import { useCallback, useEffect, useRef, useState } from 'react';
import { extensionOf, stem } from '../lib/files.ts';
import type { Renderer } from '../lib/renderer.ts';
import { VideoSource, isVideo } from '../lib/video.ts';

/** An image in the set. For a video, `bitmap` is the frame at `time` (seconds). */
export interface Img { id: number; bitmap: ImageBitmap; name: string; width: number; height: number; video?: VideoSource; time?: number }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
const isMedia = (f: File) => f.type.startsWith('image/') || isVideo(f);

/** Closes a bitmap once the canvases drawing it have moved on. */
export const closeLater = (b: ImageBitmap, also?: () => void) => setTimeout(() => { b.close(); also?.(); }, 1000);

/** The loaded images and videos, and which one is active. */
export function useImages(renderer: Renderer | null, notify: (text: string) => void, onRemove: (id: number) => void) {
  const [images, setImages] = useState<Img[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const nextId = useRef(1);
  const active = images.find((i) => i.id === activeId) ?? null;

  const add = useCallback(async (bitmap: ImageBitmap, name: string, video?: VideoSource) => {
    const id = nextId.current++;
    if (renderer) await renderer.addSource(id, bitmap);
    setImages((list) => [...list, { id, bitmap, name, width: bitmap.width, height: bitmap.height, video, time: video ? 0 : undefined }]);
    setActiveId(id);
  }, [renderer]);

  const addFiles = useCallback(async (files: Iterable<File>, fallbackName = 'image') => {
    let failed = 0;
    for (const f of files) {
      const name = stem(f.name) || fallbackName;
      if (isVideo(f)) {
        let video: VideoSource | null = null;
        try {
          video = await VideoSource.open(f);
          await add(await video.frameAt(0), name, video);
        } catch (e) {
          video?.dispose();
          notify(`Could not open ${f.name}: ${message(e)}`);
        }
      } else if (f.type.startsWith('image/')) {
        try { await add(await createImageBitmap(f), name); } catch { failed++; }
      } else failed++;
    }
    if (failed) notify(`${failed} file${failed > 1 ? 's' : ''} could not be read as an image or video`);
  }, [add, notify]);

  const remove = useCallback((id: number) => {
    renderer?.dropSource(id);
    onRemove(id);
    setImages((list) => {
      const img = list.find((i) => i.id === id);
      if (img) closeLater(img.bitmap, () => img.video?.dispose());
      const rest = list.filter((i) => i.id !== id);
      setActiveId((cur) => (cur === id ? rest[rest.length - 1]?.id ?? null : cur));
      return rest;
    });
  }, [renderer, onRemove]);

  const replaceFrame = useCallback((id: number, bitmap: ImageBitmap, time: number) => {
    setImages((list) => list.map((i) => (i.id === id ? { ...i, bitmap, time } : i)));
  }, []);

  const step = useCallback((d: number) => {
    const list = imagesRef.current;
    if (list.length < 2) return;
    setActiveId((cur) => list[(list.findIndex((x) => x.id === cur) + d + list.length) % list.length].id);
  }, []);

  const paste = useCallback(async () => {
    try {
      const files: File[] = [];
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) files.push(new File([await item.getType(type)], `pasted.${extensionOf(type)}`, { type }));
      }
      if (files.length) addFiles(files, 'pasted');
      else notify('No image on the clipboard');
    } catch {
      notify('Clipboard blocked, use Ctrl V');
    }
  }, [addFiles, notify]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (typing(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter(isMedia);
      if (files.length) { e.preventDefault(); addFiles(files, 'pasted'); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  return { images, imagesRef, active, activeId, setActiveId, add, addFiles, remove, replaceFrame, step, paste };
}

export type Library = ReturnType<typeof useImages>;
