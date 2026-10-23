// WebGL2 version of render(): the full-resolution pixel passes run as shaders, while glyph choice, stamping and
// dithering stay on the CPU. Mirrors render.ts closely enough that the two match within a level or so.
import { dither } from './dither.ts';
import type { Params } from './params.ts';
import { blur, createF, hexToRgb, type FImage, type RGBAImage } from './pixels.ts';
import { cellGrid, glyphPlan, render, type GlyphPlan, type RenderOptions, type RenderResult } from './render.ts';

/** The GPU itself failed (context lost, out of memory, driver error), as opposed to this one render not fitting. */
class GpuFailure extends Error {}

/**
 * A source the GPU can upload straight from (a canvas, bitmap or video frame) instead of from CPU pixels. `read`
 * returns its pixels for the CPU fallback.
 */
export interface ImageInput { width: number; height: number; image: TexImageSource; read: () => RGBAImage }
export type Source = RGBAImage | ImageInput;
/** A render handed over as an ImageBitmap, without reading the pixels back from the GPU. */
export interface BitmapResult { width: number; height: number; bitmap: ImageBitmap; text?: string }

const pixelsOf = (src: Source): RGBAImage => ('image' in src ? src.read() : src);

function bitmapOf(r: RenderResult): BitmapResult {
  const c = new OffscreenCanvas(r.width, r.height);
  c.getContext('2d')!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
  return { width: r.width, height: r.height, bitmap: c.transferToImageBitmap(), text: r.text };
}

/**
 * Render functions that use the GPU while `enabled` and available, and the CPU otherwise. Any GPU-side error
 * re-renders that call on the CPU; after a GPU failure it stays on the CPU. Each call reports which one it used.
 * `data` returns pixels (for encoding); `bitmap` returns an ImageBitmap (for display), which on the GPU skips the
 * read-back entirely.
 */
export function gpuOrCpu() {
  let gpu: GpuRenderer | null | undefined;
  const run = <T>(src: Source, p: Params, opts: RenderOptions, enabled: boolean, onGpu: (g: GpuRenderer) => T, onCpu: (r: RenderResult) => T): { r: T; gpu: boolean } => {
    if (enabled && gpu !== null) {
      try {
        gpu ??= GpuRenderer.create();
        if (gpu) return { r: onGpu(gpu), gpu: true };
      } catch (err) {
        if (err instanceof GpuFailure) {
          console.warn('GPU rendering failed; using the CPU from now on.', err);
          gpu = null;
        }
      }
    }
    return { r: onCpu(render(pixelsOf(src), p, opts)), gpu: false };
  };
  return {
    data: (src: Source, p: Params, opts: RenderOptions, enabled: boolean) =>
      run(src, p, opts, enabled, (g) => g.render(src, p, opts), (r) => r),
    bitmap: (src: Source, p: Params, opts: RenderOptions, enabled: boolean) =>
      run(src, p, opts, enabled, (g) => g.renderBitmap(src, p, opts), bitmapOf),
  };
}

type Fmt = 'u8' | 'f16' | 'f32';
interface Tex { t: WebGLTexture; w: number; h: number; fmt: Fmt; key: string }
type Uniform = number | boolean | number[] | Tex;

const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 o;
ivec2 P() { return ivec2(gl_FragCoord.xy); }
float ss(float a, float b, float x) {
  if (b <= a) return x >= a ? 1.0 : 0.0;
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
// Bilinear resample matching resizeF: sample texture t (size ts) as if resized to ds, at pixel p.
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

const SHADERS: Record<string, string> = {
  adjust: ADJUST + `uniform sampler2D uSrc;
void main() { o = vec4(adjustC(texelFetch(uSrc, P(), 0).rgb), 1.0); }`,

  // Average of the adjusted source over each cell; a pixel belongs to cell floor(x / cw), as in cellAverages.
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

  // Halo (dim and soften the photo near glyphs), then the glyph layer over it.
  compose: `uniform sampler2D uBg, uSoft, uSpread, uGlyph; uniform bool uHalo, uSoftOn; uniform float uHaloTone;
uniform vec3 uBgColor; uniform ivec2 uSpreadSize; uniform vec2 uGridPx;
void main() {
  ivec2 p = P();
  vec3 c = texelFetch(uBg, p, 0).rgb;
  if (uHalo) {
    float m = clamp(bil(uSpread, uSpreadSize, uGridPx, p).r * 3.0, 0.0, 1.0);
    if (m > 0.0) {
      if (uSoftOn) c += (texelFetch(uSoft, p, 0).rgb - c) * m;
      // Below 0 dims toward the background color; above 0 lifts toward a brighter version of the pixel's own color.
      vec3 inv = 1.0 - c;
      c += ((uHaloTone < 0.0 ? uBgColor : 1.0 - inv * inv * inv) - c) * (abs(uHaloTone) * m);
    }
  }
  vec4 g = texelFetch(uGlyph, p, 0);
  if (g.a > 0.0) c = c * (1.0 - g.a) + g.rgb;
  o = vec4(c, 1.0);
}`,

  // Stamps the glyph masks of the cells around this pixel, composited in raster order exactly like glyphLayer.
  // uSlot per cell: mask slot (-1 = none) and the stamp's top-left pixel; uColor: glyph color and opacity.
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
void main() { ivec2 p = P(); o = vec4(uStrength * (0.55 * texelFetch(uTight, p, 0).rgb + 0.65 * texelFetch(uWide, p, 0).rgb), 1.0); }`,

  nearest: `uniform sampler2D uSrc; uniform ivec2 uSize, uDst;
void main() {
  ivec2 p = P();
  ivec2 q = min(uSize - 1, p * uSize / uDst);
  o = vec4(texelFetch(uSrc, q, 0).rgb, 1.0);
}`,

  // Glow, color fringe, scanlines, vignette, grain and the final clamp; output is rounded like Uint8ClampedArray.
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
  // Drawing to the canvas: its row 0 is the bottom, while textures here keep the image's top row at 0.
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

const VERT = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

interface Program { prog: WebGLProgram; uniforms: Map<string, { loc: WebGLUniformLocation; type: number }> }

export class GpuRenderer {
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, Program>();
  private fbo: WebGLFramebuffer;
  private free = new Map<string, Tex[]>();
  private live = new Set<Tex>();
  private usedKeys = new Set<string>();
  private srcCache: { key: string; tex: Tex } | null = null;
  /** Glyph mask atlases by their mask list, most recently used last; outside the texture pool. */
  private atlases = new Map<string, { tex: Tex; cols: number }>();
  private canvas: OffscreenCanvas;
  private lost = false;
  private maxSize: number;

  /** Returns null where WebGL2 with float render targets isn't available. */
  static create(): GpuRenderer | null {
    try {
      if (typeof OffscreenCanvas === 'undefined') return null;
      const canvas = new OffscreenCanvas(1, 1);
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const r = new GpuRenderer(gl, canvas);
      canvas.addEventListener('webglcontextlost', () => { r.lost = true; });
      return r;
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext, canvas: OffscreenCanvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const vs = this.shader(gl.VERTEX_SHADER, VERT);
    for (const [name, src] of Object.entries(SHADERS)) {
      const prog = gl.createProgram()!;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, this.shader(gl.FRAGMENT_SHADER, HEAD + src));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link ${name}: ${gl.getProgramInfoLog(prog)}`);
      const uniforms = new Map<string, { loc: WebGLUniformLocation; type: number }>();
      for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
        const info = gl.getActiveUniform(prog, i)!;
        uniforms.set(info.name, { loc: gl.getUniformLocation(prog, info.name)!, type: info.type });
      }
      this.programs.set(name, { prog, uniforms });
    }
    this.fbo = gl.createFramebuffer()!;
    gl.bindVertexArray(gl.createVertexArray());
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  }

  get usable() { return !this.lost; }

  private shader(type: number, src: string) {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
    return sh;
  }

  // ---- textures ----

  private tex(w: number, h: number, fmt: Fmt): Tex {
    const key = `${fmt}:${w}x${h}`;
    this.usedKeys.add(key);
    const pooled = this.free.get(key)?.pop();
    if (pooled) { this.live.add(pooled); return pooled; }
    const tex = this.newTex(w, h, fmt);
    this.live.add(tex);
    return tex;
  }

  private newTex(w: number, h: number, fmt: Fmt): Tex {
    const gl = this.gl;
    const key = `${fmt}:${w}x${h}`;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt === 'u8' ? gl.RGBA8 : fmt === 'f16' ? gl.RGBA16F : gl.RGBA32F, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    return { t, w, h, fmt, key };
  }

  private release(...ts: (Tex | null | undefined)[]) {
    for (const t of ts) {
      if (!t || !this.live.delete(t) || t === this.srcCache?.tex) continue;
      let list = this.free.get(t.key);
      if (!list) this.free.set(t.key, (list = []));
      list.push(t);
    }
  }

  private upload(w: number, h: number, fmt: 'u8' | 'f32', data: ArrayBufferView, into?: Tex): Tex {
    const gl = this.gl;
    const t = into ?? this.tex(w, h, fmt);
    gl.bindTexture(gl.TEXTURE_2D, t.t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, fmt === 'u8' ? gl.UNSIGNED_BYTE : gl.FLOAT, data);
    return t;
  }

  private uploadImage(src: ImageInput): Tex {
    const gl = this.gl;
    const t = this.tex(src.width, src.height, 'u8');
    gl.bindTexture(gl.TEXTURE_2D, t.t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, src.width, src.height, gl.RGBA, gl.UNSIGNED_BYTE, src.image);
    return t;
  }

  /** The plan's glyph masks packed into one texture, reused while the same masks are in use. */
  private atlas(plan: GlyphPlan): { tex: Tex; cols: number } {
    const key = plan.maskKeys.join('\n');
    const hit = this.atlases.get(key);
    if (hit) { this.atlases.delete(key); this.atlases.set(key, hit); return hit; }
    const { mw, mh, masks } = plan;
    const cols = Math.max(1, Math.ceil(Math.sqrt(masks.length)));
    const rows = Math.max(1, Math.ceil(masks.length / cols));
    const W = cols * mw, H = rows * mh;
    if (W > this.maxSize || H > this.maxSize) throw new Error(`glyph atlas exceeds the GPU texture limit of ${this.maxSize}px`);
    const data = new Uint8Array(W * H * 4);
    masks.forEach((m, k) => {
      const ox = (k % cols) * mw, oy = Math.floor(k / cols) * mh;
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) data[((oy + y) * W + ox + x) * 4] = Math.round(m[y * mw + x] * 255);
    });
    const entry = { tex: this.upload(W, H, 'u8', data, this.newTex(W, H, 'u8')), cols };
    this.atlases.set(key, entry);
    while (this.atlases.size > 8) {
      const [k, old] = this.atlases.entries().next().value!;
      this.gl.deleteTexture(old.tex.t);
      this.atlases.delete(k);
    }
    return entry;
  }

  private bindTarget(t: Tex) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.t, 0);
  }

  private readF(t: Tex): FImage {
    const gl = this.gl;
    this.bindTarget(t);
    const buf = new Float32Array(t.w * t.h * 4);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, buf);
    const out = createF(t.w, t.h);
    for (let i = 0, j = 0; i < out.r.length; i++, j += 4) { out.r[i] = buf[j]; out.g[i] = buf[j + 1]; out.b[i] = buf[j + 2]; }
    return out;
  }

  private uploadF(img: FImage): Tex {
    const buf = new Float32Array(img.r.length * 4);
    for (let i = 0, j = 0; i < img.r.length; i++, j += 4) { buf[j] = img.r[i]; buf[j + 1] = img.g[i]; buf[j + 2] = img.b[i]; buf[j + 3] = 1; }
    return this.upload(img.width, img.height, 'f32', buf);
  }

  // ---- passes ----

  private pass(name: string, w: number, h: number, fmt: Fmt, uniforms: Record<string, Uniform>): Tex {
    const target = this.tex(w, h, fmt);
    this.draw(name, w, h, uniforms, target);
    return target;
  }

  /** Runs a shader over a w×h target: a texture, or the canvas when `target` is null. */
  private draw(name: string, w: number, h: number, uniforms: Record<string, Uniform>, target: Tex | null) {
    const gl = this.gl;
    const { prog, uniforms: info } = this.programs.get(name)!;
    gl.useProgram(prog);
    let unit = 0;
    for (const [k, v] of Object.entries(uniforms)) {
      const u = info.get(k);
      if (!u) continue; // optimized out
      if (typeof v === 'object' && !Array.isArray(v)) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, v.t);
        gl.uniform1i(u.loc, unit++);
      } else if (u.type === gl.FLOAT) gl.uniform1f(u.loc, v as number);
      else if (u.type === gl.INT || u.type === gl.BOOL) gl.uniform1i(u.loc, Number(v));
      else if (u.type === gl.UNSIGNED_INT) gl.uniform1ui(u.loc, v as number);
      else if (u.type === gl.FLOAT_VEC2) gl.uniform2fv(u.loc, v as number[]);
      else if (u.type === gl.FLOAT_VEC3) gl.uniform3fv(u.loc, v as number[]);
      else if (u.type === gl.INT_VEC2) gl.uniform2iv(u.loc, v as number[]);
    }
    if (target) this.bindTarget(target);
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Unbind inputs so a texture is never sampled while it is also the render target of a later pass.
    for (let i = 0; i < unit; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, null); }
  }

  private down(src: Tex, f: number, bright?: { lo: number; hi: number }, fmt: Fmt = 'f16'): Tex {
    return this.pass('down', Math.max(1, Math.ceil(src.w / f)), Math.max(1, Math.ceil(src.h / f)), fmt, {
      uSrc: src, uF: f, uSize: [src.w, src.h], uBrightPass: !!bright, uLo: bright?.lo ?? 0, uHi: bright?.hi ?? 0,
    });
  }

  /**
   * Same algorithm as pixels.ts blur (downsample, three box passes, bilinear back up), always into a new
   * full-size texture, faded toward `mixColor` by `mixK` on the way out. `fmt` is also the working precision.
   */
  private blur(src: Tex, sigma: number, mixK = 1, mixColor = [0, 0, 0], fmt: Fmt = 'f16'): Tex {
    const work: Fmt = fmt === 'f32' ? 'f32' : 'f16';
    let cur = src;
    const step = (next: Tex) => { if (cur !== src) this.release(cur); cur = next; };
    if (sigma > 0.3) {
      const f = Math.max(1, Math.floor(sigma / 3));
      if (f > 1) step(this.down(src, f, undefined, work));
      const s = sigma / f;
      const size = [cur.w, cur.h];
      if (s > 0.3 && s < 0.9) {
        const k = (s * s) / 2;
        step(this.pass('tap', cur.w, cur.h, work, { uSrc: cur, uK: k, uDir: [1, 0], uSize: size }));
        step(this.pass('tap', cur.w, cur.h, work, { uSrc: cur, uK: k, uDir: [0, 1], uSize: size }));
      } else if (s >= 0.9) {
        const r = Math.max(1, Math.round((Math.sqrt(4 * s * s + 1) - 1) / 2));
        for (let i = 0; i < 3; i++) {
          step(this.pass('box', cur.w, cur.h, work, { uSrc: cur, uR: r, uDir: [1, 0], uSize: size }));
          step(this.pass('box', cur.w, cur.h, work, { uSrc: cur, uR: r, uDir: [0, 1], uSize: size }));
        }
      }
    }
    const out = this.pass('resize', src.w, src.h, fmt, { uSrc: cur, uSize: [cur.w, cur.h], uDst: [src.w, src.h], uMixK: mixK, uMixColor: mixColor });
    if (cur !== src) this.release(cur);
    return out;
  }

  private background(adj: Tex, p: Params, bgBlur: number, s: number): Tex {
    return this.blur(adj, bgBlur * s, p.bgOpacity, hexToRgb(p.bgColor));
  }

  private source(src: Source, key: string | undefined): Tex {
    const k = key && `${key}|${src.width}x${src.height}`;
    if (k && this.srcCache?.key === k) { this.live.add(this.srcCache.tex); return this.srcCache.tex; }
    if (this.srcCache) {
      const old = this.srcCache.tex;
      this.srcCache = null;
      this.live.add(old);
      this.release(old);
    }
    const tex = 'image' in src ? this.uploadImage(src) : this.upload(src.width, src.height, 'u8', src.data);
    if (k) this.srcCache = { key: k, tex };
    return tex;
  }

  render(src: Source, p: Params, opts: RenderOptions): RenderResult {
    return this.guarded(src, () => {
      const { tex, text } = this.run(src, p, opts, false);
      const gl = this.gl;
      this.bindTarget(tex!);
      const data = new Uint8ClampedArray(src.width * src.height * 4);
      gl.readPixels(0, 0, src.width, src.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return { width: src.width, height: src.height, data, text };
    });
  }

  /** Like render, but draws the result into the canvas and hands it over as an ImageBitmap, with no read-back. */
  renderBitmap(src: Source, p: Params, opts: RenderOptions): BitmapResult {
    return this.guarded(src, () => {
      const { text } = this.run(src, p, opts, true);
      return { width: src.width, height: src.height, bitmap: this.canvas.transferToImageBitmap(), text };
    });
  }

  private guarded<T>(src: Source, body: () => T): T {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) throw new GpuFailure('WebGL context lost');
    const { width: w, height: h } = src;
    if (w > this.maxSize || h > this.maxSize) throw new Error(`image exceeds the GPU texture limit of ${this.maxSize}px`);
    this.usedKeys.clear();
    for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++);
    try {
      const r = body();
      // WebGL reports out-of-memory and resets through error flags rather than exceptions, and then reads back zeros.
      const err = gl.getError();
      if (gl.isContextLost() || err !== gl.NO_ERROR) {
        (r as { bitmap?: ImageBitmap }).bitmap?.close();
        throw new GpuFailure(`WebGL error 0x${err.toString(16)}`);
      }
      return r;
    } finally {
      this.release(...this.live);
      // Drop pooled textures of sizes this render didn't use, so a size change doesn't pin old memory.
      for (const [key, list] of this.free) {
        if (this.usedKeys.has(key)) continue;
        for (const t of list) this.gl.deleteTexture(t.t);
        this.free.delete(key);
      }
    }
  }

  /** Renders into a texture (returned) or, with `toCanvas`, into the canvas (resized to fit). */
  private run(src: Source, p: Params, opts: RenderOptions, toCanvas: boolean): { tex: Tex | null; text?: string } {
    const { width: w, height: h } = src;
    const s = w / (p.unitWidth > 0 ? p.unitWidth : (opts.targetWidth ?? w));
    const adjU = { uBright: p.brightness, uContrast: p.contrast, uSat: p.saturation, uInvG: 1 / p.gamma, uInvert: p.invert };
    const srcTex = this.source(src, opts.sourceKey);
    // Error diffusion amplifies tiny input differences, so the dither path keeps full float precision.
    const adj = this.pass('adjust', w, h, p.style === 'dither' ? 'f32' : 'f16', { uSrc: srcTex, ...adjU });

    let out: Tex;
    let glowSrc: Tex | null = null;
    let text: string | undefined;
    if (p.style === 'photo') {
      out = this.background(adj, p, p.bgBlur, s);
    } else if (p.style === 'dither') {
      const px = Math.max(1, p.pixelSize * s);
      const gw = Math.max(1, Math.round(w / px)), gh = Math.max(1, Math.round(h / px));
      const pre = px > 1.5 ? this.blur(adj, px * 0.45, 1, [0, 0, 0], 'f32') : adj;
      const smallTex = this.pass('resize', gw, gh, 'f32', { uSrc: pre, uSize: [w, h], uDst: [gw, gh], uMixK: 1, uMixColor: [0, 0, 0] });
      if (pre !== adj) this.release(pre);
      const d = dither(this.readF(smallTex), p.ditherAlgo, p.palette, p.ditherLevels, p.ditherSpread, p.seed);
      this.release(smallTex);
      const dTex = this.uploadF(d);
      out = this.pass('nearest', w, h, 'f16', { uSrc: dTex, uSize: [gw, gh], uDst: [w, h] });
      this.release(dTex);
    } else {
      const grid = cellGrid(w, h, p, s);
      const { cw, ch, cols, rows } = grid;
      const starts = new Float32Array((Math.max(cols, rows) + 1) * 4);
      for (const [n, size, step, off] of [[cols, w, cw, 0], [rows, h, ch, 1]]) {
        let c = 0;
        for (let x = 0; x < size; x++) {
          const cell = Math.min(n - 1, Math.floor(x / step));
          while (c <= cell) starts[c++ * 4 + off] = x;
        }
        while (c <= n) starts[c++ * 4 + off] = size;
      }
      const startsTex = this.upload(starts.length / 4, 1, 'f32', starts);
      const cellsTex = this.pass('cells', cols, rows, 'f32', { uSrc: srcTex, uStarts: startsTex, ...adjU });
      this.release(startsTex);
      const cells = this.readF(cellsTex);
      this.release(cellsTex);
      const minPx = w / (opts.targetWidth ?? w);
      const layer = glyphPlan(cells, grid, p, s, opts.createCanvas, minPx, w, h, opts.mask);
      text = layer.text;
      let glyph = this.glyphs(layer, grid, w, h);
      if (p.glyphBlur > 0) { const b = this.blur(glyph, p.glyphBlur * s); this.release(glyph); glyph = b; }

      const bg = this.background(adj, p, p.bgBlur, s);
      const halo = p.coverage !== 'full' && (p.haloTone !== 0 || p.haloBlur > 0);
      let spread: Tex | null = null, soft: Tex | null = null;
      if (halo) {
        const c = createF(cols, rows);
        c.r.set(layer.cover);
        spread = this.uploadF(blur(c, p.haloRadius));
        if (p.haloBlur > 0) soft = this.background(adj, p, p.bgBlur + p.haloBlur, s);
      }
      out = this.pass('compose', w, h, 'f16', {
        uBg: bg, uSoft: soft ?? bg, uSpread: spread ?? bg, uGlyph: glyph, uHalo: halo, uSoftOn: !!soft, uHaloTone: p.haloTone,
        uBgColor: hexToRgb(p.bgColor), uSpreadSize: [cols, rows], uGridPx: [Math.round(cols * cw), Math.round(rows * ch)],
      });
      this.release(bg, soft, spread);
      glowSrc = glyph;
    }
    this.release(adj);

    if (p.blur > 0) { const b = this.blur(out, p.blur * s); this.release(out); out = b; }

    let comb: Tex | null = null;
    if (p.bloom > 0) {
      const f = w > 64 && h > 64 ? 2 : 1;
      const small = this.down(glowSrc ?? out, f, { lo: p.bloomThreshold - 0.1, hi: p.bloomThreshold + 0.15 });
      const tight = this.blur(small, (p.bloomRadius * s * 0.4) / f);
      const wide = this.blur(small, (p.bloomRadius * s * 1.6) / f);
      comb = this.pass('bloom', small.w, small.h, 'f16', { uTight: tight, uWide: wide, uStrength: p.bloom });
      this.release(small, tight, wide);
    }
    this.release(glowSrc);

    const finU: Record<string, Uniform> = {
      uImg: out, uComb: comb ?? out, uBloom: !!comb, uSize: [w, h], uCombSize: comb ? [comb.w, comb.h] : [w, h],
      uChrom: p.chromatic * s, uScan: p.scanlines, uScanSp: Math.max(1.5, p.scanlineSpacing * s),
      uVig: p.vignette, uVigSize: p.vignetteSize, uVigX: p.vignetteX, uVigY: p.vignetteY,
      uGrain: p.grain, uSeed: (p.seed * 7919 + 17 + (opts.frame ?? 0) * 104729) >>> 0, uFlip: toCanvas,
    };
    let fin: Tex | null = null;
    if (toCanvas) {
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      this.draw('final', w, h, finU, null);
    } else fin = this.pass('final', w, h, 'u8', finU);
    this.release(out, comb);
    return { tex: fin, text };
  }

  /** Draws the planned glyphs into a full-size layer: premultiplied color in rgb, coverage in a. */
  private glyphs(plan: GlyphPlan, grid: { cw: number; ch: number; cols: number; rows: number }, w: number, h: number): Tex {
    const { cols, rows } = grid;
    const n = cols * rows;
    const slots = new Float32Array(n * 4), colors = new Float32Array(n * 4);
    for (let c = 0, j = 0; c < n; c++, j += 4) {
      slots[j] = plan.slot[c]; slots[j + 1] = plan.x0[c]; slots[j + 2] = plan.y0[c];
    }
    colors.set(plan.color);
    const slotTex = this.upload(cols, rows, 'f32', slots);
    const colorTex = this.upload(cols, rows, 'f32', colors);
    const atlas = plan.masks.length ? this.atlas(plan) : null;
    const out = this.pass('glyphs', w, h, 'f16', {
      uSlot: slotTex, uColor: colorTex, uAtlas: atlas?.tex ?? slotTex, uGrid: [cols, rows], uMask: [plan.mw, plan.mh],
      uAtlasCols: atlas?.cols ?? 1, uCell: [grid.cw, grid.ch],
    });
    this.release(slotTex, colorTex);
    return out;
  }
}
