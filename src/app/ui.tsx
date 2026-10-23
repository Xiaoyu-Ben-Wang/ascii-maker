import { Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { Popover as P, Select as S, Slider as Sl, Switch as Sw, Tooltip as T } from 'radix-ui';
import { memo, useEffect, useState, type ComponentProps, type ReactNode } from 'react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({ variant = 'ghost', size = 'md', className, ...rest }: ComponentProps<'button'> & { variant?: 'ghost' | 'solid' | 'primary'; size?: 'sm' | 'md' | 'icon' }) {
  return (
    <button
      {...rest}
      className={cx(
        'press inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap select-none outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' && 'h-7 px-2.5 text-[12px]',
        size === 'md' && 'h-8 px-3 text-[13px]',
        size === 'icon' && 'size-8',
        variant === 'ghost' && 'text-muted hover:text-fg hover:bg-white/[0.06]',
        variant === 'solid' && 'bg-white/[0.06] text-fg border border-line hover:bg-white/[0.09]',
        variant === 'primary' && 'bg-accent text-accent-ink hover:bg-[#b5fcdc] shadow-[0_0_0_1px_rgb(157_251_208/0.4),0_8px_24px_-8px_rgb(157_251_208/0.45)]',
        className,
      )}
    />
  );
}

export function Tip({ label, children, side = 'bottom' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="pop z-50 rounded-md border border-line bg-raised px-2 py-1 text-[12px] text-fg shadow-xl">
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="ml-1.5 rounded border border-line-strong px-1 font-mono text-[10px] text-muted">{children}</kbd>
);

/** Field label; hovering it explains the field, and it turns accent-colored once the value differs from the preset. */
export function Label({ text, hint, modified, onReset }: { text: string; hint?: string; modified?: boolean; onReset?: () => void }) {
  const label = (
    <span
      onDoubleClick={onReset}
      className={cx('shrink-0 cursor-default text-[12px] select-none', modified ? 'text-fg' : 'text-muted', hint && 'decoration-white/20 decoration-dotted underline-offset-[3px] hover:underline')}
    >
      {text}{modified && <span aria-label="changed" className="ml-1.5 inline-block size-1 translate-y-[-2px] rounded-full bg-accent" />}
    </span>
  );
  return hint ? <Tip side="left" label={<span className="block max-w-56 leading-snug">{hint}</span>}>{label}</Tip> : label;
}

/** Small reset arrow shown once a field differs from the preset. */
function ResetButton({ show, onReset, label }: { show?: boolean; onReset?: () => void; label: string }) {
  return (
    <button
      aria-label={`Reset ${label}`} title="Reset to preset" tabIndex={show ? 0 : -1} onClick={onReset}
      className={cx('grid size-5 place-items-center rounded text-faint transition-opacity duration-150 hover:bg-white/[0.06] hover:text-fg', show && onReset ? 'opacity-100' : 'pointer-events-none opacity-0')}
    >
      <RotateCcw className="size-3" />
    </button>
  );
}

function fmt(v: number, step: number) {
  const d = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toFixed(d);
}

/** Arrow-button jump: one tick on whole-number sliders, otherwise a round value near 1/50 of the range. */
function jumpFor(min: number, max: number, step: number) {
  if (step >= 1) return step;
  const raw = (max - min) / 50;
  const e = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((m) => m * e).reduce((a, b) => (Math.abs(Math.log(b / raw)) < Math.abs(Math.log(a / raw)) ? b : a));
  return Math.max(step, Math.round(nice / step) * step);
}

function StepButton({ dir, label, disabled, onClick }: { dir: -1 | 1; label: string; disabled: boolean; onClick: () => void }) {
  const Icon = dir < 0 ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button" tabIndex={-1} aria-label={`${dir < 0 ? 'Decrease' : 'Increase'} ${label}`} disabled={disabled} onClick={onClick}
      // With a mouse the arrows appear on hover, keeping the panel calm; on touch screens they stay as tap targets.
      className="press grid size-4 shrink-0 place-items-center rounded text-faint transition-opacity duration-150 hover:bg-white/[0.06] hover:text-fg disabled:pointer-events-none disabled:opacity-30 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:disabled:group-hover:opacity-30"
    >
      <Icon className="size-3" />
    </button>
  );
}

/** A slider's value as editable text: typing a number and pressing Enter (or leaving the field) applies it. */
function ValueInput({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) {
      const n = Number(draft);
      if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
    }
    setDraft(null);
  };
  return (
    <input
      aria-label={label}
      className="w-12 rounded bg-transparent px-1 text-right font-mono text-[11px] text-muted tabular-nums outline-none hover:bg-white/[0.05] focus:bg-white/[0.07] focus:text-fg"
      value={draft ?? fmt(value, step)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

const THUMB = 'block size-3.5 rounded-full bg-fg shadow-[0_1px_4px_rgb(0_0_0/0.5)] outline-none transition-[box-shadow,transform] duration-150 focus-visible:ring-4 focus-visible:ring-accent/30 active:scale-110';

/** Label + two editable values + a two-thumb slider for a low..high band. */
export const RangeField = memo(function RangeField(props: {
  label: string; value: [number, number]; min: number; max: number; step: number; hint?: string; modified?: boolean;
  /** Names of the two ends, for screen readers and the value fields. */
  ends: [string, string];
  onChange: (v: [number, number]) => void; onReset?: () => void;
}) {
  const { label, value: [lo, hi], min, max, step, hint, modified, ends, onChange, onReset } = props;
  return (
    <div className="group py-1.5">
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <Label text={label} hint={hint} modified={modified} onReset={onReset} />
        <span className="flex-1" />
        <ResetButton show={modified} onReset={onReset} label={label} />
        <ValueInput label={`${label} ${ends[0]}`} value={lo} min={min} max={hi} step={step} onChange={(v) => onChange([v, hi])} />
        <span className="font-mono text-[11px] text-faint">–</span>
        <ValueInput label={`${label} ${ends[1]}`} value={hi} min={lo} max={max} step={step} onChange={(v) => onChange([lo, v])} />
      </div>
      <div className="flex items-center gap-1 px-5">
        <Sl.Root className="relative flex h-4 min-w-0 flex-1 touch-none items-center select-none" value={[lo, hi]} min={min} max={max} step={step}
          onValueChange={([a, b]) => onChange([a, b])}>
          <Sl.Track className="relative h-[3px] grow overflow-hidden rounded-full bg-white/[0.09]">
            <Sl.Range className="absolute h-full rounded-full bg-gradient-to-r from-accent/50 to-accent" />
          </Sl.Track>
          <Sl.Thumb aria-label={`${label} ${ends[0]}`} className={THUMB} />
          <Sl.Thumb aria-label={`${label} ${ends[1]}`} className={THUMB} />
        </Sl.Root>
      </div>
    </div>
  );
});

/** Label + editable value + slider. Double-click the label (or click the arrow) to reset. */
export const SliderField = memo(function SliderField(props: {
  label: string; value: number; min: number; max: number; step: number; hint?: string; modified?: boolean;
  /** Fill the track from this value (e.g. 0 on a -1..1 slider) instead of from the minimum. */
  origin?: number;
  onChange: (v: number) => void; onReset?: () => void;
}) {
  const { label, value, min, max, step, hint, modified, origin, onChange, onReset } = props;
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const [draft, setDraft] = useState<string | null>(null);
  const nudge = (dir: -1 | 1) => {
    const v = Math.min(max, Math.max(min, value + dir * jumpFor(min, max, step)));
    onChange(Number((min + Math.round((v - min) / step) * step).toFixed(6)));
  };
  const commit = () => {
    if (draft !== null) {
      const n = Number(draft);
      if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
    }
    setDraft(null);
  };
  return (
    <div className="group py-1.5">
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <Label text={label} hint={hint} modified={modified} onReset={onReset} />
        <span className="flex-1" />
        <ResetButton show={modified} onReset={onReset} label={label} />
        <input
          aria-label={`${label} value`}
          className="w-14 rounded bg-transparent px-1 text-right font-mono text-[11px] text-muted tabular-nums outline-none hover:bg-white/[0.05] focus:bg-white/[0.07] focus:text-fg"
          value={draft ?? fmt(value, step)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur(); }
          }}
        />
      </div>
      <div className="flex items-center gap-1">
        <StepButton dir={-1} label={label} disabled={value <= min} onClick={() => nudge(-1)} />
        <Sl.Root className="relative flex h-4 min-w-0 flex-1 touch-none items-center select-none" value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)}>
          <Sl.Track className="relative h-[3px] grow overflow-hidden rounded-full bg-white/[0.09]">
            {origin === undefined
              ? <Sl.Range className="absolute h-full rounded-full bg-gradient-to-r from-accent/50 to-accent" />
              : <span className={cx('absolute h-full rounded-full from-accent/50 to-accent', value < origin ? 'bg-gradient-to-l' : 'bg-gradient-to-r')}
                  style={{ left: `${pct(Math.min(origin, value))}%`, width: `${Math.abs(pct(value) - pct(origin))}%` }} />}
          </Sl.Track>
          {origin !== undefined && (
            <span aria-hidden className="pointer-events-none absolute top-1/2 h-2 w-px -translate-y-1/2 bg-white/25" style={{ left: `${pct(origin)}%` }} />
          )}
          <Sl.Thumb aria-label={label} className="block size-3.5 rounded-full bg-fg shadow-[0_1px_4px_rgb(0_0_0/0.5)] outline-none transition-[box-shadow,transform] duration-150 focus-visible:ring-4 focus-visible:ring-accent/30 active:scale-110" />
        </Sl.Root>
        <StepButton dir={1} label={label} disabled={value >= max} onClick={() => nudge(1)} />
      </div>
    </div>
  );
});

export function Row({ label, hint, modified, onReset, children }: { label: string; hint?: string; modified?: boolean; onReset?: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <Label text={label} hint={hint} modified={modified} onReset={onReset} />
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {onReset && <ResetButton show={modified} onReset={onReset} label={label} />}
        {children}
      </div>
    </div>
  );
}

export function Select<V extends string>({ value, options, onChange, label, className }: {
  value: V; options: readonly V[] | readonly { value: V; label: string; hint?: string; disabled?: boolean }[]; onChange: (v: V) => void; label: string; className?: string;
}) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o, hint: undefined, disabled: false } : o));
  return (
    <S.Root value={value} onValueChange={(v) => onChange(v as V)}>
      <S.Trigger aria-label={label} className={cx('press flex h-7 min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-white/[0.04] px-2.5 text-[12px] text-fg outline-none hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-accent/40', className ?? 'w-40')}>
        <span className="truncate"><S.Value /></span>
        <S.Icon><ChevronDown className="size-3.5 text-muted" /></S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} className="pop z-50 max-h-[min(380px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line-strong bg-raised p-1 shadow-2xl">
          <S.Viewport>
            {opts.map((o) => (
              <S.Item key={o.value} value={o.value} disabled={o.disabled} className="relative flex cursor-default items-center rounded-md py-1.5 pr-2 pl-7 text-[12px] text-fg outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/[0.07]">
                <S.ItemIndicator className="absolute left-2"><Check className="size-3.5 text-accent" /></S.ItemIndicator>
                <div>
                  <S.ItemText>{o.label}</S.ItemText>
                  {o.hint && <div className="mt-0.5 max-w-64 text-[11px] text-faint">{o.hint}</div>}
                </div>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

/** Determinate progress bar (`value` 0..1), or an indeterminate one when `value` is null. */
export function Progress({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="relative h-9 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-white/[0.04]" role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)}>
      <div className={cx('absolute inset-y-0 left-0 bg-accent/25', value === null ? 'w-1/3 animate-[slide_1.2s_ease-in-out_infinite]' : 'transition-[width] duration-200')}
        style={value === null ? undefined : { width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      <div className="relative flex h-full items-center justify-between gap-2 px-3 font-mono text-[11px] text-fg tabular-nums">
        <span className="truncate">{label}</span>
        {value !== null && <span className="shrink-0">{Math.floor(value * 100)}%</span>}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Sw.Root aria-label={label} checked={checked} onCheckedChange={onChange} className="relative h-[18px] w-8 rounded-full bg-white/[0.12] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 data-[state=checked]:bg-accent">
      <Sw.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-fg shadow transition-transform duration-150 ease-[var(--ease-out)] data-[state=checked]:translate-x-[16px] data-[state=checked]:bg-accent-ink" />
    </Sw.Root>
  );
}

export function ColorField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="flex h-7 w-40 items-center gap-2 rounded-md border border-line bg-white/[0.04] pr-2 pl-1">
      <label className="relative size-5 shrink-0 cursor-pointer overflow-hidden rounded border border-line-strong" style={{ background: value }}>
        <input aria-label={label} type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
      <input
        aria-label={`${label} hex`}
        value={text}
        onChange={(e) => { setText(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value); }}
        className="w-full bg-transparent font-mono text-[11px] text-fg uppercase outline-none"
      />
    </div>
  );
}

export function TextField({ value, onChange, label, mono }: { value: string; onChange: (v: string) => void; label: string; mono?: boolean }) {
  return (
    <input
      aria-label={label}
      value={value}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className={cx('h-7 w-full rounded-md border border-line bg-white/[0.04] px-2 text-[12px] text-fg outline-none focus:border-accent/40 focus:bg-white/[0.06]', mono && 'font-mono')}
    />
  );
}

export function Popover({ trigger, children, align = 'end', open, onOpenChange }: {
  trigger: ReactNode; children: ReactNode; align?: 'start' | 'center' | 'end'; open?: boolean; onOpenChange?: (v: boolean) => void;
}) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content align={align} sideOffset={8} className="pop z-50 w-72 rounded-xl border border-line-strong bg-raised p-3 shadow-2xl outline-none">
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

/**
 * Collapsible inspector section. With `toggle`, the header carries an on/off switch: turning it on opens the
 * section and turning it off collapses it. It opens initially if `defaultOpen` (remount it to re-apply that).
 */
export function Section({ title, children, defaultOpen = true, right, toggle }: {
  title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode;
  toggle?: { on: boolean; onChange: (v: boolean) => void };
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group/sec border-t border-line px-4 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between py-1.5 select-none [&::-webkit-details-marker]:hidden">
        <span className={cx('text-[11px] font-medium tracking-[0.08em] uppercase', toggle && !toggle.on ? 'text-faint/70' : 'text-faint')}>{title}</span>
        <span className="flex items-center gap-2">
          {right}
          {toggle && (
            // Keeps a click on the switch from also opening or closing the section.
            <span className="flex" onClick={(e) => e.preventDefault()}>
              <Switch label={title} checked={toggle.on} onChange={(v) => { toggle.onChange(v); setOpen(v); }} />
            </span>
          )}
          <ChevronDown className="size-3.5 text-faint transition-transform duration-200 ease-[var(--ease-out)] group-open/sec:rotate-180" />
        </span>
      </summary>
      <div className="pb-2">{children}</div>
    </details>
  );
}
