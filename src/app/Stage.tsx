import { ImageUp, Sparkles, ZoomOut } from 'lucide-react';
import { EXAMPLES, exampleUrl, type SampleSource } from './sample.ts';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Frame } from '../engine/index.ts';
import type { MaskTool, PaintMask } from './mask.ts';
import { Button, cx } from './ui.tsx';

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
  /** Called with the zoom level the preview should be rendered for (1, 2, 4 or 8). */
  onZoom?: (renderZoom: number) => void;
  /** When set, clicking or dragging on the image picks a point (0..1 of width and height), shown with a marker. */
  pick?: { x: number; y: number; onPick: (x: number, y: number) => void; onDone: () => void } | null;
  /** When set, dragging on the image paints the highlight mask. `size` is the brush radius as a share of the image's long edge. */
  paint?: Paint | null;
  children?: ReactNode;
}

export interface Paint { mask: PaintMask; tool: MaskTool; size: number; overlay: boolean; onStroke: (done: boolean) => void }

const MAX_ZOOM = 8;
type View = { z: number; x: number; y: number };
const NO_ZOOM: View = { z: 1, x: 0, y: 0 };
/** Power-of-two zoom bucket, so renders only redo at 2×, 4×, 8× rather than on every pinch step. */
export const renderZoom = (z: number) => Math.min(MAX_ZOOM, 2 ** Math.ceil(Math.log2(Math.max(1, z) - 0.05)));

export function Stage({ original, frame, result, split, onSplit, holdOriginal, onOpen, onSamples, onExample, onSize, onZoom, pick, paint, children }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const origRef = useRef<HTMLCanvasElement>(null);
  const resRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [fit, setFit] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>(NO_ZOOM);
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const rz = renderZoom(view.z);

  // A new image (or size) starts unzoomed.
  useEffect(() => setView(NO_ZOOM), [original, frame]);

  // Re-render sharper once a pinch settles at a new zoom bucket.
  useEffect(() => {
    if (!onZoom) return;
    const t = setTimeout(() => onZoom(rz), 150);
    return () => clearTimeout(t);
  }, [rz, onZoom]);

  // Pinch, pan, wheel and double-tap zoom. Touch events (not pointer events) because iOS Safari only lets a page
  // take over a pinch through a non-passive touchmove.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !original) return;
    const clampView = (v: View): View => {
      const z = Math.min(MAX_ZOOM, Math.max(1, v.z));
      if (z <= 1.001) return NO_ZOOM;
      const f = fitRef.current;
      const mx = (f.w * z) / 2, my = (f.h * z) / 2;
      return { z, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
    };
    // Zoom by `k` keeping the client point (cx, cy) fixed on screen.
    const zoomAt = (v: View, k: number, cx: number, cy: number): View => {
      const r = el.getBoundingClientRect();
      const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
      const z = Math.min(MAX_ZOOM, Math.max(1, v.z * k));
      const kk = z / v.z;
      return clampView({ z, x: px - (px - v.x) * kk, y: py - (py - v.y) * kk });
    };
    const apply = (v: View) => setView(clampView(v));
    const toggleAt = (cx: number, cy: number) => {
      const v = viewRef.current;
      apply(v.z > 1 ? NO_ZOOM : zoomAt(v, 2.5, cx, cy));
    };
    const onSplitHandle = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-split-handle],[data-pick-layer],[data-mask-layer]');

    let pinch: { d: number; mx: number; my: number; v: View } | null = null;
    let pan: { x: number; y: number; v: View } | null = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    let moved = false;
    const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    const touchStart = (e: TouchEvent) => {
      // Two fingers always pinch, even over the pick or paint layers.
      if (e.touches.length < 2 && onSplitHandle(e.target)) return;
      if (e.touches.length >= 2) {
        e.preventDefault();
        const m = mid(e.touches);
        pinch = { d: dist(e.touches), mx: m.x, my: m.y, v: viewRef.current };
        pan = null;
      } else if (e.touches.length === 1) {
        moved = false;
        if (viewRef.current.z > 1) pan = { x: e.touches[0].clientX, y: e.touches[0].clientY, v: viewRef.current };
      }
    };
    const touchMove = (e: TouchEvent) => {
      moved = true;
      if (pinch && e.touches.length >= 2) {
        e.preventDefault();
        const m = mid(e.touches);
        const v = zoomAt(pinch.v, dist(e.touches) / pinch.d, pinch.mx, pinch.my);
        apply({ ...v, x: v.x + m.x - pinch.mx, y: v.y + m.y - pinch.my });
      } else if (pan && e.touches.length === 1) {
        e.preventDefault();
        apply({ ...pan.v, x: pan.v.x + e.touches[0].clientX - pan.x, y: pan.v.y + e.touches[0].clientY - pan.y });
      }
    };
    const touchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 1 && viewRef.current.z > 1) {
        // Lifting one finger of a pinch continues as a pan from where it is.
        pan = { x: e.touches[0].clientX, y: e.touches[0].clientY, v: viewRef.current };
        moved = true;
        return;
      }
      if (e.touches.length) return;
      pan = null;
      const t = e.changedTouches[0];
      if (!t || moved || onSplitHandle(e.target)) return;
      const now = performance.now();
      if (now - lastTap.t < 300 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 30) {
        e.preventDefault();
        toggleAt(t.clientX, t.clientY);
        lastTap = { t: 0, x: 0, y: 0 };
      } else lastTap = { t: now, x: t.clientX, y: t.clientY };
    };
    // Safari fires its own pinch gestures (also for desktop trackpads); stop it zooming the whole page.
    let gesture: View | null = null;
    const gestureStart = (e: Event) => { e.preventDefault(); gesture = viewRef.current; };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      if (gesture && !pinch) apply(zoomAt(gesture, g.scale, g.clientX, g.clientY));
    };
    const gestureEnd = (e: Event) => { e.preventDefault(); gesture = null; };
    // Browsers don't say whether a wheel event came from a mouse or a trackpad, so classify each burst of events by
    // its first one: mouse notches report lines/pages or a wheelDelta in steps of 120, trackpads report small pixel
    // deltas, often with some horizontal movement. The burst keeps its kind so a trackpad's momentum tail can't flip it.
    const burst = { t: 0, mouse: false };
    const isMouseWheel = (e: WheelEvent) => {
      const now = performance.now();
      if (now - burst.t > 200) {
        const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
        burst.mouse = e.deltaMode !== 0 || (e.deltaX === 0 && (
          (!!wd && wd % 120 === 0) || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50)));
      } else if (e.deltaX !== 0) burst.mouse = false;
      burst.t = now;
      return burst.mouse;
    };
    const wheel = (e: WheelEvent) => {
      const v = viewRef.current;
      const mouse = isMouseWheel(e);
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch (reported as ctrl+wheel) or ctrl+scroll.
        e.preventDefault();
        apply(zoomAt(v, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)), e.clientX, e.clientY));
      } else if (mouse) {
        e.preventDefault();
        const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
        apply(zoomAt(v, Math.exp(-Math.max(-200, Math.min(200, px)) * 0.002), e.clientX, e.clientY));
      } else if (v.z > 1) {
        e.preventDefault();
        apply({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    const dblclick = (e: MouseEvent) => { if (!onSplitHandle(e.target)) toggleAt(e.clientX, e.clientY); };
    // Mouse drag to pan while zoomed.
    let drag: { x: number; y: number; v: View } | null = null;
    const pointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || viewRef.current.z <= 1 || onSplitHandle(e.target)) return;
      drag = { x: e.clientX, y: e.clientY, v: viewRef.current };
      el.setPointerCapture(e.pointerId);
    };
    const pointerMove = (e: PointerEvent) => {
      if (drag) apply({ ...drag.v, x: drag.v.x + e.clientX - drag.x, y: drag.v.y + e.clientY - drag.y });
    };
    const pointerUp = () => { drag = null; };

    const opts = { passive: false } as const;
    const listeners: [string, (e: never) => void][] = [
      ['touchstart', touchStart], ['touchmove', touchMove], ['touchend', touchEnd], ['touchcancel', touchEnd],
      ['gesturestart', gestureStart], ['gesturechange', gestureChange], ['gestureend', gestureEnd],
      ['wheel', wheel], ['dblclick', dblclick], ['pointerdown', pointerDown], ['pointermove', pointerMove],
      ['pointerup', pointerUp], ['pointercancel', pointerUp],
    ];
    for (const [type, fn] of listeners) el.addEventListener(type, fn as EventListener, opts);
    return () => { for (const [type, fn] of listeners) el.removeEventListener(type, fn as EventListener); };
  }, [original]);

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
    const k = Math.min(dpr * rz, frame.crop.w / fit.w);
    c.width = Math.max(1, Math.round(fit.w * Math.max(1, k)));
    c.height = Math.max(1, Math.round(fit.h * Math.max(1, k)));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    const { x, y, w, h } = frame.crop;
    ctx.drawImage(original, x, y, w, h, 0, 0, c.width, c.height);
  }, [original, frame, fit.w, fit.h, rz]);

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
      className={cx('stage-grid absolute inset-0 flex items-center justify-center overflow-hidden px-4', original && 'select-none', view.z > 1 && 'cursor-grab active:cursor-grabbing')}
      // Page pinch and double-tap zoom are handled here instead; one-finger scrolling still moves the page until zoomed.
      style={original ? { touchAction: view.z > 1 ? 'none' : 'pan-x pan-y', WebkitTouchCallout: 'none' } : undefined}
    >
      {original ? (
        <div
          className="relative shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)] ring-1 ring-white/[0.06]"
          style={{ width: fit.w, height: fit.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
        >
          <canvas ref={origRef} className="absolute inset-0 size-full" />
          <canvas ref={resRef} className="absolute inset-0 size-full" style={{ clipPath: clip }} />
          {pick && (
            <div data-pick-layer className="absolute inset-0 z-20 cursor-crosshair touch-none" onPointerDown={startPick}>
              <div className="pointer-events-none absolute size-5 -translate-1/2 rounded-full border-2 border-accent shadow-[0_0_0_1px_rgb(0_0_0/0.6),0_0_12px_rgb(157_251_208/0.6)]"
                style={{ left: `${pick.x * 100}%`, top: `${pick.y * 100}%`, scale: `${1 / view.z}` }} />
            </div>
          )}
          {paint && frame && !pick && <MaskLayer paint={paint} crop={frame.crop} sourceWidth={original.width} />}
          {split !== null && !holdOriginal && (
            <div data-split-handle className="absolute inset-y-0 z-10 w-8 -translate-x-1/2 cursor-ew-resize touch-none" style={{ left: `${split * 100}%`, scale: `${1 / view.z} 1` }} onPointerDown={startDrag}>
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/80 shadow-[0_0_12px_rgb(255_255_255/0.6)]" />
              <div className="absolute top-1/2 left-1/2 flex size-7 -translate-1/2 items-center justify-center rounded-full border border-white/30 bg-black/50 font-mono text-[10px] text-white backdrop-blur" style={{ scale: `1 ${1 / view.z}` }}>⇆</div>
            </div>
          )}
        </div>
      ) : (
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
      {original && view.z > 1 && (
        <button
          onClick={() => setView(NO_ZOOM)}
          aria-label="Reset zoom"
          className="press glass absolute right-3 bottom-3 z-10 flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 font-mono text-[11px] text-fg tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:bottom-14"
        >
          {view.z.toFixed(1)}×<ZoomOut className="size-3.5 text-muted" />
        </button>
      )}
      {children}
    </div>
  );
}

/** Paints the highlight mask; the mask covers the whole source, this layer only the framed crop of it. */
function MaskLayer({ paint, crop, sourceWidth }: { paint: Paint; crop: Frame['crop']; sourceWidth: number }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const tintHost = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const stroke = useRef<{ id: number; x: number; y: number; sent: number } | null>(null);
  const { mask } = paint;
  const k = mask.width / sourceWidth; // source px -> mask px
  const radius = paint.size * Math.max(crop.w, crop.h);

  useEffect(() => {
    const host = tintHost.current!;
    mask.tint.className = 'pointer-events-none absolute max-w-none';
    host.appendChild(mask.tint);
    return () => mask.tint.remove();
  }, [mask]);
  // Scale the whole-source tint so its crop region fills the layer.
  useEffect(() => {
    const mw = crop.w * k, mh = crop.h * k;
    Object.assign(mask.tint.style, {
      width: `${(mask.width / mw) * 100}%`, height: `${(mask.height / mh) * 100}%`,
      left: `${((-crop.x * k) / mw) * 100}%`, top: `${((-crop.y * k) / mh) * 100}%`,
    });
  }, [mask, crop, k]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = layerRef.current!.getBoundingClientRect(); // includes the zoom transform
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const toMask = (u: { x: number; y: number }) => ({ x: (crop.x + u.x * crop.w) * k, y: (crop.y + u.y * crop.h) * k });

  const down = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (stroke.current) {
      // A second finger means a pinch: take back the stroke the first finger started.
      mask.undoLast();
      stroke.current = null;
      paint.onStroke(true);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    mask.snapshot();
    const p = toMask(local(e));
    mask.dab(p.x, p.y, radius * k, paint.tool);
    stroke.current = { id: e.pointerId, x: p.x, y: p.y, sent: performance.now() };
    paint.onStroke(false);
  };
  const move = (e: React.PointerEvent) => {
    const u = local(e);
    setHover(u);
    const s = stroke.current;
    if (!s || s.id !== e.pointerId) return;
    const p = toMask(u);
    mask.line(s.x, s.y, p.x, p.y, radius * k, paint.tool);
    s.x = p.x; s.y = p.y;
    // Re-render now and then mid-stroke so the glyphs follow the brush.
    if (performance.now() - s.sent > 180) { s.sent = performance.now(); paint.onStroke(false); }
  };
  const up = (e: React.PointerEvent) => {
    if (stroke.current?.id !== e.pointerId) return;
    stroke.current = null;
    paint.onStroke(true);
  };

  return (
    <div ref={layerRef} data-mask-layer className="absolute inset-0 z-20 cursor-none touch-none overflow-hidden"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setHover(null)}>
      <div ref={tintHost} className="absolute inset-0" style={{ display: paint.overlay ? undefined : 'none' }} />
      {hover && (
        <div className="pointer-events-none absolute -translate-1/2 rounded-full border border-white/90 shadow-[0_0_0_1px_rgb(0_0_0/0.6)]"
          style={{ left: `${hover.x * 100}%`, top: `${hover.y * 100}%`, width: `${(2 * radius / crop.w) * 100}%`, height: `${(2 * radius / crop.h) * 100}%` }} />
      )}
    </div>
  );
}
