import { Check, ChevronDown } from 'lucide-react';
import { Popover as P, Select as S, Slider as Sl, Switch as Sw, Tooltip as T } from 'radix-ui';
import { memo, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';

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

function fmt(v: number, step: number) {
  const d = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toFixed(d);
}

/** Label + editable value + slider. Double-click the label to reset. */
export const SliderField = memo(function SliderField(props: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; onReset?: () => void;
}) {
  const { label, value, min, max, step, onChange, onReset } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) {
      const n = Number(draft);
      if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
    }
    setDraft(null);
  };
  return (
    <div className="group py-1.5">
      <div className="mb-1.5 flex items-center justify-between">
        <label onDoubleClick={onReset} className="cursor-default text-[12px] text-muted select-none">
          {label}
        </label>
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
      <Sl.Root className="relative flex h-4 w-full touch-none items-center select-none" value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)}>
        <Sl.Track className="relative h-[3px] grow overflow-hidden rounded-full bg-white/[0.09]">
          <Sl.Range className="absolute h-full rounded-full bg-gradient-to-r from-accent/50 to-accent" />
        </Sl.Track>
        <Sl.Thumb aria-label={label} className="block size-3.5 rounded-full bg-fg shadow-[0_1px_4px_rgb(0_0_0/0.5)] outline-none transition-[box-shadow,transform] duration-150 focus-visible:ring-4 focus-visible:ring-accent/30 active:scale-110" />
      </Sl.Root>
    </div>
  );
});

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[12px] text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 justify-end">{children}</div>
    </div>
  );
}

export function Select<V extends string>({ value, options, onChange, label, className }: {
  value: V; options: readonly V[] | readonly { value: V; label: string; hint?: string }[]; onChange: (v: V) => void; label: string; className?: string;
}) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o, hint: undefined } : o));
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
              <S.Item key={o.value} value={o.value} className="relative flex cursor-default items-center rounded-md py-1.5 pr-2 pl-7 text-[12px] text-fg outline-none select-none data-[highlighted]:bg-white/[0.07]">
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

export function Popover({ trigger, children, align = 'end' }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'center' | 'end' }) {
  return (
    <P.Root>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content align={align} sideOffset={8} className="pop z-50 w-72 rounded-xl border border-line-strong bg-raised p-3 shadow-2xl outline-none">
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

/** Collapsible inspector section. Uses <details> so it needs no state or animation library. */
export function Section({ title, children, defaultOpen = true, right }: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details ref={ref} open={defaultOpen} className="group/sec border-t border-line px-4 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between py-1.5 select-none [&::-webkit-details-marker]:hidden">
        <span className="text-[11px] font-medium tracking-[0.08em] text-faint uppercase">{title}</span>
        <span className="flex items-center gap-2">
          {right}
          <ChevronDown className="size-3.5 text-faint transition-transform duration-200 ease-[var(--ease-out)] group-open/sec:rotate-180" />
        </span>
      </summary>
      <div className="pb-2">{children}</div>
    </details>
  );
}
