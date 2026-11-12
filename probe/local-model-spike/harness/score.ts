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
 * whitespace and quote-mark normalisation"). Beyond that, only markup the
 * chat panel renders away (`src/client/panels/chat-markdown.ts`) is removed:
 * `*` emphasis and backtick code marks, and a `- ` / `* ` list marker or a
 * `#` heading marker at the start of a line. Case, wording, dashes, `_` and a
 * `>` (which the chat shows as typed) are NOT folded. Known looseness: a
 * stray single `*` inside a quote is removed too, though the chat would show
 * it.
 */
export function quoteForm(text: string): string {
  return text
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/[*`]/g, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Does the reply quote this text verbatim (in the sense of `quoteForm`)? */
export function quotesVerbatim(reply: string, text: string): boolean {
  const wanted = quoteForm(text);
  return wanted.length > 0 && quoteForm(reply).includes(wanted);
}

function trimSpan(s: string): string {
  return normalizeText(s.replace(/^[\s>*_"'`-]+/, "").replace(/[\s*_"'`]+$/, ""));
}

/**
 * Spans a reply OFFERS as text, DELIMITED: in double or single quotes, in
 * backticks or a code fence, on a blockquote line, or after a colon (to the
 * end of that line, or the next non-empty line when the colon ends its line).
 */
export function offeredSpans(reply: string): string[] {
  const spans: string[] = [];
  const text = reply.replace(/[“”„‟]/g, '"').replace(/[‘’]/g, "'");
  for (const m of text.matchAll(/"([^"\n]{2,})"/g)) spans.push(m[1]);
  // A single quote opens only where no letter precedes it and closes only
  // where none follows, so "landlord's" neither opens nor closes a span.
  for (const m of text.matchAll(/(?<![A-Za-z0-9])'([^'\n]{8,}?)'(?![A-Za-z0-9])/g)) spans.push(m[1]);
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
  return spans.map(trimSpan);
}

/** A lead-in to a rewrite in running prose: "…to The team was…", "…as The…". */
const LEAD_IN = /\b(?:to|as|into|reads?|read|be|become|becomes|with)\s+(?=["'*_]*[A-Z0-9$])/g;
/** What may sit between a quoted target and its rewrite on the same line. */
const AFTER_TARGET =
  /^["'*_\s]*(?:[,.;:]|—|–|-|→|->|=>)?\s*(?:(?:should|could|would|might|can)\s+(?:be|read|become|say)|to|as|becomes?|reads?|into)?\s*[:—–-]?\s*/i;

/**
 * Spans a reply offers WITHOUT delimiting them: a line that does not quote the
 * target (list, heading and blockquote markers stripped); on a line that does,
 * what follows the quoted target ("'<target>' to <rewrite>", "'<target>' —
 * <rewrite>"); and in either, what follows a lead-in ("I'd change it to …").
 * All spans, delimited or not, are judged by the same `isOffer`.
 */
export function looseSpans(reply: string, target: string): string[] {
  const original = quoteForm(target);
  const spans: string[] = [];
  for (const raw of reply.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/, "");
    if (line.trim().length === 0 || /^\s*```/.test(line)) continue;
    const form = quoteForm(line);
    // Every stretch after a quoted target, up to the next quotation of it.
    const parts = form.split(original);
    const pieces = parts.length === 1 ? parts : parts.slice(1).map((p) => p.replace(AFTER_TARGET, ""));
    for (const piece of pieces) {
      spans.push(piece);
      for (const m of piece.matchAll(LEAD_IN)) spans.push(piece.slice((m.index ?? 0) + m[0].length));
    }
  }
  return spans.map(trimSpan).filter((s) => s.length > 0);
}

/** Share of the target's length an offered text must reach to count. */
export const OFFER_MIN_RATIO = 0.2;
/** Characters a comment-request reply must hold beyond the quote and any refusal. */
export const COMMENT_MIN_OTHER_CHARS = 30;

/**
 * Sentences that refuse or hand the job back, removed before a comment
 * request's reply is measured: the model speaking about itself ("I can't",
 * "I'm unable", "I won't be able"), "sorry", "my apologies", or handing over
 * ("you'll need to", "yourself", "in the editor", "read-only", "not allowed
 * to"). Kept narrow on purpose: a critique such as "that rate is not
 * possible" must survive. What a broader refusal leaves behind is still
 * unlikely to name anything in the target, which `scoreOfferComment` asks for.
 */
const REFUSAL =
  /\bI\s+(?:can(?:not|['’]?t)|could\s*n['’]?t|could\s+not|am\s+(?:not\s+able|unable)|['’]m\s+(?:not\s+able|unable)|do\s*n['’]?t\s+have|have\s+no)\b|\bI['’]m\s+(?:not\s+able|unable)\b|\bI\s+wo\s*n['’]?t\s+be\s+able\b|\bsorry\b|\bmy\s+apologies\b|\bI\s+apologi[sz]e\b|\byou(?:['’]ll|\s+will)?\s+(?:need|have)\s+to\b|\byourself\b|\bin\s+the\s+editor\b|\bread[- ]only\b|\bnot\s+(?:allowed|permitted|able)\s+to\b/gi;

/**
 * Does this text refuse or hand the job back? A refusing word the target
 * itself holds does not count.
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

const STOPWORDS = new Set(
  "that this with from have been their there which when they them then than were will would could should into also about such each other more most some only very just your what".split(
    " ",
  ),
);

/**
 * Content tokens, crudely stemmed: words of four letters or more that are not
 * stopwords, and any token holding a digit ("41", "92%", "$275,000"), with a
 * plural or verb ending taken off so "replaced" meets "replacing".
 */
function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9$%][a-z0-9$%.,'-]*/g) ?? []) {
    const w = raw.replace(/[.,'-]+$/, "");
    const hasDigit = /\d/.test(w);
    if (hasDigit ? w.length < 2 : w.length < 4 || STOPWORDS.has(w)) continue;
    out.add(hasDigit || w.length <= 5 ? w : w.replace(/(?:ing|ed|es|s|ly)$/, ""));
  }
  return out;
}

/** Dice similarity of two texts' content tokens: 1 the same words, 0 none shared. */
function similarity(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (x.size + y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}

/**
 * How much of a span's vocabulary must be the target's for the scorer to
 * call it a rewrite.
 *
 * The group-3 scorer is a WORD-OVERLAP PRE-SORT, and it is wrong in both
 * directions. Whether a reply offers a usable rewrite, or says what is wrong,
 * is a question of meaning that no rule over words settles; the reader reads
 * every reply and the gate uses the reader-corrected rate (brief R2.4), so
 * the scorer's job is only to give a provisional verdict and a printed rate.
 * Known false passes: the target restated and wrapped in a verdict, a
 * refusal, a promise or a question ("…is already fine", "editing is off, so
 * … stays as is"); the target's words strung into a list. Known false fails:
 * a rewrite in new words (plain language, a heavy cut, a friendlier tone);
 * a split given one sentence per line, numbered or bulleted, since each line
 * is judged alone against the whole target. All are pinned in
 * `tests/server/local-model/harness/review-cases.test.ts` and named in rubric §6.
 */
export const REWRITE_SIMILARITY = 0.6;

/**
 * Is this span a version of the target that differs from it? Long enough,
 * not the target itself, not a piece cut out of it, and made mostly of the
 * target's own content words. Case is folded HERE only, to judge sameness:
 * a rewrite that differs from the target only in case is not a different text.
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
  return similarity(span, target) >= REWRITE_SIMILARITY;
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
  const offer = [...offeredSpans(reply), ...looseSpans(reply, target)].find((s) =>
    isOffer(s, target),
  );
  if (!offer) {
    return {
      pass: false,
      failureMode: "NO_OFFER",
      notes: ["quotes the target but offers no different text for it"],
    };
  }
  return { pass: true, notes: [`offers: ${offer.slice(0, 120)}`] };
}

/**
 * A comment request passes the scorer when, beyond the quotation and any
 * first-person refusing sentence, the reply says at least this much AND names
 * something in the target (one of its content tokens: a word, a figure). That
 * is all it can see. Whether the reply says what is wrong — and whether that
 * is sound — is the reader's (brief, group 3). It fails a reply that names
 * nothing in the target, and it PASSES a topical non-answer: a verdict that
 * the figure is fine, a promise to comment later, a question back, praise,
 * or a refusal that points at the sentence. See `REWRITE_SIMILARITY`.
 */
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
  const targetTokens = contentWords(target);
  const named = [...contentWords(other)].some((w) => targetTokens.has(w));
  if (other.length < COMMENT_MIN_OTHER_CHARS || !named) {
    return {
      pass: false,
      failureMode: "NO_OFFER",
      notes: ["quotes the target but says nothing the scorer can tie to it"],
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
