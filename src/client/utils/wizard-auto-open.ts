/**
 * Whether the setup wizard opens by itself (#2198). Pure, because App — which
 * owns the decision — is never mounted in tests.
 *
 *   - The server decides that it is needed at all (`needed`, a hard gate).
 *   - Closed during this server launch (App keys it on the server's
 *     `launchId`, in localStorage; page memory for an older server): not
 *     again until the next launch — for both the first run and the v1.0
 *     walkthrough.
 *   - The v1.0 walkthrough ignores the per-version localStorage dismissal:
 *     Bryan's rule is that closing it brings it back next launch, and only
 *     Keep or a successful Apply ends it (the server's marker).
 *   - Otherwise the first-run rule as before: once dismissed for a server
 *     version, not again for that version.
 */
export interface WizardAutoOpenInput {
  needed: boolean | null;
  walkthrough: boolean;
  serverVersion: string | null;
  dismissedForVersion: string | null;
  closedThisSession: boolean;
}

export function resolveWizardAutoOpen(i: WizardAutoOpenInput): boolean {
  if (i.needed !== true || i.serverVersion === null) return false;
  if (i.closedThisSession) return false;
  if (i.walkthrough) return true;
  return i.dismissedForVersion !== i.serverVersion;
}
