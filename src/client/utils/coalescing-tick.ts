/**
 * Bridge a synchronous external event source into Svelte `$state`.
 *
 * Writing `$state` while Svelte holds an active reaction throws
 * `state_unsafe_mutation` — and that throw is NOT dev-only: Svelte's
 * `state_unsafe_mutation()` has an `else` branch that throws a bare
 * `https://svelte.dev/e/state_unsafe_mutation` in production too. The guard
 * fires for any of `DERIVED | BLOCK_EFFECT | ASYNC | EAGER_EFFECT`, so despite
 * the message naming only `$derived`/`$inspect`/template expressions, an
 * ordinary `{#if}` block counts.
 *
 * Tiptap emits `update`/`transaction` synchronously from ProseMirror's
 * `dispatch`, and ProseMirror dispatches from DOM event handlers — including a
 * native `blur`, which the browser can fire *during* a render when a block
 * effect removes the focused node. The write then lands mid-reaction and
 * throws, from inside ProseMirror's dispatch. Deferring to a microtask moves
 * the write past the end of the current synchronous render, where no reaction
 * is active.
 *
 * Coalescing is the second reason this exists: a burst of transactions (typing,
 * or a remote CRDT sync applying many steps) collapses into one write.
 */
export function createCoalescingTick(
  bump: () => void,
  schedule: (cb: () => void) => void = queueMicrotask,
): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      bump();
    });
  };
}
