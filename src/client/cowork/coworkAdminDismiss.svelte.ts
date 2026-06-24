/**
 * Session-scoped dismiss state for the Cowork "Admin permission required" modal
 * (`CoworkAdminDeclinedModal`).
 *
 * Why module scope (not component `$state`): the modal only mounts when
 * `isTauriRuntime() && !shouldShowWizard` (`App.svelte`), so opening/closing the
 * integration wizard unmounts and remounts the component. Component-local dismiss
 * state would reset on every wizard cycle and re-surface the popup from a stale
 * `uacDeclinedAt`. Keeping the flag here makes "dismiss for the session" mean exactly
 * that — it survives remounts and resets only on a full app relaunch (fresh module
 * load) or a genuinely new decline.
 */

let dismissed = $state(false);
// Plain `let`, NOT `$state`: read + written inside the watcher effect below. As $state
// it would self-invalidate (effect_update_depth_exceeded). A non-reactive module let is
// safe to compare-and-store, and surviving remount is the whole point.
let lastSeenDeclinedAt: string | null = null;

/** Whether the user has dismissed the popup for this session. */
export function adminPopupDismissed(): boolean {
  return dismissed;
}

/** Hide the popup for the session (Esc / click-outside). */
export function dismissAdminPopup(): void {
  dismissed = true;
}

/**
 * Feed the latest `uacDeclinedAt` timestamp from the status poll. Re-arms the popup
 * (clears `dismissed`) only on a genuinely NEW decline — a changed, non-null timestamp.
 *
 * Null transitions are deliberately ignored: disabling Cowork clears the declined flag
 * (`uacDeclinedAt` goes non-null → null), and treating that as a "fresh decline" would
 * flash the modal for one frame before the integration-off state propagates.
 */
export function noteUacDeclinedAt(at: string | null): void {
  if (at !== lastSeenDeclinedAt) {
    lastSeenDeclinedAt = at;
    if (at !== null) dismissed = false;
  }
}

/** Test-only reset of module state between cases. */
export function _resetAdminDismissForTests(): void {
  dismissed = false;
  lastSeenDeclinedAt = null;
}
