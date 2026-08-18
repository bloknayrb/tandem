/**
 * `anchorFlatRange` — the range mint the client side of #1471 will call.
 *
 * It ships one branch ahead of its first consumer, so it would otherwise be
 * untested dead code arriving with a confident JSDoc. These tests exist so the
 * contract that comment describes is actually pinned before anything is built
 * on it — particularly the all-or-nothing rule, which is not an aesthetic
 * choice: the two assocs refuse to mint in DIFFERENT places, so a helper that
 * returned one anchored endpoint and one raw offset would hand the caller a
 * range whose halves disagree about which document they describe.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { extractText } from "../../src/server/mcp/document-model";
import { toFlatOffset } from "../../src/shared/positions/types";
import { anchorFlatRange, flatOffsetToRelPos } from "../../src/shared/positions/ydoc";

function docFor(markdown: string) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  return ydoc;
}

describe("anchorFlatRange", () => {
  it("mints both endpoints for an ordinary range", () => {
    const ydoc = docFor("alpha bravo\n");
    const range = anchorFlatRange(ydoc, toFlatOffset(0), toFlatOffset(5));
    expect(range).not.toBeNull();
    expect(range?.fromRel).toBeDefined();
    expect(range?.toRel).toBeDefined();
  });

  it("uses assoc 0 for from and assoc -1 for to", () => {
    // The assoc pair IS the contract — it decides whether text typed at either
    // boundary joins the range. Compared against the primitive directly rather
    // than trusted, so a swapped pair fails here instead of surfacing later as
    // an annotation that quietly grows when the user types next to it.
    const ydoc = docFor("alpha bravo\n");
    const range = anchorFlatRange(ydoc, toFlatOffset(2), toFlatOffset(7));
    expect(range?.fromRel).toEqual(flatOffsetToRelPos(ydoc, toFlatOffset(2), 0));
    expect(range?.toRel).toEqual(flatOffsetToRelPos(ydoc, toFlatOffset(7), -1));
    // And NOT the other way round, which a symmetric-looking helper could be.
    expect(range?.fromRel).not.toEqual(flatOffsetToRelPos(ydoc, toFlatOffset(2), -1));
  });

  it("returns null when only the from endpoint refuses", () => {
    // Offset 0 is inside the `# ` prefix, which exists only in the server's
    // rendering and has no Y.XmlText behind it.
    const ydoc = docFor("# Title\n\nbody\n");
    expect(anchorFlatRange(ydoc, toFlatOffset(0), toFlatOffset(6))).toBeNull();
    // Guard against the test passing for the wrong reason: the `to` endpoint on
    // its own must be perfectly mintable, so the null above is the
    // all-or-nothing rule and not a doc-wide failure.
    expect(flatOffsetToRelPos(ydoc, toFlatOffset(6), -1)).not.toBeNull();
  });

  it("returns null when only the to endpoint refuses", () => {
    // The mirror case, which a from-only guard would let through. Empty blocks
    // are where the two assocs disagree: assoc -1 refuses on the separator
    // AFTER the empty element, assoc 0 on the one before it.
    const ydoc = docFor("- one\n-\n- three\n");
    const flat = extractText(ydoc);
    const refusesLeft = [...flat].findIndex(
      (_, i) => flatOffsetToRelPos(ydoc, toFlatOffset(i), -1) === null,
    );
    expect(refusesLeft, "fixture must contain an offset assoc -1 refuses").toBeGreaterThan(0);
    expect(flatOffsetToRelPos(ydoc, toFlatOffset(0), 0)).not.toBeNull();
    expect(anchorFlatRange(ydoc, toFlatOffset(0), toFlatOffset(refusesLeft))).toBeNull();
  });

  it("does not throw on a wildly out-of-range offset", () => {
    const ydoc = docFor("short\n");
    expect(() => anchorFlatRange(ydoc, toFlatOffset(0), toFlatOffset(9999))).not.toThrow();
  });

  it("does not throw on an empty document", () => {
    const ydoc = new Y.Doc();
    expect(() => anchorFlatRange(ydoc, toFlatOffset(0), toFlatOffset(1))).not.toThrow();
    expect(anchorFlatRange(ydoc, toFlatOffset(0), toFlatOffset(1))).toBeNull();
  });
});
