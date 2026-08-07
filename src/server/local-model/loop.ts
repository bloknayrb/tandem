/**
 * Tool-use turn loop for the local-model collaborator (#1123 M1, ADR-039) —
 * productionized from `probe/local-model-spike/loop.ts`.
 *
 * Wires the chat client <-> tool dispatch over a single Y.Doc, with hard
 * budgets and per-run metrics. Malformed tool-call JSON is a MEASURED outcome
 * (recorded), not a crash. Transport-agnostic.
 *
 * Production additions over the harness:
 *  - `signal`: an AbortSignal threaded into the chat client so a shutdown,
 *    document switch, or superseding message can abort an in-flight turn
 *    (exit "aborted"); under ADR-039 "one active agent at a time".
 *  - `history`: prior-turn conversation messages, so M1.2 can supply per-doc
 *    chat continuity (M1.1 defaults to none).
 *  - `isLicenseRestricted`: forwarded to dispatch so mutating tools honor the
 *    license gate.
 */
import type * as Y from "yjs";
import type { LocalModelConfig } from "./config.js";
import { type ChatMessage, chat, type ToolSchema } from "./ollama-client.js";
import { dispatch, type ToolOutcome } from "./tools.js";

export interface LoopMetrics {
  turns: number;
  toolCalls: number;
  jsonParseFailures: number;
  /** ANY failed comment/replacement anchor — quote not found OR a found span the
   *  server rejected (heading overlap, RANGE_*). Not just ANCHOR_NOT_FOUND, so
   *  the capability ledger can't under-report a documented model failure mode. */
  anchorResolutionFailures: number;
  flatOnlyAnchors: number; // fullyAnchored === false on a successful anchor
  /** failed reply_to_annotation calls (bad/hallucinated id, wrong type) */
  replyFailures: number;
  blockedByLicense: number;
  wallMs: number;
  /**
   * `timeout` is deliberately NOT folded into `max_turns` (#1295 L6). The
   * collaborator branches on `max_turns` to tell the user the model "reached
   * its step limit" — true for a turn-budget exit, a lie for a wall-clock one,
   * and it points them at raising `maxTurns` for what is actually a stalling
   * endpoint. It would also contradict `turns`, which stays below the budget.
   *
   * `timeout` covers BOTH wall-clock expiries: the run-budget clamp and a plain
   * per-turn `timeoutMs`. Neither is caller-initiated, and `aborted` is silent
   * by design, so bucketing either one there tells the user nothing at all.
   */
  exit: "clean" | "max_turns" | "max_tool_calls" | "timeout" | "aborted" | "error";
  errorMessage?: string;
}

export interface LoopStep {
  turn: number;
  assistantContent: string;
  toolCalls: {
    name: string;
    args: Record<string, unknown> | null;
    rawArgs: string;
    parseError?: string;
    outcome: ToolOutcome["effect"];
  }[];
  latencyMs: number;
}

export interface LoopResult {
  metrics: LoopMetrics;
  steps: LoopStep[];
  /** the final plain-text assistant message (chat answer), if any */
  finalContent: string;
  /** the full message transcript, for per-doc conversation continuity (M1.2) */
  messages: ChatMessage[];
}

/**
 * Aggregate wall-clock ceiling for one run (#1295 L6).
 *
 * Five minutes: comfortably above a slow-but-working local model answering a
 * multi-turn task, and far below the ~36 minutes (12 turns x 180 s) a slow
 * endpoint could hold by answering each turn just inside its per-turn timeout.
 *
 * Note the shape carefully: a turn that actually HITS `timeoutMs` throws and
 * ends the whole run at the first timeout, so the long hold is built from turns
 * that COMPLETE late, not from turns that time out. `timeoutMs` cannot bound it
 * because it only ever bounds one turn.
 */
const DEFAULT_RUN_DEADLINE_MS = 5 * 60_000;

/** Mirrors `DEFAULT_TIMEOUT_MS` in the client — only used to compute the clamp
 *  below, so the client stays the single authority on the value it applies. */
const CLIENT_DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Per-turn timeout, clamped to whatever remains of the run deadline (#1295 L6).
 * Never returns 0 or negative: the loop's top-of-iteration deadline check is
 * what stops the run, and handing `chat()` a non-positive timeout would abort
 * instantly and surface as a confusing transport error instead.
 */
function turnTimeoutMs(
  configured: number | undefined,
  started: number,
  deadlineMs: number,
): number {
  const perTurn = configured ?? CLIENT_DEFAULT_TIMEOUT_MS;
  const remaining = deadlineMs - (Date.now() - started);
  return Math.max(1, Math.min(perTurn, remaining));
}

export interface RunLoopOpts {
  ydoc: Y.Doc;
  config: LocalModelConfig;
  tools: ToolSchema[];
  systemPrompt: string;
  userPrompt: string;
  /** prior conversation turns to continue (M1.2); defaults to none */
  history?: ChatMessage[];
  maxTurns?: number;
  maxToolCalls?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Raw response-byte ceiling per `chat()` call. Omitted → the client's
   *  `DEFAULT_MAX_RESPONSE_BYTES`, which is sized for a whole JSON response
   *  rather than a chat bubble (#1292). */
  maxResponseBytes?: number;
  /** Aggregate wall-clock ceiling for the whole run (#1295 L6). Defaults to
   *  {@link DEFAULT_RUN_DEADLINE_MS}. `timeoutMs` bounds one turn; this bounds
   *  all of them together. */
  runDeadlineMs?: number;
  signal?: AbortSignal;
  isLicenseRestricted?: () => boolean;
  /** When set, every turn streams and this fires per assistant content delta
   *  (#1123 M1.2). Tool-use turns stream too (their content is preamble); the
   *  loop's tool-call detection + metrics are unchanged. */
  onContentDelta?: (delta: string) => void;
  /** Fires once per turn after `chat()` returns, before tool dispatch (#1123
   *  M1.2). `hadToolCalls` lets a streaming sink discard a tool-call turn's
   *  preamble so the next turn's content replaces it instead of bleeding in. */
  onTurnEnd?: (info: { hadToolCalls: boolean }) => void;
}

export async function runLoop(opts: RunLoopOpts): Promise<LoopResult> {
  const { ydoc, config, tools, systemPrompt, userPrompt, signal } = opts;
  const maxTurns = opts.maxTurns ?? 12;
  const maxToolCalls = opts.maxToolCalls ?? 20;
  const runDeadlineMs = opts.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(opts.history ?? []),
    { role: "user", content: userPrompt },
  ];

  const metrics: LoopMetrics = {
    turns: 0,
    toolCalls: 0,
    jsonParseFailures: 0,
    anchorResolutionFailures: 0,
    flatOnlyAnchors: 0,
    replyFailures: 0,
    blockedByLicense: 0,
    wallMs: 0,
    exit: "clean",
  };
  const steps: LoopStep[] = [];
  let finalContent = "";
  const started = Date.now();

  try {
    while (metrics.turns < maxTurns) {
      if (signal?.aborted) {
        metrics.exit = "aborted";
        break;
      }
      // #1295 L6: `timeoutMs` bounds a single turn, so 12 turns that each
      // complete just inside it hold a run for ~36 minutes. This is the
      // aggregate ceiling. It fires only for a run whose LAST turn returned at
      // or after the deadline — a turn still in flight is cut by the clamp
      // below and classified in the catch instead.
      if (Date.now() - started >= runDeadlineMs) {
        metrics.exit = "timeout";
        break;
      }
      metrics.turns += 1;
      const res = await chat({
        config,
        messages,
        tools,
        temperature: opts.temperature,
        // Clamp the per-turn timeout to what is left of the run budget, so the
        // deadline can't be overshot by a whole turn. Checking only at the top
        // of the loop would let a turn that starts one millisecond inside the
        // budget run the full `timeoutMs` past it.
        timeoutMs: turnTimeoutMs(opts.timeoutMs, started, runDeadlineMs),
        maxResponseBytes: opts.maxResponseBytes,
        signal,
        onContentDelta: opts.onContentDelta,
      });

      // An abort that fired during the await but LOST the race (chat() resolved
      // before the abort propagated, so no AbortError was thrown) would otherwise
      // dispatch this turn's tool writes onto a doc the user just superseded /
      // closed / switched away from. dispatch() is synchronous, so the only
      // interleave point is here, post-await — re-check before processing the
      // turn so a stale run lands no annotations (symmetric with the gated chat
      // write-back in collaborator.ts).
      if (signal?.aborted) {
        metrics.exit = "aborted";
        break;
      }

      if (res.toolCalls.length === 0) {
        finalContent = res.content;
        steps.push({
          turn: metrics.turns,
          assistantContent: res.content,
          toolCalls: [],
          latencyMs: res.latencyMs,
        });
        metrics.exit = "clean";
        opts.onTurnEnd?.({ hadToolCalls: false });
        break;
      }
      opts.onTurnEnd?.({ hadToolCalls: true });

      // Echo the assistant turn (with its tool calls) back into the transcript.
      messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });

      const stepCalls: LoopStep["toolCalls"] = [];
      for (const tc of res.toolCalls) {
        metrics.toolCalls += 1;
        if (tc.parseError) metrics.jsonParseFailures += 1;

        const outcome = dispatch(tc.name, tc.args, {
          ydoc,
          isLicenseRestricted: opts.isLicenseRestricted,
          // #1123 M3: the byline identity is prebuilt on the config (one source,
          // no extra RunLoopOpts field, no per-dispatch allocation).
          agentIdentity: config.agentIdentity,
        });
        const eff = outcome.effect;
        if (eff.kind === "blocked") metrics.blockedByLicense += 1;
        if ((eff.kind === "comment" || eff.kind === "replacement") && !eff.ok) {
          // Any anchor failure: quote-not-found OR a found-but-rejected span.
          metrics.anchorResolutionFailures += 1;
        }
        if (
          (eff.kind === "comment" || eff.kind === "replacement") &&
          eff.ok &&
          eff.fullyAnchored === false
        ) {
          metrics.flatOnlyAnchors += 1;
        }
        if (eff.kind === "reply" && !eff.ok) metrics.replyFailures += 1;

        stepCalls.push({
          name: tc.name,
          args: tc.args,
          rawArgs: tc.rawArgs,
          parseError: tc.parseError,
          outcome: eff,
        });

        // Tool result message (transport-shaped in ollama-client.ts).
        messages.push({
          role: "tool",
          content: JSON.stringify(outcome.result),
          tool_call_id: tc.id,
          tool_name: tc.name,
        });

        if (metrics.toolCalls >= maxToolCalls) break;
      }
      steps.push({
        turn: metrics.turns,
        assistantContent: res.content,
        toolCalls: stepCalls,
        latencyMs: res.latencyMs,
      });

      if (metrics.toolCalls >= maxToolCalls) {
        metrics.exit = "max_tool_calls";
        break;
      }
    }
    if (
      metrics.turns >= maxTurns &&
      metrics.exit === "clean" &&
      steps[steps.length - 1]?.toolCalls.length
    ) {
      metrics.exit = "max_turns";
    }
  } catch (err) {
    // An abort surfaces as a fetch AbortError, but TWO different things abort a
    // turn and they mean opposite things to the user (#1295 L6 follow-up):
    //
    //  - the CALLER's signal (supersede / doc close / doc switch / shutdown, and
    //    the streaming sink's own cap-abort). Deliberately silent — the user
    //    caused it and already has the partial reply on screen.
    //  - `postLoopback`'s internal timeout controller, which is the ONLY other
    //    abort source in the client. That is a wall-clock expiry: either the
    //    per-turn `timeoutMs` or the clamp to what remained of the run budget
    //    (`turnTimeoutMs`). Both must reach the user.
    //
    // The clamp is why the top-of-loop deadline check is not enough on its own:
    // it hands `chat()` a timeout that expires exactly AT the deadline, so the
    // in-flight turn always aborts before the loop can come back around and see
    // `Date.now() - started >= runDeadlineMs`. Classifying every AbortError as
    // "aborted" therefore made the "timeout" exit — and the collaborator's
    // "it ran out of time" notification — unreachable, leaving a run that stalls
    // out with no message at all.
    //
    // `signal?.aborted` is checked FIRST so a caller abort that races a timeout
    // stays silent.
    if (signal?.aborted) {
      metrics.exit = "aborted";
    } else if (err instanceof Error && err.name === "AbortError") {
      metrics.exit = "timeout";
    } else {
      metrics.exit = "error";
      metrics.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  metrics.wallMs = Date.now() - started;
  return { metrics, steps, finalContent, messages };
}
