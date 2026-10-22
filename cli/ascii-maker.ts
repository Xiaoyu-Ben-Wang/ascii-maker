#!/usr/bin/env node
// CLI for the ascii-maker engine: same renderer as the browser editor, run under Node.
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  COLOR_MODES, DEFAULTS, DIAGONAL_MODES, DITHER_ALGOS, PALETTE_NAMES, PRESETS, RANGES, SIZE_NAMES, STYLES, frameFor, render,
  resolveParams, type Params, type SizeName,
} from '../src/engine/index.ts';
import { hexToRgb } from '../src/engine/pixels.ts';

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const paramKeys = Object.keys(DEFAULTS) as (keyof Params)[];

const HELP = `ascii-maker — algorithmic ASCII / cross / diagonal / dots / dither renderer

Usage:
  node cli/ascii-maker.ts <input> -o <output.png|jpg|webp> [options]
  node cli/ascii-maker.ts <input...> -o <folder/> [options]      (batch: one output per input)

Options:
  -o, --out <file>        Output image (format from extension; default <input>-ascii.png)
  -p, --preset <name>     Start from a preset (see --list)
  -c, --config <file>     JSON file of params (applied after the preset)
  -s, --size <name>       Output size: source (default), 1080p, 2k, 4k (long edge 1920/2560/3840)
  -w, --width <px>        Resize output to this exact width (keeps aspect ratio)
  -f, --format <ext>      Batch output format: png (default), jpg, webp
      --text <file>       Also write the plain ASCII grid (characters style)
      --quality <0-100>   JPEG/WebP quality (default 92)
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
`;

const options: Record<string, { type: 'string' | 'boolean'; short?: string }> = {
  out: { type: 'string', short: 'o' },
  preset: { type: 'string', short: 'p' },
  config: { type: 'string', short: 'c' },
  width: { type: 'string', short: 'w' },
  size: { type: 'string', short: 's' },
  format: { type: 'string', short: 'f' },
  text: { type: 'string' },
  quality: { type: 'string' },
  'dump-params': { type: 'boolean' },
  list: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
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
  return out as Partial<Params>;
}

function validate(p: Params) {
  for (const k of paramKeys) {
    if (!(k in DEFAULTS)) continue;
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
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(format)) fail('--format must be png, jpg or webp');
  const used = new Set<string>();
  for (const input of positionals) {
    const stem = basename(input).replace(/\.[^.]+$/, '');
    let out = outDir ? join(outDir, `${stem}-${params.style}.${format}`) : (outArg ?? input.replace(/\.[^.]+$/, '') + '-ascii.png');
    // Inputs with the same file name from different folders get -2, -3… instead of overwriting each other.
    for (let n = 2; used.has(out); n++) out = join(outDir ?? '.', `${stem}-${params.style}-${n}.${format}`);
    used.add(out);
    await renderFile(input, out, size as SizeName, values, params);
  }
}

async function renderFile(input: string, out: string, size: SizeName, values: Record<string, unknown>, params: Params) {
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

  const result = render(src, params, { createCanvas: (cw, ch) => createCanvas(cw, ch) });

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
