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
 *   2. The server's `GET /health` `hasSession` and `sessionCount` fields
 *      (loopback-only). `hasSession` says whether ANY MCP session is in the
 *      registry, supervised or not, including a client that went away without
 *      disconnecting; `sessionCount` counts the LIVE ones. Together they are
 *      the "an agent is actually connected" signal (`sessionLive`: a session
 *      and a live count, or a session with no count reported) for clients
 *      that perform an MCP `initialize` handshake. MCP `2026-07-28` removed
 *      that handshake and protocol-level sessions, so the field goes silent
 *      about clients on that revision — see #1249 before treating a `false`
 *      here as "no agent". Note this hook is NOT promotion-only with respect
 *      to it: `readHasSession` writes any non-null value, so a confident
 *      `false` demotes both `state` and `liveIndicator` — as does a sustained
 *      inability to reach the server at all (see the fail-safe note below).
 *
 * A live MCP session means AI works regardless of launcher state, so it
 * promotes readiness to `ready` and suppresses both the restart CTA and the
 * "no AI is connected" send notice. Without it, a manually-launched session
 * would show "Restart Claude Code" — and clicking it would spawn a SECOND agent
 * on the same documents (#1054).
 *
 * Readiness keys on these connection facts — NOT the document-sync connection
 * (the green "Synced" dot) and NOT `claudeActive` (Claude's *activity* presence:
 * it flaps to `false` every few seconds when Claude is idle between tool calls,
 * so gating a setup CTA on it would make a working user's chip oscillate).
 * `claudeActive` stays the idle/working animation on the status dot — except
 * beside Tandem's own launched Claude, where the status pill shows only the
 * supervisor's `busy` (`launcherBusy`), because presence can't be attributed to
 * the chat's session (#2167).
 *
 * States:
 *   - `booting`      — not yet known (still connecting / first status read
 *                      pending, or a launcher stopped as `unlicensed` while
 *                      the client's licence view still says AI is on — see
 *                      `staleLicenceStop`). Render nothing; never flash a CTA.
 *   - `unconfigured` — launcher unavailable (`available: false`: stdio mode,
 *                      disabled, or `not-configured` — no launchable claude-code
 *                      integration, #2180) AND no live MCP session. Prompt setup.
 *   - `stopped`      — `available: true, running: false` AND no live MCP
 *                      session. Prompt restart, NOT the setup wizard — unless
 *                      the server says a restart is already under way
 *                      (`restartPending`), when `chip` is null and the pill
 *                      shows "Restarting Claude…" (`launcherRestarting`).
 *   - `ready`        — Claude Code running OR an MCP session is live.
 *
 * `chip` folds in Solo-mode suppression: in Solo mode the user has deliberately
 * chosen to work without AI surfacing, so a persistent "Connect AI" nag would
 * contradict that intent.
 *
 * Fail-safe, and its limit: a transient `/health` failure keeps the PRIOR value
 * rather than clobbering to a scarier state — mirroring `useFirstRunNeeded`'s
 * "don't assert a scary state on a hiccup" discipline. But "transient" used to
 * mean *every* way a read could fail to produce an answer, including the server
 * not being there at all, and a fail-safe with no floor is just a lie with good
 * manners: the pill went on reporting "AI connected" indefinitely against a
 * process that had exited, next to the disconnection banner saying otherwise.
 *
 * So the read is now discriminated (see `fetchHealth`) around a narrower
 * question than "did something answer": did OUR server answer. Only a 200 with
 * a body that reads and parses counts; anything else accrues a strike, and two
 * consecutive strikes **from the poll path** demote. `readHasSession` documents
 * why the count sits above the staleness guard and why only increments are
 * poll-gated.
 *
 * `pollLauncherStatus` has the same floor, off the same `makeStrikeCounter`,
 * clearing `status` to null (→ "booting", i.e. "we do not know") rather than to
 * a fabricated launcher state. Its strike rule is deliberately narrower: unlike
 * `makeHealthHandler`, the launcher route genuinely can fail, so a non-OK there
 * really is the server answering.
 *
 * `serverUnreachable` is the one signal that distinguishes "no AI is attached to
 * a working server" from "the server is gone". Downstream those need opposite
 * messages, and before it existed they were indistinguishable — see the field's
 * doc on `AiReadiness`.
 */
import { onDestroy, untrack } from "svelte";
import { API_HEALTH, API_LAUNCHER_STATUS } from "../../shared/api-paths.js";
import {
  isTransientlyUnavailable,
  type LauncherErrorCode,
  type LauncherStatus,
} from "../../shared/launcher/contract.js";
import { deliveryStall } from "../status/delivery-stall.js";
import { API_BASE } from "../utils/fileUpload.js";
import type { AiNotice } from "../utils/license-ui.js";

/** Loopback `/health` response. `hasSession` and `push` are omitted for
 * non-loopback callers; the client only ever talks to 127.0.0.1 so they are
 * present in practice, but absence is treated as "unknown" (no promotion). */
interface HealthResponse {
  status?: string;
  hasSession?: boolean;
  /** Distinct MCP clients in the registry — an upper bound; see
   *  `countDistinctClients` in `server/mcp/transport-registry.ts`. */
  sessionCount?: number;
  push?: { subscribers?: number };
  /** The push↔pull join — see `server/events/delivery-state.ts`. */
  delivery?: { state?: string; waitingMs?: number | null };
}

/**
 * Outcome of one `/health` read.
 *
 * The distinction is narrower than "did something answer": it is **did OUR
 * server answer**. `makeHealthHandler` (`server/mcp/routes/health.ts`) has no
 * failure branch at all — it unconditionally sends a 200 carrying valid JSON,
 * and the only thing that can reject the request before it is the DNS-rebinding
 * Host check, which a 127.0.0.1 / `tauri.localhost` client never trips. So a
 * non-OK status, or complete bytes that will not parse, is not this server
 * being unwell; it is evidence that whatever is on the port is **not this
 * server** — a stale Vite instance, a previous Tandem that never released
 * :3479, any squatter. Reading those as "answered, so reset the strike count"
 * reopened the exact hole this discrimination exists to close, one branch over.
 *
 * `answered: true` therefore means exactly: 200, body read to completion, body
 * parsed. Everything else counts toward demotion. The redaction case — a real
 * 200 whose loopback-only fields are absent — is expressed as `null` FIELDS on
 * an `answered: true` read, not as a third variant, because that is what it is:
 * our server, answering, declining to say.
 */
type HealthRead =
  | {
      answered: true;
      hasSession: boolean | null;
      sessionCount: number | null;
      pushAttached: boolean | null;
      /** The join's state string, verbatim. Unknown values pass through as-is
       *  and are simply not matched by `deliveryStall` — an older or newer
       *  server naming a state this client has never heard of must read as "no
       *  claim", never as a claim it happens to resemble. */
      deliveryState: string | null;
      deliveryWaitingMs: number | null;
    }
  | { answered: false; why: string };

/** Consecutive dead POLL reads before we stop believing in the session.
 *  Two, not one: a single dropped request is common and must not flap the
 *  pill. At `POLL_MS` = 8s that is ~16s of a stale claim, which is well inside
 *  the window where a user could act on it — and far better than the previous
 *  behaviour, which was to keep claiming it indefinitely. */
const DEAD_READS_BEFORE_DEMOTING = 2;

/** Per-read bound on both polls. Shorter than `POLL_MS` so a wedged server
 *  accrues one strike per interval rather than queueing reads behind one
 *  another. See the note at the `/health` fetch for why an unbounded read is
 *  the same floorless fail-safe this module exists to remove. */
const READ_TIMEOUT_MS = 5_000;

/**
 * "Has this reader gone quiet for long enough to stop believing its last
 * answer?" — one mechanism, two readers.
 *
 * A factory rather than two hand-rolled counters because the rule is one rule
 * and it is easy to get subtly different in two places: reset on ANY answer,
 * count only reads that are allowed to (the `/health` reader excludes its
 * out-of-band probes), and report the threshold crossing rather than exposing
 * the number. `record` returns whether the caller should now stop trusting its
 * retained value.
 */
function makeStrikeCounter(limit: number) {
  let strikes = 0;
  return {
    record(answered: boolean, counts = true): boolean {
      if (answered) {
        strikes = 0;
        return false;
      }
      if (counts) strikes++;
      return strikes >= limit;
    },
  };
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
 *   - `setup`   — configured but stopped because the Claude CLI is missing or
 *     unstartable (`lastError === "cli-unusable"`). Opens the integration
 *     wizard, same as `connect`, but with install-specific copy.
 *
 *     #1268 keyed this off `circuit-open` instead, on a correct observation
 *     with an incorrect conclusion. The observation: a missing CLI really does
 *     surface as `circuit-open`, not `binary-not-found`. The supervisor spawns
 *     the bundled reaper (which always exists); the reaper's own exec of the
 *     missing `claude` fails internally and exits 127 — an ordinary process
 *     exit, not a Node `ENOENT` on the reaper spawn — so it routes through
 *     `scheduleRestart` and eventually trips the breaker, never through the
 *     `child.on("error")` handler that sets `binary-not-found`. The error was
 *     treating that *sufficient* cause as the *only* one: the breaker also
 *     trips on a stale `--resume` session, an auth failure, OOM, or a bad
 *     plugin, and the wizard cannot clear a tripped breaker — only relaunch
 *     and start-fresh do. So a crash-looping user with a perfectly good
 *     install was told, by every surface at once, to install software they
 *     already had. The supervisor now probes at trip time and reports which
 *     it is; `binary-not-found` remains the *reaper*-missing case (a broken
 *     Tandem install) and still falls into `restart`, since retrying the
 *     reaper spawn is the only available action.
 *   - `sign-in` — configured but stopped because the CLI answered "Not logged
 *     in" (`lastError === "needs-login"`, #1780). Its action is a restart,
 *     which is the re-check: the supervisor sends the resumed session a turn,
 *     and a CLI the user has since signed in answers it.
 *   - `restart` — configured but stopped for any other reason, including
 *     `circuit-open` with a healthy CLI, `wake-delivery-failed`, and the rare
 *     `binary-not-found`. Plain restart.
 *   - `unlicensed` — the AI is refused by the licence (#1521): `aiNotice` is
 *     set, whichever kind. Opens Settings → License. It ranks FIRST, above Solo:
 *     Solo is a privacy choice, the licence refusal is a capability fact, and
 *     every other CTA (connect, restart) would be refused by the server anyway.
 *     Its copy is kind-neutral — see `AI_CTA.unlicensed`.
 */
export type AiChip = "connect" | "setup" | "sign-in" | "restart" | "unlicensed" | null;

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
/** Every handler an `AI_CTA` entry can name. Dispatched by `ctaHandler` alone. */
export type AiCtaAction = "connect" | "restart" | "open-license-settings";

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
    action: AiCtaAction;
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
    // The `title` names the escape hatch because the status pill is a compact,
    // single-action surface and deliberately grows no secondary button. The
    // empty state, which has room, renders a real "Restart Claude anyway" — so
    // a user whose CLI the probe missed is not stranded on either surface.
    title:
      "Claude Code needs to be installed — already have it? Run “Relaunch Claude in this folder” from the command palette",
    ariaLabel: "Claude Code needs to be installed. Set up Claude Code.",
    action: "connect",
  },
  "sign-in": {
    label: "Check Claude sign-in",
    title:
      "Claude Code isn't signed in. Run “claude” in a terminal and sign in, then click to check again.",
    ariaLabel: "Claude Code is not signed in. Check again after signing in.",
    action: "restart",
  },
  restart: {
    label: "Restart Claude Code",
    title: "Claude Code stopped — restart it",
    ariaLabel: "Claude Code has stopped. Restart Claude Code.",
    action: "restart",
  },
  // THE statement of the kind-neutral rule (other comments point here): this
  // one entry serves both `unlicensed` and `unverifiable`, and an unverifiable
  // licence holder most likely already paid (ADR-040 decision 8). So it never
  // says "unlicensed", "activate" or "trial ended", and carries no URL. Views
  // take kind-specific copy from `aiOffCopy(readiness.aiNotice)`; this entry is
  // the label, the action, and the fallback where a type cannot prove the kind.
  unlicensed: {
    label: "AI off — see license",
    title: "Tandem's AI features are off. Open Settings → License.",
    ariaLabel: "AI features are off. Open license settings.",
    action: "open-license-settings",
  },
};

/**
 * The ONE dispatcher from a CTA's `action` to its handler. A `switch` with a
 * `never` default, so a new action is a compile error here rather than a binary
 * ternary at a call site routing it to the wrong handler (#1521).
 */
export function ctaHandler(
  action: AiCtaAction,
  h: { connect: () => void; restart: () => void; openLicenseSettings: () => void },
): () => void {
  switch (action) {
    case "connect":
      return h.connect;
    case "restart":
      return h.restart;
    case "open-license-settings":
      return h.openLicenseSettings;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** A stopped launcher's CTA — also a tripped Tandem Claude surfaced beside a
 *  session that is still attached (`launcherFailure`). */
export type LauncherFailure = Exclude<AiChip, null | "connect" | "unlicensed">;

/**
 * The `lastError` → CTA decision for a stopped launcher. ONE function, used by
 * both `chip` and `launcherFailure`, so the two cannot drift apart (#1268).
 * See `AiChip` for why `cli-unusable` and not `circuit-open` means "install".
 */
function chipForStoppedLauncher(lastError: LauncherErrorCode | undefined): LauncherFailure {
  if (lastError === "cli-unusable") return "setup";
  if (lastError === "needs-login") return "sign-in";
  return "restart";
}

type RunningLauncherStatus = Extract<LauncherStatus, { running: true }>;

function isRunning(s: LauncherStatus): s is RunningLauncherStatus {
  return s.available && s.running;
}

/**
 * The `lastError` codes that mean Tandem's own Claude has stopped for good.
 *
 * A code alone does not say whether Tandem is still retrying: `spawn-failed`
 * is set both with a restart scheduled and on a permanent stop, and a relaunch
 * leaves the old code in place until its spawn clears it. The server's
 * `restartPending` answers that (#2180), so `launcherFailure` also requires it
 * to be absent; this table only says which codes mean "stopped" once nothing is
 * retrying.
 *
 * `stop-failed` is set only when a reaper survived SIGKILL and was abandoned.
 * A relaunch's own spawn clears it, so it survives a relaunch only when that
 * relaunch spawned nothing: its plan found no integration (which reads as
 * `not-configured`, masking it), or reading or persisting the plan threw. The
 * abandoned process may still be alive, so "isn't running" can be imprecise
 * there; Restart is still the right remedy.
 *
 * `status-check-failed` is the status ROUTE failing, not the supervisor, so it
 * is not a stop.
 *
 * `unlicensed` (#1521) is false: the licence refusal trips no breaker, and the
 * supervisor resumes on its own when a licence is activated in the app.
 *
 * A `Record` rather than a `Set` so a new server code fails to compile here
 * until someone decides whether it means "stopped for good".
 */
const TRIPPED_FAILURE: Record<LauncherErrorCode, boolean> = {
  "needs-login": true,
  "binary-not-found": true,
  "circuit-open": true,
  "cli-unusable": true,
  "wake-delivery-failed": true,
  "spawn-failed": true,
  "stop-failed": true,
  "status-check-failed": false,
  unlicensed: false,
};

/**
 * Copy for the "Tandem's Claude isn't running" button, which renders BESIDE
 * another attached session — so, unlike `AI_CTA`, every line names Tandem's
 * own Claude, so the click can't be read as acting on the user's. The action
 * comes from `AI_CTA[failure].action`, never from a second lookup here.
 *
 * `restart` says "isn't running" rather than "stopped" because
 * `binary-not-found` maps to it and that Claude may never have started.
 */
export const TANDEM_CLAUDE_DOWN: Record<LauncherFailure, { label: string; title: string }> = {
  restart: {
    label: "Tandem's Claude isn't running",
    title:
      "Tandem's background Claude isn't running. Restart it — any Claude you started yourself is unaffected.",
  },
  "sign-in": {
    label: "Tandem's Claude: sign in",
    title:
      "Tandem's background Claude isn't signed in. Run “claude” in a terminal to sign in, then click to check again — any Claude you started yourself is unaffected.",
  },
  setup: {
    label: "Tandem's Claude can't start",
    title:
      "Tandem can't start its background Claude: the Claude CLI is missing or won't run. Click to set it up — already have it? Run “Relaunch Claude in this folder” from the command palette",
  },
};

/**
 * The affirmative "an agent is connected" indicator, or `null` when there's
 * nothing positive to assert (no session, or still booting). Distinct from
 * `chip` (which is the *negative*-state CTA). They MUST stay separate — folding an
 * affirmative value into `chip` would break the `chip === null` guards that
 * gate the "no AI is connected" send notice (App.svelte) and collide with the
 * titlebar CTA/default-model branches. They are NOT mutually exclusive: a
 * leftover-only session (`hasSession` true, live `sessionCount` 0) gives
 * `connected` beside a non-null `chip`, and the view renders that pair as "AI
 * not connected" so the label agrees with the CTA (`aiIndicatorView` Rule 3).
 *   - `connected`   — an MCP session is in the registry and mode is Tandem. It
 *                     may be a leftover; `sessionCount` says whether one is live.
 *   - `solo-paused` — a LIVE MCP session and mode is Solo: chat still works,
 *                     but the AI won't see the user's edits/comments (the server
 *                     withholds them — `server/events/queue.ts`
 *                     `isUserPrivacyHeld` + `shouldForwardExternally`).
 */
export type AiLiveIndicator = "connected" | "solo-paused" | null;

/**
 * Whether anything is delivering real-time events to the attached agent.
 *   - `none`     — zero SSE consumers. The one sound negative; safe to act on.
 *   - `attached` — at least one consumer, which does NOT prove delivery.
 *   - `unknown`  — not yet polled, or the loopback-only field was redacted.
 */
export type PushDelivery = "none" | "attached" | "unknown";

export interface AiReadiness {
  readonly state: AiReadinessState;
  /** The CTA to surface, with Solo-mode suppression already applied. */
  readonly chip: AiChip;
  /** Last scrubbed error code from supervisor when state is stopped. */
  readonly lastError?: LauncherErrorCode;
  /**
   * The affirmative connected indicator, keyed on `hasSession` (Solo: on a live
   * session) — NOT on `state`, which also reaches `ready` from the
   * launcher's `running: true` with no open session (auto-launched desktop
   * startup window), where an "AI connected" badge would be a false green.
   */
  readonly liveIndicator: AiLiveIndicator;
  /**
   * Whether any real-time push consumer (channel shim / plugin monitor) is
   * attached.
   *
   * ONLY `"none"` is actionable, and that asymmetry is the whole contract. The
   * `makeHealthHandler` docblock in `server/mcp/routes/health.ts` states it:
   * `subscribers: 0` is a sound negative, but any positive count includes an
   * attached-but-inert shim, so `"attached"` does NOT mean events reach a
   * model. Use it to explain a delay, never to assert that push is working —
   * do not build a "push is live" indicator on it.
   *
   * A named union rather than `boolean | null` deliberately. As a tri-state
   * boolean, `if (!pushConsumerAttached)` compiled and read as "not attached"
   * while firing on `null` — telling a working user their comment went
   * nowhere, the exact alarm the health route forbids. Every member of a string
   * union is truthy, so that mistake stops type-checking as intended. This is
   * the same lesson `AI_CTA` above records: make the safe reading the only
   * convenient one.
   *
   * This is the missing half of `liveIndicator`. That signal proves Claude
   * *can read* the document; this one says whether Claude will be *told* to.
   */
  readonly pushDelivery: PushDelivery;
  /**
   * Has `/health` gone quiet for a full strike run?
   *
   * The question is about the SERVER, not the AI, and the two were previously
   * indistinguishable downstream: both surfaced as "no session". They call for
   * opposite messages. "No AI is attached to a server that is fine" means the
   * message waits. "The server is gone" means the message is sitting in a local
   * Y.Doc with nowhere to sync — and if the server returns on a new generation,
   * the stale-tab gate rebuilds from empty Y.Docs and it is dropped.
   *
   * Deliberately keyed on the same two-strike run as the demotion, not on a
   * single failed read, so a blip cannot raise an alarm about data loss.
   */
  readonly serverUnreachable: boolean;
  /**
   * Tandem's own launched Claude is running: launcher status says
   * `available && running` on the latest answered read, and the server is not
   * unreachable. Both gates are load-bearing: `pollLauncherStatus` resets its
   * strikes on ANY HTTP answer and keeps the last `status`, so a squatter on the
   * port that answers non-OK, or a launcher route erroring while `/health` is
   * fine, would otherwise pin this (and a stale `busy`) `true` forever.
   */
  readonly launcherRunning: boolean;
  /** Increments each time Tandem's Claude is seen to start running. Lets a
   *  dismissal of `launcherFailure` expire on the next successful run. */
  readonly launcherRunEpoch: number;
  /** The launched Claude's working folder, or `null` when not running or when
   *  the field is absent (off-loopback, or an older server). */
  readonly launcherCwd: string | null;
  /** The launched Claude has a turn in flight — see `SupervisorStatus.busy`.
   *  A missing field reads `false`, which is how an older server is silent. */
  readonly launcherBusy: boolean;
  /** The server matched a live MCP connection to this spawn of Tandem's Claude
   *  (`LauncherStatus.attached`). `false` means "can't confirm", not "not
   *  connected": it is only reachable when the child's connection forwards its
   *  Claude session id. Gated like `launcherRunning`. */
  readonly launcherAttached: boolean;
  /** Tandem is already bringing its Claude back — a restart is scheduled, a
   *  start or relaunch is running, or a killed child's exit is on its way
   *  (`LauncherStatus.restartPending`, #2180). Drives the "Restarting Claude…"
   *  view. Gated like `launcherRunning`; `chip` and `launcherFailure` instead
   *  read the raw retained status, so a failed read mid-restart cannot bring a
   *  Restart button back. */
  readonly launcherRestarting: boolean;
  /** How many LIVE MCP clients `/health` counts (`isLiveEntry` +
   *  `countDistinctClients`), or `null` when unknown or unreachable. */
  readonly sessionCount: number | null;
  /**
   * Tandem's Claude has tripped (see `TRIPPED_FAILURE`) while ANOTHER live
   * session is attached — the case `chip` hides, because a live session
   * promotes `state` to `ready` (#1054). `null` otherwise, and in Solo.
   * Deliberately separate from `chip`, which keeps its meaning for EmptyState
   * and the send path.
   */
  readonly launcherFailure: LauncherFailure | null;
  /**
   * How long the user's last message has gone unanswered, in ms — or `null`
   * when there is nothing sound to say.
   *
   * A projection of current truth (D-5), not an event. The `no-push` and
   * `offline` notices fire once at send, on what was known then; this answers
   * whether the thing you sent is STILL waiting, so it re-derives and erases
   * itself. See `status/delivery-stall.ts` for the precedence rules and for the
   * gap it deliberately cannot cover.
   */
  readonly deliveryStalledMs: number | null;
  /**
   * The licence refusal, or null (#1521): the same `deps.aiNotice()` that ranks
   * `chip` first, so it is non-null exactly when `chip === "unlicensed"`. Views
   * key their AI-off rendering and copy on this value and their CTA on `chip`;
   * because both come from here, the two cannot disagree. Pass this, never
   * `licenseStore.ui.aiNotice` beside it.
   */
  readonly aiNotice: AiNotice | null;
  /** Re-poll launcher status + session now (e.g. just after a restart). */
  refresh: () => void;
  /** Re-poll launcher status alone. For the post-send `busy` read: it leaves
   *  `/health` out so a user-triggered read never counts toward its strike run
   *  (see `readHasSession`'s `fromPoll`). */
  refreshLauncherStatus: () => void;
  /**
   * Fresh, awaitable MCP-session check for moment-of-send decisions (#1083).
   *
   * The polled `chip` can be up to POLL_MS stale: an agent whose MCP
   * `initialize` landed after the last background poll still reads as absent,
   * so the "no AI is connected" send notice would fire while the agent is
   * live. Callers about to alarm on `chip !== null` should confirm with this
   * probe first.
   *
   * `sessionLive` is `true` only when a fresh `/health` read confirms a LIVE
   * MCP session (`sessionCount > 0`, or `hasSession` when no count is
   * reported) — a leftover from a client that went away does not count. On
   * fetch failure or a redacted body (no `hasSession` field)
   * it falls back to the last-known polled value — mirroring the poll's "keep
   * prior value on a blip" fail-safe in both directions.
   *
   * `answered` reports whether THIS read reached our server, and it is separate
   * from `sessionLive` because the fallback above silently launders a stale
   * `true` into what reads like a fresh confirmation. That is the same collapse
   * `HealthRead` exists to prevent, one layer up: a caller that only sees the
   * boolean cannot tell "a live session, just confirmed" from "no idea, here is
   * what we thought 8 seconds ago". Callers making an AFFIRMATIVE connectivity
   * claim must check it; `serverUnreachable` is no substitute, because probe
   * reads deliberately do not accrue strikes and so cannot set it.
   */
  probeSession: () => Promise<{ answered: boolean; sessionLive: boolean }>;
}

const POLL_MS = 8_000;

export function createAiReadiness(deps: {
  connected: () => boolean;
  firstRunSettled: () => boolean;
  soloMode: () => boolean;
  /** The licence refusal, or null (#1521). Null on every dark build. */
  aiNotice: () => AiNotice | null;
  /**
   * Re-read the licence now (#1521). Called when the launcher reports the
   * server stopped Tandem's Claude as `unlicensed` while `aiNotice` is still
   * null: at trial expiry the server knows before the client's licence poll
   * does (up to 60 s later). Required, so no caller can leave that window open.
   * The pill waits only until the returned promise settles.
   */
  refreshLicence: () => Promise<unknown> | void;
}): AiReadiness {
  let status = $state<LauncherStatus | null>(null);
  // Whether an MCP client transport is currently open (from `/health`). An
  // active session means AI works regardless of launcher state (#1054).
  let mcpSessionActive = $state(false);
  // Whether `/health` reported any SSE consumer. `null` = not yet known or
  // redacted, which is NOT the same as "none".
  let pushAttached = $state<boolean | null>(null);
  // `/health`'s `sessionCount`; `null` = unknown (not yet read, redacted, or
  // the server is unreachable).
  let sessionCount = $state<number | null>(null);
  // An AI session that is still THERE: `/health` saw a session and counts at
  // least one live one. `hasSession` alone includes a client that went away
  // without disconnecting, for up to ~35 min. A `null` count (not reported,
  // e.g. a redacted or stubbed body) falls back to `hasSession` rather than
  // demoting on the strength of a missing field.
  const sessionLive = $derived(mcpSessionActive && sessionCount !== 0);
  // Has `/health` gone quiet for a full strike run — i.e. is the SERVER gone,
  // as distinct from an AI not being attached to a server that is fine? The
  // send path needs the difference: with the server down, a chat message is
  // written to a local Y.Doc that has nowhere to sync, and if the server comes
  // back on a new generation the stale-tab gate rebuilds from empty Y.Docs and
  // the message is dropped. Telling that user "it'll be seen when an AI
  // connects" is a second false promise in place of the one just removed.
  let serverUnreachable = $state(false);
  // The push↔pull join, mirrored from `/health` (D-5). Held as raw state and
  // interpreted by `deliveryStall`, so the threshold and the Solo/offline
  // precedence live in one pure, testable place rather than in a reactive
  // expression nothing can drive.
  let deliveryState = $state<string | null>(null);
  let deliveryWaitingMs = $state<number | null>(null);
  // Have we ever read launcher status successfully? Distinguishes "still
  // booting" from a genuine `available: false`, so the chip never flashes
  // during cold start. `/health` is not gated on this: readiness derives
  // `booting` until launcher status settles, and `hasSession` only ever
  // PROMOTES to ready (never demotes), so a missing first `/health` read can't
  // surface a false CTA.
  let settledOnce = $state(false);
  // Did the LAST launcher read that the server answered carry a valid body?
  // Gates `runningStatus` only; the CTA path keeps the prior status as before.
  let launcherFresh = $state(false);
  // Counts each observed start of Tandem's Claude (not-running → running), so
  // a dismissal of its failure button lasts only until it next runs.
  let launcherRunEpoch = $state(0);

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
  /** Not `$state` — nothing renders these; they gate the writes that do. */
  const healthStrikes = makeStrikeCounter(DEAD_READS_BEFORE_DEMOTING);
  const launcherStrikes = makeStrikeCounter(DEAD_READS_BEFORE_DEMOTING);

  /**
   * The launcher half of the same floor.
   *
   * This retained `status` through every failure forever once a single read had
   * succeeded — the identical shape the `/health` reader was fixed for, and it
   * was NOT masked by the way the comment here used to claim. The
   * `!settledOnce || status === null` half of the booting gate only covers a
   * route that never once succeeded. What actually hid it was `deps.connected()`:
   * :3478 and :3479 are bound by the same process, so the Hocuspocus socket
   * drops when it dies. That is an incidental coupling of two ports to one
   * process — nothing here enforces it, and any failure that takes the HTTP API
   * down while the WebSocket survives makes it live.
   *
   * So it now clears to `null` after the same two consecutive dead reads, which
   * lands on "booting" — "we do not know" — rather than on a fabricated
   * launcher state.
   *
   * "Two reads" is not "~16s" here, and the difference is deliberate rather than
   * overlooked. `refreshAiReadinessAfterLauncherAction` fires two extra polls at
   * 2s and 5s after a restart action, so a dead API demotes in seconds on that
   * path. There is no `fromPoll` equivalent because there is nothing to exempt —
   * every launcher read IS a poll, one per generation, and a burst issued
   * precisely to observe a state change should be allowed to observe it. The
   * outcome is "booting" during a restart the user just asked for, which is
   * both accurate and unalarming.
   *
   * Note the asymmetry with `/health`: a non-OK or unparseable
   * response is NOT a strike here, because unlike `makeHealthHandler` the
   * launcher route genuinely can fail (`requireSupervisor` 503s while the
   * launcher is deferred), so on THIS route those really are the server
   * answering.
   */
  async function pollLauncherStatus(mine: number): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${API_LAUNCHER_STATUS}`, {
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch {
      // Nothing answered. Strike — and once the run is long enough, stop
      // presenting a launcher state read from a server that is gone.
      if (launcherStrikes.record(false) && mine === gen && !destroyed) status = null;
      return;
    }
    launcherStrikes.record(true);
    if (mine !== gen) return;
    // A non-OK, malformed or invalid answer keeps the prior `status` for the
    // CTA (see above), but it is NOT a fresh sighting of a running launcher:
    // `runningStatus` stops vouching for it, so a stale `busy: true` cannot keep
    // "Tandem's Claude is working…" on screen while the route errors.
    if (!res.ok) {
      launcherFresh = false; // real server error (e.g. 503 deferred) — keep prior status
      return;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      launcherFresh = false; // malformed body — keep prior status
      return;
    }
    // Validate before trusting. An unchecked cast here is not cosmetic: any
    // parseable non-`LauncherStatus` body — `{}` from a port squatter, an error
    // envelope — makes `available === false` and `running === true` both false,
    // which lands on `state === "stopped"` with no `lastError`, which renders a
    // working "Restart Claude Code" button derived from a body nobody checked.
    if (typeof (body as LauncherStatus | null)?.available !== "boolean") {
      launcherFresh = false;
      return;
    }
    const next = body as LauncherStatus;
    if (isRunning(next) && !(status !== null && isRunning(status))) launcherRunEpoch++;
    status = next;
    launcherFresh = true;
    settledOnce = true;
  }

  /** One `/health` read, separating "our server answered" from everything else
   *  — see `HealthRead` for why the line is drawn there and not at "something
   *  answered".
   *
   *  All of it used to collapse into one `null`-everything result, and the
   *  collapse was a lie the user could see: a fetch that threw because the
   *  server was gone was treated exactly like a good response with the
   *  loopback-only fields redacted, so the pill went on asserting "AI
   *  connected" next to the disconnection banner.
   *
   *  Both fields come off ONE fetch deliberately. They answer different questions
   *  (`hasSession` = an MCP transport completed initialize; `push.subscribers`
   *  = an SSE consumer is attached) and the `makeHealthHandler` docblock in
   *  `server/mcp/routes/health.ts` is explicit that they are structurally
   *  disjoint — which is precisely why a user can see "AI connected" while
   *  nothing they do reaches Claude. Reading them at the same instant keeps the
   *  two halves of that story consistent. */
  async function fetchHealth(): Promise<HealthRead> {
    let res: Response;
    try {
      // Bounded, because "dead" has to mean wedged as well as refused. A
      // process that is up but not answering produces no rejection at all —
      // the fetch just hangs, no strike accrues, and the pill holds its claim
      // until the browser's own multi-minute timeout. That is the same
      // floorless fail-safe in a different disguise. The bound is shorter than
      // `POLL_MS` so a hung server accrues one strike per interval instead of
      // queueing reads behind each other.
      res = await fetch(`${API_BASE}${API_HEALTH}`, {
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch {
      return { answered: false, why: "request failed or timed out" };
    }
    if (!res.ok) return { answered: false, why: `HTTP ${res.status}` };

    // Read the body and parse it in SEPARATE steps — the same split
    // `scripts/dev-standalone.mjs` makes, and for the same reason. A single
    // `res.json()` folds two opposite failures into one catch: a `SyntaxError`
    // (complete bytes, bad JSON) and a `TypeError` (the body stream errored —
    // headers arrived, the body never did, i.e. the server started answering
    // and then stopped existing). Both land here as `answered: false` today,
    // but they are worth telling apart in the log: the second is what a
    // crash-looping sidecar or an update-time `kill_sidecar()` looks like from
    // the client, and it is the one that used to reset the strike count on
    // every poll and hold the pill green forever.
    let raw: string;
    try {
      raw = await res.text();
    } catch {
      return { answered: false, why: "body stream errored mid-response" };
    }
    let body: HealthResponse;
    try {
      body = JSON.parse(raw) as HealthResponse;
    } catch {
      return { answered: false, why: "unparseable body (not this server)" };
    }

    // Only trust each field when present (loopback). Absence is "unknown", not
    // "no session" / "no consumer". The count collapses to a boolean because
    // nothing needs the number, and `> 0` is the only reading of it that
    // `routes/health.ts` vouches for.
    return {
      answered: true,
      hasSession: typeof body.hasSession === "boolean" ? body.hasSession : null,
      sessionCount:
        typeof body.sessionCount === "number" &&
        Number.isInteger(body.sessionCount) &&
        body.sessionCount >= 0
          ? body.sessionCount
          : null,
      pushAttached: typeof body.push?.subscribers === "number" ? body.push.subscribers > 0 : null,
      deliveryState: typeof body.delivery?.state === "string" ? body.delivery.state : null,
      deliveryWaitingMs:
        typeof body.delivery?.waitingMs === "number" ? body.delivery.waitingMs : null,
    };
  }

  /** One ordered `/health` read (shared by the background poll and
   *  `probeSession`). Writes `mcpSessionActive` only when this is still the
   *  most recently issued read — last-issued-wins, so a slow older response
   *  can never clobber a fresher one (e.g. a poll that sampled "no session"
   *  just before the agent's initialize, resolving after the probe that saw
   *  it). A dropped write is recovered by the next interval poll. Returns both
   *  the fetched value and whether the read answered at all, so callers can act
   *  on their own read WITHOUT having to treat "no session" and "no answer" as
   *  the same thing — `hasSession: null` alone cannot tell them apart. */
  async function readHasSession(
    fromPoll: boolean,
  ): Promise<{ answered: boolean; hasSession: boolean | null; sessionCount: number | null }> {
    const mine = ++healthSeq;
    const fresh = await fetchHealth();

    // Strike accounting happens BEFORE the staleness guard, deliberately.
    //
    // That guard orders `$state` writes so a slow older response cannot clobber
    // a fresher one. Whether the server answered is not a question about
    // ordering, and counting inside the guard made every superseded poll read
    // vanish — while `probeSession` bumps `healthSeq` on every send that gets
    // past the two guards at `App.svelte:553-560` (Solo, and a confirmed
    // `pushDelivery === "attached"`). Those guards do not help here: the second
    // is exactly the fast path a hand-launched session never takes, so for the
    // population this whole branch is about, every send probes. A user typing
    // at a dead server would therefore postpone demotion indefinitely — the
    // exact inverse of the hazard `fromPoll` exists to prevent.
    //
    // The two paths are treated ASYMMETRICALLY, and only one half is
    // poll-gated. Increments are, because an out-of-band probe fires on user
    // action and several in a row would demote in well under the intended
    // ~16s. Resets are NOT: an answered read is evidence of life whoever asked
    // for it, and ignoring a probe's success would be inventing a strike we
    // have positive evidence against. The consequence is real but bounded and
    // in the safe direction — a probe that answers can zero a legitimately
    // earned run and postpone demotion by one more interval; it can never
    // re-promote, because promotion needs a non-null `hasSession` from a read
    // that also survives the staleness guard.
    //
    // `fromPoll` is required, not defaulted: a future call site that forgets it
    // should not silently opt out of the count.
    const runIsLongEnough = healthStrikes.record(fresh.answered, fromPoll);
    if (!fresh.answered) {
      // The only trace a stuck pill leaves. Otherwise two opposite causes —
      // "the server sent me HTML" and "the server hung up mid-sentence" —
      // arrive here indistinguishable and silent.
      console.warn(`[aiReadiness] /health did not answer: ${fresh.why}`);
    }

    const out = {
      answered: fresh.answered,
      hasSession: fresh.answered ? fresh.hasSession : null,
      sessionCount: fresh.answered ? fresh.sessionCount : null,
    };
    if (mine !== healthSeq || destroyed) return out;

    if (fresh.answered) {
      serverUnreachable = false;
      // Each field is written only when known, so a redacted or partial body
      // can never demote one signal on the strength of the other's absence.
      if (fresh.hasSession !== null) mcpSessionActive = fresh.hasSession;
      if (fresh.pushAttached !== null) pushAttached = fresh.pushAttached;
      // Assigned unconditionally, unlike the two above. Those only ever
      // PROMOTE, because a redacted field must not demote a live session. The
      // join is the opposite: `null` there means the server declined to say, and
      // continuing to render a stall on a stale read is precisely the "claim
      // outliving its evidence" failure this whole surface exists to remove.
      deliveryState = fresh.deliveryState;
      deliveryWaitingMs = fresh.deliveryWaitingMs;
      // Unconditional for the same reason: a count the server no longer
      // vouches for must not stay on the pill.
      sessionCount = fresh.sessionCount;
    } else if (runIsLongEnough) {
      serverUnreachable = true;
      mcpSessionActive = false;
      sessionCount = null;
      // NOT `false`. A server we cannot reach tells us nothing about how many
      // consumers are attached to it, and `pushAttached === false` is a load-
      // bearing claim: it is the confirmed zero that drives the "nothing is
      // notifying Claude" copy. Asserting it from a failed read would swap one
      // confident lie for another.
      pushAttached = null;
      // The join is deliberately NOT cleared here, and re-adding a clear would
      // be adding a line nothing can observe: `serverUnreachable` above already
      // outranks the stall inside `deliveryStall`, so ONCE THE SERVER IS
      // DECLARED UNREACHABLE the join cannot reach the banner either way.
      //
      // Below the floor is a different case, and it is deliberate rather than a
      // gap: a single dead read takes NEITHER branch, so the previous join
      // survives and keeps rendering. That is correct — a dropped request is
      // not evidence the stall ended — and it is pinned by "One dead read holds
      // the claim" in the hook's tests. Do not "fix" the code to clear early.
    }
    return out;
  }

  /** See `AiReadiness.probeSession`. Issues a fresh `/health` read (which also
   *  folds into polled state, clearing the titlebar chip immediately instead
   *  of waiting out the poll interval) and answers with the freshest data it
   *  has — falling back to the last-known polled value when the read fails, and
   *  saying which of the two happened. */
  async function probeSession(): Promise<{ answered: boolean; sessionLive: boolean }> {
    const fresh = await readHasSession(false);
    // Same rule as `sessionLive`, applied to this read: a session that is only
    // a leftover is not one the send path may call connected.
    const live =
      fresh.hasSession === null ? sessionLive : fresh.hasSession && fresh.sessionCount !== 0;
    return { answered: fresh.answered, sessionLive: live };
  }

  function poll(): void {
    const mine = ++gen;
    void pollLauncherStatus(mine);
    void readHasSession(true);
  }

  poll();
  const interval = setInterval(() => poll(), POLL_MS);

  // When the licence refusal clears, read the launcher at once. The server has
  // already respawned Tandem's Claude by then, but the retained `status` still
  // carries `lastError: "unlicensed"`, which `chip` maps to Restart the moment
  // the refusal stops outranking it — and a click on that relaunches over the
  // fresh child. Keyed on the transition itself, so it covers every way the
  // refusal clears: the Settings activate form and a CLI `tandem activate`
  // picked up by the licence poll alike. `prev` is a plain `let`, not `$state`:
  // as `$state` this effect would re-trigger on its own write. The follow-up
  // reads at 2s and 5s mirror `refreshAiReadinessAfterLauncherAction`: the
  // respawned child is usually still starting at the first read, and without
  // them the pill waits for the next 8s poll to show it running. Every
  // transition, either way, cancels follow-ups still pending from an earlier
  // clearing: a refusal that returns within 5s must not leave them firing, and
  // a second clearing must not stack a second pair on the first.
  let prevAiOff: boolean | null = null;
  const followUps: ReturnType<typeof setTimeout>[] = [];
  const readLauncher = () => {
    if (!destroyed) void pollLauncherStatus(++gen);
  };
  $effect(() => {
    const aiOff = deps.aiNotice() !== null;
    const changed = prevAiOff !== null && aiOff !== prevAiOff;
    const cleared = prevAiOff === true && !aiOff;
    prevAiOff = aiOff;
    if (!changed) return;
    for (const t of followUps) clearTimeout(t);
    followUps.length = 0;
    if (!cleared) return;
    untrack(readLauncher);
    followUps.push(setTimeout(readLauncher, 2_000), setTimeout(readLauncher, 5_000));
  });
  onDestroy(() => {
    gen++;
    destroyed = true;
    clearInterval(interval);
    for (const t of followUps) clearTimeout(t);
  });

  // The server has stopped Tandem's Claude for want of a licence, but the
  // client's licence view does not say so yet (`aiNotice` null): at trial
  // expiry the licence poll can lag the server by up to 60 s. The launcher read
  // is then ahead of the licence, so neither half is the truth on its own.
  // `state` reads it as "we do not know yet" (booting), which keeps the
  // Restart chip off — a click on it would only be refused — and keeps the
  // pill from saying "unlicensed" with no kind to explain it, which an
  // unverifiable licence holder must never see. `launcherFailure` already
  // ignores `unlicensed` (`TRIPPED_FAILURE`).
  //
  // The wait is bounded by that one re-read, never by the sighting. The server
  // can keep reporting `unlicensed` after the licence is valid — a CLI
  // `tandem activate` never reaches the route that resumes the launcher, nor
  // does a licence file that starts verifying, nor an activation after a user
  // Stop — and a "booting" held for the whole sighting would then hide the
  // pill, and the Restart that now succeeds, until the server restarts. So once
  // the re-read settles with `aiNotice` still null, the client's licence view
  // is the answer and `state` falls through to the ordinary stopped mapping.
  const staleLicenceStop = $derived(
    status !== null &&
      status.available &&
      !status.running &&
      status.lastError === "unlicensed" &&
      deps.aiNotice() === null,
  );
  let licenceRereadPending = $state(false);
  let sighting = 0;
  // ...and ask the licence store to catch up, once per sighting: a `$derived`
  // boolean re-runs this only when it CHANGES, so an 8 s poll repeating the
  // same answer calls nothing; a different `lastError`, or `aiNotice` turning
  // non-null, ends the sighting and the next one calls again. This effect
  // writes `licenceRereadPending` but never reads it.
  $effect(() => {
    const mine = ++sighting;
    if (!staleLicenceStop) {
      licenceRereadPending = false;
      return;
    }
    licenceRereadPending = true;
    untrack(() => {
      void Promise.resolve()
        .then(() => deps.refreshLicence())
        .catch(() => {})
        .finally(() => {
          if (mine === sighting && !destroyed) licenceRereadPending = false;
        });
    });
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
    if (sessionLive) return "ready";
    if (staleLicenceStop && licenceRereadPending) return "booting";
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
  // Off the RAW retained status, not the fresh-gated view flag below: a single
  // failed read during a restart keeps the last status but clears
  // `launcherFresh`, and keying the chip on the gated flag would put a Restart
  // button back mid-restart — one that relaunches over the automatic retry.
  const restartPending = $derived(
    status !== null && status.available && !status.running && status.restartPending === true,
  );

  // `chip` is the ONE place the `lastError` → CTA decision is made (see the
  // `AiChip` doc comment for why `cli-unusable` — a server-side probe taken at
  // breaker-trip time — is the branch that means "go install Claude Code", and
  // why `circuit-open` on its own does not). Views must render off this value
  // alone, not re-derive their own copy of this ternary.
  const chip = $derived<AiChip>(
    deps.aiNotice()
      ? "unlicensed"
      : deps.soloMode()
        ? null
        : state === "unconfigured"
          ? "connect"
          : state === "stopped" && !restartPending
            ? chipForStoppedLauncher(lastError)
            : null,
  );

  // The running arm of `status`, or null. One gate, narrowed once, so the three
  // getters below cannot drift apart. `serverUnreachable` is load-bearing — see
  // `AiReadiness.launcherRunning`.
  const runningStatus = $derived(
    status !== null && isRunning(status) && launcherFresh && !serverUnreachable ? status : null,
  );
  const launcherRunning = $derived(runningStatus !== null);
  // `?? null` is load-bearing: the contract types `cwd` as required, but the
  // off-loopback body and older servers omit it.
  const launcherCwd = $derived(runningStatus?.cwd ?? null);
  const launcherBusy = $derived(runningStatus?.busy === true);
  // Off `runningStatus`, never `status`: `status` keeps a stale running body
  // for the CTA after a failed read, and a stale `attached: true` is a false
  // green.
  const launcherAttached = $derived(runningStatus?.attached === true);
  const launcherRestarting = $derived(restartPending && launcherFresh && !serverUnreachable);
  // Suppressed while the AI is refused: the chip already says why, and the
  // launcher cannot be restarted until the licence returns.
  const launcherFailure = $derived<LauncherFailure | null>(
    deps.aiNotice() === null &&
      !deps.soloMode() &&
      sessionLive &&
      !restartPending &&
      lastError !== undefined &&
      TRIPPED_FAILURE[lastError]
      ? chipForStoppedLauncher(lastError)
      : null,
  );

  // The affirmative indicator keys on `mcpSessionActive` (an open MCP transport,
  // proven by a real `initialize` round-trip) — the honest subset of `ready`.
  // `state === "ready"` also fires from the launcher `running: true` branch with
  // no session, so keying on `state` would render "AI connected" with nothing
  // connected. When no session is open there is nothing affirmative to say
  // (`null`); Solo-with-no-session is still `null` — "AI won't see your edits"
  // only makes sense once an AI is actually connected.
  //
  // "connected" keys on ANY session so the pill can still show a leftover one
  // (hollow, with copy saying it may have closed — the view reads
  // `sessionCount`). Solo keys on a LIVE one: its pill exists only to say an AI
  // is attached but held, which a leftover is not.
  const liveIndicator = $derived<AiLiveIndicator>(
    !mcpSessionActive ? null : deps.soloMode() ? (sessionLive ? "solo-paused" : null) : "connected",
  );

  // Deliberately NOT folded into `liveIndicator` or `state`. Push delivery is
  // orthogonal to whether an agent is attached: a hand-launched session has a
  // live MCP transport and no consumer at all, which is the exact state this
  // exists to make legible. Folding it in would either blank a genuinely
  // connected indicator or claim push works from a signal that cannot prove it.
  const pushDelivery = $derived<PushDelivery>(
    pushAttached === null ? "unknown" : pushAttached ? "attached" : "none",
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
    get pushDelivery() {
      return pushDelivery;
    },
    get serverUnreachable() {
      return serverUnreachable;
    },
    get launcherRunning() {
      return launcherRunning;
    },
    get launcherRunEpoch() {
      return launcherRunEpoch;
    },
    get launcherCwd() {
      return launcherCwd;
    },
    get launcherBusy() {
      return launcherBusy;
    },
    get launcherAttached() {
      return launcherAttached;
    },
    get launcherRestarting() {
      return launcherRestarting;
    },
    get sessionCount() {
      return sessionCount;
    },
    get launcherFailure() {
      return launcherFailure;
    },
    // A getter over raw `$state` rather than a `$derived`, matching
    // `serverUnreachable` directly above and `yjsSync.connected`. Reactivity in
    // Svelte 5 comes from reading a signal inside a tracking context, not from
    // `$derived` — the four signals read here land in the consuming component's
    // own tracked scope. It must keep returning a PRIMITIVE: handing back a
    // fresh object per read would invalidate any consumer `$derived` every time.
    get deliveryStalledMs() {
      return deliveryStall({
        state: deliveryState,
        waitingMs: deliveryWaitingMs,
        soloMode: deps.soloMode(),
        aiOff: deps.aiNotice() !== null,
        serverUnreachable,
      });
    },
    get aiNotice() {
      return deps.aiNotice();
    },
    refresh: () => poll(),
    refreshLauncherStatus: () => void pollLauncherStatus(++gen),
    probeSession,
  };
}
