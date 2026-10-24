import type { Params } from './params.ts';
import { blur, clamp01, createF, downsample, luma, mulberry32, resizeF, smoothstep, type FImage } from './pixels.ts';

// Shared with the GPU renderer, which must match these within a level.

/** Bloom is a tight halo plus a wide haze, each a multiple of bloomRadius, from a soft bright-pass. */
export const BLOOM = { tight: 0.4, wide: 1.6, tightWeight: 0.55, wideWeight: 0.65 };
export const bloomBand = (p: Params) => ({ lo: p.bloomThreshold - 0.1, hi: p.bloomThreshold + 0.15 });
/** The glow is low-frequency, so it is computed at half resolution. */
export const bloomFactor = (w: number, h: number) => (w > 64 && h > 64 ? 2 : 1);
export const grainSeed = (p: Params, frame: number) => (p.seed * 7919 + 17 + frame * 104729) >>> 0;
export const scanlineSpacing = (p: Params, s: number) => Math.max(1.5, p.scanlineSpacing * s);
/** Makes a lone glyph's halo nearly as strong as a cluster's. */
export const HALO_GAIN = 3;

/** Soft shoulder instead of a hard clip, so blown highlights stay smooth. */
const shoulder = (v: number) => (v <= 0.8 ? v : 0.8 + 0.2 * (1 - Math.exp(-(v - 0.8) / 0.2)));

/** Final blur, bloom, color fringe, scanlines, vignette and grain, in place. Bloom comes from `glowSource` if given. */
export function postProcess(img: FImage, p: Params, s: number, glowSource: FImage | undefined, frame: number) {
  const { width: w, height: h } = img;
  const n = w * h;

  if (p.blur > 0) {
    const b = blur(img, p.blur * s);
    img.r.set(b.r); img.g.set(b.g); img.b.set(b.b);
  }

  if (p.bloom > 0) {
    const src = glowSource ?? img;
    const bright = createF(w, h);
    const { lo, hi } = bloomBand(p);
    for (let i = 0; i < n; i++) {
      const k = smoothstep(lo, hi, luma(src.r[i], src.g[i], src.b[i]));
      if (k === 0) continue;
      bright.r[i] = src.r[i] * k; bright.g[i] = src.g[i] * k; bright.b[i] = src.b[i] * k;
    }
    const f = bloomFactor(w, h);
    const small = f > 1 ? downsample(bright, f) : bright;
    const tight = blur(small, (p.bloomRadius * s * BLOOM.tight) / f);
    const wide = blur(small, (p.bloomRadius * s * BLOOM.wide) / f);
    for (let i = 0; i < small.r.length; i++) {
      tight.r[i] = p.bloom * (BLOOM.tightWeight * tight.r[i] + BLOOM.wideWeight * wide.r[i]);
      tight.g[i] = p.bloom * (BLOOM.tightWeight * tight.g[i] + BLOOM.wideWeight * wide.g[i]);
      tight.b[i] = p.bloom * (BLOOM.tightWeight * tight.b[i] + BLOOM.wideWeight * wide.b[i]);
    }
    const glow = f > 1 ? resizeF(tight, w, h) : tight;
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
        // The offset grows toward the edges, like lens fringing.
        const dx = ((x - cx) / norm) * off, dy = ((y - cy) / norm) * off;
        const i = y * w + x;
        const rx = Math.min(w - 1, Math.max(0, Math.round(x + dx))), ry = Math.min(h - 1, Math.max(0, Math.round(y + dy)));
        const bx = Math.min(w - 1, Math.max(0, Math.round(x - dx))), by = Math.min(h - 1, Math.max(0, Math.round(y - dy)));
        img.r[i] = r0[ry * w + rx];
        img.b[i] = b0[by * w + bx];
      }
  }

  const sp = scanlineSpacing(p, s);
  const lift = 1 + p.scanlines * 0.3;
  const vig = p.vignette > 0 ? vignetteMask(w, h, p.vignette, p.vignetteSize, p.vignetteX, p.vignetteY) : null;
  const rand = mulberry32(grainSeed(p, frame));
  for (let y = 0; y < h; y++) {
    let rowM = 1;
    if (p.scanlines > 0) {
      const v = Math.sin((Math.PI * (y + 0.5)) / sp);
      rowM = (1 - p.scanlines * v * v) * lift;
    }
    for (let x = 0, i = y * w; x < w; x++, i++) {
      const m = vig ? rowM * vig[i] : rowM;
      const g = p.grain > 0 ? (rand() - 0.5) * p.grain : 0;
      img.r[i] = clamp01(img.r[i] * m + g);
      img.g[i] = clamp01(img.g[i] * m + g);
      img.b[i] = clamp01(img.b[i] * m + g);
    }
  }
}

let vigCache: { key: string; mask: Float32Array } | null = null;

/** Distances are scaled by the half-size, not the distance to each edge, so an off-center vignette darkens the far side more. */
function vignetteMask(w: number, h: number, v: number, size: number, vx: number, vy: number): Float32Array {
  const key = `${w},${h},${v},${size},${vx},${vy}`;
  if (vigCache?.key === key) return vigCache.mask;
  const mask = new Float32Array(w * h);
  const cx = w * vx, cy = h * vy, hw = w / 2, hh = h / 2;
  for (let y = 0; y < h; y++) {
    const dy = (y - cy) / hh;
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / hw;
      mask[y * w + x] = 1 - v * smoothstep(0.35 * size, size, Math.sqrt((dx * dx + dy * dy) / 2));
    }
  }
  vigCache = { key, mask };
  return mask;
}
