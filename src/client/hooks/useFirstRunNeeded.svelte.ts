/**
 * Client-side fetcher for `GET /api/integrations/first-run-needed`.
 *
 * **Why a hook + not a component-level effect:** the wizard auto-open
 * decision must complete *before* the modal mounts. Putting the fetch
 * inside `IntegrationWizardModal.svelte`'s `$effect` would fire only
 * after mount — too late. This hook runs at App.svelte boot (next to
 * `createYjsSync()`) and exposes a derived-readable result.
 *
 * **Stale-fetch guard:** the `beginGen` monotonic counter (mirrored from
 * `useIntegrationWizard.svelte.ts`) ensures a fetch initiated during one
 * hook lifetime can't overwrite state after the hook is torn down or
 * re-fetched. Pattern: every fetch captures the counter value at start;
 * the result is only applied if the captured value still matches the
 * current counter at the time the promise resolves.
 */

import type { FirstRunNeededResponse } from "../../shared/integrations/contract";
import { API_INTEGRATIONS_FIRST_RUN } from "../../shared/integrations/contract";

export interface FirstRunNeededState {
  /** `true` when the server says the wizard should auto-open. `null` while loading. */
  readonly needed: boolean | null;
  /** Server version (from package.json) — wizard dismissal is keyed on this. */
  readonly serverVersion: string | null;
  /** Per-session nonce — apply endpoint requires this in its body. */
  readonly confirmationNonce: string | null;
  /** True once the initial fetch has settled (success OR network error). */
  readonly settled: boolean;
  /** Re-fetch — used before transitioning the wizard to visible to catch
   *  concurrent persists from another tab / `tandem setup --apply`. */
  refetch(): Promise<void>;
}

/**
 * Build a stateful first-run-needed reader. Caller must ensure the
 * returned object's lifetime matches the wizard's auto-open lifecycle
 * (typically: created in App.svelte at module top, lives as long as the
 * app is mounted).
 */
export function createFirstRunNeeded(): FirstRunNeededState {
  let needed = $state<boolean | null>(null);
  let serverVersion = $state<string | null>(null);
  let confirmationNonce = $state<string | null>(null);
  let settled = $state(false);
  let gen = 0;

  async function fetchOnce(): Promise<void> {
    const captured = ++gen;
    try {
      const res = await fetch(API_INTEGRATIONS_FIRST_RUN, { credentials: "same-origin" });
      if (captured !== gen) return; // a newer fetch has started or hook torn down
      if (!res.ok) {
        // Treat network/server failure as "wizard not needed" — the safer
        // default is to NOT auto-open when we can't reach the server. The
        // user can still manually open via Settings → Reopen wizard.
        needed = false;
        settled = true;
        return;
      }
      const body = (await res.json()) as Partial<FirstRunNeededResponse>;
      if (captured !== gen) return;
      needed = body.needed === true;
      serverVersion = typeof body.serverVersion === "string" ? body.serverVersion : null;
      confirmationNonce =
        typeof body.confirmationNonce === "string" ? body.confirmationNonce : null;
      settled = true;
    } catch {
      if (captured !== gen) return;
      needed = false;
      settled = true;
    }
  }

  // Kick off the initial fetch. We deliberately do NOT wrap this in
  // `$effect.root` — the hook caller's effect lifetime is the right
  // anchor, and the captured-gen guard handles the stale-write case
  // even when the hook outlives a component.
  void fetchOnce();

  return {
    get needed() {
      return needed;
    },
    get serverVersion() {
      return serverVersion;
    },
    get confirmationNonce() {
      return confirmationNonce;
    },
    get settled() {
      return settled;
    },
    refetch: fetchOnce,
  };
}
