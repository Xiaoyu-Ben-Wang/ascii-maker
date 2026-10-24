import { Film, Plus, X } from 'lucide-react';
import { memo, useEffect, useRef } from 'react';
import { frameFor, type SizeName } from '../../engine/index.ts';
import type { Img } from '../hooks/useCatalog.ts';
import { formatTime } from '../lib/video.ts';
import { cx } from './ui.tsx';

export interface SelectMods { toggle: boolean; range: boolean }

const Card = memo(function Card({ img, size, active, selected, onSelect, onOpen, onRemove }: {
  img: Img; size: SizeName; active: boolean; selected: boolean;
  onSelect: (id: number, mods: SelectMods) => void; onOpen: (id: number) => void; onRemove: (id: number) => void;
}) {
  const frame = frameFor(img.width, img.height, size);

  return (
    <div className={cx('group relative overflow-hidden rounded-xl border bg-surface transition-colors duration-150',
      selected ? 'border-accent ring-2 ring-accent/40' : active ? 'border-accent/50' : 'border-line hover:border-line-strong')}>
      <button aria-pressed={selected} aria-label={`Select ${img.name}`} title="Double-click to view"
        onClick={(e) => onSelect(img.id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })} onDoubleClick={() => onOpen(img.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onOpen(img.id); } }}
        className="press block w-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        {img.thumb
          ? <img src={img.thumb} alt="" className="block w-full bg-ink object-cover" style={{ aspectRatio: `${frame.width} / ${frame.height}` }} />
          : <div className="block w-full animate-pulse bg-ink" style={{ aspectRatio: `${frame.width} / ${frame.height}` }} />}
      </button>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg">
          {img.kind === 'video' && <Film className="size-3.5 shrink-0 text-muted" aria-label="Video" />}
          <span className="truncate">{img.name}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-faint tabular-nums">{img.video && `${formatTime(img.video.info.duration)} · `}{frame.width}×{frame.height}</span>
      </div>
      <button
        onClick={() => onRemove(img.id)}
        aria-label={`Remove ${img.name}`}
        className="press glass absolute top-2 right-2 flex size-6 items-center justify-center rounded-md border border-line text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
});

export function Gallery({ images, activeId, selected, size, onSelect, onOpen, onRemove, onAdd }: {
  images: Img[]; activeId: number | null; selected: ReadonlySet<number>; size: SizeName;
  onSelect: (id: number, mods: SelectMods) => void; onOpen: (id: number) => void; onRemove: (id: number) => void; onAdd: () => void;
}) {
  return (
    <div className="stage-grid absolute inset-0 overflow-y-auto px-4 pt-16 pb-16 md:px-6">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-start gap-4">
        {images.map((img) => (
          <Card key={img.id} img={img} size={size} active={img.id === activeId} selected={selected.has(img.id)}
            onSelect={onSelect} onOpen={onOpen} onRemove={onRemove} />
        ))}
        <button onClick={onAdd} className="press flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong text-muted outline-none hover:border-accent/50 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40">
          <Plus className="size-5" />
        </button>
      </div>
    </div>
  );
}

const Thumb = memo(function Thumb({ img }: { img: Img }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bitmap = img.thumb ? null : img.bitmap;
  useEffect(() => {
    const c = ref.current;
    if (!c || !bitmap) return;
    const h = 96;
    c.height = h;
    c.width = Math.max(1, Math.round((bitmap.width * h) / bitmap.height));
    c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height);
  }, [bitmap]);
  if (img.thumb) return <img src={img.thumb} alt="" className="block h-12 w-auto" />;
  return <canvas ref={ref} className="block h-12 w-12 bg-ink" />;
});

export function Filmstrip({ images, activeId, onSelect, onRemove, onAdd }: {
  images: Img[]; activeId: number | null; onSelect: (id: number) => void; onRemove: (id: number) => void; onAdd: () => void;
}) {
  return (
    <div className="glass absolute bottom-12 left-1/2 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-xl border border-line p-1.5 shadow-lg">
      {images.map((img) => (
        <div key={img.id} className="group relative shrink-0">
          <button
            onClick={() => onSelect(img.id)}
            aria-label={img.name}
            title={img.name}
            className={cx('press relative block overflow-hidden rounded-md outline-none ring-2 ring-offset-0 transition-[box-shadow,opacity] duration-150 focus-visible:ring-accent/60',
              img.id === activeId ? 'ring-accent' : 'opacity-60 ring-transparent hover:opacity-100')}
          >
            <Thumb img={img} />
            {img.kind === 'video' && <Film className="absolute bottom-1 left-1 size-3 text-white drop-shadow" aria-hidden />}
          </button>
          <button
            onClick={() => onRemove(img.id)}
            aria-label={`Remove ${img.name}`}
            className="press glass absolute top-1 right-1 flex size-5 items-center justify-center rounded border border-line text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <button onClick={onAdd} aria-label="Add images" className="press flex h-12 w-10 shrink-0 items-center justify-center rounded-md border border-dashed border-line-strong text-muted hover:text-fg">
        <Plus className="size-4" />
      </button>
    </div>
  );
}
