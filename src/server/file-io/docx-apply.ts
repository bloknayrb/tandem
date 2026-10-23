// Apply accepted suggestions to a .docx as tracked changes (w:del + w:ins).
//
// Uses the shared walker (docx-walker.ts) to map flat-text offsets into
// the XML DOM, then mutates the DOM in-place before serializing back to ZIP.

import render from "dom-serializer";
import type { ChildNode } from "domhandler";
import { Element, Text } from "domhandler";
import { parseDocument } from "htmlparser2";
import JSZip from "jszip";
import { snapshotContradicts } from "../../shared/snapshot.js";
import { assertDocxWithinSizeLimits } from "./docx-size-gate.js";
import {
  findAllByName,
  getAttr,
  isElement,
  type SpecialCharSpan,
  type TextHit,
  walkDocumentBody,
} from "./docx-walker.js";

/** Element names inside <w:r> that would produce malformed XML if split. */
const COMPLEX_RUN_ELEMENTS = new Set([
  "w:footnoteReference",
  "w:endnoteReference",
  "w:drawing",
  "w:pict",
  "w:fldChar",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OffsetEntry {
  run: Element;
  textNode: Element;
  /** Character index within the textNode's text content. */
  charIndex: number;
  paragraph: Element;
  paragraphId?: string;
}

export interface OffsetMap {
  get(offset: number): OffsetEntry | undefined;
  flatText: string;
  totalLength: number;
  /** The parsed <w:body> element — same DOM tree as all OffsetEntry references. */
  body: Element;
  /** The full parsed document (parent of body). */
  doc: ReturnType<typeof parseDocument>;
  /**
   * Every span the walker produced from a non-`<w:t>` element (#1754). Derived
   * from the SAME walk that mints the offsets, so it needs no name list and no
   * nesting rules — anything `flatTextForElement` handled is by construction
   * something `buildRun("w:t", …)` cannot reproduce.
   */
  specialSpans: SpecialCharSpan[];
}

export interface SuggestionInput {
  from: number;
  to: number;
  newText: string;
  author: string;
  date: string;
  revisionId: number;
}

export interface ApplyResult {
  ok: boolean;
  reason?: string;
}

export interface AcceptedSuggestion {
  id: string;
  from: number;
  to: number;
  newText: string;
  textSnapshot?: string;
  /**
   * Carried from the annotation so the staleness check below knows whether
   * `textSnapshot` is the whole annotated text or only its first 200
   * characters (#1486). Without it, every suggestion over a long range is
   * rejected as "changed" when nothing changed.
   */
  textSnapshotTruncated?: boolean;
  /** Word comment ID if this suggestion overlaps an imported comment. */
  importCommentId?: string;
}

export interface ApplyOptions {
  author: string;
  ydocFlatText: string;
  date?: string;
}

export interface ApplyOutput {
  buffer: Buffer;
  applied: number;
  rejected: number;
  rejectedDetails: Array<{ id: string; reason: string }>;
  commentsResolved: number;
}

// ---------------------------------------------------------------------------
// buildOffsetMap
// ---------------------------------------------------------------------------

/**
 * Walk the document body and build a lookup from flat-text offset to the
 * corresponding XML DOM position (run, text node, char index within node).
 */
export function buildOffsetMap(xml: string, targetOffsets: Set<number>): OffsetMap {
  const entries = new Map<number, OffsetEntry>();

  // Collect text hits so we can resolve offsets after the walk
  const hits: TextHit[] = [];
  const specialSpans: SpecialCharSpan[] = [];

  const { totalLength, flatText } = walkDocumentBody(xml, {
    onText(hit) {
      hits.push(hit);
    },
    onSpecialChar(span) {
      specialSpans.push(span);
    },
  });

  // For each target offset, find the text hit that contains it
  for (const offset of targetOffsets) {
    // Special case: end-of-document offset
    if (offset === totalLength && hits.length > 0) {
      const lastHit = hits[hits.length - 1];
      entries.set(offset, {
        run: lastHit.run,
        textNode: lastHit.textNode,
        charIndex: lastHit.text.length,
        paragraph: lastHit.paragraph,
        paragraphId: lastHit.paragraphId,
      });
      continue;
    }

    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const start = hit.offsetStart;
      const end = start + hit.text.length;
      if (offset >= start && offset < end) {
        entries.set(offset, {
          run: hit.run,
          textNode: hit.textNode,
          charIndex: offset - start,
          paragraph: hit.paragraph,
          paragraphId: hit.paragraphId,
        });
        break;
      }
      // Allow offset === end for the last character boundary of a text node,
      // but only if no subsequent hit starts at that offset (prefer the start
      // of the next node).
      if (offset === end) {
        const nextHit = hits[i + 1];
        if (!nextHit || nextHit.offsetStart !== offset) {
          entries.set(offset, {
            run: hit.run,
            textNode: hit.textNode,
            charIndex: hit.text.length,
            paragraph: hit.paragraph,
            paragraphId: hit.paragraphId,
          });
          break;
        }
      }
    }
  }

  // Recover the walker's parsed DOM by walking up the parent chain from hits.
  // The walker parses internally; all hit nodes share the same DOM tree.
  let walkerBody: Element;
  let walkerDoc: ReturnType<typeof parseDocument>;
  if (hits.length > 0) {
    // Walk up from the first paragraph to find body and document
    let node = hits[0].paragraph.parent;
    while (node && isElement(node) && node.name !== "w:body") {
      node = node.parent;
    }
    walkerBody = node as Element;
    if (!walkerBody || walkerBody.name !== "w:body") {
      throw new Error("Could not recover w:body from walker's parsed DOM");
    }
    walkerDoc = walkerBody.parent as unknown as ReturnType<typeof parseDocument>;
  } else {
    // No hits — parse ourselves (no entries reference it anyway)
    const doc = parseDocument(xml, { xmlMode: true });
    const bodyElements = findAllByName("w:body", doc.children);
    walkerBody = bodyElements[0] ?? new Element("w:body", {});
    walkerDoc = doc;
  }

  return {
    get(offset: number) {
      return entries.get(offset);
    },
    flatText,
    totalLength,
    body: walkerBody,
    doc: walkerDoc,
    specialSpans,
  };
}

/**
 * The `<w:r>` runs a suggestion would touch: every paragraph-direct run from
 * `fromRun` through `toRun` inclusive. This is the set `applySingleSuggestion`
 * ultimately DESTROYS (`removeChild(run)`), which is why two separate guards
 * below read it rather than reasoning about offsets alone.
 */
function collectTouchedRuns(paragraph: Element, fromRun: Element, toRun: Element): Element[] {
  const runs: Element[] = [];
  let collecting = false;
  for (const child of paragraph.children) {
    if (!isElement(child) || child.name !== "w:r") continue;
    if (child === fromRun) collecting = true;
    if (collecting) {
      runs.push(child);
      if (child === toRun) break;
    }
  }
  return runs;
}

/**
 * Is `run` a DIRECT `<w:r>` child of `paragraph`?
 *
 * The walker recurses into `<w:hyperlink>`, `<w:smartTag>` and friends, so
 * `TextHit.run` can be a run nested one level below the paragraph — while every
 * DOM operation in this file (`collectTouchedRuns`, `splitRun`, step 3's
 * collection loop, step 6's `insertChild`) addresses runs by POSITION IN
 * `paragraph.children`. For a nested run `indexOf` returns -1, which is not an
 * error anywhere: the touched-run set comes back EMPTY and the apply splices
 * runs to the FRONT of the paragraph. The fence below refuses on this rather
 * than growing nesting support, which is a separate piece of work.
 */
function isParagraphDirectRun(paragraph: Element, run: Element): boolean {
  return paragraph.children.includes(run);
}

/**
 * Does anything strictly BETWEEN the two endpoint runs hide a `<w:r>` inside a
 * wrapper element (`<w:hyperlink>`, `<w:ins>`, `<w:smartTag>`, …)?
 *
 * `isParagraphDirectRun` only screens the two ENDPOINTS, and every DOM operation
 * downstream — `collectTouchedRuns`, step 3's collection loop, step 6's
 * `removeChild` — walks `paragraph.children` and skips anything that is not a
 * direct `<w:r>`. An interior wrapper is therefore invisible to all of them: the
 * suggestion reports `applied: 1`, the wrapped text is absent from the `<w:del>`
 * record, and it survives REORDERED after the insertion. Neither accepting nor
 * rejecting the tracked change in Word can recover the original wording, because
 * the deletion never claimed that text. `<w:ins>` is the ordinary shape of a
 * document already under review — precisely `tandem_applyChanges`' domain — so
 * this is the common case, not an exotic one.
 *
 * Refusing is the fix rather than growing nesting support, same as the endpoint
 * fence: see `isParagraphDirectRun`.
 */
function hasNestedRunBetween(paragraph: Element, fromRun: Element, toRun: Element): boolean {
  const fromIdx = paragraph.children.indexOf(fromRun);
  const toIdx = paragraph.children.indexOf(toRun);
  if (fromIdx < 0 || toIdx < 0) return false;
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  for (let i = lo + 1; i < hi; i++) {
    const child = paragraph.children[i];
    if (!isElement(child) || child.name === "w:r") continue;
    if (findAllByName("w:r", [child]).length > 0) return true;
  }
  return false;
}

/**
 * How many DIRECT `<w:t>` children `run` carries.
 *
 * Step 4 rebuilds the deletion text from `findTextNode(run)`, which returns only
 * the FIRST `<w:t>`, while step 6 `removeChild`s the whole run — so a run holding
 * two `<w:t>` children loses the trailing one silently AND without it appearing
 * in the `<w:del>` record. The special-character fence does not cover this: two
 * plain `<w:t>` separated by nothing, or by an element the walker ignores (a
 * `<w:cr/>`), produce no `SpecialCharSpan` at all. Same invariant as the
 * run-keyed half of that fence, keyed on the same destroyed-run set.
 */
function countTextNodes(run: Element): number {
  let n = 0;
  for (const child of run.children) {
    if (isElement(child) && child.name === "w:t") n++;
  }
  return n;
}

/**
 * The only element children a DESTROYED `<w:r>` may carry. Step 4 records a
 * destroyed run solely through its first `<w:t>` (as `<w:delText>`) and its
 * `<w:rPr>`; step 6 then `removeChild`s the whole run. Any other child is
 * deleted with no revision recording it, so a reject in Word cannot bring it
 * back (#2107). `w:lastRenderedPageBreak` is here because Word regenerates it
 * on every layout. `w:commentReference` is here only so the generic refusal
 * below does not shadow its own, more specific one (`hasCommentRef`).
 *
 * This is the FENCE's allowlist and deliberately not the trim's: whether a
 * trailing run may be left in place is a question about flat text, answered
 * by `carriesNoFlatText`, not about element names — an earlier allowlist trim
 * let a trailing `<w:object>`, `<w:cr/>` or `<w:ptab/>` run fall through both
 * the trim and the fence and be silently destroyed.
 *
 * Element names are matched with the literal `w:` prefix, the same convention
 * as `w:r` and `COMPLEX_RUN_ELEMENTS` in this file. A document using another
 * prefix fails toward REFUSAL here, never toward silent loss.
 */
const RECORDABLE_RUN_CHILDREN = new Set([
  "w:rPr",
  "w:t",
  "w:lastRenderedPageBreak",
  "w:commentReference",
]);

/**
 * Does destroying `run` lose something step 4 does not record? True when it
 * carries any element child outside `RECORDABLE_RUN_CHILDREN` — a `<w:cr/>`, an
 * embedded `<w:object>`, a `<w:ptab/>`, an `mc:AlternateContent` drawing, or
 * anything the walker resolves to nothing. Name-agnostic on purpose: anything
 * not known to be recorded is refused.
 */
function hasUnrecordedChild(run: Element): boolean {
  return run.children.some((c) => isElement(c) && !RECORDABLE_RUN_CHILDREN.has(c.name));
}

/**
 * The runs the walker attributed a `SpecialCharSpan` to — zero-length ones
 * included (an unmapped `w:sym`, an unknown `w:br w:type`). Such a run is not
 * "flat-text-free" for `carriesNoFlatText`, so it keeps its run-keyed refusal.
 */
function specialSpanRuns(offsetMap: OffsetMap): Set<Element> {
  const runs = new Set<Element>();
  for (const span of offsetMap.specialSpans) if (span.run) runs.add(span.run);
  return runs;
}

/**
 * Does `run` contribute nothing to the flat text? No `<w:t>` anywhere in it, no
 * nested `<w:p>` (a text box's paragraph adds a separator even when empty), and
 * no walker `SpecialCharSpan`. Keyed on what the walker counts, not on element
 * names, so an element nobody listed is classified by what it does.
 */
function carriesNoFlatText(run: Element, specialRuns: Set<Element>): boolean {
  return (
    !specialRuns.has(run) &&
    findAllByName("w:t", run.children).length === 0 &&
    findAllByName("w:p", run.children).length === 0
  );
}

/**
 * Drop trailing flat-text-free runs from a collected run span, in place (#2107).
 *
 * `buildOffsetMap` resolves an exclusive `to` into the START of the next TEXT
 * run, so every run between the range's last character and that text run lands
 * in the collected span — and every such run is zero-width by construction (the
 * hit holding `to - 1` and the hit starting at `to` are adjacent in flat text).
 * It therefore sits AFTER `[from, to)`, not inside it, and is left in place:
 * nothing moves, because the `<w:del>`/`<w:ins>` pair goes where the FIRST
 * destroyed run stood. Before this trim step 4 gave such a run no `<w:delText>`
 * and step 6 removed it — a comment lost its reference mark, an embedded OLE
 * object or a `<w:cr/>` vanished — with no revision recording it.
 *
 * One exception: a run carrying a `COMPLEX_RUN_ELEMENTS` child (a field
 * character, a footnote reference, a drawing) is NOT trimmed and keeps its
 * pre-#2107 refusal at the fence, pinned as a current limitation in the tests.
 * That is a fail-closed false refusal, never a silent loss.
 *
 * Stops at length 1 so the from-run — which holds the `<w:t>` that `from`
 * resolved into — is never dropped. Applied identically by
 * `collectDestroyedRuns` (the fence) and step 3 of `applySingleSuggestion` (the
 * apply), so both agree on what is destroyed. Anything the trim keeps that
 * carries an unrecorded child is refused by the fence (`hasUnrecordedChild`).
 */
function trimTrailingZeroWidthRuns(runs: Element[], specialRuns: Set<Element>): void {
  while (runs.length > 1) {
    const last = runs[runs.length - 1];
    if (!carriesNoFlatText(last, specialRuns)) break;
    if (last.children.some((c) => isElement(c) && COMPLEX_RUN_ELEMENTS.has(c.name))) break;
    runs.pop();
  }
}

/**
 * The subset of `collectTouchedRuns` that `applySingleSuggestion` actually
 * DESTROYS: it drops `toRun` when the exclusive `to` offset lands on that run's
 * FIRST character, mirroring the `toEntry.charIndex === 0 && child ===
 * toEntry.run` break in step 3, where the run is neither split nor removed.
 *
 * That shape is common, not exotic: `buildOffsetMap` resolves an exclusive `to`
 * into the START of the next text hit whenever one begins at exactly that
 * offset, so any suggestion ending at a run boundary resolves `toRun` to the
 * FOLLOWING run. Keying the special-character fence on the unfiltered set
 * therefore refused an ordinary suggestion merely ADJACENT to a run that happens
 * to carry a trailing tab (a table-of-contents line) — the false refusal #1754
 * exists to remove.
 *
 * It then trims trailing zero-width runs (`trimTrailingZeroWidthRuns`, #2107),
 * exactly as step 3 does after its own loop, so a comment-reference, `<w:cr/>`
 * or embedded-object run sitting between the range's last character and the
 * next text run is neither refused here nor destroyed there.
 *
 * Deliberately NOT used for the run-CLAIM check below, which must keep the
 * conservative superset (untrimmed, `toRun` included): a `toRun` this
 * suggestion leaves alone can still be REMOVED by another suggestion applied
 * earlier in the descending pass. `applySingleSuggestion` now refuses such a
 * `toRun` with its pre-mutation direct-run check rather than deleting the
 * paragraph tail, but the claim check is what keeps the suggestion applicable.
 */
function collectDestroyedRuns(
  paragraph: Element,
  fromRun: Element,
  toEntry: OffsetEntry,
  specialRuns: Set<Element>,
): Element[] {
  const runs = collectTouchedRuns(paragraph, fromRun, toEntry.run);
  // `runs.length > 1` keeps the `from` run: when the range opens and closes in
  // the SAME run, step 3 breaks immediately, deletes nothing and answers the
  // opaque "No runs found in deletion range". Refusing at the fence instead
  // keeps the reason that names the tab/break/symbol — and that shape is
  // exactly one run holding `alpha<w:sym/>beta` with a suggestion over `alpha`.
  if (toEntry.charIndex === 0 && runs.length > 1 && runs[runs.length - 1] === toEntry.run) {
    runs.pop();
  }
  trimTrailingZeroWidthRuns(runs, specialRuns);
  return runs;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/** Get the text content of a w:t or w:delText element. */
function getNodeText(node: Element): string {
  for (const child of node.children) {
    if (child.type === "text") return (child as unknown as Text).data;
  }
  return "";
}

/** Set the text content of a w:t or w:delText element. */
function setNodeText(node: Element, text: string): void {
  const textChild = new Text(text);
  (textChild as ChildNode).parent = node;
  node.children = [textChild];
  // Preserve spaces if needed
  if (text.startsWith(" ") || text.endsWith(" ")) {
    node.attribs["xml:space"] = "preserve";
  } else {
    delete node.attribs["xml:space"];
  }
}

/** Clone a w:rPr element by serializing and re-parsing. */
function cloneRPr(rPr: Element): Element {
  const serialized = render(rPr, { xmlMode: true });
  const doc = parseDocument(serialized, { xmlMode: true });
  return doc.children[0] as Element;
}

/** Find the w:rPr child of a w:r run, if any. */
function findRPr(run: Element): Element | undefined {
  for (const child of run.children) {
    if (isElement(child) && child.name === "w:rPr") return child;
  }
  return undefined;
}

/** Build a new w:r element with optional rPr and a text element. */
function buildRun(
  textElementName: "w:t" | "w:delText",
  text: string,
  rPrSource?: Element,
): Element {
  const children: ChildNode[] = [];

  if (rPrSource) {
    const cloned = cloneRPr(rPrSource);
    children.push(cloned);
  }

  const textChild = new Text(text);
  const attribs: Record<string, string> = {};
  if (text.startsWith(" ") || text.endsWith(" ")) {
    attribs["xml:space"] = "preserve";
  }
  const textNode = new Element(textElementName, attribs, [textChild]);
  (textChild as ChildNode).parent = textNode;
  children.push(textNode);

  const run = new Element("w:r", {}, children);
  for (const child of children) {
    (child as ChildNode).parent = run;
  }
  return run;
}

/** Insert a node into a parent's children array at a given index. */
function insertChild(parent: Element, index: number, node: ChildNode): void {
  parent.children.splice(index, 0, node);
  node.parent = parent;
}

/** Remove a node from its parent's children array. */
function removeChild(node: ChildNode): void {
  if (!node.parent) return;
  const parent = node.parent as Element;
  const idx = parent.children.indexOf(node);
  if (idx >= 0) parent.children.splice(idx, 1);
  node.parent = null;
}

// ---------------------------------------------------------------------------
// applySingleSuggestion
// ---------------------------------------------------------------------------

/**
 * Apply a single tracked-change suggestion to the document body.
 *
 * Wraps the original text in `<w:del>` (using `<w:delText>`) and inserts
 * `<w:ins>` with the replacement. Inherits `<w:rPr>` from the first deleted run.
 */
export function applySingleSuggestion(
  offsetMap: OffsetMap,
  suggestion: SuggestionInput,
): ApplyResult {
  const { from, to, newText, author, date, revisionId } = suggestion;

  if (from > to) {
    return { ok: false, reason: "Range endpoints are out of order" };
  }

  const fromHit = offsetMap.get(from);
  const toHit = offsetMap.get(to);

  if (!fromHit || !toHit) {
    return { ok: false, reason: `Could not resolve offsets: from=${from} to=${to}` };
  }

  if (fromHit.paragraph !== toHit.paragraph) {
    return { ok: false, reason: "Cross-paragraph suggestions not yet supported" };
  }

  // Work on COPIES, taken here — after the resolve and cross-paragraph checks
  // and BEFORE step 1 — so step 1's re-pointing never writes through to the
  // shared `OffsetMap` entries. Mutating the shared entries used to be how
  // `from === to` kept both endpoints in step (the two lookups returned one
  // object); the #2106 re-point after step 1 replaces that. Copies are safe
  // because the orchestrator's run-claim check guarantees that an offset shared
  // between two applied suggestions only ever resolves inside a claimed run, so
  // no later suggestion depends on an entry an earlier one re-pointed.
  const fromEntry = { ...fromHit };
  const toEntry = { ...toHit };

  const paragraph = fromEntry.paragraph;

  // Pre-mutation refusals for shapes the DOM operations below — all expressed
  // in paragraph-direct children — would get silently wrong. The orchestrator's
  // fences refuse every one of these first (with the same reason strings), so
  // this is defence in depth for direct callers, and NOT a complete guard:
  // `<w:r><w:t>alpha</w:t><w:tab/><w:t>beta</w:t></w:r>` over `alpha` resolves
  // both endpoints into the first `<w:t>`, passes all three checks, and would
  // remove the whole run. Only the orchestrator's special-character and
  // split-text fences protect that shape.
  //
  // (a) An endpoint run that is not a direct child of the paragraph (inside a
  //     hyperlink, or removed by an earlier apply) — see `isParagraphDirectRun`.
  if (
    !isParagraphDirectRun(paragraph, fromEntry.run) ||
    !isParagraphDirectRun(paragraph, toEntry.run)
  ) {
    return { ok: false, reason: "Spans a hyperlink or other nested run and couldn't be applied" };
  }
  // (b) Endpoints out of document order. Unreachable for a consistent
  //     `OffsetMap` once the flat `from > to` check above has run; kept because
  //     step 3 assumes document order, and an inverted pair there collects to
  //     the END of the paragraph (#2106).
  const fromIdx = paragraph.children.indexOf(fromEntry.run);
  const toIdx = paragraph.children.indexOf(toEntry.run);
  if (
    toIdx < fromIdx ||
    (fromEntry.textNode === toEntry.textNode && toEntry.charIndex < fromEntry.charIndex)
  ) {
    return { ok: false, reason: "Range endpoints are out of order" };
  }
  // (c) Both endpoints in one run but in different `<w:t>` elements: the step-1
  //     split moves only the from-`<w:t>`'s tail, so the to-endpoint cannot be
  //     re-pointed, and step 4 would record only the first segment.
  if (fromEntry.run === toEntry.run && fromEntry.textNode !== toEntry.textNode) {
    return {
      ok: false,
      reason: "Spans a run with multiple text segments and couldn't be applied",
    };
  }

  // Collect all w:r runs between from and to within this paragraph.
  // We need to find runs that contain text in the [from, to) range.
  // Strategy: split boundary runs if needed, then wrap interior runs.

  // Step 1: Split the "from" run if charIndex > 0
  if (fromEntry.charIndex > 0) {
    const splitTextNode = fromEntry.textNode;
    const splitAt = fromEntry.charIndex;
    splitRun(fromEntry.run, fromEntry.textNode, fromEntry.charIndex, paragraph);
    // After split, fromEntry.run is the "before" part; the text we want
    // starts in the newly created run (next sibling).
    const idx = paragraph.children.indexOf(fromEntry.run);
    const nextRun = paragraph.children[idx + 1];
    if (!nextRun || !isElement(nextRun) || nextRun.name !== "w:r") {
      return { ok: false, reason: "Split failed: no next run after from-split" };
    }
    // Update fromEntry to point to the new run
    fromEntry.run = nextRun;
    const nextTextNode = findTextNode(nextRun);
    if (!nextTextNode) {
      return { ok: false, reason: "Run contains no text element" };
    }
    fromEntry.textNode = nextTextNode;
    fromEntry.charIndex = 0;

    // #2106: when `to` resolved into the SAME `<w:t>` just split, `toEntry`
    // still points at the first half (now only the text before `from`) with a
    // `charIndex` measured against the unsplit text. Step 2 then skipped its
    // split, and step 3 — starting at `fromEntry.run`, which lies AFTER
    // `toEntry.run` — never met its break and destroyed every direct `<w:r>` to
    // the end of the paragraph. Re-point it at the second half. `from <= to`
    // (checked above) keeps the new index non-negative; `from === to` lands on
    // index 0, the insertion-only path below.
    if (toEntry.textNode === splitTextNode) {
      toEntry.run = nextRun;
      toEntry.textNode = nextTextNode;
      toEntry.charIndex -= splitAt;
    }
  }

  // Step 2: Split the "to" run if charIndex < text length
  const toText = getNodeText(toEntry.textNode);
  if (toEntry.charIndex < toText.length && toEntry.charIndex > 0) {
    splitRun(toEntry.run, toEntry.textNode, toEntry.charIndex, paragraph);
    // After split, toEntry.run has text [0..charIndex), and the rest is in a new run.
    // We want to include toEntry.run in the deletion (it has the first part).
    // toEntry now correctly points to the run ending at the split point.
  } else if (toEntry.charIndex === 0) {
    // The "to" offset is at the start of this run — don't include this run.
    // We delete everything up to but not including toEntry.run.
  }

  // Step 3: Collect all runs between fromEntry.run and toEntry.run (inclusive/exclusive)
  const runsToDelete: Element[] = [];
  let collecting = false;

  for (const child of paragraph.children) {
    if (!isElement(child) || child.name !== "w:r") {
      if (collecting && child === toEntry.run) break;
      continue;
    }

    if (child === fromEntry.run) {
      collecting = true;
    }

    if (collecting) {
      if (toEntry.charIndex === 0 && child === toEntry.run) {
        // Don't include this run — "to" is at its start
        break;
      }
      runsToDelete.push(child);
      if (child === toEntry.run) {
        break;
      }
    }
  }

  // #2107: a zero-width run between the range's last character and the next
  // text run is not part of the range. Same trim as `collectDestroyedRuns`.
  trimTrailingZeroWidthRuns(runsToDelete, specialSpanRuns(offsetMap));

  if (runsToDelete.length === 0) {
    // Edge case: from === to (insertion only, no deletion)
    if (from === to && newText.length > 0) {
      const insertionPoint = paragraph.children.indexOf(fromEntry.run);
      const rPr = findRPr(fromEntry.run);
      const insRun = buildRun("w:t", newText, rPr);
      const ins = new Element(
        "w:ins",
        {
          "w:id": String(revisionId + 1),
          "w:author": author,
          "w:date": date,
        },
        [insRun],
      );
      (insRun as ChildNode).parent = ins;
      insertChild(paragraph, insertionPoint, ins);
      return { ok: true };
    }
    return { ok: false, reason: "No runs found in deletion range" };
  }

  // Step 4: Build w:del element with w:delText runs
  const rPrSource = findRPr(runsToDelete[0]);
  const delChildren: ChildNode[] = [];

  for (const run of runsToDelete) {
    const tn = findTextNode(run);
    if (!tn) continue; // skip tab-only or break-only runs with no <w:t>
    const text = getNodeText(tn);
    const delRun = buildRun("w:delText", text, findRPr(run));
    delChildren.push(delRun);
  }

  const del = new Element(
    "w:del",
    {
      "w:id": String(revisionId),
      "w:author": author,
      "w:date": date,
    },
    delChildren,
  );
  for (const child of delChildren) {
    (child as ChildNode).parent = del;
  }

  // Step 5: Build w:ins element if newText is non-empty
  let ins: Element | undefined;
  if (newText.length > 0) {
    const insRun = buildRun("w:t", newText, rPrSource);
    ins = new Element(
      "w:ins",
      {
        "w:id": String(revisionId + 1),
        "w:author": author,
        "w:date": date,
      },
      [insRun],
    );
    (insRun as ChildNode).parent = ins;
  }

  // Step 6: Replace the original runs with del (+ ins)
  const firstRunIndex = paragraph.children.indexOf(runsToDelete[0]);

  // Remove original runs
  for (const run of runsToDelete) {
    removeChild(run);
  }

  // Insert del at the position of the first removed run
  insertChild(paragraph, firstRunIndex, del);

  // Insert ins after del
  if (ins) {
    insertChild(paragraph, firstRunIndex + 1, ins);
  }

  return { ok: true };
}

/** Split a run at charIndex, creating a new run after it with the remainder. */
function splitRun(run: Element, textNode: Element, charIndex: number, paragraph: Element): void {
  const fullText = getNodeText(textNode);
  const before = fullText.slice(0, charIndex);
  const after = fullText.slice(charIndex);

  // Update the original run's text
  setNodeText(textNode, before);

  // Create a new run for the remainder
  const rPr = findRPr(run);
  const newRun = buildRun("w:t", after, rPr);

  // Insert after the original run in the paragraph
  const idx = paragraph.children.indexOf(run);
  insertChild(paragraph, idx + 1, newRun);
}

/** Find the w:t element within a run. */
function findTextNode(run: Element): Element | undefined {
  for (const child of run.children) {
    if (isElement(child) && child.name === "w:t") return child;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// applyTrackedChanges (orchestrator)
// ---------------------------------------------------------------------------

/**
 * Apply accepted suggestions to a .docx buffer as tracked changes.
 *
 * Returns a new buffer with the modified document plus statistics.
 */
export async function applyTrackedChanges(
  docxBuffer: Buffer,
  suggestions: AcceptedSuggestion[],
  options: ApplyOptions,
): Promise<ApplyOutput> {
  // #1310: this path re-reads the SAME on-disk file the document was opened from
  // (`mcp/docx-apply.ts` → `fs.readFile`), so it carries the identical untrusted input as import and
  // needs the identical ceiling. The licence refusal sits at the `/mcp` handshake, not on this
  // tool, and authenticates nothing about the bytes.
  await assertDocxWithinSizeLimits(docxBuffer);

  const zip = await JSZip.loadAsync(docxBuffer);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) {
    throw new Error("Missing word/document.xml in .docx archive");
  }

  const date = options.date ?? new Date().toISOString();

  // Collect all target offsets
  const targetOffsets = new Set<number>();
  for (const s of suggestions) {
    targetOffsets.add(s.from);
    targetOffsets.add(s.to);
  }

  // Build offset map (first pass — for comparison guard only)
  const offsetMap = buildOffsetMap(documentXml, targetOffsets);

  // Comparison guard
  if (offsetMap.flatText !== options.ydocFlatText) {
    throw new Error(
      "Flat text mismatch: the .docx content does not match the Y.Doc flat text. " +
        "The file may have changed since it was loaded. " +
        // Deliberately NOT an enumeration: decision B (#1827) defers the rest of
        // the walker/mammoth reconciliation, so naming two causes here would
        // misdiagnose every file that trips a third.
        "Some documents are a known limitation (#1754).",
    );
  }

  // Sort descending by `from` so later edits don't shift earlier offsets
  const sorted = [...suggestions].sort((a, b) => b.from - a.from);

  // Validate ALL before mutating
  const valid: AcceptedSuggestion[] = [];
  const rejectedDetails: Array<{ id: string; reason: string }> = [];

  for (const s of sorted) {
    // An inverted range is refused first: `snapshotContradicts` passes one that
    // has no snapshot, and the overlap, fence and run-claim stages below all
    // assume `from <= to`. `mcp/docx-apply.ts` already skips an inverted
    // relRange, but a stored flat-range fallback can still arrive inverted from
    // corrupt data.
    if (s.from > s.to) {
      rejectedDetails.push({ id: s.id, reason: "Range endpoints are out of order" });
      continue;
    }

    // textSnapshot check — has the text under this range changed since the
    // suggestion was WRITTEN? (`captureSnapshot` runs at annotation creation,
    // and everything here is already accepted, so the snapshot always predates
    // acceptance.) The capped-snapshot-is-a-prefix rule (#1486)
    // lives in the predicate, which the editor's accept path shares (#1629);
    // it also absorbs the "no snapshot ⇒ nothing to contradict" case that used
    // to be an outer guard here.
    const actual = offsetMap.flatText.slice(s.from, s.to);
    if (snapshotContradicts(s, actual)) {
      rejectedDetails.push({
        id: s.id,
        reason: `Text snapshot mismatch: expected "${s.textSnapshot}", got "${actual}"`,
      });
      continue;
    }

    // Offset resolution check
    const fromEntry = offsetMap.get(s.from);
    const toEntry = offsetMap.get(s.to);
    if (!fromEntry || !toEntry) {
      rejectedDetails.push({
        id: s.id,
        reason: `Could not resolve offsets: from=${s.from} to=${s.to}`,
      });
      continue;
    }

    valid.push(s);
  }

  // Check for overlapping ranges among valid suggestions (already sorted desc by from)
  const validAfterOverlapCheck: AcceptedSuggestion[] = [];
  let lastFrom = Infinity;
  for (const s of valid) {
    if (s.to > lastFrom) {
      rejectedDetails.push({
        id: s.id,
        reason: `Overlapping range [${s.from}, ${s.to}) conflicts with another suggestion`,
      });
      continue;
    }
    lastFrom = s.from;
    validAfterOverlapCheck.push(s);
  }

  // Reject suggestions whose range contains complex (non-text) elements
  // that would produce malformed XML when the run is split or wrapped, OR that
  // would take a tab / break / symbol with them (#1754).
  //
  // The second half is TWO predicates, ORed, and the run-keyed one is the
  // load-bearing half. `applySingleSuggestion` destroys whole `<w:r>` elements,
  // not offset ranges — it rebuilds the deletion text from `findTextNode(run)`,
  // which returns only the FIRST `<w:t>` in a run, then `removeChild(run)`s the
  // lot. So on `<w:r><w:t>Name</w:t><w:tab/><w:t>Value</w:t></w:r>` a suggestion
  // over `Name` alone does not overlap the tab's `[4,5)` span at all and would
  // still silently delete the tab AND `Value` from the user's .docx. That was
  // unreachable only because the flat-text guard threw on any tabbed document
  // first; the tab/break/symbol fix above is precisely what makes it reachable,
  // so this fence ships with it or not at all.
  //
  // It keys on `collectDestroyedRuns`, NOT `collectTouchedRuns`: the run holding
  // the exclusive `to` boundary is excluded when the apply would not touch it,
  // or every suggestion ending at a run boundary before a tab-bearing run is
  // refused. See that function for why the run-claim check below must not follow
  // suit.
  //
  // Predicate 2 is also LENGTH-INDEPENDENT, which is what covers the two
  // elements that fix turns zero-width (an unrecognised `w:br w:type`, an
  // unmapped `w:sym`): a zero-length span can never satisfy
  // `s.from < span.offsetStart + 0` for a suggestion starting at or after it.
  const validAfterComplexCheck: AcceptedSuggestion[] = [];
  const specialRuns = specialSpanRuns(offsetMap);
  for (const s of validAfterOverlapCheck) {
    const fromEntry = offsetMap.get(s.from)!;
    const toEntry = offsetMap.get(s.to)!;

    // Nested runs first, because every guard after this one is EXPRESSED in
    // paragraph-direct children and goes silently inert without saying so — see
    // `isParagraphDirectRun`. A run inside a `<w:hyperlink>` produced an empty
    // touched-run set, passed both halves of the fence below, and then corrupted
    // the paragraph in `applySingleSuggestion` while reporting `applied: 1`.
    // Newly reachable: before the tab/break/symbol fix a hyperlinked, tabbed
    // document died on the flat-text guard above instead.
    //
    // Review round 2: the endpoints alone are not enough. A wrapper sitting
    // BETWEEN two paragraph-direct endpoint runs is invisible to every loop that
    // follows, and the failure is silent corruption reported as `applied: 1` —
    // see `hasNestedRunBetween`. The interior scan is gated on a single
    // paragraph because a cross-paragraph pair's indices are not comparable;
    // `applySingleSuggestion` refuses that shape on its own.
    if (
      !isParagraphDirectRun(fromEntry.paragraph, fromEntry.run) ||
      !isParagraphDirectRun(toEntry.paragraph, toEntry.run) ||
      (fromEntry.paragraph === toEntry.paragraph &&
        hasNestedRunBetween(fromEntry.paragraph, fromEntry.run, toEntry.run))
    ) {
      rejectedDetails.push({
        id: s.id,
        reason: "Spans a hyperlink or other nested run and couldn't be applied",
      });
      continue;
    }

    const touchedRuns = collectDestroyedRuns(
      fromEntry.paragraph,
      fromEntry.run,
      toEntry,
      specialRuns,
    );
    const touchedRunSet = new Set(touchedRuns);

    const hasComplex = touchedRuns.some((run) =>
      run.children.some((rc) => isElement(rc) && COMPLEX_RUN_ELEMENTS.has(rc.name)),
    );

    const hasSpecialChar = offsetMap.specialSpans.some(
      (span) =>
        // Half-open on BOTH sides, so a suggestion ending exactly at the special
        // character, or starting exactly at its end, still applies. A
        // closed-interval test would silently refuse ordinary adjacent
        // suggestions on every tabbed document — the outcome #1754 exists to
        // remove.
        (s.from < span.offsetStart + span.length && s.to > span.offsetStart) ||
        (span.run !== undefined && touchedRunSet.has(span.run)),
    );

    // Review round 2: a destroyed run with a SECOND `<w:t>` loses that text with
    // no record of it, and no `SpecialCharSpan` marks the shape — see
    // `countTextNodes`. Same destroyed-run set as predicate 2, so the same
    // `toRun`-exclusion applies and an adjacent suggestion is not refused.
    const hasSplitText = touchedRuns.some((run) => countTextNodes(run) > 1);

    // #2107: a Word comment's reference run INSIDE the destroyed set would be
    // removed with no revision recording it (step 4 builds `<w:delText>` only
    // from `<w:t>`), leaving the comment with range markers and no reference.
    // A TRAILING reference run is already trimmed out of `touchedRuns`, so this
    // fires only for one the range genuinely spans. Deliberately asymmetric: an
    // interior `lastRenderedPageBreak`-only or empty run is still destroyed,
    // because Word regenerates the one and the other carries nothing (both are
    // in `RECORDABLE_RUN_CHILDREN`; see `hasUnrecorded` below for the rest).
    //
    // Run-keyed, not offset-keyed, on purpose: it also refuses a reference that
    // shares a `<w:r>` with text in the from-run. That is not mere over-refusal
    // — `splitRun` leaves every non-`<w:t>` child in the BEFORE half, so
    // `<w:r><w:t>xy</w:t><w:commentReference/></w:r>` split at 1 would move the
    // reference mark ahead of the deleted `y`. Do not narrow this to "only
    // references that would be destroyed". Kept out of `COMPLEX_RUN_ELEMENTS`
    // so the refusal names the comment.
    const hasCommentRef = touchedRuns.some((run) =>
      run.children.some((rc) => isElement(rc) && rc.name === "w:commentReference"),
    );

    // #2107 review: the general case of the above. Any destroyed run carrying a
    // child step 4 does not record — an interior `<w:object>` or `<w:cr/>` run,
    // or a `<w:t>` run that also holds one — would vanish with no revision. A
    // trailing zero-width run is already trimmed out of `touchedRuns`, so this
    // fires only for content the range genuinely spans (or a run `splitRun`
    // would reorder: it leaves every non-`<w:t>` child in the BEFORE half).
    const hasUnrecorded = touchedRuns.some(hasUnrecordedChild);

    if (hasComplex || hasSpecialChar || hasCommentRef || hasSplitText || hasUnrecorded) {
      rejectedDetails.push({
        id: s.id,
        // The named-element reason WINS when both hold: a run reading
        // `<w:t>alpha</w:t><w:sym/><w:t>beta</w:t>` satisfies both predicates,
        // and the element it carries is the more diagnosable half.
        reason:
          hasComplex || hasSpecialChar
            ? "Overlaps a footnote, drawing, field, tab, break or symbol and couldn't be applied"
            : hasCommentRef
              ? "Spans a Word comment's reference mark and couldn't be applied"
              : hasSplitText
                ? "Spans a run with multiple text segments and couldn't be applied"
                : "Spans an embedded object, line break or other non-text content and couldn't be applied",
      });
    } else {
      validAfterComplexCheck.push(s);
    }
  }

  // Reject suggestions that target the same <w:r> run — the first split would
  // invalidate the second suggestion's DOM references. Uses the UNFILTERED
  // `collectTouchedRuns` on purpose (see `collectDestroyedRuns`): a `toRun` this
  // suggestion never touches is still the run its own step-3 loop stops on, so
  // letting another suggestion delete it would get this one refused by
  // `applySingleSuggestion`'s pre-mutation direct-run check (before #2106 it
  // deleted the paragraph tail instead). Trailing zero-width runs (#2107) stay in
  // this untrimmed set too, so another suggestion cannot remove a run this one
  // deliberately keeps — do not move this check onto the trimmed set.
  const validAfterRunCheck: AcceptedSuggestion[] = [];
  const claimedRuns = new Map<Element, string>(); // run -> suggestion id that claimed it
  for (const s of validAfterComplexCheck) {
    const fromEntry = offsetMap.get(s.from)!;
    const toEntry = offsetMap.get(s.to)!;
    const touchedRuns = collectTouchedRuns(fromEntry.paragraph, fromEntry.run, toEntry.run);

    let conflict = false;
    for (const run of touchedRuns) {
      if (claimedRuns.has(run)) {
        rejectedDetails.push({
          id: s.id,
          reason: "Targets the same text run as another suggestion",
        });
        conflict = true;
        break;
      }
    }
    if (!conflict) {
      for (const run of touchedRuns) {
        claimedRuns.set(run, s.id);
      }
      validAfterRunCheck.push(s);
    }
  }

  // The offset map already parsed the XML — reuse its DOM for serialization
  const doc = offsetMap.doc;

  // Find max existing w:id to avoid collisions
  const idMatches = documentXml.match(/w:id="(\d+)"/g) || [];
  let maxId = 0;
  for (const m of idMatches) {
    const num = parseInt(m.match(/\d+/)![0], 10);
    if (num > maxId) maxId = num;
  }

  // Apply each valid suggestion in reverse offset order.
  // ID allocation: maxId += 2 per suggestion because each tracked change
  // needs two revision IDs — one for the <w:del> element (revisionId) and
  // one for the <w:ins> element (revisionId + 1).
  let applied = 0;
  const appliedSuggestions: AcceptedSuggestion[] = [];
  for (const s of validAfterRunCheck) {
    maxId += 2;
    const result = applySingleSuggestion(offsetMap, {
      from: s.from,
      to: s.to,
      newText: s.newText,
      author: options.author,
      date,
      revisionId: maxId - 1,
    });
    if (result.ok) {
      applied++;
      appliedSuggestions.push(s);
    } else {
      rejectedDetails.push({ id: s.id, reason: result.reason ?? "Unknown error" });
    }
  }

  // Serialize back
  const serialized = render(doc, { xmlMode: true });
  zip.file("word/document.xml", serialized);

  // Resolve Word comments for successfully applied suggestions only
  const commentsResolved = await resolveWordComments(zip, appliedSuggestions);

  const buffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

  return {
    buffer,
    applied,
    rejected: rejectedDetails.length,
    rejectedDetails,
    commentsResolved,
  };
}

// ---------------------------------------------------------------------------
// resolveWordComments
// ---------------------------------------------------------------------------

const W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml";

/**
 * Read each Word comment's OWN last-paragraph `w14:paraId` from
 * `word/comments.xml`, keyed by comment id. This is the value OOXML
 * `CT_CommentEx/@paraId` references (OOXML §2.5.39) — the comment body's last
 * paragraph, NOT the document paragraph the comment is anchored to. Original
 * case is preserved so the written id matches both the comment's `<w:p>` and
 * any `commentEx` entry Word already wrote. See #1007.
 */
async function readCommentLastParaIds(zip: JSZip): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const xml = await zip.file("word/comments.xml")?.async("text");
  if (!xml) return map;
  const doc = parseDocument(xml, { xmlMode: true });
  for (const comment of findAllByName("w:comment", doc.children)) {
    const id = getAttr(comment, "w:id");
    if (!id) continue;
    // Shallow filter — only direct children of <w:comment>. `findAllByName` is
    // recursive and would include <w:p> elements nested inside embedded tables,
    // yielding the wrong last-paragraph paraId. CT_CommentEx @paraId references
    // the comment body's last TOP-LEVEL paragraph (OOXML §2.5.39).
    const paragraphs = comment.children.filter(isElement).filter((c) => c.name === "w:p");
    if (paragraphs.length === 0) continue;
    const lastParaId = getAttr(paragraphs[paragraphs.length - 1], "w14:paraId");
    if (lastParaId) map.set(id, lastParaId);
  }
  return map;
}

/**
 * Mark Word comments as "done" in commentsExtended.xml.
 *
 * For each applied suggestion that has an `importCommentId`, looks up the
 * comment's own last-paragraph `w14:paraId` (from `word/comments.xml`) and
 * marks the matching `<w15:commentEx>` entry `w15:done="1"` — updating an
 * existing entry in place, or creating one (and the part + relationship +
 * content-type) when `commentsExtended.xml` is absent.
 */
export async function resolveWordComments(
  zip: JSZip,
  appliedSuggestions: AcceptedSuggestion[],
): Promise<number> {
  const commentLastParaIds = await readCommentLastParaIds(zip);

  // Collect comment IDs to resolve
  const toResolve: Array<{ commentId: string; paraId: string }> = [];
  for (const s of appliedSuggestions) {
    if (!s.importCommentId) continue;
    const paraId = commentLastParaIds.get(s.importCommentId);
    if (!paraId) {
      console.warn(
        `[docx-apply] No comment-paragraph id for comment ${s.importCommentId}; skipping resolution`,
      );
      continue;
    }
    toResolve.push({ commentId: s.importCommentId, paraId });
  }

  if (toResolve.length === 0) return 0;

  // Deduplicate by commentId
  const seen = new Set<string>();
  const unique = toResolve.filter((r) => {
    if (seen.has(r.commentId)) return false;
    seen.add(r.commentId);
    return true;
  });

  const existingXml = await zip.file("word/commentsExtended.xml")?.async("text");

  if (existingXml) {
    // Parse and append
    const doc = parseDocument(existingXml, { xmlMode: true });
    const root = doc.children.find((c) => isElement(c) && c.name === "w15:commentsEx") as
      | Element
      | undefined;
    if (root) {
      // Index existing commentEx entries by lowercased paraId. paraIds are hex
      // (ST_LongHexNumber); compare case-insensitively, but keep/write the
      // original case. A comment Word already tracks here must be UPDATED to
      // done="1" in place, not duplicated.
      const existing = new Map<string, Element>();
      for (const child of root.children) {
        if (isElement(child) && child.name === "w15:commentEx") {
          const pid = getAttr(child, "w15:paraId");
          if (pid) existing.set(pid.toLowerCase(), child);
        }
      }

      for (const { paraId } of unique) {
        const found = existing.get(paraId.toLowerCase());
        if (found) {
          found.attribs["w15:done"] = "1";
        } else {
          const entry = new Element("w15:commentEx", {
            "w15:paraId": paraId,
            "w15:done": "1",
          });
          insertChild(root, root.children.length, entry);
        }
      }
      zip.file("word/commentsExtended.xml", render(doc, { xmlMode: true }));
    }
  } else {
    // Create new commentsExtended.xml
    const entries = unique
      .map((r) => `<w15:commentEx w15:paraId="${r.paraId}" w15:done="1"/>`)
      .join("");
    const newXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w15:commentsEx xmlns:w15="${W15_NS}">${entries}</w15:commentsEx>`;
    zip.file("word/commentsExtended.xml", newXml);

    // Add relationship in word/_rels/document.xml.rels
    const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("text");
    if (relsXml) {
      const relsDoc = parseDocument(relsXml, { xmlMode: true });
      const relsRoot = relsDoc.children.find((c) => isElement(c) && c.name === "Relationships") as
        | Element
        | undefined;
      if (relsRoot) {
        // Find a unique rId
        const existingIds = findAllByName("Relationship", relsRoot.children)
          .map((r) => getAttr(r, "Id") || "")
          .filter((id) => id.startsWith("rId"))
          .map((id) => parseInt(id.slice(3), 10))
          .filter((n) => !isNaN(n));
        const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 100;

        const rel = new Element("Relationship", {
          Id: `rId${nextId}`,
          Type: "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
          Target: "commentsExtended.xml",
        });
        insertChild(relsRoot, relsRoot.children.length, rel);
        zip.file("word/_rels/document.xml.rels", render(relsDoc, { xmlMode: true }));
      }
    }

    // Add content type
    const ctXml = await zip.file("[Content_Types].xml")?.async("text");
    if (ctXml) {
      const ctDoc = parseDocument(ctXml, { xmlMode: true });
      const typesRoot = ctDoc.children.find((c) => isElement(c) && c.name === "Types") as
        | Element
        | undefined;
      if (typesRoot) {
        const override = new Element("Override", {
          PartName: "/word/commentsExtended.xml",
          ContentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
        });
        insertChild(typesRoot, typesRoot.children.length, override);
        zip.file("[Content_Types].xml", render(ctDoc, { xmlMode: true }));
      }
    }
  }

  return unique.length;
}
