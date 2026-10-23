import {
  Braces, BookmarkPlus, Brush, ClipboardPaste, Columns2, Copy, Cpu, Download, ImageUp, LayoutGrid, Redo2, RotateCcw, Settings2, Square, Terminal, Trash2, Undo2, X,
} from 'lucide-react';
import { Tooltip } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULTS, PRESETS, frameFor, resolveParams, type Params, type SizeName } from '../engine/index.ts';
import { Filmstrip, Gallery, type Img } from './Gallery.tsx';
import { Inspector } from './Inspector.tsx';
import { PaintMask, type MaskTool } from './mask.ts';
import { MaskBar } from './MaskBar.tsx';
import { CanceledError, Renderer, type VideoProgress } from './renderer.ts';
import { SAMPLE_SOURCES, loadSample, type SampleSource } from './sample.ts';
import { Scrubber } from './Scrubber.tsx';
import { Stage } from './Stage.tsx';
import { Button, Kbd, Popover, Progress, Row, Select, SliderField, Switch, TextField, Tip, cx } from './ui.tsx';
import { VIDEO_FORMATS, VideoSource, encodableFormats, evenSize, isVideo, type VideoFormat } from './video.ts';
import { zip } from './zip.ts';

const STORE_KEY = 'ascii-maker:v2';
const USER_PRESETS_KEY = 'ascii-maker:presets';
const GPU_KEY = 'ascii-maker:gpu';
const CUSTOM = 'custom';
/** Saved presets live under this prefix so they never collide with built-in names. */
const USER = 'user:';
type UserPresets = Record<string, Partial<Params>>;

function loadUserPresets(): UserPresets {
  try {
    const s = JSON.parse(localStorage.getItem(USER_PRESETS_KEY) ?? 'null');
    if (s && typeof s === 'object') return s;
  } catch { /* storage unavailable */ }
  return {};
}
const FORMATS = [
  { value: 'image/png', label: 'PNG' },
  { value: 'image/jpeg', label: 'JPEG' },
  { value: 'image/webp', label: 'WebP' },
];

interface Result { id: number; bitmap: ImageBitmap; text?: string; ms: number; gpu: boolean }

function loadStored(): { preset: string; params: Params } {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (s?.params) return { preset: s.preset ?? CUSTOM, params: resolveParams(s.params) };
  } catch { /* storage unavailable */ }
  return { preset: 'soft-ascii', params: resolveParams(PRESETS['soft-ascii'].params) };
}

function changed(p: Params): Partial<Params> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULTS) as (keyof Params)[]) if (p[k] !== DEFAULTS[k]) out[k] = p[k];
  return out as Partial<Params>;
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const ext = (mime: string) => mime.split('/')[1].replace('jpeg', 'jpg');
/** Rejects with CanceledError as soon as `signal` aborts, without waiting for `p`. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CanceledError());
    signal.addEventListener('abort', () => reject(new CanceledError()), { once: true });
    p.then(resolve, reject);
  });
}
const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;

export function App() {
  const stored = useMemo(loadStored, []);
  const [params, setParams] = useState<Params>(stored.params);
  const [userPresets, setUserPresets] = useState(loadUserPresets);
  const [preset, setPreset] = useState(() =>
    stored.preset.startsWith(USER) && !(stored.preset.slice(USER.length) in userPresets) ? CUSTOM : stored.preset);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [images, setImages] = useState<Img[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [view, setView] = useState<'single' | 'grid'>('single');
  const [result, setResult] = useState<Result | null>(null);
  const [exportSize, setExportSize] = useState<SizeName>('source');
  const [format, setFormat] = useState('image/png');
  const [quality, setQuality] = useState(92);
  const [pngLevel, setPngLevel] = useState(5);
  const [videoFormat, setVideoFormat] = useState<VideoFormat>('mp4');
  const [keepAudio, setKeepAudio] = useState(true);
  const [encodable, setEncodable] = useState<VideoFormat[] | null>(null);
  /** The running export: a label and progress 0..1 (null while it can't be measured). */
  const [job, setJob] = useState<{ label: string; value: number | null } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [split, setSplit] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [masking, setMasking] = useState(false);
  const [maskTool, setMaskTool] = useState<MaskTool>('add');
  const [maskSize, setMaskSize] = useState(0.04);
  const [maskOverlay, setMaskOverlay] = useState(true);
  /** Bumped whenever a mask changes, so the preview and mask controls refresh. */
  const [maskGen, setMaskGen] = useState(0);
  const masks = useRef(new Map<number, PaintMask>());
  /** Images whose mask has paint on it. */
  const painted = useRef(new Set<number>());
  const [hold, setHold] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  /** Bumped after a crashed render worker recovers, so every view re-requests its render. */
  const [gen, setGen] = useState(0);
  const [gpu, setGpu] = useState(() => { try { return localStorage.getItem(GPU_KEY) !== '0'; } catch { return true; } });
  const gpuRef = useRef(gpu);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const fileInput = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  const active = images.find((i) => i.id === activeId) ?? null;
  const canMask = !!active && view === 'single' && params.style !== 'photo' && params.style !== 'dither';
  const mask = masking && canMask ? (masks.current.get(active.id) ?? masks.current.set(active.id, new PaintMask(active.width, active.height)).get(active.id)!) : null;
  const maskingRef = useRef(false);
  maskingRef.current = !!mask;
  useEffect(() => { if (!canMask && masking) setMasking(false); }, [canMask, masking]);

  const commitMask = useCallback((id: number) => {
    const m = masks.current.get(id);
    const data = m?.read() ?? null;
    if (data) painted.current.add(id); else painted.current.delete(id);
    renderer?.setMask(id, data);
    setMaskGen((g) => g + 1);
  }, [renderer]);
  const onStroke = useCallback(() => { if (activeId !== null) commitMask(activeId); }, [activeId, commitMask]);
  const undoMask = useCallback(() => {
    if (activeId === null) return;
    masks.current.get(activeId)?.undoLast();
    commitMask(activeId);
  }, [activeId, commitMask]);

  const notify = useCallback((text: string) => setToast({ id: Date.now(), text }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const r = new Renderer(() => {
      notify('Renderer restarted');
      setGen((g) => g + 1);
    }, gpuRef.current);
    for (const img of imagesRef.current) {
      r.addSource(img.id, img.bitmap);
      const m = masks.current.get(img.id)?.read();
      if (m) r.setMask(img.id, m);
    }
    setRenderer(r);
    return () => { r.terminate(); setRenderer(null); };
  }, [notify]);

  // ---- undo history: a snapshot is committed once params settle ----
  const past = useRef<Params[]>([]);
  const future = useRef<Params[]>([]);
  const committed = useRef(params);
  const [, bump] = useState(0);
  useEffect(() => {
    if (params === committed.current) return;
    const t = setTimeout(() => {
      past.current.push(committed.current);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      committed.current = params;
      bump((n) => n + 1);
    }, 350);
    return () => clearTimeout(t);
  }, [params]);
  const undo = useCallback(() => {
    const cur = paramsRef.current;
    if (cur !== committed.current) past.current.push(committed.current);
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(cur);
    committed.current = prev;
    setParams(prev);
    setPreset(CUSTOM);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(paramsRef.current);
    committed.current = next;
    setParams(next);
    setPreset(CUSTOM);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ preset, params: changed(params) })); } catch { /* ignore */ }
  }, [params, preset]);

  const set = useCallback((patch: Partial<Params>) => {
    setParams((p) => ({ ...p, ...patch }));
    setPreset((name) => (name === CUSTOM || 'style' in patch ? CUSTOM : name));
  }, []);
  const pickVignette = useCallback((x: number, y: number) => set({ vignetteX: x, vignetteY: y }), [set]);
  /** Bumped when a whole look is loaded, so the inspector sections re-open or collapse to match it. */
  const [epoch, setEpoch] = useState(0);
  const presetEpoch = `${epoch}`;
  const presetParams = useCallback((name: string): Partial<Params> | undefined =>
    name.startsWith(USER) ? userPresets[name.slice(USER.length)] : PRESETS[name]?.params, [userPresets]);
  const applyPreset = useCallback((name: string) => {
    setEpoch((n) => n + 1);
    setPreset(name);
    const p = presetParams(name);
    if (p) setParams(resolveParams(p));
  }, [presetParams]);
  const base = useMemo(() => resolveParams(presetParams(preset) ?? {}), [preset, presetParams]);
  const presetOptions = useMemo(() => [
    ...Object.entries(PRESETS).map(([k, p]) => ({ value: k, label: k, hint: p.description })),
    ...Object.keys(userPresets).sort().map((k) => ({ value: USER + k, label: k, hint: 'Saved preset' })),
    { value: CUSTOM, label: 'custom', hint: 'Your own settings' },
  ], [userPresets]);
  const storeUserPresets = useCallback((next: UserPresets) => {
    setUserPresets(next);
    try { localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(next)); } catch { notify('Could not save presets in this browser'); }
  }, [notify]);
  const savePreset = useCallback(() => {
    const name = saveName.trim();
    if (!name) return;
    storeUserPresets({ ...userPresets, [name]: changed(params) });
    setPreset(USER + name);
    setSaveOpen(false);
    notify(`${name in userPresets ? 'Updated' : 'Saved'} preset “${name}”`);
  }, [saveName, userPresets, params, storeUserPresets, notify]);
  const deletePreset = useCallback(() => {
    const name = preset.slice(USER.length);
    const { [name]: _, ...rest } = userPresets;
    storeUserPresets(rest);
    setPreset(CUSTOM);
    notify(`Deleted preset “${name}”`);
  }, [preset, userPresets, storeUserPresets, notify]);
  const userPreset = preset.startsWith(USER);
  const edits = useMemo(() => (Object.keys(DEFAULTS) as (keyof Params)[]).filter((k) => params[k] !== base[k]).length, [params, base]);

  // ---- image set ----
  const addBitmap = useCallback(async (bitmap: ImageBitmap, name: string, video?: VideoSource) => {
    const id = nextId.current++;
    if (renderer) await renderer.addSource(id, bitmap);
    setImages((list) => [...list, { id, bitmap, name, width: bitmap.width, height: bitmap.height, video, time: video ? 0 : undefined }]);
    setActiveId(id);
  }, [renderer]);
  const addFiles = useCallback(async (files: Iterable<File>, fallbackName = 'image') => {
    let failed = 0;
    for (const f of files) {
      const name = f.name.replace(/\.[^.]+$/, '') || fallbackName;
      if (isVideo(f)) {
        let video: VideoSource | null = null;
        try {
          video = await VideoSource.open(f);
          await addBitmap(await video.frameAt(0), name, video);
        } catch (e) {
          video?.dispose();
          notify(`Could not open ${f.name}: ${e instanceof Error ? e.message : e}`);
        }
        continue;
      }
      if (!f.type.startsWith('image/')) { failed++; continue; }
      try {
        await addBitmap(await createImageBitmap(f), name);
      } catch { failed++; }
    }
    if (failed) notify(`${failed} file${failed > 1 ? 's' : ''} could not be read as an image or video`);
  }, [addBitmap, notify]);
  const addSamples = useCallback(async () => {
    try {
      const bitmaps = await Promise.all(SAMPLE_SOURCES.map(loadSample));
      for (const [i, b] of bitmaps.entries()) await addBitmap(b, SAMPLE_SOURCES[i]);
      setView('grid');
    } catch {
      notify('Could not load the samples');
    }
  }, [addBitmap, notify]);
  const openExample = useCallback(async (source: SampleSource, presetName: string) => {
    try {
      await addBitmap(await loadSample(source), source);
      applyPreset(presetName);
      setView('single');
    } catch {
      notify('Could not load the example');
    }
  }, [addBitmap, applyPreset, notify]);
  const removeImage = useCallback((id: number) => {
    renderer?.dropSource(id);
    masks.current.delete(id);
    painted.current.delete(id);
    setImages((list) => {
      const img = list.find((i) => i.id === id);
      // Close after the canvases that draw it have unmounted.
      if (img) setTimeout(() => { img.bitmap.close(); img.video?.dispose(); }, 1000);
      const rest = list.filter((i) => i.id !== id);
      setActiveId((cur) => (cur === id ? rest[rest.length - 1]?.id ?? null : cur));
      return rest;
    });
  }, [renderer]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) files.push(new File([await item.getType(type)], `pasted.${ext(type)}`, { type }));
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
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/') || isVideo(f));
      if (files.length) { e.preventDefault(); addFiles(files, 'pasted'); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  // ---- video scrubbing: the scrubber moves at once, the frame under it is decoded and rendered once it settles ----
  const [scrub, setScrub] = useState<{ id: number; time: number } | null>(null);
  /** Frame swaps commit in order, so a slow decode never lands after a newer one. */
  const swaps = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!scrub || !renderer) return;
    const img = imagesRef.current.find((i) => i.id === scrub.id);
    // No early return when time matches: an older swap still in flight may land a different frame first.
    if (!img?.video) return;
    const { id, time } = scrub;
    const video = img.video;
    let cancelled = false;
    const t = setTimeout(() => {
      swaps.current = swaps.current.then(async () => {
        if (cancelled) return;
        const bitmap = await video.frameAt(time);
        const cur = imagesRef.current.find((i) => i.id === id);
        if (cancelled || !cur) { bitmap.close(); return; }
        await renderer.addSource(id, bitmap);
        const now = imagesRef.current.find((i) => i.id === id);
        // A newer scrub (queued behind this one) sends its own frame; a removed video needs none.
        if (cancelled || !now) { bitmap.close(); return; }
        setTimeout(() => now.bitmap.close(), 1000); // once the canvases drawing it have moved on
        setImages((list) => list.map((i) => (i.id === id ? { ...i, bitmap, time } : i)));
      }).catch((e) => notify(`Could not decode that frame: ${e instanceof Error ? e.message : e}`));
    }, 100);
    return () => { cancelled = true; clearTimeout(t); };
  }, [scrub, renderer, notify]);
  const scrubTime = active?.video ? (scrub?.id === active.id ? scrub.time : active.time ?? 0) : 0;

  // ---- main preview: setting changes are debounced so a slider drag renders once it settles ----
  const activeW = active?.width ?? 0, activeH = active?.height ?? 0;
  const frame = useMemo(() => (activeW ? frameFor(activeW, activeH, exportSize) : null), [activeW, activeH, exportSize]);
  // Always the export resolution, so zooming never changes how the render looks.
  const previewWidth = frame?.width ?? 0;
  const previewHeight = frame?.height ?? 0;

  const renderedParams = useRef(params);
  useEffect(() => {
    if (!active || !frame || !previewWidth || !renderer || view !== 'single') return;
    let cancelled = false;
    const id = active.id;
    const t = setTimeout(() => {
      renderedParams.current = params;
      renderer.preview({ sourceId: id, width: previewWidth, height: previewHeight, crop: frame.crop, targetWidth: frame.width, params }).then((res) => {
        if (!res || cancelled) { res?.bitmap.close(); return; }
        setResult((prev) => {
          if (prev && prev.bitmap !== res.bitmap) prev.bitmap.close();
          return { id, bitmap: res.bitmap, text: res.text, ms: res.ms, gpu: res.gpu };
        });
      });
    }, params === renderedParams.current ? 0 : 100);
    return () => { cancelled = true; clearTimeout(t); };
  }, [active, frame, params, previewWidth, previewHeight, renderer, view, gen, maskGen]);

  // The result bitmap is consumed by the canvas that shows it, so drop it when that canvas unmounts.
  useEffect(() => {
    if (view === 'grid') setResult((prev) => { prev?.bitmap.close(); return null; });
  }, [view]);

  // Never show one image's render over another.
  const shown = result && result.id === activeId ? result : null;

  // ---- export ----
  // Which video formats this browser can encode, checked for the active (or first) video.
  const sampleVideo = active?.video ? active : images.find((i) => i.video);
  const sampleW = sampleVideo?.width ?? 0, sampleH = sampleVideo?.height ?? 0;
  useEffect(() => {
    if (!sampleW) return;
    let live = true;
    const f = frameFor(sampleW, sampleH, exportSize);
    encodableFormats(f.width, f.height).then((ok) => {
      if (!live) return;
      setEncodable(ok);
      setVideoFormat((cur) => (ok.includes(cur) || !ok.length ? cur : ok[0]));
    });
    return () => { live = false; };
  }, [sampleW, sampleH, exportSize]);

  /** Renders one image, or every frame of a video, with `p` at the export size. */
  const exportOne = useCallback(async (img: Img, p: Params, onFrame?: (v: VideoProgress, total: number) => void, signal?: AbortSignal) => {
    const f = frameFor(img.width, img.height, exportSize);
    if (img.video) {
      const { width, height } = evenSize(f.width, f.height);
      const ok = await encodableFormats(width, height);
      const fmt = ok.includes(videoFormat) ? videoFormat : ok[0];
      if (!fmt) throw new Error('this browser cannot encode video');
      const total = Math.max(1, Math.round(img.video.info.duration * img.video.info.fps));
      const r = await renderer!.exportVideo({ sourceId: img.id, file: img.video.file, width, height, crop: f.crop, params: p, format: fmt, audio: keepAudio },
        (v) => onFrame?.(v, Math.max(total, v.frame)), signal);
      return { blob: r.blob, width, height, ms: r.ms, name: `${img.name}-${p.style}.${fmt}` };
    }
    const r = await abortable(renderer!.export({ sourceId: img.id, width: f.width, height: f.height, crop: f.crop, params: p, mime: format, quality: quality / 100, pngLevel }), signal);
    return { ...r, name: `${img.name}-${p.style}.${ext(format)}` };
  }, [renderer, exportSize, format, quality, pngLevel, videoFormat, keepAudio]);

  const startJob = useCallback((label: string, value: number | null) => {
    const ac = new AbortController();
    abort.current = ac;
    setJob({ label, value });
    return ac.signal;
  }, []);
  const endJob = useCallback((e?: unknown) => {
    if (e instanceof CanceledError) notify('Export canceled');
    else if (e) notify(`Export failed: ${e instanceof Error ? e.message : e}`);
    abort.current = null;
    setJob(null);
  }, [notify]);

  const doExport = useCallback(async () => {
    if (!active || !renderer || abort.current) return;
    const signal = startJob(active.video ? 'Starting…' : 'Rendering…', active.video ? 0 : null);
    try {
      const r = await exportOne(active, paramsRef.current, (v, total) => setJob({ label: `Frame ${v.frame} / ${total}`, value: v.progress }), signal);
      download(r.blob, r.name);
      notify(`Exported ${r.width}×${r.height} in ${(r.ms / 1000).toFixed(1)}s`);
      endJob();
    } catch (e) {
      endJob(e);
    }
  }, [active, renderer, exportOne, notify, startJob, endJob]);

  const exportAll = useCallback(async () => {
    const list = imagesRef.current;
    if (!list.length || !renderer || abort.current) return;
    const t0 = performance.now();
    const p = paramsRef.current; // one look for the whole batch, even if sliders move meanwhile
    const n = list.length;
    const signal = startJob(`1 / ${n}`, 0);
    try {
      const files: { name: string; blob: Blob }[] = [];
      const used = new Set<string>();
      for (const [i, img] of list.entries()) {
        if (!imagesRef.current.some((x) => x.id === img.id)) continue; // removed mid-export
        setJob({ label: `${i + 1} / ${n}`, value: i / n });
        const r = await exportOne(img, p, (v, total) => setJob({ label: `${i + 1} / ${n} · frame ${v.frame} / ${total}`, value: (i + v.progress) / n }), signal);
        let name = r.name;
        for (let k = 2; used.has(name); k++) name = r.name.replace(/(\.\w+)$/, `-${k}$1`);
        used.add(name);
        files.push({ name, blob: r.blob });
      }
      setJob({ label: 'Zipping…', value: 1 });
      download(await abortable(zip(files), signal), `ascii-maker-${p.style}.zip`);
      notify(`Exported ${files.length} files in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      endJob();
    } catch (e) {
      endJob(e);
    }
  }, [renderer, exportOne, notify, startJob, endJob]);

  const copy = useCallback(async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); notify(`Copied ${what}`); } catch { notify('Clipboard unavailable'); }
  }, [notify]);

  const cliCommand = useCallback(() => {
    const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    const q = (v: unknown) => (typeof v === 'string' && /[^\w#.,-]/.test(v) ? `"${v.replace(/(["\\$`])/g, '\\$1')}"` : String(v));
    const flags = Object.entries(changed(params)).map(([k, v]) =>
      typeof v === 'boolean' ? (v ? `--${kebab(k)}` : `--no-${kebab(k)}`) : `--${kebab(k)}=${q(v)}`);
    const size = exportSize === 'source' ? [] : [`--size ${exportSize}`];
    const io = images.length > 1
      ? [...images.map((i) => i.video?.file.name ?? `${i.name}.jpg`), '-o', 'out/']
      : [active?.video?.file.name ?? `${active?.name ?? 'input'}.jpg`, '-o', `${active?.name ?? 'input'}-${params.style}.${active?.video ? videoFormat : 'png'}`];
    return ['node cli/ascii-maker.ts', ...io, ...size, ...flags].join(' ');
  }, [params, images, active, exportSize, videoFormat]);

  // ---- keyboard ----
  const step = useCallback((d: number) => {
    const list = imagesRef.current;
    if (list.length < 2) return;
    setActiveId((cur) => {
      const i = list.findIndex((x) => x.id === cur);
      return list[(i + d + list.length) % list.length].id;
    });
  }, []);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !typing(e.target) && maskingRef.current && !e.shiftKey) { e.preventDefault(); undoMask(); }
      else if (mod && key === 'z' && !typing(e.target)) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && key === 'y' && !typing(e.target)) { e.preventDefault(); redo(); }
      else if (mod && key === 'o') { e.preventDefault(); fileInput.current?.click(); }
      else if (mod && key === 's') {
        e.preventDefault();
        // Commit a half-typed value box (it applies on blur) before exporting.
        (document.activeElement as HTMLElement | null)?.blur();
        setTimeout(() => (e.shiftKey ? exportAll() : doExport()), 0);
      }
      else if (e.key === 'Escape') { setPicking(false); setMasking(false); }
      else if (mod || typing(e.target) || (e.target as HTMLElement)?.closest?.('[role=slider],[role=combobox],[role=listbox]')) return;
      else if (key === 'b') setHold(true);
      else if (key === 'm') { setMasking((v) => !v); setPicking(false); }
      else if (maskingRef.current && key === 'a') setMaskTool('add');
      else if (maskingRef.current && key === 'r') setMaskTool('remove');
      else if (maskingRef.current && key === 'e') setMaskTool('erase');
      else if (maskingRef.current && (key === '[' || key === ']')) setMaskSize((v) => Math.min(0.2, Math.max(0.005, v * (key === ']' ? 1.25 : 0.8))));
      else if (key === 'g') setView((v) => (v === 'grid' ? 'single' : 'grid'));
      else if (e.key === '\\') setSplit((s) => (s === null ? 0.5 : null));
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    const up = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'b') setHold(false); };
    const release = () => setHold(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', release); };
  }, [undo, redo, undoMask, doExport, exportAll, step]);

  const sizes = useMemo(() => [
    { value: 'source' as const, label: 'Original' },
    { value: '1080p' as const, label: '1080p' },
    { value: '2k' as const, label: '2K' },
    { value: '4k' as const, label: '4K' },
  ], [active]);

  const grid = view === 'grid' && images.length > 0;

  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={300}>
      <div className="grid h-full grid-cols-[minmax(0,1fr)] max-md:h-auto md:grid-cols-[minmax(0,1fr)_320px]">
        <input ref={fileInput} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { if (e.target.files) addFiles([...e.target.files]); e.target.value = ''; }} />

        <main
          className="relative min-h-0 min-w-0 overflow-hidden max-md:h-[64svh] max-md:min-h-[420px]"
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles([...e.dataTransfer.files]); }}
        >
          {grid ? (
            <Gallery images={images} activeId={activeId} params={params} size={exportSize} renderer={renderer} gen={gen}
              onOpen={(id) => { setActiveId(id); setView('single'); }} onRemove={removeImage} onAdd={() => fileInput.current?.click()} />
          ) : (
            <Stage
              original={active?.bitmap ?? null}
              viewKey={active?.id}
              frame={frame}
              result={shown?.bitmap ?? null}
              split={split}
              onSplit={setSplit}
              holdOriginal={hold}
              onOpen={() => fileInput.current?.click()}
              onSamples={addSamples}
              onExample={openExample}
              pick={picking && active ? { x: params.vignetteX, y: params.vignetteY, onPick: pickVignette, onDone: () => setPicking(false) } : null}
              paint={mask ? { mask, tool: maskTool, size: maskSize, overlay: maskOverlay, onStroke } : null}
            />
          )}

          {/* Floating toolbar */}
          <div className="glass absolute top-3 left-3 z-10 flex items-center gap-0.5 rounded-xl border border-line p-1 shadow-lg">
            <div className="flex items-center gap-2 pr-2 pl-2 font-mono text-[12px] font-medium tracking-tight text-fg select-none max-sm:hidden">
              <span className="grid size-4 grid-cols-2 grid-rows-2 gap-px" aria-hidden>
                <span className="rounded-[1px] bg-accent" /><span /><span /><span className="rounded-[1px] bg-accent" />
              </span>
              ascii-maker
            </div>
            <div className="mx-1 h-5 w-px bg-line max-sm:hidden" />
            <Tip label={<>Open<Kbd>Ctrl O</Kbd></>}>
              <Button size="icon" aria-label="Add images" onClick={() => fileInput.current?.click()}><ImageUp className="size-4" /></Button>
            </Tip>
            <Tip label={<>Paste<Kbd>Ctrl V</Kbd></>}>
              <Button size="icon" aria-label="Paste image" onClick={pasteFromClipboard}><ClipboardPaste className="size-4" /></Button>
            </Tip>
            <div className="mx-1 h-5 w-px bg-line" />
            <Tip label={<>Undo<Kbd>Ctrl Z</Kbd></>}>
              <Button size="icon" aria-label="Undo" onClick={undo} disabled={!past.current.length && params === committed.current}><Undo2 className="size-4" /></Button>
            </Tip>
            <Tip label={<>Redo<Kbd>Ctrl Shift Z</Kbd></>}>
              <Button size="icon" aria-label="Redo" onClick={redo} disabled={!future.current.length}><Redo2 className="size-4" /></Button>
            </Tip>
            <Tip label={<>Compare<Kbd>\</Kbd></>}>
              <Button size="icon" aria-label="Compare" aria-pressed={split !== null} disabled={!active || grid}
                className={cx(split !== null && !grid && 'bg-white/[0.08] text-accent')}
                onClick={() => setSplit((s) => (s === null ? 0.5 : null))}><Columns2 className="size-4" /></Button>
            </Tip>
            <Tip label={canMask ? <>Paint where glyphs go<Kbd>M</Kbd></> : 'Mask brush works with glyph styles'}>
              <Button size="icon" aria-label="Mask brush" aria-pressed={!!mask} disabled={!canMask}
                className={cx('relative', mask && 'bg-white/[0.08] text-accent')}
                onClick={() => { setMasking((v) => !v); setPicking(false); }}>
                <Brush className="size-4" />
                {active && painted.current.has(active.id) && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" aria-hidden />}
              </Button>
            </Tip>
            <Tip label={gpu ? 'Hardware acceleration on: rendering uses the GPU' : 'Hardware acceleration off: rendering uses the CPU'}>
              <Button size="icon" aria-label="Hardware acceleration" aria-pressed={gpu}
                className={cx(gpu && 'text-accent')}
                onClick={() => {
                  const v = !gpu;
                  setGpu(v);
                  gpuRef.current = v;
                  try { localStorage.setItem(GPU_KEY, v ? '1' : '0'); } catch { /* storage unavailable */ }
                  renderer?.setGpu(v);
                  setGen((g) => g + 1);
                }}><Cpu className="size-4" /></Button>
            </Tip>
          </div>

          {images.length > 0 && (
            <div className="glass absolute top-3 right-3 z-10 flex items-center gap-0.5 rounded-xl border border-line p-1 shadow-lg" role="group" aria-label="View">
              <Tip label={<>Single<Kbd>G</Kbd></>}>
                <Button size="sm" aria-pressed={!grid} onClick={() => setView('single')} className={cx(!grid && 'bg-white/[0.08] text-fg')}>
                  <Square className="size-3.5" />Single
                </Button>
              </Tip>
              <Tip label={<>All<Kbd>G</Kbd></>}>
                <Button size="sm" aria-pressed={grid} onClick={() => setView('grid')} className={cx(grid && 'bg-white/[0.08] text-fg')}>
                  <LayoutGrid className="size-3.5" />All<span className="font-mono text-[11px] text-faint">{images.length}</span>
                </Button>
              </Tip>
            </div>
          )}

          {mask && (
            <MaskBar tool={maskTool} size={maskSize} overlay={maskOverlay} canUndo={mask.canUndo}
              onTool={setMaskTool} onSize={setMaskSize} onOverlay={setMaskOverlay} onUndo={undoMask}
              onClear={() => { mask.clear(); onStroke(); }} onDone={() => setMasking(false)} />
          )}

          {!grid && images.length > 1 && <Filmstrip images={images} activeId={activeId} onSelect={setActiveId} onRemove={removeImage} onAdd={() => fileInput.current?.click()} />}

          {!grid && active && frame && (shown || active.video) && (
            <div className={cx('glass absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-line px-3 py-1 font-mono text-[11px] text-muted tabular-nums',
              active.video && 'w-[min(720px,calc(100%-1.5rem))]')}>
              <span className="max-w-40 shrink-0 truncate text-fg max-sm:max-w-24">{active.name}</span>
              <span className="h-3 w-px shrink-0 bg-line" />
              {active.video && (
                <>
                  <Scrubber time={scrubTime} duration={active.video.info.duration} fps={active.video.info.fps} onChange={(t) => setScrub({ id: active.id, time: t })} />
                  <span className="h-3 w-px shrink-0 bg-line max-sm:hidden" />
                </>
              )}
              <span className={cx('shrink-0', active.video && 'max-sm:hidden')}>{frame.width} × {frame.height}</span>
              {shown && (
                <>
                  <span className="h-3 w-px shrink-0 bg-line max-sm:hidden" />
                  <span className="shrink-0 max-sm:hidden">{Math.round(shown.ms)} ms · {shown.gpu ? 'GPU' : 'CPU'}</span>
                </>
              )}
            </div>
          )}

          <div
            className="pointer-events-none absolute inset-3 z-20 rounded-2xl border-2 border-dashed border-accent/60 bg-accent/[0.04] transition-opacity duration-150"
            style={{ opacity: dragging ? 1 : 0 }}
          />

          {toast && (
            <div key={toast.id} role="status" className="glass absolute bottom-24 left-1/2 z-30 -translate-x-1/2 animate-[pop-in_180ms_var(--ease-out)] rounded-lg border border-line-strong px-3 py-1.5 text-[12px] whitespace-nowrap text-fg shadow-xl">
              {toast.text}
            </div>
          )}
        </main>

        <aside className="flex min-h-0 min-w-0 flex-col border-line bg-surface max-md:border-t md:border-l">
          <div className="flex items-center gap-2 px-4 pt-3">
            <Select label="Preset" value={preset} options={presetOptions} onChange={applyPreset} className="min-w-0 flex-1" />
            <Popover
              open={saveOpen}
              onOpenChange={(v) => { setSaveOpen(v); if (v) setSaveName(userPreset ? preset.slice(USER.length) : ''); }}
              trigger={<Button size="icon" aria-label="Save as preset"><BookmarkPlus className="size-3.5" /></Button>}
            >
              <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); savePreset(); }}>
                <div className="text-[12px] text-fg">Save current settings as a preset</div>
                <TextField label="Preset name" value={saveName} onChange={setSaveName} />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-faint">{saveName.trim() in userPresets ? 'Overwrites the saved preset' : 'Stored in this browser'}</span>
                  <Button type="submit" variant="primary" size="sm" disabled={!saveName.trim()}>Save</Button>
                </div>
              </form>
            </Popover>
            {userPreset && (
              <Tip label="Delete this saved preset">
                <Button size="icon" aria-label="Delete preset" onClick={deletePreset}><Trash2 className="size-3.5" /></Button>
              </Tip>
            )}
            <Tip label={preset === CUSTOM ? 'Reset everything to defaults' : 'Undo all changes to this preset'}>
              <Button size="icon" aria-label="Reset to preset" disabled={!edits} onClick={() => { setParams(base); setEpoch((n) => n + 1); }}><RotateCcw className="size-3.5" /></Button>
            </Tip>
          </div>
          <p className="truncate px-4 pt-1.5 text-[11px] text-faint empty:hidden" title={PRESETS[preset]?.description}>
            {edits ? <span className="text-accent">{edits} change{edits > 1 ? 's' : ''}</span> : null}
            {edits && PRESETS[preset] ? ' · ' : null}
            {PRESETS[preset]?.description}
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <Inspector params={params} base={base} set={set} resetKey={presetEpoch} picking={picking && !grid} onPicking={(v) => { setPicking(v); if (v) setView('single'); }} />
          </div>
          <div className="flex gap-2 border-t border-line bg-surface p-3 max-md:sticky max-md:bottom-0 max-md:z-20">
            {job ? (
              <>
                <Progress value={job.value} label={job.label} />
                <Tip label="Cancel export" side="top">
                  <Button variant="solid" size="icon" className="size-9" aria-label="Cancel export" onClick={() => abort.current?.abort()}><X className="size-4" /></Button>
                </Tip>
              </>
            ) : grid ? (
              <Button variant="primary" className="flex-1" disabled={!images.length} onClick={exportAll}>
                <Download className="size-4" />Export all {images.length}
              </Button>
            ) : (
              <Button variant="primary" className="flex-1" disabled={!active} onClick={doExport}>
                <Download className="size-4" />{active?.video ? 'Export video' : 'Export'}
              </Button>
            )}
            <Popover trigger={<Button variant="solid" size="icon" aria-label="Export options"><Settings2 className="size-4" /></Button>}>
                            <Row label="Size"><Select label="Export size" value={exportSize} options={sizes} onChange={setExportSize} /></Row>
              <Row label="Format"><Select label="Format" value={format} options={FORMATS} onChange={setFormat} /></Row>
              {format === 'image/png'
                ? <SliderField label="Compression" hint="Lossless either way: higher is smaller but slower to export. JPEG or WebP are far smaller." value={pngLevel} min={0} max={9} step={1} onChange={setPngLevel} />
                : <SliderField label="Quality" hint="Lower makes smaller files with more compression artifacts." value={quality} min={10} max={100} step={1} onChange={setQuality} />}
              {sampleVideo && (
                <>
                  <Row label="Video" hint="Container and codec for exported videos.">
                    <Select label="Video format" value={videoFormat} onChange={setVideoFormat}
                      options={VIDEO_FORMATS.map((f) => {
                        const off = !!encodable && !encodable.includes(f.value);
                        return { value: f.value, label: f.label, disabled: off, hint: off ? 'This browser cannot encode it' : undefined };
                      })} />
                  </Row>
                  <Row label="Keep audio" hint="Copy the source audio into exported videos, or leave them silent.">
                    <Switch label="Keep audio" checked={keepAudio} onChange={setKeepAudio} />
                  </Row>
                </>
              )}
              {frame && <div className="pt-1 pb-2 text-right font-mono text-[11px] text-faint">{frame.width} × {frame.height}px</div>}
              <div className="mt-1 grid gap-1 border-t border-line pt-2">
                {images.length > 1 && (
                  <Button size="sm" className="justify-start" disabled={!!job} onClick={exportAll}>
                    <Download className="size-3.5" />Export all (.zip)
                  </Button>
                )}
                <Button size="sm" className="justify-start" disabled={!shown?.text} onClick={() => shown?.text && copy(shown.text, 'ASCII text')}>
                  <Copy className="size-3.5" />Copy ASCII text
                </Button>
                <Button size="sm" className="justify-start" onClick={() => copy(cliCommand(), 'CLI command')}>
                  <Terminal className="size-3.5" />Copy CLI command
                </Button>
                <Button size="sm" className="justify-start" onClick={() => download(new Blob([JSON.stringify(changed(params), null, 2)], { type: 'application/json' }), 'ascii-maker-params.json')}>
                  <Braces className="size-3.5" />Save params JSON
                </Button>
              </div>
            </Popover>
          </div>
        </aside>
      </div>
    </Tooltip.Provider>
  );
}
