/**
 * Tool-use turn loop for the #1123 M0 spike.
 *
 * Wires ollama.chat <-> tools.dispatch over a single in-memory Y.Doc, with
 * hard budgets and per-run metric accumulation. Malformed tool-call JSON is a
 * MEASURED outcome (recorded), not a crash. The loop is transport-agnostic.
 */
import type * as Y from "yjs";

import { chat, type ChatMessage, type Transport, type ToolSchema } from "./ollama.js";
import { dispatch, type ToolOutcome } from "./tools.js";

export interface LoopMetrics {
  turns: number;
  toolCalls: number;
  jsonParseFailures: number;
  anchorResolutionFailures: number;
  flatOnlyAnchors: number; // fullyAnchored === false on a successful anchor
  wallMs: number;
  exit: "clean" | "max_turns" | "max_tool_calls" | "error";
  errorMessage?: string;
}

export interface LoopStep {
  turn: number;
  assistantContent: string;
  toolCalls: { name: string; args: Record<string, unknown> | null; rawArgs: string; parseError?: string; outcome: ToolOutcome["effect"] }[];
  latencyMs: number;
}

export interface LoopResult {
  metrics: LoopMetrics;
  steps: LoopStep[];
  /** the final plain-text assistant message (chat answer), if any */
  finalContent: string;
  rawResponses: unknown[];
}

export interface RunLoopOpts {
  ydoc: Y.Doc;
  model: string;
  transport: Transport;
  tools: ToolSchema[];
  systemPrompt: string;
  userPrompt: string;
  maxTurns?: number;
  maxToolCalls?: number;
  temperature?: number;
  timeoutMs?: number;
}

export async function runLoop(opts: RunLoopOpts): Promise<LoopResult> {
  const { ydoc, model, transport, tools, systemPrompt, userPrompt } = opts;
  const maxTurns = opts.maxTurns ?? 12;
  const maxToolCalls = opts.maxToolCalls ?? 20;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const metrics: LoopMetrics = {
    turns: 0,
    toolCalls: 0,
    jsonParseFailures: 0,
    anchorResolutionFailures: 0,
    flatOnlyAnchors: 0,
    wallMs: 0,
    exit: "clean",
  };
  const steps: LoopStep[] = [];
  const rawResponses: unknown[] = [];
  let finalContent = "";
  const started = Date.now();

  try {
    while (metrics.turns < maxTurns) {
      metrics.turns += 1;
      const res = await chat({ model, messages, tools, transport, temperature: opts.temperature, timeoutMs: opts.timeoutMs });
      rawResponses.push(res.raw);

      if (res.toolCalls.length === 0) {
        finalContent = res.content;
        steps.push({ turn: metrics.turns, assistantContent: res.content, toolCalls: [], latencyMs: res.latencyMs });
        metrics.exit = "clean";
        break;
      }

      // Echo the assistant turn (with its tool calls) back into the transcript.
      messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });

      const stepCalls: LoopStep["toolCalls"] = [];
      for (const tc of res.toolCalls) {
        metrics.toolCalls += 1;
        if (tc.parseError) metrics.jsonParseFailures += 1;

        const outcome = dispatch(tc.name, tc.args, { ydoc });
        const eff = outcome.effect;
        if ((eff.kind === "comment" || eff.kind === "replacement") && !eff.ok && eff.errorCode === "ANCHOR_NOT_FOUND") {
          metrics.anchorResolutionFailures += 1;
        }
        if ((eff.kind === "comment" || eff.kind === "replacement") && eff.ok && eff.fullyAnchored === false) {
          metrics.flatOnlyAnchors += 1;
        }

        stepCalls.push({ name: tc.name, args: tc.args, rawArgs: tc.rawArgs, parseError: tc.parseError, outcome: eff });

        // Tool result message (transport-shaped in ollama.ts).
        messages.push({ role: "tool", content: JSON.stringify(outcome.result), tool_call_id: tc.id, tool_name: tc.name });

        if (metrics.toolCalls >= maxToolCalls) break;
      }
      steps.push({ turn: metrics.turns, assistantContent: res.content, toolCalls: stepCalls, latencyMs: res.latencyMs });

      if (metrics.toolCalls >= maxToolCalls) {
        metrics.exit = "max_tool_calls";
        break;
      }
    }
    if (metrics.turns >= maxTurns && metrics.exit === "clean" && steps[steps.length - 1]?.toolCalls.length) {
      metrics.exit = "max_turns";
    }
  } catch (err) {
    metrics.exit = "error";
    metrics.errorMessage = err instanceof Error ? err.message : String(err);
  }

  metrics.wallMs = Date.now() - started;
  return { metrics, steps, finalContent, rawResponses };
}
