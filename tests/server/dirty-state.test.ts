import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  Y_MAP_CONTENT_VERSION,
  Y_MAP_DOCUMENT_META,
  Y_MAP_SAVED_AT_VERSION,
} from "../../src/shared/constants.js";

describe("content version tracking", () => {
  it("starts at version 0 with clean state", () => {
    const doc = new Y.Doc();
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    meta.set(Y_MAP_CONTENT_VERSION, 0);
    meta.set(Y_MAP_SAVED_AT_VERSION, 0);
    expect(meta.get(Y_MAP_CONTENT_VERSION)).toBe(meta.get(Y_MAP_SAVED_AT_VERSION));
  });

  it("increments contentVersion on XmlFragment change", () => {
    const doc = new Y.Doc();
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    let version = 0;
    meta.set(Y_MAP_CONTENT_VERSION, version);
    meta.set(Y_MAP_SAVED_AT_VERSION, version);

    const fragment = doc.getXmlFragment("default");
    fragment.observeDeep(() => {
      version++;
      meta.set(Y_MAP_CONTENT_VERSION, version);
    });

    // Insert content — should increment version
    const text = new Y.XmlText("hello");
    fragment.insert(0, [text]);

    expect(meta.get(Y_MAP_CONTENT_VERSION)).toBeGreaterThan(0);
    expect(meta.get(Y_MAP_SAVED_AT_VERSION)).toBe(0);
  });

  it("marks clean when savedAtVersion catches up", () => {
    const doc = new Y.Doc();
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    let version = 0;
    meta.set(Y_MAP_CONTENT_VERSION, version);
    meta.set(Y_MAP_SAVED_AT_VERSION, version);

    const fragment = doc.getXmlFragment("default");
    fragment.observeDeep(() => {
      version++;
      meta.set(Y_MAP_CONTENT_VERSION, version);
    });

    fragment.insert(0, [new Y.XmlText("hello")]);
    expect(meta.get(Y_MAP_CONTENT_VERSION)).not.toBe(meta.get(Y_MAP_SAVED_AT_VERSION));

    // Simulate save
    meta.set(Y_MAP_SAVED_AT_VERSION, meta.get(Y_MAP_CONTENT_VERSION));
    expect(meta.get(Y_MAP_CONTENT_VERSION)).toBe(meta.get(Y_MAP_SAVED_AT_VERSION));
  });

  it("annotation map changes do not increment contentVersion", () => {
    const doc = new Y.Doc();
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    let version = 0;
    meta.set(Y_MAP_CONTENT_VERSION, version);
    meta.set(Y_MAP_SAVED_AT_VERSION, version);

    // Only observe the fragment, not the whole doc
    const fragment = doc.getXmlFragment("default");
    fragment.observeDeep(() => {
      version++;
      meta.set(Y_MAP_CONTENT_VERSION, version);
    });

    // Modify annotations map — should NOT increment version
    const annotations = doc.getMap("annotations");
    annotations.set("test-ann", { id: "test-ann", type: "comment" });

    expect(meta.get(Y_MAP_CONTENT_VERSION)).toBe(0);
  });
});
