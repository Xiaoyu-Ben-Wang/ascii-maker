#!/usr/bin/env node
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BACKDROPS, CHARSETS, COLOR_MODES, COVERAGES, DEFAULTS, DIAGONAL_MODES, DITHER_ALGOS, HIGHLIGHT_MODES, PALETTE_NAMES, PRESETS, RANGES, SIZE_NAMES, STYLES, frameFor,
  paramFlag as kebab, render, resolveParams, type HighlightMask, type Params, type SizeName,
} from '../src/engine/index.ts';
import { hexToRgb, luma } from '../src/engine/pixels.ts';
import { VIDEO_EXTS, convertVideo } from './video.ts';

const paramKeys = Object.keys(DEFAULTS) as (keyof Params)[];

const HELP = `ascii-maker — algorithmic ASCII / cross / diagonal / dots / dither renderer for images and video

Usage:
  node cli/ascii-maker.ts <input> -o <output.png|jpg|webp> [options]
  node cli/ascii-maker.ts <input...> -o <folder/> [options]      (batch: one output per input)

Options:
  -o, --out <file>        Output image (format from extension; default <input>-ascii.png)
  -p, --preset <name>     Start from a preset (see --list)
  -c, --config <file>     JSON file of params (applied after the preset)
  -s, --size <name>       Output size: source (default), 1080p, 2k, 4k (long edge 1920/2560/3840)
  -w, --width <px>        Resize output to this exact width (keeps aspect ratio)
  -f, --format <ext>      Batch output format: png (default), jpg, webp; for video mp4 (default), webm, gif

Video (input .mp4 .mov .mkv .webm .avi .m4v .gif; needs ffmpeg on PATH or FFMPEG_PATH):
      --fps <n>           Output frame rate (default: the source's)
      --start <sec>       Start time
  -t, --duration <sec>    Length to convert
      --crf <n>           Quality, lower is better (default 18)
      --threads <n>       Render threads (default: CPU cores - 1)
      --no-audio          Drop the audio track
      --text <file>       Also write the plain ASCII grid (characters style)
      --quality <0-100>   JPEG/WebP quality (default 92)
      --mask <image>      Highlight mask, stretched over each input image: white forces glyphs, black keeps
                          them off, mid-gray (128) or transparent leaves the image alone. Glyph styles
                          only; not for video
      --dump-params       Print the resolved params as JSON and exit
      --list              List presets, styles, dither algorithms and palettes
      --json              Print a JSON summary instead of a log line
  -h, --help              Show this help

Every render param is also a flag (kebab-case), e.g.:
${paramKeys.map((k) => `  --${kebab(k)} <${typeof DEFAULTS[k]}>${RANGES[k] ? ` [${RANGES[k]![0]}..${RANGES[k]![1]}]` : ''} (default ${JSON.stringify(DEFAULTS[k])})`).join('\n')}

Examples:
  node cli/ascii-maker.ts photo.jpg -p soft-ascii -o out.png
  node cli/ascii-maker.ts photo.jpg -p dither-scanline --dither-algo atkinson --palette pico8 -o out.png
  node cli/ascii-maker.ts photo.jpg --style cross --cell-size 18 --bloom 0.8 --size 4k -o out.jpg
  node cli/ascii-maker.ts photos/*.jpg -p diagonal --size 1080p -o out/
  node cli/ascii-maker.ts clip.mp4 -p soft-ascii --size 1080p -o clip-ascii.mp4
`;

const options: Record<string, { type: 'string' | 'boolean'; short?: string }> = {
  out: { type: 'string', short: 'o' },
  preset: { type: 'string', short: 'p' },
  config: { type: 'string', short: 'c' },
  width: { type: 'string', short: 'w' },
  size: { type: 'string', short: 's' },
  format: { type: 'string', short: 'f' },
  fps: { type: 'string' },
  start: { type: 'string' },
  duration: { type: 'string', short: 't' },
  crf: { type: 'string' },
  threads: { type: 'string' },
  'no-audio': { type: 'boolean' },
  text: { type: 'string' },
  quality: { type: 'string' },
  mask: { type: 'string' },
  'dump-params': { type: 'boolean' },
  list: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  // Old name: --halo-dim 0.4 is --halo-tone -0.4.
  'halo-dim': { type: 'string' },
};
for (const k of paramKeys) {
  options[kebab(k)] = { type: typeof DEFAULTS[k] === 'boolean' ? 'boolean' : 'string' };
  if (typeof DEFAULTS[k] === 'boolean') options['no-' + kebab(k)] = { type: 'boolean' };
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseFlags(values: Record<string, unknown>): Partial<Params> {
  const out: Record<string, unknown> = {};
  for (const k of paramKeys) {
    const name = kebab(k);
    if (values['no-' + name]) { out[k] = false; continue; }
    const v = values[name];
    if (v === undefined) continue;
    const def = DEFAULTS[k];
    if (typeof def === 'boolean') out[k] = v;
    else if (typeof def === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) fail(`--${name} expects a number, got "${v}"`);
      out[k] = n;
    } else out[k] = v;
  }
  if (values['halo-dim'] !== undefined && values['halo-tone'] === undefined) {
    const n = Number(values['halo-dim']);
    if (!Number.isFinite(n)) fail(`--halo-dim expects a number, got "${values['halo-dim']}"`);
    out.haloTone = -n;
  }
  return out as Partial<Params>;
}

function validate(p: Params) {
  for (const k of paramKeys) {
    if (typeof p[k] !== typeof DEFAULTS[k]) fail(`${k} must be a ${typeof DEFAULTS[k]}, got ${JSON.stringify(p[k])}`);
    const range = RANGES[k];
    const v = p[k];
    if (range && typeof v === 'number' && (v < range[0] || v > range[1])) fail(`--${kebab(k)} must be between ${range[0]} and ${range[1]}, got ${v}`);
  }
  const oneOf = (name: string, v: string, list: readonly string[]) => {
    if (!list.includes(v)) fail(`unknown ${name} "${v}" (${list.join(', ')})`);
  };
  oneOf('style', p.style, STYLES);
  oneOf('dither algo', p.ditherAlgo, DITHER_ALGOS);
  oneOf('diagonal mode', p.diagonalMode, DIAGONAL_MODES);
  oneOf('color mode', p.colorMode, COLOR_MODES);
  oneOf('coverage', p.coverage, COVERAGES);
  oneOf('backdrop', p.backdrop, BACKDROPS);
  oneOf('highlight mode', p.highlightMode, HIGHLIGHT_MODES);
  if (!PALETTE_NAMES.includes(p.palette)) {
    const hexes = p.palette.split(',').map((h) => h.trim()).filter(Boolean);
    try {
      if (hexes.length < 2) throw new Error();
      hexes.forEach(hexToRgb);
    } catch {
      fail(`unknown palette "${p.palette}" (${PALETTE_NAMES.join(', ')}, or a list like "#000,#fff")`);
    }
  }
  for (const k of ['monoColor', 'bgColor'] as const) {
    try { hexToRgb(p[k]); } catch { fail(`${k} must be a hex color, got "${p[k]}"`); }
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true, strict: true });
  if (values.help) return void console.log(HELP);
  if (values.list) {
    console.log('Presets:');
    for (const [name, pr] of Object.entries(PRESETS)) console.log(`  ${name.padEnd(16)} ${pr.description}`);
    console.log(`\nStyles: ${STYLES.join(', ')}`);
    console.log(`Dither algorithms: ${DITHER_ALGOS.join(', ')}`);
    console.log(`Palettes: ${PALETTE_NAMES.join(', ')} (or a comma-separated hex list)`);
    console.log('\nCharsets (--charset <name> or your own characters, dark to bright):');
    for (const [name, c] of Object.entries(CHARSETS)) console.log(`  ${name.padEnd(10)} ${JSON.stringify(c.chars).padEnd(26)} ${c.description}`);
    return;
  }

  let preset: Partial<Params> | undefined;
  if (values.preset) {
    const pr = PRESETS[values.preset as string];
    if (!pr) fail(`unknown preset "${values.preset}" (${Object.keys(PRESETS).join(', ')})`);
    preset = pr.params;
  }
  const config = values.config ? (JSON.parse(readFileSync(values.config as string, 'utf8')) as Partial<Params>) : undefined;
  const params = resolveParams(preset, config, parseFlags(values));
  if (CHARSETS[params.charset]) params.charset = CHARSETS[params.charset].chars;
  validate(params);
  if (values['dump-params']) return void console.log(JSON.stringify(params, null, 2));

  if (!positionals.length) fail('missing input image (see --help)');
  const size = (values.size as string | undefined) ?? 'source';
  if (!SIZE_NAMES.includes(size as SizeName)) fail(`--size must be one of ${SIZE_NAMES.join(', ')}`);
  if (values.width && values.size) fail('use either --width or --size, not both');
  const many = positionals.length > 1;
  const outArg = values.out as string | undefined;
  // Several inputs (or an -o ending in a slash) write into a folder, keeping each input's name.
  const outDir = many || (outArg && /[\\/]$/.test(outArg)) ? (outArg ?? '.') : null;
  if (outDir) mkdirSync(outDir, { recursive: true });
  if (values.text && many) fail('--text only works with a single input');

  const format = ((values.format as string | undefined) ?? 'png').toLowerCase().replace(/^\./, '');
  if (!['png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'gif'].includes(format)) fail('--format must be png, jpg, webp (images) or mp4, webm, gif (video)');
  const used = new Set<string>();
  const num = (name: string) => {
    const v = values[name];
    if (v === undefined) return undefined;
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) fail(`--${name} must be a non-negative number`);
    return x;
  };
  const mask = typeof values.mask === 'string' ? await loadMask(values.mask) : undefined;
  if (mask && positionals.some((f) => VIDEO_EXTS.includes(extname(f).toLowerCase()))) fail('--mask works with images, not video');
  for (const input of positionals) {
    const video = VIDEO_EXTS.includes(extname(input).toLowerCase());
    const ext = video ? (values.format ? format : 'mp4') : format;
    if (video && !['mp4', 'webm', 'gif'].includes(ext)) fail('video --format must be mp4, webm or gif');
    const stem = basename(input).replace(/\.[^.]+$/, '');
    let out = outDir ? join(outDir, `${stem}-${params.style}.${ext}`) : (outArg ?? input.replace(/\.[^.]+$/, '') + `-ascii.${video ? 'mp4' : 'png'}`);
    // Inputs with the same file name from different folders get -2, -3… instead of overwriting each other.
    for (let n = 2; used.has(out); n++) out = join(outDir ?? '.', `${stem}-${params.style}-${n}.${ext}`);
    used.add(out);
    if (!video) { await renderFile(input, out, size as SizeName, values, params, mask); continue; }
    mkdirSync(dirname(out) || '.', { recursive: true });
    const r = await convertVideo(input, out, params, {
      size: size as SizeName, width: num('width'), fps: num('fps'), start: num('start'), duration: num('duration'),
      crf: num('crf') ?? 18, threads: num('threads'), audio: !values['no-audio'], quiet: !!values.json,
    });
    const secs = (r.ms / 1000).toFixed(1);
    if (values.json) console.log(JSON.stringify({ input, output: out, width: r.width, height: r.height, frames: r.frames, fps: r.fps, ms: Math.round(r.ms), params }));
    else console.log(`${out}  ${r.width}×${r.height}  ${r.frames} frames @ ${+r.fps.toFixed(3)} fps  ${params.style}  ${secs}s (${r.renderFps.toFixed(1)} frames/s)`);
  }
}

/** A mask image as gray levels: its luminance, over mid-gray so transparent areas leave the image alone. */
async function loadMask(path: string): Promise<HighlightMask> {
  if (!existsSync(path)) fail(`mask not found: ${path}`);
  const img = await loadImage(readFileSync(path));
  const ctx = createCanvas(img.width, img.height).getContext('2d');
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, img.width, img.height);
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, img.width, img.height).data;
  const data = new Uint8Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]));
  return { width: img.width, height: img.height, data };
}

async function renderFile(input: string, out: string, size: SizeName, values: Record<string, unknown>, params: Params, mask?: HighlightMask) {
  const t0 = performance.now();
  const image = await loadImage(readFileSync(input));
  let { width: w, height: h } = frameFor(image.width, image.height, size);
  if (values.width) {
    const tw = Number(values.width);
    if (!(tw > 0)) fail('--width must be a positive number');
    h = Math.round((image.height * tw) / image.width);
    w = Math.round(tw);
  }
  const srcCanvas = createCanvas(w, h);
  const sctx = srcCanvas.getContext('2d');
  sctx.drawImage(image, 0, 0, w, h);
  const src = sctx.getImageData(0, 0, w, h);

  const result = render(src, params, { createCanvas: (cw, ch) => createCanvas(cw, ch), mask });

  const outCanvas = createCanvas(w, h);
  outCanvas.getContext('2d').putImageData(new ImageData(result.data, w, h), 0, 0);
  const ext = extname(out).toLowerCase();
  const quality = values.quality ? Number(values.quality) : 92;
  const buf =
    ext === '.jpg' || ext === '.jpeg' ? await outCanvas.encode('jpeg', quality)
    : ext === '.webp' ? await outCanvas.encode('webp', quality)
    : await outCanvas.encode('png');
  mkdirSync(dirname(out) || '.', { recursive: true });
  writeFileSync(out, buf);
  if (values.text && result.text !== undefined) writeFileSync(values.text as string, result.text + '\n');

  const ms = Math.round(performance.now() - t0);
  if (values.json) console.log(JSON.stringify({ input, output: out, width: w, height: h, ms, text: values.text ?? null, params }));
  else console.log(`${out}  ${w}×${h}  ${params.style}${values.preset ? ` (preset ${values.preset})` : ''}  ${ms}ms`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
