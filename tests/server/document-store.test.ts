/**
 * Parity contract for `YDocStore` (issue #315).
 *
 * The DocumentStore seam was extracted as a PURE INTERNAL REFACTOR: every
 * method must produce the same Y.Map structures and outputs the pre-refactor
 * MCP handlers produced when they touched `Y.Map` directly. The existing MCP /
 * annotation suites are the behavioral parity floor; this file is the contract
 * test for the new interface itself — it pins the store's outputs against the
 * standalone helpers (`createAnnotation`, `collectAnnotations`,
 * `addReplyToAnnotation`, `removeAnnotationById`) and the lifecycle module the
 * handlers used before, and asserts the Y.Map state matches byte-for-byte.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { acceptPending, dismissPending } from "../../src/server/annotations/lifecycle.js";
import {
  addReplyToAnnotation,
  collectAnnotations,
  collectRepliesForAnnotation,
  createAnnotation,
  removeAnnotationById,
} from "../../src/server/mcp/annotations.js";
import { getDocumentStore, YDocStore } from "../../src/server/mcp/document-store.js";
import { anchoredRange } from "../../src/server/positions.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { MCP_ORIGIN } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

beforeEach(() => {
  clearOpenDocs();
});

const FILE_PATH = "/tmp/doc.md";

describe("YDocStore.createAnnotation parity", () => {
  it("writes the same Y.Map record the standalone helper writes", () => {
    // Drive both the store method and the standalone helper against the SAME
    // Y.Doc so relRange (which embeds the doc's client ID) is comparable; only
    // the random id + timestamp legitimately differ between the two records.
    const ydoc = setupDoc("create-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH);

    const idStore = store.createAnnotation("comment", rangeOf(0, 5, ydoc), "needs work", {
      suggestedText: "Hi",
    });
    const idHelper = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "needs work", {
      suggestedText: "Hi",
    });

    const recStore = map.get(idStore) as Annotation;
    const recHelper = map.get(idHelper) as Annotation;

    const norm = (a: Annotation) => ({ ...a, id: "X", timestamp: 0 });
    expect(norm(recStore)).toEqual(norm(recHelper));
    expect(recStore.author).toBe("claude");
    expect(recStore.type).toBe("comment");
    expect(recStore.suggestedText).toBe("Hi");
    expect(recStore.relRange).toBeDefined();
  });

  it("tags the write with MCP_ORIGIN (ADR-031)", () => {
    const ydoc = setupDoc("create-origin", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH);
    let origin: unknown;
    ydoc.on("afterTransaction", (tr) => {
      origin = tr.origin;
    });
    store.createAnnotation("comment", rangeOf(0, 5, ydoc), "x");
    expect(origin).toBe(MCP_ORIGIN);
  });
});

describe("YDocStore.listAnnotations parity", () => {
  it("matches collectAnnotations output", () => {
    const ydoc = setupDoc("list-1", "Hello world content");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH);

    createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "one");
    createAnnotation(map, ydoc, "highlight", rangeOf(6, 11, ydoc), "", { color: "yellow" });
    createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "private");

    expect(store.listAnnotations()).toEqual(collectAnnotations(map, store.docHash));
    expect(store.listAnnotations()).toHaveLength(3);
  });

  it("getAnnotation returns the sanitized record, undefined when absent", () => {
    const ydoc = setupDoc("get-1", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH);
    const id = store.createAnnotation("comment", rangeOf(0, 5, ydoc), "hi");
    expect(store.getAnnotation(id)?.content).toBe("hi");
    expect(store.getAnnotation("missing")).toBeUndefined();
  });
});

describe("YDocStore.editAnnotation parity (handler guard order)", () => {
  it("updates content + suggestedText and bumps rev/editedAt", () => {
    const ydoc = setupDoc("edit-ok", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH);
    const id = store.createAnnotation("comment", rangeOf(0, 5, ydoc), "old");
    const before = store.getAnnotation(id)!;

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
    const store = new YDocStore(ydoc, FILE_PATH);
    expect(store.editAnnotation("nope", { content: "x" })).toEqual({ kind: "not-found" });
  });

  it("rejects editing a note (ADR-027) before any other guard", () => {
    const ydoc = setupDoc("edit-note", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH);
    const id = store.createAnnotation("note", rangeOf(0, 5, ydoc), "private");
    // Even with an empty patch, the note guard wins (it precedes empty-patch).
    expect(store.editAnnotation(id, {})).toEqual({ kind: "invalid-note" });
  });

  it("returns not-pending for an accepted annotation", () => {
    const ydoc = setupDoc("edit-np", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH);
    const id = store.createAnnotation("comment", rangeOf(0, 5, ydoc), "x");
    acceptPending(id, ydoc, map);
    expect(store.editAnnotation(id, { content: "y" })).toEqual({
      kind: "not-pending",
      currentStatus: "accepted",
    });
  });

  it("returns empty-patch when no fields are supplied (pending comment)", () => {
    const ydoc = setupDoc("edit-empty", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH);
    const id = store.createAnnotation("comment", rangeOf(0, 5, ydoc), "x");
    expect(store.editAnnotation(id, {})).toEqual({ kind: "empty-patch" });
  });

  it("rejects suggestedText on a non-comment after the empty-patch guard", () => {
    const ydoc = setupDoc("edit-sugg", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH);
    const id = store.createAnnotation("highlight", rangeOf(0, 5, ydoc), "", { color: "yellow" });
    expect(store.editAnnotation(id, { suggestedText: "Hi" })).toEqual({
      kind: "invalid-suggestion-target",
      annotationType: "highlight",
    });
  });
});

describe("YDocStore lifecycle parity", () => {
  it("acceptAnnotation matches acceptPending", () => {
    const a = setupDoc("acc-a", "Hello world");
    const b = setupDoc("acc-b", "Hello world");
    const storeA = new YDocStore(a, FILE_PATH);
    const idA = storeA.createAnnotation("comment", rangeOf(0, 5, a), "x");
    const idB = createAnnotation(b.getMap(Y_MAP_ANNOTATIONS), b, "comment", rangeOf(0, 5, b), "x");

    const resA = storeA.acceptAnnotation(idA);
    const resB = acceptPending(idB, b, b.getMap(Y_MAP_ANNOTATIONS));
    expect(resA.kind).toBe(resB.kind);
    expect((a.getMap(Y_MAP_ANNOTATIONS).get(idA) as Annotation).status).toBe("accepted");
  });

  it("dismissAnnotation matches dismissPending", () => {
    const a = setupDoc("dis-a", "Hello world");
    const b = setupDoc("dis-b", "Hello world");
    const storeA = new YDocStore(a, FILE_PATH);
    const idA = storeA.createAnnotation("comment", rangeOf(0, 5, a), "x");
    const idB = createAnnotation(b.getMap(Y_MAP_ANNOTATIONS), b, "comment", rangeOf(0, 5, b), "x");

    storeA.dismissAnnotation(idA);
    dismissPending(idB, b, b.getMap(Y_MAP_ANNOTATIONS));
    expect((a.getMap(Y_MAP_ANNOTATIONS).get(idA) as Annotation).status).toBe("dismissed");
  });
});

describe("YDocStore.removeAnnotation parity", () => {
  it("removes the annotation and its replies, matching removeAnnotationById", () => {
    const ydoc = setupDoc("rm-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH);

    const id = store.createAnnotation("comment", rangeOf(0, 5, ydoc), "x");
    store.addReply(id, "a reply", "claude");
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(1);

    const result = store.removeAnnotation(id);
    expect(result).toEqual({ ok: true, id });
    expect(map.has(id)).toBe(false);
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
  });

  it("returns NOT_FOUND for an absent ID (same arm as the helper)", () => {
    const ydoc = setupDoc("rm-2", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH);
    const viaStore = store.removeAnnotation("nope");
    const viaHelper = removeAnnotationById(ydoc, ydoc.getMap(Y_MAP_ANNOTATIONS), FILE_PATH, "nope");
    expect(viaStore).toEqual(viaHelper);
  });
});

describe("YDocStore replies parity", () => {
  it("addReply writes the same record as addReplyToAnnotation (claude author)", () => {
    const ydoc = setupDoc("rep-1", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH);
    const id = store.createAnnotation("comment", rangeOf(0, 5, ydoc), "x");

    const r = store.addReply(id, "agreed", "claude");
    expect(r.ok).toBe(true);

    const replies = store.listReplies(id);
    expect(replies).toHaveLength(1);
    expect(replies[0].author).toBe("claude");
    expect(replies[0].text).toBe("agreed");
    // listReplies mirrors collectRepliesForAnnotation exactly.
    expect(replies).toEqual(collectRepliesForAnnotation(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES), id));
  });

  it("addReply rejects a non-comment parent (ADR-027), matching the helper", () => {
    const ydoc = setupDoc("rep-2", "Hello world");
    const store = new YDocStore(ydoc, FILE_PATH);
    const id = store.createAnnotation("highlight", rangeOf(0, 5, ydoc), "", { color: "yellow" });
    const r = store.addReply(id, "nope", "claude");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("INVALID_ARGUMENT");
  });
});

describe("YDocStore.listAnnotationsRefreshed", () => {
  it("re-anchors flat offsets after an upstream edit and persists them", () => {
    const ydoc = setupDoc("refresh-1", "Hello world content here");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const store = new YDocStore(ydoc, FILE_PATH);
    // Anchor a comment on "world" (offsets 6..11).
    const id = store.createAnnotation("comment", rangeOf(6, 11, ydoc), "on world");

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
});
