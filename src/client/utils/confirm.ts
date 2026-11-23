/**
 * Ask the user an OK/Cancel question and resolve with their answer.
 *
 * Always use this instead of `window.confirm` / bare `confirm` (lint and
 * `tests/client/no-raw-confirm.test.ts` enforce it). In the browser
 * `window.confirm` is synchronous and returns a boolean, but in the desktop app
 * `tauri-plugin-dialog`'s init script replaces it with an **async** function
 * that returns a `Promise<boolean>`. A caller that writes
 * `if (!confirm(msg)) return;` then sees a Promise, which is always truthy, so
 * the guarded action runs before the user has answered and Cancel does
 * nothing. Awaiting the result here works for both implementations.
 *
 * A failed dialog (for example the IPC call rejecting) answers `false`: every
 * caller guards something destructive, so "not confirmed" is the safe reading.
 *
 * The same plugin also makes `window.alert` asynchronous. That changes only
 * ordering (the code after it no longer waits for the dialog), never whether
 * an action runs, so `alert` callers are left alone.
 */
export async function confirmDialog(message: string): Promise<boolean> {
  try {
    // The cast widens the DOM typing to cover the Tauri override.
    // eslint-disable-next-line no-restricted-properties -- this is the one sanctioned call site
    const answer = await (window.confirm(message) as boolean | Promise<boolean>);
    return answer === true;
  } catch (err) {
    console.warn("[Tandem] confirm dialog failed; treating it as Cancel", err);
    return false;
  }
}
