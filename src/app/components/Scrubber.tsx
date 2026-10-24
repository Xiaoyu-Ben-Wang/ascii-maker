import { Slider as Sl } from 'radix-ui';
import { formatTime } from '../lib/video.ts';

/** Scrub-only timeline for a video: picks the frame to preview, with no playback. Arrow keys step one frame. */
export function Scrubber({ time, duration, fps, onChange }: { time: number; duration: number; fps: number; onChange: (t: number) => void }) {
  const step = 1 / Math.max(1, fps);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <Sl.Root className="relative flex h-5 min-w-24 flex-1 touch-none items-center select-none" value={[time]} min={0} max={Math.max(step, duration)} step={step}
        onValueChange={([v]) => onChange(v)}>
        <Sl.Track className="relative h-1 grow overflow-hidden rounded-full bg-white/[0.12]">
          <Sl.Range className="absolute h-full rounded-full bg-accent" />
        </Sl.Track>
        <Sl.Thumb aria-label="Video position" className="block size-3.5 rounded-full bg-fg shadow-[0_1px_4px_rgb(0_0_0/0.5)] outline-none transition-[box-shadow,transform] duration-150 focus-visible:ring-4 focus-visible:ring-accent/30 active:scale-110" />
      </Sl.Root>
      <span className="shrink-0 text-fg">{formatTime(time)}<span className="text-faint"> / {formatTime(duration)}</span></span>
    </div>
  );
}
