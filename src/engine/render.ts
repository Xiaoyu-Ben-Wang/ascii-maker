import { autoPalette, dither } from './dither.ts';
import type { Params } from './params.ts';
import {
  adjust, blur, clamp01, cloneF, createF, downsample, fromRGBA, hexToRgb, luma, mulberry32, resizeF, toRGBA,
  type FImage, type RGBAImage,
} from './pixels.ts';

/** The subset of CanvasRenderingContext2D the renderer uses (DOM canvas and @napi-rs/canvas both satisfy it). */
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

export interface RenderOptions {
  createCanvas: CanvasFactory;
  /** Width of the final output this render stands in for (e.g. a downscaled preview); defaults to the source width. */
  targetWidth?: number;
  /** With `sourceKey`, reuses intermediate images across renders of the same source (e.g. while a slider moves). */
  cache?: RenderCache;
  /** Identifies the source pixels; must change whenever they do. */
  sourceKey?: string;
  /** Video frame number; varies the film grain so it animates instead of sitting still on the image. */
  frame?: number;
}

/** LRU of intermediate images, bounded in bytes. Entries are shared, so callers must never mutate them. */
export class RenderCache {
  private entries = new Map<string, FImage>();
  private bytes = 0;
  private maxBytes: number;
  constructor(maxMB = 192) { this.maxBytes = maxMB * 1024 * 1024; }
  get(key: string, make: () => FImage): FImage {
    let v = this.entries.get(key);
    if (v) {
      this.entries.delete(key);
    } else {
      v = make();
      this.bytes += v.r.byteLength * 3;
      while (this.bytes > this.maxBytes && this.entries.size) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.r.byteLength * 3;
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, v);
    return v;
  }
}

type Memo = (key: string, make: () => FImage) => FImage;

export interface RenderResult {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Plain-text ASCII grid, for the "characters" style. */
  text?: string;
}

const smoothstep = (a: number, b: number, x: number) => {
  if (b <= a) return x >= a ? 1 : 0;
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function render(src: RGBAImage, p: Params, opts: RenderOptions): RenderResult {
  // Factor from param pixels to pixels of `src`.
  const s = src.width / (p.unitWidth > 0 ? p.unitWidth : (opts.targetWidth ?? src.width));
  const memo: Memo = opts.cache && opts.sourceKey
    ? (key, make) => opts.cache!.get(`${opts.sourceKey}|${src.width}x${src.height}|${key}`, make)
    : (_key, make) => make();
  const adjKey = `adj:${p.brightness},${p.contrast},${p.saturation},${p.gamma},${p.invert}`;
  const img = memo(adjKey, () => {
    const f = fromRGBA(src);
    adjust(f, p);
    return f;
  });

  let out: FImage;
  let glow: FImage | undefined;
  let text: string | undefined;
  if (p.style === 'dither') {
    out = renderDither(img, p, s, (k, make) => memo(`${adjKey}|${k}`, make));
  } else {
    // Source pixels per output pixel: keeps the 1px stroke floor in output pixels so previews match exports.
    const minPx = src.width / (opts.targetWidth ?? src.width);
    ({ out, glow, text } = renderGlyphs(img, p, s, opts.createCanvas, minPx, (k, make) => memo(`${adjKey}|${k}`, make)));
  }

  postProcess(out, p, s, glow, opts.frame ?? 0);
  return { width: out.width, height: out.height, data: toRGBA(out), text };
}

function renderDither(img: FImage, p: Params, s: number, memo: Memo): FImage {
  const px = Math.max(1, p.pixelSize * s);
  const gw = Math.max(1, Math.round(img.width / px));
  const gh = Math.max(1, Math.round(img.height / px));
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

/** Average color of each cw×ch cell. */
function cellAverages(img: FImage, cols: number, rows: number, cw: number, ch: number): FImage {
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

function renderGlyphs(img: FImage, p: Params, s: number, createCanvas: CanvasFactory, minPx: number, memo: Memo) {
  const { width: w, height: h } = img;

  // Background: softened source faded toward bgColor. Cloned because compositing writes into it.
  const bg = cloneF(memo(`bg:${p.bgBlur * s},${p.bgColor},${p.bgOpacity}`, () => {
    const b = p.bgBlur > 0 ? blur(img, p.bgBlur * s) : cloneF(img);
    const [br, bgG, bb] = hexToRgb(p.bgColor);
    const k = p.bgOpacity;
    for (let i = 0; i < b.r.length; i++) {
      b.r[i] = br * (1 - k) + b.r[i] * k;
      b.g[i] = bgG * (1 - k) + b.g[i] * k;
      b.b[i] = bb * (1 - k) + b.b[i] * k;
    }
    return b;
  }));

  const ch = Math.max(2, p.cellSize * s);
  // Monospace glyphs are ~0.6 as wide as tall; other styles use square cells.
  const cw = p.style === 'characters' ? Math.max(2, ch * 0.6) : ch;
  const cols = Math.ceil(w / cw);
  const rows = Math.ceil(h / ch);
  const cells = memo(`cells:${cols}x${rows},${cw},${ch}`, () => cellAverages(img, cols, rows, cw, ch));
  const lum = new Float32Array(cols * rows);
  for (let i = 0; i < lum.length; i++) lum[i] = luma(cells.r[i], cells.g[i], cells.b[i]);
  // Smoothed copy for edge direction, so slashes follow contours rather than fine texture.
  let edgeLum: Float32Array | undefined;
  if (p.style === 'diagonal' && p.diagonalMode === 'edge') {
    const f = createF(cols, rows);
    f.r.set(lum); f.g.set(lum); f.b.set(lum);
    edgeLum = blur(f, 1.5).r;
  }

  // Glyphs are rasterized once into alpha masks (the atlas) and stamped per cell in JS. Drawing each cell through
  // the canvas is far slower, and native canvases serialize text drawing across threads.
  const lineWidth = Math.max(minPx, ch * p.strokeWidth);
  const pad = Math.ceil(Math.max(lineWidth, ch * 0.2));
  const mw = Math.ceil(cw) + 2 * pad, mh = Math.ceil(ch) + 2 * pad;
  const fontPx = Math.round(ch);
  const atlasKey = `${p.style}|${mw}x${mh}|${ch.toFixed(2)}|${cw.toFixed(2)}|${lineWidth.toFixed(2)}|${p.font}`;
  const mask = (key: string, draw: (ctx: Ctx2D, x: number, y: number) => void) =>
    glyphMask(`${atlasKey}|${key}`, mw, mh, createCanvas, (ctx) => {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      ctx.lineCap = 'round';
      ctx.lineWidth = lineWidth;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${fontPx}px ${p.font}`;
      draw(ctx, mw / 2, mh / 2);
    });
  // Shape sizes are quantized so a handful of masks cover every brightness.
  const LEVELS = 24;
  const level = (t: number) => Math.round(clamp01(t) * LEVELS) / LEVELS;

  let glow = createF(w, h);
  let alpha = createF(w, h);
  const gr = glow.r, gg = glow.g, gb = glow.b, al = alpha.r;
  const stamp = (m: Float32Array, mx: number, my: number, r: number, g: number, b: number, a: number) => {
    const x0 = Math.round(mx - mw / 2), y0 = Math.round(my - mh / 2);
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
  };

  const mono = hexToRgb(p.monoColor);
  const rand = mulberry32(p.seed);
  const chars = [...p.charset];
  const full = p.coverage === 'full';
  // In full coverage the whole charset (leading space included) spans the luminance range.
  const charStart = !full && chars[0] === ' ' && chars.length > 1 ? 1 : 0;
  const textRows: string[] = [];
  const th = full ? 0 : p.threshold;
  const fadeEnd = full ? 0 : th + p.thresholdSoftness * (1 - th);

  for (let cy = 0; cy < rows; cy++) {
    let line = '';
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      const l = lum[i];
      const jitter = rand();
      const a = smoothstep(th, fadeEnd, l) * p.glyphOpacity;
      // t: 0 at the threshold, 1 at full white; drives glyph choice and size.
      const t = th >= 1 ? 0 : clamp01((l - th) / (1 - th));
      if (a < 0.02) { line += ' '; continue; }

      let r = p.colorMode === 'mono' ? mono[0] : cells.r[i];
      let g = p.colorMode === 'mono' ? mono[1] : cells.g[i];
      let b = p.colorMode === 'mono' ? mono[2] : cells.b[i];
      r = clamp01((r + (1 - r) * p.glyphTint) * p.glyphBoost);
      g = clamp01((g + (1 - g) * p.glyphTint) * p.glyphBoost);
      b = clamp01((b + (1 - b) * p.glyphTint) * p.glyphBoost);
      const mx = cx * cw + cw / 2, my = cy * ch + ch / 2;
      const q = level(t);
      const size = p.sizeByBrightness ? 0.3 + 0.7 * q : 1;

      switch (p.style) {
        case 'characters': {
          const idx = charStart + Math.min(chars.length - 1 - charStart, Math.floor(t * (chars.length - charStart)));
          const c = chars[idx];
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
          let forward = true; // "/"
          if (p.diagonalMode === 'backward') forward = false;
          else if (p.diagonalMode === 'mixed') forward = jitter < 0.5;
          else if (p.diagonalMode === 'edge') {
            const E = edgeLum!;
            const L = (x: number, y: number) => E[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))];
            const gx = L(cx + 1, cy - 1) + 2 * L(cx + 1, cy) + L(cx + 1, cy + 1) - L(cx - 1, cy - 1) - 2 * L(cx - 1, cy) - L(cx - 1, cy + 1);
            const gy = L(cx - 1, cy + 1) + 2 * L(cx, cy + 1) + L(cx + 1, cy + 1) - L(cx - 1, cy - 1) - 2 * L(cx, cy - 1) - L(cx + 1, cy - 1);
            // Stroke runs along the edge, i.e. perpendicular to the gradient.
            if (Math.abs(gx) + Math.abs(gy) > 0.2) forward = gx * gy >= 0;
          }
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

  const out = bg;
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

  return { out, glow, text: p.style === 'characters' ? textRows.join('\n') : undefined };
}

function postProcess(img: FImage, p: Params, s: number, glowSource: FImage | undefined, frame: number) {
  const { width: w, height: h } = img;
  const n = w * h;

  if (p.blur > 0) {
    const b = blur(img, p.blur * s);
    img.r.set(b.r); img.g.set(b.g); img.b.set(b.b);
  }

  if (p.bloom > 0) {
    // Bright-pass, then a tight halo plus a wide haze, computed at half resolution (the glow is low-frequency).
    const srcImg = glowSource ?? img;
    const bright = createF(w, h);
    const lo = p.bloomThreshold - 0.1, hi = p.bloomThreshold + 0.15;
    for (let i = 0; i < n; i++) {
      const k = smoothstep(lo, hi, luma(srcImg.r[i], srcImg.g[i], srcImg.b[i]));
      if (k === 0) continue;
      bright.r[i] = srcImg.r[i] * k; bright.g[i] = srcImg.g[i] * k; bright.b[i] = srcImg.b[i] * k;
    }
    const f = w > 64 && h > 64 ? 2 : 1;
    const small = f > 1 ? downsample(bright, f) : bright;
    const tight = blur(small, (p.bloomRadius * s * 0.4) / f);
    const wide = blur(small, (p.bloomRadius * s * 1.6) / f);
    const st = p.bloom;
    for (let i = 0; i < small.r.length; i++) {
      tight.r[i] = st * (0.55 * tight.r[i] + 0.65 * wide.r[i]);
      tight.g[i] = st * (0.55 * tight.g[i] + 0.65 * wide.g[i]);
      tight.b[i] = st * (0.55 * tight.b[i] + 0.65 * wide.b[i]);
    }
    const glow = f > 1 ? resizeF(tight, w, h) : tight;
    // Soft shoulder instead of a hard clip keeps blown highlights smooth.
    for (let i = 0; i < n; i++) {
      img.r[i] = shoulder(img.r[i] + glow.r[i]);
      img.g[i] = shoulder(img.g[i] + glow.g[i]);
      img.b[i] = shoulder(img.b[i] + glow.b[i]);
    }
  }

  if (p.chromatic > 0) {
    const off = p.chromatic * s;
    const r0 = img.r.slice(), b0 = img.b.slice();
    const cx = w / 2, cy = h / 2, norm = Math.hypot(cx, cy);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        // Offset grows toward the edges, like lens fringing.
        const dx = ((x - cx) / norm) * off, dy = ((y - cy) / norm) * off;
        const i = y * w + x;
        const rx = Math.min(w - 1, Math.max(0, Math.round(x + dx))), ry = Math.min(h - 1, Math.max(0, Math.round(y + dy)));
        const bx = Math.min(w - 1, Math.max(0, Math.round(x - dx))), by = Math.min(h - 1, Math.max(0, Math.round(y - dy)));
        img.r[i] = r0[ry * w + rx];
        img.b[i] = b0[by * w + bx];
      }
  }

  // Scanlines, vignette, grain and the final clamp in one pass.
  const sp = Math.max(1.5, p.scanlineSpacing * s);
  const lift = 1 + p.scanlines * 0.3;
  const vig = p.vignette > 0 ? vignetteMask(w, h, p.vignette) : null;
  const rand = mulberry32(p.seed * 7919 + 17 + frame * 104729);
  const grain = p.grain;
  for (let y = 0; y < h; y++) {
    let rowM = 1;
    if (p.scanlines > 0) {
      const v = Math.sin((Math.PI * (y + 0.5)) / sp);
      rowM = (1 - p.scanlines * v * v) * lift;
    }
    for (let x = 0, i = y * w; x < w; x++, i++) {
      const m = vig ? rowM * vig[i] : rowM;
      const g = grain > 0 ? (rand() - 0.5) * grain : 0;
      img.r[i] = clamp01(img.r[i] * m + g);
      img.g[i] = clamp01(img.g[i] * m + g);
      img.b[i] = clamp01(img.b[i] * m + g);
    }
  }
}

let vigCache: { w: number; h: number; v: number; mask: Float32Array } | null = null;
function vignetteMask(w: number, h: number, v: number): Float32Array {
  if (vigCache && vigCache.w === w && vigCache.h === h && vigCache.v === v) return vigCache.mask;
  const mask = new Float32Array(w * h);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    const dy = (y - cy) / cy;
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / cx;
      mask[y * w + x] = 1 - v * smoothstep(0.35, 1, Math.sqrt((dx * dx + dy * dy) / 2));
    }
  }
  vigCache = { w, h, v, mask };
  return mask;
}

const shoulder = (v: number) => (v <= 0.8 ? v : 0.8 + 0.2 * (1 - Math.exp(-(v - 0.8) / 0.2)));

/**
 * Resolves an "auto" dither palette against `src` and returns params with that palette spelled out as hex,
 * so every frame of a video uses the same colors instead of flickering between per-frame palettes.
 */
export function lockPalette(src: RGBAImage, p: Params): Params {
  if (p.style !== 'dither' || p.palette !== 'auto') return p;
  const img = fromRGBA(src);
  adjust(img, p);
  const w = Math.min(256, img.width);
  const small = resizeF(img, w, Math.max(1, Math.round((img.height * w) / img.width)));
  const hex = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  const cols = autoPalette(small, Math.max(2, Math.round(p.ditherLevels)), p.seed);
  return { ...p, palette: cols.map(([r, g, b]) => `#${hex(r)}${hex(g)}${hex(b)}`).join(',') };
}

const atlas = new Map<string, Float32Array>();
/** Alpha mask of one glyph, rendered once and cached (across renders too, which matters for video). */
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
