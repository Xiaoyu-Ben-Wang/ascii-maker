import { useCallback, useEffect, useMemo, useState } from 'react';
import { PRESETS, diffParams, resolveParams, type Params } from '../../engine/index.ts';
import { KEYS, load, save } from '../lib/storage.ts';
import { useHistory } from './useHistory.ts';

export const CUSTOM = 'custom';
/** Saved presets are named with this prefix so they never collide with built-in ones. */
const USER = 'user:';
type UserPresets = Record<string, Partial<Params>>;

export const userPresetName = (preset: string) => (preset.startsWith(USER) ? preset.slice(USER.length) : null);

function loadLook(userPresets: UserPresets): { preset: string; params: Params } {
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

/** The current settings, the preset they came from, saved presets, and undo history. */
export function useLook(notify: (text: string) => void) {
  const [userPresets, setUserPresets] = useState<UserPresets>(() => {
    const s = load<UserPresets>(KEYS.presets);
    return s && typeof s === 'object' ? s : {};
  });
  const [initial] = useState(() => loadLook(userPresets));
  const [params, setParams] = useState(initial.params);
  const [preset, setPreset] = useState(initial.preset);
  /** Bumped when a whole look is loaded, so inspector sections re-open or collapse to match it. */
  const [epoch, setEpoch] = useState(0);

  useEffect(() => { save(KEYS.look, { preset, params: diffParams(params) }); }, [params, preset]);

  const restore = useCallback((p: Params) => { setParams(p); setPreset(CUSTOM); }, []);
  const history = useHistory(params, restore);

  const set = useCallback((patch: Partial<Params>) => {
    setParams((p) => ({ ...p, ...patch }));
    setPreset((name) => ('style' in patch ? CUSTOM : name));
  }, []);

  const paramsOf = useCallback((name: string): Partial<Params> | undefined => {
    const user = userPresetName(name);
    return user !== null ? userPresets[user] : PRESETS[name]?.params;
  }, [userPresets]);

  const apply = useCallback((name: string) => {
    setEpoch((n) => n + 1);
    setPreset(name);
    const p = paramsOf(name);
    if (p) setParams(resolveParams(p));
  }, [paramsOf]);

  const base = useMemo(() => resolveParams(paramsOf(preset) ?? {}), [preset, paramsOf]);
  const edits = useMemo(() => Object.keys(diffParams(params, base)).length, [params, base]);
  const reset = useCallback(() => { setParams(base); setEpoch((n) => n + 1); }, [base]);

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
    setPreset(USER + name);
    notify(`${name in userPresets ? 'Updated' : 'Saved'} preset “${name}”`);
  }, [userPresets, params, storePresets, notify]);

  const deletePreset = useCallback(() => {
    const name = userPresetName(preset);
    if (name === null) return;
    const { [name]: _, ...rest } = userPresets;
    storePresets(rest);
    setPreset(CUSTOM);
    notify(`Deleted preset “${name}”`);
  }, [preset, userPresets, storePresets, notify]);

  return { params, set, preset, base, edits, epoch, apply, reset, options, userPresets, savePreset, deletePreset, ...history };
}

export type Look = ReturnType<typeof useLook>;
