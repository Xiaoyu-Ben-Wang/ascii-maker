import { Brush, ClipboardPaste, Columns2, Cpu, Eye, ImageUp, Keyboard, LayoutGrid, Redo2, SlidersHorizontal, Undo2 } from 'lucide-react';
import { keyFor } from '../lib/shortcuts.ts';
import { Button, Kbd, Tip, cx } from './ui.tsx';

const pressed = 'bg-white/[0.08] text-accent';
const Divider = ({ className }: { className?: string }) => <div className={cx('mx-1 h-5 w-px bg-line', className)} />;

function Logo() {
  return (
    <div className="flex items-center gap-2 pr-2 pl-2 font-mono text-[12px] font-medium tracking-tight text-fg select-none max-sm:hidden">
      <svg viewBox="0 0 16 16" className="size-[18px] text-accent" aria-hidden>
        <path d="M12.5 0.5v6M9.5 3.5h6M1.1 10.1l4.8 4.8M5.9 10.1l-4.8 4.8" className="stroke-[oklch(0.58_0.075_150)]" strokeWidth="1.3" />
        <g className="drop-shadow-[0_0_2px_color-mix(in_oklab,var(--color-accent)_35%,transparent)]" fontFamily="Tiny5, monospace" fontSize="9" textAnchor="middle" dominantBaseline="central" fill="currentColor">
          <text x="3.5" y="3.5">A</text>
          <text x="12.5" y="12.5">M</text>
        </g>
      </svg>
      ascii-maker
    </div>
  );
}

export function Toolbar(props: {
  onHelp: () => void;
  onOpen: () => void; onPaste: () => void;
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean;
  comparing: boolean; canCompare: boolean; onCompare: () => void;
  masking: boolean; canMask: boolean; painted: boolean; onMask: () => void;
  gpu: boolean; onGpu: () => void;
}) {
  return (
    <div className="glass flex items-center gap-0.5 rounded-xl border border-line p-1 shadow-lg">
      <Logo />
      <Divider className="max-sm:hidden" />
      <Tip label={<>Import<Kbd>{keyFor('import')}</Kbd></>}>
        <Button size="icon" aria-label="Add images" onClick={props.onOpen}><ImageUp className="size-4" /></Button>
      </Tip>
      <Tip label={<>Paste<Kbd>Ctrl V</Kbd></>}>
        <Button size="icon" aria-label="Paste image" onClick={props.onPaste}><ClipboardPaste className="size-4" /></Button>
      </Tip>
      <Divider />
      <Tip label={<>Undo<Kbd>{keyFor('undo')}</Kbd></>}>
        <Button size="icon" aria-label="Undo" onClick={props.onUndo} disabled={!props.canUndo}><Undo2 className="size-4" /></Button>
      </Tip>
      <Tip label={<>Redo<Kbd>{keyFor('redo')}</Kbd></>}>
        <Button size="icon" aria-label="Redo" onClick={props.onRedo} disabled={!props.canRedo}><Redo2 className="size-4" /></Button>
      </Tip>
      <Tip label={<>Before/after split<Kbd>{keyFor('split')}</Kbd></>}>
        <Button size="icon" aria-label="Compare" aria-pressed={props.comparing} disabled={!props.canCompare}
          className={cx(props.comparing && pressed)} onClick={props.onCompare}><Columns2 className="size-4" /></Button>
      </Tip>
      <Tip label={props.canMask ? <>Paint where glyphs go<Kbd>{keyFor('mask')}</Kbd></> : 'Mask brush works with glyph styles in Develop'}>
        <Button size="icon" aria-label="Mask brush" aria-pressed={props.masking} disabled={!props.canMask}
          className={cx('relative', props.masking && pressed)} onClick={props.onMask}>
          <Brush className="size-4" />
          {props.painted && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" aria-hidden />}
        </Button>
      </Tip>
      <Tip label={<>Keyboard shortcuts<Kbd>{keyFor('help')}</Kbd></>}>
        <Button size="icon" aria-label="Keyboard shortcuts" onClick={props.onHelp}><Keyboard className="size-4" /></Button>
      </Tip>
      <Tip label={props.gpu ? 'Hardware acceleration on: rendering uses the GPU' : 'Hardware acceleration off: rendering uses the CPU'}>
        <Button size="icon" aria-label="Hardware acceleration" aria-pressed={props.gpu} className={cx(props.gpu && 'text-accent')} onClick={props.onGpu}>
          <Cpu className="size-4" />
        </Button>
      </Tip>
    </div>
  );
}

export type Mode = 'library' | 'loupe' | 'develop';

const MODES: { mode: Mode; label: string; Icon: typeof LayoutGrid }[] = [
  { mode: 'library', label: 'Library', Icon: LayoutGrid },
  { mode: 'loupe', label: 'Loupe', Icon: Eye },
  { mode: 'develop', label: 'Develop', Icon: SlidersHorizontal },
];

export function ModeSwitch({ mode, count, onChange }: { mode: Mode; count: number; onChange: (m: Mode) => void }) {
  return (
    <div className="glass ml-auto flex items-center gap-0.5 rounded-xl border border-line p-1 shadow-lg" role="group" aria-label="Mode">
      {MODES.map(({ mode: m, label, Icon }) => (
        <Tip key={m} label={<>{label}<Kbd>{keyFor(m)}</Kbd></>}>
          <Button size="sm" aria-pressed={mode === m} onClick={() => onChange(m)} className={cx(mode === m && 'bg-white/[0.08] text-fg')}>
            <Icon className="size-3.5" /><span className="max-sm:sr-only">{label}</span>
            {m === 'library' && <span className="font-mono text-[11px] text-faint">{count}</span>}
          </Button>
        </Tip>
      ))}
    </div>
  );
}
