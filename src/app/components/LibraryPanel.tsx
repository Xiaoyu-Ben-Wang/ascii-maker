import { useEffect, useState } from 'react';
import type { Img } from '../hooks/useCatalog.ts';
import { Row } from './ui.tsx';

const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.ceil(n / 1e3)} KB`);

/** The Library's side panel: the active creation's details and how much the library stores. */
export function LibraryPanel({ active, count, selected }: { active: Img | null; count: number; selected: number }) {
  const [used, setUsed] = useState<number | null>(null);
  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setUsed(e.usage ?? null), () => {});
  }, [count]);

  return (
    <div className="grid gap-3 p-4 text-[12px]">
      {active ? (
        <div className="grid gap-2">
          <div className="truncate text-[13px] text-fg" title={active.name}>{active.name}</div>
          <Row label="Size"><span className="font-mono text-muted tabular-nums">{active.width} × {active.height}</span></Row>
          <Row label="Type"><span className="text-muted">{active.kind}</span></Row>
          <Row label="Preset"><span className="truncate text-muted">{active.look.preset}</span></Row>
          <Row label="Added"><span className="text-muted">{new Date(active.createdAt).toLocaleDateString()}</span></Row>
        </div>
      ) : (
        <div className="text-muted">Nothing selected</div>
      )}
      <div className="border-t border-line pt-3 text-faint">
        {count} creation{count === 1 ? '' : 's'}{selected > 1 && ` · ${selected} selected`}{used !== null && ` · ${bytes(used)} stored`}
      </div>
    </div>
  );
}
