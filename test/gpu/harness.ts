// Runs browser-side cases one at a time and exposes the results to test/gpu/run.ts.
export interface Case { name: string; run: () => string | void | Promise<string | void> }
export interface Result { name: string; ok: boolean; detail: string; ms: number }

declare global { interface Window { __results?: Result[]; __progress?: number } }

export async function report(cases: Case[]) {
  const results: Result[] = [];
  for (const c of cases) {
    const t0 = performance.now();
    try {
      const detail = (await c.run()) ?? '';
      results.push({ name: c.name, ok: true, detail, ms: performance.now() - t0 });
    } catch (err) {
      results.push({ name: c.name, ok: false, detail: err instanceof Error ? err.message : String(err), ms: performance.now() - t0 });
    }
    window.__progress = results.length / cases.length;
  }
  window.__results = results;
}
