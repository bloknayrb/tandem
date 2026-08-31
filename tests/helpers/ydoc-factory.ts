import * as Y from "yjs";
import { type MintExtras, mintAnnotation } from "../../src/server/annotations/lifecycle.js";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { anchoredRange } from "../../src/server/positions.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { type AnchoredRangeResult, toFlatOffset } from "../../src/shared/positions/types.js";
import type { OnLossy } from "../../src/shared/sanitize.js";
import type { Annotation, AnnotationType } from "../../src/shared/types.js";

/** Create a Y.Doc populated with text content */
export function makeDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  populateYDoc(doc, text);
  return doc;
}

/** Create an empty Y.Doc (XmlFragment exists but has no elements) */
export function makeEmptyDoc(): Y.Doc {
  return new Y.Doc();
}

/** Shortcut to get the 'default' XmlFragment */
export function getFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment("default");
}

/** Create a Y.Doc populated via markdown parser (remark) */
export function makeMarkdownDoc(md: string): Y.Doc {
  const doc = new Y.Doc();
  loadMarkdown(doc, md);
  return doc;
}

/** Shortcut to get the 'annotations' Y.Map */
export function getAnnotationsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(Y_MAP_ANNOTATIONS);
}

/** Create a test annotation with sensible defaults and optional overrides. */
export function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  // `Annotation` is a discriminated union on `type`, and `Partial<Annotation>`
  // makes `type` itself optional. Spreading an optional `type?: "highlight" |
  // "comment" | "note"` over the required one widens the discriminant back to
  // the full union, so the object literal no longer narrows to any single
  // member -- even though every caller passes a coherent combination. The cast
  // asserts that coherence. Same shape as `makeImportNote` below.
  return {
    id: "ann_test_001",
    author: "claude",
    type: "comment",
    range: { from: toFlatOffset(0), to: toFlatOffset(5) },
    content: "test",
    status: "pending",
    timestamp: Date.now(),
    ...overrides,
  } as Annotation;
}

/**
 * Create an imported Word-comment annotation in its post-import shape:
 * `author: "import"`, `type: "note"`, `audience: "private"` (the AR5 source
 * shape that the promote path converts to an outbound comment). Overrides are
 * loosely typed so tests can seed deliberately-malformed inputs (e.g. a stray
 * `color`/`suggestedText` to assert the promote transform strips them).
 */
export function makeImportNote(overrides: Record<string, unknown> = {}): Annotation {
  return {
    id: "imp_test",
    type: "note",
    author: "import",
    audience: "private",
    range: { from: toFlatOffset(0), to: toFlatOffset(5) },
    content: "reviewer comment",
    status: "pending",
    timestamp: 1000,
    rev: 1,
    importSource: { author: "Reviewer A", file: "review.docx" },
    ...overrides,
  } as Annotation;
}

/**
 * Create an anchored range (flat + CRDT) for annotation creation in tests.
 *
 * **The return type is annotated, not inferred, and `ydoc` is required — both
 * on purpose.** This helper used to take an optional `ydoc` and fall back to a
 * bare `{ range }`, which widened its inferred return type to a union of that
 * shape and `AnchoredRangeResult`. Passing the result to anything expecting an
 * `AnchoredRangeResult` therefore did not type-check. The first pass at this
 * unit answered that by writing the *same* `anchoredRangeOf` wrapper into
 * EIGHT test files, each casting the union back down -- so the duplication was
 * this branch's own, introduced at `210085c` and deleted at `f191f58`, not
 * pre-existing debt (`anchoredRangeOf` appears nowhere on master). Narrowing
 * here is what removed the need for all eight. The
 * no-ydoc branch had no remaining callers — `unanchored()` in
 * `tests/helpers/positions.ts` is the fixture for a range with no CRDT anchor.
 */
export function rangeOf(from: number, to: number, ydoc: Y.Doc): AnchoredRangeResult {
  const result = anchoredRange(ydoc, toFlatOffset(from), toFlatOffset(to));
  if (!result.ok) throw new Error("anchoredRange failed in test helper");
  return result;
}

/**
 * Write a RAW annotation record straight into the map, bypassing the mint path.
 *
 * The point is to store a shape production never produces — a legacy `flag` or
 * `question`, an explicit `audience: "outbound"` on a user note — so a spec can
 * exercise the sanitize-then-guard ordering that only such a record reaches.
 * `makeAnnotation` above is the opposite tool: it builds a WELL-FORMED record.
 *
 * Deliberately untyped in `extra`: a `Partial<Annotation>` would reject exactly
 * the legacy shapes this exists to write.
 */
export function seedRawAnnotation(
  map: Y.Map<unknown>,
  doc: Y.Doc,
  id: string,
  extra: Record<string, unknown>,
): void {
  map.set(id, {
    id,
    type: "comment",
    author: "user",
    audience: "private",
    status: "pending",
    range: rangeOf(0, 5, doc).range,
    content: "legacy",
    timestamp: Date.now(),
    rev: 1,
    ...extra,
  });
}

/**
 * Mint an annotation of ANY type through the real production path, and return
 * its id.
 *
 * The third member of this file's write family, and the only one that goes
 * through production code: `makeAnnotation` builds a well-formed record without
 * writing it, `seedRawAnnotation` writes a deliberately malformed one straight
 * into the map, and this one calls `mintAnnotation` — so the record, its `rev`,
 * and its `withMcp` origin tag are whatever production produces.
 *
 * **Why it lives in `tests/` (ADR-035 Unit 8j-1).** Until this unit it was
 * `mcp/annotations.ts::createAnnotation`, a *production* export accepting `note`
 * and `highlight` — which `AnnotationLifecycle.create`, the seam every
 * production caller now holds, deliberately refuses. It had no production
 * caller; the only thing standing between it and acquiring one was a census
 * assertion. Here, a `src/` importer is a visible boundary violation that would
 * bundle test code into `dist/`, and `annotation-create-seam-census.test.ts`
 * fails on one.
 *
 * The body is copied verbatim from that export rather than rewritten, including
 * its `(map, ydoc, …)` argument order — which is inverted relative to
 * `mintAnnotation`'s `(ydoc, map, …)`. Correcting the order would mean touching
 * all 159 call sites, which is the cost this relocation exists to avoid: the
 * fixtures stay byte-identical, so the parity floor cannot shift under the move.
 *
 * `mintAnnotation` itself cannot follow it here for the plainest possible
 * reason: production calls it. `createAnnotationLifecycle` mints through it, so
 * it is on the hot path, not a compatibility leftover. (It also performs the
 * real origin-tagged write and fires the review notification — true, but
 * secondary, and an earlier draft of this docblock led with it and thereby
 * implied the function had no production caller.)
 */
export function createAnnotation(
  map: Y.Map<unknown>,
  ydoc: Y.Doc,
  type: AnnotationType,
  anchored: AnchoredRangeResult,
  content: string,
  extras?: MintExtras,
): string {
  return mintAnnotation(ydoc, map, type, anchored, content, extras).id;
}

/**
 * A sink that discards migration events.
 *
 * Named rather than written inline at each call so a reader can tell "this spec
 * does not care about the relay" from "this spec forgot" — the distinction the
 * required-not-defaulted `onLossy` parameter exists to make visible in the
 * first place. Specs that DO care pass their own sink.
 */
export const noRelay: OnLossy = () => {};

/**
 * Drop the two fields that legitimately differ between any two annotations
 * minted a moment apart, so two records can be compared whole.
 *
 * Whole-record comparison rather than a field list on purpose: a list silently
 * stops covering whatever field is added next.
 */
export function normalizeForParity(a: Annotation): Annotation {
  return { ...a, id: "", timestamp: 0 } as Annotation;
}
