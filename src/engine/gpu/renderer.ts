import { dither } from '../dither.ts';
import { BLOOM, bloomBand, bloomFactor, grainSeed, grainSize, scanlineSpacing } from '../effects.ts';
import { GRAIN, grainClumpScale, grainWeights } from '../grain.ts';
import { blurCells, cellGrid, glyphPlan, type CellGrid, type GlyphPlan } from '../glyphs.ts';
import type { Params } from '../params.ts';
import { createF, hexToRgb, type FImage, type RGBAImage } from '../pixels.ts';
import { ditherGrid, hasHalo, minStroke, unitScale, type RenderOptions, type RenderResult } from '../render.ts';
import { HEAD, SHADERS, VERTEX, type ShaderName } from './shaders.ts';

/** The GPU itself failed (context lost, out of memory, driver error), as opposed to one render not fitting. */
export class GpuFailure extends Error {}

/** A source the GPU can upload directly (canvas, bitmap, video frame); `read` returns its pixels for the CPU. */
export interface ImageInput { width: number; height: number; image: TexImageSource; read: () => RGBAImage }
export type Source = RGBAImage | ImageInput;
/** A render handed over as an ImageBitmap. */
export interface BitmapResult { width: number; height: number; bitmap: ImageBitmap; text?: string }

/**
 * render() on WebGL2: the full-resolution pixel passes run as shaders, while glyph planning and dithering stay on
 * the CPU. Matches the CPU renderer within a level or so.
 */
type Fmt = 'u8' | 'f16' | 'f32';
interface Tex { t: WebGLTexture; w: number; h: number; fmt: Fmt; key: string }
type Uniform = number | boolean | number[] | Tex;
interface Program { prog: WebGLProgram; uniforms: Map<string, { loc: WebGLUniformLocation; type: number }> }
const NONE = [0, 0, 0];

export class GpuRenderer {
  private gl: WebGL2RenderingContext;
  private programs = new Map<ShaderName, Program>();
  private fbo: WebGLFramebuffer;
  private free = new Map<string, Tex[]>();
  private live = new Set<Tex>();
  private usedKeys = new Set<string>();
  private srcCache: { key: string; tex: Tex } | null = null;
  /** Glyph mask atlases by their mask list, most recently used last; kept outside the texture pool. */
  private atlases = new Map<string, { tex: Tex; cols: number }>();
  private canvas: OffscreenCanvas;
  private lost = false;
  private maxSize: number;

  /** Null where WebGL2 with float render targets isn't available. */
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
    const vs = this.shader(gl.VERTEX_SHADER, VERTEX);
    for (const [name, src] of Object.entries(SHADERS) as [ShaderName, string][]) {
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

  private shader(type: number, src: string) {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
    return sh;
  }

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

  private pass(name: ShaderName, w: number, h: number, fmt: Fmt, uniforms: Record<string, Uniform>): Tex {
    const target = this.tex(w, h, fmt);
    this.draw(name, w, h, uniforms, target);
    return target;
  }

  /** Runs a shader over a w×h target: a texture, or the canvas when `target` is null. */
  private draw(name: ShaderName, w: number, h: number, uniforms: Record<string, Uniform>, target: Tex | null) {
    const gl = this.gl;
    const { prog, uniforms: info } = this.programs.get(name)!;
    gl.useProgram(prog);
    let unit = 0;
    for (const [k, v] of Object.entries(uniforms)) {
      const u = info.get(k);
      if (!u) continue;
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
   * pixels.ts blur (downsample, three box passes, bilinear back up) into a new full-size texture, faded toward
   * `mixColor` by `mixK` on the way out. `fmt` is also the working precision.
   */
  private blur(src: Tex, sigma: number, mixK = 1, mixColor = NONE, fmt: Fmt = 'f16'): Tex {
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

  /** Like render, but draws into the canvas and hands that over as an ImageBitmap, with no read-back. */
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
      // WebGL reports out-of-memory and resets through error flags, not exceptions, and then reads back zeros.
      const err = gl.getError();
      if (gl.isContextLost() || err !== gl.NO_ERROR) {
        (r as { bitmap?: ImageBitmap }).bitmap?.close();
        throw new GpuFailure(`WebGL error 0x${err.toString(16)}`);
      }
      return r;
    } finally {
      this.release(...this.live);
      // Pooled textures of sizes this render didn't use are dropped, so a size change doesn't pin old memory.
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
    const s = unitScale(w, p, opts.targetWidth);
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
      const { px, gw, gh } = ditherGrid(w, h, p, s);
      const pre = px > 1.5 ? this.blur(adj, px * 0.45, 1, NONE, 'f32') : adj;
      const smallTex = this.pass('resize', gw, gh, 'f32', { uSrc: pre, uSize: [w, h], uDst: [gw, gh], uMixK: 1, uMixColor: NONE });
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
      const layer = glyphPlan(cells, grid, p, s, opts.createCanvas, minStroke(w, opts.targetWidth), w, h, opts.mask);
      text = layer.text;
      let glyph = this.glyphs(layer, grid, w, h);
      if (p.glyphBlur > 0) { const b = this.blur(glyph, p.glyphBlur * s); this.release(glyph); glyph = b; }

      const bg = this.background(adj, p, p.bgBlur, s);
      const halo = hasHalo(p);
      let spread: Tex | null = null, soft: Tex | null = null;
      if (halo) {
        spread = this.uploadF({ ...createF(cols, rows), r: blurCells(layer.cover, cols, rows, p.haloRadius) });
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
      const f = bloomFactor(w, h);
      const small = this.down(glowSrc ?? out, f, bloomBand(p));
      const tight = this.blur(small, (p.bloomRadius * s * BLOOM.tight) / f);
      const wide = this.blur(small, (p.bloomRadius * s * BLOOM.wide) / f);
      comb = this.pass('bloom', small.w, small.h, 'f16', { uTight: tight, uWide: wide, uStrength: p.bloom });
      this.release(small, tight, wide);
    }
    this.release(glowSrc);

    const finU: Record<string, Uniform> = {
      uImg: out, uComb: comb ?? out, uBloom: !!comb, uSize: [w, h], uCombSize: comb ? [comb.w, comb.h] : [w, h],
      uChrom: p.chromatic * s, uScan: p.scanlines, uScanSp: scanlineSpacing(p, s),
      uVig: p.vignette, uVigSize: p.vignetteSize, uVigX: p.vignetteX, uVigY: p.vignetteY,
      uGrain: p.grain * GRAIN.gain, uGrainSz: grainSize(p, s), uGrainRough: p.grainRoughness,
      uGrainW: grainWeights(p.grainRoughness), uGrainClump: grainClumpScale(p.grainRoughness),
      uSeed: grainSeed(p, opts.frame ?? 0), uFlip: toCanvas,
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

  /** The planned glyphs as a full-size layer: premultiplied color in rgb, coverage in a. */
  private glyphs(plan: GlyphPlan, grid: CellGrid, w: number, h: number): Tex {
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
