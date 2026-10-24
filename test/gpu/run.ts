// GPU tests: serves the browser-side checks with Vite and runs them in headless Chromium (WebGL2 through
// SwiftShader, so no GPU is needed). Run with `pnpm test:gpu`; needs Playwright's Chromium
// (`pnpm exec playwright-core install chromium` once).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import type { Result } from './harness.ts';

let server: ViteDevServer;
let browser: Browser;

before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function run(page: string): Promise<Result[]> {
  const p = await browser.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  try {
    await p.goto(new URL(`test/gpu/${page}.html`, server.resolvedUrls!.local[0]).href);
    const deadline = Date.now() + 15 * 60_000;
    while (!(await p.evaluate(() => !!window.__results))) {
      if (errors.length) throw new Error(`${page}: ${errors.join('; ')}`);
      if (Date.now() > deadline) throw new Error(`${page}: timed out`);
      await new Promise((r) => setTimeout(r, 500));
    }
    return (await p.evaluate(() => window.__results))!;
  } finally {
    await p.close();
  }
}

for (const page of process.env.GPU_PAGES?.split(',') ?? ['engine', 'video']) {
  test(page, async (t) => {
    const results = await run(page);
    assert.ok(results.length > 0, 'no cases ran');
    for (const r of results) {
      await t.test(r.name, () => {
        if (r.detail) t.diagnostic(`${r.name}: ${r.detail}`);
        assert.ok(r.ok, r.detail);
      });
    }
  });
}
