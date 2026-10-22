// Quick timing of preview-sized renders: node test/bench.ts <image>
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { PRESETS, RenderCache, render, resolveParams } from '../src/engine/index.ts';

const img = await loadImage(readFileSync(process.argv[2]));
const w = 1600, h = Math.round((img.height * w) / img.width);
const c = createCanvas(w, h);
c.getContext('2d').drawImage(img, 0, 0, w, h);
const src = c.getContext('2d').getImageData(0, 0, w, h);
const cache = new RenderCache();
for (const name of Object.keys(PRESETS)) {
  const p = resolveParams(PRESETS[name].params);
  const t0 = performance.now();
  render(src, p, { createCanvas, targetWidth: 3840 });
  const t1 = performance.now();
  render(src, p, { createCanvas, targetWidth: 3840, cache, sourceKey: 's' });
  const t2 = performance.now();
  render(src, { ...p, threshold: p.threshold + 0.01 }, { createCanvas, targetWidth: 3840, cache, sourceKey: 's' });
  const t3 = performance.now();
  console.log(`${name.padEnd(16)} cold ${Math.round(t1 - t0)}ms  warm-change ${Math.round(t3 - t2)}ms`);
}
