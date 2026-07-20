/**
 * AI-readiness reader (#1018/#1022/#1054).
 *
 * "AI" in Tandem today is the external Claude Code integration. The
 * auto-launcher (#477 PR 4) can spawn and supervise it, but it is NOT the only
 * way an agent connects: a user can launch Claude Code manually from a terminal
 * with the tandem MCP server configured. That externally-launched agent is
 * invisible to the launcher (which only knows about the process IT spawned), so
 * the launcher truthfully reports `running: false` even while the agent is live
 * (#1054).
 *
 * Readiness therefore folds in TWO signals:
 *   1. The launcher's `GET /api/launcher/status` — the supervised process.
 *   2. The server's `GET /health` `hasSession` field (loopback-only) — whether
 *      ANY MCP client transport is currently open, supervised or not. This is
 *      the authoritative "an agent is actually connected" signal.
 *
 * An active MCP session means AI works regardless of launcher state, so it
 * promotes readiness to `ready` and suppresses both the restart CTA and the
 * "no AI is connected" send notice. Without it, a manually-launched session
 * would show "Restart Claude Code" — and clicking it would spawn a SECOND agent
 * on the same documents (#1054).
 *
 * Readiness keys on these connection facts — NOT the document-sync connection
 * (the green "Synced" dot) and NOT `claudeActive` (Claude's *activity* presence:
 * it flaps to `false` every few seconds when Claude is idle between tool calls,
 * so gating a setup CTA on it would make a working user's chip oscillate).
 * `claudeActive` stays the idle/working animation on the status dot.
 *
 * States:
 *   - `booting`      — not yet known (still connecting / first status read
 *                      pending). Render nothing; never flash a CTA on boot.
 *   - `unconfigured` — launcher unavailable (`available: false`: stdio mode,
 *                      disabled, or no claude-code integration) AND no active
 *                      MCP session. Prompt setup.
 *   - `stopped`      — configured but not running (`available: true,
 *                      running: false` — crashed/stopped) AND no active MCP
 *                      session. Prompt restart, NOT the setup wizard (the user
 *                      is already set up).
 *   - `ready`        — Claude Code running OR an MCP session is active.
 *
 * `chip` folds in Solo-mode suppression: in Solo mode the user has deliberately
 * chosen to work without AI surfacing, so a persistent "Connect AI" nag would
 * contradict that intent.
 *
 * Fail-safe: a transient fetch failure (network blip, non-OK) keeps the PRIOR
 * value rather than clobbering to a scarier state — mirroring
 * `useFirstRunNeeded`'s "don't assert a scary state on a hiccup" discipline.
 * This applies to both the launcher status and `hasSession`, so a momentary
 * `/health` blip never flips a connected agent's chip back on.
 */
import { onDestroy } from "svelte";
import { API_HEALTH, API_LAUNCHER_STATUS } from "../../shared/api-paths.js";
import type { LauncherStatus } from "../../shared/launcher/contract.js";
import { API_BASE } from "../utils/fileUpload.js";

/** Loopback `/health` response. `hasSession` is omitted for non-loopback
 * callers; the client only ever talks to 127.0.0.1 so it is present in
 * practice, but absence is treated as "unknown" (no promotion). */
interface HealthResponse {
  status?: string;
  hasSession?: boolean;
}

export type AiReadinessState = "booting" | "unconfigured" | "stopped" | "ready";

/** What the titlebar/empty-state CTA should offer, or `null` to show nothing. */
export type AiChip = "connect" | "restart" | null;

/**
 * The affirmative "an agent is connected" indicator, or `null` when there's
 * nothing positive to assert (no session, or still booting). Distinct from
 * `chip` (which is the *negative*-state CTA): `chip` and `liveIndicator` are
 * mutually exclusive in practice and MUST stay separate — folding an
 * affirmative value into `chip` would break the `chip === null` guards that
 * gate the "no AI is connected" send notice (App.svelte) and collide with the
 * titlebar CTA/default-model branches.
 *   - `connected`   — an MCP session is open and mode is Tandem: events flow.
 *   - `solo-paused` — an MCP session is open but mode is Solo: chat still works,
 *                     but the AI won't see the user's edits/comments
 *                     (`sse-consumer.ts` drops non-`chat:message` events in Solo).
 */
export type AiLiveIndicator = "connected" | "solo-paused" | null;

export interface AiReadiness {
  readonly state: AiReadinessState;
  /** The CTA to surface, with Solo-mode suppression already applied. */
  readonly chip: AiChip;
  /**
   * The affirmative connected indicator, keyed on the authoritative MCP-session
   * signal (`hasSession`) — NOT on `state`, which also reaches `ready` from the
   * launcher's `running: true` with no open session (auto-launched desktop
   * startup window), where an "AI connected" badge would be a false green.
   */
  readonly liveIndicator: AiLiveIndicator;
  /** Re-poll launcher status + session now (e.g. just after a restart). */
  refresh: () => void;
  /**
   * Fresh, awaitable MCP-session check for moment-of-send decisions (#1083).
   *
   * The polled `chip` can be up to POLL_MS stale: an agent whose MCP
   * `initialize` landed after the last background poll still reads as absent,
   * so the "no AI is connected" send notice would fire while the agent is
   * live. Callers about to alarm on `chip !== null` should confirm with this
   * probe first.
   *
   * Returns `true` only when a fresh `/health` read confirms an open MCP
   * transport. On fetch failure or a redacted body (no `hasSession` field) it
   * returns the last-known polled value — mirroring the poll's "keep prior
   * value on a blip" fail-safe in both directions.
   */
  probeSession: () => Promise<boolean>;
}

const POLL_MS = 8_000;

export function createAiReadiness(deps: {
  connected: () => boolean;
  firstRunSettled: () => boolean;
  soloMode: () => boolean;
}): AiReadiness {
  let status = $state<LauncherStatus | null>(null);
  // Whether an MCP client transport is currently open (from `/health`). An
  // active session means AI works regardless of launcher state (#1054).
  let mcpSessionActive = $state(false);
  // Have we ever read launcher status successfully? Distinguishes "still
  // booting" from a genuine `available: false`, so the chip never flashes
  // during cold start. `/health` is not gated on this: readiness derives
  // `booting` until launcher status settles, and `hasSession` only ever
  // PROMOTES to ready (never demotes), so a missing first `/health` read can't
  // surface a false CTA.
  let settledOnce = $state(false);

  // Drop stale async resolves for LAUNCHER reads (a poll that resolves after
  // the component is gone, or after a newer poll superseded it). Mirrors
  // useFirstRunNeeded's gen. `/health` reads use their own ordering (see
  // `healthSeq`) because `probeSession` issues out-of-band reads that must
  // never cancel — nor be clobbered by — an in-flight background poll.
  let gen = 0;
  // Ticket counter for `/health` reads, shared by the background poll and
  // `probeSession`: only the most recently ISSUED read may write state, so an
  // older response resolving late can never overwrite a fresher one.
  let healthSeq = 0;
  let destroyed = false;

  async function pollLauncherStatus(mine: number): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${API_LAUNCHER_STATUS}`);
    } catch {
      return; // network blip — keep prior status (fail-safe)
    }
    if (mine !== gen) return;
    if (!res.ok) return; // transient server error — keep prior status
    try {
      status = (await res.json()) as LauncherStatus;
      settledOnce = true;
    } catch {
      // malformed body — keep prior status
    }
  }

  /** One `/health` read. `null` means "unknown" (network blip, non-OK,
   *  malformed body, or the loopback-only `hasSession` field is absent) —
   *  callers keep their prior value rather than demote to false. */
  async function fetchHasSession(): Promise<boolean | null> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${API_HEALTH}`);
    } catch {
      return null; // network blip
    }
    if (!res.ok) return null; // transient server error
    try {
      const body = (await res.json()) as HealthResponse;
      // Only trust the field when present (loopback). Absence is "unknown",
      // not "no session".
      return typeof body.hasSession === "boolean" ? body.hasSession : null;
    } catch {
      return null; // malformed body
    }
  }

  /** One ordered `/health` read (shared by the background poll and
   *  `probeSession`). Writes `mcpSessionActive` only when this is still the
   *  most recently issued read — last-issued-wins, so a slow older response
   *  can never clobber a fresher one (e.g. a poll that sampled "no session"
   *  just before the agent's initialize, resolving after the probe that saw
   *  it). A dropped write is recovered by the next interval poll. Returns the
   *  fetched value either way so callers can act on their own read. */
  async function readHasSession(): Promise<boolean | null> {
    const mine = ++healthSeq;
    const fresh = await fetchHasSession();
    if (fresh !== null && mine === healthSeq && !destroyed) {
      mcpSessionActive = fresh;
    }
    return fresh;
  }

  /** See `AiReadiness.probeSession`. Issues a fresh `/health` read (which also
   *  folds into polled state, clearing the titlebar chip immediately instead
   *  of waiting out the poll interval) and answers with the freshest data it
   *  has — falling back to the last-known polled value when the read fails. */
  async function probeSession(): Promise<boolean> {
    const fresh = await readHasSession();
    return fresh ?? mcpSessionActive;
  }

  function poll(): void {
    const mine = ++gen;
    void pollLauncherStatus(mine);
    void readHasSession();
  }

  poll();
  const interval = setInterval(() => poll(), POLL_MS);
  onDestroy(() => {
    gen++;
    destroyed = true;
    clearInterval(interval);
  });

  const state = $derived.by((): AiReadinessState => {
    if (!deps.firstRunSettled() || !deps.connected() || !settledOnce || status === null) {
      // NOTE: this booting gate intentionally OUTRANKS the mcpSessionActive
      // promotion below. If the launcher route (`/api/launcher/status`) fails
      // permanently, `status` stays null / `settledOnce` stays false, so a live
      // MCP session is rendered as "booting" (chip suppressed) rather than
      // "ready" — never a false CTA, but also never an affirmative ready. This
      // precedence is deliberate (don't flash a state until the launcher truth
      // settles); it is not an oversight. A never-settling launcher masking a
      // live session is the accepted trade-off.
      return "booting";
    }
    // An active MCP session means an agent is connected and AI works, whether
    // or not the launcher spawned it. Promote to ready and skip the CTA.
    if (mcpSessionActive) return "ready";
    if (status.available === false) return "unconfigured";
    return status.running === true ? "ready" : "stopped";
  });

  const chip = $derived.by((): AiChip => {
    if (deps.soloMode()) return null;
    if (state === "unconfigured") return "connect";
    if (state === "stopped") return "restart";
    return null;
  });

  // The affirmative indicator keys on `mcpSessionActive` (an open MCP transport,
  // proven by a real `initialize` round-trip) — the honest subset of `ready`.
  // `state === "ready"` also fires from the launcher `running: true` branch with
  // no session, so keying on `state` would render "AI connected" with nothing
  // connected. When no session is open there is nothing affirmative to say
  // (`null`); Solo-with-no-session is still `null` — "AI won't see your edits"
  // only makes sense once an AI is actually connected.
  const liveIndicator = $derived.by((): AiLiveIndicator => {
    if (!mcpSessionActive) return null;
    return deps.soloMode() ? "solo-paused" : "connected";
  });

  return {
    get state() {
      return state;
    },
    get chip() {
      return chip;
    },
    get liveIndicator() {
      return liveIndicator;
    },
    refresh: () => poll(),
    probeSession,
  };
}
