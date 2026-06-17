/**
 * Deterministic scoring for the #1123 M0 spike.
 *
 * Span correctness is resolved through the SAME findOccurrence used by the
 * harness dispatch — model anchor and gold anchor pass through identical code,
 * so a scoring miss can never be an offset-arithmetic artifact (the issue's
 * named false-NO-GO risk).
 *
 * Chat quality beyond deterministic gates is graded by an optional blind judge
 * (judge.ts); if unavailable, chat is reported on the deterministic floor only.
 */
import type * as Y from "yjs";

import { findOccurrence } from "../../src/server/mcp/navigation.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";

import type { LoopResult } from "./loop.js";
import type { Scenario, ContentAssertion, ReplacementAssertion } from "./scenarios.js";

export interface ScoreResult {
  pass: boolean;
  spanPass?: boolean;
  spanIoU?: number;
  contentPass?: boolean;
  replacementPass?: boolean;
  chatDeterministicPass?: boolean;
  failureMode?: string; // ANCHOR_NOT_FOUND | WRONG_SPAN | OFF_TOPIC | DEGENERATE_EDIT | NO_ACTION | EXTRA_ACTION | NO_REPLY | FORMAT | UNMET_REPLACEMENT
  notes?: string;
}

interface Span {
  from: number;
  to: number;
}

function resolveGold(fullText: string, quoted: string, occ: number): Span | null {
  const hit = findOccurrence(fullText, quoted, occ);
  return "error" in hit ? null : { from: hit.from, to: hit.to };
}

/** Character-interval IoU. */
function iou(a: Span, b: Span): number {
  const interStart = Math.max(a.from, b.from);
  const interEnd = Math.min(a.to, b.to);
  const inter = Math.max(0, interEnd - interStart);
  const union = a.to - a.from + (b.to - b.from) - inter;
  return union <= 0 ? 0 : inter / union;
}

function bestIoU(fullText: string, modelSpan: Span, scenario: Scenario): number {
  const golds: Span[] = [];
  const main = resolveGold(fullText, scenario.target.quoted_text, scenario.target.occurrence_index ?? 1);
  if (main) golds.push(main);
  for (const alt of scenario.target.acceptable_anchors ?? []) {
    const g = resolveGold(fullText, alt.quoted_text, alt.occurrence_index ?? 1);
    if (g) golds.push(g);
  }
  return golds.reduce((best, g) => Math.max(best, iou(modelSpan, g)), 0);
}

function matchContent(text: string, a: ContentAssertion): { pass: boolean; why?: string } {
  const lc = text.toLowerCase();
  if (a.min_chars && text.trim().length < a.min_chars) return { pass: false, why: "too short" };
  if (a.must_match_any && !a.must_match_any.some((k) => lc.includes(k.toLowerCase())))
    return { pass: false, why: `none of [${a.must_match_any.join(", ")}]` };
  if (a.must_not_match && a.must_not_match.some((k) => lc.includes(k.toLowerCase())))
    return { pass: false, why: "matched a forbidden term" };
  return { pass: true };
}

function matchReplacement(suggested: string, goldText: string, a: ReplacementAssertion | undefined): { pass: boolean; why?: string } {
  if (!suggested.trim()) return { pass: false, why: "empty suggestion" };
  if (suggested.trim() === goldText.trim()) return { pass: false, why: "no-op (identical to original)" };
  if (!a) return { pass: true };
  const lc = suggested.toLowerCase();
  if (a.must_match && !new RegExp(a.must_match, "i").test(suggested)) return { pass: false, why: `must match /${a.must_match}/` };
  if (a.must_not_match && new RegExp(a.must_not_match, "i").test(suggested)) return { pass: false, why: `must not match /${a.must_not_match}/` };
  if (a.max_len_ratio && suggested.length > goldText.length * a.max_len_ratio)
    return { pass: false, why: `not shortened (>${a.max_len_ratio}x)` };
  if (a.contains && !lc.includes(a.contains.toLowerCase())) return { pass: false, why: `must contain "${a.contains}"` };
  return { pass: true };
}

/** Extract the comment/replacement annotations created during the run, in order. */
function createdAnnotations(ydoc: Y.Doc): { id: string; content: string; suggestedText?: string; span: Span }[] {
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS).toJSON() as Record<
    string,
    { content?: string; suggestedText?: string; range?: { from: number; to: number } }
  >;
  return Object.entries(map)
    .filter(([, v]) => v.range)
    .map(([id, v]) => ({ id, content: v.content ?? "", suggestedText: v.suggestedText, span: v.range as Span }));
}

const SPAN_IOU_COMMENT = 0.5;
const SPAN_IOU_REPLACEMENT = 0.6;

export function score(scenario: Scenario, ydoc: Y.Doc, loop: LoopResult): ScoreResult {
  const fullText = extractText(ydoc);
  const created = createdAnnotations(ydoc);

  if (scenario.operation === "chat") {
    // No annotation expected. Deterministic gates: produced a plain-text reply,
    // min length, must-cite keywords, and made no spurious annotations.
    if (created.length > 0) return { pass: false, failureMode: "EXTRA_ACTION", notes: "chat scenario produced annotations" };
    const reply = loop.finalContent;
    if (!reply.trim()) return { pass: false, chatDeterministicPass: false, failureMode: "NO_REPLY" };
    const c = matchContent(reply, scenario.content_assertion ?? {});
    return { pass: c.pass, chatDeterministicPass: c.pass, failureMode: c.pass ? undefined : "OFF_TOPIC", notes: c.why };
  }

  if (scenario.operation === "sequence") {
    const seq = scenario.sequence ?? {};
    const reply = loop.finalContent;
    if (seq.final_annotation_count !== undefined && created.length !== seq.final_annotation_count)
      return { pass: false, failureMode: created.length > seq.final_annotation_count ? "EXTRA_ACTION" : "NO_ACTION", notes: `expected ${seq.final_annotation_count} annotations, got ${created.length}` };
    if (seq.min_annotation_count !== undefined && created.length < seq.min_annotation_count)
      return { pass: false, failureMode: "NO_ACTION", notes: `expected >=${seq.min_annotation_count} annotations, got ${created.length}` };
    if (seq.must_anchor) {
      const golds: Span[] = [];
      const m = resolveGold(fullText, seq.must_anchor.quoted_text, seq.must_anchor.occurrence_index ?? 1);
      if (m) golds.push(m);
      for (const alt of seq.must_anchor.acceptable_anchors ?? []) {
        const g = resolveGold(fullText, alt.quoted_text, alt.occurrence_index ?? 1);
        if (g) golds.push(g);
      }
      let bestAnn: (typeof created)[number] | undefined;
      let bestScore = 0;
      for (const a of created) {
        const s = golds.reduce((b, g) => Math.max(b, iou(a.span, g)), 0);
        if (s > bestScore) {
          bestScore = s;
          bestAnn = a;
        }
      }
      if (bestScore < SPAN_IOU_COMMENT) return { pass: false, spanIoU: bestScore, failureMode: bestScore === 0 ? "WRONG_LOCATION" : "WRONG_SPAN", notes: `no annotation anchored the required span (best IoU ${bestScore.toFixed(2)})` };
      if (seq.must_suggest) {
        const ok = bestAnn?.suggestedText && new RegExp(seq.must_suggest, "i").test(bestAnn.suggestedText);
        if (!ok) return { pass: false, spanIoU: bestScore, failureMode: "UNMET_REPLACEMENT", notes: `anchored annotation's suggestion did not match /${seq.must_suggest}/` };
      }
    }
    if (seq.chat_must_match_any) {
      const c = matchContent(reply, { must_match_any: seq.chat_must_match_any });
      if (!c.pass) return { pass: false, failureMode: "NO_VERIFY", notes: `verify/summary step missing: ${c.why}` };
    }
    return { pass: true };
  }

  if (scenario.operation === "no-op") {
    // Correct behavior: zero annotations + a plain-text acknowledgement.
    if (created.length === 0) return { pass: true, notes: "correctly made no changes" };
    return { pass: false, failureMode: "EXTRA_ACTION", notes: `made ${created.length} annotation(s) when none warranted` };
  }

  // comment | replacement: expect exactly one relevant annotation.
  if (created.length === 0) return { pass: false, failureMode: "NO_ACTION", notes: "no annotation created" };
  // Pick the created annotation with the best span match (model may make >1; penalize extras lightly via note).
  const wantsSuggestion = scenario.operation === "replacement";
  const candidates = created.filter((a) => (wantsSuggestion ? a.suggestedText !== undefined : a.suggestedText === undefined));
  const pool = candidates.length ? candidates : created;

  let best = pool[0];
  let bestScore = bestIoU(fullText, best.span, scenario);
  for (const a of pool.slice(1)) {
    const s = bestIoU(fullText, a.span, scenario);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }

  const threshold = wantsSuggestion ? SPAN_IOU_REPLACEMENT : SPAN_IOU_COMMENT;
  const spanPass = bestScore >= threshold;
  if (!spanPass) {
    // An annotation exists but doesn't overlap gold => wrong location (often wrong
    // section / wrong occurrence). True ANCHOR_NOT_FOUND (the model's own quote
    // failed to resolve) is recorded separately in loop metrics, not here.
    const fm = bestScore === 0 ? "WRONG_LOCATION" : "WRONG_SPAN";
    return { pass: false, spanPass: false, spanIoU: bestScore, failureMode: fm, notes: `best IoU ${bestScore.toFixed(2)} < ${threshold}` };
  }

  const content = matchContent(best.content, scenario.content_assertion ?? {});
  let replacementPass: boolean | undefined;
  if (wantsSuggestion) {
    const goldSpan = resolveGold(fullText, scenario.target.quoted_text, scenario.target.occurrence_index ?? 1);
    const goldText = goldSpan ? fullText.slice(goldSpan.from, goldSpan.to) : "";
    const r = matchReplacement(best.suggestedText ?? "", goldText, scenario.replacement_assertion);
    replacementPass = r.pass;
    if (!r.pass)
      return { pass: false, spanPass: true, spanIoU: bestScore, replacementPass: false, failureMode: "UNMET_REPLACEMENT", notes: r.why };
  }

  const extraNote = pool.length > 1 ? ` (model created ${created.length} annotations)` : "";
  if (!content.pass)
    return { pass: false, spanPass: true, spanIoU: bestScore, contentPass: false, replacementPass, failureMode: "OFF_TOPIC", notes: (content.why ?? "") + extraNote };

  return { pass: true, spanPass: true, spanIoU: bestScore, contentPass: true, replacementPass, notes: extraNote.trim() || undefined };
}

/** Wilson score interval lower/upper bound for a binomial proportion (95% default). */
export function wilson(passes: number, n: number, z = 1.96): { rate: number; lo: number; hi: number } {
  if (n === 0) return { rate: 0, lo: 0, hi: 0 };
  const p = passes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { rate: p, lo: Math.max(0, (center - margin) / denom), hi: Math.min(1, (center + margin) / denom) };
}
