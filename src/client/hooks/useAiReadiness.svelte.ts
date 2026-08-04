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
 *      the authoritative "an agent is actually connected" signal for clients
 *      that perform an MCP `initialize` handshake. MCP `2026-07-28` removed
 *      that handshake and protocol-level sessions, so the field goes silent
 *      about clients on that revision — see #1249 before treating a `false`
 *      here as "no agent". Note this hook is NOT promotion-only with respect
 *      to it: `readHasSession` writes any non-null value, so a confident
 *      `false` demotes both `state` and `liveIndicator`.
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
import {
  isTransientlyUnavailable,
  type LauncherErrorCode,
  type LauncherStatus,
} from "../../shared/launcher/contract.js";
import { API_BASE } from "../utils/fileUpload.js";

/** Loopback `/health` response. `hasSession` is omitted for non-loopback
 * callers; the client only ever talks to 127.0.0.1 so it is present in
 * practice, but absence is treated as "unknown" (no promotion). */
interface HealthResponse {
  status?: string;
  hasSession?: boolean;
}

export type AiReadinessState = "booting" | "unconfigured" | "stopped" | "ready";

/**
 * What the titlebar/empty-state CTA should offer, or `null` to show nothing.
 * This is the SINGLE source of truth for which CTA a `stopped` state gets —
 * views must switch on this value alone, never re-derive their own decision
 * from `lastError` (that duplication is exactly how the titlebar and empty
 * state CTAs drifted out of sync; see #1268).
 *   - `connect` — never configured (`state === "unconfigured"`). Opens the
 *     integration wizard.
 *   - `setup`   — configured but stopped with the circuit breaker tripped
 *     (`lastError === "circuit-open"`). This — NOT `binary-not-found` — is
 *     the branch that actually fires when the Claude Code CLI isn't
 *     installed: the supervisor spawns the bundled reaper (which always
 *     exists), and the reaper's own exec of the (missing) `claude` binary
 *     fails internally and exits with code 127 — an ordinary process exit,
 *     not a Node `ENOENT` on the reaper spawn itself. That routes through
 *     `scheduleRestart`, which retries and eventually trips the breaker
 *     (`circuit-open`), never through the `child.on("error")` handler that
 *     sets `binary-not-found`. `binary-not-found` is reserved for the
 *     genuinely rare case where the *reaper* binary is missing/unrunnable —
 *     a broken Tandem install, not a missing Claude CLI — and gets no
 *     special CTA (falls into `restart`, since retrying the reaper spawn is
 *     the only available action). Opens the integration wizard, same as
 *     `connect`, but with install-specific copy.
 *   - `restart` — configured but stopped for any other reason (including the
 *     rare `binary-not-found`). Plain restart.
 */
export type AiChip = "connect" | "setup" | "restart" | null;

/**
 * Everything a surface needs to render an `AiChip`'s call to action: its copy
 * and, crucially, WHICH action it performs.
 *
 * A `Record` keyed on the union rather than a ternary at each call site, and
 * the `action` discriminant is the whole point. `AiChip` grew from two members
 * to three, and every widening silently left binary `chip === "connect" ? a : b`
 * ternaries behind — they keep compiling, and the new member just falls down
 * the wrong branch. That is not hypothetical: it shipped. The "no AI connected"
 * toast in `App.svelte` offered `setup` users "Restart Claude Code" wired to
 * `restartClaude()`, re-triggering the doomed spawn loop that tripped the
 * circuit breaker in the first place — the exact opposite of the intended
 * "install the CLI".
 *
 * With this map a fourth member is a type error at every consumer instead.
 */
export const AI_CTA: Record<
  Exclude<AiChip, null>,
  {
    /** Short button/CTA text. */
    label: string;
    /** `title` attribute — the hover explanation. */
    title: string;
    ariaLabel: string;
    /** Which handler this CTA must invoke. `setup` resolves to `connect`: the
     * install flow IS the integration wizard, only with different copy. */
    action: "connect" | "restart";
  }
> = {
  connect: {
    label: "Connect AI",
    title: "AI isn't set up — connect Claude Code",
    ariaLabel: "AI isn't set up. Connect Claude Code.",
    action: "connect",
  },
  setup: {
    label: "Set up Claude Code",
    title: "Claude Code needs to be installed",
    ariaLabel: "Claude Code needs to be installed. Set up Claude Code.",
    action: "connect",
  },
  restart: {
    label: "Restart Claude Code",
    title: "Claude Code stopped — restart it",
    ariaLabel: "Claude Code has stopped. Restart Claude Code.",
    action: "restart",
  },
};

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
 *                     but the AI won't see the user's edits/comments (the server
 *                     withholds them — `server/events/queue.ts`
 *                     `isUserPrivacyHeld` + `shouldForwardExternally`).
 */
export type AiLiveIndicator = "connected" | "solo-paused" | null;

export interface AiReadiness {
  readonly state: AiReadinessState;
  /** The CTA to surface, with Solo-mode suppression already applied. */
  readonly chip: AiChip;
  /** Last scrubbed error code from supervisor when state is stopped. */
  readonly lastError?: LauncherErrorCode;
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
    if (status.available === false) {
      // Autostart deferral (#1236): the app was launched by the OS at login and
      // deliberately held the Claude launcher back. Nothing is misconfigured —
      // the Rust shell fires the deferred start the moment the window is shown,
      // so this state resolves on its own within a poll or two. Rendering it as
      // "unconfigured" would show a fully-configured user the setup-wizard
      // "connect" CTA, which is worse than saying nothing. "booting" is exactly
      // right: transient, chip suppressed.
      //
      // `reason` is loopback-only, so a LAN viewer sees bare
      // `{ available: false }` and still lands on "unconfigured" — correct, since
      // a LAN viewer cannot act on the deferral anyway.
      if (isTransientlyUnavailable(status.reason)) return "booting";
      return "unconfigured";
    }
    return status.running === true ? "ready" : "stopped";
  });

  // `status` is a discriminated union on `available` (and, once available,
  // `running`) — narrow on those tags rather than probing shape with `in`
  // checks, which only happen to work because the `available: false` arm
  // lacks a `running` field.
  const lastError = $derived<LauncherErrorCode | undefined>(
    status !== null && status.available && !status.running ? status.lastError : undefined,
  );

  // `chip` is the ONE place the `lastError` → CTA decision is made (see the
  // `AiChip` doc comment for why `circuit-open`, not `binary-not-found`, is
  // the branch that means "go install Claude Code"). Views must render off
  // this value alone, not re-derive their own copy of this ternary.
  const chip = $derived<AiChip>(
    deps.soloMode()
      ? null
      : state === "unconfigured"
        ? "connect"
        : state === "stopped"
          ? lastError === "circuit-open"
            ? "setup"
            : "restart"
          : null,
  );

  // The affirmative indicator keys on `mcpSessionActive` (an open MCP transport,
  // proven by a real `initialize` round-trip) — the honest subset of `ready`.
  // `state === "ready"` also fires from the launcher `running: true` branch with
  // no session, so keying on `state` would render "AI connected" with nothing
  // connected. When no session is open there is nothing affirmative to say
  // (`null`); Solo-with-no-session is still `null` — "AI won't see your edits"
  // only makes sense once an AI is actually connected.
  const liveIndicator = $derived<AiLiveIndicator>(
    !mcpSessionActive ? null : deps.soloMode() ? "solo-paused" : "connected",
  );

  return {
    get state() {
      return state;
    },
    get chip() {
      return chip;
    },
    get lastError() {
      return lastError;
    },
    get liveIndicator() {
      return liveIndicator;
    },
    refresh: () => poll(),
    probeSession,
  };
}
