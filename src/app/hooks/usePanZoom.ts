import { useEffect, useRef, useState, type RefObject } from 'react';

export type View = { z: number; x: number; y: number };
export const NO_ZOOM: View = { z: 1, x: 0, y: 0 };
export interface ZoomControl { toggleActual: () => void; zoomBy: (k: number) => void }
/** Elements that use Space themselves. */
const interactive = (t: EventTarget | null) => t instanceof Element && !!t.closest('input,textarea,select,button,a,[role=slider],[role=switch],[role=checkbox],[role=radio],[role=combobox]');

/**
 * Pinch, pan, wheel and double-tap zoom over `ref`, for content laid out at `fit` size. `actual` is the zoom that
 * shows the content at one pixel per device pixel; zoom reaches 4× that. Elements marked data-overlay keep
 * single-finger and mouse input for themselves, except while Space is held, which pans. Touch events rather than
 * pointer events, because iOS Safari only lets a page take over a pinch through a non-passive touchmove.
 */
export function usePanZoom(ref: RefObject<HTMLElement | null>, fit: { w: number; h: number }, enabled: boolean, actual = 1) {
  const [view, setView] = useState<View>(NO_ZOOM);
  const [spacePan, setSpacePan] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const actualRef = useRef(actual);
  actualRef.current = actual;
  const control = useRef<ZoomControl>({ toggleActual: () => {}, zoomBy: () => {} });

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const maxZoom = () => Math.max(8, actualRef.current * 4);
    const clampView = (v: View): View => {
      const z = Math.min(maxZoom(), Math.max(1, v.z));
      if (z <= 1.001) return NO_ZOOM;
      const f = fitRef.current;
      const mx = (f.w * z) / 2, my = (f.h * z) / 2;
      return { z, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
    };
    /** Zooms by `k` keeping the client point (cx, cy) fixed on screen. */
    const zoomAt = (v: View, k: number, cx: number, cy: number): View => {
      const r = el.getBoundingClientRect();
      const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
      const z = Math.min(maxZoom(), Math.max(1, v.z * k));
      const kk = z / v.z;
      return clampView({ z, x: px - (px - v.x) * kk, y: py - (py - v.y) * kk });
    };
    const apply = (v: View) => setView(clampView(v));
    const toggleAt = (cx: number, cy: number) => {
      const v = viewRef.current;
      apply(v.z > 1 ? NO_ZOOM : zoomAt(v, 2.5, cx, cy));
    };
    const onOverlay = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-overlay]');

    let pinch: { d: number; mx: number; my: number; v: View } | null = null;
    let pan: { x: number; y: number; v: View } | null = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    let moved = false;
    const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    const touchStart = (e: TouchEvent) => {
      // Two fingers always pinch, even over the pick or paint layers.
      if (e.touches.length < 2 && onOverlay(e.target)) return;
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
      if (!t || moved || onOverlay(e.target)) return;
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
    // Wheel events don't say whether they come from a mouse or a trackpad, so each burst is classified by its first
    // event (mouse notches step by lines or 120; trackpads by small pixels, often sideways) and keeps that kind.
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
    const dblclick = (e: MouseEvent) => { if (!onOverlay(e.target)) toggleAt(e.clientX, e.clientY); };
    let drag: { x: number; y: number; v: View } | null = null;
    let space = false;
    let pointer: { x: number; y: number } | null = null;
    const pointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || viewRef.current.z <= 1 || (onOverlay(e.target) && !space)) return;
      // Captured before overlays see it, so a held Space pans instead of painting or picking.
      if (space) { e.stopPropagation(); e.preventDefault(); }
      drag = { x: e.clientX, y: e.clientY, v: viewRef.current };
      el.setPointerCapture(e.pointerId);
    };
    const pointerMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (drag) apply({ ...drag.v, x: drag.v.x + e.clientX - drag.x, y: drag.v.y + e.clientY - drag.y });
    };
    const pointerLeave = () => { pointer = null; };
    /** The cursor if it is over the stage, else the stage center. */
    const focus = () => {
      if (pointer) return pointer;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    control.current = {
      toggleActual: () => {
        const v = viewRef.current, a = actualRef.current, f = focus();
        apply(v.z >= a * 0.99 && v.z > 1 ? NO_ZOOM : zoomAt(v, a / v.z, f.x, f.y));
      },
      zoomBy: (k) => { const f = focus(); apply(zoomAt(viewRef.current, k, f.x, f.y)); },
    };
    const keyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || interactive(e.target)) return;
      e.preventDefault();
      if (!space) { space = true; setSpacePan(true); }
    };
    const keyUp = (e: KeyboardEvent) => { if (e.code === 'Space') { space = false; setSpacePan(false); } };
    const blur = () => { space = false; setSpacePan(false); };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    el.addEventListener('pointerdown', pointerDown, { capture: true });
    const pointerUp = () => { drag = null; };

    const opts = { passive: false } as const;
    const listeners: [string, (e: never) => void][] = [
      ['touchstart', touchStart], ['touchmove', touchMove], ['touchend', touchEnd], ['touchcancel', touchEnd],
      ['gesturestart', gestureStart], ['gesturechange', gestureChange], ['gestureend', gestureEnd],
      ['wheel', wheel], ['dblclick', dblclick], ['pointermove', pointerMove], ['pointerleave', pointerLeave],
      ['pointerup', pointerUp], ['pointercancel', pointerUp],
    ];
    for (const [type, fn] of listeners) el.addEventListener(type, fn as EventListener, opts);
    return () => {
      for (const [type, fn] of listeners) el.removeEventListener(type, fn as EventListener);
      el.removeEventListener('pointerdown', pointerDown, { capture: true });
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
    };
  }, [ref, enabled]);

  return { view, setView, spacePan, control };
}
