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

/**
 * Escape ownership across modal layers.
 *
 * Every app-level modal (`SettingsModal`, `HelpModal`, `IntegrationWizardModal`,
 * `FileOpenDialog`, `CommandPalette`, `FirstRunModelPickerModal`,
 * `CoworkAdminDeclinedModal`) renders its `aria-modal="true"` dialog only
 * while open, on the above-titlebar tier or higher, and after `SettingsModal`
 * in `App.svelte`; `ModelEditModal` renders inside Settings' own subtree. So
 * an open `aria-modal` dialog is always the top of the stack relative to the
 * page, and relative to Settings whenever Settings is the other one open.
 *
 * Two kinds of surface use that:
 *   - a surface that lives BENEATH every modal (the selection popup, the
 *     activity tray) and listens for Escape in the window capture phase must
 *     yield while any modal is open. Capture at `window` runs before every
 *     dialog's own handler, so without the yield Escape dismisses the hidden
 *     surface under the scrim and leaves the dialog the user is looking at
 *     open;
 *   - `SettingsModal`, whose Escape handler is document-level and acts
 *     whatever holds focus, must yield while any OTHER modal is open, because
 *     that one is layered over it and owns the key.
 *
 * The rule a layer over Settings must follow follows from that: by the time
 * Settings' document listener runs, the layer has either stopped the event or
 * is still in the DOM. A bubbling handler that closes its dialog and lets the
 * event go on breaks it — with a real key press the browser runs microtasks
 * between listeners, Svelte's flush removes the dialog in that gap, and
 * Settings, seeing no other modal, closes too. So such a layer stops
 * propagation (ModelEditModal) or listens in the window capture phase and
 * stops it there (HelpModal, CommandPalette, FileOpenDialog).
 *
 * Only `"true"` counts: `FindReplaceBar` declares `aria-modal="false"`. A
 * dialog that is in the DOM but not on screen does not count either — one
 * hidden with CSS, or one Svelte has marked `inert` while its `out:`
 * transition plays — or it would silently disable Escape for Settings, the
 * selection popup and the activity tray.
 */
export const MODAL_DIALOG_SELECTOR = '[aria-modal="true"]';

/**
 * True when an `aria-modal="true"` dialog other than `except` is in the
 * document. Pass the caller's own dialog as `except` to ask "is something
 * layered over me?"; pass nothing to ask "is any modal open?".
 */
export function modalDialogOpen(except: Element | null = null): boolean {
  for (const dialog of document.querySelectorAll(MODAL_DIALOG_SELECTOR)) {
    if (dialog === except) continue;
    if (dialog.closest("[inert]")) continue;
    // Optional: absent on older engines (WebKitGTK before 2.44), where a
    // CSS-hidden dialog still counts — the pre-hardening behaviour. The
    // historic `checkVisibilityCSS` alias is passed for engines that predate
    // `visibilityProperty`.
    if (
      dialog.checkVisibility?.({ visibilityProperty: true, checkVisibilityCSS: true }) === false
    ) {
      continue;
    }
    return true;
  }
  return false;
}
