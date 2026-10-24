import { useEffect, useRef } from 'react';
import type { MaskTool } from '../lib/mask.ts';

export interface HotkeyActions {
  masking: boolean;
  undo: () => void;
  redo: () => void;
  undoStroke: () => void;
  open: () => void;
  exportOne: () => void;
  exportAll: () => void;
  escape: () => void;
  holdOriginal: (held: boolean) => void;
  toggleMask: () => void;
  maskTool: (t: MaskTool) => void;
  brush: (grow: boolean) => void;
  toggleView: () => void;
  toggleSplit: () => void;
  step: (d: number) => void;
}

const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
const inControl = (t: EventTarget | null) => t instanceof Element && !!t.closest('[role=slider],[role=combobox],[role=listbox]');
const TOOL_KEYS: Record<string, MaskTool> = { a: 'add', r: 'remove', e: 'erase' };

export function useHotkeys(actions: HotkeyActions) {
  const ref = useRef(actions);
  ref.current = actions;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const a = ref.current;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.key === 'Escape') return a.escape();
      if (mod) {
        if ((key === 'z' || key === 'y') && typing(e.target)) return;
        if (key === 'z' && !e.shiftKey && a.masking) a.undoStroke();
        else if (key === 'z') (e.shiftKey ? a.redo : a.undo)();
        else if (key === 'y') a.redo();
        else if (key === 'o') a.open();
        else if (key === 's') {
          // Commit a half-typed value box (it applies on blur) before exporting.
          (document.activeElement as HTMLElement | null)?.blur();
          setTimeout(() => (e.shiftKey ? ref.current.exportAll() : ref.current.exportOne()), 0);
        } else return;
        e.preventDefault();
        return;
      }
      if (typing(e.target) || inControl(e.target)) return;
      if (key === 'b') a.holdOriginal(true);
      else if (key === 'm') a.toggleMask();
      else if (a.masking && TOOL_KEYS[key]) a.maskTool(TOOL_KEYS[key]);
      else if (a.masking && (key === '[' || key === ']')) a.brush(key === ']');
      else if (key === 'g') a.toggleView();
      else if (e.key === '\\') a.toggleSplit();
      else if (e.key === 'ArrowRight') a.step(1);
      else if (e.key === 'ArrowLeft') a.step(-1);
    };
    const up = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'b') ref.current.holdOriginal(false); };
    const release = () => ref.current.holdOriginal(false);
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
