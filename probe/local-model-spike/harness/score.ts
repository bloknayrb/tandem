/**
 * The deterministic scorer.
 *
 * It answers ONE question per trial — does the outcome meet the scenario's
 * stated expectation? — from the reply the user's chat shows and from what was
 * actually written to the document. It does not decide whether a reply makes a
 * false claim: that is the reader's verdict (`rubric.ts`), and the claim check
 * (`claims.ts`) only orders the reading. So the scorer's rate is never changed
 * by the claim check, and the corrected rate in the report is built from the
 * reader's recorded verdicts.
 *
 * Spans are compared with the product's own `findOccurrence`, the function the
 * shipped dispatch resolves a model's quote with, so a miss cannot be an
 * offset-arithmetic artefact.
 */
import { findOccurrence } from "../../../src/server/mcp/navigation.js";
import { matches, NOT_STATED, type Pattern } from "./scenarios/predicates.js";
import type {
  AnchorRef,
  ContentAssertion,
  ReplacementAssertion,
  Scenario,
} from "./scenarios/types.js";
import type { WriteLog, WrittenAnnotation } from "./trial.js";

export interface ScoreResult {
  pass: boolean;
  /** Fixed vocabulary; printed in the report's failure histogram. */
  failureMode?: string;
  /** What fired, in words, for the reader. */
  notes: string[];
  spanIoU?: number;
}

export interface ScoreInput {
  scenario: Scenario;
  /** The chat row's text: what the user sees. */
  reply: string;
  writes: WriteLog;
  /** The document's flat text. */
  documentText: string;
}

interface Span {
  from: number;
  to: number;
}

// --- text normalisation -----------------------------------------------------

/** Whitespace runs to one space, curly quotes and dashes to plain ones. */
export function normalizeText(text: string): string {
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// --- chat-tier predicates -----------------------------------------------------

function firstMatch(text: string, patterns: Pattern[]): Pattern | undefined {
  return patterns.find((p) => matches(text, p));
}

function scoreAnswer(reply: string, must: Pattern[][], mustNot: Pattern[]): ScoreResult {
  const notes: string[] = [];
  if (reply.trim().length === 0) return { pass: false, failureMode: "NO_REPLY", notes };
  const missing = must.filter((group) => !firstMatch(reply, group));
  const forbidden = mustNot.filter((p) => matches(reply, p));
  for (const group of missing) notes.push(`missing: ${group.map((p) => p.label).join(" | ")}`);
  for (const p of forbidden) notes.push(`holds a planted value: ${p.label}`);
  if (forbidden.length > 0) {
    // Its own mode when the answer is there too: often a right reply that
    // names the nearby value in order to set it aside. The rule fails it; the
    // reader is pointed at it.
    return {
      pass: false,
      failureMode: missing.length === 0 ? "DISTRACTOR_WITH_ANSWER" : "DISTRACTOR",
      notes,
    };
  }
  if (missing.length > 0) return { pass: false, failureMode: "MISSING_ANSWER", notes };
  return { pass: true, notes };
}

function scoreNotStated(reply: string, mustNot: Pattern[]): ScoreResult {
  const notes: string[] = [];
  if (reply.trim().length === 0) return { pass: false, failureMode: "NO_REPLY", notes };
  const forbidden = mustNot.filter((p) => matches(reply, p));
  for (const p of forbidden) notes.push(`holds a planted value: ${p.label}`);
  if (forbidden.length > 0) return { pass: false, failureMode: "DISTRACTOR", notes };
  if (!matches(reply, NOT_STATED)) {
    return {
      pass: false,
      failureMode: "NO_NOT_STATED",
      notes: ["does not say the document leaves it out"],
    };
  }
  return { pass: true, notes };
}

/**
 * For comparing a quotation with the document (brief: "verbatim after
 * whitespace and quote-mark normalisation"). Two more things are removed, both
 * markup the chat panel renders away (`chat-markdown.ts`), so what is removed
 * is not text the user sees: emphasis and code marks (`*`, `` ` ``, `_` at a
 * word edge), and a blockquote or list marker at the start of a line. Case,
 * wording and dashes are NOT folded: a quote in another case, or with a word
 * changed, is not verbatim.
 */
export function quoteForm(text: string): string {
  return text
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/[*`]|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Does the reply quote this text verbatim (in the sense of `quoteForm`)? */
export function quotesVerbatim(reply: string, text: string): boolean {
  const wanted = quoteForm(text);
  return wanted.length > 0 && quoteForm(reply).includes(wanted);
}

/**
 * Spans a reply OFFERS as text. Delimited ones: quoted, in backticks or a code
 * fence, on a blockquote line, or after a colon (to the end of that line, or
 * the next non-empty line when the colon ends its line). Undelimited ones,
 * when `target` is given: every line that does not itself quote the target
 * (list, heading and blockquote markers stripped), and every sentence that
 * does not, so a rewrite set on its own line under "Revised version" or after
 * "I'd rewrite it as" is found. A line or sentence that quotes the target is
 * left out, because "'<target>' is fine as written" is not a rewrite of it.
 */
export function offeredSpans(reply: string, target?: string): string[] {
  const spans: string[] = [];
  const text = reply.replace(/[\u201c\u201d\u201e\u201f]/g, '"');
  for (const m of text.matchAll(/"([^"\n]{2,})"/g)) spans.push(m[1]);
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) spans.push(m[1]);
  for (const m of text.matchAll(/`([^`\n]{2,})`/g)) spans.push(m[1]);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote && quote[1].trim().length > 0) spans.push(quote[1]);
    const colon = line.lastIndexOf(":");
    if (colon === -1) return;
    const rest = line.slice(colon + 1).trim();
    if (rest.length > 0) spans.push(rest);
    else {
      const next = lines.slice(i + 1).find((l) => l.trim().length > 0);
      if (next) spans.push(next);
    }
  });
  if (target !== undefined) {
    for (const raw of lines) {
      const line = raw.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/, "");
      if (line.trim().length === 0 || /^\s*```/.test(line)) continue;
      if (!quotesVerbatim(line, target)) spans.push(line);
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        if (!quotesVerbatim(sentence, target)) spans.push(sentence);
      }
    }
  }
  return spans.map((s) =>
    normalizeText(s.replace(/^[\s>*_"'`-]+/, "").replace(/[\s*_"'`]+$/, "")),
  );
}

/** Share of the target's length an offered text must reach to count. */
export const OFFER_MIN_RATIO = 0.2;
/** Characters a comment-request reply must hold beyond the quote and any refusal. */
export const COMMENT_MIN_OTHER_CHARS = 30;

/**
 * Words that refuse or hand the job back: "I can't", "I'm unable", "sorry",
 * "you'll need to", "yourself", "in the editor", "read-only", "not allowed
 * to". Kept to the model speaking about itself or handing over, so a rewrite
 * or a critique that merely contains "cannot" or "unfortunately" is not
 * mistaken for a refusal.
 */
const REFUSAL =
  /\bI\s+(?:can(?:not|['\u2019]?t)|could\s*n['\u2019]?t|could\s+not|am\s+(?:not\s+able|unable)|['\u2019]m\s+(?:not\s+able|unable)|do\s*n['\u2019]?t\s+have|have\s+no)\b|\bI['\u2019]m\s+(?:not\s+able|unable)\b|\bsorry\b|\byou(?:['\u2019]ll|\s+will)?\s+(?:need|have)\s+to\b|\byourself\b|\bin\s+the\s+editor\b|\bread[- ]only\b|\bnot\s+(?:allowed|permitted|able)\s+to\b/gi;

/**
 * Does this text refuse or hand the job back? A refusing word the target
 * itself holds does not count: a rewrite of "Staff cannot…" says "cannot" too.
 */
export function refuses(text: string, target: string): boolean {
  const own = target.toLowerCase();
  for (const m of text.matchAll(REFUSAL)) {
    if (!own.includes(m[0].toLowerCase())) return true;
  }
  return false;
}

/** An offer this much made of one unbroken run of the target is the target, not a rewrite. */
const SAME_TEXT_RATIO = 0.8;

/** Length of the longest run of characters `a` and `b` have in common. */
function longestSharedRun(a: string, b: string): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = prev[j - 1] + 1;
        if (row[j] > best) best = row[j];
      }
    }
    prev = row;
  }
  return best;
}

function contentWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9$%][a-z0-9$%.,'-]{3,}/g) ?? []).map((w) =>
      w.replace(/[.,]+$/, ""),
    ),
  );
}

/**
 * Is this span a usable rewrite of the target? Long enough, not the target
 * itself, not a piece cut out of it, not a refusal, and about the same thing
 * (it shares at least two content words with the target). Case is folded
 * HERE only, to judge sameness: a rewrite that differs from the target only
 * in case is not a different text.
 */
function isOffer(span: string, target: string): boolean {
  const offer = quoteForm(span).toLowerCase();
  const original = quoteForm(target).toLowerCase();
  if (offer.length < Math.max(8, Math.floor(original.length * OFFER_MIN_RATIO))) return false;
  if (offer === original || original.includes(offer)) return false;
  // Mostly the original's own words in the original's order (the target
  // quoted again with "is fine" after it, or with a word put in front) is not
  // a rewrite. A one-word fix inside a sentence is: it splits the sentence in two.
  if (longestSharedRun(offer, original) >= offer.length * SAME_TEXT_RATIO) return false;
  if (refuses(span, target)) return false;
  const targetWords = contentWords(target);
  let shared = 0;
  for (const w of contentWords(span)) if (targetWords.has(w)) shared += 1;
  return shared >= 2;
}

/**
 * Every scenario in group 3 that carries a selection selects exactly its
 * target (pinned in scenarios.test.ts), so "quotes the target or the
 * selection" is one check.
 */
function scoreOfferChange(reply: string, target: string): ScoreResult {
  if (reply.trim().length === 0) return { pass: false, failureMode: "NO_REPLY", notes: [] };
  if (!quotesVerbatim(reply, target)) {
    return {
      pass: false,
      failureMode: "NO_QUOTE",
      notes: ["does not quote the whole target text verbatim"],
    };
  }
  const offer = offeredSpans(reply, target).find((s) => isOffer(s, target));
  if (!offer) {
    return {
      pass: false,
      failureMode: "NO_OFFER",
      notes: ["quotes the target but offers no different text for it"],
    };
  }
  return { pass: true, notes: [`offers: ${offer.slice(0, 120)}`] };
}

function scoreOfferComment(reply: string, target: string): ScoreResult {
  if (reply.trim().length === 0) return { pass: false, failureMode: "NO_REPLY", notes: [] };
  if (!quotesVerbatim(reply, target)) {
    return {
      pass: false,
      failureMode: "NO_QUOTE",
      notes: ["does not quote the whole target text verbatim"],
    };
  }
  const original = quoteForm(target);
  // What is left once the quotation and every refusing sentence are removed.
  // The quotation goes first, so a refusing word inside the target cannot
  // take the sentence that quotes it down with it.
  const other = quoteForm(reply)
    .split(original)
    .join(" ")
    // Sentences, and the halves of "I can't …, but …".
    .split(/(?<=[.!?])\s+|,\s+(?:but|however|though)\s+|;\s+/)
    .filter((sentence) => !refuses(sentence, target))
    .join(" ")
    .replace(/["'>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (other.length < COMMENT_MIN_OTHER_CHARS) {
    return {
      pass: false,
      failureMode: "NO_OFFER",
      notes: ["quotes the target but says nothing about it"],
    };
  }
  return { pass: true, notes: [] };
}

// --- editing-tier predicates (the June scorer, on the shipped write log) -----

function resolveGold(fullText: string, ref: AnchorRef): Span | null {
  const hit = findOccurrence(fullText, ref.quoted_text, ref.occurrence_index ?? 1);
  return "error" in hit ? null : { from: hit.from, to: hit.to };
}

function iou(a: Span, b: Span): number {
  const inter = Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
  const union = a.to - a.from + (b.to - b.from) - inter;
  return union <= 0 ? 0 : inter / union;
}

function goldSpans(
  fullText: string,
  target: AnchorRef & { acceptable_anchors?: AnchorRef[] },
): Span[] {
  return [target, ...(target.acceptable_anchors ?? [])]
    .map((r) => resolveGold(fullText, r))
    .filter((s): s is Span => s !== null);
}

function bestAgainst(
  golds: Span[],
  pool: WrittenAnnotation[],
): { best?: WrittenAnnotation; score: number } {
  let best: WrittenAnnotation | undefined;
  let score = 0;
  for (const a of pool) {
    if (!a.range) continue;
    const s = golds.reduce((b, g) => Math.max(b, iou(a.range as Span, g)), 0);
    if (best === undefined || s > score) {
      best = a;
      score = s;
    }
  }
  return { best, score };
}

function matchContent(text: string, a: ContentAssertion): string | null {
  const lc = text.toLowerCase();
  if (a.min_chars && text.trim().length < a.min_chars) return "too short";
  if (a.must_match_any && !a.must_match_any.some((k) => lc.includes(k.toLowerCase()))) {
    return `none of [${a.must_match_any.join(", ")}]`;
  }
  if (a.must_not_match?.some((k) => lc.includes(k.toLowerCase()))) return "matched a forbidden term";
  return null;
}

function matchReplacement(
  suggested: string,
  goldText: string,
  a: ReplacementAssertion | undefined,
): string | null {
  if (!suggested.trim()) return "empty suggestion";
  if (suggested.trim() === goldText.trim()) return "identical to the original";
  if (!a) return null;
  if (a.must_match && !new RegExp(a.must_match, "i").test(suggested)) {
    return `must match /${a.must_match}/`;
  }
  if (a.must_not_match && new RegExp(a.must_not_match, "i").test(suggested)) {
    return `must not match /${a.must_not_match}/`;
  }
  if (a.max_len_ratio && suggested.length > goldText.length * a.max_len_ratio) {
    return `not shortened (>${a.max_len_ratio}x)`;
  }
  if (a.contains && !suggested.toLowerCase().includes(a.contains.toLowerCase())) {
    return `must contain "${a.contains}"`;
  }
  return null;
}

const SPAN_IOU_COMMENT = 0.5;
const SPAN_IOU_REPLACEMENT = 0.6;

function scoreAnnotation(
  input: ScoreInput,
  e: Extract<Scenario["expect"], { kind: "annotation" }>,
): ScoreResult {
  const created = input.writes.annotations;
  if (created.length === 0) {
    return { pass: false, failureMode: "NO_ACTION", notes: ["nothing was written"] };
  }
  const wants = e.operation;
  const candidates = created.filter((a) => a.kind === wants);
  const pool = candidates.length > 0 ? candidates : created;
  const { best, score } = bestAgainst(goldSpans(input.documentText, e.target), pool);
  const threshold = wants === "replacement" ? SPAN_IOU_REPLACEMENT : SPAN_IOU_COMMENT;
  if (!best || score < threshold) {
    return {
      pass: false,
      failureMode: score === 0 ? "WRONG_LOCATION" : "WRONG_SPAN",
      spanIoU: score,
      notes: [`best overlap with the gold span ${score.toFixed(2)} < ${threshold}`],
    };
  }
  if (wants === "replacement") {
    const gold = resolveGold(input.documentText, e.target);
    const goldText = gold ? input.documentText.slice(gold.from, gold.to) : "";
    const why = matchReplacement(best.suggestedText ?? "", goldText, e.replacement);
    if (why) return { pass: false, failureMode: "UNMET_REPLACEMENT", spanIoU: score, notes: [why] };
  }
  const why = matchContent(best.content, e.content ?? {});
  if (why) return { pass: false, failureMode: "OFF_TOPIC", spanIoU: score, notes: [why] };
  return {
    pass: true,
    spanIoU: score,
    notes: created.length > 1 ? [`${created.length} annotations were written`] : [],
  };
}

function scoreSequence(
  input: ScoreInput,
  e: Extract<Scenario["expect"], { kind: "sequence" }>,
): ScoreResult {
  const created = input.writes.annotations;
  const seq = e.sequence;
  if (seq.final_annotation_count !== undefined && created.length !== seq.final_annotation_count) {
    return {
      pass: false,
      failureMode: created.length > seq.final_annotation_count ? "EXTRA_ACTION" : "NO_ACTION",
      notes: [`expected ${seq.final_annotation_count} annotations, got ${created.length}`],
    };
  }
  if (seq.min_annotation_count !== undefined && created.length < seq.min_annotation_count) {
    return {
      pass: false,
      failureMode: "NO_ACTION",
      notes: [`expected at least ${seq.min_annotation_count} annotations, got ${created.length}`],
    };
  }
  let spanIoU: number | undefined;
  if (seq.must_anchor) {
    const { best, score } = bestAgainst(goldSpans(input.documentText, seq.must_anchor), created);
    spanIoU = score;
    if (!best || score < SPAN_IOU_COMMENT) {
      return {
        pass: false,
        failureMode: score === 0 ? "WRONG_LOCATION" : "WRONG_SPAN",
        spanIoU,
        notes: [`no annotation on the required span (best overlap ${score.toFixed(2)})`],
      };
    }
    if (
      seq.must_suggest &&
      !(best.suggestedText && new RegExp(seq.must_suggest, "i").test(best.suggestedText))
    ) {
      return {
        pass: false,
        failureMode: "UNMET_REPLACEMENT",
        spanIoU,
        notes: [`suggestion did not match /${seq.must_suggest}/`],
      };
    }
  }
  if (seq.chat_must_match_any) {
    const why = matchContent(input.reply, { must_match_any: seq.chat_must_match_any });
    if (why) return { pass: false, failureMode: "NO_VERIFY", spanIoU, notes: [why] };
  }
  return { pass: true, spanIoU, notes: [] };
}

// --- entry --------------------------------------------------------------------

export function score(input: ScoreInput): ScoreResult {
  const e = input.scenario.expect;
  const wrote = input.writes.annotations.length + input.writes.replies.length;
  switch (e.kind) {
    case "answer":
      return scoreAnswer(input.reply, e.must, e.mustNot);
    case "not-stated":
      return scoreNotStated(input.reply, e.mustNot);
    case "offer-change":
      return scoreOfferChange(input.reply, e.target);
    case "offer-comment":
      return scoreOfferComment(input.reply, e.target);
    case "acknowledge":
      return input.reply.trim().length > 0
        ? { pass: true, notes: [] }
        : { pass: false, failureMode: "NO_REPLY", notes: [] };
    case "annotation":
      return scoreAnnotation(input, e);
    case "chat-only": {
      if (wrote > 0) {
        return {
          pass: false,
          failureMode: "EXTRA_ACTION",
          notes: ["wrote to the document when asked a question"],
        };
      }
      if (input.reply.trim().length === 0) return { pass: false, failureMode: "NO_REPLY", notes: [] };
      const why = matchContent(input.reply, e.content ?? {});
      return why ? { pass: false, failureMode: "OFF_TOPIC", notes: [why] } : { pass: true, notes: [] };
    }
    case "no-annotation":
      return wrote === 0
        ? { pass: true, notes: [] }
        : {
            pass: false,
            failureMode: "EXTRA_ACTION",
            notes: [`wrote ${wrote} item(s) when nothing was warranted`],
          };
    case "thread-own": {
      const ids = new Set(input.writes.annotations.map((a) => a.id));
      const landed = input.writes.replies.some((r) => ids.has(r.annotationId));
      if (input.writes.annotations.length === 0) {
        return { pass: false, failureMode: "NO_ACTION", notes: ["no comment was written"] };
      }
      return landed
        ? { pass: true, notes: [] }
        : { pass: false, failureMode: "NO_REPLY_WRITTEN", notes: ["no reply landed under its own comment"] };
    }
    case "thread-none":
      if (input.writes.replies.length > 0) {
        return { pass: false, failureMode: "EXTRA_ACTION", notes: ["a reply landed somewhere"] };
      }
      return input.reply.trim().length > 0
        ? { pass: true, notes: [] }
        : { pass: false, failureMode: "NO_REPLY", notes: [] };
    case "sequence":
      return scoreSequence(input, e);
  }
}
