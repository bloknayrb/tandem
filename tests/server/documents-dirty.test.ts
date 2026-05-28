import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  clearDirtyState,
  isDirty,
  markClean,
  markCleanIfUnchanged,
  registerDirtyObserver,
  resetForTesting,
  snapshotDirtyVersion,
} from "../../src/server/documents/dirty.js";

afterEach(() => {
  resetForTesting();
});

function attachAndEdit(docId: string, doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [p]);
  void docId;
}

describe("dirty.ts — observer + version", () => {
  it("starts clean before any edits", () => {
    const docId = "doc-a";
    const doc = new Y.Doc();
    registerDirtyObserver(docId, doc);
    expect(isDirty(docId)).toBe(false);
  });

  it("marks dirty when the body fragment changes", () => {
    const docId = "doc-b";
    const doc = new Y.Doc();
    registerDirtyObserver(docId, doc);
    attachAndEdit(docId, doc, "hello");
    expect(isDirty(docId)).toBe(true);
  });

  it("annotation-map writes do NOT mark the doc dirty", () => {
    // Critical Rule: dirty observes the body XmlFragment only — annotations,
    // awareness, savedAtVersion meta, and ctrl-room writes must not trigger
    // an autosave.
    const docId = "doc-c";
    const doc = new Y.Doc();
    registerDirtyObserver(docId, doc);
    doc.getMap("annotations").set("ann-1", { id: "ann-1" });
    expect(isDirty(docId)).toBe(false);
  });
});

describe("dirty.ts — race handling", () => {
  it("markCleanIfUnchanged with unchanged snapshot clears the dirty flag", () => {
    const docId = "doc-d";
    const doc = new Y.Doc();
    registerDirtyObserver(docId, doc);
    attachAndEdit(docId, doc, "edit");
    const snap = snapshotDirtyVersion(docId);
    expect(isDirty(docId)).toBe(true);

    const cleared = markCleanIfUnchanged(docId, snap);
    expect(cleared).toBe(true);
    expect(isDirty(docId)).toBe(false);
  });

  it("markCleanIfUnchanged with a stale snapshot leaves the doc dirty", () => {
    // The whole point of the snapshot/compare-on-clean dance is to avoid the
    // lost-update race: an edit that lands DURING the disk write must keep
    // the doc dirty so the next autosave pass picks it up.
    const docId = "doc-e";
    const doc = new Y.Doc();
    registerDirtyObserver(docId, doc);
    attachAndEdit(docId, doc, "first");
    const snap = snapshotDirtyVersion(docId);

    // Simulate a concurrent edit landing during the (hypothetical) async write.
    attachAndEdit(docId, doc, "second");

    const cleared = markCleanIfUnchanged(docId, snap);
    expect(cleared).toBe(false);
    expect(isDirty(docId)).toBe(true);
  });

  it("markClean unconditionally clears the flag at the current version", () => {
    const docId = "doc-f";
    const doc = new Y.Doc();
    registerDirtyObserver(docId, doc);
    attachAndEdit(docId, doc, "edit-1");
    attachAndEdit(docId, doc, "edit-2");
    expect(isDirty(docId)).toBe(true);

    markClean(docId);
    expect(isDirty(docId)).toBe(false);
  });
});

describe("dirty.ts — lifecycle", () => {
  it("re-registering the observer on a swapped Y.Doc preserves dirty state", () => {
    // Hocuspocus replaces the Y.Doc instance on swap (see ADR / provider.ts).
    // The dirty-version must NOT reset across the swap, or an edited doc that
    // reconnects would silently lose its pending-save flag.
    const docId = "doc-g";
    const docA = new Y.Doc();
    registerDirtyObserver(docId, docA);
    attachAndEdit(docId, docA, "before-swap");
    expect(isDirty(docId)).toBe(true);

    const docB = new Y.Doc();
    registerDirtyObserver(docId, docB);
    expect(isDirty(docId)).toBe(true);
  });

  it("clearDirtyState detaches and drops tracking entirely", () => {
    const docId = "doc-h";
    const doc = new Y.Doc();
    registerDirtyObserver(docId, doc);
    attachAndEdit(docId, doc, "edit");
    clearDirtyState(docId);

    // After clear, even further edits don't show up (no observer attached).
    attachAndEdit(docId, doc, "post-clear");
    expect(isDirty(docId)).toBe(false);
  });

  it("isDirty returns false for an unknown docId", () => {
    expect(isDirty("never-registered")).toBe(false);
  });
});
