import type { LauncherStandby } from "../../shared/launcher/contract";
import type { AiRemedy } from "../hooks/useAiReadiness.svelte";

/**
 * The chat panel's "Claude is resuming…" row (#2196): what happened to a chat
 * message the user sent while Tandem's Claude was stopped by choice.
 *
 * The server starts Claude for such a message on its own (the supervisor's
 * standby watch); this only reports it. A request is recorded at send time and
 * ONLY when the server said a message would start Claude
 * (`launcherStartsOnMessage`), so the row never promises an answer nothing is
 * coming to give — with another AI attached, or the licence refusing, there is
 * no request and no row.
 *
 * Once Claude is running the row steps aside for the pickup row, which reads
 * the chat map and knows whether the message was read.
 */
export type ChatResume =
  | { kind: "resuming"; verb: "resuming" | "starting" }
  | { kind: "failed"; remedy: AiRemedy };

export interface ChatResumeRequest {
  at: number;
  /** The standby at send time: an idle-stopped Claude is "resuming", one that
   * was off or never started this session is "starting". */
  from: LauncherStandby;
}

/** How long a start may take to show up in the launcher status before the row
 * stops promising. The status poll is 8 s and the post-send re-reads land well
 * inside this, so a start that has not begun by then is not coming. */
export const RESUME_GRACE_MS = 20_000;

export interface ChatResumeInput {
  running: boolean;
  /** `/health` has gone quiet for a strike run: the server is gone, and the
   * offline notice speaks for the message. */
  serverUnreachable: boolean;
  /** A start or restart is under way (`launcherRestarting`). */
  restarting: boolean;
  /** Still in standby with nothing under way. */
  standby: LauncherStandby | null;
  /** `launcherRemedy`. */
  remedy: AiRemedy | null;
  now: number;
}

export function chatResume(
  request: ChatResumeRequest | null,
  input: ChatResumeInput,
): ChatResume | null {
  if (request === null || input.running || input.serverUnreachable) return null;
  const resuming: ChatResume = {
    kind: "resuming",
    verb: request.from === "idle" ? "resuming" : "starting",
  };
  const inGrace = input.now - request.at < RESUME_GRACE_MS;
  // The licence refuses the AI (#1521): nothing will start, whatever the
  // standby says, and Start would be refused. Its own remedy, not "start".
  if (input.remedy === "ai-off") return { kind: "failed", remedy: "ai-off" };
  // A start under way. `restarting` is the fresh-gated reading; a standby with
  // no remedy is the RAW `restartPending` — one failed status read during a
  // long start must not turn "resuming" into "couldn't start".
  if (input.restarting || (input.standby !== null && input.remedy === null)) return resuming;
  // Still in standby with nothing under way: the server has not begun, or has
  // not been re-read since the send. Inside the grace that is the normal gap;
  // past it the start is not coming (another AI attached meanwhile, say).
  if (input.standby !== null) return inGrace ? resuming : { kind: "failed", remedy: "start" };
  // Not running, not starting, not in standby: the start ended in a failure
  // the launcher reports (`lastError`, not-configured) — or the status is
  // unknown for now, which earns the grace and then silence, never a claim.
  if (input.remedy !== null) return { kind: "failed", remedy: input.remedy };
  return inGrace ? resuming : null;
}

const RESUMING_TEXT = {
  resuming: "Claude is resuming… it will answer when it's back.",
  starting: "Starting Tandem's Claude… it will answer when it's ready.",
} as const;

export const RESUME_FAILED_TEXT =
  "Tandem's Claude couldn't start, so your message hasn't been answered yet.";

/** The row's line; the visible row and the announcement both read it. */
export function chatResumeLabel(resume: ChatResume): string {
  return resume.kind === "failed" ? RESUME_FAILED_TEXT : RESUMING_TEXT[resume.verb];
}
