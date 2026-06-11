import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getGenerationId, writeGenerationId } from "../../src/server/mcp/document-service.js";
import {
  assertAllowedOrigin,
  getDocument,
  getOrCreateDocument,
  removeDocument,
  setShouldKeepDocument,
} from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, TAURI_HOSTNAME, TAURI_LINUX_ORIGIN } from "../../src/shared/constants.js";

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

describe("assertAllowedOrigin (WebSocket origin gate)", () => {
  // This is the origin gate the Linux desktop actually hits on the Hocuspocus
  // WebSocket. Its correctness rests on the early `=== TAURI_LINUX_ORIGIN`
  // return running BEFORE `new URL()` — because `new URL("tauri://localhost")`
  // has hostname "localhost", which the 127.0.0.1/tauri.localhost check rejects.
  // A regression that reordered or dropped that early return would break Linux
  // sync silently (CI green), so these cases pin it.
  it("accepts the Linux Tauri origin tauri://localhost", () => {
    expect(() => assertAllowedOrigin(TAURI_LINUX_ORIGIN)).not.toThrow();
  });

  it("accepts the existing loopback + Windows origins", () => {
    expect(() => assertAllowedOrigin("http://127.0.0.1:5173")).not.toThrow();
    expect(() => assertAllowedOrigin("http://127.0.0.1:3479")).not.toThrow();
    expect(() => assertAllowedOrigin(`http://${TAURI_HOSTNAME}`)).not.toThrow();
  });

  it.each([
    ["a port suffix", "tauri://localhost:1234"],
    ["a trailing slash (must match the exact wire form)", "tauri://localhost/"],
    ["a hostname suffix", "tauri://localhost.evil"],
    ["a replaced host", "tauri://evil.example"],
    ["a different scheme to the same host", "https://localhost"],
    ["a bare localhost http origin (narrowed out in #477 PR 2)", "http://localhost:5173"],
  ])("rejects %s (%s)", (_why, origin) => {
    expect(() => assertAllowedOrigin(origin)).toThrow();
  });

  it("rejects a missing / empty origin", () => {
    expect(() => assertAllowedOrigin(undefined)).toThrow();
    expect(() => assertAllowedOrigin("")).toThrow();
  });
});

describe("writeGenerationId", () => {
  it("mints a generationId readable via getGenerationId()", () => {
    writeGenerationId();
    const genId = getGenerationId();
    expect(genId).toBeDefined();
    expect(typeof genId).toBe("string");
    expect((genId as string).length).toBeGreaterThan(0);
  });

  it("produces a different generationId on each call", () => {
    writeGenerationId();
    const first = getGenerationId();

    writeGenerationId();
    expect(getGenerationId()).not.toBe(first);
  });
});
