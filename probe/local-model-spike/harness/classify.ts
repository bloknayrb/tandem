/**
 * What kind of ending a trial had (brief R2.6).
 *
 * Three families:
 *  - `infrastructure`: the endpoint, not the model. Not a scored trial: logged,
 *    left out of every rate, counted, and run again on resume.
 *  - a scored FAILURE with its own column: the user got a notice, a cut reply
 *    or nothing, whatever the text says.
 *  - `completed`: the run ended cleanly; the scorer decides pass or fail.
 *
 * The rule, in order:
 *  1. No turn ran at all → infrastructure (a harness fault, never the model's).
 *  2. The loop's exit is `timeout` → `timeout`; `max_turns` / `max_tool_calls`
 *     → `budget`; `editing_off` → `editing_off`.
 *  3. The chat row ends with the sink's truncation marker → `stream_cap`, for
 *     any exit (checked first). Otherwise exit `aborted` or `doc-swapped`:
 *     nothing in a trial aborts a run or swaps its document, so it is a
 *     harness fault → infrastructure.
 *  4. Exit `error`, read from the LAST chat request the fetch tap saw (the
 *     one that failed), whatever earlier turns streamed:
 *     - `fetch` threw before any response (connection refused or reset, DNS)
 *       → infrastructure;
 *     - HTTP 404, 429, 502, 503 or 504 → infrastructure (404 is how Ollama is
 *       ASSUMED to answer for a model it does not have);
 *     - the loop's message says the endpoint is invalid → infrastructure;
 *     - anything else — any other status including 500, the response-size cap,
 *       an unreadable response, an error with no attributable cause → a scored
 *       failure (`error`).
 *  5. Exit `clean`: if any raw stream carried an error frame → `error_frame`
 *     (a scored failure); otherwise `completed`.
 *
 * Known misses, both directions:
 *  - an HTTP 500 that is the server's own fault (out of memory while loading)
 *    is scored against the model; a 5xx in the infrastructure set that is
 *    really the server choking on a model's malformed tool call is excused;
 *  - a connection that drops mid-stream (the failing request had a response)
 *    is scored as `error` even if the server crashed;
 *  - a whitespace-only stream that reaches the sink's cap writes no marker and
 *    exits `aborted`, so it is excused as infrastructure;
 *  - a server that answers 200 with an error body in a shape other than a
 *    top-level `error` key is seen as whatever the product makes of it.
 */
import { TRUNCATION_MARKER } from "../../../src/server/local-model/collaborator.js";
import type { TrialObservation } from "./trial.js";

export type TrialEnding =
  | "completed"
  | "timeout"
  | "budget"
  | "editing_off"
  | "stream_cap"
  | "error"
  | "error_frame"
  | "infrastructure";

export interface Classification {
  ending: TrialEnding;
  /** Short, fixed-vocabulary reason for the log and the report. */
  detail: string;
}

/** HTTP statuses counted as the endpoint's fault, not the model's. */
export const INFRASTRUCTURE_STATUSES: ReadonlySet<number> = new Set([404, 429, 502, 503, 504]);

export function classifyTrial(obs: TrialObservation): Classification {
  if (obs.loop === null) return { ending: "infrastructure", detail: "no-turn-ran" };
  const { exit, errorMessage } = obs.loop.metrics;

  // The sink's streaming cap, whatever the exit: the cap usually aborts the
  // run, but when it lands on the stream's last chunk the loop exits cleanly
  // and the final flush commits the marker.
  if (obs.reply.endsWith(TRUNCATION_MARKER)) {
    return { ending: "stream_cap", detail: "sink-streaming-cap" };
  }

  if (exit === "timeout") return { ending: "timeout", detail: "timeout" };
  if (exit === "max_turns" || exit === "max_tool_calls") return { ending: "budget", detail: exit };
  if (exit === "editing_off") return { ending: "editing_off", detail: "editing_off" };
  if (exit === "aborted") return { ending: "infrastructure", detail: "aborted-by-harness" };
  if (exit === "doc-swapped") return { ending: "infrastructure", detail: "doc-swapped" };

  if (exit === "error") {
    const last = obs.fetches[obs.fetches.length - 1];
    if (last?.thrown && last.thrown.name !== "AbortError") {
      return { ending: "infrastructure", detail: `fetch-threw:${last.thrown.code ?? "unknown"}` };
    }
    if (last && last.status !== null && INFRASTRUCTURE_STATUSES.has(last.status)) {
      return { ending: "infrastructure", detail: `http-${last.status}` };
    }
    if (/invalid local-model endpoint/.test(errorMessage ?? "")) {
      return { ending: "infrastructure", detail: "invalid-endpoint" };
    }
    if (last && last.status !== null && last.status >= 400) {
      return { ending: "error", detail: `http-${last.status}` };
    }
    if (/exceeded .*cap/.test(errorMessage ?? "")) return { ending: "error", detail: "response-cap" };
    const failing = obs.turns[obs.turns.length - 1];
    if (failing && failing.hadToolCalls === null && failing.text.length > 0) {
      // The failing request had already streamed text: the user watched a
      // reply start and then got a notice.
      return { ending: "error", detail: "error-after-text" };
    }
    if (/non-JSON response/.test(errorMessage ?? "")) return { ending: "error", detail: "unreadable" };
    return { ending: "error", detail: "unattributed" };
  }

  if (obs.fetches.some((f) => f.errorFrame)) return { ending: "error_frame", detail: "error-frame" };
  return { ending: "completed", detail: "clean" };
}

export function isScored(ending: TrialEnding): boolean {
  return ending !== "infrastructure";
}
