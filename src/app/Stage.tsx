import { ImageUp, Sparkles } from 'lucide-react';
import { EXAMPLES, exampleUrl, type SampleSource } from './sample.ts';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Frame } from '../engine/index.ts';
import { Button, Kbd } from './ui.tsx';

interface Props {
  original: ImageBitmap | null;
  frame: Frame | null;
  result: ImageBitmap | null;
  /** 0..1 position of the before/after divider, or null when not comparing. */
  split: number | null;
  onSplit: (v: number) => void;
  holdOriginal: boolean;
  onOpen: () => void;
  onSamples: () => void;
  onExample: (source: SampleSource, preset: string) => void;
  onSize: (cssWidth: number, cssHeight: number) => void;
  children?: ReactNode;
}

export function Stage({ original, frame, result, split, onSplit, holdOriginal, onOpen, onSamples, onExample, onSize, children }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const origRef = useRef<HTMLCanvasElement>(null);
  const resRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [fit, setFit] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!frame || !box.w) return;
    const k = Math.min((box.w - 48) / frame.width, (box.h - 150) / frame.height);
    const f = { w: Math.max(1, Math.floor(frame.width * k)), h: Math.max(1, Math.floor(frame.height * k)) };
    setFit(f);
    onSize(f.w, f.h);
  }, [frame, box.w, box.h, onSize]);

  // The "before" layer is the source drawn once at display resolution.
  useEffect(() => {
    const c = origRef.current;
    if (!c || !original || !frame || !fit.w) return;
    const dpr = Math.min(2, devicePixelRatio);
    c.width = Math.round(fit.w * dpr);
    c.height = Math.round(fit.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    const { x, y, w, h } = frame.crop;
    ctx.drawImage(original, x, y, w, h, 0, 0, c.width, c.height);
  }, [original, frame, fit.w, fit.h]);

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

  return (
    <div
      ref={stageRef}
      className="stage-grid absolute inset-0 flex items-center justify-center overflow-hidden px-4"
    >
      {original ? (
        <div className="relative shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)] ring-1 ring-white/[0.06]" style={{ width: fit.w, height: fit.h }}>
          <canvas ref={origRef} className="absolute inset-0 size-full" />
          <canvas ref={resRef} className="absolute inset-0 size-full" style={{ clipPath: clip }} />
          {split !== null && !holdOriginal && (
            <div className="absolute inset-y-0 z-10 w-8 -translate-x-1/2 cursor-ew-resize touch-none" style={{ left: `${split * 100}%` }} onPointerDown={startDrag}>
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/80 shadow-[0_0_12px_rgb(255_255_255/0.6)]" />
              <div className="absolute top-1/2 left-1/2 flex size-7 -translate-1/2 items-center justify-center rounded-full border border-white/30 bg-black/50 font-mono text-[10px] text-white backdrop-blur">⇆</div>
              <span className="glass absolute top-2 right-6 rounded px-1.5 py-0.5 text-[10px] text-muted">before</span>
              <span className="glass absolute top-2 left-6 rounded px-1.5 py-0.5 text-[10px] text-muted">after</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex max-h-full w-full max-w-3xl flex-col items-center overflow-y-auto py-16 text-center">
          <div className="mb-5 font-mono text-[11px] leading-[1.15] whitespace-pre text-accent/70 select-none" aria-hidden>
            {'  .:-=+xX0S8#@\n .:-=+xX0S8#@@\n:-=+xX0S8#@@@\n'}
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight text-fg">Turn any image into glyphs</h1>
          <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
            ASCII, cross-stitch, hatching, halftone and dither, with bloom and scanlines. Everything runs in your browser.
          </p>
          <div className="mt-6 flex gap-2">
            <Button variant="primary" onClick={onOpen}><ImageUp className="size-4" />Open images</Button>
            <Button variant="solid" onClick={onSamples}><Sparkles className="size-4" />Try the samples</Button>
          </div>
          <p className="mt-4 text-[12px] text-faint">or drop / paste images <Kbd>Ctrl V</Kbd>. Load several to edit them together.</p>
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
      {children}
    </div>
  );
}
