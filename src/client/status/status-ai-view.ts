import type {
  AiChip,
  AiLiveIndicator,
  AiReadinessState,
  LauncherFailure,
  PushDelivery,
} from "../hooks/useAiReadiness.svelte";
import type { CwdDrift } from "../hooks/useCwdDrift.svelte";

/**
 * Consolidated AI-status indicator for the status pill (replaces the old
 * titlebar "AI connected" pill + the status bar's "Assistant · idle" segment).
 *
 * This pure mapping is the spec: given readiness, the affirmative
 * `liveIndicator`, the launcher's own facts, and whether the user is in Solo
 * mode, decide what the single status-pill indicator renders. Extracted (not
 * inlined) so the multi-state logic — especially the ordering rules below — is
 * unit-tested, not mounted.
 *
 * The pill says WHO is attached, not merely that something is. "AI connected"
 * keyed on any MCP transport collapsed six realities into one green dot — a
 * terminal session idle at its prompt, Claude Desktop, an inert shim, a closed
 * terminal's leftover connection, a script, and Tandem's own launched Claude —
 * and only the last is something the server knows it will wake.
 *
 * Ordering rules (order is load-bearing):
 *   1. Solo first: the user opted out of AI surfacing, so the Solo pill (or
 *      nothing) wins over every connection claim.
 *   2. Tandem's own Claude (`launcherRunning`). The supervisor wakes it over
 *      stdin, so this is the one tier whose wake claim the server can back. It
 *      outranks `booting`, as a live session does: gating it on `state` would
 *      blank a running launcher during a doc-sync blip.
 *   3. Any other attached session (`liveIndicator === "connected"`) — a proven
 *      `initialize`, which also outranks `booting` (#1054). Its copy claims only
 *      what that proves: something is connected.
 *   4. Only the NEGATIVE / absent states are gated on `booting`, so we never flash
 *      "AI not connected" before readiness settles.
 *
 * Activity (the dot pulse, the `· {status}` suffix, the working pill) follows
 * Bryan's rule that the chat UI shows status only for the chat's attached
 * session. The chat is a shared inbox, so `claudeActive` / `claudeStatus` /
 * `claudeWorking` — written by whichever session called a tool — can't be
 * attributed to it. Where Tandem's Claude is running, the views carry `pulse`
 * and `ownActivity` overrides driven by the supervisor's own `busy` instead;
 * elsewhere they stay `null` and StatusBar keeps its old logic until #2167
 * attributes activity to the session that picked up the chat.
 */
export type AiIndicatorTone = "connected" | "solo" | "not-connected" | "pending";

export interface AiIndicatorView {
  /** User-facing label. */
  label: string;
  /** Drives dot + text color. */
  tone: AiIndicatorTone;
  /** `data-ai-state` attribute. */
  dataState: "connected" | "solo-paused" | "not-connected" | "tandem-claude";
  /**
   * Whether this state may animate its dot off presence activity. Only ever
   * true when a session is live (connected/solo) — a disconnected indicator
   * must never pulse "as if working". Ignored whenever `pulse` is non-null.
   */
  canAnimate: boolean;
  /**
   * Override for the dot pulse. `null` = StatusBar's presence-driven logic
   * (`canAnimate` + `claudeActive`); a boolean replaces it entirely, so presence
   * activity from some other session can never pulse this view.
   */
  pulse: boolean | null;
  /**
   * Activity attributable to the chat's session, or `null`. Non-null only for a
   * busy launched Claude. While `pulse` is non-null this is the ONLY activity
   * StatusBar shows.
   */
  ownActivity: "working" | null;
  /** Hover tooltip — carries the explanation the terse label omits. */
  title: string;
  /** Screen-reader label (the visible text under-specifies "Solo · edits held"). */
  ariaLabel: string;
  /**
   * How many MCP clients `/health` counts, for the ` · N sessions` suffix, or
   * `null` to show none. Already folded into `title` and `ariaLabel`.
   */
  sessionCount: number | null;
}

/** No override: StatusBar's presence-driven activity logic applies. */
const NO_OVERRIDE = { pulse: null, ownActivity: null } as const;
/** A view before `withSessionCount`, its single writer of `sessionCount`. */
type BaseView = Omit<AiIndicatorView, "sessionCount">;
/** Suppress presence-driven activity without claiming any of our own. */
const QUIET = { pulse: false, ownActivity: null } as const;

/**
 * A session is connected, and it is not (provably) Tandem's own Claude.
 *
 * "Something is connected to Tandem" is exactly what `liveIndicator` proves — a
 * completed MCP `initialize`. Not "Claude", not "a session you started", not
 * "has the tools": the attached client may be a terminal, Claude Desktop, a
 * script, or the leftover connection of a Claude that has since died, and every
 * stronger noun is false for one of those. The check-in claim is conditional
 * ("if it's a session you're using") for the same reason.
 */
const CONNECTED: BaseView = {
  label: "AI attached",
  tone: "connected",
  dataState: "connected",
  canAnimate: true,
  ...NO_OVERRIDE,
  title:
    "Something is connected to Tandem. Tandem can't tell whether it's being notified, so if it's a session you're using, it may only see your messages when it next checks in.",
  ariaLabel:
    "AI attached. Something is connected to Tandem; Tandem can't tell whether it's being notified, so it may only see your messages when it next checks in.",
};

/**
 * Connected, but demonstrably nothing is delivering events.
 *
 * Same label and tone as `CONNECTED` on purpose: something really is attached,
 * and recolouring would read as a fault when nothing is broken. What changes is
 * the hover text. Only rendered on a CONFIRMED zero — `pushDelivery === "none"`.
 * An unknown or positive count keeps `CONNECTED`, because a positive count
 * includes an attached-but-inert consumer and cannot prove delivery either way.
 */
const CONNECTED_NO_PUSH: BaseView = {
  ...CONNECTED,
  title:
    "Something is connected to Tandem, but nothing is notifying it. If it's a session you're using, it sees your messages only when it next checks in, so you may need to prompt it.",
  ariaLabel:
    "AI attached, but nothing is notifying it. If it's a session you're using, it sees your messages only when it next checks in.",
};

/** Appended while Tandem's own Claude has tripped (the sibling button is up):
 *  the "something" may be that dead Claude's leftover connection. */
const LEFTOVER_HINT = " It may be the stopped Claude's leftover connection.";

/**
 * #1287: the label used to read "Solo · edits held", which overstates what
 * Solo actually withholds. Solo gates *forwarding* of annotation
 * notifications — `shouldForwardExternally` at the event fan-out, plus
 * `hideFromAI` on the pull paths — not document mutations, chat, or Claude's
 * ability to read the document on request. "Edits held" reads as "the AI is
 * idle and blind," which is false: Claude can still be mid-tool-call while
 * this pill shows. "Comments held" names the actual contract — your
 * annotation comments and replies aren't pushed to Claude's inbox until you
 * switch back to Tandem.
 */
const SOLO_PAUSED: BaseView = {
  label: "Solo · comments held",
  tone: "solo",
  dataState: "solo-paused",
  canAnimate: true,
  ...NO_OVERRIDE,
  title:
    "Solo mode — your comments and replies aren't sent to the AI until you switch to Tandem (chat and document edits still work).",
  ariaLabel:
    "Solo mode — the AI is connected, but your comments and replies aren't forwarded until you switch to Tandem",
};

/** Solo with a session while Tandem's Claude runs: the session's presence
 *  activity is no more attributable here than in Tandem mode, so toggling Solo
 *  must not bring it back. */
const SOLO_PAUSED_QUIET: BaseView = { ...SOLO_PAUSED, ...QUIET };

/**
 * Solo, Tandem's Claude running, no session seen. Makes no claim that chat
 * reaches it: with no `hasSession`, Tandem can't say the child has its tools.
 */
const SOLO_PAUSED_LAUNCHER: BaseView = {
  ...SOLO_PAUSED,
  canAnimate: false,
  ...QUIET,
  title:
    "Solo mode — Tandem's Claude is running, but Tandem hasn't seen it connect. Your comments and replies aren't sent to it until you switch to Tandem.",
  ariaLabel:
    "Solo mode. Tandem's Claude is running, but Tandem hasn't seen it connect. Your comments and replies aren't forwarded until you switch to Tandem.",
};

const NOT_CONNECTED: BaseView = {
  label: "AI not connected",
  tone: "not-connected",
  dataState: "not-connected",
  canAnimate: false,
  ...NO_OVERRIDE,
  title: "No AI is connected. Start Claude Code and run /mcp to connect.",
  ariaLabel: "No AI is connected",
};

/**
 * Collapse a home directory to `~` for display, so the OS username stays out of
 * an always-present tooltip (and out of screenshots of it). Cosmetic, not a
 * security boundary: it only recognises the three conventional home layouts.
 * (The server-side redactors, `src/shared/redact-user-paths.ts`, cover the same
 * layouts for diagnostics; this client copy has no `homedir()` to anchor on.)
 */
export function displayPath(path: string): string {
  // Case-insensitive because Windows paths are (`c:\users\…`), and an optional
  // `\\?\` extended-length prefix in case one reaches the server unstripped.
  const match =
    /^(?:\\\\\?\\)?([A-Za-z]:[\\/]Users[\\/][^\\/]+|\/home\/[^/]+|\/Users\/[^/]+)(?=$|[\\/])/i.exec(
      path,
    );
  return match ? `~${path.slice(match[0].length)}` : path;
}

/** Appended when a session is connected but the server could not match it to
 *  Tandem's own Claude — the usual case for the direct-HTTP config entry, which
 *  carries no Claude session id. */
const UNATTRIBUTED = " Tandem can't confirm that any connection is this Claude.";

/**
 * Tandem's own launched Claude is running.
 *
 * "Wakes it when you send a message" is the one wake claim in this file the
 * server can back: the supervisor writes a turn to the child's stdin. There is
 * deliberately no reply/latency clause — the attached session may be some other
 * client while this child has not connected. With no session seen, the pending
 * variant drops even the wake claim and says only "hasn't seen it connect":
 * "seen", not "connected", because a working stateless (#1249) child never sets
 * `hasSession`, and the copy has to stay true there.
 */
function tandemClaudeView(input: {
  attached: boolean;
  sessionSeen: boolean;
  cwd: string | null;
  busy: boolean;
  docSyncConnected: boolean;
}): BaseView {
  const where = input.cwd === null ? "" : ` in ${displayPath(input.cwd)}`;
  let title: string;
  if (!input.sessionSeen) {
    title = input.busy
      ? `Tandem's Claude is running${where} and working on a turn; Tandem hasn't seen it connect.`
      : `Tandem's Claude is running${where}; Tandem hasn't seen it connect.`;
  } else if (!input.docSyncConnected) {
    // With sync down the send toast is suppressed (state is `booting`), so this
    // is the only place that can say the message won't get there.
    title =
      `Tandem's Claude is running${where}. Document sync is down, so what you send now won't reach it until sync reconnects.` +
      (input.busy ? " It is in the middle of a turn." : "");
  } else if (input.busy) {
    // The wait is on the WAKE, not the message: Claude polls its inbox mid-turn,
    // and the chat pickup row (#2165) may show the message picked up first.
    title = `Tandem's Claude is running${where} and is in the middle of a turn. Tandem wakes it again when that turn finishes, if it hasn't picked up your message already.`;
  } else {
    title = `Tandem's Claude is running${where}. Tandem wakes it when you send a message.`;
  }
  if (input.sessionSeen && !input.attached) title += UNATTRIBUTED;
  return {
    label: "Tandem's Claude",
    // Green only when the server matched a live connection to THIS child. A
    // session that may be some other client is no evidence about this one.
    tone: input.attached ? "connected" : "pending",
    dataState: "tandem-claude",
    canAnimate: input.attached,
    // Only the supervisor-observed turn drives activity here (Bryan's rule).
    pulse: input.busy,
    ownActivity: input.busy ? "working" : null,
    title,
    ariaLabel: `Tandem's Claude. ${title}`,
  };
}

/** The visible suffix: "1 session", "3 sessions". */
export function sessionCountLabel(count: number): string {
  return count === 1 ? "1 session" : `${count} sessions`;
}

/**
 * Attach `/health`'s session count to a view. The count is an upper bound (see
 * `countDistinctClients` server-side), so the sentence names its main
 * overcount; the rest of its limits are in docs/troubleshooting.md. Nothing at
 * zero or unknown, and never on "AI not connected", whose label already says it.
 */
function withSessionCount(view: BaseView, count: number | null): AiIndicatorView {
  if (count == null || count < 1 || view.dataState === "not-connected") {
    return { ...view, sessionCount: null };
  }
  const sentence = `${sessionCountLabel(count)} ${count === 1 ? "is" : "are"} connected to Tandem. A session that closed can stay counted for up to about 35 minutes, and a frozen one until it closes.`;
  return {
    ...view,
    sessionCount: count,
    title: `${view.title} ${sentence}`,
    ariaLabel: `${view.ariaLabel} ${sentence}`,
  };
}

/**
 * Returns the indicator view, or `null` to render nothing (booting with no live
 * session, Solo with nothing running, or a stale-running launcher behind an
 * unreachable server).
 */
export function aiIndicatorView(input: AiIndicatorInput): AiIndicatorView | null {
  const view = baseIndicatorView(input);
  return view === null ? null : withSessionCount(view, input.sessionCount);
}

export interface AiIndicatorInput {
  state: AiReadinessState;
  liveIndicator: AiLiveIndicator;
  soloMode: boolean;
  pushDelivery: PushDelivery;
  launcherRunning: boolean;
  launcherCwd: string | null;
  launcherBusy: boolean;
  /** The server matched a live connection to this spawn of Tandem's Claude. */
  launcherAttached: boolean;
  launcherFailure: LauncherFailure | null;
  docSyncConnected: boolean;
  /** `/health`'s session count, or `null` when unknown. */
  sessionCount: number | null;
}

function baseIndicatorView(input: AiIndicatorInput): BaseView | null {
  // Rule 1: Solo. Solo already tells the user their comments are withheld,
  // which is a stronger and more relevant statement than any delivery state.
  if (input.liveIndicator === "solo-paused") {
    return input.launcherRunning ? SOLO_PAUSED_QUIET : SOLO_PAUSED;
  }
  if (input.soloMode) return input.launcherRunning ? SOLO_PAUSED_LAUNCHER : null;

  // Rule 2: Tandem's own Claude.
  if (input.launcherRunning) {
    return tandemClaudeView({
      attached: input.launcherAttached,
      // The two come from separate polls; a match on the launcher read is a
      // session seen even if `/health` has not caught up yet.
      sessionSeen: input.liveIndicator === "connected" || input.launcherAttached,
      cwd: input.launcherCwd,
      busy: input.launcherBusy,
      docSyncConnected: input.docSyncConnected,
    });
  }

  // Rule 3: anything else attached.
  if (input.liveIndicator === "connected") {
    const view = input.pushDelivery === "none" ? CONNECTED_NO_PUSH : CONNECTED;
    if (input.launcherFailure === null) return view;
    return {
      ...view,
      title: view.title + LEFTOVER_HINT,
      ariaLabel: view.ariaLabel + LEFTOVER_HINT,
    };
  }

  // Rule 4: gate the negative/absent states so we never flash "not connected".
  if (input.state === "booting") return null; // readiness not settled — don't flash
  // `ready` with nothing attached and no running launcher: the launcher status
  // is a stale `running: true` while the server is unreachable (which gates
  // `launcherRunning` off). Say nothing — the offline banner tells that story.
  if (input.state === "ready") return null;
  return NOT_CONNECTED; // unconfigured / stopped, Tandem: honest "not connected"
}

/** What the user dismissed: the failure, and the run epoch it happened in. */
export interface LauncherFailureDismissal {
  failure: LauncherFailure;
  epoch: number;
}

/**
 * The "Tandem's Claude isn't running" button's visibility after a dismissal.
 * Hidden only while it is the SAME failure in the SAME run epoch: a different
 * failure is new information, and so is the same one after Tandem's Claude has
 * run again in between (`launcherRunEpoch`), because that is a second outage,
 * not the one the user waved away. In memory only — a reload shows it again.
 *
 * Only the button obeys this. The tooltip's leftover hint keeps the raw failure,
 * since dismissing a button does not change the fact it reports.
 */
export function visibleLauncherFailure(
  failure: LauncherFailure | null,
  dismissed: LauncherFailureDismissal | null,
  epoch: number,
): LauncherFailure | null {
  if (failure === null) return null;
  return dismissed !== null && dismissed.failure === failure && dismissed.epoch === epoch
    ? null
    : failure;
}

// --- Working-directory drift qualifier (#1282) -----------------------------

export interface CwdDriftPill {
  /** Compact status-bar text. */
  label: string;
  /** Hover tooltip. */
  title: string;
  /** Screen-reader label — carries the full paths, which the pill elides. */
  ariaLabel: string;
  /** Menu heading: the explanation the pill has no room for. */
  explanation: string;
  /** Label for the act-on-it row. */
  actionLabel: string;
}

/**
 * The working-directory drift pill, or `null` to render nothing.
 *
 * **Why this is a sibling of the AI indicator and not folded into it.** The
 * drift pill describes the FOLDER, not the connection, and it carries its own
 * act-on-it menu. Folding it into `aiIndicatorView` would make one pill carry
 * two unrelated claims and two actions.
 *
 * **Why two adjacent Claude chips is not the #1268 shape.** That failure was two
 * CTAs for the same situation, describing it differently and wired to different
 * handlers. The drift pill cannot coexist with either stopped-launcher CTA:
 * `aiChip` is non-null only for `unconfigured` / `stopped`, and
 * `launcherFailure` only for a tripped launcher beside another session — both
 * mean the supervised launcher is not running, and the server reports drift only
 * when it IS. They can overlap only through staleness: `useCwdDrift` does not
 * poll, so a drift answer from before an unattended trip stays live. So either
 * one wins outright. This is a staleness gate, not a second copy of the server's
 * predicate: it never turns a `false` into a `true`.
 *
 * `drift` being non-null already means "the server says nudge"; suppression the
 * USER asked for (per-pair dismissal, session backstop, permanent opt-out) is
 * applied by the caller before this point, so it stays in one place —
 * `cwdDriftDismiss` — rather than half here and half there.
 */
export function cwdDriftPill(
  drift: CwdDrift | null,
  aiChip: AiChip,
  launcherFailure: LauncherFailure | null,
): CwdDriftPill | null {
  if (drift === null) return null;
  if (aiChip !== null || launcherFailure !== null) return null;
  // Names the consequence, not the state. "AI · other folder" reads as a
  // connection status and leaves the user with no idea what is actually
  // degraded — the document syncs fine and Claude can still edit it; what it
  // cannot see is everything AROUND the document.
  const consequence =
    `Claude is running in ${drift.claudeCwd}, not ${drift.suggestedCwd}. ` +
    "It can still read and edit this document, but it can't see that folder's " +
    "CLAUDE.md, .claude/ settings or git history, and its own file tools can't " +
    "reach the files beside it.";
  return {
    label: `Claude in ${drift.claudeLabel}`,
    title: consequence,
    ariaLabel: `Working folder mismatch. ${consequence}`,
    explanation: consequence,
    actionLabel: `Restart Claude in ${drift.label}…`,
  };
}
