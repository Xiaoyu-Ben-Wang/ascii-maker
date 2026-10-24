import { ImageUp, Sparkles, ZoomOut } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Frame } from '../../engine/index.ts';
import { NO_ZOOM, usePanZoom, type ZoomControl } from '../hooks/usePanZoom.ts';
import { EXAMPLES, exampleUrl, type SampleSource } from '../lib/samples.ts';
import { MaskLayer, type Paint } from './MaskLayer.tsx';
import { Button, cx } from './ui.tsx';

interface Props {
  original: ImageBitmap | null;
  /** Identifies the image shown; zoom resets when it changes (a new video frame keeps the same key). */
  viewKey?: unknown;
  frame: Frame | null;
  result: ImageBitmap | null;
  /** 0..1 position of the before/after divider, or null when not comparing. */
  split: number | null;
  onSplit: (v: number) => void;
  holdOriginal: boolean;
  onOpen: () => void;
  onSamples: () => void;
  /** Show the start screen when there is no image. */
  empty: boolean;
  /** Shown, softened, while the source decodes. */
  placeholder?: string | null;
  onExample: (source: SampleSource, preset: string) => void;
  /** Clicking or dragging on the image picks a point (0..1 of width and height). */
  pick?: { x: number; y: number; onPick: (x: number, y: number) => void; onDone: () => void } | null;
  paint?: Paint | null;
  /** Filled in with the stage's zoom controls, for keyboard shortcuts. */
  zoom?: RefObject<ZoomControl | null>;
}

export function Stage({ original, viewKey, frame, result, split, onSplit, holdOriginal, onOpen, onSamples, empty, placeholder, onExample, pick, paint, zoom }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const origRef = useRef<HTMLCanvasElement>(null);
  const resRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [fit, setFit] = useState({ w: 0, h: 0 });
  // The zoom at which one rendered pixel is one device pixel.
  const actual = frame && fit.w ? Math.max(1, frame.width / (fit.w * devicePixelRatio)) : 1;
  const { view, setView, spacePan, control } = usePanZoom(stageRef, fit, !!original, actual);
  if (zoom) zoom.current = control.current;
  const crisp = view.z >= actual * 0.99;
  const rendering = crisp ? 'pixelated' : 'auto';

  const key = viewKey ?? original;
  useEffect(() => setView(NO_ZOOM), [key, frame, setView]);

  useLayoutEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!frame || !box.w) return;
    const k = Math.min((box.w - 48) / frame.width, (box.h - 150) / frame.height);
    setFit({ w: Math.max(1, Math.floor(frame.width * k)), h: Math.max(1, Math.floor(frame.height * k)) });
  }, [frame, box.w, box.h]);

  // The "before" layer is the source drawn once at the export resolution, like the render.
  useEffect(() => {
    const c = origRef.current;
    if (!c || !original || !frame) return;
    c.width = frame.width;
    c.height = frame.height;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    const { x, y, w, h } = frame.crop;
    ctx.drawImage(original, x, y, w, h, 0, 0, c.width, c.height);
  }, [original, frame]);

  useEffect(() => {
    // A bitmap that was already shown is detached (width 0) and can't be transferred again.
    if (result && result.width === 0) return;
    resRef.current?.getContext('bitmaprenderer')!.transferFromImageBitmap(result);
  }, [result]);

  const clip = holdOriginal ? 'inset(0 0 0 100%)' : split !== null ? `inset(0 0 0 ${split * 100}%)` : 'none';

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const rect = target.parentElement!.getBoundingClientRect();
    const move = (ev: PointerEvent) => onSplit(Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)));
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const startPick = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pick || e.button !== 0) return;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    // The rect already includes the zoom transform.
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = target.getBoundingClientRect();
      const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
      pick.onPick(c((ev.clientX - r.left) / r.width), c((ev.clientY - r.top) / r.height));
    };
    at(e);
    const up = () => { target.removeEventListener('pointermove', at); target.removeEventListener('pointerup', up); pick.onDone(); };
    target.addEventListener('pointermove', at);
    target.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={stageRef}
      className={cx('stage-grid absolute inset-0 flex items-center justify-center overflow-hidden px-4', original && 'select-none', (view.z > 1 || spacePan) && 'cursor-grab active:cursor-grabbing')}
      // Page pinch and double-tap zoom are handled here instead; one-finger scrolling still moves the page until zoomed.
      style={original ? { touchAction: view.z > 1 ? 'none' : 'pan-x pan-y', WebkitTouchCallout: 'none' } : undefined}
    >
      {original ? (
        <div
          className="relative shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)] ring-1 ring-white/[0.06]"
          style={{ width: fit.w, height: fit.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
        >
          <canvas ref={origRef} className="absolute inset-0 size-full" style={{ imageRendering: rendering }} />
          <canvas ref={resRef} className="absolute inset-0 size-full" style={{ clipPath: clip, imageRendering: rendering }} />
          {pick && (
            <div data-overlay className="absolute inset-0 z-20 cursor-crosshair touch-none" onPointerDown={startPick}>
              <div className="pointer-events-none absolute size-5 -translate-1/2 rounded-full border-2 border-accent shadow-[0_0_0_1px_rgb(0_0_0/0.6),0_0_12px_rgb(157_251_208/0.6)]"
                style={{ left: `${pick.x * 100}%`, top: `${pick.y * 100}%`, scale: `${1 / view.z}` }} />
            </div>
          )}
          {paint && frame && !pick && <MaskLayer paint={paint} crop={frame.crop} sourceWidth={original.width} />}
          {split !== null && !holdOriginal && (
            <div data-overlay className="absolute inset-y-0 z-10 w-8 -translate-x-1/2 cursor-ew-resize touch-none" style={{ left: `${split * 100}%`, scale: `${1 / view.z} 1` }} onPointerDown={startDrag}>
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/80 shadow-[0_0_12px_rgb(255_255_255/0.6)]" />
              <div className="absolute top-1/2 left-1/2 flex size-7 -translate-1/2 items-center justify-center rounded-full border border-white/30 bg-black/50 font-mono text-[10px] text-white backdrop-blur" style={{ scale: `1 ${1 / view.z}` }}>⇆</div>
            </div>
          )}
        </div>
      ) : placeholder && frame && fit.w ? (
        <img src={placeholder} alt="" className="blur-[2px]" style={{ width: fit.w, height: fit.h, objectFit: 'cover' }} />
      ) : empty && (
        <div className="flex max-h-full w-full max-w-3xl flex-col items-center overflow-y-auto py-16 text-center">
          <div className="mb-5 font-mono text-[11px] leading-[1.15] whitespace-pre text-accent/70 select-none" aria-hidden>
            {'  .:-=+xX0S8#@\n .:-=+xX0S8#@@\n:-=+xX0S8#@@@\n'}
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={onOpen}><ImageUp className="size-4" />Open</Button>
            <Button variant="solid" onClick={onSamples}><Sparkles className="size-4" />Samples</Button>
          </div>
          <div className="mt-10 grid w-full grid-cols-2 gap-3 sm:grid-cols-3">
            {EXAMPLES.map((ex) => (
              <button
                key={`${ex.source}-${ex.preset}`}
                onClick={() => onExample(ex.source, ex.preset)}
                className="press group overflow-hidden rounded-lg border border-line bg-surface text-left outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <img src={exampleUrl(`${ex.source}-${ex.preset}-thumb.webp`)} alt={`${ex.source} in the ${ex.preset} preset`} loading="lazy" decoding="async"
                  className="block aspect-[16/10] w-full object-cover" />
                <span className="flex items-center justify-between px-2.5 py-1.5 text-[11px]">
                  <span className="text-fg">{ex.preset}</span>
                  <span className="text-faint">{ex.source}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {original && frame && (
        <button
          onClick={() => control.current.toggleActual()}
          aria-label={view.z > 1 ? 'Zoom to fit' : 'Zoom to 100%'}
          title="Fit / 100% (Z)"
          className="press glass absolute right-3 bottom-3 z-10 flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 font-mono text-[11px] text-fg tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:bottom-14"
        >
          {view.z > 1 ? `${Math.round((view.z / actual) * 100)}%` : 'Fit'}
          {view.z > 1 && <ZoomOut className="size-3.5 text-muted" />}
        </button>
      )}
    </div>
  );
}
