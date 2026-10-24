// Editor tests: drives the app in headless Chromium against the Vite dev server. Run with `pnpm test:app`;
// needs Playwright's Chromium (`pnpm exec playwright-core install chromium` once).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const example = (name: string) => join(root, 'public/examples', `${name}.jpg`);
let server: ViteDevServer;
let browser: Browser;
let url: string;
const tmp = mkdtempSync(join(tmpdir(), 'ascii-app-'));

before(async () => {
  server = await createServer({ root, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => {
  await browser?.close();
  await server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A fresh browser profile (empty library) with the app open. */
async function app(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  (page as Page & { errors: string[] }).errors = errors;
  await page.goto(url);
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).waitFor();
  return page;
}

const errorsOf = (page: Page) => (page as Page & { errors: string[] }).errors;

async function importFiles(page: Page, files: string[]) {
  await page.locator('input[type=file]').setInputFiles(files);
  await page.waitForFunction((n) => document.querySelector('[aria-label=Mode] button')?.textContent?.endsWith(String(n)), files.length);
}

/** The library as stored in IndexedDB. */
function readDb(page: Page) {
  return page.evaluate(() => new Promise<{ rows: { key: string; name: string; kind: string; style?: string; painted: boolean; thumbStale?: boolean }[]; blobs: string[] }>((resolve) => {
    const req = indexedDB.open('ascii-maker');
    req.onsuccess = () => {
      const tx = req.result.transaction(['creations', 'blobs']);
      const out = { rows: [] as never[], blobs: [] as string[] };
      tx.objectStore('creations').getAll().onsuccess = (e) => {
        out.rows = (e.target as IDBRequest).result.map((m: { key: string; name: string; kind: string; painted: boolean; thumbStale?: boolean; look: { params: { style?: string } } }) =>
          ({ key: m.key, name: m.name, kind: m.kind, style: m.look.params.style, painted: m.painted, thumbStale: m.thumbStale })) as never[];
      };
      tx.objectStore('blobs').getAllKeys().onsuccess = (e) => { out.blobs = (e.target as IDBRequest).result as string[]; };
      tx.oncomplete = () => resolve(out);
    };
  }));
}

const activeMode = (page: Page) => page.locator('[aria-label=Mode] [aria-pressed=true]').textContent();
const settle = (page: Page, ms = 700) => page.waitForTimeout(ms);

test('creations, their own looks and masks survive a reload', async () => {
  const files = [example('planet'), example('orbs')];
  let video = false;
  try {
    const v = join(tmp, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v]);
    files.push(v);
    video = true;
  } catch { /* no ffmpeg: images only */ }
  const page = await app();
  await importFiles(page, files);

  await page.keyboard.press('g');
  await page.getByRole('button', { name: 'Select orbs' }).dblclick();
  await page.keyboard.press('d');
  await page.getByRole('radio', { name: /cross/i }).click();
  await page.keyboard.press('k');
  const stage = page.locator('main canvas').nth(1);
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 10 });
  await page.mouse.up();
  await settle(page, 2000);

  await page.reload();
  await page.getByRole('button', { name: 'Select orbs' }).waitFor();
  assert.equal(await activeMode(page), `Library${files.length}`);
  const db = await readDb(page);
  const by = (n: string) => db.rows.find((r) => r.name === n)!;
  assert.equal(db.rows.length, files.length);
  assert.equal(by('orbs').style, 'cross');
  assert.equal(by('orbs').painted, true);
  assert.ok(db.blobs.includes(`${by('orbs').key}:mask`));
  assert.notEqual(by('planet').style, 'cross');
  for (const r of db.rows) assert.ok(db.blobs.includes(`${r.key}:source`) && db.blobs.includes(`${r.key}:thumb`), `${r.name} blobs`);
  if (video) assert.equal(by('clip').kind, 'video');
  assert.deepEqual(errorsOf(page), []);
});

test('settings copy and paste onto a selection, and undo per creation', async () => {
  const page = await app();
  await importFiles(page, [example('jellyfish'), example('planet'), example('clouds')]);
  await page.getByRole('radio', { name: /cross/i }).click();
  await settle(page);
  await page.keyboard.press('Control+Shift+C');
  await page.keyboard.press('g');
  await page.getByRole('button', { name: 'Select planet' }).click();
  await page.getByRole('button', { name: 'Select jellyfish' }).click({ modifiers: ['Control'] });
  await page.keyboard.press('Control+Shift+V');
  await settle(page);
  const db = await readDb(page);
  assert.deepEqual(db.rows.map((r) => r.style).sort(), ['cross', 'cross', 'cross']);

  // Jellyfish was active, so its history has the paste; undoing it restores its own look.
  await page.keyboard.press('d');
  await page.keyboard.press('Control+z');
  await settle(page);
  const after = await readDb(page);
  assert.notEqual(after.rows.find((r) => r.name === 'jellyfish')!.style, 'cross');
  assert.equal(after.rows.find((r) => r.name === 'planet')!.style, 'cross');

  // Planet was not open during the paste, but still gets an undo step for it.
  await page.getByRole('button', { name: 'planet', exact: true }).click();
  await settle(page);
  await page.keyboard.press('Control+z');
  await settle(page);
  assert.notEqual((await readDb(page)).rows.find((r) => r.name === 'planet')!.style, 'cross');

  // Every pasted creation's thumbnail re-renders, opened or not.
  await page.waitForFunction(() => new Promise((resolve) => {
    const req = indexedDB.open('ascii-maker');
    req.onsuccess = () => {
      req.result.transaction('creations').objectStore('creations').getAll().onsuccess = (e) =>
        resolve((e.target as IDBRequest).result.every((m: { thumbStale?: boolean }) => !m.thumbStale));
    };
  }), null, { timeout: 15000 });
});

test('mode keys, panels, cheat sheet and moved keys', async () => {
  const page = await app();
  await importFiles(page, [example('planet')]);
  for (const [key, mode] of [['g', 'Library1'], ['e', 'Loupe'], ['d', 'Develop']] as const) {
    await page.keyboard.press(key);
    assert.equal(await activeMode(page), mode);
  }
  await page.keyboard.press('Shift+W');
  await page.getByRole('toolbar', { name: 'Mask brush' }).waitFor();
  await page.keyboard.press('e');
  assert.equal(await activeMode(page), 'Develop', 'E does not leave Develop while masking');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Tab');
  assert.equal(await page.locator('aside').count(), 0, 'Tab hides the panel');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('aside').count(), 1);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('[aria-label=Mode]').count(), 0, 'Shift+Tab hides everything');
  await page.keyboard.press('Shift+Tab');

  await page.keyboard.press('Control+/');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);

  await page.keyboard.press('b');
  await page.getByRole('status').filter({ hasText: 'Before view moved' }).waitFor();
  assert.deepEqual(errorsOf(page), []);
});

test('Loupe renders the export frame and zooms to actual pixels', async () => {
  const page = await app();
  await importFiles(page, [example('planet')]);
  await page.keyboard.press('e');
  const result = page.locator('main canvas').nth(1);
  // The status bar reports the finished render and its size, the export frame.
  await page.locator('main').getByText(/ms · (GPU|CPU)/).waitFor();
  await page.locator('main').getByText('1920 × 1080').waitFor();
  await page.keyboard.press('z');
  await page.getByRole('button', { name: 'Zoom to fit' }).filter({ hasText: '100%' }).waitFor();
  assert.equal(await result.evaluate((c) => getComputedStyle(c).imageRendering), 'pixelated');
  await page.keyboard.press('z');
  await page.getByRole('button', { name: 'Zoom to 100%' }).filter({ hasText: 'Fit' }).waitFor();
});

test('Delete removes a creation and its stored blobs', async () => {
  const page = await app();
  await importFiles(page, [example('planet'), example('orbs')]);
  await page.keyboard.press('g');
  await page.getByRole('button', { name: 'Select planet' }).click();
  const key = (await readDb(page)).rows.find((r) => r.name === 'planet')!.key;
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Select planet' }).waitFor({ state: 'detached' });
  await settle(page, 300);
  const db = await readDb(page);
  assert.deepEqual(db.rows.map((r) => r.name), ['orbs']);
  assert.ok(!db.blobs.some((b) => b.startsWith(key)));
});
