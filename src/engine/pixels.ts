// Float RGB image buffers and the low-level filters the renderer is built from.

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Planar float image, channels 0..1. */
export interface FImage {
  width: number;
  height: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

export function createF(width: number, height: number): FImage {
  const n = width * height;
  return { width, height, r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n) };
}

export function fromRGBA(img: RGBAImage): FImage {
  const out = createF(img.width, img.height);
  const d = img.data;
  for (let i = 0, p = 0; i < out.r.length; i++, p += 4) {
    out.r[i] = d[p] / 255;
    out.g[i] = d[p + 1] / 255;
    out.b[i] = d[p + 2] / 255;
  }
  return out;
}

export function toRGBA(img: FImage): Uint8ClampedArray {
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[p] = img.r[i] * 255 + 0.5;
    out[p + 1] = img.g[i] * 255 + 0.5;
    out[p + 2] = img.b[i] * 255 + 0.5;
    out[p + 3] = 255;
  }
  return out;
}

export function cloneF(img: FImage): FImage {
  return { width: img.width, height: img.height, r: img.r.slice(), g: img.g.slice(), b: img.b.slice() };
}

export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = parseInt(h, 16);
  if (Number.isNaN(v) || h.length !== 6) throw new Error(`Invalid color: ${hex}`);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function adjust(img: FImage, o: { brightness: number; contrast: number; saturation: number; gamma: number; invert: boolean }) {
  const invG = 1 / o.gamma;
  const pow = invG === 1 ? (v: number) => v : (v: number) => Math.pow(v, invG);
  const chans = [img.r, img.g, img.b];
  for (let i = 0; i < img.r.length; i++) {
    let r = img.r[i], g = img.g[i], b = img.b[i];
    if (o.invert) { r = 1 - r; g = 1 - g; b = 1 - b; }
    const l = luma(r, g, b);
    r = l + (r - l) * o.saturation;
    g = l + (g - l) * o.saturation;
    b = l + (b - l) * o.saturation;
    r = (r - 0.5) * o.contrast + 0.5 + o.brightness;
    g = (g - 0.5) * o.contrast + 0.5 + o.brightness;
    b = (b - 0.5) * o.contrast + 0.5 + o.brightness;
    chans[0][i] = pow(clamp01(r));
    chans[1][i] = pow(clamp01(g));
    chans[2][i] = pow(clamp01(b));
  }
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Running-sum box blur along one axis (edges clamped); three passes approximate a Gaussian.
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const scale = 1 / (2 * r + 1);
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const base = y * w, last = base + w - 1;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[base + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        dst[base + x] = acc * scale;
        const add = base + x + r + 1, sub = base + x - r;
        acc += src[add > last ? last : add] - src[sub < base ? base : sub];
      }
    }
    return;
  }
  // Vertical: sweep whole rows at once so memory access stays sequential.
  const acc = new Float32Array(w);
  for (let k = -r; k <= r; k++) {
    const row = Math.min(h - 1, Math.max(0, k)) * w;
    for (let x = 0; x < w; x++) acc[x] += src[row + x];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const add = Math.min(h - 1, y + r + 1) * w, sub = Math.max(0, y - r) * w;
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc[x] * scale;
      acc[x] += src[add + x] - src[sub + x];
    }
  }
}

// 3-tap [k, 1-2k, k] pass with variance sigma² (2k = sigma²), for blurs smaller than one box radius.
function tapPass(ch: Float32Array, w: number, h: number, k: number) {
  const tmp = new Float32Array(ch.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      tmp[i] = ch[i] * (1 - 2 * k) + (ch[x > 0 ? i - 1 : i] + ch[x < w - 1 ? i + 1 : i]) * k;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      ch[i] = tmp[i] * (1 - 2 * k) + (tmp[y > 0 ? i - w : i] + tmp[y < h - 1 ? i + w : i]) * k;
    }
}

function blurChannel(ch: Float32Array, w: number, h: number, sigma: number) {
  if (sigma <= 0.3) return;
  if (sigma < 0.9) return tapPass(ch, w, h, (sigma * sigma) / 2);
  // Box radius whose 3-pass variance matches sigma².
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const tmp = new Float32Array(ch.length);
  for (let i = 0; i < 3; i++) {
    boxPass(ch, tmp, w, h, r, true);
    boxPass(tmp, ch, w, h, r, false);
  }
}

export function downsample(img: FImage, f: number): FImage {
  const w = Math.max(1, Math.ceil(img.width / f));
  const h = Math.max(1, Math.ceil(img.height / f));
  const out = createF(w, h);
  const cnt = new Float32Array(w * h);
  for (let y = 0; y < img.height; y++) {
    const oy = ((y / f) | 0) * w;
    for (let x = 0; x < img.width; x++) {
      const i = y * img.width + x;
      const o = oy + ((x / f) | 0);
      out.r[o] += img.r[i]; out.g[o] += img.g[i]; out.b[o] += img.b[i]; cnt[o]++;
    }
  }
  for (let o = 0; o < cnt.length; o++) { out.r[o] /= cnt[o]; out.g[o] /= cnt[o]; out.b[o] /= cnt[o]; }
  return out;
}

/** Bilinear resample of `img` onto a width×height grid. */
export function resizeF(img: FImage, width: number, height: number): FImage {
  const out = createF(width, height);
  const sx = img.width / width, sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(img.height - 1, fy | 0), y1 = Math.min(img.height - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(img.width - 1, fx | 0), x1 = Math.min(img.width - 1, x0 + 1), tx = fx - x0;
      const a = y0 * img.width + x0, b = y0 * img.width + x1, c = y1 * img.width + x0, d = y1 * img.width + x1;
      const o = y * width + x;
      const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
      out.r[o] = img.r[a] * w00 + img.r[b] * w01 + img.r[c] * w10 + img.r[d] * w11;
      out.g[o] = img.g[a] * w00 + img.g[b] * w01 + img.g[c] * w10 + img.g[d] * w11;
      out.b[o] = img.b[a] * w00 + img.b[b] * w01 + img.b[c] * w10 + img.b[d] * w11;
    }
  }
  return out;
}

/** Gaussian-like blur; large radii run on a downsampled copy so 4K stays fast. */
export function blur(img: FImage, sigma: number): FImage {
  if (sigma <= 0.3) return cloneF(img);
  const f = Math.max(1, Math.floor(sigma / 3));
  const small = f > 1 ? downsample(img, f) : cloneF(img);
  const s = sigma / f;
  blurChannel(small.r, small.width, small.height, s);
  blurChannel(small.g, small.width, small.height, s);
  blurChannel(small.b, small.width, small.height, s);
  return f > 1 ? resizeF(small, img.width, img.height) : small;
}

/** Deterministic PRNG so CLI output is reproducible. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
