import { BLOOM, HALO_GAIN } from '../effects.ts';

/** A JS number as a GLSL float literal. */
const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

export const VERTEX = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

export const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 o;
ivec2 P() { return ivec2(gl_FragCoord.xy); }
float ss(float a, float b, float x) {
  if (b <= a) return x >= a ? 1.0 : 0.0;
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
// Bilinear resample matching resizeF: texture t (size ts) as if resized to ds, at pixel p.
vec4 bil(sampler2D t, ivec2 ts, vec2 ds, ivec2 p) {
  vec2 f = max(vec2(0.0), (vec2(p) + 0.5) * (vec2(ts) / ds) - 0.5);
  ivec2 i0 = min(ts - 1, ivec2(f)), i1 = min(ts - 1, i0 + 1);
  vec2 k = f - vec2(i0);
  return texelFetch(t, i0, 0) * (1.0 - k.x) * (1.0 - k.y) + texelFetch(t, ivec2(i1.x, i0.y), 0) * k.x * (1.0 - k.y)
       + texelFetch(t, ivec2(i0.x, i1.y), 0) * (1.0 - k.x) * k.y + texelFetch(t, i1, 0) * k.x * k.y;
}
`;

const ADJUST = `
uniform float uBright, uContrast, uSat, uInvG; uniform bool uInvert;
vec3 adjustC(vec3 c) {
  if (uInvert) c = 1.0 - c;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = l + (c - l) * uSat;
  c = clamp((c - 0.5) * uContrast + 0.5 + uBright, 0.0, 1.0);
  return uInvG == 1.0 ? c : pow(c, vec3(uInvG));
}
`;

export const SHADERS = {
  adjust: ADJUST + `uniform sampler2D uSrc;
void main() { o = vec4(adjustC(texelFetch(uSrc, P(), 0).rgb), 1.0); }`,

  // Average of the adjusted source over each cell. Cell edges come from the CPU (uStarts: first column in r, first
  // row in g), since float32 division would put some boundary pixels in the neighbouring cell.
  cells: ADJUST + `uniform sampler2D uSrc, uStarts;
void main() {
  ivec2 c = P();
  int x0 = int(texelFetch(uStarts, ivec2(c.x, 0), 0).r), x1 = int(texelFetch(uStarts, ivec2(c.x + 1, 0), 0).r);
  int y0 = int(texelFetch(uStarts, ivec2(c.y, 0), 0).g), y1 = int(texelFetch(uStarts, ivec2(c.y + 1, 0), 0).g);
  vec3 sum = vec3(0.0);
  for (int y = y0; y < y1; y++)
    for (int x = x0; x < x1; x++) sum += adjustC(texelFetch(uSrc, ivec2(x, y), 0).rgb);
  float n = float((x1 - x0) * (y1 - y0));
  o = vec4(n > 0.0 ? sum / n : vec3(0.0), 1.0);
}`,

  // Box downsample by an integer factor (partial blocks at the edges), optionally through the bloom bright-pass.
  down: `uniform sampler2D uSrc; uniform int uF; uniform ivec2 uSize; uniform bool uBrightPass; uniform float uLo, uHi;
void main() {
  ivec2 p = P();
  vec4 sum = vec4(0.0); float n = 0.0;
  for (int y = p.y * uF; y < min(uSize.y, (p.y + 1) * uF); y++)
    for (int x = p.x * uF; x < min(uSize.x, (p.x + 1) * uF); x++) {
      vec4 v = texelFetch(uSrc, ivec2(x, y), 0);
      if (uBrightPass) v = vec4(v.rgb * ss(uLo, uHi, dot(v.rgb, vec3(0.2126, 0.7152, 0.0722))), 1.0);
      sum += v; n += 1.0;
    }
  o = sum / n;
}`,

  box: `uniform sampler2D uSrc; uniform int uR; uniform ivec2 uDir, uSize;
void main() {
  ivec2 p = P();
  vec4 sum = vec4(0.0);
  for (int k = -uR; k <= uR; k++) sum += texelFetch(uSrc, clamp(p + uDir * k, ivec2(0), uSize - 1), 0);
  o = sum / float(2 * uR + 1);
}`,

  tap: `uniform sampler2D uSrc; uniform float uK; uniform ivec2 uDir, uSize;
void main() {
  ivec2 p = P();
  vec4 a = texelFetch(uSrc, clamp(p - uDir, ivec2(0), uSize - 1), 0), b = texelFetch(uSrc, clamp(p + uDir, ivec2(0), uSize - 1), 0);
  o = texelFetch(uSrc, p, 0) * (1.0 - 2.0 * uK) + (a + b) * uK;
}`,

  // Bilinear resize, then a fade toward uMixColor (background opacity).
  resize: `uniform sampler2D uSrc; uniform ivec2 uSize; uniform vec2 uDst; uniform float uMixK; uniform vec3 uMixColor;
void main() {
  vec4 v = bil(uSrc, uSize, uDst, P());
  o = vec4(uMixColor * (1.0 - uMixK) + v.rgb * uMixK, v.a);
}`,

  // The halo around glyphs (see render.ts), then the glyph layer over it.
  compose: `uniform sampler2D uBg, uSoft, uSpread, uGlyph; uniform bool uHalo, uSoftOn; uniform float uHaloTone;
uniform vec3 uBgColor; uniform ivec2 uSpreadSize; uniform vec2 uGridPx;
void main() {
  ivec2 p = P();
  vec3 c = texelFetch(uBg, p, 0).rgb;
  if (uHalo) {
    float m = clamp(bil(uSpread, uSpreadSize, uGridPx, p).r * ${f(HALO_GAIN)}, 0.0, 1.0);
    if (m > 0.0) {
      if (uSoftOn) c += (texelFetch(uSoft, p, 0).rgb - c) * m;
      vec3 inv = 1.0 - c;
      c += ((uHaloTone < 0.0 ? uBgColor : 1.0 - inv * inv * inv) - c) * (abs(uHaloTone) * m);
    }
  }
  vec4 g = texelFetch(uGlyph, p, 0);
  if (g.a > 0.0) c = c * (1.0 - g.a) + g.rgb;
  o = vec4(c, 1.0);
}`,

  // Stamps the glyph masks of the cells around this pixel, in raster order like stampGlyphs. uSlot per cell: mask
  // slot (-1 = none) and the stamp's top-left pixel; uColor: glyph color and opacity.
  glyphs: `uniform sampler2D uSlot, uColor, uAtlas; uniform ivec2 uGrid, uMask; uniform int uAtlasCols; uniform vec2 uCell;
void main() {
  ivec2 p = P();
  // A stamp at x0 = round(cx * cw + cw/2 - mw/2) covers x0 .. x0 + mw - 1; these are the cells whose stamps can reach p.
  vec2 a = (vec2(p) - vec2(uMask) / 2.0 - uCell / 2.0 + 0.5) / uCell;
  ivec2 lo = max(ivec2(0), ivec2(floor(a)));
  ivec2 hi = min(uGrid - 1, ivec2(floor(a + vec2(uMask) / uCell + 0.01)));
  vec3 g = vec3(0.0); float al = 0.0;
  for (int cy = lo.y; cy <= hi.y; cy++)
    for (int cx = lo.x; cx <= hi.x; cx++) {
      vec4 sl = texelFetch(uSlot, ivec2(cx, cy), 0);
      if (sl.r < 0.0) continue;
      ivec2 q = p - ivec2(sl.gb);
      if (q.x < 0 || q.y < 0 || q.x >= uMask.x || q.y >= uMask.y) continue;
      int k = int(sl.r);
      float m = texelFetch(uAtlas, ivec2((k % uAtlasCols) * uMask.x + q.x, (k / uAtlasCols) * uMask.y + q.y), 0).r;
      vec4 c = texelFetch(uColor, ivec2(cx, cy), 0);
      float ea = m * c.a;
      if (ea == 0.0) continue;
      g = g * (1.0 - ea) + c.rgb * ea; al = al * (1.0 - ea) + ea;
    }
  o = vec4(g, al);
}`,

  bloom: `uniform sampler2D uTight, uWide; uniform float uStrength;
void main() { ivec2 p = P(); o = vec4(uStrength * (${f(BLOOM.tightWeight)} * texelFetch(uTight, p, 0).rgb + ${f(BLOOM.wideWeight)} * texelFetch(uWide, p, 0).rgb), 1.0); }`,

  nearest: `uniform sampler2D uSrc; uniform ivec2 uSize, uDst;
void main() {
  ivec2 p = P();
  ivec2 q = min(uSize - 1, p * uSize / uDst);
  o = vec4(texelFetch(uSrc, q, 0).rgb, 1.0);
}`,

  // Glow, color fringe, scanlines, vignette, grain and the final clamp, rounded like Uint8ClampedArray.
  final: `uniform sampler2D uImg, uComb; uniform bool uBloom; uniform ivec2 uSize, uCombSize;
uniform float uChrom, uScan, uScanSp, uVig, uVigSize, uVigX, uVigY, uGrain; uniform uint uSeed; uniform bool uFlip;
float shoulder(float v) { return v <= 0.8 ? v : 0.8 + 0.2 * (1.0 - exp(-(v - 0.8) / 0.2)); }
vec3 at(ivec2 q) {
  vec3 c = texelFetch(uImg, q, 0).rgb;
  if (uBloom) { vec3 g = bil(uComb, uCombSize, vec2(uSize), q).rgb; c = vec3(shoulder(c.r + g.r), shoulder(c.g + g.g), shoulder(c.b + g.b)); }
  return c;
}
float hash(ivec2 p) {
  uint h = uint(p.x) * 1973u + uint(p.y) * 9277u + uSeed * 26699u;
  h = (h ^ 61u) ^ (h >> 16); h *= 9u; h ^= h >> 4; h *= 0x27d4eb2du; h ^= h >> 15;
  return float(h) / 4294967296.0;
}
void main() {
  ivec2 p = P();
  // The canvas's row 0 is the bottom, while textures here keep the image's top row at 0.
  if (uFlip) p.y = uSize.y - 1 - p.y;
  vec2 sz = vec2(uSize), x = vec2(p);
  vec3 c = at(p);
  if (uChrom > 0.0) {
    vec2 ctr = sz / 2.0;
    vec2 d = (x - ctr) / length(ctr) * uChrom;
    c.r = at(clamp(ivec2(floor(x + d + 0.5)), ivec2(0), uSize - 1)).r;
    c.b = at(clamp(ivec2(floor(x - d + 0.5)), ivec2(0), uSize - 1)).b;
  }
  float m = 1.0;
  if (uScan > 0.0) { float v = sin(3.141592653589793 * (x.y + 0.5) / uScanSp); m = (1.0 - uScan * v * v) * (1.0 + uScan * 0.3); }
  if (uVig > 0.0) {
    vec2 d = (x - sz * vec2(uVigX, uVigY)) / (sz / 2.0);
    m *= 1.0 - uVig * ss(0.35 * uVigSize, uVigSize, sqrt(dot(d, d) / 2.0));
  }
  float g = uGrain > 0.0 ? (hash(p) - 0.5) * uGrain : 0.0;
  c = clamp(c * m + g, 0.0, 1.0);
  o = vec4(min(vec3(1.0), (c * 255.0 + 0.5) / 255.0), 1.0);
}`,
};

export type ShaderName = keyof typeof SHADERS;
