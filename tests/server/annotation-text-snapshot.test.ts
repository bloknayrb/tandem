import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { captureSnapshot, collectAnnotations } from "../../src/server/mcp/annotations.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { isSnapshotTruncated, SNAPSHOT_CAP } from "../../src/shared/snapshot.js";
import { unanchored as makeResult } from "../helpers/positions.js";
import { createAnnotation } from "../helpers/ydoc-factory.js";

const DOC_HASH = "sha256:annotation-text-snapshot";

describe("annotation textSnapshot", () => {
  it("stores textSnapshot when provided via extras", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", makeResult(0, 10), "Nice paragraph", {
      textSnapshot: "hello worl",
    });
    const annotations = collectAnnotations(map, DOC_HASH);
    const stored = annotations.find((a) => a.id === id);
    expect(stored).toBeDefined();
    expect(stored?.textSnapshot).toBe("hello worl");
  });

  it("works without textSnapshot (legacy compatibility)", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "highlight", makeResult(0, 5), "Looks good");
    const annotations = collectAnnotations(map, DOC_HASH);
    const stored = annotations.find((a) => a.id === id);
    expect(stored).toBeDefined();
    expect(stored?.textSnapshot).toBeUndefined();
  });

  it("stores textSnapshot on note annotations", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "note", makeResult(5, 20), "Needs review", {
      textSnapshot: "noted text",
    });
    const annotations = collectAnnotations(map, DOC_HASH);
    const stored = annotations.find((a) => a.id === id);
    expect(stored?.textSnapshot).toBe("noted text");
  });
});

describe("snapshot truncation", () => {
  // Calls the PRODUCT's `captureSnapshot`. This block previously declared its
  // own copy of the truncation logic and asserted against that, so it passed
  // no matter what the product did — including asserting a trailing "..." that
  // #1486 removed. A test that re-implements the thing it tests is testing the
  // copy.

  /** A Y.Doc whose flat text is `content`. */
  function docWithText(content: string): Y.Doc {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    fragment.insert(0, [p]);
    p.insert(0, [new Y.XmlText(content)]);
    return ydoc;
  }

  it("caps text longer than 200 chars and REPORTS the cut", () => {
    const ydoc = docWithText("a".repeat(250));
    const snap = captureSnapshot(ydoc, 0, 250);
    expect(snap.text).toHaveLength(200);
    expect(snap.truncated).toBe(true);
  });

  it("no longer writes an ellipsis into the snapshot", () => {
    // The three characters that reached the user's document on undo. They were
    // also undetectable after the fact — real prose ends with "..." — which is
    // why the cut is reported as a flag instead of marked in the text (#1486).
    const ydoc = docWithText("a".repeat(250));
    expect(captureSnapshot(ydoc, 0, 250).text.endsWith("...")).toBe(false);
    expect(captureSnapshot(ydoc, 0, 250).text).toBe("a".repeat(200));
  });

  it("keeps text at exactly 200 chars unchanged and untruncated", () => {
    const exact = "b".repeat(200);
    const snap = captureSnapshot(docWithText(exact), 0, 200);
    expect(snap.text).toBe(exact);
    expect(snap.truncated).toBe(false);
  });

  it("keeps short text unchanged", () => {
    const snap = captureSnapshot(docWithText("short"), 0, 5);
    expect(snap.text).toBe("short");
    expect(snap.truncated).toBe(false);
  });

  it("does not flag a snapshot that merely ENDS with an ellipsis", () => {
    // Why the flag has to be its own field rather than sniffed from the text.
    // Deliberately at EXACTLY the cap, not comfortably under it: a short string
    // is rejected by the length test alone, so it would pass against a
    // sniff-only implementation and prove nothing. This is the one input where
    // "ends in ..." and "is cap-length" both hold and the answer is still
    // `false`, which is the whole reason `captureSnapshot` reports out of band.
    const honest = `${"c".repeat(SNAPSHOT_CAP - 3)}...`;
    expect(honest).toHaveLength(SNAPSHOT_CAP);
    const snap = captureSnapshot(docWithText(honest), 0, honest.length);
    expect(snap.text).toBe(honest);
    expect(snap.truncated).toBe(false);
  });
});

describe("#1486: isSnapshotTruncated", () => {
  // The shared predicate both restore paths call — undo (client) and the reload
  // relocation pass (server). It lives in one file precisely because the second
  // consumer was missed on the first pass at this fix.

  // `SnapshotBearing` requires an `id` (unused by either predicate below —
  // it's the identifying field a real Annotation carries alongside the
  // snapshot); a fixed placeholder here satisfies the type without touching
  // what these tests exercise.
  const TEST_ID = "ann_test";

  it("trusts the flag when the record carries one", () => {
    expect(
      isSnapshotTruncated({ id: TEST_ID, textSnapshot: "x", textSnapshotTruncated: true }),
    ).toBe(true);
    expect(
      isSnapshotTruncated({ id: TEST_ID, textSnapshot: "x", textSnapshotTruncated: false }),
    ).toBe(false);
  });

  it("treats a flagged-false cap-length ellipsis snapshot as complete", () => {
    // The flag WINS over the legacy sniff. A record this build wrote knows the
    // answer; the sniff is a guess for records that don't. Getting the
    // precedence backwards would refuse honest undos forever.
    expect(
      isSnapshotTruncated({
        id: TEST_ID,
        textSnapshot: `${"c".repeat(SNAPSHOT_CAP - 3)}...`,
        textSnapshotTruncated: false,
      }),
    ).toBe(false);
  });

  it("detects a LEGACY record by cap-length plus the old trailing ellipsis", () => {
    // No flag — this is what is on users' disks today. Both conditions are
    // required, and the next two tests pin each half.
    expect(
      isSnapshotTruncated({ id: TEST_ID, textSnapshot: `${"c".repeat(SNAPSHOT_CAP - 3)}...` }),
    ).toBe(true);
  });

  it("does not fire on a cap-length snapshot WITHOUT the ellipsis", () => {
    // What this build writes when it truncates — and also a legitimately
    // 200-character snapshot. Both carry the flag when truncated, so length
    // alone must not condemn them or every exactly-200 undo would be refused.
    expect(isSnapshotTruncated({ id: TEST_ID, textSnapshot: "c".repeat(SNAPSHOT_CAP) })).toBe(
      false,
    );
  });

  it("does not fire on a SHORT snapshot ending in an ellipsis", () => {
    // Ordinary prose. Sniffing for the ellipsis alone would refuse undo on
    // every sentence that trails off.
    expect(isSnapshotTruncated({ id: TEST_ID, textSnapshot: "he hesitated..." })).toBe(false);
  });

  it("does not fire on a missing snapshot", () => {
    expect(isSnapshotTruncated({ id: TEST_ID, textSnapshot: undefined })).toBe(false);
  });
});
