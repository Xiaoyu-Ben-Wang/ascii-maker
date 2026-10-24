// Regenerates the editor screenshots in docs/: node scripts/screenshots.ts
// Needs Playwright's Chromium once: pnpm exec playwright-core install chromium-headless-shell
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { createServer } from 'vite';

const OUT = 'docs';
mkdirSync(OUT, { recursive: true });

const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const url = server.resolvedUrls!.local[0];

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Waits until the preview has rendered with the current settings. */
async function rendered(page: Page) {
  await page.waitForFunction(() => /\d+ ms · (GPU|CPU)/.test(document.querySelector('main')?.textContent ?? ''));
  await page.waitForTimeout(800);
}

const shot = (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) =>
  page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 88, clip });

try {
  const page = await open();
  await page.getByRole('button', { name: /jellyfish in the soft-ascii preset/ }).click();
  await rendered(page);
  await shot(page, 'editor');

  await page.keyboard.press('Backslash');
  await page.waitForTimeout(400);
  await shot(page, 'compare');
  await page.keyboard.press('Backslash');

  const box = (await page.locator('main canvas').first().boundingBox())!;

  // Paint glyphs onto the dark water with the mask brush.
  await page.keyboard.press('m');
  for (let i = 0; i < 3; i++) await page.keyboard.press('BracketRight');
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  await page.mouse.move(...at(0.08, 0.86));
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) await page.mouse.move(...at(0.08 + 0.55 * (i / 40), 0.86 - 0.12 * Math.sin((i / 40) * Math.PI)));
  await page.mouse.up();
  await page.mouse.move(...at(0.7, 0.75));
  await page.waitForTimeout(2500);
  await shot(page, 'mask');
  await page.close();

  const grid = await open();
  await grid.getByRole('button', { name: 'Samples' }).click();
  await grid.waitForFunction(() => (document.querySelector('main')?.textContent?.match(/·\s*\d+ms/g) ?? []).length >= 4, null, { timeout: 120_000 });
  await grid.waitForTimeout(800);
  await shot(grid, 'grid', { x: 0, y: 0, width: 1120, height: 320 });
  await grid.close();
} finally {
  await browser.close();
  await server.close();
}
