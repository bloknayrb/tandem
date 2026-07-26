/**
 * Tab focus trap for modal dialogs.
 *
 * Extracted because this was the fifth hand-copied instance in the client
 * (`SettingsModal`, `IntegrationWizardModal`, `CoworkAdminDeclinedModal`,
 * `HelpModal`, and now `LicenseWall`), and the copies had already drifted:
 * SettingsModal filters `:not([inert])`, others filter `offsetParent !== null`,
 * one filters nothing and omits `summary` from its selector. An accessibility
 * fix currently has to be made five times to actually land.
 *
 * The other four are deliberately NOT migrated here yet — that is a bigger
 * change than the one that surfaced this. New dialogs should use this.
 */

/**
 * Elements that can hold focus. `summary` is included because `<details>`
 * disclosures are focusable and several dialogs use them.
 */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Currently-focusable descendants, in DOM order, excluding hidden ones. */
export function focusablesWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    // `offsetParent === null` catches `display:none` and detached subtrees;
    // `[inert]` is checked separately because inert content stays laid out.
    (el) => el.offsetParent !== null && !el.closest("[inert]"),
  );
}

/**
 * Keep Tab inside `container`. Call from the dialog's `keydown` handler.
 *
 * Re-queries on every Tab rather than caching: disclosures and conditional
 * blocks change the focusable set while a dialog is open. This runs at most
 * once per Tab keypress, so the forced layout from `offsetParent` is
 * user-paced and not a hot path.
 *
 * Also recovers focus that has escaped the container entirely (e.g. the
 * previously-focused element was removed), which the copies that only handled
 * first/last did not.
 */
export function trapTab(e: KeyboardEvent, container: HTMLElement | null): void {
  if (e.key !== "Tab" || !container) return;
  const focusables = focusablesWithin(container);
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  // Focus escaped the dialog — pull it back rather than letting Tab walk the
  // page behind the scrim.
  if (!(active instanceof Node) || !container.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }

  if (e.shiftKey && (active === first || active === container)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
