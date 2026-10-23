import {
  Braces, ClipboardPaste, Columns2, Copy, Download, ImageUp, LayoutGrid, Redo2, RotateCcw, Settings2, Square, Terminal, Undo2,
} from 'lucide-react';
import { Tooltip } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULTS, PRESETS, frameFor, resolveParams, type Params, type SizeName } from '../engine/index.ts';
import { Filmstrip, Gallery, type Img } from './Gallery.tsx';
import { Inspector } from './Inspector.tsx';
import { Renderer, type Rendered } from './renderer.ts';
import { SAMPLE_SOURCES, loadSample, type SampleSource } from './sample.ts';
import { Stage } from './Stage.tsx';
import { Button, Kbd, Popover, Row, Select, Tip, cx } from './ui.tsx';
import { zip } from './zip.ts';

const STORE_KEY = 'ascii-maker:v2';
const CUSTOM = 'custom';
const PRESET_OPTIONS = [
  ...Object.entries(PRESETS).map(([k, p]) => ({ value: k, label: k, hint: p.description })),
  { value: CUSTOM, label: 'custom', hint: 'Your own settings' },
];
const FORMATS = [
  { value: 'image/png', label: 'PNG' },
  { value: 'image/jpeg', label: 'JPEG' },
  { value: 'image/webp', label: 'WebP' },
];

interface Result { id: number; bitmap: ImageBitmap; text?: string; ms: number; draft: boolean }

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
const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;

export function App() {
  const stored = useMemo(loadStored, []);
  const [params, setParams] = useState<Params>(stored.params);
  const [preset, setPreset] = useState(stored.preset);
  const [images, setImages] = useState<Img[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [view, setView] = useState<'single' | 'grid'>('single');
  const [result, setResult] = useState<Result | null>(null);
  const [fitWidth, setFitWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [exportSize, setExportSize] = useState<SizeName>('source');
  const [format, setFormat] = useState('image/png');
  const [exporting, setExporting] = useState<string | null>(null);
  const [split, setSplit] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [hold, setHold] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  /** Bumped after a crashed render worker recovers, so every view re-requests its render. */
  const [gen, setGen] = useState(0);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const fileInput = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  const active = images.find((i) => i.id === activeId) ?? null;

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
    });
    for (const img of imagesRef.current) r.addSource(img.id, img.bitmap);
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
  const applyPreset = useCallback((name: string) => {
    setEpoch((n) => n + 1);
    setPreset(name);
    if (PRESETS[name]) setParams(resolveParams(PRESETS[name].params));
  }, []);
  const base = useMemo(() => resolveParams(PRESETS[preset]?.params ?? {}), [preset]);
  const edits = useMemo(() => (Object.keys(DEFAULTS) as (keyof Params)[]).filter((k) => params[k] !== base[k]).length, [params, base]);

  // ---- image set ----
  const addBitmap = useCallback(async (bitmap: ImageBitmap, name: string) => {
    const id = nextId.current++;
    if (renderer) await renderer.addSource(id, bitmap);
    setImages((list) => [...list, { id, bitmap, name, width: bitmap.width, height: bitmap.height }]);
    setActiveId(id);
  }, [renderer]);
  const addFiles = useCallback(async (files: Iterable<File>, fallbackName = 'image') => {
    let failed = 0;
    for (const f of files) {
      if (!f.type.startsWith('image/')) { failed++; continue; }
      try {
        await addBitmap(await createImageBitmap(f), f.name.replace(/\.[^.]+$/, '') || fallbackName);
      } catch { failed++; }
    }
    if (failed) notify(`${failed} file${failed > 1 ? 's' : ''} could not be read as an image`);
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
    setImages((list) => {
      const img = list.find((i) => i.id === id);
      // Close after the canvases that draw it have unmounted.
      if (img) setTimeout(() => img.bitmap.close(), 1000);
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
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addFiles(files, 'pasted'); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  // ---- main preview: a quick half-res draft while values change, then the full preview once they settle ----
  const frame = useMemo(() => (active ? frameFor(active.width, active.height, exportSize) : null), [active, exportSize]);
  // Zoomed in, the preview renders at more of the export resolution so glyphs stay crisp.
  const previewWidth = frame && fitWidth ? Math.min(frame.width, Math.round(fitWidth * Math.min(2, devicePixelRatio) * zoom), zoom > 1 ? 4096 : 2200) : 0;
  const previewHeight = frame ? Math.max(1, Math.round((previewWidth * frame.height) / frame.width)) : 0;
  const onSize = useCallback((w: number) => setFitWidth(w), []);

  useEffect(() => {
    if (!active || !frame || !previewWidth || !renderer || view !== 'single') return;
    let cancelled = false;
    const id = active.id;
    const show = (res: Rendered | null, draft: boolean) => {
      if (!res || cancelled) { res?.bitmap.close(); return; }
      setResult((prev) => {
        if (prev && prev.bitmap !== res.bitmap) prev.bitmap.close();
        return { id, bitmap: res.bitmap, text: res.text, ms: res.ms, draft };
      });
    };
    const job = (w: number, h: number) => ({ sourceId: id, width: w, height: h, crop: frame.crop, targetWidth: frame.width, params });
    const draftW = Math.round(previewWidth / 2);
    if (draftW >= 480) renderer.preview(job(draftW, Math.max(1, Math.round(previewHeight / 2)))).then((r) => show(r, true));
    const t = setTimeout(() => renderer.preview(job(previewWidth, previewHeight)).then((r) => show(r, false)), draftW >= 480 ? 120 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [active, frame, params, previewWidth, previewHeight, renderer, view, gen]);

  // The result bitmap is consumed by the canvas that shows it, so drop it when that canvas unmounts.
  useEffect(() => {
    if (view === 'grid') setResult((prev) => { prev?.bitmap.close(); return null; });
  }, [view]);

  // Never show one image's render over another.
  const shown = result && result.id === activeId ? result : null;

  // ---- export ----
  const exportOne = useCallback(async (img: Img, p: Params) => {
    const f = frameFor(img.width, img.height, exportSize);
    const r = await renderer!.export({ sourceId: img.id, width: f.width, height: f.height, crop: f.crop, params: p, mime: format, quality: 0.92 });
    return { ...r, name: `${img.name}-${p.style}.${ext(format)}` };
  }, [renderer, exportSize, format]);

  const doExport = useCallback(async () => {
    if (!active || !renderer || exporting) return;
    setExporting('Rendering…');
    try {
      const r = await exportOne(active, paramsRef.current);
      download(r.blob, r.name);
      notify(`Exported ${r.width}×${r.height} in ${(r.ms / 1000).toFixed(1)}s`);
    } catch (e) {
      notify(`Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setExporting(null);
    }
  }, [active, renderer, exporting, exportOne, notify]);

  const exportAll = useCallback(async () => {
    const list = imagesRef.current;
    if (!list.length || !renderer || exporting) return;
    const t0 = performance.now();
    const p = paramsRef.current; // one look for the whole batch, even if sliders move meanwhile
    try {
      const files: { name: string; blob: Blob }[] = [];
      const used = new Set<string>();
      for (const [i, img] of list.entries()) {
        if (!imagesRef.current.some((x) => x.id === img.id)) continue; // removed mid-export
        setExporting(`${i + 1} / ${list.length}`);
        const r = await exportOne(img, p);
        let name = r.name;
        for (let n = 2; used.has(name); n++) name = r.name.replace(/(\.\w+)$/, `-${n}$1`);
        used.add(name);
        files.push({ name, blob: r.blob });
      }
      download(await zip(files), `ascii-maker-${p.style}.zip`);
      notify(`Exported ${files.length} images in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      notify(`Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setExporting(null);
    }
  }, [renderer, exporting, exportOne, notify]);

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
      ? [...images.map((i) => `${i.name}.jpg`), '-o', 'out/']
      : [`${active?.name ?? 'input'}.jpg`, '-o', `${active?.name ?? 'input'}-${params.style}.png`];
    return ['node cli/ascii-maker.ts', ...io, ...size, ...flags].join(' ');
  }, [params, images, active, exportSize]);

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
      if (mod && key === 'z' && !typing(e.target)) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && key === 'y' && !typing(e.target)) { e.preventDefault(); redo(); }
      else if (mod && key === 'o') { e.preventDefault(); fileInput.current?.click(); }
      else if (mod && key === 's') {
        e.preventDefault();
        // Commit a half-typed value box (it applies on blur) before exporting.
        (document.activeElement as HTMLElement | null)?.blur();
        setTimeout(() => (e.shiftKey ? exportAll() : doExport()), 0);
      }
      else if (e.key === 'Escape') setPicking(false);
      else if (mod || typing(e.target) || (e.target as HTMLElement)?.closest?.('[role=slider],[role=combobox],[role=listbox]')) return;
      else if (key === 'b') setHold(true);
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
  }, [undo, redo, doExport, exportAll, step]);

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
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) addFiles([...e.target.files]); e.target.value = ''; }} />

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
              frame={frame}
              result={shown?.bitmap ?? null}
              split={split}
              onSplit={setSplit}
              holdOriginal={hold}
              onOpen={() => fileInput.current?.click()}
              onSamples={addSamples}
              onExample={openExample}
              onSize={onSize}
              onZoom={setZoom}
              pick={picking && active ? { x: params.vignetteX, y: params.vignetteY, onPick: pickVignette, onDone: () => setPicking(false) } : null}
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

          {!grid && images.length > 1 && <Filmstrip images={images} activeId={activeId} onSelect={setActiveId} onRemove={removeImage} onAdd={() => fileInput.current?.click()} />}

          {!grid && active && shown && frame && (
            <div className="glass absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-line px-3 py-1 font-mono text-[11px] text-muted tabular-nums">
              <span className="max-w-40 truncate text-fg">{active.name}</span>
              <span className="h-3 w-px bg-line" />
              <span>{frame.width} × {frame.height}</span>
              <span className="h-3 w-px bg-line" />
              <span className={cx('transition-colors duration-150', shown.draft ? 'text-faint' : 'text-muted')}>{Math.round(shown.ms)} ms</span>
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
            <Select label="Preset" value={preset} options={PRESET_OPTIONS} onChange={applyPreset} className="min-w-0 flex-1" />
            <Tip label={preset === CUSTOM ? 'Reset everything to defaults' : 'Undo all changes to this preset'}>
              <Button size="icon" aria-label="Reset to preset" disabled={!edits} onClick={() => { setParams(base); setEpoch((n) => n + 1); }}><RotateCcw className="size-3.5" /></Button>
            </Tip>
          </div>
          <p className="truncate px-4 pt-1.5 text-[11px] text-faint" title={PRESETS[preset]?.description}>
            {edits ? <><span className="text-accent">{edits} change{edits > 1 ? 's' : ''}</span> · </> : null}
            {PRESETS[preset]?.description ?? 'Your own settings. Pick a preset to start over.'}
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <Inspector params={params} base={base} set={set} resetKey={presetEpoch} picking={picking && !grid} onPicking={(v) => { setPicking(v); if (v) setView('single'); }} />
          </div>
          <div className="flex gap-2 border-t border-line bg-surface p-3 max-md:sticky max-md:bottom-0 max-md:z-20">
            {grid ? (
              <Button variant="primary" className="flex-1" disabled={!images.length || !!exporting} onClick={exportAll}>
                <Download className="size-4" />{exporting ?? `Export all ${images.length}`}
              </Button>
            ) : (
              <Button variant="primary" className="flex-1" disabled={!active || !!exporting} onClick={doExport}>
                <Download className="size-4" />{exporting ?? 'Export'}
              </Button>
            )}
            <Popover trigger={<Button variant="solid" size="icon" aria-label="Export options"><Settings2 className="size-4" /></Button>}>
                            <Row label="Size"><Select label="Export size" value={exportSize} options={sizes} onChange={setExportSize} /></Row>
              <Row label="Format"><Select label="Format" value={format} options={FORMATS} onChange={setFormat} /></Row>
              {frame && <div className="pt-1 pb-2 text-right font-mono text-[11px] text-faint">{frame.width} × {frame.height}px</div>}
              <div className="mt-1 grid gap-1 border-t border-line pt-2">
                {images.length > 1 && (
                  <Button size="sm" className="justify-start" disabled={!!exporting} onClick={exportAll}>
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
