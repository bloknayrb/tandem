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
 *
 * **How the three surfaces must render this (#1376).** All of them announce the
 * result to a screen reader, and all of them got it wrong the same way, so the
 * rule lives here rather than three times over:
 *
 *  1. The `role="status"` region must be mounted BEFORE any text lands in it —
 *     for the life of the confirm, or of the wizard's sub-view. An ARIA live
 *     region generally has to be in the accessibility tree before its contents
 *     change for the change to be announced; a region inserted together with
 *     its text is commonly not read out at all. That is the whole defect: a
 *     user asked Tandem to check the network, detection failed, and the
 *     sentence saying why was silent.
 *  2. The blocked hint and the in-flight line are ADDITIVE, not an
 *     `{#if}/{:else if}`. `run()` deliberately keeps the previous result (see
 *     the comment on `run` below), so a retry has `probing` and `blocked` set
 *     at once — and swapping would unmount the `-blocked` testid that three
 *     suites read mid-probe.
 */
export function createSubnetPreflight(): SubnetPreflightState {
  let preflight = $state<SubnetPreflight | null>(null);
  let probing = $state(false);

  /**
   * Monotonic ticket. A user can open the confirm, dismiss it, and reopen
   * faster than PowerShell answers; only the newest probe may write.
   */
  let token = 0;

  const run = async (): Promise<void> => {
    const mine = ++token;
    // `preflight` is deliberately NOT cleared here, and `reset()` is the sole
    // owner of clearing it. Nulling it would land before Svelte's first flush,
    // and every surface gates its retry button on `preflight.status ===
    // "blocked"` — so a re-probe would unmount the very button the user just
    // clicked and mount Enable in its place. That is not cosmetic: the second
    // click of a double-click would land on Enable, firing a UAC prompt and a
    // firewall write nobody asked for, and the focused element would be
    // destroyed mid-interaction. Holding the previous result keeps the button
    // mounted so it can say "Checking…" instead.
    //
    // The cost is that every path which closes a surface MUST call `reset()`,
    // or a stale hint paints on reopen. All three do; the tests pin it.
    probing = true;
    try {
      const invoke = await loadInvoke();
      const result = await coworkPreflightSubnet(invoke);
      if (mine !== token) return;
      preflight = result;
    } catch (err) {
      if (mine !== token) return;
      // Reaching here means the bridge didn't load, or `coworkPreflightSubnet`
      // threw rather than resolving — several distinct causes that all say
      // nothing about whether enabling would work, so fall through to the
      // unguarded button. Log it: `unknown` is never rendered, so without this
      // a genuine client fault is invisible on both sides of the bridge.
      console.error("[cowork] subnet pre-flight threw:", err);
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
