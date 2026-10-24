import type { Frame } from '../../engine/index.ts';
import type { Img } from '../hooks/useImages.ts';
import type { Preview } from '../hooks/usePreview.ts';
import { Scrubber } from './Scrubber.tsx';
import { cx } from './ui.tsx';

const Divider = ({ className }: { className?: string }) => <span className={cx('h-3 w-px shrink-0 bg-line', className)} />;

export function StatusBar({ image, frame, preview, time, onScrub }: {
  image: Img; frame: Frame; preview: Preview | null; time: number; onScrub: (t: number) => void;
}) {
  const { video } = image;
  return (
    <div className={cx('glass absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-line px-3 py-1 font-mono text-[11px] text-muted tabular-nums',
      video && 'w-[min(720px,calc(100%-1.5rem))]')}>
      <span className="max-w-40 shrink-0 truncate text-fg max-sm:max-w-24">{image.name}</span>
      <Divider />
      {video && (
        <>
          <Scrubber time={time} duration={video.info.duration} fps={video.info.fps} onChange={onScrub} />
          <Divider className="max-sm:hidden" />
        </>
      )}
      <span className={cx('shrink-0', video && 'max-sm:hidden')}>{frame.width} × {frame.height}</span>
      {preview && (
        <>
          <Divider className="max-sm:hidden" />
          <span className="shrink-0 max-sm:hidden">{Math.round(preview.ms)} ms · {preview.gpu ? 'GPU' : 'CPU'}</span>
        </>
      )}
    </div>
  );
}
