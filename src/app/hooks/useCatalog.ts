import { useCallback, useEffect, useRef, useState } from 'react';
import { diffParams, frameFor, resolveParams } from '../../engine/index.ts';
import { deleteCreation, listCreations, loadBlob, persistStorage, saveBlob, saveCreation, type CreationMeta } from '../lib/catalog.ts';
import { extensionOf, stem } from '../lib/files.ts';
import type { Renderer } from '../lib/renderer.ts';
import { VideoSource, isVideo } from '../lib/video.ts';
import type { ImgLook } from './useLook.ts';
import type { Masks } from './useMasks.ts';

/**
 * A creation in the library. `id` names its source in the renderer for this session; `key` is its permanent id.
 * `bitmap` is null until the source is first needed; for a video it is the frame at `time` (seconds).
 */
export interface Img {
  id: number;
  key: string;
  name: string;
  kind: 'image' | 'video';
  width: number;
  height: number;
  look: ImgLook;
  painted: boolean;
  createdAt: number;
  /** Object URL of the saved render, or null until one exists. */
  thumb: string | null;
  /** The saved render predates the latest edit. */
  thumbStale: boolean;
  bitmap: ImageBitmap | null;
  video?: VideoSource;
  time?: number;
}

const THUMB_W = 720;
/** Decoded sources kept besides the active one; older ones are released. */
const KEEP_DECODED = 3;
const SAVE_MS = 400;
const THUMB_MS = 1500;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
const isMedia = (f: File) => f.type.startsWith('image/') || isVideo(f);

/** Closes a bitmap once the canvases drawing it have moved on. */
export const closeLater = (b: ImageBitmap, also?: () => void) => setTimeout(() => { b.close(); also?.(); }, 1000);

const metaOf = (img: Img): CreationMeta => ({
  key: img.key, name: img.name, kind: img.kind, width: img.width, height: img.height,
  look: { preset: img.look.preset, params: diffParams(img.look.params) }, painted: img.painted, thumbStale: img.thumbStale,
  createdAt: img.createdAt, updatedAt: Date.now(),
});

async function decode(blob: Blob, img: Pick<Img, 'kind' | 'name'>): Promise<{ bitmap: ImageBitmap; video?: VideoSource }> {
  if (img.kind === 'image') return { bitmap: await createImageBitmap(blob) };
  const file = blob instanceof File ? blob : new File([blob], img.name, { type: blob.type });
  const video = await VideoSource.open(file);
  try {
    return { bitmap: await video.frameAt(0), video };
  } catch (e) {
    video.dispose();
    throw e;
  }
}

/**
 * The library, newest first: every saved creation, which one is active, and their sources, decoded when needed and
 * released again once a few others have been used since. Looks and masks save as they settle, and thumbnails
 * re-render one at a time after edits.
 */
export function useCatalog(renderer: Renderer | null, notify: (text: string) => void, masks: Masks, newLook: () => ImgLook) {
  const [images, setImages] = useState<Img[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const nextId = useRef(1);
  const decoding = useRef(new Map<number, Promise<Img | null>>());
  const saveTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const thumbTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const thumbQueue = useRef<Promise<void>>(Promise.resolve());
  /** Decoded ids, most recently used first. */
  const recent = useRef<number[]>([]);
  /** Creations whose source never reached the library; they live for this session only. */
  const unsaved = useRef(new Set<number>());
  const warned = useRef(false);
  const active = images.find((i) => i.id === activeId) ?? null;
  const find = (id: number) => imagesRef.current.find((i) => i.id === id);

  /** Updates a creation in state and in imagesRef at once, so async work sees the change before the next render. */
  const patch = useCallback((id: number, change: Partial<Img>) => {
    imagesRef.current = imagesRef.current.map((i) => (i.id === id ? { ...i, ...change } : i));
    setImages((list) => list.map((i) => (i.id === id ? { ...i, ...change } : i)));
  }, []);

  const failedSave = useCallback((e: unknown) => {
    if (warned.current) return;
    warned.current = true;
    notify(`Could not save to the library: ${message(e)}`);
  }, [notify]);

  const persist = useCallback((id: number, blobs?: Parameters<typeof saveCreation>[1]) => {
    const img = find(id);
    if (img && !unsaved.current.has(id)) return saveCreation(metaOf(img), blobs).catch(failedSave);
  }, [failedSave]);

  /** Drops a decoded source that is not in use, keeping its thumbnail and saved state. */
  const release = useCallback((id: number) => {
    const img = find(id);
    if (!img?.bitmap || id === activeRef.current || decoding.current.has(id)) return;
    renderer?.dropSource(id);
    const { bitmap, video } = img;
    closeLater(bitmap, () => video?.dispose());
    patch(id, { bitmap: null, video: undefined, time: undefined });
  }, [renderer, patch]);

  const used = useCallback((id: number) => {
    recent.current = [id, ...recent.current.filter((x) => x !== id && find(x))];
    for (const old of recent.current.slice(KEEP_DECODED + 1)) release(old);
  }, [release]);

  const queueThumb = useRef<(id: number) => void>(() => {});

  /** Decodes the creation's source (once) and hands it to the renderer, with its mask. */
  const ensure = useCallback((id: number): Promise<Img | null> => {
    const img = find(id);
    if (!img) return Promise.resolve(null);
    if (img.bitmap) { used(id); return Promise.resolve(img); }
    let job = decoding.current.get(id);
    if (!job) {
      job = (async () => {
        let bitmap: ImageBitmap | undefined, video: VideoSource | undefined;
        // Removed while decoding: drop what was made so far.
        const gone = () => {
          if (find(id)) return false;
          renderer?.dropSource(id);
          masks.drop(id);
          if (bitmap) closeLater(bitmap, () => video?.dispose());
          return true;
        };
        try {
          const blob = await loadBlob(img.key, 'source');
          if (!blob) throw new Error('its source is missing from the library');
          ({ bitmap, video } = await decode(blob, img));
          if (gone()) return null;
          if (renderer) await renderer.addSource(id, bitmap);
          if (gone()) return null;
          if (masks.read(id)) masks.commit(id);
          else if (img.painted) {
            const mask = await loadBlob(img.key, 'mask');
            if (mask) await masks.load(id, bitmap.width, bitmap.height, mask);
            if (gone()) return null;
          }
          patch(id, { bitmap, video, time: video ? 0 : undefined });
          decoding.current.delete(id);
          used(id);
          const ready = find(id)!;
          if (!ready.thumb || ready.thumbStale) queueThumb.current(id);
          return ready;
        } catch (e) {
          if (!gone()) notify(`Could not open ${img.name}: ${message(e)}`);
          return null;
        } finally {
          decoding.current.delete(id);
        }
      })();
      decoding.current.set(id, job);
    }
    return job;
  }, [renderer, masks, notify, patch, used]);

  const renderThumb = useCallback(async (id: number) => {
    let img = find(id);
    if (!img || !renderer) return;
    const wasDecoded = !!img.bitmap;
    if (!wasDecoded) img = (await ensure(id)) ?? undefined;
    if (!img?.bitmap) return;
    const frame = frameFor(img.width, img.height, 'source');
    const width = Math.min(THUMB_W, frame.width);
    const height = Math.max(1, Math.round((width * frame.height) / frame.width));
    const r = await renderer.thumb({ sourceId: id, width, height, crop: frame.crop, targetWidth: frame.width, params: img.look.params });
    if (!r) return;
    const c = new OffscreenCanvas(r.bitmap.width, r.bitmap.height);
    c.getContext('bitmaprenderer')!.transferFromImageBitmap(r.bitmap);
    const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.85 });
    const now = find(id);
    if (!now) return;
    // An edit that landed while rendering keeps the thumbnail stale, so it renders again.
    const stale = now.look !== img.look;
    if (now.thumb) URL.revokeObjectURL(now.thumb);
    patch(id, { thumb: URL.createObjectURL(blob), thumbStale: stale });
    await persist(id, { thumb: blob });
    if (!wasDecoded) release(id);
  }, [renderer, ensure, patch, persist, release]);

  queueThumb.current = (id: number) => {
    thumbQueue.current = thumbQueue.current.then(() => renderThumb(id)).catch(() => {});
  };

  const later = (timers: Map<number, ReturnType<typeof setTimeout>>, id: number, ms: number, run: () => void) => {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => { timers.delete(id); run(); }, ms));
  };

  /** Marks the thumbnail stale, saves the creation soon, and re-renders the thumbnail once edits stop. */
  const touch = useCallback((id: number) => {
    later(saveTimers.current, id, SAVE_MS, () => persist(id));
    later(thumbTimers.current, id, THUMB_MS, () => queueThumb.current(id));
  }, [persist]);

  // Pending saves are written before the page goes away, so the last edit is not lost.
  useEffect(() => {
    const flush = () => {
      for (const [id, t] of saveTimers.current) { clearTimeout(t); persist(id); }
      saveTimers.current.clear();
    };
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); };
  }, [persist]);

  useEffect(() => {
    let live = true;
    listCreations().then(async (metas) => {
      metas.sort((a, b) => b.createdAt - a.createdAt);
      const list: Img[] = [];
      for (const m of metas) {
        const thumb = await loadBlob(m.key, 'thumb').catch(() => undefined);
        let look: ImgLook;
        try { look = { preset: m.look.preset, params: resolveParams(m.look.params) }; } catch { look = newLook(); }
        list.push({ ...m, id: nextId.current++, look, thumb: thumb ? URL.createObjectURL(thumb) : null, thumbStale: !!m.thumbStale, bitmap: null });
      }
      if (!live) return;
      imagesRef.current = [...imagesRef.current, ...list];
      setImages((cur) => [...cur, ...list]);
      for (const img of list) if (!img.thumb || img.thumbStale) queueThumb.current(img.id);
    }).catch((e) => notify(`Could not read the library: ${message(e)}`)).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Saves a new creation from a file and makes it active. */
  const add = useCallback(async (file: Blob, name: string, look: ImgLook = newLook()) => {
    const kind = file instanceof File && isVideo(file) ? 'video' : 'image';
    const { bitmap, video } = await decode(file, { kind, name });
    const id = nextId.current++;
    if (renderer) await renderer.addSource(id, bitmap);
    const img: Img = {
      id, key: crypto.randomUUID(), name, kind, width: bitmap.width, height: bitmap.height, look, painted: false,
      createdAt: Date.now(), thumb: null, thumbStale: false, bitmap, video, time: video ? 0 : undefined,
    };
    imagesRef.current = [img, ...imagesRef.current];
    setImages((list) => [img, ...list]);
    setActiveId(id);
    activeRef.current = id;
    used(id);
    persistStorage();
    saveCreation(metaOf(img), { source: file }).then(() => queueThumb.current(id), (e) => {
      unsaved.current.add(id);
      notify(e instanceof DOMException && e.name === 'QuotaExceededError'
        ? `Library is full; ${name} is kept for this session only`
        : `Could not save ${name}; it is kept for this session only`);
      queueThumb.current(id);
    });
    return img;
  }, [renderer, newLook, used, notify]);

  const addFiles = useCallback(async (files: Iterable<File>, fallbackName = 'image') => {
    let failed = 0;
    for (const f of files) {
      const name = stem(f.name) || fallbackName;
      if (!isMedia(f)) { failed++; continue; }
      try {
        await add(f, name);
      } catch (e) {
        if (isVideo(f)) notify(`Could not open ${f.name}: ${message(e)}`);
        else failed++;
      }
    }
    if (failed) notify(`${failed} file${failed > 1 ? 's' : ''} could not be read as an image or video`);
  }, [add, notify]);

  const updateLook = useCallback((key: string, look: ImgLook) => {
    const img = imagesRef.current.find((i) => i.key === key);
    if (!img) return;
    patch(img.id, { look, thumbStale: true });
    touch(img.id);
  }, [patch, touch]);

  /** Call after a mask stroke: saves (or deletes) the creation's mask. */
  const maskChanged = useCallback(async (id: number) => {
    if (!find(id)) return;
    const painted = masks.isPainted(id);
    patch(id, { painted, thumbStale: true });
    const blob = painted ? await masks.blob(id) : null;
    if (!find(id)) return;
    persist(id, { mask: blob });
    later(thumbTimers.current, id, THUMB_MS, () => queueThumb.current(id));
  }, [masks, patch, persist]);

  const remove = useCallback((id: number) => {
    const img = find(id);
    if (!img) return;
    clearTimeout(saveTimers.current.get(id));
    clearTimeout(thumbTimers.current.get(id));
    saveTimers.current.delete(id);
    thumbTimers.current.delete(id);
    renderer?.dropSource(id);
    masks.drop(id);
    unsaved.current.delete(id);
    recent.current = recent.current.filter((x) => x !== id);
    deleteCreation(img.key).catch((e) => notify(`Could not delete ${img.name}: ${message(e)}`));
    imagesRef.current = imagesRef.current.filter((i) => i.id !== id);
    setImages((list) => {
      const rest = list.filter((i) => i.id !== id);
      setActiveId((cur) => (cur === id ? rest[0]?.id ?? null : cur));
      return rest;
    });
    if (img.bitmap) closeLater(img.bitmap, () => img.video?.dispose());
    if (img.thumb) setTimeout(() => URL.revokeObjectURL(img.thumb!), 1000);
  }, [renderer, masks, notify]);

  const replaceFrame = useCallback((id: number, bitmap: ImageBitmap, time: number) => {
    patch(id, { bitmap, time });
  }, [patch]);

  /** Moves the active creation through `ids` (default: the whole library), wrapping around. */
  const step = useCallback((d: number, ids?: ReadonlySet<number>) => {
    const list = imagesRef.current.filter((i) => !ids || ids.has(i.id));
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

  return { images, imagesRef, active, activeId, setActiveId, loaded, add, addFiles, ensure, updateLook, maskChanged, remove, replaceFrame, step, paste };
}

export type Library = ReturnType<typeof useCatalog>;
