/**
 * Document-level "event landed outside this node" subscription helper.
 *
 * Replaces the duplicated `contains(target)` guard that previously lived in
 * both `Toolbar.svelte` (scroll-based dismiss) and `HighlightColorPicker.svelte`
 * (mousedown-based dismiss). See #589.
 *
 * Call sites still decide what "dismiss" means and apply any caller-specific
 * extra guards (e.g. Toolbar skips dismiss while the user is composing in a
 * textarea). This module only owns the contains-check and listener lifecycle.
 */

export type OutsideEventType = "mousedown" | "scroll";

/**
 * Attach a document-level handler that fires when one of `eventTypes` lands
 * outside the element returned by `getElement`. Returns a cleanup function
 * that removes the listeners — pass it back from `$effect` to scope the
 * subscription to the effect's lifetime.
 *
 * `getElement` is a getter rather than a plain `HTMLElement` so that callers
 * using `bind:this` (which is null on first effect run) work without
 * special-casing.
 *
 * @param getElement Accessor returning the host element, or null if it hasn't mounted yet.
 * @param eventTypes Events to listen for. `"scroll"` always needs `capture: true` to fire for inner-scroll containers.
 * @param onOutside Fired when the event target is non-null and not contained by the element.
 * @param options.capture Defaults to `true` (matches both prior call sites).
 */
export function onOutsideEvent(
  getElement: () => HTMLElement | null,
  eventTypes: readonly OutsideEventType[],
  onOutside: (event: Event) => void,
  options: { capture?: boolean } = {},
): () => void {
  const { capture = true } = options;

  function handle(event: Event) {
    const el = getElement();
    if (!el) return;
    if (event.target instanceof Node && el.contains(event.target)) return;
    onOutside(event);
  }

  for (const t of eventTypes) document.addEventListener(t, handle, capture);

  return () => {
    for (const t of eventTypes) document.removeEventListener(t, handle, capture);
  };
}
