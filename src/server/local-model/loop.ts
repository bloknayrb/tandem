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
  exit: "clean" | "max_turns" | "max_tool_calls" | "aborted" | "error";
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
      metrics.turns += 1;
      const res = await chat({
        config,
        messages,
        tools,
        temperature: opts.temperature,
        timeoutMs: opts.timeoutMs,
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
    // An abort surfaces as a fetch AbortError — classify it as "aborted", not "error".
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      metrics.exit = "aborted";
    } else {
      metrics.exit = "error";
      metrics.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  metrics.wallMs = Date.now() - started;
  return { metrics, steps, finalContent, messages };
}
