/**
 * Things recorded about a reply that are reported and never gate (brief R2.7,
 * R2.8, R3.4): visible reasoning, a reply in another language, a reply that
 * repeats the system prompt, a prompt longer than the context window, and a
 * chat row left holding an earlier turn's preamble.
 *
 * Inline reasoning shapes ASSUMED (no model was available to check): a
 * `<think>`, `<thinking>` or `<reasoning>` block in the content, closed or left
 * open. Known misses: a closing tag with no opening one, and untagged
 * reasoning ("Okay, the user wants…").
 */
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
 * The final turn said nothing and the chat row still holds text from an
 * earlier turn (a preamble before a tool call that a flush had committed).
 * The run exits cleanly, so the user gets no notice: the preamble IS the reply.
 */
export function stalePreamble(input: { reply: string; turns: TurnText[] }): boolean {
  const last = input.turns[input.turns.length - 1];
  if (!last || input.reply.trim().length === 0) return false;
  return last.hadToolCalls === false && last.text.trim().length === 0;
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
