// Regenerates public/examples/ (README + homepage gallery): node scripts/examples.ts [--photo path/to/photo.jpg]
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PRESETS, render, resolveParams } from '../src/engine/index.ts';
import { SCENES } from '../src/samples/scenes.ts';

const OUT = 'public/examples';
const { values } = parseArgs({ options: { photo: { type: 'string' } } });
mkdirSync(OUT, { recursive: true });

const PLAN: Record<string, string[]> = {
  jellyfish: ['soft-ascii', 'cross', 'diagonal', 'dither-scanline'],
  planet: ['cross', 'soft-ascii'],
  clouds: ['diagonal', 'dots', 'ascii-surround'],
  orbs: ['gameboy-dither', 'matrix'],
};

type Canvas = ReturnType<typeof createCanvas>;
const encode = (c: Canvas, q = 86) => c.encode('jpeg', q);

function fitCanvas(img: { width: number; height: number }, longEdge: number) {
  const k = Math.min(1, longEdge / Math.max(img.width, img.height));
  return createCanvas(Math.round(img.width * k), Math.round(img.height * k));
}

async function source(name: string): Promise<Canvas | null> {
  if (name === 'jellyfish') {
    const path = values.photo ?? `${OUT}/jellyfish.jpg`;
    if (!existsSync(path)) { console.warn(`skipping jellyfish: pass --photo`); return null; }
    const img = await loadImage(readFileSync(path));
    const c = fitCanvas(img, 1920);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const c = createCanvas(1920, 1080);
  SCENES[name as keyof typeof SCENES](c.getContext('2d') as never, 1920, 1080);
  return c;
}

const manifest: { source: string; preset: string; file: string; thumb: string; description: string }[] = [];
for (const [name, presets] of Object.entries(PLAN)) {
  const src = await source(name);
  if (!src) continue;
  writeFileSync(`${OUT}/${name}.jpg`, await encode(src, 88));
  const data = src.getContext('2d').getImageData(0, 0, src.width, src.height);
  for (const preset of presets) {
    const t0 = performance.now();
    const r = render(data, resolveParams(PRESETS[preset].params), { createCanvas: (w, h) => createCanvas(w, h) });
    const full = createCanvas(r.width, r.height);
    full.getContext('2d').putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
    const big = fitCanvas(full, 1600);
    big.getContext('2d').drawImage(full, 0, 0, big.width, big.height);
    const small = fitCanvas(full, 640);
    small.getContext('2d').drawImage(full, 0, 0, small.width, small.height);
    const file = `${name}-${preset}.jpg`, thumb = `${name}-${preset}-thumb.webp`;
    writeFileSync(`${OUT}/${file}`, await encode(big));
    writeFileSync(`${OUT}/${thumb}`, await small.encode('webp', 80));
    manifest.push({ source: name, preset, file, thumb, description: PRESETS[preset].description });
    console.log(`${file}  ${Math.round(performance.now() - t0)}ms`);
  }
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
