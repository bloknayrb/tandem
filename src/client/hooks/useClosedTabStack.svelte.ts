/**
 * Tracks user-closed tabs in an in-memory LIFO so Ctrl+Alt+T can reopen them
 * and the new-tab launcher can surface "Reopen last closed".
 *
 * `.svelte.ts` factory: the internal array is `$state`-backed so the reactive
 * `top` getter drives the launcher's "Reopen last closed" affordance — it
 * enables/disables live as tabs open and close while the menu is open. App
 * owns the single instance and passes `top` down to DocumentTabs as a prop.
 * The imperative push/pop/peek/size/clear surface is unchanged so the existing
 * App keydown flow (and its unit tests) keep working verbatim.
 *
 * Lifetime is in-memory only; resets on page reload. Acceptable for v1 — the
 * action label is "Reopen closed tab (this session)" so the bound is clear.
 */

export interface ClosedTabRecord {
  filePath: string;
  closedAt: number;
}

const DEFAULT_CAP = 25;

export function createClosedTabStack(cap = DEFAULT_CAP) {
  const stack = $state<ClosedTabRecord[]>([]);
  return {
    push(rec: ClosedTabRecord) {
      // Dedup at the head so closing the same tab twice doesn't pollute the
      // history with consecutive duplicates.
      if (stack.length && stack[stack.length - 1].filePath === rec.filePath) return;
      stack.push(rec);
      while (stack.length > cap) stack.shift();
    },
    pop(): ClosedTabRecord | null {
      return stack.pop() ?? null;
    },
    peek(): ClosedTabRecord | null {
      return stack.length ? stack[stack.length - 1] : null;
    },
    /**
     * Reactive head-of-stack for UI surfaces. Reading this in a reactive
     * context (template / `$derived` / `$effect`) tracks pushes and pops, so a
     * consumer re-renders when the most-recently-closed tab changes. Do NOT
     * destructure this off the returned object — that snapshots the getter and
     * loses reactivity (see feedback_svelte_getter_destructuring).
     */
    get top(): ClosedTabRecord | null {
      return stack.length ? stack[stack.length - 1] : null;
    },
    size(): number {
      return stack.length;
    },
    clear() {
      stack.length = 0;
    },
  };
}

export type ClosedTabStack = ReturnType<typeof createClosedTabStack>;
