import { Check, Eraser, Eye, EyeOff, Minus, Plus, Trash2, Undo2 } from 'lucide-react';
import type { MaskTool } from '../lib/mask.ts';
import { Button, Kbd, Tip, cx } from './ui.tsx';

const TOOLS: { tool: MaskTool; label: string; key: string; icon: typeof Plus }[] = [
  { tool: 'add', label: 'Add glyphs', key: 'A', icon: Plus },
  { tool: 'remove', label: 'Remove glyphs', key: 'R', icon: Minus },
  { tool: 'erase', label: 'Erase mask', key: 'E', icon: Eraser },
];

export function MaskBar({ tool, size, overlay, canUndo, onTool, onSize, onOverlay, onUndo, onClear, onDone }: {
  tool: MaskTool; size: number; overlay: boolean; canUndo: boolean;
  onTool: (t: MaskTool) => void; onSize: (v: number) => void; onOverlay: (v: boolean) => void;
  onUndo: () => void; onClear: () => void; onDone: () => void;
}) {
  return (
    <div className="glass absolute top-16 left-1/2 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border border-line p-1 shadow-lg"
      role="toolbar" aria-label="Mask brush">
      {TOOLS.map(({ tool: t, label, key, icon: Icon }) => (
        <Tip key={t} label={<>{label}<Kbd>{key}</Kbd></>}>
          <Button size="icon" aria-label={label} aria-pressed={tool === t} onClick={() => onTool(t)}
            className={cx(tool === t && 'bg-white/[0.08]', tool === t && (t === 'add' ? 'text-accent' : t === 'remove' ? 'text-red-400' : 'text-fg'))}>
            <Icon className="size-4" />
          </Button>
        </Tip>
      ))}
      <div className="mx-1 h-5 w-px bg-line" />
      <label className="flex items-center gap-2 px-1.5 text-[11px] text-muted">
        Size
        <input type="range" min={0.005} max={0.2} step={0.005} value={size} onChange={(e) => onSize(Number(e.target.value))}
          aria-label="Brush size" className="w-24 accent-[var(--color-accent)]" />
      </label>
      <div className="mx-1 h-5 w-px bg-line" />
      <Tip label={overlay ? 'Hide mask' : 'Show mask'}>
        <Button size="icon" aria-label={overlay ? 'Hide mask' : 'Show mask'} aria-pressed={overlay} onClick={() => onOverlay(!overlay)}>
          {overlay ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        </Button>
      </Tip>
      <Tip label={<>Undo stroke<Kbd>Ctrl Z</Kbd></>}>
        <Button size="icon" aria-label="Undo stroke" disabled={!canUndo} onClick={onUndo}><Undo2 className="size-4" /></Button>
      </Tip>
      <Tip label="Clear mask">
        <Button size="icon" aria-label="Clear mask" onClick={onClear}><Trash2 className="size-4" /></Button>
      </Tip>
      <Tip label={<>Done<Kbd>M</Kbd></>}>
        <Button size="sm" variant="primary" onClick={onDone} className="ml-0.5"><Check className="size-3.5" />Done</Button>
      </Tip>
    </div>
  );
}
