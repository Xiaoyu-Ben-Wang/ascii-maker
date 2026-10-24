import { useCallback, useMemo, useRef, useState } from 'react';
import { PRESETS, diffParams, resolveParams, type Params } from '../../engine/index.ts';
import { KEYS, load, save } from '../lib/storage.ts';
import { useHistory } from './useHistory.ts';

export const CUSTOM = 'custom';
/** Saved presets are named with this prefix so they never collide with built-in ones. */
const USER = 'user:';
type UserPresets = Record<string, Partial<Params>>;

export const userPresetName = (preset: string) => (preset.startsWith(USER) ? preset.slice(USER.length) : null);

function loadLook(userPresets: UserPresets): ImgLook {
  const s = load<{ preset?: string; params?: Partial<Params> }>(KEYS.look);
  try {
    if (s?.params) {
      const name = s.preset ?? CUSTOM;
      const user = userPresetName(name);
      return { preset: user !== null && !(user in userPresets) ? CUSTOM : name, params: resolveParams(s.params) };
    }
  } catch { /* corrupted settings: fall back to the default look */ }
  return { preset: 'soft-ascii', params: resolveParams(PRESETS['soft-ascii'].params) };
}

/** A creation's settings and the preset they started from. */
export interface ImgLook { preset: string; params: Params }

/**
 * The settings being edited: the active creation's (`target`), or with none open the default look new creations
 * start from, which follows the last look edited. Also saved presets and per-creation undo history.
 */
export function useLook(notify: (text: string) => void, target: { key: string; look: ImgLook } | null, onChange: (key: string, look: ImgLook) => void) {
  const [userPresets, setUserPresets] = useState<UserPresets>(() => {
    const s = load<UserPresets>(KEYS.presets);
    return s && typeof s === 'object' ? s : {};
  });
  const [fallback, setFallback] = useState<ImgLook>(() => loadLook(userPresets));
  const { params, preset } = target?.look ?? fallback;
  /** Bumped when a whole look is loaded, so inspector sections re-open or collapse to match it. */
  const [epoch, setEpoch] = useState(0);

  /** The look new creations start with: the last preset applied, or what was set with nothing open. */
  const defaultLook = useRef(fallback);
  const setDefault = useCallback((look: ImgLook) => {
    defaultLook.current = look;
    save(KEYS.look, { preset: look.preset, params: diffParams(look.params) });
  }, []);

  // Edits made in one tick (several set() calls) build on each other, not on the last render.
  const latest = useRef({ target, look: target?.look ?? fallback });
  if (latest.current.target?.key !== target?.key || latest.current.look !== (target?.look ?? fallback)) latest.current = { target, look: target?.look ?? fallback };
  const write = useCallback((look: ImgLook) => {
    const t = latest.current.target;
    latest.current = { target: t, look };
    if (t) onChange(t.key, look);
    else { setFallback(look); setDefault(look); }
  }, [onChange, setDefault]);

  const restore = useCallback((p: Params) => write({ preset: CUSTOM, params: p }), [write]);
  const history = useHistory(params, restore, target?.key ?? '');

  const set = useCallback((patch: Partial<Params>) => {
    const cur = latest.current.look;
    write({ preset: 'style' in patch ? CUSTOM : cur.preset, params: { ...cur.params, ...patch } });
  }, [write]);

  const current = useCallback(() => defaultLook.current, []);

  const paramsOf = useCallback((name: string): Partial<Params> | undefined => {
    const user = userPresetName(name);
    return user !== null ? userPresets[user] : PRESETS[name]?.params;
  }, [userPresets]);

  const apply = useCallback((name: string) => {
    setEpoch((n) => n + 1);
    const p = paramsOf(name);
    const look = { preset: name, params: p ? resolveParams(p) : latest.current.look.params };
    write(look);
    setDefault(look);
  }, [paramsOf, write, setDefault]);

  const base = useMemo(() => resolveParams(paramsOf(preset) ?? {}), [preset, paramsOf]);
  const edits = useMemo(() => Object.keys(diffParams(params, base)).length, [params, base]);
  const reset = useCallback(() => { write({ preset, params: base }); setEpoch((n) => n + 1); }, [base, preset, write]);

  const options = useMemo(() => [
    ...Object.entries(PRESETS).map(([k, p]) => ({ value: k, label: k, hint: p.description })),
    ...Object.keys(userPresets).sort().map((k) => ({ value: USER + k, label: k, hint: 'Saved preset' })),
    { value: CUSTOM, label: 'custom', hint: 'Your own settings' },
  ], [userPresets]);

  const storePresets = useCallback((next: UserPresets) => {
    setUserPresets(next);
    if (!save(KEYS.presets, next)) notify('Could not save presets in this browser');
  }, [notify]);

  const savePreset = useCallback((name: string) => {
    storePresets({ ...userPresets, [name]: diffParams(params) });
    write({ preset: USER + name, params });
    notify(`${name in userPresets ? 'Updated' : 'Saved'} preset “${name}”`);
  }, [userPresets, params, storePresets, notify, write]);

  const deletePreset = useCallback(() => {
    const name = userPresetName(preset);
    if (name === null) return;
    const { [name]: _, ...rest } = userPresets;
    storePresets(rest);
    write({ preset: CUSTOM, params });
    notify(`Deleted preset “${name}”`);
  }, [preset, params, userPresets, storePresets, notify, write]);

  return { params, set, preset, base, edits, epoch, apply, reset, options, userPresets, savePreset, deletePreset, current, ...history };
}

export type Look = ReturnType<typeof useLook>;
