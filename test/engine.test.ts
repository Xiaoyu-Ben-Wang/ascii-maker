import { createCanvas } from '@napi-rs/canvas';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bayerMatrix, dither, PALETTES } from '../src/engine/dither.ts';
import { DITHER_ALGOS, PRESETS, RenderCache, STYLES, render, resolveParams } from '../src/engine/index.ts';
import { createF, hexToRgb } from '../src/engine/pixels.ts';

const factory = (w: number, h: number) => createCanvas(w, h);

const tempDirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

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

test('an upper threshold leaves the brightest cells bare too', () => {
  const src = gradient(400, 60);
  for (let i = 0; i < src.data.length; i += 4) src.data[i + 1] = src.data[i + 2] = src.data[i]; // gray ramp, dark at left
  const charset = ' .:-=+xX0S8#@';
  const band = (lo: number, hi: number, soft = 0) => render(src, resolveParams({ style: 'characters', unitWidth: 0, cellSize: 10, charset, threshold: lo, thresholdHigh: hi, thresholdSoftness: soft }), { createCanvas: factory });
  const row = band(0.3, 0.7).text!.split('\n')[2].padEnd(67);
  const cols = row.length;
  // The ramp is 400px over 67 columns: 30% ≈ column 20, 70% ≈ column 47.
  assert.ok(!/\S/.test(row.slice(0, 18)), 'cells darker than the lower end stay bare');
  assert.ok(!/\S/.test(row.slice(49, cols)), 'cells brighter than the upper end stay bare');
  assert.ok(/^\S+$/.test(row.slice(22, 46)), 'cells inside the band all get glyphs');
  // The whole character set spans the band, so its densest glyphs sit just below the upper end.
  assert.ok(/[#@]/.test(row.slice(40, 48)), `dense glyphs near the upper end: ${row}`);
  // Fade softens both ends instead of cutting them off.
  const soft = band(0.3, 0.7, 0.5).text!.split('\n')[2];
  assert.ok(soft.trimEnd().length > row.trimEnd().length, 'fade-out reaches past the upper end');
  // 1 means no upper end: the same render as before the setting existed.
  assert.deepEqual(render(src, resolveParams({ threshold: 0.3, thresholdHigh: 1 }), { createCanvas: factory }).data,
    render(src, resolveParams({ threshold: 0.3 }), { createCanvas: factory }).data);
});

test('a lower threshold of 0 puts full glyphs on the darkest cells', () => {
  const src = gradient(200, 40);
  for (let i = 0; i < src.data.length; i += 4) src.data[i] = src.data[i + 1] = src.data[i + 2] = 0;
  const p = resolveParams({ style: 'dots', sizeByBrightness: false, unitWidth: 0, cellSize: 10, threshold: 0, thresholdHigh: 0.5, thresholdSoftness: 0.5, colorMode: 'mono', bgOpacity: 0, glyphBlur: 0, bloom: 0, vignette: 0, grain: 0 });
  const r = render(src, p, { createCanvas: factory });
  let lit = 0;
  for (let i = 0; i < r.data.length; i += 4) if (r.data[i] > 128) lit++;
  assert.ok(lit > 0, 'black cells get glyphs when the lower end is 0');
});

test('full coverage ignores both ends of the threshold', () => {
  const src = gradient(200, 60);
  const p = { style: 'characters', coverage: 'full', unitWidth: 0, cellSize: 10, charset: '.:#' } as const;
  assert.equal(render(src, resolveParams(p, { threshold: 0.4, thresholdHigh: 0.5 }), { createCanvas: factory }).text,
    render(src, resolveParams(p), { createCanvas: factory }).text);
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
  const dir = tempDir('ascii-maker-');
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
  assert.equal(JSON.parse(cli('--charset', 'blocks')).charset, ' ░▒▓█');
  assert.equal(JSON.parse(cli('--charset', ' ab')).charset, ' ab');
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
  const dir = tempDir('ascii-zip-');
  writeFileSync(join(dir, 't.zip'), buf);
  try {
    const out = execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip(), len(z.namelist()))', join(dir, 't.zip')], { encoding: 'utf8' });
    assert.equal(out.trim(), 'None 2');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
});

test('CLI converts a video, keeping frame count, size and audio', (t) => {
  const has = (bin: string) => { try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (!has('ffmpeg') || !has('ffprobe')) return t.skip('ffmpeg not installed');
  const dir = tempDir('ascii-video-');
  const input = join(dir, 'in.mp4'), out = join(dir, 'out.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]);
  const res = JSON.parse(execFileSync(process.execPath, ['cli/ascii-maker.ts', input, '-p', 'dither-scanline', '--threads', '2', '-o', out, '--json'], { encoding: 'utf8' }));
  assert.equal(res.frames, 24);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,nb_read_frames', '-of', 'json', out], { encoding: 'utf8' }));
  const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  assert.deepEqual([v.width, v.height, Number(v.nb_read_frames)], [320, 180, 24]);
  assert.ok(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'), 'audio track kept');
});

test('full coverage puts a glyph in every cell, including dark ones', () => {
  const src = gradient(200, 100);
  for (let i = 0; i < src.data.length; i += 4) src.data[i + 1] = src.data[i + 2] = src.data[i];
  const p = resolveParams({ style: 'characters', coverage: 'full', charset: '.:#', threshold: 0.9 });
  const rows = render(src, p, { createCanvas: factory }).text!.split('\n');
  assert.ok(rows.every((row) => row.length > 0 && !/ /.test(row)), 'no blank cells');
  assert.ok(rows[0].startsWith('.') && rows[0].endsWith('#'), 'dark to bright across the ramp');
});

test('relative and local highlight modes keep a bright image mostly bare', () => {
  // Bright, flat background (0.8) with one small brighter spot.
  const w = 240, h = 120;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.hypot(x - 120, y - 60) < 15 ? 255 : 205;
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  const src = { width: w, height: h, data };
  const lit = (extra: object) => {
    const text = render(src, resolveParams({ style: 'characters', unitWidth: 0, cellSize: 8 }, extra), { createCanvas: factory }).text!;
    const cells = text.split('\n').join('').replace(/ /g, '').length;
    return cells;
  };
  const absolute = lit({ highlightMode: 'absolute' });
  const relative = lit({ highlightMode: 'relative', threshold: 0.9 });
  const local = lit({ highlightMode: 'local', localRadius: 40 });
  assert.ok(absolute > 300, `absolute covers the image (${absolute})`);
  assert.ok(relative > 0 && relative < absolute / 4, `relative keeps to the spot (${relative})`);
  assert.ok(local > 0 && local < absolute / 4, `local keeps to the spot (${local})`);
});

test('halo dims and blurs only near glyphs', () => {
  const w = 160, h = 80, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, v = x < 40 ? 255 : 30 + (x % 7) * 8; // bright block on the left, textured gray elsewhere
    data.set([v, v, v, 255], i * 4);
  }
  const base = { style: 'characters', unitWidth: w, cellSize: 8, threshold: 0.6, bgOpacity: 1, bgBlur: 0, bloom: 0, vignette: 0, grain: 0 } as const;
  const at = (r: { data: Uint8ClampedArray }, x: number, y = 40) => r.data[(y * w + x) * 4];
  const plain = render({ width: w, height: h, data }, resolveParams(base), { createCanvas: factory });
  const dim = render({ width: w, height: h, data }, resolveParams({ ...base, haloTone: -0.8 }), { createCanvas: factory });
  const soft = render({ width: w, height: h, data }, resolveParams({ ...base, haloBlur: 6 }), { createCanvas: factory });
  assert.ok(at(dim, 44) < at(plain, 44) - 20, 'dimmed next to the glyphs');
  assert.equal(at(dim, 140), at(plain, 140), 'untouched far from the glyphs');
  assert.notEqual(at(soft, 43), at(plain, 43), 'blurred next to the glyphs');
  assert.deepEqual([at(soft, 139), at(soft, 140), at(soft, 141)], [at(plain, 139), at(plain, 140), at(plain, 141)], 'texture kept far away');
});

test('halo tone above 0 brightens near glyphs into a glow, and only there', () => {
  const w = 160, h = 80, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, v = x < 40 ? 255 : 60;
    data.set([v, v, v, 255], i * 4);
  }
  const base = { style: 'characters', unitWidth: w, cellSize: 8, threshold: 0.6, bgOpacity: 1, bgBlur: 0, bloom: 0, vignette: 0, grain: 0 } as const;
  const at = (r: { data: Uint8ClampedArray }, x: number) => r.data[(40 * w + x) * 4];
  const plain = render({ width: w, height: h, data }, resolveParams(base), { createCanvas: factory });
  const glow = render({ width: w, height: h, data }, resolveParams({ ...base, haloTone: 0.8 }), { createCanvas: factory });
  const dim = render({ width: w, height: h, data }, resolveParams({ ...base, haloTone: -0.8 }), { createCanvas: factory });
  assert.ok(at(glow, 44) > at(plain, 44) + 20, 'brighter next to the glyphs');
  assert.ok(at(dim, 44) < at(plain, 44) - 20, 'darker next to the glyphs');
  assert.equal(at(glow, 140), at(plain, 140), 'untouched far from the glyphs');
});

test('the old haloDim setting still works, as a negative halo tone', () => {
  const p = resolveParams({ haloDim: 0.3 } as never);
  assert.equal(p.haloTone, -0.3);
  assert.ok(!('haloDim' in p));
  assert.equal(resolveParams({ haloDim: 0.3, haloTone: 0.5 } as never).haloTone, 0.5, 'an explicit haloTone wins');
  const out = execFileSync(process.execPath, ['cli/ascii-maker.ts', '--halo-dim', '0.4', '--dump-params'], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).haloTone, -0.4);
});

test('painted mask adds and removes glyphs, mapped through its region', () => {
  const w = 120, h = 40, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = i % w < 60 ? 255 : 40; // bright left half, dark right half
    data.set([v, v, v, 255], i * 4);
  }
  const p = resolveParams({ style: 'characters', unitWidth: w, cellSize: 8, threshold: 0.5, charset: ' .:-=+*#%@' });
  const src = { width: w, height: h, data };
  const lines = (text = '') => text.split('\n');
  const plain = lines(render(src, p, { createCanvas: factory }).text);
  assert.ok(plain[2].trimEnd().length < 15, 'only the bright half has glyphs');
  // Mask twice the image width: left half (the image) says remove, right half says add; region picks one side.
  const mw = 48, mh = 8, md = new Uint8Array(mw * mh);
  for (let i = 0; i < md.length; i++) md[i] = i % mw < 24 ? 0 : 255;
  const removed = lines(render(src, p, { createCanvas: factory, mask: { width: mw, height: mh, data: md, region: { x: 0, y: 0, w: 24, h: 8 } } }).text);
  assert.equal(removed.join('').trim(), '', 'remove clears every glyph');
  const added = lines(render(src, p, { createCanvas: factory, mask: { width: mw, height: mh, data: md, region: { x: 24, y: 0, w: 24, h: 8 } } }).text);
  assert.ok(added[2].length >= 24 && /^[^ ]+$/.test(added[2]), `add fills the dark half too: ${JSON.stringify(added[2])}`);
  const neutral = new Uint8Array(mw * mh).fill(128);
  assert.deepEqual(lines(render(src, p, { createCanvas: factory, mask: { width: mw, height: mh, data: neutral } }).text), plain, 'gray mask changes nothing');
});

test('cli --mask clears glyphs under black and leaves transparent areas alone', () => {
  const dir = tempDir('ascii-mask-');
  const png = (name: string, draw: (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void, w = 96, h = 32) => {
    const c = createCanvas(w, h);
    draw(c.getContext('2d'));
    writeFileSync(join(dir, name), c.toBuffer('image/png'));
    return join(dir, name);
  };
  const input = png('in.png', (ctx) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 96, 32); });
  // Mask at a different size than the input: it is stretched over it.
  // Left half black, right half transparent (which must count as gray, not black).
  const mask = png('mask.png', (ctx) => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 12, 8); }, 24, 8);
  const run = (...extra: string[]) => {
    execFileSync(process.execPath, ['cli/ascii-maker.ts', input, '--style', 'characters', '--unit-width', '96', '--cell-size', '8', '--threshold', '0.3',
      '-o', join(dir, 'out.png'), '--text', join(dir, 'out.txt'), ...extra], { stdio: 'pipe' });
    return readFileSync(join(dir, 'out.txt'), 'utf8').split('\n')[1];
  };
  const plain = run(), masked = run('--mask', mask);
  assert.ok(/^\S{15,}$/.test(plain), plain);
  assert.equal(masked.length, plain.length, 'right half untouched');
  assert.ok(/^ {8,}\S/.test(masked), `left half cleared: ${JSON.stringify(masked)}`);
});
