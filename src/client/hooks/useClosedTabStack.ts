/**
 * Tracks user-closed tabs in an in-memory LIFO so Ctrl+Alt+T can reopen them.
 *
 * Pure module — no Svelte runes. The only consumer is the App-level keydown
 * handler which reads on demand; there's no UI surface that needs reactive
 * size/peek today. If a "Recently closed tabs" submenu is ever added, promote
 * to a `.svelte.ts` factory backed by `$state`.
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
  const stack: ClosedTabRecord[] = [];
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
    size(): number {
      return stack.length;
    },
    clear() {
      stack.length = 0;
    },
  };
}

export type ClosedTabStack = ReturnType<typeof createClosedTabStack>;
