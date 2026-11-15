/**
 * Things recorded about a reply that are reported and never gate (brief R2.7,
 * R2.8, R3.4): visible reasoning, a reply in another language, a reply that
 * repeats the system prompt, a prompt longer than the context window, a chat
 * row left holding an earlier turn's preamble, and a `</think>` with no
 * opening tag.
 *
 * Inline reasoning shapes ASSUMED (no model was available to check): a
 * `<think>`, `<thinking>` or `<reasoning>` block in the content, closed or left
 * open. Since #1123 part C the product hides `<think>` blocks (never
 * `<thinking>` or `<reasoning>`), so a reply shows reasoning only through the
 * other two, or a `<think>` left open after visible text at a clean end. Known
 * misses: untagged reasoning ("Okay, the user wants…"). A closing `</think>`
 * with no opening one stays visible; it is counted (`orphanCloseThink`), so a
 * real measurement can show whether any model emits one.
 */
import { shownText } from "../../../src/server/local-model/think-filter.js";
import type { TapRecord } from "./fetch-tap.js";
import type { TurnText } from "./trial.js";

export type ReasoningShape = "none" | "inline" | "separate" | "inline+separate" | "reasoning-only";

const INLINE_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi;
const INLINE_OPEN = /<(?:think|thinking|reasoning)>/i;

/** The reply with inline reasoning blocks removed. */
export function withoutInlineReasoning(text: string): string {
  return text.replace(INLINE_BLOCK, "").trim();
}

export function reasoningShape(input: {
  reply: string;
  turns: TurnText[];
  fetches: TapRecord[];
}): { shape: ReasoningShape; replyShowsReasoning: boolean } {
  const inline = INLINE_OPEN.test(input.reply) || input.turns.some((t) => INLINE_OPEN.test(t.text));
  const separate = input.fetches.some((f) => f.separateReasoningChars > 0);
  const anyText = input.reply.trim().length > 0 || input.turns.some((t) => t.text.trim().length > 0);
  let shape: ReasoningShape = "none";
  if (separate && !anyText) shape = "reasoning-only";
  else if (inline && separate) shape = "inline+separate";
  else if (inline) shape = "inline";
  else if (separate) shape = "separate";
  return { shape, replyShowsReasoning: INLINE_OPEN.test(input.reply) };
}

/**
 * What a turn's text showed the user (#1123 part C, R5.2): inline `<think>`
 * reasoning removed as the product removes it. A turn that ended without tool
 * calls is the run's last, and a `clean` end releases a block left open after
 * visible text; a tool-call turn and a cut turn never release one.
 */
export function turnShownText(turn: TurnText): string {
  return shownText(turn.text, turn.hadToolCalls === false);
}

/**
 * The final turn SHOWED nothing (empty, or only `<think>` reasoning) and the
 * chat row still holds text from an earlier turn (a preamble before a tool
 * call that a flush had committed). The run exits cleanly, so the user gets no
 * notice: the preamble IS the reply (D-C1).
 */
export function stalePreamble(input: { reply: string; turns: TurnText[] }): boolean {
  const last = input.turns[input.turns.length - 1];
  if (!last || input.reply.trim().length === 0) return false;
  return last.hadToolCalls === false && turnShownText(last).trim().length === 0;
}

/**
 * How many `</think>` (any case) the model wrote with no `<think>` block open
 * before it in the same turn (#1123 part C, R5.3) — including a second close
 * after a block already closed, which the product also leaves visible. The product leaves such a tag
 * visible; this is the measurement that says whether any model needs more.
 */
export function orphanCloseThink(turns: TurnText[]): number {
  let n = 0;
  for (const t of turns) {
    // Walk the tags in order: a close with no block open is an orphan, as the
    // product sees it (it stays visible); blocks do not nest.
    let open = false;
    for (const m of t.text.matchAll(/<\/?think>/gi)) {
      const isClose = m[0][1] === "/";
      if (!isClose) open = true;
      else if (open) open = false;
      else n += 1;
    }
  }
  return n;
}

const ENGLISH_STOPWORDS = new Set(
  "the of and to a in is that it for on with as are this be was by not or an at from but have has which its can will their would there what about".split(
    " ",
  ),
);

/**
 * Is the reply plausibly not in English (every fixture is English)? Two crude
 * tests: a fifth or more of its letters are outside the Latin script, or a
 * reply of 12+ words holds almost no common English words. Known miss: a short
 * reply in a Latin-script language.
 */
export function otherLanguage(reply: string): boolean {
  const letters = reply.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const nonLatin = letters.filter((c) => !/\p{Script=Latin}/u.test(c)).length;
  if (nonLatin / letters.length >= 0.2) return true;
  const words = reply.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length < 12) return false;
  const common = words.filter((w) => ENGLISH_STOPWORDS.has(w)).length;
  return common / words.length < 0.08;
}

/** Does the reply repeat a run of `runLength`+ characters of the system prompt? */
export function repeatsPrompt(reply: string, systemPrompt: string, runLength = 40): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const r = norm(reply);
  const p = norm(systemPrompt);
  if (r.length < runLength || p.length < runLength) return false;
  const windows = new Set<string>();
  for (let i = 0; i + runLength <= p.length; i++) windows.add(p.slice(i, i + runLength));
  for (let i = 0; i + runLength <= r.length; i++) {
    if (windows.has(r.slice(i, i + runLength))) return true;
  }
  return false;
}

/** Characters per token used when the server reports no prompt token count. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

export interface ContextUse {
  /** Largest prompt of the trial, in tokens. */
  promptTokens: number | null;
  /** True when `promptTokens` is an estimate from characters. */
  estimated: boolean;
  /** The prompt was longer than the recorded context length. */
  overContext: boolean | "unknown";
}

export function contextUse(fetches: TapRecord[], contextLength: number | "unknown"): ContextUse {
  let reported: number | null = null;
  let chars = 0;
  for (const f of fetches) {
    if (f.promptTokens !== null) reported = Math.max(reported ?? 0, f.promptTokens);
    chars = Math.max(chars, f.requestChars);
  }
  const estimated = reported === null;
  const promptTokens =
    reported ?? (chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE) : null);
  return {
    promptTokens,
    estimated,
    overContext:
      contextLength === "unknown" || promptTokens === null ? "unknown" : promptTokens > contextLength,
  };
}
