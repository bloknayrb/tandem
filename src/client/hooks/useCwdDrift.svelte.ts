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
 * Svelte-5 reactive contract. The `mounted`-as-plain-`let` and
 * writes-only-its-own-`$state` rules follow `useReachabilityCheck`; the `epoch`
 * counter has no precedent there (that hook re-arms off `getActive()`), so don't
 * go looking for one.
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
 *   - `state_unsafe_mutation` does not apply to any of the `drift` writes, but
 *     for two different reasons, and only one of them is "async". The writes
 *     after a fetch land in a continuation with no active reaction at all. The
 *     `drift = null` on the no-document path is fully SYNCHRONOUS inside the
 *     effect body — legal because the guard fires on
 *     `DERIVED | BLOCK_EFFECT | ASYNC | EAGER_EFFECT` and a plain `$effect`
 *     carries none of them. Do NOT wrap either in `createCoalescingTick`.
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

/**
 * Accept a `drifted: true` answer only when every field it promises is present.
 * Returns `null` — "say nothing" — for anything else, which is what the rest of
 * the feature already does with every other doubt.
 */
function completeDrift(preview: LauncherCwdPreview): CwdDrift | null {
  if (!preview.drifted) return null;
  const { suggestedCwd, claudeCwd, label, claudeLabel } = preview as Partial<
    Extract<LauncherCwdPreview, { drifted: true }>
  >;
  if (
    typeof suggestedCwd !== "string" ||
    typeof claudeCwd !== "string" ||
    typeof label !== "string" ||
    typeof claudeLabel !== "string"
  ) {
    return null;
  }
  return { suggestedCwd, claudeCwd, label, claudeLabel };
}

/**
 * One-shot report of a rejected probe.
 *
 * Two permanent-rejection states are reachable and neither is otherwise
 * observable from anywhere: the launcher routes are not registered at all (the
 * `if (launcher)` branch in `mcp/server.ts` — stdio mode, tests), so the route
 * 404s forever; and the route is loopback-only, so every LAN/browser client gets
 * a permanent 403. In both, the pill simply never appears, and "you have no
 * drift", "this build has no such route" and "you are not on loopback" are
 * indistinguishable to the user and to whoever they ask.
 *
 * `fetchLauncherStatus` in `actions/builtin.svelte.ts` already models exactly
 * this distinction (`404 → "not-built"`); this is the cheap version of the same
 * honesty. Module-scoped, so it is one line per page load, not per tab switch.
 */
let probeRejectionReported = false;
function noteProbeRejected(status: number): void {
  if (probeRejectionReported) return;
  probeRejectionReported = true;
  console.warn(
    `[Tandem] Working-folder drift check unavailable (HTTP ${status}). ` +
      "The status bar will not report when Claude is running in another folder.",
  );
}

/** Test-only reset of the one-shot rejection latch. */
export function _resetProbeRejectionForTests(): void {
  probeRejectionReported = false;
}

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
    // Subscribe to refresh requests. The launcher's own cwd is not observable
    // from here — `GET /api/launcher/status` exposes it only to loopback callers
    // and `useAiReadiness` does not surface it — so a relaunch's effect is picked
    // up by re-probing, not by keying on the new value. Without this the pill
    // survives a successful relaunch, naming the folder Claude just moved out of,
    // because the document path never changed.
    //
    // Read before the early return for consistency, not for behaviour: with no
    // document open the effect's only action is `drift = null`, and the
    // null→non-null transition re-runs it on the `cwd` dependency regardless. It
    // is placed here so the subscription does not depend on which branch ran.
    const startedAt = epoch;

    if (cwd === null) {
      drift = null;
      return;
    }

    const controller = new AbortController();
    /**
     * May this continuation still write? Every exit path asks — including the
     * failure paths, which is not symmetry for its own sake.
     *
     * A real `fetch` REJECTS when its signal aborts, and the effect cleanup
     * aborts on every re-run. So an abort lands in the `catch` below with
     * `mounted` still true: guarding the failure paths on `mounted` alone means
     * every tab switch, and every one of the two `refresh()` calls fired after a
     * launcher action, blanks the pill for a settle window before it comes back.
     * The user sees the amber chip flicker twice for an action they cancelled.
     */
    const stale = (): boolean => !mounted || controller.signal.aborted || startedAt !== epoch;

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
            noteProbeRejected(res.status);
            // Fail safe to "nothing to say". The alternative — keeping the last
            // answer — would leave an amber pill asserting a folder relationship
            // nobody has checked since the server started refusing to answer.
            if (!stale()) drift = null;
            return;
          }
          preview = (await res.json()) as LauncherCwdPreview;
        } catch {
          if (!stale()) drift = null; // network blip, abort, malformed body
          return;
        }
        if (stale()) return;
        // Validate before trusting. This is the ONE path in the feature where a
        // bad answer becomes a confident false statement rather than silence:
        // a `{ drifted: true }` with missing fields renders "Claude is running in
        // undefined" AND poisons the dismissal key, so one dismissal of that
        // nonsense pair suppresses every real drift afterwards. Version skew is
        // not hypothetical here — the plugin-installed monitor is pinned per
        // release while the desktop server rides the Tauri updater track, with no
        // version handshake between them.
        drift = completeDrift(preview);
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
