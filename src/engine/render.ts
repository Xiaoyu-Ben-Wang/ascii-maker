import { scopedMemo, type Memo, type RenderCache } from './cache.ts';
import { autoPalette, dither } from './dither.ts';
import { HALO_GAIN, postProcess } from './effects.ts';
import { blurCells, cellAverages, cellGrid, glyphPlan, stampGlyphs, type CanvasFactory, type HighlightMask } from './glyphs.ts';
import { ditherBackdrop, usesDither, type Params } from './params.ts';
import { adjust, blur, clamp01, cloneF, createF, fromRGBA, hexToRgb, resizeF, toRGBA, type FImage, type RGBAImage } from './pixels.ts';

export interface RenderOptions {
  createCanvas: CanvasFactory;
  /** Width of the final output this render stands in for (e.g. a downscaled preview); defaults to the source width. */
  targetWidth?: number;
  /** With `sourceKey`, reuses intermediate images across renders of the same source (e.g. while a slider moves). */
  cache?: RenderCache;
  /** Identifies the source pixels; must change whenever they do. */
  sourceKey?: string;
  /** Video frame number, so film grain animates. */
  frame?: number;
  /** Painted highlight mask; only glyph styles use it. */
  mask?: HighlightMask;
}

export interface RenderResult {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Plain-text ASCII grid, for the "characters" style. */
  text?: string;
}

/** Factor from param pixels (measured at unitWidth) to source pixels. */
export const unitScale = (w: number, p: Params, targetWidth = w) => w / (p.unitWidth > 0 ? p.unitWidth : targetWidth);

/** The thinnest stroke in source pixels: one output pixel, so previews match exports. */
export const minStroke = (w: number, targetWidth = w) => w / targetWidth;

export const hasHalo = (p: Params) => p.coverage !== 'full' && (p.haloTone !== 0 || p.haloBlur > 0);

export function render(src: RGBAImage, p: Params, opts: RenderOptions): RenderResult {
  const s = unitScale(src.width, p, opts.targetWidth);
  const { cache, sourceKey } = opts;
  const root: Memo = cache && sourceKey ? (key, make) => cache.get(`${sourceKey}|${src.width}x${src.height}|${key}`, make) : (_key, make) => make();
  const adjKey = `adj:${p.brightness},${p.contrast},${p.saturation},${p.gamma},${p.invert}`;
  const img = root(adjKey, () => {
    const f = fromRGBA(src);
    adjust(f, p);
    return f;
  });
  const memo = scopedMemo(root, adjKey);

  let out: FImage;
  let glow: FImage | undefined;
  let text: string | undefined;
  if (p.style === 'photo') out = background(img, p, s, memo);
  else if (p.style === 'dither') out = renderDither(img, p, s, memo);
  else ({ out, glow, text } = renderGlyphs(img, p, s, opts, memo));

  postProcess(out, p, s, glow, opts.frame ?? 0);
  return { width: out.width, height: out.height, data: toRGBA(out), text };
}

/**
 * The photo (or its dither, for a dither backdrop), blurred and faded toward bgColor. Returns a fresh copy, safe to
 * modify. Photo blur would smear a dither, so there only the extra blur past bgBlur applies.
 */
function background(img: FImage, p: Params, s: number, memo: Memo, bgBlur = p.bgBlur): FImage {
  const dith = ditherBackdrop(p);
  const radius = dith ? bgBlur - p.bgBlur : bgBlur;
  const src = dith ? `dither:${ditherKey(img, p, s)}` : 'photo';
  return cloneF(memo(`bg:${src},${radius * s},${p.bgColor},${p.bgOpacity}`, () => {
    const base = dith ? renderDither(img, p, s, memo) : img;
    const b = radius > 0 ? blur(base, radius * s) : cloneF(base);
    const [cr, cg, cb] = hexToRgb(p.bgColor);
    const k = p.bgOpacity;
    for (let i = 0; i < b.r.length; i++) {
      b.r[i] = cr * (1 - k) + b.r[i] * k;
      b.g[i] = cg * (1 - k) + b.g[i] * k;
      b.b[i] = cb * (1 - k) + b.b[i] * k;
    }
    return b;
  }));
}

/** Size of the dither grid, in dither pixels. */
export function ditherGrid(w: number, h: number, p: Params, s: number) {
  const px = Math.max(1, p.pixelSize * s);
  return { px, gw: Math.max(1, Math.round(w / px)), gh: Math.max(1, Math.round(h / px)) };
}

const ditherKey = (img: FImage, p: Params, s: number) => {
  const { gw, gh } = ditherGrid(img.width, img.height, p, s);
  return `${p.ditherAlgo},${p.palette},${p.ditherLevels},${p.ditherSpread},${p.seed},${gw}x${gh}`;
};

function renderDither(img: FImage, p: Params, s: number, memo: Memo): FImage {
  const { px, gw, gh } = ditherGrid(img.width, img.height, p, s);
  // Pre-blur so the downsample averages each block instead of point-sampling it.
  const small = memo(`px:${gw}x${gh}`, () => resizeF(px > 1.5 ? blur(img, px * 0.45) : img, gw, gh));
  const d = dither(small, p.ditherAlgo, p.palette, p.ditherLevels, p.ditherSpread, p.seed);
  const out = createF(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    const sy = Math.min(gh - 1, Math.floor((y * gh) / img.height));
    for (let x = 0; x < img.width; x++) {
      const si = sy * gw + Math.min(gw - 1, Math.floor((x * gw) / img.width));
      const o = y * img.width + x;
      out.r[o] = d.r[si]; out.g[o] = d.g[si]; out.b[o] = d.b[si];
    }
  }
  return out;
}

function renderGlyphs(img: FImage, p: Params, s: number, opts: RenderOptions, memo: Memo) {
  const { width: w, height: h } = img;
  const grid = cellGrid(w, h, p, s);
  const { cw, ch, cols, rows } = grid;
  const cells = memo(`cells:${cols}x${rows},${cw},${ch}`, () => cellAverages(img, grid));
  const plan = glyphPlan(cells, grid, p, s, opts.createCanvas, minStroke(img.width, opts.targetWidth), w, h, opts.mask);
  let { glow, alpha } = stampGlyphs(plan, w, h);

  const out = background(img, p, s, memo);
  if (hasHalo(p)) halo(out, img, plan.cover, grid, p, s, memo);
  if (p.glyphBlur > 0) {
    glow = blur(glow, p.glyphBlur * s);
    alpha = blur(alpha, p.glyphBlur * s);
  }
  for (let i = 0; i < out.r.length; i++) {
    const a = alpha.r[i];
    if (a === 0) continue;
    out.r[i] = out.r[i] * (1 - a) + glow.r[i];
    out.g[i] = out.g[i] * (1 - a) + glow.g[i];
    out.b[i] = out.b[i] * (1 - a) + glow.b[i];
  }
  return { out, glow, text: plan.text };
}

/**
 * Changes the photo only near glyphs: blurs it by haloBlur, then dims it toward bgColor (haloTone < 0) or lifts
 * it toward a brighter version of its own colors (haloTone > 0).
 */
function halo(bg: FImage, img: FImage, cover: Float32Array, { cols, rows, cw, ch }: ReturnType<typeof cellGrid>, p: Params, s: number, memo: Memo) {
  // Spread at cell resolution, then scale up to the cell grid, which can overhang the image edge.
  const gw = Math.round(cols * cw);
  const spread = resizeF({ ...createF(cols, rows), r: blurCells(cover, cols, rows, p.haloRadius) }, gw, Math.round(rows * ch)).r;
  const soft = p.haloBlur > 0 ? background(img, p, s, memo, p.bgBlur + p.haloBlur) : null;
  const [cr, cg, cb] = hexToRgb(p.bgColor);
  const tone = Math.abs(p.haloTone), lifts = p.haloTone > 0;
  const lift = (v: number) => 1 - (1 - v) * (1 - v) * (1 - v);
  for (let i = 0; i < bg.r.length; i++) {
    const m = clamp01(spread[Math.floor(i / bg.width) * gw + (i % bg.width)] * HALO_GAIN);
    if (m === 0) continue;
    if (soft) {
      bg.r[i] += (soft.r[i] - bg.r[i]) * m; bg.g[i] += (soft.g[i] - bg.g[i]) * m; bg.b[i] += (soft.b[i] - bg.b[i]) * m;
    }
    const d = tone * m;
    if (lifts) { bg.r[i] += (lift(bg.r[i]) - bg.r[i]) * d; bg.g[i] += (lift(bg.g[i]) - bg.g[i]) * d; bg.b[i] += (lift(bg.b[i]) - bg.b[i]) * d; }
    else { bg.r[i] += (cr - bg.r[i]) * d; bg.g[i] += (cg - bg.g[i]) * d; bg.b[i] += (cb - bg.b[i]) * d; }
  }
}

/**
 * Resolves an "auto" dither palette against `src` and spells it out as hex, so every frame of a video uses the
 * same colors instead of flickering between per-frame palettes.
 */
export function lockPalette(src: RGBAImage, p: Params): Params {
  if (!usesDither(p) || p.palette !== 'auto') return p;
  const img = fromRGBA(src);
  adjust(img, p);
  const w = Math.min(256, img.width);
  const small = resizeF(img, w, Math.max(1, Math.round((img.height * w) / img.width)));
  const hex = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  const cols = autoPalette(small, Math.max(2, Math.round(p.ditherLevels)), p.seed);
  return { ...p, palette: cols.map(([r, g, b]) => `#${hex(r)}${hex(g)}${hex(b)}`).join(',') };
}
