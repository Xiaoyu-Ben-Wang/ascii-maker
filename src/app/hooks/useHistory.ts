import { useCallback, useEffect, useRef, useState } from 'react';

const LIMIT = 100;

/**
 * Undo/redo over `value`, committing a snapshot once it stops changing for `settleMs`. Each `scope` (e.g. each
 * creation) keeps its own history; switching scope records nothing.
 */
export function useHistory<T>(value: T, restore: (v: T) => void, scope: string, settleMs = 350) {
  const stacks = useRef(new Map<string, { past: T[]; future: T[]; committed: T }>());
  const scopeRef = useRef(scope);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const committed = useRef(value);
  const current = useRef(value);
  current.current = value;
  const [, rerender] = useState(0);

  if (scopeRef.current !== scope) {
    stacks.current.set(scopeRef.current, { past: past.current, future: future.current, committed: committed.current });
    const next = stacks.current.get(scope);
    past.current = next?.past ?? [];
    future.current = next?.future ?? [];
    committed.current = next ? next.committed : value;
    scopeRef.current = scope;
  }

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
  }, [value, settleMs, scope]);

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

  const drop = useCallback((s: string) => { stacks.current.delete(s); }, []);

  /** Records a change made to another scope, as one undo step there. */
  const remember = useCallback((s: string, before: T, after: T) => {
    if (s === scopeRef.current) return;
    const st = stacks.current.get(s) ?? { past: [], future: [], committed: before };
    st.past.push(st.committed);
    if (st.past.length > LIMIT) st.past.shift();
    st.future = [];
    st.committed = after;
    stacks.current.set(s, st);
  }, []);

  return { undo, redo, dropHistory: drop, remember, canUndo: past.current.length > 0 || value !== committed.current, canRedo: future.current.length > 0 };
}
