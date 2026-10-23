// PNG encoder with a selectable zlib level, since canvas PNG export can't set one.
import { zlibSync } from 'fflate';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Encodes RGBA pixels as a PNG. `level` is the zlib level, 0 (stored, fastest) to 9 (smallest, slowest).
 * Opaque images are written as RGB, and each row gets the filter with the smallest sum of absolute bytes.
 */
export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, level: number): Uint8Array {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;

  const raw = new Uint8Array(stride * height);
  for (let i = 0, o = 0; i < rgba.length; i += 4) {
    raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2];
    if (!opaque) raw[o++] = rgba[i + 3];
  }

  const filtered = new Uint8Array((stride + 1) * height);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride, prev = row - stride;
    let best = 0;
    if (level > 0) {
      let bestSum = Infinity;
      for (let f = 0; f < 5; f++) {
        const out = cand[f];
        let sum = 0;
        for (let x = 0; x < stride; x++) {
          const cur = raw[row + x];
          const a = x >= bpp ? raw[row + x - bpp] : 0;
          const b = y > 0 ? raw[prev + x] : 0;
          const c = x >= bpp && y > 0 ? raw[prev + x - bpp] : 0;
          const v = (cur - (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 0xff;
          out[x] = v;
          sum += v < 128 ? v : 256 - v;
          if (sum >= bestSum) break;
        }
        if (sum < bestSum) { bestSum = sum; best = f; }
      }
    }
    const o = y * (stride + 1);
    filtered[o] = best;
    filtered.set(best === 0 ? raw.subarray(row, row + stride) : cand[best], o + 1);
  }

  const idat = zlibSync(filtered, { level: Math.max(0, Math.min(9, Math.round(level))) as 0 });
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, opaque ? 2 : 6, 0, 0, 0], 8);

  const chunks: [string, Uint8Array][] = [['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]];
  const out = new Uint8Array(8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0));
  const ov = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let p = 8;
  for (const [type, data] of chunks) {
    ov.setUint32(p, data.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(data, p + 8);
    ov.setUint32(p + 8 + data.length, crc32(out, p + 4, p + 8 + data.length));
    p += 12 + data.length;
  }
  return out;
}
