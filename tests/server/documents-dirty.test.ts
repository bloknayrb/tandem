import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  clearDirtyState,
  isDirty,
  markClean,
  markCleanIfUnchanged,
  markDirty,
  registerDirtyObserver,
  resetForTesting,
  setDirtyMirrorEligibility,
  snapshotDirtyVersion,
} from "../../src/server/documents/dirty.js";
import { addDoc, isDirtyMirrorEligible, removeDoc } from "../../src/server/documents/registry.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_DIRTY, Y_MAP_DOCUMENT_META } from "../../src/shared/constants.js";

// Docs created for the mirror tests must live in the provider map, because
// `publishDirty` resolves the LIVE doc through `getDocument(docId)` rather than
// caching a reference (a cached one outlives the Hocuspocus swap's destroy()).
const provided: string[] = [];
function liveDoc(docId: string): Y.Doc {
  provided.push(docId);
  return getOrCreateDocument(docId);
}
function mirrorOf(doc: Y.Doc): unknown {
  return doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_DIRTY);
}

afterEach(() => {
  resetForTesting();
  for (const id of provided) {
    removeDocument(id);
    removeDoc(id);
  }
  provided.length = 0;
});

function attachAndEdit(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [p]);
}

// Declared FIRST on purpose: `resetForTesting` clears the injected mirror
// predicate, so only a test running before any afterEach has fired can observe
// the AMBIENT registration that `registry.ts` performs at module scope. That
// one wiring line has no other cover. It fails closed — if this ever runs after
// a reset, the predicate is null, the upload doc publishes, and the assertion
// below goes red rather than silently passing for the wrong reason.
describe("dirty.ts — registry wiring is live on import (#1447)", () => {
  it("S0: importing registry.ts is enough to suppress an upload doc's mirror", () => {
    const docId = "mirror-wiring";
    const doc = liveDoc(docId);
    addDoc(docId, {
      id: docId,
      filePath: "upload://scratchpad",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    registerDirtyObserver(docId, doc);
    attachAndEdit(doc, "typing in a scratchpad");

    expect(isDirty(docId)).toBe(true);
    expect(mirrorOf(doc)).toBeUndefined();
  });
});

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
    attachAndEdit(doc, "hello");
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
    attachAndEdit(doc, "edit");
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
    attachAndEdit(doc, "first");
    const snap = snapshotDirtyVersion(docId);

    // Simulate a concurrent edit landing during the (hypothetical) async write.
    attachAndEdit(doc, "second");

    const cleared = markCleanIfUnchanged(docId, snap);
    expect(cleared).toBe(false);
    expect(isDirty(docId)).toBe(true);
  });

  it("markClean unconditionally clears the flag at the current version", () => {
    const docId = "doc-f";
    const doc = new Y.Doc();
    registerDirtyObserver(docId, doc);
    attachAndEdit(doc, "edit-1");
    attachAndEdit(doc, "edit-2");
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
    attachAndEdit(docA, "before-swap");
    expect(isDirty(docId)).toBe(true);

    const docB = new Y.Doc();
    registerDirtyObserver(docId, docB);
    expect(isDirty(docId)).toBe(true);
  });

  it("clearDirtyState detaches and drops tracking entirely", () => {
    const docId = "doc-h";
    const doc = new Y.Doc();
    registerDirtyObserver(docId, doc);
    attachAndEdit(doc, "edit");
    clearDirtyState(docId);

    // After clear, even further edits don't show up (no observer attached).
    attachAndEdit(doc, "post-clear");
    expect(isDirty(docId)).toBe(false);
  });

  it("isDirty returns false for an unknown docId", () => {
    expect(isDirty("never-registered")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #1447: the documentMeta mirror. The client cannot derive "unsaved" — the
// initial CRDT sync and a pre-attach MCP edit are the same bytes to it — so the
// server projects its authoritative flag into the doc's own documentMeta.
// ---------------------------------------------------------------------------

describe("dirty.ts — Y_MAP_DIRTY mirror (#1447)", () => {
  it("S1: publishes true into documentMeta on a body edit", () => {
    const docId = "mirror-a";
    const doc = liveDoc(docId);
    registerDirtyObserver(docId, doc);
    expect(mirrorOf(doc)).toBe(false);

    attachAndEdit(doc, "pre-attach MCP edit");
    expect(mirrorOf(doc)).toBe(true);
  });

  it("S2: markClean publishes false; a lost markCleanIfUnchanged race stays true", () => {
    const docId = "mirror-b";
    const doc = liveDoc(docId);
    registerDirtyObserver(docId, doc);

    attachAndEdit(doc, "edit");
    const snap = snapshotDirtyVersion(docId);
    expect(mirrorOf(doc)).toBe(true);

    markClean(docId);
    expect(mirrorOf(doc)).toBe(false);

    // The save-race path: an edit lands during the async write, so the doc is
    // genuinely still dirty. saveDocumentToDisk has ALREADY written a fresh
    // savedAtVersion by this point, so the mirror is the only signal left that
    // stops the client treating that save as having made the tab clean.
    attachAndEdit(doc, "one");
    const raceSnap = snapshotDirtyVersion(docId);
    attachAndEdit(doc, "two — lands during the write");
    expect(markCleanIfUnchanged(docId, raceSnap)).toBe(false);
    expect(isDirty(docId)).toBe(true);
    expect(mirrorOf(doc)).toBe(true);
    expect(snap).toBeGreaterThan(0);
  });

  it("S3: the transaction that writes Y_MAP_DIRTY is tagged `internal`", () => {
    // Critical Rule 2: the helper choice IS the contract. `withBrowser` is the
    // only channel-emitting origin, so a drift to it would fire a spurious
    // channel event at Claude on every save. Asserting the origin of the
    // transaction whose keysChanged holds Y_MAP_DIRTY specifically — not merely
    // that "internal" appears somewhere in the origin list.
    const docId = "mirror-c";
    const doc = liveDoc(docId);
    const origins: unknown[] = [];
    doc.on("afterTransaction", (txn: Y.Transaction) => {
      for (const [type, evt] of txn.changed) {
        if (type === doc.getMap(Y_MAP_DOCUMENT_META) && evt.has(Y_MAP_DIRTY)) {
          origins.push(txn.origin);
        }
      }
    });

    registerDirtyObserver(docId, doc);
    attachAndEdit(doc, "edit");

    expect(origins.length).toBeGreaterThan(0);
    for (const origin of origins) expect(origin).toBe("internal");
  });

  it("S4: writes only on a transition, and the mirror write does not feed back", () => {
    const docId = "mirror-d";
    const doc = liveDoc(docId);
    registerDirtyObserver(docId, doc);

    let mirrorWrites = 0;
    doc.on("afterTransaction", (txn: Y.Transaction) => {
      for (const [type, evt] of txn.changed) {
        if (type === doc.getMap(Y_MAP_DOCUMENT_META) && evt.has(Y_MAP_DIRTY)) mirrorWrites++;
      }
    });

    for (let i = 0; i < 10; i++) attachAndEdit(doc, `edit-${i}`);
    expect(mirrorOf(doc)).toBe(true);
    // Ten edits, ONE clean→dirty transition.
    expect(mirrorWrites).toBe(1);

    // And the mirror write is off-fragment, so it bumps no version: the doc is
    // exactly as dirty after the publish as the ten edits made it.
    const afterEdits = snapshotDirtyVersion(docId);
    markClean(docId);
    expect(mirrorOf(doc)).toBe(false);
    expect(snapshotDirtyVersion(docId)).toBe(afterEdits);
    expect(isDirty(docId)).toBe(false);
  });

  it("S5: re-registering on a swapped Y.Doc seeds the new doc's mirror", () => {
    // Hocuspocus replaces the Y.Doc in onLoadDocument and destroy()s the old
    // one; onDocSwapped → reattachObservers → registerDirtyObserver. Module
    // state (version/savedVersion) is deliberately preserved across the swap, so
    // any module-state "last published" cache would also survive it and suppress
    // the write that seeds the NEW doc's map. The Y.Map itself is the transition
    // test precisely so this can't happen.
    const docId = "mirror-e";
    const docA = liveDoc(docId);
    registerDirtyObserver(docId, docA);
    attachAndEdit(docA, "before swap");
    expect(mirrorOf(docA)).toBe(true);

    // The swap replaces the map entry with a fresh doc.
    removeDocument(docId);
    const docB = getOrCreateDocument(docId);
    expect(mirrorOf(docB)).toBeUndefined();

    registerDirtyObserver(docId, docB);
    expect(isDirty(docId)).toBe(true);
    expect(mirrorOf(docB)).toBe(true);
  });

  it('S6: never publishes for a source:"upload" doc (scratchpad / upload)', () => {
    // A scratchpad can't reach disk without a Save As promotion —
    // saveDocumentToDisk returns PROMOTION_REQUIRED, autosave skips it and
    // nothing calls markClean. A mirrored `true` would be a dot with no code
    // path able to clear it, across every reload.
    const docId = "mirror-f";
    const doc = liveDoc(docId);
    // `resetForTesting` clears the injected predicate, so reinstall the exact
    // function `registry.ts` registers at module scope — this asserts dirty.ts
    // honours it; S8 asserts the predicate itself is right.
    setDirtyMirrorEligibility(isDirtyMirrorEligible);
    addDoc(docId, {
      id: docId,
      filePath: "upload://scratchpad",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    registerDirtyObserver(docId, doc);
    attachAndEdit(doc, "typing in a scratchpad");

    expect(isDirty(docId)).toBe(true);
    expect(mirrorOf(doc)).toBeUndefined();

    // Promotion (Save As) flips source to "file" on the same docId/room; the
    // exclusion is read live, not latched at registration, so the post-promote
    // markClean starts mirroring.
    addDoc(docId, {
      id: docId,
      filePath: "/tmp/promoted.md",
      format: "md",
      readOnly: false,
      source: "file",
    });
    markClean(docId);
    expect(mirrorOf(doc)).toBe(false);
  });

  it("S8: the registry's mirror predicate excludes uploads and admits files", () => {
    // The other half of S6: S6 proves `publishDirty` honours whatever predicate
    // is installed, this proves the installed one draws the line in the right
    // place — including the upload→file promotion flip.
    const docId = "mirror-h";
    provided.push(docId);
    addDoc(docId, {
      id: docId,
      filePath: "upload://scratchpad",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    expect(isDirtyMirrorEligible(docId)).toBe(false);

    addDoc(docId, {
      id: docId,
      filePath: "/tmp/promoted.md",
      format: "md",
      readOnly: false,
      source: "file",
    });
    expect(isDirtyMirrorEligible(docId)).toBe(true);

    // A docId the registry doesn't track (CTRL_ROOM never gets a dirty
    // observer; unit-test docs) mirrors normally.
    expect(isDirtyMirrorEligible("never-registered")).toBe(true);
  });

  it("S7: publishes nothing when the docId has no live Y.Doc", () => {
    // A cached doc reference would outlive its doc here (detachObservers does
    // not detach the dirty observer) and publish into an orphan nobody syncs.
    const docId = "mirror-g";
    const orphan = new Y.Doc();
    registerDirtyObserver(docId, orphan);
    attachAndEdit(orphan, "edit");
    markDirty(docId);

    expect(isDirty(docId)).toBe(true);
    expect(mirrorOf(orphan)).toBeUndefined();
  });
});
