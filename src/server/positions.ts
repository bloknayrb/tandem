/**
 * Server-side position module.
 *
 * Consolidates all flat-offset, Y.Doc element resolution, RelativePosition,
 * and range validation logic into caller-optimized functions.
 *
 * High-level (use these):
 *   - validateRange()    — validate + stale-check a flat-offset range
 *   - anchoredRange()    — validate + create both flat and CRDT-anchored range
 *   - refreshRange()     — resolve relRange → flat offsets (or lazily attach)
 *   - refreshAllRanges() — batch version in a Y.Doc transaction
 *
 * Low-level (escape hatches):
 *   - resolveToElement()     — flat offset → Y.Doc element position
 *   - flatOffsetToRelPos()   — flat offset → serialized RelativePosition
 *   - relPosToFlatOffset()   — serialized RelativePosition → flat offset
 */

import * as Y from "yjs";
import { withMcp } from "../shared/origins.js";
import type {
  AnchoredRangeResult,
  DocumentRange,
  FlatOffset,
  FlatRangeValidation,
  RangeInvalidReason,
  RangeValidation,
  RefreshResult,
  RelativeRange,
  SerializedRelPos,
} from "../shared/positions/index.js";
import { toFlatOffset } from "../shared/positions/index.js";
import {
  anchorFlatRange,
  flatOffsetToRelPos,
  getElementTextLength,
  getHeadingPrefixLength,
  rangeOverlapsHeadingPrefix,
  resolveToElement,
} from "../shared/positions/ydoc.js";
import { snapshotContradicts } from "../shared/snapshot.js";
import type { Annotation } from "../shared/types.js";
import { collectXmlTexts, extractText, flatDocLength } from "./mcp/document-model.js";

// Moved to `src/shared/positions/ydoc.ts` — see that file's header for why the
// move is a leaf extraction rather than a file move. Re-exported so existing
// importers of `server/positions` keep working untouched.
export { anchorFlatRange, flatOffsetToRelPos, resolveToElement };

// ---------------------------------------------------------------------------
// Low-level: element resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Low-level: RelativePosition conversion
// ---------------------------------------------------------------------------

/**
 * Resolve a JSON-serialized Yjs RelativePosition back to a flat text offset.
 * Returns null if the referenced content was deleted.
 */
export function relPosToFlatOffset(doc: Y.Doc, relPosJson: SerializedRelPos): FlatOffset | null {
  let absPos;
  try {
    const rpos = Y.createRelativePositionFromJSON(relPosJson);
    absPos = Y.createAbsolutePositionFromRelativePosition(rpos, doc);
  } catch (err) {
    if (!(err instanceof TypeError) && !(err instanceof SyntaxError)) {
      console.error("[positions] relPosToFlatOffset: unexpected error resolving relRange:", err);
    }
    return null;
  }
  if (!absPos) return null;

  const fragment = doc.getXmlFragment("default");
  let accumulated = 0;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    const prefixLen = getHeadingPrefixLength(node);

    const xmlTexts = collectXmlTexts(node);
    for (const { xmlText, offsetFromStart } of xmlTexts) {
      if (xmlText === absPos.type) {
        return toFlatOffset(accumulated + prefixLen + offsetFromStart + absPos.index);
      }
    }

    accumulated += prefixLen + getElementTextLength(node);
    if (i < fragment.length - 1) {
      accumulated += 1;
    }
  }

  console.error(
    "[positions] relPosToFlatOffset: absPos resolved but no matching XmlText found in traversal",
  );
  return null;
}

// ---------------------------------------------------------------------------
// High-level: range validation
// ---------------------------------------------------------------------------

/** How `validateRange`/`validateFlatRange` treat an offset that splits a surrogate pair. */
export type SurrogatePolicy = "reject" | "ignore";

/** The opts that apply to the text-only checks, shared with `validateFlatRange`. */
export interface FlatRangeOpts {
  /** Permit `from === to`. Point comments (Word insertion markers) need it. */
  allowEmpty?: boolean;
  /**
   * `"ignore"` skips the surrogate check. For STORED/derived offsets only —
   * after a CRDT edit inside an emoji a refreshed range can legitimately end
   * mid-pair (Word's own offsets are UTF-16), and rejecting those would score a
   * real comment as lost. The new rule is for the caller-supplied tool
   * boundary. Default `"reject"`.
   */
  surrogates?: SurrogatePolicy;
}

/**
 * The five call sites that hoist an `extractText` across a loop.
 *
 * A closed union rather than `string`, because these tags key
 * `hoistMismatchCounts`, which is module-global and never cleared: a tag built
 * from a document id or an annotation id would grow it without bound. Adding an
 * arm is the moment to re-read `resolveDocText`'s scoped argument for why a
 * length comparison is a sufficient guard — it is a claim about what these five
 * callers write, not a general one.
 */
export type HoistTag =
  | "document/stamp-whole-doc"
  | "docx-capture/score"
  | "docx-comments/inject"
  | "watcher/relocation-anchor"
  | "watcher/relocation-probe";

/** Options shared by `validateRange` and `anchoredRange`. */
export interface RangeValidationOpts extends FlatRangeOpts {
  textSnapshot?: string;
  rejectHeadingOverlap?: boolean;
  /**
   * Also reject a range whose INTERIOR steps over a top-level heading prefix,
   * not just one whose endpoints land inside one (#1766).
   *
   * **A separate option, ORed into `rejectHeadingOverlap`'s verdict rather than
   * folded into it — and only `tandem_edit` passes it.** The flag has three
   * callers and only one of them rewrites text: `YDocStore.anchorRange`
   * (`tandem_comment` / `tandem_suggest`) and `local-model/tools.ts` create
   * annotations, and a comment spanning a section is legal. Widening the shared
   * flag would answer "target the text content only" to a multi-section comment,
   * which is not advice its author can follow.
   *
   * Union, not replacement, in the other direction too: the overlap predicate
   * alone would newly ACCEPT `to === blockStart` — the documented exclusive-end
   * asymmetry, which is what stops `tandem_edit` swallowing the newline above a
   * heading. That is a RELAXATION, and this change is a pure tightening, so the
   * endpoint term stays. `positions.test.ts`'s "keeps the exclusive-end
   * asymmetry" spec is the one that goes red for it; the local-model and
   * `tandem_comment` heading specs do NOT, because their fixtures cover the
   * prefix itself and answer the same under either rule.
   *
   * Inert without `rejectHeadingOverlap`, which is where the fragment resolves.
   */
  rejectHeadingInterior?: boolean;
  /**
   * **Must be `extractText(ydoc)` of THIS ydoc, as of this call.** Not a
   * same-shaped string, not the PRE-edit text of a document this caller has
   * since written to.
   *
   * Guarded by a flat-length comparison on every call — cheap (a tree walk, no
   * string build), and sufficient for the five callers that pass it because none
   * of them writes document text inside its loop. It is NOT a full content
   * check: read `resolveDocText` before adding a call site, because the argument
   * is scoped to what those callers do, not to the option.
   */
  text?: string;
  /**
   * Names the call site for the hoist-mismatch log, so a loop over hundreds of
   * annotations reports "the watcher's relocation pass, occurrence 100" rather
   * than hundreds of identical anonymous lines. Only meaningful with `text`.
   */
  textTag?: HoistTag;
  /**
   * Treat a `textSnapshot` that differs from the document only in WHICH Unicode
   * space separator it uses as a match (#1622). Default **off**.
   *
   * Opt-in, and only the two caller-supplied-snapshot sites opt in:
   * `tandem_edit`'s `validateRange` (`mcp/document.ts`) and
   * `YDocStore.anchorRange` (`mcp/document-store.ts`, i.e. `tandem_comment` /
   * `tandem_suggest`). A caller transcribing `tandem_getTextContent` output
   * cannot see a U+00A0, so its snapshot comes back with U+0020 and today's
   * exact comparison answers `RANGE_GONE` for text that is right there.
   *
   * **The two STORED-snapshot sites must stay exact** — `documents/watcher.ts`'s
   * relocation probe and relocation anchor. There the snapshot is the server's
   * own earlier slice, so an external U+00A0→U+0020 edit genuinely IS a document
   * change; normalizing would make the probe answer `ok` while
   * `snapshotContradicts` — still exact — refuses the editor accept and the
   * `.docx` apply, the #1631 divergence shape.
   *
   * Default off because that direction fails safely: a forgotten opt-in
   * reproduces today's visible `RANGE_GONE`, a forgotten opt-out would silently
   * accept a stale range.
   */
  normalizeSpaceClass?: boolean;
}

/**
 * Unicode `Zs` (space separator) MINUS U+0020, as a length-preserving 1:1 map
 * onto U+0020.
 *
 * **Length-preserving is the invariant**: one code unit in, one out, so every
 * offset computed against the normalized copy is valid against the original —
 * the same constraint `flattenHeadingText` documents. That is what lets the
 * normalized relocation sweep in `validateRange` hand back offsets that index
 * the real document.
 *
 * Deliberately EXCLUDED, and not to be widened:
 *  - `\t`, `\r`, `\n` — a newline is a block separator in this coordinate
 *    system, so collapsing it would let a range cross a block boundary; and tab
 *    is not a space separator in Unicode.
 *  - zero-width characters (U+200B, U+FEFF, …) — they are not spaces, and
 *    mapping one to U+0020 would make two visibly different strings compare
 *    equal.
 *
 * The `g` regex is module-level: `String.prototype.replace` resets `lastIndex`
 * on a global pattern before it runs, so there is no shared-state hazard.
 */
const SPACE_SEPARATORS_EXCEPT_U0020 = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/** See {@link SPACE_SEPARATORS_EXCEPT_U0020}. Exported because `mcp/navigation.ts` needs the
 * IDENTICAL set for `findOccurrence`/`countOccurrences`; a second copy is how the two drift. */
export function normalizeSpaceClass(s: string): string {
  return s.replace(SPACE_SEPARATORS_EXCEPT_U0020, " ");
}

/** Every start offset at which `needle` occurs in `haystack`, overlaps included. */
function collectOccurrences(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = haystack.indexOf(needle, searchFrom);
    if (idx === -1) break;
    hits.push(idx);
    searchFrom = idx + 1;
  }
  return hits;
}

function invalid(reason: RangeInvalidReason, message: string): FlatRangeValidation & { ok: false } {
  return { ok: false, code: "INVALID_RANGE", message, reason };
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Is this UTF-16 code unit the TRAILING half of a surrogate pair?
 *
 * Deliberately NOT exported. It was, for the .docx comment export resolver's
 * outward snap, and on its own it is the wrong question: it asks what is AT `i`
 * without asking what precedes it, so it fires on any lone low surrogate — one
 * at offset 0, or one following a non-high unit — where nothing is split and the
 * snap corrupts a valid offset (at offset 0 it produced -1). Every caller wants
 * {@link splitsSurrogatePair}, the paired form.
 */
function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Does offset `i` fall BETWEEN the two halves of a surrogate pair?
 *
 * The paired form is the whole point. A one-sided "the unit at `i` is any
 * surrogate" check passes every `"a<emoji>b"` case and then rejects offset 2 of
 * `"<emoji><emoji>"` — the legal boundary between two adjacent astral
 * characters, where the unit at `i` is a HIGH surrogate and nothing is split.
 * That offset has no alternative, so rejecting it is a dead end. At
 * `i === text.length` `charCodeAt` is NaN, which is neither half, so the
 * document end is always legal; and `i <= 0` returns false, so the document
 * start is too.
 */
export function splitsSurrogatePair(text: string, i: number): boolean {
  if (i <= 0) return false;
  return isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i));
}

/**
 * One-line description of a rejected range, for a log line.
 *
 * Every caller that logs a `validateRange`/`anchoredRange` failure used to print
 * `result.code` alone, which collapses all six `INVALID_RANGE` reasons — and the
 * `message` that names the actual offsets — into one indistinguishable string.
 * Whoever reads the log is trying to tell "the caller's arithmetic is wrong"
 * from "the document moved under it", and the code alone cannot say.
 */
export function describeRangeFailure(result: RangeValidation & { ok: false }): string {
  if (result.code === "INVALID_RANGE") {
    return `${result.code} (${result.reason}): ${result.message}`;
  }
  if (result.code === "RANGE_MOVED") {
    return `${result.code}: relocated to [${result.resolvedFrom}, ${result.resolvedTo}]`;
  }
  return result.code;
}

/**
 * The checks that need no document text: integrality, ordering, lower bound.
 *
 * Split out because `validateRange` must run these BEFORE the staleness gate
 * and the rest AFTER it. `String.prototype.slice` wraps a negative start
 * (`"hello world".slice(-3, 11) === "rld"`), so a negative `from` with a
 * coincidentally matching snapshot would pass staleness, and a non-matching one
 * would be answered with a relocation instead of `out-of-bounds`.
 */
function checkOffsetShape(from: number, to: number): (FlatRangeValidation & { ok: false }) | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return invalid(
      "non-integer",
      `Invalid range: from (${from}) and to (${to}) must both be integers.`,
    );
  }
  if (from > to) {
    return invalid("inverted", `Invalid range: from (${from}) must be <= to (${to}).`);
  }
  if (from < 0) {
    return invalid("out-of-bounds", `Invalid range: from (${from}) must be >= 0.`);
  }
  return null;
}

/** Upper bound, emptiness and surrogate safety, against the materialized text. */
function checkAgainstText(
  text: string,
  from: number,
  to: number,
  opts: FlatRangeOpts | undefined,
): (FlatRangeValidation & { ok: false }) | null {
  if (to > text.length) {
    return invalid(
      "out-of-bounds",
      `Invalid range: to (${to}) exceeds document length (${text.length}).`,
    );
  }
  if (from === to && !opts?.allowEmpty) {
    return invalid("empty", `Invalid range: [${from}, ${to}) is empty.`);
  }
  if ((opts?.surrogates ?? "reject") === "reject") {
    if (splitsSurrogatePair(text, from)) {
      return invalid("surrogate", `Invalid range: from (${from}) splits a surrogate pair.`);
    }
    if (splitsSurrogatePair(text, to)) {
      return invalid("surrogate", `Invalid range: to (${to}) splits a surrogate pair.`);
    }
  }
  return null;
}

/**
 * Validate a flat-offset range against a plain string — no Y.Doc needed.
 *
 * The pure core of {@link validateRange}, and the entry point for the two
 * callers that hold the flat text but deliberately no `Y.Doc`
 * (`tandem_getContext` through a `YDocStore`, and the `.docx` comment export
 * resolver, which resolves through `refreshRange`).
 *
 * Order: integer, ordering, lower bound, upper bound, emptiness, surrogate.
 *
 * The return type is {@link FlatRangeValidation}, NOT the wider
 * `RangeValidation`: with no Y.Doc there is no staleness gate and no heading
 * fragment, so the three other failure codes are structurally unreachable.
 * Saying that in the type is what lets a caller branch on `!ok` alone and still
 * reach `.reason` — see the type's own docstring for the dead conjunct this
 * replaced.
 */
export function validateFlatRange(
  text: string,
  from: number,
  to: number,
  opts?: FlatRangeOpts,
): FlatRangeValidation {
  const shape = checkOffsetShape(from, to);
  if (shape) return shape;
  const against = checkAgainstText(text, from, to, opts);
  if (against) return against;
  return { ok: true, range: { from: toFlatOffset(from), to: toFlatOffset(to) } };
}

/**
 * How many times each hoist-mismatch site has fired, so a 500-annotation loop
 * over a stale `opts.text` prints a handful of lines instead of 500 identical
 * ones. Keyed by the caller's own `textTag`; see {@link RangeValidationOpts}.
 *
 * Never cleared. That is deliberate: the throttle below logs on every power of
 * ten, so a tag that keeps misbehaving keeps reporting — with a running total
 * that a per-occurrence line could never give — rather than going quiet forever
 * the way a plain "log once" Set would.
 */
const hoistMismatchCounts = new Map<HoistTag, number>();

/**
 * Test-only. Clears the counter above so a throttle spec's expected log count
 * does not depend on which tags earlier specs in the run happened to touch —
 * the alternative was a prose comment claiming a literal is unused elsewhere,
 * which nothing enforces. Never called from production code.
 */
export function __testResetHoistMismatchCounts(): void {
  hoistMismatchCounts.clear();
}

/**
 * First occurrence, then the 10th, 100th, 1000th … Everything else is counted
 * only.
 *
 * **Only a TAGGED caller is throttled.** The throttle exists for a loop; an
 * untagged call is a one-off, and silencing one because some unrelated one-off
 * fired earlier would be the same "goes quiet forever" failure the Map's
 * docstring rejects.
 */
function reportHoistMismatch(tag: HoistTag | undefined, detail: string): void {
  const where = tag ?? "an untagged call site";
  let n = 1;
  if (tag !== undefined) {
    n = (hoistMismatchCounts.get(tag) ?? 0) + 1;
    hoistMismatchCounts.set(tag, n);
    if (!/^10*$/.test(String(n))) return;
  }
  console.error(
    `[positions] validateRange: hoisted text rejected at ${tag === undefined ? where : `'${where}' (occurrence ${n})`} — ` +
      `${detail} Recomputing from the Y.Doc.`,
  );
}

/**
 * The flat text for this call, honouring a hoisted `opts.text` when the document
 * still has the shape the caller hoisted against.
 *
 * **The guard is `flatDocLength(ydoc) === provided.length`, it runs always, and
 * it is NOT test-gated.** `flatDocLength` walks the tree reading `child.length`
 * and builds no string, so a matching hoist costs one walk and zero allocation.
 * That is the whole point of the option.
 *
 * **Why a length is enough HERE — a scoped claim, not a complete one.** Every
 * caller that passes `text` hoists it and then loops writing only
 * `Y_MAP_AUTHORSHIP` or `Y_MAP_ANNOTATIONS`, never the `default` fragment. So
 * the only staleness this guard can actually meet is a structural change to the
 * fragment, and a structural change moves the flat length. A same-length,
 * in-place TEXT edit landing mid-loop would slip past — this does not pretend
 * otherwise. It is simply not a shape any hoist caller produces, because none of
 * them writes document text at all. **A new `text:` call site that writes to the
 * fragment inside its own loop invalidates this argument, not merely this
 * guard** — and so does one that `await`s between hoisting and using the text.
 * The scope is both halves: no document-text write in the loop, AND the
 * `extractText` of THIS doc is hoisted immediately, with no `await` between the
 * hoist and the use. An async hoist caller satisfies the first half alone and
 * still lets another task mutate the fragment inside the window.
 *
 * Two earlier forms, recorded so neither comes back:
 *
 *  - Length check plus a `process.env.VITEST === "true"` content compare. That
 *    shipped the weak half: production compared lengths only, and no test could
 *    ever be red for the production behaviour, because under vitest the strong
 *    half repaired the string before it could change an outcome. A guard that
 *    exists only under tests is a test that self-heals.
 *  - An UNCONDITIONAL `extractText` content compare, which replaced it and is
 *    what this replaces. It was correct, and it inverted the option's whole
 *    purpose: a caller passing `text` then cost strictly MORE than one omitting
 *    it, because verifying the hoist rebuilt the full projection once per loop
 *    iteration.
 *
 * **Measured, because the size of the win is smaller than it looks and the next
 * reader should not re-derive an inflated one.** On a 1500-block / 125 KB
 * document, `stampClaudeAuthorshipWholeDoc` ran 17.0 s with the content compare
 * and 14.7 s with this guard (median of 5; the box was noisy, spread 11.6-24.4 s).
 * Per call on the same document the guard costs 5.49 ms against 5.66 ms — about
 * 3% per call, while the whole loop moved 13% — because BOTH are dominated by
 * the Y.js tree traversal rather than the string concatenation; what the guard removes is the 125 KB allocation per
 * iteration, not the walk. And the loop's real cost is neither: it is already
 * O(blocks²) in tree walks and always was, because `resolveToElement` and
 * `flatOffsetToRelPos` each walk the fragment block-by-block on every call. The
 * hoist is worth having; it is not what makes this loop expensive.
 *
 * Recovers by recomputing rather than throwing: this runs inside MCP tool
 * handlers, where a throw is a worse outcome than a slow correct answer.
 */
function resolveDocText(
  ydoc: Y.Doc,
  provided: string | undefined,
  tag: HoistTag | undefined,
): string {
  if (provided === undefined) return extractText(ydoc);
  const trueLength = flatDocLength(ydoc);
  if (provided.length === trueLength) return provided;
  reportHoistMismatch(
    tag,
    `hoisted length ${provided.length} != document length ${trueLength} — the document ` +
      "changed shape under the hoist.",
  );
  return extractText(ydoc);
}

/**
 * Validate a flat-offset range against a Y.Doc.
 *
 * Order (#1752), and the order is the contract:
 *   integer → ordering → lower bound → **staleness** → upper bound → empty →
 *   surrogate → heading overlap.
 *
 * Two placements are load-bearing rather than arbitrary:
 *
 *  - **Lower bound BEFORE staleness**, because `slice` wraps a negative start.
 *  - **Upper bound AFTER staleness.** After an external edit shortens the file,
 *    the watcher's relocation probe passes stale offsets past the new end WITH
 *    a snapshot and relies on `RANGE_MOVED`. Bounds-first would answer
 *    `INVALID_RANGE` and pin the annotation to dead offsets — silent annotation
 *    loss. Same for `tandem_edit`'s documented retry path. So with a mismatched
 *    `textSnapshot`, a staleness outcome WINS over `out-of-bounds`, and the
 *    surrogate check applies only to a range about to be returned `ok`;
 *    relocated coordinates are re-checked on the caller's retry.
 *
 * Two accidents are pinned by tests rather than redesigned: the staleness gate
 * is truthiness-checked, so an empty `textSnapshot` skips it (do not change to
 * `!== undefined`); and with a snapshot `from === to` never reaches `"empty"`,
 * because the slice is `""` and staleness fires first.
 *
 * `opts.normalizeSpaceClass` (#1622) changes the COMPARISON inside the staleness
 * step and nothing about this order. See the option's own doc for who opts in
 * and why the default is off.
 *
 * **`empty` also wins over the heading check** for a caller without
 * `allowEmpty`: an empty range inside a heading prefix answers `empty`, not
 * `HEADING_OVERLAP`, because emptiness is checked with the other text-side
 * rules and the heading fragment walk comes last. Pass `allowEmpty` — as
 * `tandem_edit` does — and the same range answers `HEADING_OVERLAP`.
 */
export function validateRange(
  ydoc: Y.Doc,
  from: FlatOffset,
  to: FlatOffset,
  opts?: RangeValidationOpts,
): RangeValidation {
  const rejectHeadingOverlap = opts?.rejectHeadingOverlap ?? false;

  const shape = checkOffsetShape(from, to);
  if (shape) return shape;

  // ONE materialization, shared by staleness, bounds and the surrogate check.
  // Previously computed only when a snapshot was given; making it unconditional
  // adds a full-document walk to every `anchoredRange` caller (~3.5 ms at
  // 460 KB). Accepted. `opts.text` is what a loop uses to avoid paying it per
  // iteration, and its guard costs a tree walk, not a string build — see
  // `resolveDocText`.
  const fullText = resolveDocText(ydoc, opts?.text, opts?.textTag);

  // Staleness check
  //
  // Five steps, in this order (#1622); steps 2 and 4 run only under
  // `normalizeSpaceClass`, steps 1/3/5 are unconditional and unchanged:
  //   1. exact slice comparison — the fast path;
  //   2. normalized-equal AT THESE OFFSETS ⇒ a match, not a relocation. A
  //      whitespace-class difference is a TRANSCRIPTION difference, not evidence
  //      the document moved, and answering RANGE_MOVED here would name the very
  //      offsets the caller just passed — the infinite retry that made the
  //      issue's own `whitespaceMismatch` proposal unworkable;
  //   3. exact `indexOf` sweep — still PREFERRED, so a document holding both an
  //      exact and a normalized-only occurrence relocates to the exact one;
  //   4. only when the exact sweep is empty, the same sweep over the normalized
  //      document with the normalized snapshot. Valid on the original because
  //      the normalization is 1:1 and length-preserving;
  //   5. RANGE_GONE only when that is empty too — so the error means what it says.
  //
  // The normalized full text is built LAZILY, inside step 4 and nowhere else:
  // step 2 normalizes a slice, not the document, and `validateRange` runs once
  // per annotation inside the watcher's relocation loop, which hoists its
  // `extractText` precisely so a per-annotation full-document cost does not come
  // back (#1752). A cached normalized twin on `RangeValidationOpts.text` is not
  // the answer either — the hoist's guard is a flat-length comparison and a
  // second cached string would need its own.
  if (opts?.textSnapshot) {
    const normalizing = opts.normalizeSpaceClass === true;
    const slice = fullText.slice(from, to);
    const exactHit = slice === opts.textSnapshot;
    const normalizedHit =
      !exactHit &&
      normalizing &&
      normalizeSpaceClass(slice) === normalizeSpaceClass(opts.textSnapshot);
    if (!exactHit && !normalizedHit) {
      let candidates = collectOccurrences(fullText, opts.textSnapshot);
      if (candidates.length === 0 && normalizing) {
        candidates = collectOccurrences(
          normalizeSpaceClass(fullText),
          normalizeSpaceClass(opts.textSnapshot),
        );
      }
      if (candidates.length === 0) {
        return { ok: false, code: "RANGE_GONE" };
      }
      const best = candidates.reduce((a, b) => (Math.abs(a - from) <= Math.abs(b - from) ? a : b));
      return {
        ok: false,
        code: "RANGE_MOVED",
        resolvedFrom: toFlatOffset(best),
        resolvedTo: toFlatOffset(best + opts.textSnapshot.length),
      };
    }
  }

  const against = checkAgainstText(fullText, from, to, opts);
  if (against) return against;

  // Heading overlap check
  if (rejectHeadingOverlap) {
    const fragment = ydoc.getXmlFragment("default");
    const startPos = resolveToElement(fragment, from);
    const endPos = resolveToElement(fragment, to);
    if (!startPos || !endPos) {
      return invalid("unresolvable", `Cannot resolve offset range [${from}, ${to}] in document.`);
    }
    // Two terms, ORed. The endpoint term is the rule for all three callers and
    // is unchanged — in particular a `to` equal to the FIRST character of a
    // heading prefix is still refused even though the end is exclusive, because
    // `resolveToElement(to)` lands at offset 0 of the heading and reports
    // `clampedFromPrefix`. That asymmetry is deliberate (it is what stops
    // `tandem_edit` swallowing the newline above a heading) and is documented in
    // `docs/architecture.md` rather than removed. The interior term is
    // `tandem_edit`'s alone — see `rejectHeadingInterior`.
    if (
      startPos.clampedFromPrefix ||
      endPos.clampedFromPrefix ||
      (opts?.rejectHeadingInterior === true && rangeOverlapsHeadingPrefix(fragment, from, to))
    ) {
      return { ok: false, code: "HEADING_OVERLAP" };
    }
  }

  return { ok: true, range: { from, to } };
}

// ---------------------------------------------------------------------------
// High-level: anchored range creation
// ---------------------------------------------------------------------------

/**
 * Validate a range and create both flat and CRDT-anchored positions in one call.
 * Pass `opts.rejectHeadingOverlap: true` to also reject ranges that overlap
 * heading prefixes (same guard used by `tandem_edit`).
 *
 * Sole assembler of `RelativeRange` at annotation birth — `refreshRange`'s
 * lazy-attach and dead-relRange repair branches are the only other sites that
 * assemble the `{fromRel, toRel}` shape, and both live in this file. Wire-shape
 * changes to `SerializedRelPos` require updating `SerializedRelPosSchema`,
 * both readers, and any on-disk JSON predating the change.
 */
export function anchoredRange(
  ydoc: Y.Doc,
  from: FlatOffset,
  to: FlatOffset,
  textSnapshot?: string,
  opts?: Omit<RangeValidationOpts, "textSnapshot">,
): AnchoredRangeResult | (RangeValidation & { ok: false }) {
  const validation = validateRange(ydoc, from, to, { ...opts, textSnapshot });
  if (!validation.ok) return validation;

  const range: DocumentRange = { from, to };

  // Create CRDT-anchored positions
  const fromRel = flatOffsetToRelPos(ydoc, from, 0); // assoc 0: stick right
  const toRel = flatOffsetToRelPos(ydoc, to, -1); // assoc -1: stick left
  const relRange: RelativeRange | undefined = fromRel && toRel ? { fromRel, toRel } : undefined;

  if (!relRange) {
    const fragment = ydoc.getXmlFragment("default");
    const fromEl = resolveToElement(fragment, from);
    const toEl = resolveToElement(fragment, to);
    if (fromEl && !fromEl.clampedFromPrefix && toEl && !toEl.clampedFromPrefix) {
      console.error(`[positions] anchoredRange: relRange creation failed for [${from}, ${to}]`);
    }
  }

  if (relRange) {
    return { ok: true, fullyAnchored: true, range, relRange };
  }
  return { ok: true, fullyAnchored: false, range };
}

// ---------------------------------------------------------------------------
// Pure: flat-range arithmetic across a text replacement
// ---------------------------------------------------------------------------

/**
 * Where does `range` land after `[from, to)` is replaced by `newLength` units?
 * (#1765)
 *
 * A `tandem_edit` that crosses a top-level block boundary merges the tail block
 * into the start block and then DELETES the emptied original. Yjs cannot move
 * items, so every RelativePosition anchored in that element dies the instant
 * the delete lands — including annotations entirely AFTER the edited range,
 * which the edit did not touch at all. For those the post-edit offsets are
 * exact arithmetic rather than a guess, and this is the arithmetic.
 *
 * Half-open on both sides, and both boundaries are load-bearing: a range ending
 * exactly at `from` is untouched (identity), a range starting exactly at `to`
 * shifts by the delta.
 *
 * **`null` when the range INTERSECTS the replacement, and refusing is the
 * point.** A partially overwritten annotation has no correct destination;
 * clamping both ends to `from` would invent one. The caller leaves such a
 * record alone, where #1764 reports it as `degraded` — honest, and recoverable.
 *
 * The arithmetic holds even when the edit absorbs a heading, because every
 * character the branch removes outside `newText` lies INSIDE `[from, to)`: an
 * absorbed heading's prefix starts at that element's block start, which is
 * strictly between `from` and `to` (a `to` inside a prefix is already refused
 * upstream), and the block separators that disappear are exactly the ones the
 * span crosses.
 */
export function remapRangeAcrossReplacement(
  range: DocumentRange,
  from: FlatOffset,
  to: FlatOffset,
  newLength: number,
): DocumentRange | null {
  if (range.to <= from) return range;
  if (range.from >= to) {
    const delta = newLength - (to - from);
    return { from: toFlatOffset(range.from + delta), to: toFlatOffset(range.to + delta) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// High-level: annotation range refresh
// ---------------------------------------------------------------------------

/**
 * Does the annotation's STORED flat range still hold the text its snapshot
 * captured? (#1764)
 *
 * The one predicate behind all three arms of `refreshRange` that would
 * otherwise mint or overwrite an anchor from an unverified stored range. Reuses
 * `snapshotContradicts` rather than re-stating its rule: that function already
 * distinguishes an ABSENT snapshot (nothing to contradict) from an empty one (a
 * real claim that the range held no text) from a non-string one (fails toward
 * contradiction), and already prefix-matches a truncated snapshot. A second
 * inline copy of any of that is how the two would drift.
 *
 * `ann.textSnapshot === undefined` is the ONLY carve-out, and it belongs to the
 * two mint arms alone — a record carrying no snapshot has nothing to verify
 * against, and refusing would strand every pre-snapshot record permanently. The
 * collapse arm deliberately requires a snapshot instead: see its own comment.
 *
 * An out-of-bounds stored range slices to `""` and therefore contradicts, which
 * is the clamp #1765's body asks for.
 */
function storedRangeStillMatches(ann: Annotation, text: string): boolean {
  return (
    ann.textSnapshot === undefined ||
    !snapshotContradicts(ann, text.slice(ann.range.from, ann.range.to))
  );
}

/**
 * A `getText` that materializes the flat projection at most once, and not at
 * all when nothing asks for it.
 *
 * `refreshRange` needs the document text only on the guard arms, which most
 * annotations never reach; `refreshAllRanges` builds ONE of these and passes it
 * to every iteration, so a whole batch pays for at most one `extractText`. Safe
 * across a batch because the only writes in that loop are annotation records —
 * the `default` fragment is untouched.
 */
function memoizedDocText(ydoc: Y.Doc): () => string {
  let cached: string | undefined;
  return () => {
    if (cached === undefined) cached = extractText(ydoc);
    return cached;
  };
}

/**
 * Refresh an annotation's flat offsets from its relRange, or lazily attach
 * relRange if missing. Returns a tagged `RefreshResult` (ADR-032) so
 * callers can distinguish healthy / updated / attached / repaired /
 * degraded / failed paths instead of treating every outcome as success.
 * If `map` is provided, persists changes back to the Y.Map.
 *
 * The lazy-attach and dead-relRange repair branches below are the two
 * intentional `{fromRel, toRel}` re-assembly sites referenced by
 * `anchoredRange`'s JSDoc — both repair existing annotations rather than
 * minting new ones, so the shape duplication is deliberate, not a DRY gap.
 * **Both are gated on {@link storedRangeStillMatches} (#1764)**: this runs from
 * a READ path (`listAnnotationsRefreshed`), and minting a confident anchor over
 * a stored range whose snapshot no longer holds pins the record to the wrong
 * text with nothing warning.
 *
 * `getText` is internal plumbing, not a public option — omit it and each call
 * memoizes its own. `refreshAllRanges` passes one shared getter.
 */
export function refreshRange(
  ann: Annotation,
  ydoc: Y.Doc,
  map?: Y.Map<unknown>,
  getText?: () => string,
): RefreshResult {
  const docText = getText ?? memoizedDocText(ydoc);

  if (!ann.relRange) {
    // Lazy attachment: compute relRange from current flat offsets. Same
    // unverified mint as the dead-relRange arm below, so it takes the same
    // gate — fixing only that arm is defeated one call later (#1764).
    if (!storedRangeStillMatches(ann, docText())) return { kind: "degraded", annotation: ann };
    const fromRel = flatOffsetToRelPos(ydoc, ann.range.from, 0);
    const toRel = flatOffsetToRelPos(ydoc, ann.range.to, -1);
    if (!fromRel || !toRel) return { kind: "degraded", annotation: ann };
    const updated = { ...ann, relRange: { fromRel, toRel } };
    if (map) map.set(ann.id, updated);
    return { kind: "attached", annotation: updated };
  }

  // Resolve relRange to current flat offsets
  const newFrom = relPosToFlatOffset(ydoc, ann.relRange.fromRel);
  const newTo = relPosToFlatOffset(ydoc, ann.relRange.toRel);
  if (newFrom === null || newTo === null) {
    if (newFrom !== null || newTo !== null) {
      console.error(
        `[positions] refreshRange: partial CRDT resolution for ${ann.id} ` +
          `(from: ${newFrom !== null ? "ok" : "dead"}, to: ${newTo !== null ? "ok" : "dead"})`,
      );
    }
    // CRDT resolution failed (items deleted after content replacement).
    // Strip the dead relRange and attempt re-anchoring from flat offsets —
    // but only when the stored range still holds its snapshot (#1764). If the
    // text moved while the relRange died, re-anchoring here would mint a fresh,
    // confident anchor over the wrong span and nothing would warn.
    if (storedRangeStillMatches(ann, docText())) {
      const fromRel = flatOffsetToRelPos(ydoc, ann.range.from, 0);
      const toRel = flatOffsetToRelPos(ydoc, ann.range.to, -1);
      if (fromRel && toRel) {
        const updated: Annotation = { ...ann, relRange: { fromRel, toRel } };
        if (map) map.set(ann.id, updated);
        return { kind: "repaired", annotation: updated };
      }
    }
    // Can't re-anchor — strip dead relRange so lazy path works next time
    const stripped: Annotation = { ...ann };
    delete stripped.relRange;
    if (map) map.set(ann.id, stripped);
    return { kind: "degraded", annotation: stripped };
  }
  if (newFrom > newTo) {
    console.error(
      `[positions] refreshRange: inverted CRDT range for annotation ${ann.id}: ` +
        `resolved [${newFrom}, ${newTo}] from flat [${ann.range.from}, ${ann.range.to}]`,
    );
    return { kind: "failed", annotation: ann };
  }
  // A COLLAPSE has two causes needing opposite answers (#1764). A block split,
  // heading toggle or join resolves two live anchors onto one offset while the
  // annotated text is still there — persisting `{n, n}` destroys the stored
  // flat range the watcher's snapshot relocation needs, and undo then resolves
  // the two zero-width anchors to opposite ends and the record is `failed`
  // forever. Deleting the annotated span produces the same shape and there
  // `{n, n}` is correct. The discriminator is the stored `textSnapshot`.
  //
  // **This arm does NOT inherit the mint arms' `undefined` carve-out**, and the
  // asymmetry is load-bearing: `docx-comments.ts` strips `textSnapshot` off
  // every imported Word comment on the drift path, and `docx-comment-export.ts`
  // writes `refreshed.annotation.range` back into the user's `.docx`. Preserving
  // a stale non-empty span for one of those would export a Word comment over
  // unrelated text — a byte change in the user's file. With a snapshot
  // required, a snapshot-less collapse keeps writing `{n, n}`.
  if (
    newFrom === newTo &&
    ann.range.from !== ann.range.to &&
    ann.textSnapshot !== undefined &&
    storedRangeStillMatches(ann, docText())
  ) {
    return { kind: "degraded", annotation: ann };
  }
  if (newFrom === ann.range.from && newTo === ann.range.to) {
    return { kind: "ok", annotation: ann };
  }

  const updated = { ...ann, range: { from: newFrom, to: newTo } };
  if (map) map.set(ann.id, updated);
  return { kind: "updated", annotation: updated };
}

/**
 * Refresh all annotations in a batch, wrapping Y.Map writes in a transaction.
 *
 * When `skipTransact` is true, writes happen inline without wrapping a
 * `ydoc.transact`. The caller is responsible for providing an outer
 * transaction with the appropriate origin. Used by `reloadFromDisk` to merge
 * this pass with the subsequent textSnapshot relocation pass into a single
 * `MCP_ORIGIN` transaction (closes the two-write crash window — GH #622).
 */
export function refreshAllRanges(
  annotations: Annotation[],
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
  opts?: { skipTransact?: boolean },
): RefreshResult[] {
  const results: RefreshResult[] = [];
  // ONE memoized getter for the whole batch: the flat text is materialized at
  // most once per call, and not at all when no annotation reaches a guard arm
  // (#1764). Sound because this loop writes only annotation records.
  const getText = memoizedDocText(ydoc);
  const run = () => {
    for (const ann of annotations) {
      results.push(refreshRange(ann, ydoc, map, getText));
    }
  };
  if (opts?.skipTransact) {
    run();
  } else {
    withMcp(ydoc, run);
  }

  // PR #705 review observability: surface CRDT corruption (`failed` kind —
  // inverted CRDT range) at the aggregator boundary. The individual
  // refreshRange already logs via console.error; this lifts a count + IDs
  // above the per-annotation noise so a batched reload makes the corruption
  // visible without log-scraping.
  const failed = results.filter((r) => r.kind === "failed");
  if (failed.length > 0) {
    console.warn(
      `[positions] refreshAllRanges: ${failed.length} annotation(s) failed CRDT refresh: ${failed
        .map((r) => r.annotation.id)
        .join(", ")}`,
    );
  }

  return results;
}

/**
 * Exhaustive-match helper. Use in `switch (result.kind)` defaults so future
 * additions to the `RefreshResult` discriminator produce a compile error
 * at every call site that should branch on the new kind.
 */
export function assertNeverRefreshResult(value: never): never {
  throw new Error(`Unexpected RefreshResult kind: ${JSON.stringify(value)}`);
}
