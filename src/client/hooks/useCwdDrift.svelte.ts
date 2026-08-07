import { onDestroy } from "svelte";

import { API_LAUNCHER_CWD_PREVIEW } from "../../shared/api-paths.js";
import type { LauncherCwdPreview } from "../../shared/launcher/contract.js";

/**
 * Working-directory drift probe (#1282).
 *
 * Asks the server, for the currently active document, whether relaunching
 * Claude "here" would actually move it. Every decision — validity, sameness,
 * exclusions, labels — is made server-side; this hook holds the answer and the
 * timing. That division is not incidental: #1282's own post-mortem is that the
 * client's derivation and the server's rejection were each tested in isolation
 * and never together, so this side deliberately owns no predicate it could
 * drift out of sync with.
 *
 * Svelte-5 reactive contract (patterned on `useReachabilityCheck`):
 *   - The `$effect` reads exactly two reactive inputs — `getCwd()` and the
 *     `epoch` counter — and never reads `drift`, which is write-only from inside
 *     the effect. `epoch` is `$state` the effect READS but never writes, so
 *     bumping it from `refresh()` re-arms the probe without self-invalidating.
 *   - `mounted` is a plain `let`, not `$state`: a flag the effect both reads and
 *     writes would re-fire it.
 *   - Supersession and unmount are both handled by the `$effect` cleanup plus an
 *     `AbortController`, not by an in-flight flag. An in-flight flag would be
 *     actively wrong here — it drops probes 2..N, so switching quickly between
 *     three tabs leaves the pill answering for the first one.
 *   - `state_unsafe_mutation` does not apply. The `$state` writes happen in an
 *     async continuation, after the synchronous flush has unwound; there is no
 *     active reaction. Do NOT wrap these in `createCoalescingTick`.
 *
 * **Settle delay, not a debounce.** The plan called for a ~250ms debounce plus a
 * ~1.5s dwell before showing. One timer does both jobs: wait for the input to
 * hold still, THEN probe, then render the answer immediately. Tab-flicking past
 * four documents issues zero requests instead of four, and an amber pill can
 * never flash during a switch because nothing was asked yet.
 */

export interface CwdDrift {
  /** Where a relaunch would put Claude (display form, `~`-substituted). */
  suggestedCwd: string;
  /** Where Claude is now (display form). */
  claudeCwd: string;
  /** Shortest label distinguishing `suggestedCwd` from `claudeCwd`. */
  label: string;
  /** The same, for `claudeCwd`. */
  claudeLabel: string;
}

export interface CwdDriftState {
  /** The current drift, or `null` for "nothing to say". */
  readonly drift: CwdDrift | null;
  /** Re-probe now — call after any launcher mutation. */
  refresh: () => void;
}

/** How long the inputs must hold still before we ask. */
const DEFAULT_SETTLE_MS = 1_500;

export interface CwdDriftOptions {
  settleMs?: number;
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

export function createCwdDrift(
  /** The folder a relaunch would target — the caller's OWN derivation from the
   * active document, i.e. the exact value the relaunch request will carry, and
   * already screened for `upload://` scratchpad URIs. Passing the derivation
   * (not the document path) is what keeps the preview and the action from
   * disagreeing about which folder is meant. `null` when there is no eligible
   * document, which clears the nudge. */
  getCwd: () => string | null,
  opts: CwdDriftOptions = {},
): CwdDriftState {
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const baseUrl = opts.baseUrl ?? "";
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);

  let drift = $state<CwdDrift | null>(null);
  let epoch = $state(0);

  // Plain `let` — see the reactive contract above.
  let mounted = true;
  onDestroy(() => {
    mounted = false;
  });

  $effect(() => {
    const cwd = getCwd();
    // Subscribe to refresh requests. Read unconditionally, BEFORE the early
    // return, or a `refresh()` issued while no document is open would not re-arm
    // the effect once one is. The launcher's own cwd is not observable from
    // here — `GET /api/launcher/status` exposes it only to loopback callers and
    // `useAiReadiness` does not surface it — so a relaunch's effect is picked up
    // by re-probing, not by keying on the new value. Without this the pill
    // survives a successful relaunch, naming the folder Claude has just moved
    // into, because the document path never changed.
    const startedAt = epoch;

    if (cwd === null) {
      drift = null;
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        let preview: LauncherCwdPreview;
        try {
          const res = await fetchFn(`${baseUrl}${API_LAUNCHER_CWD_PREVIEW}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd }),
            signal: controller.signal,
          });
          if (!res.ok) {
            // Fail safe to "nothing to say". The alternative — keeping the last
            // answer — would leave an amber pill asserting a folder relationship
            // nobody has checked since the server started refusing to answer.
            if (mounted) drift = null;
            return;
          }
          preview = (await res.json()) as LauncherCwdPreview;
        } catch {
          if (mounted) drift = null; // network blip, abort, malformed body
          return;
        }
        // `startedAt !== epoch` is belt to the cleanup's braces: the effect
        // cleanup aborts this request before a re-run, but an abort that lands
        // between `res.json()` resolving and this line would otherwise let a
        // superseded answer write.
        if (!mounted || controller.signal.aborted || startedAt !== epoch) return;
        drift = preview.drifted
          ? {
              suggestedCwd: preview.suggestedCwd,
              claudeCwd: preview.claudeCwd,
              label: preview.label,
              claudeLabel: preview.claudeLabel,
            }
          : null;
      })();
    }, settleMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  return {
    get drift() {
      return drift;
    },
    refresh: () => {
      epoch += 1;
    },
  };
}
