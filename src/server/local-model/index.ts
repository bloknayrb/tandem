/**
 * Local-model collaborator loop (#1123 M1, ADR-039) — public entry.
 *
 * M1.1 ships this as a LIBRARY: nothing in the running server imports it yet, so
 * the feature is dark (byte-identical runtime). M1.2 wires `runLocalModelTurn`
 * to the event queue (wake on `chat:message`) + chat write-back + lifecycle.
 *
 * Note: a successful `createAnnotation` fires a `review-pending` browser
 * notification as a side-effect of the internal op — so the "no production
 * import of this directory" grep is the load-bearing dark guarantee, not
 * incidental. See the plan's §3.8.
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
