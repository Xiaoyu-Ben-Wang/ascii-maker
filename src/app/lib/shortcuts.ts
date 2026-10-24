// Keyboard shortcuts, after Lightroom. useHotkeys, the cheat sheet and button tooltips all read this table.
import type { Mode } from '../components/Toolbar.tsx';

export type ShortcutId =
  | 'library' | 'loupe' | 'develop' | 'openLoupe' | 'prev' | 'next' | 'selectAll' | 'selectNone' | 'remove'
  | 'import' | 'export' | 'undo' | 'redo' | 'copySettings' | 'pasteSettings' | 'pastePrevious' | 'reset'
  | 'before' | 'split' | 'zoom' | 'zoomIn' | 'zoomOut' | 'panel' | 'chrome' | 'fullscreen' | 'help'
  | 'mask' | 'maskAdd' | 'maskRemove' | 'brushDown' | 'brushUp';

export type Group = 'Modes' | 'Library' | 'View' | 'Develop' | 'Mask brush';

export interface Shortcut {
  id: ShortcutId;
  label: string;
  group: Group;
  /** Combos as `mod+shift+alt+<KeyboardEvent.code>`; `mod` is Ctrl, or Cmd on macOS. */
  combos: string[];
  modes?: Mode[];
  /** true: only while the mask brush is on; false: never while it is on. */
  masking?: boolean;
}

/** Listed in the cheat sheet, but handled elsewhere. */
export const OTHER_KEYS: { keys: string; label: string; group: Group }[] = [
  { keys: 'Ctrl V', label: 'Paste images', group: 'Library' },
  { keys: 'Space', label: 'Hold and drag to pan', group: 'View' },
  { keys: 'Alt', label: 'Hold to erase while painting', group: 'Mask brush' },
  { keys: 'Esc', label: 'Close, or leave the mask brush or vignette picker', group: 'View' },
];

const ALL: Mode[] = ['library', 'loupe', 'develop'];
const VIEWS: Mode[] = ['loupe', 'develop'];

export const SHORTCUTS: Shortcut[] = [
  { id: 'library', label: 'Library', group: 'Modes', combos: ['KeyG'], masking: false },
  { id: 'loupe', label: 'Loupe', group: 'Modes', combos: ['KeyE'], masking: false },
  { id: 'develop', label: 'Develop', group: 'Modes', combos: ['KeyD'], masking: false },
  { id: 'openLoupe', label: 'Open in Loupe', group: 'Library', combos: ['Enter'], modes: ['library'] },
  { id: 'prev', label: 'Previous creation', group: 'Library', combos: ['ArrowLeft'] },
  { id: 'next', label: 'Next creation', group: 'Library', combos: ['ArrowRight'] },
  { id: 'selectAll', label: 'Select all', group: 'Library', combos: ['mod+KeyA'], modes: ['library'] },
  { id: 'selectNone', label: 'Select none', group: 'Library', combos: ['mod+KeyD'], modes: ['library'] },
  { id: 'remove', label: 'Remove from library', group: 'Library', combos: ['Delete', 'Backspace'], modes: ['library', 'loupe'] },
  { id: 'import', label: 'Import', group: 'Library', combos: ['mod+shift+KeyI', 'mod+KeyO'] },
  { id: 'export', label: 'Export (the selection, in the Library)', group: 'Library', combos: ['mod+shift+KeyE'] },
  { id: 'copySettings', label: 'Copy settings', group: 'Develop', combos: ['mod+shift+KeyC'] },
  { id: 'pasteSettings', label: 'Paste settings (onto the selection, in the Library)', group: 'Develop', combos: ['mod+shift+KeyV'] },
  { id: 'pastePrevious', label: 'Paste settings from previous', group: 'Develop', combos: ['mod+alt+KeyV'] },
  { id: 'undo', label: 'Undo', group: 'Develop', combos: ['mod+KeyZ'], modes: ['develop'] },
  { id: 'redo', label: 'Redo', group: 'Develop', combos: ['mod+shift+KeyZ', 'mod+KeyY'], modes: ['develop'] },
  { id: 'reset', label: 'Reset to preset', group: 'Develop', combos: ['mod+shift+KeyR'], modes: ['develop'] },
  { id: 'before', label: 'Before view', group: 'View', combos: ['Backslash'], modes: ['develop'] },
  { id: 'split', label: 'Before/after split', group: 'View', combos: ['shift+KeyY'], modes: ['develop'] },
  { id: 'zoom', label: 'Fit / 100%', group: 'View', combos: ['KeyZ'], modes: VIEWS },
  { id: 'zoomIn', label: 'Zoom in', group: 'View', combos: ['mod+Equal'], modes: VIEWS },
  { id: 'zoomOut', label: 'Zoom out', group: 'View', combos: ['mod+Minus'], modes: VIEWS },
  { id: 'panel', label: 'Show or hide the side panel', group: 'View', combos: ['Tab'], modes: ALL },
  { id: 'chrome', label: 'Show or hide all panels', group: 'View', combos: ['shift+Tab'], modes: ALL },
  { id: 'fullscreen', label: 'Fullscreen', group: 'View', combos: ['KeyF'] },
  { id: 'help', label: 'Keyboard shortcuts', group: 'View', combos: ['mod+Slash'] },
  { id: 'mask', label: 'Mask brush', group: 'Mask brush', combos: ['shift+KeyW', 'KeyK'], modes: ['develop'] },
  { id: 'maskAdd', label: 'Add glyphs', group: 'Mask brush', combos: ['KeyA'], masking: true },
  { id: 'maskRemove', label: 'Remove glyphs', group: 'Mask brush', combos: ['KeyR'], masking: true },
  { id: 'brushDown', label: 'Smaller brush', group: 'Mask brush', combos: ['BracketLeft'], masking: true },
  { id: 'brushUp', label: 'Larger brush', group: 'Mask brush', combos: ['BracketRight'], masking: true },
];

/** Keys that used to do something else, with the toast shown the first time one is pressed. */
export const MOVED: { combo: string; text: string }[] = [
  { combo: 'KeyB', text: 'Before view moved to \\ (as in Lightroom)' },
  { combo: 'KeyM', text: 'The mask brush moved to Shift+W or K (as in Lightroom)' },
  { combo: 'mod+KeyS', text: 'Export moved to Ctrl+Shift+E; edits save automatically' },
  { combo: 'mod+shift+KeyS', text: 'Export moved to Ctrl+Shift+E; edits save automatically' },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function comboOf(e: KeyboardEvent): string {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(e.code);
  return parts.join('+');
}

const KEY_NAMES: Record<string, string> = {
  Backslash: '\\', Slash: '/', Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']',
  ArrowLeft: '←', ArrowRight: '→', Delete: 'Del', Backspace: '⌫',
};

/** A combo for display, e.g. "Ctrl Shift C". */
export function comboLabel(combo: string): string {
  return combo.split('+').map((p) => {
    if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
    if (p === 'shift') return 'Shift';
    if (p === 'alt') return isMac ? '⌥' : 'Alt';
    return KEY_NAMES[p] ?? p.replace(/^Key|^Digit/, '');
  }).join(' ');
}

/** The first key for a shortcut, for tooltips. */
export const keyFor = (id: ShortcutId) => {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s?.combos[0] ? comboLabel(s.combos[0]) : '';
};
