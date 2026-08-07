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
 * focus is actually inside it.
 *
 * NOTE — this scoping no longer distinguishes the mouse path. It was written
 * when a mouse-opened popover left focus in the editor (its trigger calls
 * `preventDefault()` on mousedown), so Escape still dismissed the selection
 * popup on the first press. #1303 then added focus-in `$effect`s to the heading
 * and decorations menus that are ungated on how the menu was opened, and both
 * menus render INSIDE the selection popup — so a mouse-opened menu now puts
 * focus inside this subtree too, and Escape closes the menu first, the popup
 * second. That is the intended shape for a nested popover that owns Escape
 * while open; it is recorded here because the two-press sequence is a
 * user-visible change that arrived from another PR, not from this one. Pinned
 * by `tests/e2e/formatting-bar-popovers.spec.ts`.
 *
 * Do NOT "fix" it by gating those effects on keyboard-initiated opens:
 * `tests/e2e/keyboard-a11y.spec.ts` opens each menu with `.click()` and asserts
 * focus lands on an item, explicitly rejecting a pre-focus shortcut.
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
