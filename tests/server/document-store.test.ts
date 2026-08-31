/**
 * Parity contract for `YDocStore` (issue #315).
 *
 * The store seam was extracted as a PURE INTERNAL REFACTOR: every method must
 * produce the same Y.Map structures and outputs the pre-refactor MCP handlers
 * produced when they touched `Y.Map` directly. The existing MCP / annotation
 * suites are the behavioral parity floor; this file is the contract test for
 * the seam itself — it pins the store's outputs against the standalone helpers
 * (`collectAnnotations`, `addUserReply`, `removeAnnotationRecord`) and the
 * lifecycle module the handlers used before, and asserts the Y.Map state
 * matches byte-for-byte.
 *
 * **`YDocStore` is the only type now** — the `DocumentStore` interface went in
 * ADR-035 Unit 8j; why is on the class, not restated here. Two specs went with
 * it: the `createAnnotation` parity pair, whose subject was a store method with
 * no production callers, and a `getAnnotation` spec named "returns the
 * sanitized record" that asserted only `.content` on a record it had just
 * minted through the canonical path. Neither loss is coverage —
 * `annotation-create-lifecycle.test.ts` pins creation's record shape field-for-
 * field and asserts `toStrictEqual([MCP_ORIGIN])`, i.e. exactly one tagged
 * transaction, where the deleted spec captured only the last origin it saw.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  acceptPending,
  dismissPending,
  type MintExtras,
  removeAnnotationRecord,
} from "../../src/server/annotations/lifecycle.js";
import {
  collectAnnotations,
  collectRepliesForAnnotation,
} from "../../src/server/mcp/annotations.js";
import { getDocumentStore, YDocStore } from "../../src/server/mcp/document-store.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { MCP_ORIGIN } from "../../src/shared/origins.js";
import type { AnchoredRangeResult } from "../../src/shared/positions/index.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation, AnnotationType } from "../../src/shared/types.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import {
  createAnnotation,
  getAnnotationsMap,
  noRelay,
  normalizeForParity,
  rangeOf,
} from "../helpers/ydoc-factory.js";

beforeEach(() => {
  clearOpenDocs();
});

/**
 * Stand-in for the deleted `YDocStore.createAnnotation` (ADR-035 Unit 8j).
 *
 * The store method's whole body was `createAnnotation(this.map, this.ydoc, …)`,
 * and `this.map` is the annotations Y.Map — so this writes the same record
 * through the same function into the same map. The specs below are
 * setup-equivalent, not weakened: they needed an annotation to exist, not that
 * method in particular. The two specs that DID pin the method itself are
 * deleted rather than ported, because their subject no longer exists.
 *
 * Local rather than shared: `document-store.test.ts` is the only file that ever
 * called `store.createAnnotation(…)`, so no other suite wants this shape.
 */
function mint(
  ydoc: Y.Doc,
  type: AnnotationType,
  anchored: AnchoredRangeResult,
  content: string,
  extras?: MintExtras,
): string {
  return createAnnotation(getAnnotationsMap(ydoc), ydoc, type, anchored, content, extras);
}

const FILE_PATH = "/tmp/doc.md";

describe("YDocStore.listAnnotations parity", () => {
  it("matches collectAnnotations output", () => {
    const ydoc = setupDoc("list-1", "Hello world content");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH, "list-1");

    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "one");
    createAnnotation(map, ydoc, "highlight", rangeOf(6, 11, ydoc), "", { color: "yellow" });
    createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "private");

    expect(store.listAnnotations()).toEqual(collectAnnotations(map, store.docHash));
    expect(store.listAnnotations()).toHaveLength(3);
  });
});

describe("YDocStore.editAnnotation parity (handler guard order)", () => {
  it("updates content + suggestedText and bumps rev/editedAt", () => {
    const ydoc = setupDoc("edit-ok", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH, "edit-ok");
    const id = mint(ydoc, "comment", rangeOf(0, 5, ydoc), "old");
    const before = ydoc.getMap(Y_MAP_ANNOTATIONS).get(id) as Annotation;

    const result = store.editAnnotation(id, { content: "new", suggestedText: "Hi" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.annotation.content).toBe("new");
    expect(result.annotation.suggestedText).toBe("Hi");
    expect(result.annotation.editedAt).toBeGreaterThan(0);
    expect(result.annotation.rev).toBeGreaterThan(before.rev ?? 0);

    const stored = ydoc.getMap(Y_MAP_ANNOTATIONS).get(id) as Annotation;
    expect(stored.content).toBe("new");
  });

  it("returns not-found for an absent ID", () => {
    const ydoc = setupDoc("edit-nf", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH, "edit-nf");
    expect(store.editAnnotation("nope", { content: "x" })).toEqual({ kind: "not-found" });
  });

  it("rejects editing a note (ADR-027) before any other guard", () => {
    const ydoc = setupDoc("edit-note", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH, "edit-note");
    const id = mint(ydoc, "note", rangeOf(0, 5, ydoc), "private");
    // Even with an empty patch, the note guard wins (it precedes empty-patch).
    expect(store.editAnnotation(id, {})).toEqual({ kind: "invalid-note" });
  });

  it("returns not-pending for an accepted annotation", () => {
    const ydoc = setupDoc("edit-np", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH, "edit-np");
    const id = mint(ydoc, "comment", rangeOf(0, 5, ydoc), "x");
    acceptPending(id, ydoc, map, noRelay);
    expect(store.editAnnotation(id, { content: "y" })).toEqual({
      kind: "not-pending",
      currentStatus: "accepted",
    });
  });

  it("returns empty-patch when no fields are supplied (pending comment)", () => {
    const ydoc = setupDoc("edit-empty", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH, "edit-empty");
    const id = mint(ydoc, "comment", rangeOf(0, 5, ydoc), "x");
    expect(store.editAnnotation(id, {})).toEqual({ kind: "empty-patch" });
  });

  it("rejects suggestedText on a non-comment after the empty-patch guard", () => {
    const ydoc = setupDoc("edit-sugg", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH, "edit-sugg");
    const id = mint(ydoc, "highlight", rangeOf(0, 5, ydoc), "", {
      color: "yellow",
    });
    expect(store.editAnnotation(id, { suggestedText: "Hi" })).toEqual({
      kind: "invalid-suggestion-target",
      annotationType: "highlight",
    });
  });
});

describe("YDocStore lifecycle parity", () => {
  // **Both specs ran against TWO Y.Docs and asserted the parity of nothing.**
  // `acceptAnnotation matches acceptPending` compared only `resA.kind` to
  // `resB.kind` — an unconditional `{kind: "ok"}` matches itself — and the
  // dismiss twin discarded both return values entirely, so deleting its
  // `dismissPending` call left it green.
  //
  // Fixing that by comparing records across two docs does not work and would
  // make things worse: `relRange` embeds the doc's client id, so a cross-doc
  // comparison must normalise it away — and normalising `relRange` away is
  // exactly what the field-survival mutant needs to survive. The fix is to
  // drive both paths against ONE doc, which is what these two now do — and the
  // reason the `relRange`-is-defined assertion below is load-bearing rather
  // than decorative.
  it.each([
    [
      "accept",
      (s: YDocStore, id: string) => s.acceptAnnotation(id),
      (id: string, d: Y.Doc, m: Y.Map<unknown>) => acceptPending(id, d, m, noRelay),
      "accepted",
    ],
    [
      "dismiss",
      (s: YDocStore, id: string) => s.dismissAnnotation(id),
      (id: string, d: Y.Doc, m: Y.Map<unknown>) => dismissPending(id, d, m, noRelay),
      "dismissed",
    ],
  ])("%sAnnotation writes what the standalone helper writes", (_label, viaStore, viaHelper, want) => {
    const ydoc = setupDoc(`parity-${want}`, "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH, `parity-${want}`);

    const idStore = mint(ydoc, "comment", rangeOf(0, 5, ydoc), "x");
    const idHelper = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "x");

    // Without this, `normalizeForParity` blanking `id` and `timestamp` would be
    // the whole of the comparison if `rangeOf` ever stopped anchoring.
    expect((map.get(idStore) as Annotation).relRange, "the fixtures are anchored").toBeDefined();

    const resStore = viaStore(store, idStore);
    const resHelper = viaHelper(idHelper, ydoc, map);

    // Both arms, not just their kinds — `.kind` alone is matched by any two
    // results that happen to succeed.
    expect(resStore.kind).toBe("ok");
    expect(resHelper.kind).toBe("ok");
    if (resStore.kind !== "ok" || resHelper.kind !== "ok") return;

    // The records, modulo the two fields that legitimately differ between any
    // two annotations minted a moment apart.
    expect(normalizeForParity(map.get(idStore) as Annotation)).toStrictEqual(
      normalizeForParity(map.get(idHelper) as Annotation),
    );
    expect((map.get(idStore) as Annotation).status).toBe(want);
  });
});

describe("YDocStore.removeAnnotation parity", () => {
  it("removes the annotation and its replies, matching removeAnnotationRecord", () => {
    const ydoc = setupDoc("rm-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH, "rm-1");

    const id = mint(ydoc, "comment", rangeOf(0, 5, ydoc), "x");
    store.addReply(id, "a reply");
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(1);

    const result = store.removeAnnotation(id);
    expect(result).toStrictEqual({ kind: "ok", id });
    expect(map.has(id)).toBe(false);
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
  });

  it("returns the not-found arm for an absent ID (same arm as the mechanism)", () => {
    const ydoc = setupDoc("rm-2", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH, "rm-2");
    const viaStore = store.removeAnnotation("nope");
    const viaMechanism = removeAnnotationRecord(ydoc, "nope");
    // Both halves pinned, not just their equality: two functions that both
    // returned `{kind:"ok"}` would also be equal to each other.
    expect(viaStore).toStrictEqual({ kind: "not-found", id: "nope" });
    expect(viaMechanism).toStrictEqual(viaStore);
  });
});

describe("YDocStore replies parity", () => {
  it("addReply writes Claude's reply through the seam", () => {
    const ydoc = setupDoc("rep-1", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH, "rep-1");
    const id = mint(ydoc, "comment", rangeOf(0, 5, ydoc), "x");

    const r = store.addReply(id, "agreed");
    expect(r.kind).toBe("ok");

    const replies = store.listReplies(id);
    expect(replies).toHaveLength(1);
    expect(replies[0].author).toBe("claude");
    expect(replies[0].text).toBe("agreed");
    // listReplies mirrors collectRepliesForAnnotation exactly.
    expect(replies).toEqual(collectRepliesForAnnotation(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES), id));
  });

  it("tags Claude's reply MCP_ORIGIN, so it is not echoed back at Claude", () => {
    const ydoc = setupDoc("rep-origin", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH, "rep-origin");
    const id = mint(ydoc, "comment", rangeOf(0, 5, ydoc), "x");

    // Unpinned until Unit 8f. The parity spec above asserts author, text and
    // list equality and never looks at origin, so flipping this call site to
    // `withBrowser` survived the entire suite — and `browser` is the one origin
    // NOT in `CHANNEL_SKIP`, which makes that mutation "Claude's own reply
    // becomes a channel event delivered back to Claude".
    let origin: unknown;
    ydoc.on("afterTransaction", (tr) => {
      origin = tr.origin;
    });
    const r = store.addReply(id, "agreed");
    expect(r.kind).toBe("ok");
    expect(origin).toBe(MCP_ORIGIN);
  });

  it("addReply rejects a non-comment parent (ADR-027), matching the helper", () => {
    const ydoc = setupDoc("rep-2", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH, "rep-2");
    const id = mint(ydoc, "highlight", rangeOf(0, 5, ydoc), "", {
      color: "yellow",
    });
    const r = store.addReply(id, "nope");
    // The ARM, not a wire code: the store now returns the lifecycle's own
    // union, and `not-repliable` is what a highlight parent produces. The
    // INVALID_ARGUMENT it maps to is asserted where that mapping lives, in
    // `describeReplyRefusal`.
    expect(r).toStrictEqual({ kind: "not-repliable", annotationType: "highlight" });
  });
});

describe("YDocStore.listAnnotationsRefreshed", () => {
  it("re-anchors flat offsets after an upstream edit and persists them", () => {
    const ydoc = setupDoc("refresh-1", "Hello world content here");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH, "refresh-1");
    // Anchor a comment on "world" (offsets 6..11).
    const id = mint(ydoc, "comment", rangeOf(6, 11, ydoc), "on world");

    // Insert text before the anchor so the flat offset must shift.
    const frag = ydoc.getXmlFragment("default");
    const para = frag.get(0) as Y.XmlElement;
    const xtext = para.get(0) as Y.XmlText;
    ydoc.transact(() => xtext.insert(0, "XXX "), MCP_ORIGIN);

    const refreshed = store.listAnnotationsRefreshed().find((annn) => annn.id === id)!;
    expect(refreshed.range.from).toBe(toFlatOffset(10));
    expect(refreshed.range.to).toBe(toFlatOffset(15));
    // The refreshed range is persisted back into the Y.Map.
    expect((map.get(id) as Annotation).range.from).toBe(toFlatOffset(10));
  });
});

describe("getDocumentStore factory", () => {
  it("resolves the active document into a store", () => {
    const ydoc = setupDoc("factory-1", "Hello world");
    const store = getDocumentStore();
    expect(store).not.toBeNull();
    expect(store!.ydoc).toBe(ydoc);
    expect(store!.getText()).toBe("Hello world");
  });

  it("returns null when no document is open", () => {
    clearOpenDocs();
    expect(getDocumentStore()).toBeNull();
  });

  it("returns a FRESH store each call — memoizing it would outlive a doc swap", () => {
    // `YDocStore` now caches an `AnnotationLifecycle` in its constructor, and
    // that lifecycle captures `ydoc.getMap(Y_MAP_ANNOTATIONS)`. The only thing
    // making that safe is this factory building a new store per handler call:
    // Hocuspocus replaces the Y.Doc in `onLoadDocument` and destroys the old
    // one, so a memoized store would write into a destroyed doc with nothing to
    // observe it. Memoizing by `doc.id` is a natural-looking optimization and
    // left every other suite green.
    setupDoc("factory-fresh", "Hello world");
    const first = getDocumentStore();
    const second = getDocumentStore();
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second!.lifecycle).not.toBe(first!.lifecycle);
  });

  it("accept/dismiss delegate to the lifecycle and keep its tagged arms", () => {
    // ADR-035 Unit 8b re-pointed these two at `this.lifecycle`. The arms are the
    // contract the MCP handlers branch on, so a delegation that threw or
    // returned a bare boolean instead would be invisible to the parity floor.
    const ydoc = setupDoc("factory-arms", "Hello world");
    const store = getDocumentStore()!;
    expect(store.acceptAnnotation("no-such-id")).toStrictEqual({
      kind: "not-found",
      id: "no-such-id",
    });

    const id = createAnnotation(
      ydoc.getMap(Y_MAP_ANNOTATIONS),
      ydoc,
      "comment",
      rangeOf(0, 5, ydoc),
      "x",
    );
    expect(store.acceptAnnotation(id)).toMatchObject({ kind: "ok" });
    // Now non-pending: the second call must report the current status, not
    // silently succeed again.
    expect(store.dismissAnnotation(id)).toStrictEqual({
      kind: "not-pending",
      id,
      currentStatus: "accepted",
    });
  });
});
