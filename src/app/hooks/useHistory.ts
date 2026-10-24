import { useCallback, useEffect, useRef, useState } from 'react';

const LIMIT = 100;

/** Undo/redo over `value`, committing a snapshot once it stops changing for `settleMs`. */
export function useHistory<T>(value: T, restore: (v: T) => void, settleMs = 350) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const committed = useRef(value);
  const current = useRef(value);
  current.current = value;
  const [, rerender] = useState(0);

  useEffect(() => {
    if (value === committed.current) return;
    const t = setTimeout(() => {
      past.current.push(committed.current);
      if (past.current.length > LIMIT) past.current.shift();
      future.current = [];
      committed.current = value;
      rerender((n) => n + 1);
    }, settleMs);
    return () => clearTimeout(t);
  }, [value, settleMs]);

  const undo = useCallback(() => {
    const cur = current.current;
    if (cur !== committed.current) past.current.push(committed.current);
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(cur);
    committed.current = prev;
    restore(prev);
  }, [restore]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(current.current);
    committed.current = next;
    restore(next);
  }, [restore]);

  return { undo, redo, canUndo: past.current.length > 0 || value !== committed.current, canRedo: future.current.length > 0 };
}
