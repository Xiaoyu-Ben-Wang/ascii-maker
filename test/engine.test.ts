import { createCanvas } from '@napi-rs/canvas';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bayerMatrix, dither, PALETTES } from '../src/engine/dither.ts';
import { DITHER_ALGOS, PRESETS, RenderCache, STYLES, render, resolveParams } from '../src/engine/index.ts';
import { createF, hexToRgb } from '../src/engine/pixels.ts';

const factory = (w: number, h: number) => createCanvas(w, h);

function gradient(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      data[p] = (x / w) * 255; data[p + 1] = (y / h) * 255; data[p + 2] = 128; data[p + 3] = 255;
    }
  return { width: w, height: h, data };
}

test('bayer 4x4 matches the standard matrix', () => {
  assert.deepEqual(bayerMatrix(4), [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
  assert.deepEqual([...bayerMatrix(16)].sort((a, b) => a - b), [...Array(256).keys()]);
});

test('every dither algorithm outputs only palette colors and preserves mid-gray on average', () => {
  const img = createF(64, 64);
  img.r.fill(0.5); img.g.fill(0.5); img.b.fill(0.5);
  const mono = PALETTES.mono.map(hexToRgb);
  for (const algo of DITHER_ALGOS) {
    const out = dither(img, algo, 'mono', 2, 1);
    for (let i = 0; i < out.r.length; i++) assert.ok(mono.some((c) => c[0] === out.r[i]), `${algo} produced off-palette value`);
    const mean = out.r.reduce((a, b) => a + b, 0) / out.r.length;
    if (algo !== 'none') assert.ok(Math.abs(mean - 0.5) < 0.08, `${algo} mean ${mean}`);
  }
});

test('auto palette picks the requested number of colors from the image', () => {
  const src = gradient(80, 60);
  const p = resolveParams({ style: 'dither', palette: 'auto', ditherLevels: 5, pixelSize: 1, bloom: 0, vignette: 0, grain: 0, scanlines: 0 });
  const r = render(src, p, { createCanvas: factory });
  const colors = new Set<number>();
  for (let i = 0; i < r.data.length; i += 4) colors.add((r.data[i] << 16) | (r.data[i + 1] << 8) | r.data[i + 2]);
  assert.ok(colors.size <= 5 && colors.size >= 3, `got ${colors.size} colors`);
});

test('every style and preset renders deterministically at the source size', () => {
  const src = gradient(120, 80);
  for (const style of STYLES) {
    const p = resolveParams({ style });
    const a = render(src, p, { createCanvas: factory });
    const b = render(src, p, { createCanvas: factory });
    assert.equal(a.width, 120);
    assert.equal(a.data.length, 120 * 80 * 4);
    assert.deepEqual(a.data, b.data, `${style} not deterministic`);
  }
  for (const [name, pr] of Object.entries(PRESETS)) {
    assert.doesNotThrow(() => render(src, resolveParams(pr.params), { createCanvas: factory }), name);
  }
});

test('characters style returns an ASCII grid that is blank below the threshold', () => {
  const src = gradient(200, 100);
  for (let i = 0; i < src.data.length; i += 4) src.data[i + 1] = src.data[i + 2] = src.data[i]; // gray ramp, dark at left
  const r = render(src, resolveParams({ style: 'characters', threshold: 0.5 }), { createCanvas: factory });
  const rows = r.text!.split('\n');
  assert.ok(rows.length > 3);
  assert.ok(rows.every((row) => !/\S/.test(row.slice(0, 3))), 'dark left edge should have no glyphs');
  assert.ok(rows.some((row) => /[#@8S0]/.test(row)), 'bright cells should use dense glyphs');
});

test('preview at a smaller size matches the full render scaled down', () => {
  const big = gradient(400, 200);
  const small = gradient(200, 100);
  const p = resolveParams({ style: 'cross', unitWidth: 0, grain: 0 });
  const full = render(big, p, { createCanvas: factory });
  const prev = render(small, p, { createCanvas: factory, targetWidth: 400 });
  // Same cell count: the preview must not draw twice as many glyphs as the export.
  const lit = (d: Uint8ClampedArray, w: number, y: number) => { let n = 0; for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] > 200) n++; return n / w; };
  assert.ok(Math.abs(lit(full.data, 400, 100) - lit(prev.data, 200, 50)) < 0.15);
});

test('CLI renders a file and reports JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascii-maker-'));
  const input = join(dir, 'in.png');
  const c = createCanvas(64, 48);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 48);
  writeFileSync(input, c.toBuffer('image/png'));
  const out = join(dir, 'out.png');
  const res = execFileSync(process.execPath, ['cli/ascii-maker.ts', input, '-p', 'dither-scanline', '--palette', 'pico8', '-w', '32', '-o', out, '--json'], { encoding: 'utf8' });
  const info = JSON.parse(res);
  assert.equal(info.width, 32);
  assert.equal(info.height, 24);
  assert.equal(info.params.palette, 'pico8');
  assert.equal(readFileSync(out).subarray(1, 4).toString(), 'PNG');
  const cli = (...args: string[]) => execFileSync(process.execPath, ['cli/ascii-maker.ts', input, '--dump-params', ...args], { stdio: 'pipe', encoding: 'utf8' });
  assert.throws(() => cli('--style', 'nope'));
  assert.throws(() => cli('--gamma', '0'));
  assert.throws(() => cli('--diagonal-mode', 'sideways'));
  assert.equal(JSON.parse(cli('--brightness=-0.2')).brightness, -0.2);
  assert.equal(JSON.parse(cli('--palette', 'ff0000,00ff00')).palette, 'ff0000,00ff00');
});

test('cached renders match uncached renders across param changes', () => {
  const src = gradient(160, 100);
  const cache = new RenderCache();
  const steps = [
    { style: 'characters' as const }, { style: 'characters' as const, bgBlur: 20 }, { style: 'characters' as const, threshold: 0.1 },
    { style: 'dither' as const }, { style: 'dither' as const, palette: 'pico8' }, { style: 'cross' as const, contrast: 1.4 },
  ];
  for (const st of steps) {
    const p = resolveParams(st);
    const cached = render(src, p, { createCanvas: factory, cache, sourceKey: 'a' });
    const fresh = render(src, p, { createCanvas: factory });
    assert.deepEqual(cached.data, fresh.data, JSON.stringify(st));
  }
});

test('size presets scale the long edge and keep the aspect ratio', async () => {
  const { frameFor } = await import('../src/engine/framing.ts');
  assert.deepEqual([frameFor(3840, 3072, '1080p').width, frameFor(3840, 3072, '1080p').height], [1920, 1536]);
  assert.deepEqual([frameFor(1000, 2000, '4k').width, frameFor(1000, 2000, '4k').height], [1920, 3840]);
  assert.deepEqual([frameFor(1200, 800, 'source').width, frameFor(1200, 800, 'source').height], [1200, 800]);
  assert.equal(frameFor(1200, 800, '2k').width, 2560);
});

test('zip writer produces an archive standard tools can read', async () => {
  const { zip } = await import('../src/app/zip.ts');
  const { crc32 } = await import('node:zlib');
  const files = [
    { name: 'a.txt', blob: new Blob(['hello ascii']) },
    { name: 'é/b.bin', blob: new Blob([new Uint8Array(70_000).map((_, i) => i * 7)]) },
  ];
  const buf = Buffer.from(await (await zip(files)).arrayBuffer());
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(buf.readUInt16LE(eocd + 10), 2);
  let p = buf.readUInt32LE(eocd + 16);
  for (const f of files) {
    const data = Buffer.from(await f.blob.arrayBuffer());
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    assert.equal(buf.readUInt32LE(p + 16), crc32(data));
    const nameLen = buf.readUInt16LE(p + 28);
    assert.equal(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'), f.name);
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26);
    assert.deepEqual(buf.subarray(start, start + data.length), data);
    p += 46 + nameLen;
  }
  // Cross-check with Python's zipfile when it's available (it is on dev machines and GitHub runners).
  const dir = mkdtempSync(join(tmpdir(), 'ascii-zip-'));
  writeFileSync(join(dir, 't.zip'), buf);
  try {
    const out = execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip(), len(z.namelist()))', join(dir, 't.zip')], { encoding: 'utf8' });
    assert.equal(out.trim(), 'None 2');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
});
