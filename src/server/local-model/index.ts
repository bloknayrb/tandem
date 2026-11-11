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
 * never registered while dark). See PR #1160's "Stays byte-identical to today
 * when dark" section (no tracked #1123 plan doc covers M1.2 — #1160's own
 * description is the record).
 */
import type * as Y from "yjs";

import { type LocalModelConfig } from "./config.js";
import { type LoopResult, runLoop } from "./loop.js";
import { type ChatMessage } from "./ollama-client.js";
import { buildUserPrompt, systemPromptFor } from "./prompts.js";
import { READ_TOOLS, TOOLS } from "./tools.js";

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
  /** Raw response-byte ceiling per model call (#1292). See `RunLoopOpts`. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
  /** Per assistant content delta, for token streaming (#1123 M1.2). */
  onContentDelta?: (delta: string) => void;
  /** Per turn boundary (after `chat()`), for the streaming sink (#1123 M1.2). */
  onTurnEnd?: (info: { hadToolCalls: boolean }) => void;
  /** Still the same Y.Doc instance, content not replaced? (#2039, #2070) See
   *  `RunLoopOpts`. */
  isDocCurrent?: () => boolean;
  /**
   * Is the user's "let local models comment and suggest changes" setting on
   * right now? (#1123, ADR-039's tiers.) Read once when the run starts, to pick
   * the tier, and again on every tool call.
   *
   * Fail-closed: anything but a function returning exactly `true` is "no". A
   * run that STARTS with it off is a chat-tier run for its whole life — it is
   * offered only the reading tools, its prompts name no writing tool, and
   * switching the setting on mid-run does not unlock it. A run that starts with
   * it on stops writing the first time this answers anything else, and stays
   * stopped.
   */
  editingAllowed: () => boolean;
}

/** Run one collaborator turn (read/decide/act) against a document. */
export async function runLocalModelTurn(opts: RunTurnOpts): Promise<LoopResult> {
  const live = (): boolean =>
    typeof opts.editingAllowed === "function" && opts.editingAllowed() === true;
  const tier = live() ? "editing" : "chat";
  // Sticky: once this run has seen editing off, it never writes again. The
  // collaborator's own closure also compares an Off counter, which is what
  // makes an Off-then-On between two tool calls stick; this latch is what keeps
  // a run that STARTED in the chat tier from being unlocked by an On.
  let revoked = tier === "chat";
  const canEdit = (): boolean => {
    if (revoked) return false;
    if (!live()) {
      revoked = true;
      return false;
    }
    return true;
  };
  const userPrompt = buildUserPrompt(opts.ydoc, opts.task, opts.includeFullText ?? true, tier);
  return runLoop({
    ydoc: opts.ydoc,
    config: opts.config,
    // The tier decides all three together: a chat-tier model is offered only
    // the reading tools and told about nothing else.
    tools: tier === "editing" ? TOOLS : READ_TOOLS,
    systemPrompt: systemPromptFor(tier),
    userPrompt,
    canEdit,
    history: opts.history,
    maxTurns: opts.maxTurns,
    maxToolCalls: opts.maxToolCalls,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
    maxResponseBytes: opts.maxResponseBytes,
    signal: opts.signal,
    onContentDelta: opts.onContentDelta,
    onTurnEnd: opts.onTurnEnd,
    // #2039: this forward is the ONLY thing that makes `doc-swapped` reachable
    // in production — the field list is hand-enumerated, so an omission is
    // silent (the option is optional and TypeScript cannot object).
    isDocCurrent: opts.isDocCurrent,
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
export {
  buildUserPrompt,
  CHAT_SYSTEM_PROMPT,
  EDITING_SYSTEM_PROMPT,
  type LocalModelTier,
  systemPromptFor,
} from "./prompts.js";
export {
  type DispatchCtx,
  dispatch,
  EDITING_OFF_MESSAGE,
  READ_TOOL_NAMES,
  READ_TOOLS,
  TOOLS,
  type ToolOutcome,
} from "./tools.js";
