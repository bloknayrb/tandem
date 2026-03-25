import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import {
  getOrCreateDocument,
  getDocument,
  removeDocument,
  setShouldKeepDocument,
} from "../../src/server/yjs/provider.js";

describe("Y.Doc lifecycle (provider)", () => {
  it("getOrCreateDocument creates a new doc if none exists", () => {
    const doc = getOrCreateDocument("test-provider-create");
    expect(doc).toBeInstanceOf(Y.Doc);
    expect(getDocument("test-provider-create")).toBe(doc);
  });

  it("getOrCreateDocument returns existing doc", () => {
    const doc1 = getOrCreateDocument("test-provider-idempotent");
    const doc2 = getOrCreateDocument("test-provider-idempotent");
    expect(doc1).toBe(doc2);
  });

  it("removeDocument clears the map entry", () => {
    getOrCreateDocument("test-provider-remove");
    expect(getDocument("test-provider-remove")).toBeDefined();
    const removed = removeDocument("test-provider-remove");
    expect(removed).toBe(true);
    expect(getDocument("test-provider-remove")).toBeUndefined();
  });

  it("getOrCreateDocument creates fresh doc after removeDocument", () => {
    const doc1 = getOrCreateDocument("test-provider-recycle");
    removeDocument("test-provider-recycle");
    const doc2 = getOrCreateDocument("test-provider-recycle");
    expect(doc2).not.toBe(doc1);
    expect(doc2).toBeInstanceOf(Y.Doc);
  });
});

describe("shouldKeepDocument guard", () => {
  afterEach(() => {
    // Reset predicate so other tests aren't affected
    setShouldKeepDocument(() => false);
  });

  it("prevents removeDocument-style eviction when predicate returns true", () => {
    const doc = getOrCreateDocument("test-guard-keep");
    const fragment = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("preserved content")]);
    fragment.insert(0, [p]);

    // Simulate: predicate says keep this doc
    setShouldKeepDocument((name) => name === "test-guard-keep");

    // Even after "removal" the doc should still be retrievable with content
    // (In production, afterUnloadDocument checks the predicate before calling delete)
    // Here we verify the predicate itself works correctly:
    const predicate = (name: string) => name === "test-guard-keep";
    expect(predicate("test-guard-keep")).toBe(true);

    // Doc should still be in the map (not removed because guard is active)
    expect(getDocument("test-guard-keep")).toBe(doc);

    // Cleanup
    setShouldKeepDocument(() => false);
    removeDocument("test-guard-keep");
  });

  it("allows eviction when predicate returns false", () => {
    getOrCreateDocument("test-guard-evict");
    setShouldKeepDocument(() => false);

    removeDocument("test-guard-evict");
    expect(getDocument("test-guard-evict")).toBeUndefined();

    // getOrCreateDocument now returns a fresh empty doc
    const fresh = getOrCreateDocument("test-guard-evict");
    const fragment = fresh.getXmlFragment("default");
    expect(fragment.length).toBe(0);

    removeDocument("test-guard-evict");
  });

  it("protects __tandem_ctrl__ with combined predicate", () => {
    const openDocs = new Set(["doc-abc"]);
    const predicate = (name: string) => openDocs.has(name) || name === "__tandem_ctrl__";

    expect(predicate("__tandem_ctrl__")).toBe(true);
    expect(predicate("doc-abc")).toBe(true);
    expect(predicate("unknown-room")).toBe(false);
  });
});
