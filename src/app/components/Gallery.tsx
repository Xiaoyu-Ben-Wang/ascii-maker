import { Film, Plus, X } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { frameFor, type Params, type SizeName } from '../../engine/index.ts';
import type { Img } from '../hooks/useImages.ts';
import type { Renderer } from '../lib/renderer.ts';
import { formatTime } from '../lib/video.ts';
import { cx } from './ui.tsx';

const THUMB_W = 720;

const Card = memo(function Card({ img, params, size, renderer, gen, active, onOpen, onRemove }: {
  img: Img; params: Params; size: SizeName; renderer: Renderer | null; gen: number; active: boolean; onOpen: () => void; onRemove: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [cssWidth, setCssWidth] = useState(0);
  const frame = frameFor(img.width, img.height, size);
  /** What is drawn, so scrolling back into view doesn't re-render an unchanged card. */
  const drawn = useRef<{ params: Params; size: SizeName; width: number; gen: number; bitmap: ImageBitmap } | null>(null);

  // Only render cards on (or near) screen, at the size they are shown.
  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '300px' });
    const ro = new ResizeObserver(([e]) => setCssWidth(Math.ceil(e.contentRect.width / 64) * 64));
    io.observe(el);
    ro.observe(el);
    return () => { io.disconnect(); ro.disconnect(); };
  }, []);

  useEffect(() => {
    if (!renderer || !visible || !cssWidth) return;
    let cancelled = false;
    const frame = frameFor(img.width, img.height, size);
    const width = Math.min(THUMB_W, frame.width, Math.round(cssWidth * Math.min(2, devicePixelRatio)));
    const d = drawn.current;
    if (d && d.params === params && d.size === size && d.width === width && d.gen === gen && d.bitmap === img.bitmap) return;
    const height = Math.max(1, Math.round((width * frame.height) / frame.width));
    const t = setTimeout(() => {
      renderer.thumb({ sourceId: img.id, width, height, crop: frame.crop, targetWidth: frame.width, params }).then((r) => {
        if (!r) return;
        if (cancelled || !ref.current) { r.bitmap.close(); return; }
        ref.current.getContext('bitmaprenderer')!.transferFromImageBitmap(r.bitmap);
        drawn.current = { params, size, width, gen, bitmap: img.bitmap };
        setMs(r.ms);
      });
    }, 100);
    return () => { cancelled = true; clearTimeout(t); };
  }, [renderer, img, params, size, visible, cssWidth, gen]);

  return (
    <div className={cx('group relative overflow-hidden rounded-xl border bg-surface transition-colors duration-150', active ? 'border-accent/50' : 'border-line hover:border-line-strong')}>
      <button onClick={onOpen} className="press block w-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label={`Open ${img.name}`}>
        <canvas ref={ref} className="block w-full bg-ink" style={{ aspectRatio: `${frame.width} / ${frame.height}` }} />
      </button>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg">
          {img.video && <Film className="size-3.5 shrink-0 text-muted" aria-label="Video" />}
          <span className="truncate">{img.name}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-faint tabular-nums">{img.video && `${formatTime(img.video.info.duration)} · `}{frame.width}×{frame.height}{ms !== null && ` · ${Math.round(ms)}ms`}</span>
      </div>
      <button
        onClick={onRemove}
        aria-label={`Remove ${img.name}`}
        className="press glass absolute top-2 right-2 flex size-6 items-center justify-center rounded-md border border-line text-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
});

export function Gallery({ images, activeId, params, size, renderer, gen, onOpen, onRemove, onAdd }: {
  images: Img[]; activeId: number | null; params: Params; size: SizeName; renderer: Renderer | null; gen: number;
  onOpen: (id: number) => void; onRemove: (id: number) => void; onAdd: () => void;
}) {
  return (
    <div className="stage-grid absolute inset-0 overflow-y-auto px-4 pt-16 pb-16 md:px-6">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-start gap-4">
        {images.map((img) => (
          <Card key={img.id} img={img} params={params} size={size} renderer={renderer} gen={gen} active={img.id === activeId}
            onOpen={() => onOpen(img.id)} onRemove={() => onRemove(img.id)} />
        ))}
        <button onClick={onAdd} className="press flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong text-muted outline-none hover:border-accent/50 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40">
          <Plus className="size-5" />
        </button>
      </div>
    </div>
  );
}

const SourceThumb = memo(function SourceThumb({ bitmap }: { bitmap: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const h = 96;
    c.height = h;
    c.width = Math.max(1, Math.round((bitmap.width * h) / bitmap.height));
    c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height);
  }, [bitmap]);
  return <canvas ref={ref} className="block h-12 w-auto" />;
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
            <SourceThumb bitmap={img.bitmap} />
            {img.video && <Film className="absolute bottom-1 left-1 size-3 text-white drop-shadow" aria-hidden />}
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
