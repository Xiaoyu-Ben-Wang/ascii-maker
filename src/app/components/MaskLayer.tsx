import { useEffect, useRef, useState } from 'react';
import type { Frame } from '../../engine/index.ts';
import type { MaskTool, PaintMask } from '../lib/mask.ts';

/** `size` is the brush radius as a share of the image's long edge. */
export interface Paint { mask: PaintMask; tool: MaskTool; size: number; overlay: boolean; onStroke: (done: boolean) => void }

/** Paints the highlight mask. The mask covers the whole source, this layer only the framed crop of it. */
export function MaskLayer({ paint, crop, sourceWidth }: { paint: Paint; crop: Frame['crop']; sourceWidth: number }) {
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
    <div ref={layerRef} data-overlay className="absolute inset-0 z-20 cursor-none touch-none overflow-hidden"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setHover(null)}>
      <div ref={tintHost} className="absolute inset-0" style={{ display: paint.overlay ? undefined : 'none' }} />
      {hover && (
        <div className="pointer-events-none absolute -translate-1/2 rounded-full border border-white/90 shadow-[0_0_0_1px_rgb(0_0_0/0.6)]"
          style={{ left: `${hover.x * 100}%`, top: `${hover.y * 100}%`, width: `${(2 * radius / crop.w) * 100}%`, height: `${(2 * radius / crop.h) * 100}%` }} />
      )}
    </div>
  );
}
