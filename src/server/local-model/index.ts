/**
 * Local-model collaborator loop (#1123 M1, ADR-039) — public entry.
 *
 * M1.1 shipped this as a LIBRARY (no production import). M1.2 wires it via
 * `collaborator.ts` — the ONLY server importer of this engine — which subscribes
 * to the event queue (wake on `chat:message`), streams a chat reply, and manages
 * the single-flight lifecycle.
 *
 * Dark guarantee (M1.2): merely importing this module has no side effect (no
 * write, no `createAnnotation`/`review-pending` — those fire only when the loop
 * RUNS). The load-bearing dark check is now that `collaborator.ts`'s
 * `subscribe()` call is gated behind `BYO_MODELS_ENABLED` (the subscriber is
 * never registered while dark), AND that `config-source.ts` returns null (so the
 * loop is inert even if the flag flips before M1a). See the plan's §3.2/§3.7.
 */
import type * as Y from "yjs";

import { type LocalModelConfig } from "./config.js";
import { type LoopResult, runLoop } from "./loop.js";
import { type ChatMessage } from "./ollama-client.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts.js";
import { TOOLS } from "./tools.js";

export interface RunTurnOpts {
  ydoc: Y.Doc;
  config: LocalModelConfig;
  /** the user's request (chat message text, or an internal task string) */
  task: string;
  /** inline the full doc into the prompt (short docs) vs windowed reads (long). */
  includeFullText?: boolean;
  /** prior conversation turns for continuity (M1.2). */
  history?: ChatMessage[];
  maxTurns?: number;
  maxToolCalls?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  isLicenseRestricted?: () => boolean;
  /** Per assistant content delta, for token streaming (#1123 M1.2). */
  onContentDelta?: (delta: string) => void;
  /** Per turn boundary (after `chat()`), for the streaming sink (#1123 M1.2). */
  onTurnEnd?: (info: { hadToolCalls: boolean }) => void;
}

/** Run one collaborator turn (read/decide/act) against a document. */
export async function runLocalModelTurn(opts: RunTurnOpts): Promise<LoopResult> {
  const userPrompt = buildUserPrompt(opts.ydoc, opts.task, opts.includeFullText ?? true);
  return runLoop({
    ydoc: opts.ydoc,
    config: opts.config,
    tools: TOOLS,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    history: opts.history,
    maxTurns: opts.maxTurns,
    maxToolCalls: opts.maxToolCalls,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    isLicenseRestricted: opts.isLicenseRestricted,
    onContentDelta: opts.onContentDelta,
    onTurnEnd: opts.onTurnEnd,
  });
}

export {
  type EndpointValidation,
  type LocalModelConfig,
  type LocalModelTransport,
  validateEndpoint,
} from "./config.js";
export { type LoopMetrics, type LoopResult, type RunLoopOpts, runLoop } from "./loop.js";
export { type ChatMessage, chat, type ToolSchema } from "./ollama-client.js";
export { buildUserPrompt, SYSTEM_PROMPT } from "./prompts.js";
export { type DispatchCtx, dispatch, TOOLS, type ToolOutcome } from "./tools.js";
