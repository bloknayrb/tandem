import type { AiRemedy } from "../hooks/useAiReadiness.svelte";

/**
 * The chat panel's note when Tandem's Claude was asked for its one-time hello
 * and nothing arrived (#2197; Bryan: "Claude didn't respond — here's how to fix
 * it"). Whether it shows is the server's call (`LauncherStatus.greetingLate`),
 * never the chat map's, so clearing the chat cannot make it appear.
 *
 * The action: `relaunch` while Tandem's Claude is running (after the fix, a
 * restart is how it picks it up), otherwise the stopped launcher's own remedy
 * (sign-in first, for the usual cause). No note at all where it would mislead
 * or where its button would do harm — see `greetingNoteAction`.
 */
export type GreetingAction = AiRemedy | "relaunch";

export const GREETING_LATE_TEXT =
  "Tandem's Claude hasn't said hello. It may not be signed in to Claude Code (run `claude` in a terminal to sign in), or not allowed to use Tandem's tools — see “Tandem's Claude didn't say hello” in the troubleshooting guide.";

export const GREETING_RELAUNCH = {
  label: "Restart Tandem's Claude",
  title: "Restart Tandem's Claude after signing in or allowing its tools.",
  ariaLabel: "Restart Tandem's Claude.",
} as const;

/** What readiness knows, for `greetingNoteAction`. */
export interface GreetingNoteInputs {
  greetingLate: boolean;
  serverUnreachable: boolean;
  /** The licence refuses the AI: the AI-off surfaces speak, not this note. */
  aiOff: boolean;
  /** Stopped by choice or idle: nothing for the note to fix. */
  stoppedByChoice: boolean;
  /** Mid-turn: a slow hello is not a missing one, and Restart would kill it. */
  busy: boolean;
  running: boolean;
  /** `launcherRemedy`: null while stopped means a restart is already under
   * way (or the status is stale) — offering Restart then would relaunch over
   * the automatic retry. */
  remedy: AiRemedy | null;
}

/** The note's action, or null for no note (#2197). */
export function greetingNoteAction(i: GreetingNoteInputs): GreetingAction | null {
  if (!i.greetingLate || i.serverUnreachable || i.aiOff || i.stoppedByChoice || i.busy) {
    return null;
  }
  return i.running ? "relaunch" : i.remedy;
}
