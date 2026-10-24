import { Tooltip } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PRESETS, diffParams, frameFor, resolveParams, type Params } from '../engine/index.ts';
import { ExportBar } from './components/ExportBar.tsx';
import { cx } from './components/ui.tsx';
import { Filmstrip, Gallery, type SelectMods } from './components/Gallery.tsx';
import { Inspector } from './components/Inspector.tsx';
import { LibraryPanel } from './components/LibraryPanel.tsx';
import { MaskBar } from './components/MaskBar.tsx';
import { PresetBar } from './components/PresetBar.tsx';
import { ShortcutSheet } from './components/ShortcutSheet.tsx';
import { Stage } from './components/Stage.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { ModeSwitch, Toolbar, type Mode } from './components/Toolbar.tsx';
import { useExport } from './hooks/useExport.ts';
import { useHotkeys } from './hooks/useHotkeys.ts';
import { useCatalog } from './hooks/useCatalog.ts';
import { useLook, type ImgLook } from './hooks/useLook.ts';
import { useMasks } from './hooks/useMasks.ts';
import type { ZoomControl } from './hooks/usePanZoom.ts';
import { usePreview } from './hooks/usePreview.ts';
import { useRenderer } from './hooks/useRenderer.ts';
import { useScrub } from './hooks/useScrub.ts';
import { useToast } from './hooks/useToast.ts';
import { cliCommand } from './lib/cli-command.ts';
import { download } from './lib/files.ts';
import { KEYS, load, save } from './lib/storage.ts';
import type { MaskTool } from './lib/mask.ts';
import type { Renderer } from './lib/renderer.ts';
import { SAMPLE_SOURCES, loadSample, type SampleSource } from './lib/samples.ts';

export function App() {
  const { toast, notify } = useToast();

  const seed = useRef<(r: Renderer) => void>(() => {});
  const { renderer, gen, gpu, toggleGpu } = useRenderer(notify, seed);
  const masks = useMasks(renderer);
  const newLook = useRef<() => ImgLook>(() => { throw new Error('look not ready'); });
  const library = useCatalog(renderer, notify, masks, useCallback(() => newLook.current(), []));
  const { images, active, activeId } = library;
  const look = useLook(notify, active ? { key: active.key, look: active.look } : null, library.updateLook);
  newLook.current = look.current;
  const { params, set } = look;
  seed.current = (r) => {
    for (const img of images) {
      if (!img.bitmap) continue;
      r.addSource(img.id, img.bitmap);
      const m = masks.read(img.id);
      if (m) r.setMask(img.id, m);
    }
  };

  const [mode, setMode] = useState<Mode>('develop');
  // A library restored on load opens in the Library.
  const [opened, setOpened] = useState(false);
  if (library.loaded && !opened) { setOpened(true); if (images.length) setMode('library'); }
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const zoom = useRef<ZoomControl | null>(null);
  const [split, setSplit] = useState<number | null>(null);
  const [hold, setHold] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const [masking, setMasking] = useState(false);
  const [maskTool, setMaskTool] = useState<MaskTool>('add');
  const [maskSize, setMaskSize] = useState(0.04);
  const [maskOverlay, setMaskOverlay] = useState(true);
  const [panels, setPanels] = useState<Record<Mode, boolean>>({ library: true, loupe: false, develop: true });
  const [chrome, setChrome] = useState(true);
  const [help, setHelp] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const openFiles = useCallback(() => fileInput.current?.click(), []);

  // The creation that was active before this one, for "paste settings from previous".
  const lastActive = useRef(activeId);
  const prevActive = useRef<number | null>(null);
  if (lastActive.current !== activeId) { prevActive.current = lastActive.current; lastActive.current = activeId; }

  const grid = mode === 'library' && images.length > 0;
  const develop = mode === 'develop';
  const loupe = mode === 'loupe' && !!active;
  const panel = !chrome ? null : grid ? (panels.library ? 'library' : null) : loupe ? (panels.loupe ? 'library' : null) : panels.develop || !active ? 'develop' : null;
  const selection = useMemo(() => new Set(images.filter((i) => selected.has(i.id)).map((i) => i.id)), [images, selected]);
  const canMask = !!active && develop && params.style !== 'photo' && params.style !== 'dither';
  const mask = masking && canMask ? masks.get(active.id, active.width, active.height) : null;
  if (masking && !canMask) setMasking(false);

  const exporter = useExport(renderer, images, active, notify, library.ensure);
  useEffect(() => { if (!grid && activeId !== null) library.ensure(activeId); }, [grid, activeId, library.ensure]);
  const exportSize = exporter.settings.size;
  const frame = useMemo(() => (active ? frameFor(active.width, active.height, exportSize) : null), [active?.width, active?.height, exportSize]);
  const preview = usePreview(renderer, active, frame, params, !grid, `${gen}:${masks.gen}`);
  const scrub = useScrub(renderer, library, notify);

  const onStroke = useCallback(() => {
    if (activeId === null) return;
    masks.commit(activeId);
    library.maskChanged(activeId);
  }, [activeId, masks.commit, library.maskChanged]);
  const undoStroke = useCallback(() => {
    if (activeId === null) return;
    masks.undo(activeId);
    library.maskChanged(activeId);
  }, [activeId, masks.undo, library.maskChanged]);
  const toggleMasking = () => { setMasking((v) => !v); setPicking(false); };
  const toggleSplit = () => setSplit((s) => (s === null ? 0.5 : null));
  const exportActive = () => { if (active) exporter.exportOne(active); };
  const exportAll = () => exporter.exportAll(selection.size ? selection : undefined);
  const select = (id: number, { toggle, range }: SelectMods) => {
    setSelected((cur) => {
      if (range && activeId !== null) {
        const a = images.findIndex((i) => i.id === activeId), b = images.findIndex((i) => i.id === id);
        return new Set([...cur, ...images.slice(Math.min(a, b), Math.max(a, b) + 1).map((i) => i.id)]);
      }
      if (!toggle) return new Set([id]);
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    library.setActiveId(id);
  };
  const openIn = (m: Mode) => { setMode(m); if (m !== 'develop') { setPicking(false); setMasking(false); } };
  const drop = (id: number) => {
    const img = images.find((i) => i.id === id);
    if (img) look.dropHistory(img.key);
    library.remove(id);
  };
  const remove = (id: number) => {
    const img = images.find((i) => i.id === id);
    if (img && confirm(`Remove “${img.name}” from the library? Its saved copy and edits are deleted.`)) drop(id);
  };
  /** In the Library, removes the selection; elsewhere the creation on screen. */
  const removeSelection = () => {
    const ids = grid && selection.size ? [...selection] : activeId !== null ? [activeId] : [];
    if (ids.length === 1) { remove(ids[0]); setSelected(new Set()); return; }
    if (!ids.length || !confirm(`Remove ${ids.length} creations from the library? Their saved copies and edits are deleted.`)) return;
    for (const id of ids) drop(id);
    setSelected(new Set());
  };

  /** Copies or pastes whole looks between creations; a paste in the Library goes to the selection. */
  const copySettings = () => {
    if (!active) return;
    save(KEYS.clipboard, { preset: look.preset, params: diffParams(params) });
    notify('Copied settings');
  };
  const pasteLook = (from: ImgLook) => {
    const targets = selection.size > 0 ? images.filter((i) => selection.has(i.id)) : active ? [active] : [];
    for (const t of targets) {
      // The active creation's history records the change itself; others get an undo step for when they are opened.
      if (t.id !== activeId) look.remember(t.key, t.look.params, from.params);
      library.updateLook(t.key, { preset: from.preset, params: from.params });
    }
    if (targets.length) notify(`Pasted settings to ${targets.length === 1 ? targets[0].name : `${targets.length} creations`}`);
  };
  const pasteSettings = () => {
    const c = load<{ preset: string; params: Partial<Params> }>(KEYS.clipboard);
    if (!c?.params) { notify('Copy settings first (Ctrl+Shift+C)'); return; }
    pasteLook({ preset: c.preset, params: resolveParams(c.params) });
  };
  const pastePrevious = () => {
    const prev = images.find((i) => i.id === prevActive.current);
    if (prev) pasteLook(prev.look);
    else notify('No previous creation to paste from');
  };
  const eraseFrom = useRef<MaskTool | null>(null);
  const eraseHold = (held: boolean) => {
    if (held && eraseFrom.current === null) { eraseFrom.current = maskTool; setMaskTool('erase'); }
    else if (!held && eraseFrom.current !== null) { setMaskTool(eraseFrom.current); eraseFrom.current = null; }
  };
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => notify('Fullscreen is not available here'));
  };

  const addSamples = async () => {
    try {
      const blobs = await Promise.all(SAMPLE_SOURCES.map(loadSample));
      for (const [i, b] of blobs.entries()) await library.add(b, SAMPLE_SOURCES[i]);
      setMode('library');
    } catch {
      notify('Could not load the samples');
    }
  };
  const openExample = async (source: SampleSource, preset: string) => {
    try {
      await library.add(await loadSample(source), source, { preset, params: resolveParams(PRESETS[preset].params) });
      setMode('develop');
    } catch {
      notify('Could not load the example');
    }
  };
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); notify(`Copied ${what}`); } catch { notify('Clipboard unavailable'); }
  };

  const brush = (grow: boolean) => setMaskSize((v) => Math.min(0.2, Math.max(0.005, v * (grow ? 1.25 : 0.8))));
  const hotMode: Mode = grid ? 'library' : loupe ? 'loupe' : 'develop';
  useHotkeys({
    mode: hotMode,
    masking: !!mask,
    notify,
    eraseHold,
    escape: () => { if (help) setHelp(false); else { setPicking(false); setMasking(false); } },
    run: {
      library: () => openIn('library'),
      ...(images.length ? { loupe: () => openIn('loupe'), develop: () => openIn('develop') } : {}),
      openLoupe: () => { if (active) openIn('loupe'); },
      prev: () => library.step(-1, !grid && selection.size > 1 ? selection : undefined),
      next: () => library.step(1, !grid && selection.size > 1 ? selection : undefined),
      selectAll: () => setSelected(new Set(images.map((i) => i.id))),
      selectNone: () => setSelected(new Set()),
      remove: removeSelection,
      import: openFiles,
      export: () => (grid ? exportAll() : exportActive()),
      undo: mask ? undoStroke : look.undo,
      redo: look.redo,
      copySettings,
      pasteSettings,
      pastePrevious,
      reset: look.reset,
      before: () => setHold((h) => !h),
      split: toggleSplit,
      zoom: () => zoom.current?.toggleActual(),
      zoomIn: () => zoom.current?.zoomBy(1.5),
      zoomOut: () => zoom.current?.zoomBy(1 / 1.5),
      panel: () => { setChrome(true); setPanels((p) => ({ ...p, [hotMode]: !p[hotMode] })); },
      chrome: () => setChrome((c) => !c),
      fullscreen,
      help: () => setHelp((h) => !h),
      ...(canMask ? { mask: toggleMasking } : {}),
      maskAdd: () => setMaskTool('add'),
      maskRemove: () => setMaskTool('remove'),
      brushDown: () => brush(false),
      brushUp: () => brush(true),
    },
  });

  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={300}>
      <div className={cx('grid h-full grid-cols-[minmax(0,1fr)] max-md:h-auto', panel && 'md:grid-cols-[minmax(0,1fr)_320px]')}>
        <input ref={fileInput} type="file" accept="image/*,video/*" multiple hidden
          onChange={(e) => { if (e.target.files) library.addFiles([...e.target.files]); e.target.value = ''; }} />

        <main
          className="relative min-h-0 min-w-0 overflow-hidden max-md:h-[64svh] max-md:min-h-[420px]"
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
          onDrop={(e) => { e.preventDefault(); setDragging(false); library.addFiles([...e.dataTransfer.files]); }}
        >
          {grid ? (
            <Gallery images={images} activeId={activeId} selected={selection} size={exportSize} onSelect={select}
              onOpen={(id) => { library.setActiveId(id); openIn('loupe'); }} onRemove={remove} onAdd={openFiles} />
          ) : (
            <Stage
              original={active?.bitmap ?? null}
              placeholder={active?.thumb ?? null}
              viewKey={active?.id}
              frame={frame}
              result={preview?.bitmap ?? null}
              split={develop ? split : null}
              onSplit={setSplit}
              holdOriginal={develop && hold}
              onOpen={openFiles}
              onSamples={addSamples}
              empty={library.loaded && images.length === 0}
              onExample={openExample}
              zoom={zoom}
              pick={develop && picking && active ? { x: params.vignetteX, y: params.vignetteY, onPick: (x, y) => set({ vignetteX: x, vignetteY: y }), onDone: () => setPicking(false) } : null}
              paint={develop && mask ? { mask, tool: maskTool, size: maskSize, overlay: maskOverlay, onStroke } : null}
            />
          )}

          {chrome && <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start justify-between gap-2 *:pointer-events-auto">
            <Toolbar
              onHelp={() => setHelp(true)}
              onOpen={openFiles} onPaste={library.paste}
              onUndo={look.undo} onRedo={look.redo} canUndo={look.canUndo} canRedo={look.canRedo}
              comparing={split !== null && develop} canCompare={!!active && develop} onCompare={toggleSplit}
              masking={!!mask} canMask={canMask} painted={!!active && masks.isPainted(active.id)} onMask={toggleMasking}
              gpu={gpu} onGpu={toggleGpu}
            />
            {images.length > 0 && <ModeSwitch mode={mode} count={images.length} onChange={openIn} />}
          </div>}

          {mask && (
            <MaskBar tool={maskTool} size={maskSize} overlay={maskOverlay} canUndo={mask.canUndo}
              onTool={setMaskTool} onSize={setMaskSize} onOverlay={setMaskOverlay} onUndo={undoStroke}
              onClear={() => { mask.clear(); onStroke(); }} onDone={() => setMasking(false)} />
          )}

          {chrome && !grid && images.length > 1 && <Filmstrip images={images} activeId={activeId} onSelect={library.setActiveId} onRemove={remove} onAdd={openFiles} />}

          {chrome && !grid && active && frame && (preview || active.video) && (
            <StatusBar image={active} frame={frame} preview={preview} time={scrub.time} onScrub={(t) => scrub.setTime(active.id, t)} />
          )}

          <div
            className="pointer-events-none absolute inset-3 z-20 rounded-2xl border-2 border-dashed border-accent/60 bg-accent/[0.04] transition-opacity duration-150"
            style={{ opacity: dragging ? 1 : 0 }}
          />

          {help && <ShortcutSheet onClose={() => setHelp(false)} />}

          {toast && (
            <div key={toast.id} role="status" className="glass absolute bottom-24 left-1/2 z-30 -translate-x-1/2 animate-[pop-in_180ms_var(--ease-out)] rounded-lg border border-line-strong px-3 py-1.5 text-[12px] whitespace-nowrap text-fg shadow-xl">
              {toast.text}
            </div>
          )}
        </main>

        {panel && <aside className="flex min-h-0 min-w-0 flex-col border-line bg-surface max-md:border-t md:border-l">
          {panel === 'develop' ? (
            <>
              <PresetBar look={look} onCopy={active ? copySettings : undefined} onPaste={active ? pasteSettings : undefined} />
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <Inspector params={params} base={look.base} set={set} resetKey={`${active?.key}:${look.epoch}`} picking={picking}
                  onPicking={setPicking} />
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto"><LibraryPanel active={active} count={images.length} selected={selection.size} /></div>
          )}
          <ExportBar
            exporter={exporter} grid={grid} count={grid && selection.size > 1 ? selection.size : images.length} selectedOnly={grid && selection.size > 1} isVideo={active?.kind === 'video'} canExport={!!active} frame={frame} text={preview?.text}
            onExport={exportActive} onExportAll={exportAll}
            onCopyText={() => { if (preview?.text) copy(preview.text, 'ASCII text'); }}
            onCopyCli={() => copy(cliCommand(params, active, exportSize, exporter.settings.videoFormat), 'CLI command')}
            onSaveParams={() => download(new Blob([JSON.stringify(diffParams(params), null, 2)], { type: 'application/json' }), 'ascii-maker-params.json')}
          />
        </aside>}
      </div>
    </Tooltip.Provider>
  );
}
