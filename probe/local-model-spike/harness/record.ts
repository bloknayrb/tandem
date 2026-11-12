/**
 * The stored shape of a trial, and the types the report and the reading file
 * work from. Imports nothing from `src/` (types only from harness modules), so
 * `read.ts` and `report.ts` can load it without loading the product.
 */
import { createHash } from "node:crypto";

import type { Classification, TrialEnding } from "./classify.js";
import type { ClaimCheckResult } from "./claims.js";
import type { ScoreResult } from "./score.js";
import type { ContextUse, ReasoningShape } from "./signals.js";
import type { Group, Tier } from "./scenarios/types.js";
import type { TurnText, WriteLog } from "./trial.js";

export interface PlannedTrial {
  trialId: string;
  scenarioId: string;
  group: Group;
  repeat: number;
}

export interface ToolStep {
  turn: number;
  name: string;
  /** The arguments the model gave, as JSON text. */
  args: string;
  /** What the product told the model, as JSON text (trimmed). */
  result: string;
  /** The product's own record of what happened. */
  effect: string;
}

export interface TrialRecord {
  runId: string;
  trialId: string;
  scenarioId: string;
  tier: Tier;
  group: Group;
  repeat: number;
  /** How the run ended (see `classify.ts`). Never "infrastructure" here. */
  ending: Exclude<TrialEnding, "infrastructure">;
  detail: string;
  /** The loop's own exit word. */
  exit: string;
  fixture: string;
  prompt: string;
  selectedText?: string;
  /** The task as the product composed it (message plus any selection). */
  composedTask: string;
  /** Whether the product inlined the document into the prompt. */
  inlined: boolean | null;
  /** The right answer in words, from the scenario. */
  expected: string;
  /** What the user's chat row holds. */
  reply: string;
  turns: TurnText[];
  writes: WriteLog;
  toolSteps: ToolStep[];
  notices: { severity: string; message: string }[];
  score: ScoreResult;
  /** `ending === "completed"` and the scorer's predicate passed. */
  scorerPass: boolean;
  /** The predicate over the reply with inline reasoning removed (informational). */
  scorerPassWithoutReasoning: boolean;
  claims: ClaimCheckResult;
  signals: {
    reasoning: ReasoningShape;
    replyShowsReasoning: boolean;
    emptyReply: boolean;
    stalePreamble: boolean;
    otherLanguage: boolean;
    repeatsPrompt: boolean;
    context: ContextUse;
  };
  metrics: { turns: number; toolCalls: number; jsonParseFailures: number };
  timeToFirstTextMs: number | null;
  totalMs: number;
  /** Binds a verdict to exactly this text (see `trialHash`). */
  hash: string;
}

export interface InfraRecord {
  runId: string;
  trialId: string;
  scenarioId: string;
  group: Group;
  detail: string;
  at: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A stable JSON text for hashing: keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  return canonical(value);
}

/**
 * What a verdict is a verdict ON: the trial, the reply the chat row holds,
 * every turn's text, and what was written. Canonical JSON, so two different
 * splits of the same characters cannot share a hash.
 */
export function trialHash(parts: {
  trialId: string;
  reply: string;
  turns: TurnText[];
  writes: WriteLog;
}): string {
  return createHash("sha256")
    .update(
      canonical({
        trialId: parts.trialId,
        reply: parts.reply,
        turns: parts.turns.map((t) => t.text),
        writes: parts.writes,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

export type { Classification };
