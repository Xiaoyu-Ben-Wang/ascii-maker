import type { Params } from './params.ts';
import { blur, clamp01, createF, hexToRgb, luma, mulberry32, smoothstep, type FImage } from './pixels.ts';

/** The subset of CanvasRenderingContext2D used to rasterize glyphs (DOM canvas and @napi-rs/canvas both fit). */
export interface Ctx2D {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}
export type CanvasFactory = (width: number, height: number) => { getContext(type: '2d'): unknown };

/**
 * Grayscale mask over the source: 128 leaves a cell alone, toward 255 forces a glyph, toward 0 keeps glyphs off.
 * `region` is the part of the mask (in mask pixels) that lines up with the rendered image, e.g. after a crop.
 */
export interface HighlightMask {
  width: number;
  height: number;
  data: Uint8Array;
  region?: { x: number; y: number; w: number; h: number };
}

export interface CellGrid { cw: number; ch: number; cols: number; rows: number }

export function cellGrid(w: number, h: number, p: Params, s: number): CellGrid {
  const ch = Math.max(2, p.cellSize * s);
  // Monospace glyphs are about 0.6 as wide as tall; other styles use square cells.
  const cw = p.style === 'characters' ? Math.max(2, ch * 0.6) : ch;
  return { cw, ch, cols: Math.ceil(w / cw), rows: Math.ceil(h / ch) };
}

export function cellAverages(img: FImage, { cols, rows, cw, ch }: CellGrid): FImage {
  const out = createF(cols, rows);
  const cnt = new Float32Array(cols * rows);
  for (let y = 0; y < img.height; y++) {
    const cy = Math.min(rows - 1, Math.floor(y / ch));
    for (let x = 0; x < img.width; x++) {
      const c = cy * cols + Math.min(cols - 1, Math.floor(x / cw));
      const i = y * img.width + x;
      out.r[c] += img.r[i]; out.g[c] += img.g[i]; out.b[c] += img.b[i]; cnt[c]++;
    }
  }
  for (let c = 0; c < cnt.length; c++) if (cnt[c]) { out.r[c] /= cnt[c]; out.g[c] /= cnt[c]; out.b[c] /= cnt[c]; }
  return out;
}

/**
 * Which glyph goes where, before any pixels are drawn. The CPU stamps it with stampGlyphs, the GPU in a shader;
 * both composite cells in raster order, each over what came before.
 */
export interface GlyphPlan {
  /** Size of every mask. */
  mw: number;
  mh: number;
  /** Unique glyph coverage masks (0..1, mw×mh) by slot, with the cache key of each. */
  masks: Float32Array[];
  maskKeys: string[];
  /** Per cell, in raster order: mask slot (-1 = nothing drawn) and top-left corner of the stamp in image pixels. */
  slot: Int32Array;
  x0: Int32Array;
  y0: Int32Array;
  /** Per cell: glyph rgb and opacity. */
  color: Float64Array;
  /** Per cell: glyph opacity. */
  cover: Float32Array;
  text?: string;
}

/** Glyph colors premultiplied by coverage, and the coverage itself in `alpha.r`. */
export function stampGlyphs(plan: GlyphPlan, w: number, h: number): { glow: FImage; alpha: FImage } {
  const { mw, mh, masks, slot, x0: X0, y0: Y0, color } = plan;
  const glow = createF(w, h);
  const alpha = createF(w, h);
  const gr = glow.r, gg = glow.g, gb = glow.b, al = alpha.r;
  for (let c = 0; c < slot.length; c++) {
    if (slot[c] < 0) continue;
    const m = masks[slot[c]];
    const x0 = X0[c], y0 = Y0[c];
    const r = color[c * 4], g = color[c * 4 + 1], b = color[c * 4 + 2], a = color[c * 4 + 3];
    const i0 = Math.max(0, -x0), i1 = Math.min(mw, w - x0);
    for (let j = Math.max(0, -y0), j1 = Math.min(mh, h - y0); j < j1; j++) {
      let o = (y0 + j) * w + x0 + i0;
      for (let mi = j * mw + i0, me = j * mw + i1; mi < me; mi++, o++) {
        const ea = m[mi] * a;
        if (ea === 0) continue;
        const k = 1 - ea;
        gr[o] = gr[o] * k + r * ea; gg[o] = gg[o] * k + g * ea; gb[o] = gb[o] * k + b * ea; al[o] = al[o] * k + ea;
      }
    }
  }
  return { glow, alpha };
}

/** Shape sizes are quantized so a handful of masks cover every brightness. */
const LEVELS = 24;
const level = (t: number) => Math.round(clamp01(t) * LEVELS) / LEVELS;

/**
 * Picks a glyph, color and opacity per cell from the cell averages. `minPx` is the thinnest stroke, in source pixels.
 * Glyphs are rasterized once into masks and stamped per cell, since drawing every cell through a canvas is far
 * slower and native canvases serialize text drawing across threads.
 */
export function glyphPlan(cells: FImage, grid: CellGrid, p: Params, s: number, createCanvas: CanvasFactory, minPx: number, w: number, h: number, highlightMask?: HighlightMask): GlyphPlan {
  const { cw, ch, cols, rows } = grid;
  const n = cols * rows;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = luma(cells.r[i], cells.g[i], cells.b[i]);
  const bright = highlightLevels(lum, cols, rows, p, (p.localRadius * s) / ch);
  // Edge direction comes from a smoothed copy, so slashes follow contours rather than fine texture.
  const edgeLum = p.style === 'diagonal' && p.diagonalMode === 'edge' ? blurCells(lum, cols, rows, 1.5) : null;

  const lineWidth = Math.max(minPx, ch * p.strokeWidth);
  const pad = Math.ceil(Math.max(lineWidth, ch * 0.2));
  const mw = Math.ceil(cw) + 2 * pad, mh = Math.ceil(ch) + 2 * pad;
  const atlasKey = `${p.style}|${mw}x${mh}|${ch.toFixed(2)}|${cw.toFixed(2)}|${lineWidth.toFixed(2)}|${p.font}`;
  const masks: Float32Array[] = [];
  const maskKeys: string[] = [];
  const slots = new Map<string, number>();
  const mask = (key: string, draw: (ctx: Ctx2D, x: number, y: number) => void) => {
    const full = `${atlasKey}|${key}`;
    let k = slots.get(full);
    if (k !== undefined) return k;
    k = masks.length;
    slots.set(full, k);
    maskKeys.push(full);
    masks.push(glyphMask(full, mw, mh, createCanvas, (ctx) => {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      ctx.lineCap = 'round';
      ctx.lineWidth = lineWidth;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${Math.round(ch)}px ${p.font}`;
      draw(ctx, mw / 2, mh / 2);
    }));
    return k;
  };

  const slot = new Int32Array(n).fill(-1);
  const X0 = new Int32Array(n), Y0 = new Int32Array(n);
  const color = new Float64Array(n * 4);
  const cover = new Float32Array(n);
  let i = 0;
  const stamp = (k: number, mx: number, my: number, r: number, g: number, b: number, a: number) => {
    const x0 = Math.round(mx - mw / 2), y0 = Math.round(my - mh / 2);
    if (x0 >= w || y0 >= h || x0 + mw <= 0 || y0 + mh <= 0) return;
    slot[i] = k; X0[i] = x0; Y0[i] = y0;
    color[i * 4] = r; color[i * 4 + 1] = g; color[i * 4 + 2] = b; color[i * 4 + 3] = a;
  };

  const mono = hexToRgb(p.monoColor);
  const rand = mulberry32(p.seed);
  const chars = [...p.charset];
  const full = p.coverage === 'full';
  // In full coverage the whole charset, leading space included, spans the brightness range.
  const charStart = !full && chars[0] === ' ' && chars.length > 1 ? 1 : 0;
  const th = full ? 0 : p.threshold;
  const fadeEnd = full ? 0 : th + p.thresholdSoftness * (1 - th);
  const top = full ? 1 : Math.max(th, p.thresholdHigh);
  const fadeOutEnd = top + p.thresholdSoftness * (1 - top);
  const painted = highlightMask ? maskCells(highlightMask, grid, w, h) : null;
  const textRows: string[] = [];

  for (let cy = 0; cy < rows; cy++) {
    let line = '';
    for (let cx = 0; cx < cols; cx++) {
      i = cy * cols + cx;
      const l = bright[i];
      const jitter = rand();
      // A lower end of 0 means none: even the darkest cells get full glyphs.
      let a = (th > 0 ? smoothstep(th, fadeEnd, l) : 1) * p.glyphOpacity;
      if (top < 1) a *= 1 - smoothstep(top, fadeOutEnd, l);
      // 0 at the lower end, 1 at the upper end; drives glyph choice and size.
      let t = top <= th ? 0 : clamp01((l - th) / (top - th));
      const m = painted ? painted[i] : 0;
      if (m > 0) {
        // Forced cells pick glyphs by their own brightness, so dark areas get light glyphs.
        a += (p.glyphOpacity - a) * m;
        t = Math.max(t, l * m);
      } else if (m < 0) a *= 1 + m;
      if (a < 0.02) { line += ' '; continue; }
      cover[i] = a;

      const [sr, sg, sb] = p.colorMode === 'mono' ? mono : [cells.r[i], cells.g[i], cells.b[i]];
      const r = clamp01((sr + (1 - sr) * p.glyphTint) * p.glyphBoost);
      const g = clamp01((sg + (1 - sg) * p.glyphTint) * p.glyphBoost);
      const b = clamp01((sb + (1 - sb) * p.glyphTint) * p.glyphBoost);
      const mx = cx * cw + cw / 2, my = cy * ch + ch / 2;
      const q = level(t);
      const size = p.sizeByBrightness ? 0.3 + 0.7 * q : 1;

      switch (p.style) {
        case 'characters': {
          const c = chars[charStart + Math.min(chars.length - 1 - charStart, Math.floor(t * (chars.length - charStart)))];
          line += c;
          if (c !== ' ') stamp(mask(`c${c}`, (ctx, x, y) => ctx.fillText(c, x, y)), mx, my, r, g, b, a);
          break;
        }
        case 'cross': {
          // Faint cells get a small ×, bright cells a bold +.
          const x = t < 0.3;
          stamp(mask(`${x ? 'x' : '+'}${size}`, (ctx, px, py) => {
            const arm = ch * 0.45 * size, d = arm * 0.7;
            ctx.beginPath();
            if (x) { ctx.moveTo(px - d, py - d); ctx.lineTo(px + d, py + d); ctx.moveTo(px + d, py - d); ctx.lineTo(px - d, py + d); }
            else { ctx.moveTo(px - arm, py); ctx.lineTo(px + arm, py); ctx.moveTo(px, py - arm); ctx.lineTo(px, py + arm); }
            ctx.stroke();
          }), mx, my, r, g, b, a);
          break;
        }
        case 'diagonal': {
          const forward = edgeLum ? edgeForward(edgeLum, cols, rows, cx, cy) : p.diagonalMode === 'mixed' ? jitter < 0.5 : p.diagonalMode !== 'backward';
          const f = p.sizeByBrightness ? 0.45 + 0.55 * q : 1;
          stamp(mask(`${forward ? 'f' : 'b'}${f}`, (ctx, px, py) => {
            const half = (ch / 2) * f;
            ctx.beginPath();
            if (forward) { ctx.moveTo(px - half, py + half); ctx.lineTo(px + half, py - half); }
            else { ctx.moveTo(px - half, py - half); ctx.lineTo(px + half, py + half); }
            ctx.stroke();
          }), mx, my, r, g, b, a);
          break;
        }
        case 'dots': {
          const rad = (ch / 2) * (p.sizeByBrightness ? Math.sqrt(q) * 0.95 : 0.8);
          if (rad < 0.4) break;
          stamp(mask(`o${rad.toFixed(2)}`, (ctx, px, py) => { ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill(); }), mx, my, r, g, b, a);
          break;
        }
        case 'lines': {
          stamp(mask(`|${size}`, (ctx, px, py) => {
            const half = (ch / 2) * size;
            ctx.beginPath(); ctx.moveTo(px, py - half); ctx.lineTo(px, py + half); ctx.stroke();
          }), mx, my, r, g, b, a);
          break;
        }
      }
    }
    textRows.push(line.replace(/\s+$/, ''));
  }

  return { mw, mh, masks, maskKeys, slot, x0: X0, y0: Y0, color, cover, text: p.style === 'characters' ? textRows.join('\n') : undefined };
}

/** Whether a "/" (rather than "\") runs along the edge at cell (cx, cy); "/" where the edge is too faint to tell. */
function edgeForward(E: Float32Array, cols: number, rows: number, cx: number, cy: number): boolean {
  const L = (x: number, y: number) => E[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))];
  const gx = L(cx + 1, cy - 1) + 2 * L(cx + 1, cy) + L(cx + 1, cy + 1) - L(cx - 1, cy - 1) - 2 * L(cx - 1, cy) - L(cx - 1, cy + 1);
  const gy = L(cx - 1, cy + 1) + 2 * L(cx, cy + 1) + L(cx + 1, cy + 1) - L(cx - 1, cy - 1) - 2 * L(cx, cy - 1) - L(cx + 1, cy - 1);
  return Math.abs(gx) + Math.abs(gy) > 0.2 ? gx * gy >= 0 : true;
}

export function blurCells(values: Float32Array, cols: number, rows: number, sigma: number): Float32Array {
  const f = createF(cols, rows);
  f.r.set(values);
  return blur(f, sigma).r;
}

/**
 * Per-cell brightness as compared against the threshold. "relative" is the cell's rank among all cells; "local" is
 * how much brighter it is than its surroundings (`radius` cells), so even, bright areas stay bare.
 */
function highlightLevels(lum: Float32Array, cols: number, rows: number, p: Params, radius: number): Float32Array {
  if (p.highlightMode === 'relative') {
    // Ranked on luminance rounded to 1/1024, so cells equal to the eye tie exactly instead of being ordered by
    // rounding noise (which differs between CPU and GPU). Ties share the middle rank of their group.
    const q = lum.map((v) => Math.round(v * 1024));
    const sorted = q.slice().sort();
    const n = sorted.length;
    const bound = (v: number, inclusive: boolean) => {
      let lo = 0, hi = n;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v || (inclusive && sorted[mid] === v)) lo = mid + 1; else hi = mid; }
      return lo;
    };
    return q.map((v) => (bound(v, false) + bound(v, true)) / (2 * n));
  }
  if (p.highlightMode === 'local') {
    const m = blurCells(lum, cols, rows, Math.max(1, radius));
    // A quarter of the absolute level keeps big bright shapes faintly present.
    return lum.map((v, i) => clamp01(0.25 * v + 2.5 * (v - m[i])));
  }
  return lum;
}

/** Mask value at cell centers as -1 (remove) .. 1 (add), or null when the mask is blank. */
function maskCells(m: HighlightMask, { cols, rows, cw, ch }: CellGrid, w: number, h: number): Float32Array | null {
  const r = m.region ?? { x: 0, y: 0, w: m.width, h: m.height };
  const out = new Float32Array(cols * rows);
  let any = false;
  for (let cy = 0; cy < rows; cy++) {
    const my = Math.min(m.height - 1, Math.max(0, Math.floor(r.y + (Math.min(h, (cy + 0.5) * ch) / h) * r.h)));
    for (let cx = 0; cx < cols; cx++) {
      const mx = Math.min(m.width - 1, Math.max(0, Math.floor(r.x + (Math.min(w, (cx + 0.5) * cw) / w) * r.w)));
      const raw = m.data[my * m.width + mx];
      const v = (raw - 128) / (raw >= 128 ? 127 : 128);
      // Ignores the faint edges of soft brush strokes and rounding around 128.
      if (Math.abs(v) > 0.02) { out[cy * cols + cx] = v; any = true; }
    }
  }
  return any ? out : null;
}

/** Rasterized glyphs, kept across renders (which matters for video). */
const atlas = new Map<string, Float32Array>();

function glyphMask(key: string, mw: number, mh: number, createCanvas: CanvasFactory, draw: (ctx: Ctx2D) => void): Float32Array {
  let m = atlas.get(key);
  if (m) return m;
  const ctx = createCanvas(mw, mh).getContext('2d') as Ctx2D;
  ctx.clearRect(0, 0, mw, mh);
  draw(ctx);
  const d = ctx.getImageData(0, 0, mw, mh).data;
  m = new Float32Array(mw * mh);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] / 255;
  if (atlas.size > 2000) atlas.clear();
  atlas.set(key, m);
  return m;
}

/** A mask spanning the whole source, with `crop` (in source pixels) as its region. */
export function cropMask(m: HighlightMask, sourceW: number, sourceH: number, crop: { x: number; y: number; w: number; h: number }): HighlightMask {
  const kx = m.width / sourceW, ky = m.height / sourceH;
  return { ...m, region: { x: crop.x * kx, y: crop.y * ky, w: crop.w * kx, h: crop.h * ky } };
}
