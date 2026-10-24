import { X } from 'lucide-react';
import { OTHER_KEYS, SHORTCUTS, comboLabel, type Group } from '../lib/shortcuts.ts';
import { Button, Kbd } from './ui.tsx';

const GROUPS: Group[] = ['Modes', 'Library', 'View', 'Develop', 'Mask brush'];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}
        className="glass max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl border border-line-strong p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[14px] text-fg">Keyboard shortcuts</h2>
          <Button size="icon" aria-label="Close" onClick={onClose}><X className="size-4" /></Button>
        </div>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g}>
              <h3 className="mb-1.5 text-[11px] tracking-wide text-faint uppercase">{g}</h3>
              <dl className="grid gap-1 text-[12px]">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3">
                    <dt className="text-muted">{s.label}</dt>
                    <dd className="flex shrink-0 gap-1">{s.combos.map((c) => <Kbd key={c}>{comboLabel(c)}</Kbd>)}</dd>
                  </div>
                ))}
                {OTHER_KEYS.filter((k) => k.group === g).map((k) => (
                  <div key={k.keys} className="flex items-center justify-between gap-3">
                    <dt className="text-muted">{k.label}</dt>
                    <dd><Kbd>{k.keys}</Kbd></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
