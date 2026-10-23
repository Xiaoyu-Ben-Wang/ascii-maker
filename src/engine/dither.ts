import { clamp01, createF, hexToRgb, mulberry32, type FImage } from './pixels.ts';
import type { DitherAlgo } from './params.ts';

export const PALETTES: Record<string, string[]> = {
  mono: ['#000000', '#ffffff'],
  gameboy: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  c64: [
    '#000000', '#ffffff', '#880000', '#aaffee', '#cc44cc', '#00cc55', '#0000aa', '#eeee77',
    '#dd8855', '#664400', '#ff7777', '#333333', '#777777', '#aaff66', '#0088ff', '#bbbbbb',
  ],
  pico8: [
    '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
    '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
  ],
  cga: ['#000000', '#55ffff', '#ff55ff', '#ffffff'],
  amber: ['#1a0d00', '#663300', '#cc6600', '#ffb000', '#ffe0a0'],
  synthwave: ['#0d0221', '#261447', '#541388', '#d90368', '#ff6c11', '#f9c80e', '#2de2e6'],
  ocean: ['#020617', '#0b2a5b', '#1d4ed8', '#38bdf8', '#bae6fd', '#ffffff'],
};

export const PALETTE_NAMES = ['auto', 'source', ...Object.keys(PALETTES)];

/** Bayer index matrix of size 2^n, built recursively: M2n = [4M, 4M+2; 4M+3, 4M+1]. */
export function bayerMatrix(size: number): number[] {
  let m = [0];
  for (let s = 1; s < size; s *= 2) {
    const n = s * 2;
    const next = new Array<number>(n * n);
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const v = 4 * m[y * s + x];
        next[y * n + x] = v;
        next[y * n + x + s] = v + 2;
        next[(y + s) * n + x] = v + 3;
        next[(y + s) * n + x + s] = v + 1;
      }
    m = next;
  }
  return m;
}

type Quantizer = (r: number, g: number, b: number, out: Float32Array) => void;

/** k-means palette of `k` colors picked from the image itself (seeded, deterministic). */
export function autoPalette(img: FImage, k: number, seed = 1): [number, number, number][] {
  const n = img.r.length;
  const stride = Math.max(1, Math.floor(n / 20000));
  const pts: number[] = [];
  for (let i = 0; i < n; i += stride) pts.push(img.r[i], img.g[i], img.b[i]);
  const m = pts.length / 3;
  const rand = mulberry32(seed);
  const d2 = (i: number, c: number[]) => {
    const a = pts[i * 3] - c[0], b = pts[i * 3 + 1] - c[1], e = pts[i * 3 + 2] - c[2];
    return a * a + b * b + e * e;
  };
  // k-means++ init spreads the seeds across the color range.
  const cents: number[][] = [];
  const first = Math.floor(rand() * m);
  cents.push([pts[first * 3], pts[first * 3 + 1], pts[first * 3 + 2]]);
  const dist = new Float64Array(m).fill(Infinity);
  while (cents.length < k) {
    let sum = 0;
    for (let i = 0; i < m; i++) { dist[i] = Math.min(dist[i], d2(i, cents[cents.length - 1])); sum += dist[i]; }
    if (sum === 0) break;
    let r = rand() * sum, pick = 0;
    for (; pick < m - 1 && (r -= dist[pick]) > 0; pick++);
    cents.push([pts[pick * 3], pts[pick * 3 + 1], pts[pick * 3 + 2]]);
  }
  const assign = new Int32Array(m);
  for (let iter = 0; iter < 12; iter++) {
    for (let i = 0; i < m; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < cents.length; c++) { const d = d2(i, cents[c]); if (d < bd) { bd = d; best = c; } }
      assign[i] = best;
    }
    const acc = cents.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < m; i++) { const a = acc[assign[i]]; a[0] += pts[i * 3]; a[1] += pts[i * 3 + 1]; a[2] += pts[i * 3 + 2]; a[3]++; }
    acc.forEach((a, c) => { if (a[3]) cents[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  return cents as [number, number, number][];
}

function paletteQuantizer(cols: [number, number, number][]): { q: Quantizer; step: number } {
  return {
    step: 1 / Math.max(1, cols.length - 1),
    q: (r, g, b, out) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        // Weighted RGB distance approximates perceived difference cheaply.
        const dr = r - c[0], dg = g - c[1], db = b - c[2];
        const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bd) { bd = d; best = i; }
      }
      out[0] = cols[best][0]; out[1] = cols[best][1]; out[2] = cols[best][2];
    },
  };
}

function makeQuantizer(palette: string, levels: number, img: FImage, seed: number): { q: Quantizer; step: number } {
  if (palette === 'auto') return paletteQuantizer(autoPalette(img, Math.max(2, Math.round(levels)), seed));
  if (palette === 'source') {
    const n = Math.max(2, Math.round(levels)) - 1;
    return {
      step: 1 / n,
      q: (r, g, b, out) => {
        out[0] = Math.round(clamp01(r) * n) / n;
        out[1] = Math.round(clamp01(g) * n) / n;
        out[2] = Math.round(clamp01(b) * n) / n;
      },
    };
  }
  const hexes = PALETTES[palette] ?? palette.split(',').map((s) => s.trim()).filter(Boolean);
  if (hexes.length < 2) throw new Error(`Unknown palette "${palette}". Use one of: ${PALETTE_NAMES.join(', ')} or a comma-separated hex list.`);
  return paletteQuantizer(hexes.map(hexToRgb));
}

type Kernel = [dx: number, dy: number, weight: number][];

const k = (div: number, rows: number[][], origin: number): Kernel => {
  const out: Kernel = [];
  rows.forEach((row, dy) => row.forEach((v, x) => { if (v) out.push([x - origin, dy, v / div]); }));
  return out;
};

// Rows start at the current pixel's row; the current pixel and earlier cells are written as 0.
const KERNELS: Partial<Record<DitherAlgo, Kernel>> = {
  'floyd-steinberg': k(16, [[0, 0, 7], [3, 5, 1]], 1),
  atkinson: k(8, [[0, 0, 1, 1], [1, 1, 1, 0], [0, 1, 0, 0]], 1),
  jarvis: k(48, [[0, 0, 0, 7, 5], [3, 5, 7, 5, 3], [1, 3, 5, 3, 1]], 2),
  stucki: k(42, [[0, 0, 0, 8, 4], [2, 4, 8, 4, 2], [1, 2, 4, 2, 1]], 2),
  burkes: k(32, [[0, 0, 0, 8, 4], [2, 4, 8, 4, 2]], 2),
  sierra: k(32, [[0, 0, 0, 5, 3], [2, 4, 5, 4, 2], [0, 2, 3, 2, 0]], 2),
  'sierra-2row': k(16, [[0, 0, 0, 4, 3], [1, 2, 3, 2, 1]], 2),
  'sierra-lite': k(4, [[0, 0, 2], [1, 1, 0]], 1),
};

const bayerCache = new Map<number, Float32Array>();
function bayer(size: number): Float32Array {
  let m = bayerCache.get(size);
  if (!m) {
    m = Float32Array.from(bayerMatrix(size), (v) => (v + 0.5) / (size * size) - 0.5);
    bayerCache.set(size, m);
  }
  return m;
}

// 8×8 clustered-dot (45° screen) threshold order, for a print-halftone look.
const HALFTONE = Float32Array.from(
  [
    24, 10, 12, 26, 35, 47, 49, 37, 8, 0, 2, 14, 45, 59, 61, 51, 22, 6, 4, 16, 43, 57, 63, 53, 30, 20, 18, 28, 33, 41, 55, 39,
    34, 46, 48, 36, 25, 11, 13, 27, 44, 58, 60, 50, 9, 1, 3, 15, 42, 56, 62, 52, 23, 7, 5, 17, 32, 40, 54, 38, 31, 21, 19, 29,
  ],
  (v) => (v + 0.5) / 64 - 0.5,
);

/** Threshold offset in -0.5..0.5 for ordered/pattern dithers, or null for error diffusion. */
function thresholdMap(algo: DitherAlgo, seed: number): ((x: number, y: number) => number) | null {
  switch (algo) {
    case 'bayer2': case 'bayer4': case 'bayer8': case 'bayer16': {
      const n = Number(algo.slice(5));
      const m = bayer(n);
      return (x, y) => m[(y % n) * n + (x % n)];
    }
    case 'halftone':
      return (x, y) => HALFTONE[(y % 8) * 8 + (x % 8)];
    case 'ign':
      // Interleaved gradient noise (Jimenez 2014): cheap, blue-noise-like, no visible tiling.
      return (x, y) => ((52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1)) % 1) - 0.5;
    case 'lines-h':
      return (_x, y) => ((y % 4) + 0.5) / 4 - 0.5;
    case 'lines-v':
      return (x) => ((x % 4) + 0.5) / 4 - 0.5;
    case 'lines-diag':
      return (x, y) => (((x + y) % 6) + 0.5) / 6 - 0.5;
    case 'lines-diag-2':
      return (x, y) => ((((x - y) % 6 + 6) % 6) + 0.5) / 6 - 0.5;
    case 'noise': {
      const rand = mulberry32(seed);
      return () => rand() - 0.5;
    }
    case 'none':
      return () => 0;
    default:
      return null;
  }
}

/** Quantize `img` (already at pixel-grid resolution) to the palette using `algo`. */
export function dither(img: FImage, algo: DitherAlgo, palette: string, levels: number, spread: number, seed = 1): FImage {
  const { q, step } = makeQuantizer(palette, levels, img, seed);
  const { width: w, height: h } = img;
  const out = createF(w, h);
  const c = new Float32Array(3);

  const tmap = thresholdMap(algo, seed);
  if (tmap) {
    const amp = step * spread;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = tmap(x, y) * amp;
        q(img.r[i] + t, img.g[i] + t, img.b[i] + t, c);
        out.r[i] = c[0]; out.g[i] = c[1]; out.b[i] = c[2];
      }
    return out;
  }

  const kernel = KERNELS[algo];
  if (!kernel) throw new Error(`Unknown dither algorithm "${algo}"`);
  const r = img.r.slice(), g = img.g.slice(), b = img.b.slice();
  for (let y = 0; y < h; y++) {
    // Serpentine scan avoids directional worm artifacts.
    const rev = y % 2 === 1;
    for (let kx = 0; kx < w; kx++) {
      const x = rev ? w - 1 - kx : kx;
      const i = y * w + x;
      q(r[i], g[i], b[i], c);
      out.r[i] = c[0]; out.g[i] = c[1]; out.b[i] = c[2];
      const er = (r[i] - c[0]) * spread, eg = (g[i] - c[1]) * spread, eb = (b[i] - c[2]) * spread;
      for (const [dx0, dy, wt] of kernel) {
        const nx = x + (rev ? -dx0 : dx0), ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        r[j] += er * wt; g[j] += eg * wt; b[j] += eb * wt;
      }
    }
  }
  return out;
}
