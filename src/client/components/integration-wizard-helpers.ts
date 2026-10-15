/**
 * Pure decision helpers for the integration wizard's Done screen.
 *
 * Extracted from `IntegrationWizardModal.svelte` so the honesty contract
 * (WS-B) can be unit-tested without mounting the modal — the derived that
 * consumes this is a thin wrapper.
 */

import { type IntegrationConfig, targetPushSupport } from "../../shared/integrations/contract.js";
import type { LauncherStandby, TandemClaudeAfterSetup } from "../../shared/launcher/contract.js";
import type { AiRemedy } from "../hooks/useAiReadiness.svelte";

export type DoneHeaderState = "connected" | "waiting" | "partial";

/**
 * The Done header must not claim connection before it happens (WS-B). A
 * successful config WRITE is not a connection — Claude has to restart to load
 * the entry — so the headline and its success glyph gate on the actual
 * `claudeConnected` round-trip, not on the apply succeeding. A green check
 * above "waiting" copy would re-tell the very lie this feature fixes.
 *
 * - `partial` — at least one apply item errored (takes precedence; a broken
 *   write can't have connected).
 * - `connected` — Claude has actually reached the server.
 * - `waiting` — config written, no connection yet (the common post-apply state).
 */
export function computeDoneHeaderState(
  anyApplyErrors: boolean,
  claudeConnected: boolean,
): DoneHeaderState {
  if (anyApplyErrors) return "partial";
  return claudeConnected ? "connected" : "waiting";
}

/**
 * Copy for a client Tandem structurally cannot notify.
 *
 * `text` only — no `ariaLabel` sibling, unlike `AI_CTA` and `AiIndicatorView`.
 * Those describe a terse control ("AI connected", a button) whose visible text
 * under-specifies it; this is a full sentence rendered as plain body text in a
 * `<span>`, so the accessible name IS the text. Adding an `aria-label` would
 * also be ARIA-prohibited on a generic element and can suppress the content it
 * was meant to clarify.
 */
export interface PushSupportNote {
  text: string;
}

/**
 * Deliberately kind-agnostic: it is rendered inside a result row that already
 * names the target, and it must stay correct if a second kind ever joins
 * `"none"`. It states only the sound half of `TargetPushSupport` — that nothing
 * will notify — and reframes the consequence as deferred, not lost.
 *
 * Two words in it are load-bearing, and the first draft got both wrong.
 *
 * "Tandem can't notify this one", not "no real-time updates for this app": the
 * sentence is read INSIDE Tandem, where "this app" is at least as likely to
 * parse as Tandem itself. Naming the actor fixes the referent without naming a
 * kind, so the row's own label still supplies which target.
 *
 * "the next time it CHECKS IN", not "the next time you prompt it". Delivery is
 * the AI's action, not the user's: Claude sees a comment when it calls
 * `tandem_checkInbox`, which a given turn may simply not do. Promising it lands
 * on the next prompt is a delivery guarantee of exactly the kind
 * `targetPushSupport`'s docblock forbids — the same sin as reading
 * `subscribers > 0` as "push works", pointed the other way. This is now the
 * verbatim tail of `CONNECTED_NO_PUSH` in `status/status-ai-view.ts` and of the
 * `no-push` send notice, which is what "matches the sibling copy" was always
 * supposed to mean.
 */
const NO_PUSH_TRANSPORT: PushSupportNote = {
  text: "Tandem can't notify this one in real time — it'll see your comments and messages the next time it checks in, not as they happen.",
};

/**
 * The Done screen's per-target delivery line, or `null` to say nothing.
 *
 * Only the confirmed-`"none"` case renders. `"possible"` stays SILENT rather
 * than rendering an affirmative counterpart — a transport existing in the
 * config is not delivery (`connection-honesty-findings.md` A5/A7), and the
 * wizard already has a separate, correctly-hedged push-mode block for the
 * Claude Code side. Adding "real-time updates are on" here would be exactly the
 * guarantee `targetPushSupport`'s docblock forbids.
 *
 * Unknown / unapplicable kinds (`other-mcp`, or a row whose picked entry has
 * gone) also return `null`: absence of knowledge is not a negative. That is the
 * same asymmetry `PushDelivery`'s `"unknown"` encodes.
 *
 * The guard EXCLUDES the kinds `targetPushSupport` cannot speak for rather than
 * listing the ones it can. Those are the same two sets today, but only the
 * exclusion form stays honest: `IntegrationConfig["kind"]` minus `"other-mcp"`
 * IS `DetectedTarget["kind"]`, so a future detected kind reaches the predicate
 * automatically. An allow-list would have silenced it — quietly reinstating the
 * very "we knew and didn't say" bug this function exists to fix, and the
 * predicate-pinned test above would not have caught it, since a kind absent
 * from the list is also absent from the loop.
 *
 * #1299: this fact was decided at wizard time and never spoken. The reporter
 * connected Claude Desktop, saw "AI connected", sent two messages, and was
 * ignored — because for that client push does not fail, it does not exist.
 */
export function pushSupportNote(
  kind: IntegrationConfig["kind"] | undefined,
): PushSupportNote | null {
  if (kind === undefined || kind === "other-mcp") return null;
  return targetPushSupport(kind) === "none" ? NO_PUSH_TRANSPORT : null;
}

/** The done screen's sign-in step (#2199): Claude Code runs but has never been
 * signed in. "Open a new terminal" rather than a path: the installer adds
 * `~/.local/bin` to the PATH of terminals opened after it, and a typed path
 * differs per shell. */
const TANDEM_CLAUDE_SIGN_IN_LINE =
  "One more step: sign in to Claude Code. Open a new terminal, run claude, and sign in when it asks — you can close the terminal once you're signed in. Then choose Check sign-in.";

/** Readiness's live view of Tandem's Claude, for the done screen's line. */
export interface TandemClaudeLive {
  running: boolean;
  /** `launcherRemedy`: non-null when it is stopped and something would fix it. */
  remedy: AiRemedy | null;
  standby: LauncherStandby | null;
}

/**
 * Whether the done screen's line about Tandem's own Claude is the "running"
 * or "starting" one (#2199) — the only case where "open the chat panel to
 * talk to it" is true. One predicate, so the guidance above that line can
 * never contradict it: a standby, a sign-in stop or any other remedy reads
 * as held or failed there.
 */
export function tandemClaudeIsStartingOrRunning(
  initial: TandemClaudeAfterSetup | null,
  live: TandemClaudeLive | null,
): boolean {
  if (live?.running === true) return initial !== null;
  return (
    (initial === "starting" || initial === "running") &&
    !live?.standby &&
    (live?.remedy == null || live.remedy === "start")
  );
}

/** The done screen is at its sign-in step (#2199): the line above says so, and
 * the screen offers Check sign-in — one predicate, so the two never part. */
export function tandemClaudeNeedsSignIn(
  initial: TandemClaudeAfterSetup | null,
  live: TandemClaudeLive | null,
): boolean {
  return (
    initial !== null &&
    initial !== "unknown" &&
    live?.running !== true &&
    live?.remedy === "sign-in"
  );
}

/**
 * The done screen's line about Tandem's OWN Claude (#2197; #2180 item 5), or
 * `null` to say nothing (no claude-code entry written, an older server, or an
 * answer that came too late to trust).
 *
 * The rest of the done screen is about the user's Claude Code config — whether
 * their terminal sessions can reach Tandem. This line is about the background
 * Claude Tandem runs itself, which a first Apply now starts. The apply's answer
 * is only the starting point: once the launcher status says Claude is running,
 * or has failed, that wins, so the line never keeps promising a start that
 * already went wrong.
 */
export function tandemClaudeDoneCopy(
  initial: TandemClaudeAfterSetup | null,
  live: TandemClaudeLive | null,
): string | null {
  if (initial === null) return null;
  // Held copy, shared by an Apply that held and one whose start has since
  // settled into a standby (an idle stop while the screen is open).
  const heldLine = (): string => {
    if (live?.standby === "off") {
      return "Tandem's own Claude is turned off. Start it from the status bar or the chat panel when you want it.";
    }
    if (live?.standby === "idle") {
      return "Tandem's own Claude stopped while it was idle. Sending a chat message starts it again.";
    }
    // Held over a diagnosis (a crash loop, a sign-in stop, a stop that
    // could not be confirmed): that, not Start, is what needs attention.
    if (live?.remedy && live.remedy !== "start") {
      return "Tandem's own Claude is stopped. The status bar shows what to do.";
    }
    return "Tandem's own Claude starts when you click Start in the status bar or the chat panel, or send it a chat message.";
  };
  // Whatever the Apply answered, a Claude that is running now is the truth.
  if (live?.running) {
    return "Tandem's own Claude is running in the background. Open the chat panel to talk to it — on a first run it says hello there, unless Solo mode is on.";
  }
  // Next, whatever the Apply answered (#2199): a Claude Code that runs but is
  // not signed in is the one thing still in the way, and the step is the
  // user's. Ahead of the switch, so an `other-ai` or `held` answer that a
  // later Start overtook does not keep its stale line.
  if (tandemClaudeNeedsSignIn(initial, live)) return TANDEM_CLAUDE_SIGN_IN_LINE;
  // The launcher's answer timed out, and nothing since says it is running.
  if (initial === "unknown") return null;
  if (initial === "starting" || initial === "running") {
    if (live?.standby) return heldLine();
    if (live?.remedy && live.remedy !== "start") {
      return "Tandem's own Claude couldn't start. The status bar shows what to do.";
    }
    return "Tandem is starting its own Claude in the background. Open the chat panel to talk to it — on a first run it says hello there, unless Solo mode is on.";
  }
  switch (initial) {
    case "held":
      return heldLine();
    case "other-ai":
      return "Tandem didn't start its own Claude, because another AI session is already connected to it.";
    case "refused":
      return "Tandem's AI features are off, so it didn't start its own Claude. See Settings → License.";
    case "not-configured":
      return "Tandem couldn't find the Claude Code setup it just saved, so it didn't start its own Claude. Try running setup again.";
    case "cli-unusable":
      return "Tandem couldn't find Claude Code on this computer, so it didn't start its own Claude. Install Claude Code, then start it from the status bar.";
    default: {
      const _exhaustive: never = initial;
      return _exhaustive;
    }
  }
}
