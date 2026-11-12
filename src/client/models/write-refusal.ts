/**
 * Has the server refused a local-model settings write from this page because
 * it is not Tandem's own window (#2404, `403 OWN_WINDOW_ONLY`)?
 *
 * A plain module with no runes, on purpose: the one-time reconcile action
 * records a refusal here, and that action is also imported by programs that
 * have no Svelte ambient types. The reactive view of this flag is
 * `hooks/useModelsWriteAccess.svelte.ts`, which subscribes.
 *
 * It never clears by itself: the page's origin does not change, and the
 * server reads its development allowance once, at start.
 */

let refused = false;
const listeners = new Set<() => void>();

/** The server refused a write because this is not Tandem's own window. */
export function noteModelsWriteRefused(): void {
  if (refused) return;
  refused = true;
  for (const cb of listeners) cb();
}

export function modelsWriteWasRefused(): boolean {
  return refused;
}

/** Be told when the first refusal lands. Returns the unsubscribe. */
export function onModelsWriteRefused(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test seam: forget the refusal (listeners stay). */
export function _resetModelsWriteRefusalForTests(): void {
  refused = false;
}
