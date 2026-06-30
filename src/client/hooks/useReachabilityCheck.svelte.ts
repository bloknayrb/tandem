import { onDestroy, untrack } from "svelte";

import { API_HEALTH } from "../../shared/api-paths.js";

/**
 * Post-apply reachability verification for the integration wizard's Done step
 * (#1174, gap #1).
 *
 * After the wizard writes Claude's MCP config it reports only file-write
 * success. This hook adds the missing round-trip: it confirms the Tandem MCP
 * server actually ANSWERS at the URL the config points at, and then watches —
 * live, non-blocking — for Claude itself to connect.
 *
 * Two transports, two honest semantics:
 *   - HTTP target (claude-code, `http://127.0.0.1:3479/mcp`): the config points
 *     at the SAME server the wizard talks to, so one loopback `GET /health`
 *     verifies it — 200 → `reachable`, non-OK/throw/timeout → `unreachable`.
 *   - stdio target (claude-desktop, `npx … mcp-stdio`): no running server to
 *     probe (Claude Desktop spawns the process at launch), so it is rendered
 *     `not-applicable` — NEVER a false green check.
 *
 * Two distinct signals:
 *   1. `serverUp` — the verify verdict (the HTTP config points at a live server).
 *   2. `claudeConnected` — a bounded background poll of `/health.hasSession`
 *      flipping true (Claude restarted and connected). A one-way latch.
 *
 * Svelte-5 reactive contract (mirrors `useClaudeCliStatus` / `useAiReadiness` /
 * `useCoworkStatus`):
 *   - `getActive` is PURE (reads only externals). The verify `$effect` reads
 *     ONLY `getActive()` reactively; `getTargets()` is SNAPSHOTTED once via
 *     `untrack` so it never re-subscribes the effect to `wizard.applyResults` /
 *     `wizard.picked` (that would re-fire the whole verify + poll on unrelated
 *     churn / reopen). The effect only WRITES its own `$state`, never reads it.
 *   - `mounted` / `intervalId` / `healthSeq` are plain `let`s (a `$state` flag
 *     the effect reads-and-writes would re-fire it); `cancelled` is declared
 *     fresh per activation.
 *   - The poll interval is OWNED by the `$effect` (created in the activation
 *     branch) and cleared in BOTH the effect cleanup AND `onDestroy`, every
 *     clear null-guarded — leak-free across deactivate → reactivate.
 *   - Verify GET and every poll tick hit the same `/health` and write the same
 *     `hasSession`-derived state, so they share ONE last-issued-wins ticket
 *     (`healthSeq`); `claudeConnected` is additionally a latch (once true, never
 *     written false) so a slow verify resolving after a poll tick can't demote.
 */

/** Loopback `/health` response; `hasSession` is loopback-only (absent → unknown). */
interface HealthResponse {
  status?: string;
  hasSession?: boolean;
}

export type ReachabilityStatus = "reachable" | "unreachable" | "not-applicable" | "verifying";

export interface ReachabilityResult {
  id: string;
  status: ReachabilityStatus;
}

export interface ReachabilityTarget {
  id: string;
  transport: "http" | "stdio";
}

export type ReachabilityPhase = "idle" | "verifying" | "done";

export interface ReachabilityCheckState {
  /** Drives the transient "Verifying…" banner. */
  readonly phase: ReachabilityPhase;
  /** Verify verdict for HTTP targets: `null` until verified / no HTTP target. */
  readonly serverUp: boolean | null;
  /** `hasSession` observed true during the bounded poll. One-way latch. */
  readonly claudeConnected: boolean;
  /** Per-target reachability rows (keyed to apply-result ids). */
  readonly results: ReachabilityResult[];
}

/** Timings (overridable in tests). Verify timeout matches doctor's `httpGet`. */
export interface ReachabilityCheckOptions {
  verifyTimeoutMs?: number;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
}

const DEFAULT_VERIFY_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_DEADLINE_MS = 20_000;

export function createReachabilityCheck(
  getTargets: () => ReachabilityTarget[],
  getActive: () => boolean,
  baseUrl = "",
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  opts: ReachabilityCheckOptions = {},
): ReachabilityCheckState {
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollDeadlineMs = opts.pollDeadlineMs ?? DEFAULT_POLL_DEADLINE_MS;

  let phase = $state<ReachabilityPhase>("idle");
  let serverUp = $state<boolean | null>(null);
  let claudeConnected = $state(false);
  let results = $state<ReachabilityResult[]>([]);

  // Plain (non-reactive) lifecycle guards — a $state flag the effect both reads
  // and writes would re-fire it.
  let mounted = true;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  // Shared ticket across the verify read and every poll tick (last-issued-wins).
  let healthSeq = 0;

  function clearPoll(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  onDestroy(() => {
    mounted = false;
    clearPoll();
    healthSeq++; // invalidate any in-flight read so it can't latch post-unmount
  });

  /**
   * One ordered `/health` read. Latches `claudeConnected` to true only when this
   * is still the most-recently-issued read (so a slow older response can't write
   * a stale value) and the field is present and true. `null` hasSession (blip /
   * non-OK / malformed / loopback field absent) never demotes — and the latch
   * never writes false at all. Returns the verdict for the caller to act on.
   */
  async function probeHealth(
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; hasSession: boolean | null }> {
    const mine = ++healthSeq;
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}${API_HEALTH}`, signal ? { signal } : undefined);
    } catch {
      return { ok: false, hasSession: null }; // network blip / abort
    }
    if (!res.ok) return { ok: false, hasSession: null };
    let body: HealthResponse | null = null;
    try {
      body = (await res.json()) as HealthResponse;
    } catch {
      body = null; // malformed body
    }
    const hasSession = body && typeof body.hasSession === "boolean" ? body.hasSession : null;
    if (hasSession === true && mine === healthSeq && mounted) claudeConnected = true;
    return { ok: true, hasSession };
  }

  $effect(() => {
    if (!getActive()) {
      // Reset so a reopen never renders a stale "Verifying…" banner.
      phase = "idle";
      clearPoll();
      return;
    }

    let cancelled = false;

    // Snapshot targets ONCE — sever the reactive edge to wizard.applyResults /
    // wizard.picked. Targets are settled by the time step === "done".
    const targets = untrack(() => getTargets()).map((t) => ({ ...t }));
    const hasHttpTarget = targets.some((t) => t.transport === "http");

    // Fresh verification cycle: latch resets here (distinct from the
    // never-demote-within-a-cycle rule).
    claudeConnected = false;
    serverUp = null;
    results = targets.map((t) => ({
      id: t.id,
      status: t.transport === "http" ? "verifying" : "not-applicable",
    }));

    if (!hasHttpTarget) {
      // Nothing health-probable (all stdio / skipped / errored) — done immediately.
      phase = "done";
      return () => {
        cancelled = true;
        clearPoll();
      };
    }

    phase = "verifying";

    const controller = new AbortController();
    const verifyTimeout = setTimeout(() => controller.abort(), verifyTimeoutMs);

    void (async () => {
      const { ok, hasSession } = await probeHealth(controller.signal);
      clearTimeout(verifyTimeout);
      if (cancelled || !mounted) return;

      serverUp = ok;
      // Rebuild rows from the SNAPSHOT (not from `results`), so the effect's
      // async continuation never reads the hook's own reactive state.
      results = targets.map((t) => ({
        id: t.id,
        status: t.transport === "http" ? (ok ? "reachable" : "unreachable") : "not-applicable",
      }));
      phase = "done";

      // Bounded live poll for Claude actually connecting (nice-to-have).
      if (!ok || hasSession === true) return; // already connected → latched, no poll
      const deadline = Date.now() + pollDeadlineMs;
      intervalId = setInterval(() => {
        if (cancelled || !mounted || claudeConnected || Date.now() >= deadline) {
          clearPoll();
          return;
        }
        void probeHealth().then(() => {
          if (claudeConnected) clearPoll();
        });
      }, pollIntervalMs);
    })();

    return () => {
      cancelled = true;
      clearTimeout(verifyTimeout);
      controller.abort();
      clearPoll();
    };
  });

  return {
    get phase() {
      return phase;
    },
    get serverUp() {
      return serverUp;
    },
    get claudeConnected() {
      return claudeConnected;
    },
    get results() {
      return results;
    },
  };
}
