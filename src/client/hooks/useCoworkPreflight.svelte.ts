import {
  coworkPreflightSubnet,
  loadInvoke,
  type SubnetPreflight,
} from "../cowork/cowork-invoke.js";

export interface SubnetPreflightState {
  readonly preflight: SubnetPreflight | null;
  readonly probing: boolean;
  /** Start a probe, superseding any in flight. */
  run: () => Promise<void>;
  /** Abandon any in-flight probe and clear the result. */
  reset: () => void;
}

/**
 * Shared state for the Cowork subnet pre-flight (#1298).
 *
 * Three surfaces offer the same Enable button — the onboarding step, Settings,
 * and the integration wizard's sub-view — and each needs the same answer to
 * the same question before showing it. They held three copies of this until a
 * `/simplify` pass; the copies had already drifted on whether dismissing the
 * confirm cleared the result, which is the drift a shared implementation makes
 * impossible rather than merely unlikely.
 *
 * Deliberately holds NO `$effect` and NO `onDestroy`, unlike its sibling
 * `createCoworkStatus`: those force a component context, and this needs none —
 * there is no timer to cancel and no shared cell a late write could clobber.
 * A probe that resolves after unmount writes to a cell nobody reads, which is
 * a no-op, not an error (Svelte 5 has no destroyed-component write guard).
 *
 * Callers must keep the returned object intact. Destructuring
 * `preflight`/`probing` invokes the getters once and freezes the values.
 */
export function createSubnetPreflight(): SubnetPreflightState {
  let preflight = $state<SubnetPreflight | null>(null);
  let probing = $state(false);

  /**
   * Monotonic ticket. A user can open the confirm, dismiss it, and reopen
   * faster than PowerShell answers; only the newest probe may write. It
   * matters most in Settings, which stays mounted after enabling, so a late
   * write there is user-visible rather than landing on a screen already gone.
   */
  let token = 0;

  const run = async (): Promise<void> => {
    const mine = ++token;
    // Synchronous prologue: this lands before Svelte's first flush, so a
    // reopened banner never paints a frame of the previous result.
    probing = true;
    preflight = null;
    try {
      const invoke = await loadInvoke();
      const result = await coworkPreflightSubnet(invoke);
      if (mine !== token) return;
      preflight = result;
    } catch {
      if (mine !== token) return;
      // The bridge itself didn't load. That says nothing about whether
      // enabling would work, so fall through to the unguarded button.
      preflight = { status: "unknown" };
    } finally {
      if (mine === token) probing = false;
    }
  };

  const reset = (): void => {
    token++;
    probing = false;
    preflight = null;
  };

  return {
    get preflight() {
      return preflight;
    },
    get probing() {
      return probing;
    },
    run,
    reset,
  };
}
