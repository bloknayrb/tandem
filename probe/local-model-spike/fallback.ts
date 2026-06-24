/**
 * Single-shot FALLBACK runner for the #1123 M0 spike.
 *
 * FALLBACK is defined (plan / ADR-039) as constrained structured-output with NO
 * general loop: the product invokes the model deliberately per action
 * ("comment on this", "rewrite this", "answer this") and takes ONE structured
 * response. So this runner makes exactly one model call:
 *   - comment / replacement: present ONLY the relevant tool and FORCE it via
 *     tool_choice; dispatch the first returned call ONCE — no retry, because a
 *     constrained feature gets one shot (a missed quote is a surfaced error, not
 *     an autonomous re-try). Failure to emit / a bad anchor is a real FAIL.
 *   - chat: no tools; capture the plain-text reply.
 *
 * It returns a LoopResult so scoring.ts grades it byte-for-byte the same way as
 * the agentic loop — the only difference is how the annotation got into the
 * Y.Doc, which the scorer never sees.
 *
 * Sequence / no-op / envelope are EXCLUDED by definition: they require a loop
 * (multi-step, navigation, or an act/no-act decision the constrained surface
 * doesn't expose).
 */
import type * as Y from "yjs";

import { chat, type Transport } from "./ollama.js";
import { dispatch, TOOLS, type ToolOutcome } from "./tools.js";
import type { LoopResult, LoopStep } from "./loop.js";
import type { Operation } from "./scenarios.js";

const COMMENT_TOOL = TOOLS.find((t) => t.name === "comment_on_quote")!;
const REPLACE_TOOL = TOOLS.find((t) => t.name === "propose_replacement")!;

export const FALLBACK_SYSTEM_PROMPT = `You are a writing assistant invoked for ONE specific action on a document. You will produce exactly one response and then stop — there is no back-and-forth.

ANCHORING — CRITICAL
- quoted_text MUST be copied VERBATIM from the document text provided — the exact characters, exactly as written. Do NOT paraphrase, summarize, or quote the instruction. Quote the document.
- Quote visible prose only. NEVER include heading markers (#, ##).
- If the same text appears more than once, set occurrence_index (1-based) to pick which one.`;

export interface FallbackOpts {
  ydoc: Y.Doc;
  model: string;
  transport: Transport;
  operation: Operation; // "comment" | "replacement" | "chat"
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  timeoutMs?: number;
  /** Variant R: at most this many ADDITIONAL forced calls, fired ONLY on a
   *  structured ANCHOR_NOT_FOUND/HEADING_OVERLAP (a deterministic anchor-repair
   *  protocol, never a content re-roll — still FALLBACK, not an agentic loop). */
  maxAnchorRetries?: number;
}

/** Run one constrained single-shot action and return a LoopResult for scoring.ts. */
export async function runFallback(opts: FallbackOpts): Promise<LoopResult> {
  const { ydoc, model, transport, operation, systemPrompt, userPrompt } = opts;
  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userPrompt },
  ];

  const metrics: LoopResult["metrics"] = {
    turns: 1,
    toolCalls: 0,
    jsonParseFailures: 0,
    anchorResolutionFailures: 0,
    flatOnlyAnchors: 0,
    wallMs: 0,
    exit: "clean",
  };
  const started = Date.now();

  try {
    if (operation === "chat") {
      const res = await chat({ model, messages, tools: [], transport, temperature: opts.temperature, timeoutMs: opts.timeoutMs });
      metrics.wallMs = Date.now() - started;
      const step: LoopStep = { turn: 1, assistantContent: res.content, toolCalls: [], latencyMs: res.latencyMs };
      return { metrics, steps: [step], finalContent: res.content, rawResponses: [res.raw] };
    }

    const tool = operation === "replacement" ? REPLACE_TOOL : COMMENT_TOOL;
    const maxRetries = opts.maxAnchorRetries ?? 0;
    const convo = [...messages];
    const steps: LoopStep[] = [];
    const raws: unknown[] = [];
    let finalContent = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      metrics.turns = attempt + 1;
      const res = await chat({
        model,
        messages: convo,
        tools: [tool],
        transport,
        temperature: opts.temperature,
        timeoutMs: opts.timeoutMs,
        toolChoice: { type: "function", function: { name: tool.name } },
      });
      raws.push(res.raw);
      finalContent = res.content;

      const tc = res.toolCalls[0];
      const stepCalls: LoopStep["toolCalls"] = [];
      if (!tc) {
        steps.push({ turn: attempt + 1, assistantContent: res.content, toolCalls: [], latencyMs: res.latencyMs });
        break; // no tool call — a reliability-floor miss; retry would not help
      }
      metrics.toolCalls += 1;
      if (tc.parseError) metrics.jsonParseFailures += 1;
      const outcome: ToolOutcome = dispatch(tc.name, tc.args, { ydoc });
      const eff = outcome.effect;
      const anchorErr = (eff.kind === "comment" || eff.kind === "replacement") && !eff.ok && (eff.errorCode === "ANCHOR_NOT_FOUND" || eff.errorCode === "HEADING_OVERLAP");
      if ((eff.kind === "comment" || eff.kind === "replacement") && !eff.ok && eff.errorCode === "ANCHOR_NOT_FOUND") metrics.anchorResolutionFailures += 1;
      if ((eff.kind === "comment" || eff.kind === "replacement") && eff.ok && eff.fullyAnchored === false) metrics.flatOnlyAnchors += 1;
      stepCalls.push({ name: tc.name, args: tc.args, rawArgs: tc.rawArgs, parseError: tc.parseError, outcome: eff });
      steps.push({ turn: attempt + 1, assistantContent: res.content, toolCalls: stepCalls, latencyMs: res.latencyMs });

      if (!anchorErr || attempt === maxRetries) break;
      // Feed the structured anchor error back and force ONE corrected re-emit.
      convo.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
      convo.push({ role: "tool", content: JSON.stringify(outcome.result), tool_call_id: tc.id, tool_name: tc.name });
    }

    metrics.wallMs = Date.now() - started;
    return { metrics, steps, finalContent, rawResponses: raws };
  } catch (err) {
    metrics.exit = "error";
    metrics.errorMessage = err instanceof Error ? err.message : String(err);
    metrics.wallMs = Date.now() - started;
    return { metrics, steps: [], finalContent: "", rawResponses: [] };
  }
}
