/**
 * Escape ownership for nested popovers.
 *
 * `Toolbar.svelte`'s selection popup registers its Escape handler at `window`
 * in the CAPTURE phase and calls `stopPropagation()`, so it preempts every
 * handler inside the document — including a popover's own dismissal. Capture
 * order is fixed (window is the first target in the propagation path), so a
 * nested popover cannot win by registering capture too, and registration order
 * is not a contract either. The nested popover therefore MARKS its subtree with
 * `ESCAPE_OWNER_ATTR` while it is open, and the window-level handler yields when
 * the Escape originated inside that subtree.
 *
 * Scoped to the event's origin on purpose: a popover only claims Escape while
 * focus is actually inside it. A mouse-opened popover leaves focus in the editor
 * (its trigger calls `preventDefault()` on mousedown), and there Escape still
 * dismisses the selection popup first — the behaviour that ships today, and the
 * behaviour `tests/e2e/formatting-bar-popovers.spec.ts` relies on when it
 * dismisses a mouse-opened heading menu by clicking away.
 *
 * Claimants today are the four popovers the persistent formatting bar owns: the
 * highlight colour picker (`HighlightColorPicker.svelte`), the link editor and
 * heading menu (`FormattingToolbar.svelte`) and the decorations menu
 * (`DecorationsMenu.svelte`). They are marked as a set deliberately — an
 * enumerated subset is exactly the thing that goes stale, and all four carry the
 * same wrapper-scoped Escape handler that the capture listener swallows. Any new
 * popover that owns Escape should set the attribute while open.
 */
export const ESCAPE_OWNER_ATTR = "data-tandem-escape-owner";

/**
 * True when `target` sits inside a subtree that has claimed Escape. Non-Element
 * targets (`window`, `document`, `null`) never claim.
 */
export function escapeIsClaimed(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${ESCAPE_OWNER_ATTR}]`) !== null;
}
