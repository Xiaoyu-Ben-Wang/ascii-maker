import { Tooltip } from 'radix-ui';
import { useCallback, useMemo, useRef, useState } from 'react';
import { diffParams, frameFor } from '../engine/index.ts';
import { ExportBar } from './components/ExportBar.tsx';
import { Filmstrip, Gallery } from './components/Gallery.tsx';
import { Inspector } from './components/Inspector.tsx';
import { MaskBar } from './components/MaskBar.tsx';
import { PresetBar } from './components/PresetBar.tsx';
import { Stage } from './components/Stage.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Toolbar, ViewSwitch } from './components/Toolbar.tsx';
import { useExport } from './hooks/useExport.ts';
import { useHotkeys } from './hooks/useHotkeys.ts';
import { useImages } from './hooks/useImages.ts';
import { useLook } from './hooks/useLook.ts';
import { useMasks } from './hooks/useMasks.ts';
import { usePreview } from './hooks/usePreview.ts';
import { useRenderer } from './hooks/useRenderer.ts';
import { useScrub } from './hooks/useScrub.ts';
import { useToast } from './hooks/useToast.ts';
import { cliCommand } from './lib/cli-command.ts';
import { download } from './lib/files.ts';
import type { MaskTool } from './lib/mask.ts';
import type { Renderer } from './lib/renderer.ts';
import { SAMPLE_SOURCES, loadSample, type SampleSource } from './lib/samples.ts';

export function App() {
  const { toast, notify } = useToast();
  const look = useLook(notify);
  const { params, set } = look;

  const seed = useRef<(r: Renderer) => void>(() => {});
  const { renderer, gen, gpu, toggleGpu } = useRenderer(notify, seed);
  const masks = useMasks(renderer);
  const library = useImages(renderer, notify, masks.drop);
  const { images, active, activeId } = library;
  seed.current = (r) => {
    for (const img of images) {
      r.addSource(img.id, img.bitmap);
      const m = masks.read(img.id);
      if (m) r.setMask(img.id, m);
    }
  };

  const [view, setView] = useState<'single' | 'grid'>('single');
  const [split, setSplit] = useState<number | null>(null);
  const [hold, setHold] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const [masking, setMasking] = useState(false);
  const [maskTool, setMaskTool] = useState<MaskTool>('add');
  const [maskSize, setMaskSize] = useState(0.04);
  const [maskOverlay, setMaskOverlay] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const openFiles = useCallback(() => fileInput.current?.click(), []);

  const grid = view === 'grid' && images.length > 0;
  const canMask = !!active && view === 'single' && params.style !== 'photo' && params.style !== 'dither';
  const mask = masking && canMask ? masks.get(active.id, active.width, active.height) : null;
  if (masking && !canMask) setMasking(false);

  const exporter = useExport(renderer, images, active, notify);
  const exportSize = exporter.settings.size;
  const frame = useMemo(() => (active ? frameFor(active.width, active.height, exportSize) : null), [active?.width, active?.height, exportSize]);
  const preview = usePreview(renderer, active, frame, params, view === 'single', `${gen}:${masks.gen}`);
  const scrub = useScrub(renderer, library, notify);

  const onStroke = useCallback(() => { if (activeId !== null) masks.commit(activeId); }, [activeId, masks.commit]);
  const undoStroke = useCallback(() => { if (activeId !== null) masks.undo(activeId); }, [activeId, masks.undo]);
  const toggleMasking = () => { setMasking((v) => !v); setPicking(false); };
  const toggleSplit = () => setSplit((s) => (s === null ? 0.5 : null));
  const exportActive = () => { if (active) exporter.exportOne(active, look.params); };
  const exportAll = () => exporter.exportAll(look.params);

  const addSamples = async () => {
    try {
      const bitmaps = await Promise.all(SAMPLE_SOURCES.map(loadSample));
      for (const [i, b] of bitmaps.entries()) await library.add(b, SAMPLE_SOURCES[i]);
      setView('grid');
    } catch {
      notify('Could not load the samples');
    }
  };
  const openExample = async (source: SampleSource, preset: string) => {
    try {
      await library.add(await loadSample(source), source);
      look.apply(preset);
      setView('single');
    } catch {
      notify('Could not load the example');
    }
  };
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); notify(`Copied ${what}`); } catch { notify('Clipboard unavailable'); }
  };

  useHotkeys({
    masking: !!mask,
    undo: look.undo, redo: look.redo, undoStroke, open: openFiles,
    exportOne: exportActive, exportAll,
    escape: () => { setPicking(false); setMasking(false); },
    holdOriginal: setHold,
    toggleMask: toggleMasking,
    maskTool: setMaskTool,
    brush: (grow) => setMaskSize((v) => Math.min(0.2, Math.max(0.005, v * (grow ? 1.25 : 0.8)))),
    toggleView: () => setView((v) => (v === 'grid' ? 'single' : 'grid')),
    toggleSplit,
    step: library.step,
  });

  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={300}>
      <div className="grid h-full grid-cols-[minmax(0,1fr)] max-md:h-auto md:grid-cols-[minmax(0,1fr)_320px]">
        <input ref={fileInput} type="file" accept="image/*,video/*" multiple hidden
          onChange={(e) => { if (e.target.files) library.addFiles([...e.target.files]); e.target.value = ''; }} />

        <main
          className="relative min-h-0 min-w-0 overflow-hidden max-md:h-[64svh] max-md:min-h-[420px]"
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
          onDrop={(e) => { e.preventDefault(); setDragging(false); library.addFiles([...e.dataTransfer.files]); }}
        >
          {grid ? (
            <Gallery images={images} activeId={activeId} params={params} size={exportSize} renderer={renderer} gen={gen}
              onOpen={(id) => { library.setActiveId(id); setView('single'); }} onRemove={library.remove} onAdd={openFiles} />
          ) : (
            <Stage
              original={active?.bitmap ?? null}
              viewKey={active?.id}
              frame={frame}
              result={preview?.bitmap ?? null}
              split={split}
              onSplit={setSplit}
              holdOriginal={hold}
              onOpen={openFiles}
              onSamples={addSamples}
              onExample={openExample}
              pick={picking && active ? { x: params.vignetteX, y: params.vignetteY, onPick: (x, y) => set({ vignetteX: x, vignetteY: y }), onDone: () => setPicking(false) } : null}
              paint={mask ? { mask, tool: maskTool, size: maskSize, overlay: maskOverlay, onStroke } : null}
            />
          )}

          <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start justify-between gap-2 *:pointer-events-auto">
            <Toolbar
              onOpen={openFiles} onPaste={library.paste}
              onUndo={look.undo} onRedo={look.redo} canUndo={look.canUndo} canRedo={look.canRedo}
              comparing={split !== null && !grid} canCompare={!!active && !grid} onCompare={toggleSplit}
              masking={!!mask} canMask={canMask} painted={!!active && masks.isPainted(active.id)} onMask={toggleMasking}
              gpu={gpu} onGpu={toggleGpu}
            />
            {images.length > 0 && <ViewSwitch grid={grid} count={images.length} onChange={(g) => setView(g ? 'grid' : 'single')} />}
          </div>

          {mask && (
            <MaskBar tool={maskTool} size={maskSize} overlay={maskOverlay} canUndo={mask.canUndo}
              onTool={setMaskTool} onSize={setMaskSize} onOverlay={setMaskOverlay} onUndo={undoStroke}
              onClear={() => { mask.clear(); onStroke(); }} onDone={() => setMasking(false)} />
          )}

          {!grid && images.length > 1 && <Filmstrip images={images} activeId={activeId} onSelect={library.setActiveId} onRemove={library.remove} onAdd={openFiles} />}

          {!grid && active && frame && (preview || active.video) && (
            <StatusBar image={active} frame={frame} preview={preview} time={scrub.time} onScrub={(t) => scrub.setTime(active.id, t)} />
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
          <PresetBar look={look} />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <Inspector params={params} base={look.base} set={set} resetKey={look.epoch} picking={picking && !grid}
              onPicking={(v) => { setPicking(v); if (v) setView('single'); }} />
          </div>
          <ExportBar
            exporter={exporter} grid={grid} count={images.length} isVideo={!!active?.video} canExport={!!active} frame={frame} text={preview?.text}
            onExport={exportActive} onExportAll={exportAll}
            onCopyText={() => { if (preview?.text) copy(preview.text, 'ASCII text'); }}
            onCopyCli={() => copy(cliCommand(params, images, active, exportSize, exporter.settings.videoFormat), 'CLI command')}
            onSaveParams={() => download(new Blob([JSON.stringify(diffParams(params), null, 2)], { type: 'application/json' }), 'ascii-maker-params.json')}
          />
        </aside>
      </div>
    </Tooltip.Provider>
  );
}
