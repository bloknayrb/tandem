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
  /** SHA-256 of the document's flat text as this trial's model saw it. The text
   *  itself is stored once per fixture in the run's `fixtures.json`. */
  documentHash: string;
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
  /** Binds a verdict to exactly this record (see `recordHash`). */
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

/** JSON round trip: what a record is once it has been written and read back. */
function asStored(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * What a verdict is a verdict ON: the WHOLE stored record except its own
 * `hash` — the reply, every turn's text, what was written, the ending, the
 * scorer's result, the prompt, the scenario id, the document's hash and every
 * signal. Computed over the record as it reads back from disk (a JSON round
 * trip first, so a field left `undefined` hashes the same before and after
 * storage), with keys sorted at every depth.
 *
 * The report recomputes it from the record it reads, never trusting the
 * stored `hash`: a record changed after the run no longer matches its own
 * hash, and a verdict written for the old record no longer matches the new.
 */
export function recordHash(record: TrialRecord | Omit<TrialRecord, "hash">): string {
  const rest = asStored(record) as Partial<TrialRecord>;
  delete rest.hash;
  return createHash("sha256").update(canonical(rest), "utf8").digest("hex").slice(0, 32);
}

/** The record with its `hash` set. */
export function sealRecord(record: Omit<TrialRecord, "hash">): TrialRecord {
  return { ...record, hash: recordHash(record) } as TrialRecord;
}

/** SHA-256 of a document's flat text, as stored in `documentHash`. */
export function documentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type { Classification };
