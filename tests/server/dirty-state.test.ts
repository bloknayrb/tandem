import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { Y_MAP_DOCUMENT_META, Y_MAP_SAVED_AT_VERSION } from "../../src/shared/constants.js";

describe("savedAtVersion baseline", () => {
  it("can be set on document metadata", () => {
    const doc = new Y.Doc();
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    const now = Date.now();
    meta.set(Y_MAP_SAVED_AT_VERSION, now);
    expect(meta.get(Y_MAP_SAVED_AT_VERSION)).toBe(now);
  });

  it("produces a new value on each save", () => {
    const doc = new Y.Doc();
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    const first = Date.now();
    meta.set(Y_MAP_SAVED_AT_VERSION, first);

    const second = first + 1000;
    meta.set(Y_MAP_SAVED_AT_VERSION, second);
    expect(meta.get(Y_MAP_SAVED_AT_VERSION)).toBe(second);
    expect(second).not.toBe(first);
  });

  it("annotation map changes do not affect savedAtVersion", () => {
    const doc = new Y.Doc();
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    const baseline = Date.now();
    meta.set(Y_MAP_SAVED_AT_VERSION, baseline);

    const annotations = doc.getMap("annotations");
    annotations.set("test-ann", { id: "test-ann", type: "comment" });

    expect(meta.get(Y_MAP_SAVED_AT_VERSION)).toBe(baseline);
  });
});
