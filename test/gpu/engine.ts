// Browser-side GPU checks, run by test/gpu/run.ts. Each case renders on the GPU and checks it against the CPU
// renderer or against another GPU path that must give identical pixels.
import { CHARSETS, DEFAULTS, PRESETS, STYLES, render, resolveParams, type HighlightMask, type Params } from '../../src/engine/index.ts';
import { GpuRenderer, gpuOrCpu, type ImageInput } from '../../src/engine/gpu/index.ts';
import type { RGBAImage } from '../../src/engine/pixels.ts';
import { report, type Case } from './harness.ts';

const createCanvas = (w: number, h: number) => new OffscreenCanvas(w, h);

const photo = new Image();
photo.src = '/public/examples/clouds.jpg';
await photo.decode();

/** The example photo at w×h, or a synthetic pattern with hard edges, gradients and noise. */
function image(w: number, h: number, kind: 'photo' | 'pattern' = 'photo'): ImageData {
  const c = new OffscreenCanvas(w, h).getContext('2d')!;
  if (kind === 'photo') c.drawImage(photo, 0, 0, w, h);
  else {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#000'); g.addColorStop(0.5, '#f0a'); g.addColorStop(1, '#fff');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = '#fff'; c.fillRect(w * 0.1, h * 0.1, w * 0.3, h * 0.3);
    c.fillStyle = '#000'; c.beginPath(); c.arc(w * 0.7, h * 0.6, Math.min(w, h) * 0.25, 0, 7); c.fill();
  }
  const img = c.getImageData(0, 0, w, h);
  if (kind === 'pattern') {
    let s = 7;
    for (let i = 0; i < img.data.length; i += 4) { s = (s * 1103515245 + 12345) >>> 0; img.data[i + 1] = Math.min(255, img.data[i + 1] + (s >>> 28)); }
  }
  return img;
}

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  if (a.length !== b.length) return { max: 999, over: 1, mean: 999 };
  let max = 0, over = 0, sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
    if (d > 2) over++;
  }
  return { max, over: over / a.length, mean: sum / a.length };
}
const fmt = (d: ReturnType<typeof diff>) => `max ${d.max}, >2 levels on ${(d.over * 100).toFixed(3)}%, mean ${d.mean.toFixed(3)}`;

const pixelsOf = (b: ImageBitmap) => {
  const c = new OffscreenCanvas(b.width, b.height).getContext('2d')!;
  c.drawImage(b, 0, 0);
  return c.getImageData(0, 0, b.width, b.height).data;
};

const gpu = GpuRenderer.create();
if (!gpu) throw new Error('WebGL2 with float render targets is not available');
const cases: Case[] = [];
const test = (name: string, run: () => string | void | Promise<string | void>) => cases.push({ name, run });

/**
 * GPU vs CPU. Grain is off unless asked for: the two use different noise generators. The tolerance allows for
 * half-float intermediates (a level here and there), not for misplaced or missing glyphs.
 */
function matchesCpu(name: string, src: RGBAImage, params: Partial<Params>, opts: { targetWidth?: number; mask?: HighlightMask; tol?: number; anyMax?: boolean } = {}) {
  test(`GPU matches CPU: ${name}`, () => {
    const p = resolveParams(params, { grain: 0 });
    const o = { createCanvas, targetWidth: opts.targetWidth, mask: opts.mask };
    const c = render(src, p, o);
    const g = gpu!.render(src, p, o);
    if (g.width !== c.width || g.height !== c.height) throw new Error(`size ${g.width}x${g.height} vs ${c.width}x${c.height}`);
    const gt = g.text ?? '', ct = c.text ?? '';
    let textDiff = 0;
    for (let i = 0; i < Math.max(gt.length, ct.length); i++) if (gt[i] !== ct[i]) textDiff++;
    if (textDiff) throw new Error(`ASCII text differs in ${textDiff} of ${ct.length} characters; pixels ${fmt(diff(g.data, c.data))}`);
    const d = diff(g.data, c.data);
    if (d.over > (opts.tol ?? 0.0005) || (!opts.anyMax && d.max > 40)) throw new Error(fmt(d));
    return fmt(d);
  });
}

// ---- GPU vs CPU over the parameter space ----

const base = image(640, 400);
const pattern = image(640, 400, 'pattern');
const glyphStyles = STYLES.filter((s) => s !== 'dither' && s !== 'photo');

for (const name of Object.keys(PRESETS)) {
  const p = PRESETS[name].params;
  // Error diffusion amplifies sub-level differences into different dither patterns, so it's checked loosely.
  const diffusion = p.style === 'dither' && !String(p.ditherAlgo).startsWith('bayer');
  matchesCpu(`preset ${name}`, base, p, diffusion ? { tol: 0.2, anyMax: true } : {});
}
for (const style of glyphStyles)
  for (const coverage of ['highlights', 'full'] as const)
    for (const [img, label] of [[base, 'photo'], [pattern, 'pattern']] as const)
      matchesCpu(`${style}, ${coverage}, ${label}`, img, { style, coverage, bgOpacity: coverage === 'full' ? 0 : 0.85 });
for (const style of glyphStyles) {
  matchesCpu(`${style}, smallest cells`, base, { style, cellSize: 4 });
  matchesCpu(`${style}, largest cells`, base, { style, cellSize: 64 });
  matchesCpu(`${style}, thin strokes, fixed size`, base, { style, strokeWidth: 0.02, sizeByBrightness: false });
  matchesCpu(`${style}, thick strokes`, base, { style, strokeWidth: 0.4, cellSize: 24 });
  matchesCpu(`${style}, mono, half opacity, soft glyphs`, base, { style, colorMode: 'mono', monoColor: '#33ff66', glyphOpacity: 0.5, glyphBlur: 2 });
  matchesCpu(`${style}, real pixels (unit width 0)`, base, { style, unitWidth: 0 });
  matchesCpu(`${style}, preview scale`, base, { style }, { targetWidth: 3840 });
}
for (const mode of ['edge', 'forward', 'backward', 'mixed'] as const) matchesCpu(`diagonal ${mode}`, pattern, { style: 'diagonal', diagonalMode: mode });
for (const [name, set] of Object.entries(CHARSETS)) matchesCpu(`charset ${name}`, base, { style: 'characters', coverage: 'full', charset: set.chars, bgOpacity: 0 });
matchesCpu('custom charset with emoji and CJK', base, { style: 'characters', coverage: 'full', charset: ' ·漢字🙂█', bgOpacity: 0 });
matchesCpu('large serif font', base, { style: 'characters', font: 'Georgia, serif', cellSize: 30 });
for (const mode of ['relative', 'local'] as const) matchesCpu(`highlight mode ${mode}`, base, { highlightMode: mode, threshold: 0.6 });
matchesCpu('threshold 1 (no glyphs)', base, { threshold: 1 });
for (const mode of ['absolute', 'relative', 'local'] as const)
  for (const style of glyphStyles) matchesCpu(`threshold band ${mode}, ${style}`, base, { style, highlightMode: mode, threshold: 0.1, thresholdHigh: 0.6, thresholdSoftness: 0.3 });
matchesCpu('preset ascii-surround on a pattern', pattern, PRESETS['ascii-surround'].params);
matchesCpu('threshold band with ends crossed', base, { threshold: 0.7, thresholdHigh: 0.3 });
matchesCpu('threshold 0, no fade', base, { threshold: 0, thresholdSoftness: 0 });
matchesCpu('halo dim + blur, wide spread', base, { haloTone: -0.8, haloBlur: 20, haloRadius: 8, bgBlur: 0 });
matchesCpu('colored background, opacity 0', base, { coverage: 'full', bgOpacity: 0, bgColor: '#f4ecd8' });
matchesCpu('halo glow', base, { haloTone: 0.7, haloRadius: 2 });
matchesCpu('halo glow + blur, colored background', base, { haloTone: 0.4, haloBlur: 10, bgColor: '#f4ecd8' });
for (const style of glyphStyles) matchesCpu(`halo glow, ${style}`, pattern, { style, haloTone: 1, haloRadius: 1.5 });
matchesCpu('colored background with halo', base, { bgColor: '#203040', haloTone: -1, haloRadius: 3 });
matchesCpu('adjustments at extremes', base, { brightness: 0.5, contrast: 2.5, saturation: 0, gamma: 2.5, invert: true });
matchesCpu('all post effects', base, { bloom: 1.5, bloomRadius: 30, scanlines: 0.8, vignette: 1, vignetteX: 0.2, vignetteY: 0.8, chromatic: 6, blur: 3 });
for (const algo of ['bayer2', 'bayer8', 'halftone', 'lines-diag', 'none'] as const) matchesCpu(`dither ${algo}`, base, { style: 'dither', ditherAlgo: algo, palette: 'pico8' });

// Overlapping glyphs: thick strokes and big glyphs reach into neighbouring cells, whose colors alternate, so drawing
// them in a different order than the CPU would show up as wrong colors where they overlap.
const checker = (() => {
  const img = new ImageData(480, 320);
  for (let y = 0; y < 320; y++)
    for (let x = 0; x < 480; x++) {
      const odd = (Math.floor(x / 12) + Math.floor(y / 12)) % 2, i = (y * 480 + x) * 4;
      img.data[i] = odd ? 255 : 20; img.data[i + 1] = odd ? 40 : 230; img.data[i + 2] = odd ? 60 : 255; img.data[i + 3] = 255;
    }
  return img;
})();
const overlap: Partial<Params> = { coverage: 'full', bgOpacity: 0, unitWidth: 0, cellSize: 12, sizeByBrightness: false, glyphOpacity: 0.7, glyphTint: 0, glyphBoost: 1, bloom: 0, vignette: 0 };
for (const style of ['cross', 'diagonal', 'lines', 'dots'] as const) {
  test(`overlapping glyphs keep their drawing order: ${style}`, () => {
    const p = resolveParams(overlap, { style, strokeWidth: 0.4, diagonalMode: 'mixed', grain: 0 });
    const d = diff(gpu.render(checker, p, { createCanvas }).data, render(checker, p, { createCanvas }).data);
    if (d.max > 2) throw new Error(fmt(d));
    return fmt(d);
  });
}
test('overlapping glyphs keep their drawing order: characters', () => {
  const p = resolveParams(overlap, { style: 'characters', charset: '█@W', font: 'Georgia, serif', cellSize: 20, grain: 0 });
  const d = diff(gpu.render(checker, p, { createCanvas }).data, render(checker, p, { createCanvas }).data);
  if (d.max > 2) throw new Error(fmt(d));
  return fmt(d);
});

// Odd and tiny sizes: partial edge cells, stamps overhanging every edge, 1-pixel images.
for (const [w, h] of [[1, 1], [2, 3], [3, 500], [500, 3], [17, 13], [1001, 667]])
  for (const style of ['characters', 'cross', 'dots'] as const)
    matchesCpu(`${w}x${h} ${style}`, image(w, h, 'pattern'), { style, cellSize: 8 });
matchesCpu('1920x1080 soft-ascii', image(1920, 1080), PRESETS['soft-ascii'].params);
matchesCpu('1920x1080 full-ascii', image(1920, 1080), PRESETS['full-ascii'].params);

// Painted mask: forced glyphs on the left, none on the right, and a crop-mapped region.
const mask: HighlightMask = { width: 64, height: 40, data: new Uint8Array(64 * 40).fill(128) };
for (let y = 0; y < 40; y++) for (let x = 0; x < 64; x++) mask.data[y * 64 + x] = x < 20 ? 255 : x > 44 ? 0 : 128;
for (const style of glyphStyles) matchesCpu(`painted mask, ${style}`, base, { style }, { mask });
matchesCpu('painted mask with crop region', base, {}, { mask: { ...mask, region: { x: 10, y: 5, w: 30, h: 20 } } });

// ---- GPU paths that must agree exactly ----

test('bitmap output equals read-back output, across size changes', () => {
  const sizes = [[640, 400], [320, 200], [641, 401], [5, 5], [1280, 800], [640, 400]];
  for (const [i, [w, h]] of sizes.entries()) {
    const src = i % 2 ? image(w, h, 'pattern') : image(w, h);
    for (const name of ['soft-ascii', 'full-cross', 'gameboy-dither', 'scanlines']) {
      const p = resolveParams(PRESETS[name].params);
      const data = gpu.render(src, p, { createCanvas }).data;
      const b = gpu.renderBitmap(src, p, { createCanvas });
      if (b.bitmap.width !== w || b.bitmap.height !== h) throw new Error(`bitmap is ${b.bitmap.width}x${b.bitmap.height}, expected ${w}x${h}`);
      const d = diff(pixelsOf(b.bitmap), data);
      b.bitmap.close();
      if (d.max > 0) throw new Error(`${w}x${h} ${name}: ${fmt(d)}`);
    }
  }
});

test('image inputs (canvas, ImageBitmap, VideoFrame) equal pixel input', async () => {
  const src = image(640, 400);
  const canvas = new OffscreenCanvas(640, 400);
  canvas.getContext('2d')!.putImageData(src, 0, 0);
  const bitmap = await createImageBitmap(canvas);
  const frame = new VideoFrame(canvas, { timestamp: 0 });
  const p = resolveParams(PRESETS['soft-ascii'].params, { grain: 0.1 });
  const want = gpu.render(src, p, { createCanvas }).data;
  for (const [name, image] of [['canvas', canvas], ['ImageBitmap', bitmap], ['VideoFrame', frame]] as const) {
    const input: ImageInput = { width: 640, height: 400, image, read: () => src };
    const d = diff(gpu.render(input, p, { createCanvas }).data, want);
    // VideoFrame goes through a YUV-capable upload path; allow the odd rounding difference there.
    if (name === 'VideoFrame' ? d.over > 0.001 : d.max > 0) throw new Error(`${name}: ${fmt(d)}`);
  }
  frame.close();
  bitmap.close();
});

test('glyph atlas cache: switching charsets and back gives identical pixels', () => {
  const src = image(640, 400);
  const p = (charset: string) => resolveParams({ coverage: 'full', bgOpacity: 0, charset });
  const first = gpu.render(src, p(CHARSETS.standard.chars), { createCanvas }).data;
  // More distinct atlases than the cache holds, so the first one is evicted and rebuilt.
  for (const set of Object.values(CHARSETS)) gpu.render(src, p(set.chars), { createCanvas });
  for (let i = 0; i < 10; i++) gpu.render(src, p(`${CHARSETS.detailed.chars.slice(0, 10 + i)}`), { createCanvas });
  const again = gpu.render(src, p(CHARSETS.standard.chars), { createCanvas }).data;
  const d = diff(again, first);
  if (d.max > 0) throw new Error(fmt(d));
});

test('cached source and fresh source give identical pixels', () => {
  const a = image(640, 400), b = image(640, 400, 'pattern');
  const p = resolveParams(PRESETS['soft-ascii'].params);
  const fresh = gpu.render(b, p, { createCanvas }).data;
  gpu.render(a, p, { createCanvas, sourceKey: 'a' });
  gpu.render(a, p, { createCanvas, sourceKey: 'a' });
  const viaKey = gpu.render(b, p, { createCanvas, sourceKey: 'b' }).data;
  const d = diff(viaKey, fresh);
  if (d.max > 0) throw new Error(fmt(d));
});

test('repeated renders are deterministic and do not grow GPU memory', () => {
  const src = image(640, 400);
  const p = resolveParams(PRESETS['soft-ascii'].params, { glyphBlur: 1, haloBlur: 5 });
  const first = gpu.render(src, p, { createCanvas }).data;
  const count = () => [...(gpu as unknown as { free: Map<string, unknown[]> }).free.values()].reduce((n, l) => n + l.length, 0);
  const before = count();
  for (let i = 0; i < 20; i++) {
    const r = gpu.renderBitmap(src, p, { createCanvas });
    r.bitmap.close();
    const d = diff(gpu.render(src, p, { createCanvas }).data, first);
    if (d.max > 0) throw new Error(`render ${i}: ${fmt(d)}`);
  }
  if (count() !== before) throw new Error(`pooled textures grew from ${before} to ${count()}`);
  return `${before} pooled textures, steady`;
});

test('grain animates per frame on the GPU, at the same strength as the CPU', () => {
  const src = image(320, 200);
  const p = resolveParams({ style: 'photo', bgBlur: 0, bgOpacity: 1, grain: 0.2 });
  const plain = resolveParams(p, { grain: 0 });
  const g0 = gpu.render(src, p, { createCanvas, frame: 0 }).data, g1 = gpu.render(src, p, { createCanvas, frame: 1 }).data;
  if (diff(g0, g1).mean < 1) throw new Error('grain does not change between frames');
  const gpuNoise = diff(g0, gpu.render(src, plain, { createCanvas }).data).mean;
  const cpuNoise = diff(render(src, p, { createCanvas }).data, render(src, plain, { createCanvas }).data).mean;
  if (Math.abs(gpuNoise - cpuNoise) > cpuNoise * 0.2) throw new Error(`GPU grain ${gpuNoise.toFixed(2)} vs CPU ${cpuNoise.toFixed(2)}`);
  return `mean grain GPU ${gpuNoise.toFixed(2)}, CPU ${cpuNoise.toFixed(2)}`;
});

test('oversized images fall back to the CPU', () => {
  const max = (gpu as unknown as { maxSize: number }).maxSize;
  const src = { width: max + 1, height: 1, data: new Uint8ClampedArray((max + 1) * 4).fill(200) };
  const r = gpuOrCpu().data(src, resolveParams({ cellSize: 4 }), { createCanvas }, true);
  if (r.gpu) throw new Error('rendered on the GPU past its texture limit');
  if (r.r.width !== max + 1) throw new Error('wrong size');
});

test('a lost GPU context falls back to the CPU and stays there', () => {
  const lost = GpuRenderer.create()!;
  const original = GpuRenderer.create;
  GpuRenderer.create = () => lost;
  try {
    const any = gpuOrCpu();
    const src = image(320, 200);
    const p = resolveParams({ grain: 0 });
    if (!any.data(src, p, { createCanvas }, true).gpu) throw new Error('did not start on the GPU');
    (lost as unknown as { gl: WebGL2RenderingContext }).gl.getExtension('WEBGL_lose_context')!.loseContext();
    const r = any.bitmap(src, p, { createCanvas }, true);
    if (r.gpu) throw new Error('still on the GPU after context loss');
    const d = diff(pixelsOf(r.r.bitmap), render(src, p, { createCanvas }).data);
    if (d.max > 0) throw new Error(`CPU fallback differs from CPU render: ${fmt(d)}`);
    if (any.data(src, p, { createCanvas }, true).gpu) throw new Error('went back to the lost GPU');
  } finally {
    GpuRenderer.create = original;
  }
});

test('GPU off renders on the CPU', () => {
  const src = image(320, 200);
  const p = resolveParams(DEFAULTS);
  const r = gpuOrCpu().bitmap(src, p, { createCanvas }, false);
  if (r.gpu) throw new Error('used the GPU while disabled');
  const d = diff(pixelsOf(r.r.bitmap), render(src, p, { createCanvas }).data);
  if (d.max > 0) throw new Error(fmt(d));
});

await report(cases);
