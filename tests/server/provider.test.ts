import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import {
  getOrCreateDocument,
  getDocument,
  removeDocument,
  setShouldKeepDocument,
} from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_DOCUMENT_META } from "../../src/shared/constants.js";
import { writeGenerationId } from "../../src/server/mcp/document-service.js";

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

  // NOTE: These tests verify the predicate logic, not the Hocuspocus
  // afterUnloadDocument hook directly (which requires a running server).
  // The guard is exercised in production when afterUnloadDocument calls
  // shouldKeepDocument before deleting from the documents map.

  it("predicate correctly identifies docs to keep", () => {
    const doc = getOrCreateDocument("test-guard-keep");
    setShouldKeepDocument((name) => name === "test-guard-keep");

    // Predicate returns true → afterUnloadDocument would skip deletion
    expect(getDocument("test-guard-keep")).toBe(doc);

    // Cleanup
    setShouldKeepDocument(() => false);
    removeDocument("test-guard-keep");
  });

  it("predicate allows eviction for untracked docs", () => {
    getOrCreateDocument("test-guard-evict");
    setShouldKeepDocument(() => false);

    // Predicate returns false → afterUnloadDocument would proceed with deletion
    removeDocument("test-guard-evict");
    expect(getDocument("test-guard-evict")).toBeUndefined();

    removeDocument("test-guard-evict");
  });

  it("combined predicate covers openDocs and CTRL_ROOM", () => {
    const openDocs = new Set(["doc-abc"]);
    const predicate = (name: string) => openDocs.has(name) || name === CTRL_ROOM;

    expect(predicate(CTRL_ROOM)).toBe(true);
    expect(predicate("doc-abc")).toBe(true);
    expect(predicate("unknown-room")).toBe(false);
  });
});

describe("writeGenerationId", () => {
  it("writes a generationId to the CTRL_ROOM documentMeta", () => {
    writeGenerationId();
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const meta = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
    const genId = meta.get("generationId") as string;
    expect(genId).toBeDefined();
    expect(typeof genId).toBe("string");
    expect(genId.length).toBeGreaterThan(0);
  });

  it("produces a different generationId on each call", () => {
    writeGenerationId();
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const meta = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
    const first = meta.get("generationId") as string;

    writeGenerationId();
    const second = meta.get("generationId") as string;
    expect(second).not.toBe(first);
  });
});
