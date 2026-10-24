// Film grain after darktable's grain module: three octaves of simplex noise on lightness, through a paper response curve.
// The GPU shader mirrors this; both use the same integer hash, so their grain matches.

export const GRAIN = {
  /** darktable's octave frequencies, halved so the finest octave stays near one pixel at size 1. */
  freq: [0.491 / 2, 0.9441 / 2, 1.728 / 2],
  /** A coarse octave that modulates strength, so rough grain clumps. */
  clumpFreq: 0.18,
  clumpGain: 1.1,
  /** Brings simplex noise to unit variance. */
  norm: 2.63,
  /** Matches the spread of the old uniform grain at the same strength in the midtones. */
  gain: 0.29,
  /** Paper response midtone bias: grain falls to about half at black and white. darktable's full bias (0.0002) would
   * all but remove it from shadows, where most of a dark photo sits. */
  delta: 0.2,
};

/** Octave weights: roughness moves energy from the middle octave to the coarse and fine ones. */
export function grainWeights(rough: number): [number, number, number] {
  const w = [0.234 * 2 * rough, 0.785, 1.215 * (0.4 + 1.2 * rough)];
  const k = GRAIN.norm / Math.hypot(w[0], w[1], w[2]);
  return [w[0] * k, w[1] * k, w[2] * k];
}

/** Rescales clumped grain back to roughly the same overall strength. */
export const grainClumpScale = (rough: number) => 1 / Math.sqrt(1 + (rough * GRAIN.clumpGain) ** 2 * 0.8);

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
// 256 gradient directions rather than simplex's usual 8 or 12, so the grain has no preferred directions.
const GX = new Float64Array(256), GY = new Float64Array(256);
for (let k = 0; k < 256; k++) { GX[k] = Math.cos((k * Math.PI) / 128); GY[k] = Math.sin((k * Math.PI) / 128); }

function corner(t: number, h: number, x: number, y: number) {
  if (t <= 0) return 0;
  t *= t;
  const k = h >>> 24;
  return t * t * (GX[k] * x + GY[k] * y);
}

/** 2D simplex noise (Gustavson), roughly in -1..1. */
function simplex(xin: number, yin: number, seed: number) {
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s), j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t), y0 = yin - (j - t);
  const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  return 70 * (corner(0.5 - x0 * x0 - y0 * y0, hash(i, j, seed), x0, y0)
    + corner(0.5 - x1 * x1 - y1 * y1, hash(i + i1, j + j1, seed), x1, y1)
    + corner(0.5 - x2 * x2 - y2 * y2, hash(i + 1, j + 1, seed), x2, y2));
}

/** Zero-mean, roughly unit-variance grain at pixel (x, y); `size` is the grain size in output pixels. */
export function grainNoise(x: number, y: number, seed: number, size: number, rough: number, w: readonly number[], clumpScale: number) {
  let n = 0;
  for (let k = 0; k < 3; k++) {
    const f = GRAIN.freq[k] / size;
    n += w[k] * simplex(x * f, y * f, (seed + k) >>> 0);
  }
  if (rough > 0) {
    const f = GRAIN.clumpFreq / size;
    const clump = GRAIN.norm * simplex(x * f, y * f, (seed + 3) >>> 0);
    n *= Math.max(0, 1 + rough * GRAIN.clumpGain * clump) * clumpScale;
  }
  return n;
}

const D = GRAIN.delta;
const paper = (e: number) => (1 + 2 * D) / (1 + Math.exp((4 * (0.5 - e)) / (1 + 2 * D))) - D;
const paperInv = (l: number) => 0.5 - ((1 + 2 * D) / 4) * Math.log((1 + 2 * D) / (l + D) - 1);

// The curves as lookup tables, linearly interpolated: exp and log per pixel dominate the CPU cost otherwise.
const N = 4096, L0 = 0.001, L1 = 0.999, E0 = paperInv(L0) - 1, E1 = paperInv(L1) + 1;
const INV = Float64Array.from({ length: N + 1 }, (_, i) => paperInv(L0 + ((L1 - L0) * i) / N));
const FWD = Float64Array.from({ length: N + 1 }, (_, i) => paper(E0 + ((E1 - E0) * i) / N));
function lerp(t: Float64Array, x: number) {
  const f = x <= 0 ? 0 : x >= N ? N - 1e-9 : x, i = f | 0;
  return t[i] + (t[i + 1] - t[i]) * (f - i);
}

/** How much grain `g` (noise × strength × gain) shifts lightness `l`: a shift in exposure, seen through the paper curve. */
export function grainShift(l: number, g: number) {
  const c = l < L0 ? L0 : l > L1 ? L1 : l;
  const e = lerp(INV, ((c - L0) / (L1 - L0)) * N) + g;
  return lerp(FWD, ((e - E0) / (E1 - E0)) * N) - c;
}
