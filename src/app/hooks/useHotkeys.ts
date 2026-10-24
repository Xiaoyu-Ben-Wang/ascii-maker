import { useEffect, useRef } from 'react';
import type { Mode } from '../components/Toolbar.tsx';
import { MOVED, SHORTCUTS, comboOf, type ShortcutId } from '../lib/shortcuts.ts';
import { KEYS, load, save } from '../lib/storage.ts';

export interface HotkeyContext {
  mode: Mode;
  masking: boolean;
  run: Partial<Record<ShortcutId, () => void>>;
  escape: () => void;
  /** Alt held while masking: erase until it is released. */
  eraseHold: (held: boolean) => void;
  notify: (text: string) => void;
}

const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
const inControl = (t: EventTarget | null) => t instanceof Element && !!t.closest('[role=slider],[role=combobox],[role=listbox]');
/** Text-editing combos stay with the browser while a text box has focus. */
const EDITING = /^mod\+(shift\+)?Key[ZYACVX]$/;
/** Keys a focused button or link acts on itself. */
const NAVIGATION = /^(shift\+)?(Tab|Enter)$/;
const focusable = (t: EventTarget | null) => t instanceof Element && !!t.closest('button,a,[tabindex]');

/** Runs the shortcut table (lib/shortcuts.ts) against key presses. */
export function useHotkeys(ctx: HotkeyContext) {
  const ref = useRef(ctx);
  ref.current = ctx;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const c = ref.current;
      if (e.key === 'Escape') return c.escape();
      if (e.key === 'Alt' && c.masking) { e.preventDefault(); c.eraseHold(true); return; }
      const combo = comboOf(e);
      const mod = combo.startsWith('mod+');
      if (typing(e.target) && (!mod || EDITING.test(combo))) return;
      if (inControl(e.target) && !mod) return;
      if (NAVIGATION.test(combo) && focusable(e.target)) return;

      const hit = SHORTCUTS.find((s) => s.combos.includes(combo)
        && (!s.modes || s.modes.includes(c.mode))
        && (s.masking === undefined || s.masking === c.masking)
        && c.run[s.id]);
      if (hit) {
        e.preventDefault();
        // Commit a half-typed value box (it applies on blur) before acting on the settings.
        if (mod) (document.activeElement as HTMLElement | null)?.blur();
        const act = c.run[hit.id]!;
        if (mod) setTimeout(act, 0); else act();
        return;
      }
      const moved = MOVED.find((m) => m.combo === combo);
      if (moved) {
        if (mod) e.preventDefault();
        const seen = load<string[]>(KEYS.movedKeys) ?? [];
        if (!seen.includes(moved.combo)) {
          c.notify(moved.text);
          save(KEYS.movedKeys, [...seen, moved.combo]);
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      if (ref.current.masking) e.preventDefault();
      ref.current.eraseHold(false);
    };
    const release = () => ref.current.eraseHold(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
    };
  }, []);
}
