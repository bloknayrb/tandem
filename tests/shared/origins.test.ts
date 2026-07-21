/**
 * Unit tests for the ADR-031 transaction wrappers. Validates that each
 * helper tags the underlying transaction with the expected origin string
 * and that the skip-set predicates match the matrix.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BROWSER_ORIGIN,
  FILE_SYNC_ORIGIN,
  INTERNAL_ORIGIN,
  MCP_ORIGIN,
  MODE_RELEASE_ORIGIN,
  RELOAD_ORIGIN,
  shouldSkipChannel,
  shouldSkipDurableSync,
  transactForTest,
  withBrowser,
  withFileSync,
  withInternal,
  withMcp,
  withModeRelease,
  withReload,
} from "../../src/shared/origins.js";

function captureOrigin<T>(doc: Y.Doc, run: () => T): { origin: unknown; result: T } {
  let captured: unknown;
  doc.on("afterTransaction", (txn: Y.Transaction) => {
    captured = txn.origin;
  });
  const result = run();
  return { origin: captured, result };
}

describe("origin wrappers tag transactions", () => {
  it("withMcp tags with 'mcp'", () => {
    const doc = new Y.Doc();
    const { origin } = captureOrigin(doc, () => withMcp(doc, () => doc.getMap("a").set("k", 1)));
    expect(origin).toBe(MCP_ORIGIN);
  });

  it("withFileSync tags with 'file-sync'", () => {
    const doc = new Y.Doc();
    const { origin } = captureOrigin(doc, () =>
      withFileSync(doc, () => doc.getMap("a").set("k", 1)),
    );
    expect(origin).toBe(FILE_SYNC_ORIGIN);
  });

  it("withInternal tags with 'internal'", () => {
    const doc = new Y.Doc();
    const { origin } = captureOrigin(doc, () =>
      withInternal(doc, () => doc.getMap("a").set("k", 1)),
    );
    expect(origin).toBe(INTERNAL_ORIGIN);
  });

  it("withReload tags with 'reload'", () => {
    const doc = new Y.Doc();
    const { origin } = captureOrigin(doc, () => withReload(doc, () => doc.getMap("a").set("k", 1)));
    expect(origin).toBe(RELOAD_ORIGIN);
  });

  it("withBrowser tags with 'browser'", () => {
    const doc = new Y.Doc();
    const { origin } = captureOrigin(doc, () =>
      withBrowser(doc, () => doc.getMap("a").set("k", 1)),
    );
    expect(origin).toBe(BROWSER_ORIGIN);
  });

  it("withModeRelease tags with 'mode-release'", () => {
    const doc = new Y.Doc();
    const { origin } = captureOrigin(doc, () =>
      withModeRelease(doc, () => doc.getMap("a").set("k", 1)),
    );
    expect(origin).toBe(MODE_RELEASE_ORIGIN);
  });

  it("returns the callback's value", () => {
    const doc = new Y.Doc();
    expect(withMcp(doc, () => 42)).toBe(42);
    expect(withFileSync(doc, () => "x")).toBe("x");
    expect(withInternal(doc, () => ({ a: 1 }))).toEqual({ a: 1 });
    expect(withReload(doc, () => null)).toBeNull();
    expect(withBrowser(doc, () => true)).toBe(true);
  });

  it("transactForTest tags with 'test'", () => {
    const doc = new Y.Doc();
    const { origin } = captureOrigin(doc, () =>
      transactForTest(doc, () => doc.getMap("a").set("k", 1)),
    );
    expect(origin).toBe("test");
  });
});

describe("skip-set predicates match the ADR-031 matrix", () => {
  it("channel skip = {mcp, file-sync, internal, reload, mode-release}", () => {
    expect(shouldSkipChannel(MCP_ORIGIN)).toBe(true);
    expect(shouldSkipChannel(FILE_SYNC_ORIGIN)).toBe(true);
    expect(shouldSkipChannel(INTERNAL_ORIGIN)).toBe(true);
    expect(shouldSkipChannel(RELOAD_ORIGIN)).toBe(true);
    expect(shouldSkipChannel(MODE_RELEASE_ORIGIN)).toBe(true);
    expect(shouldSkipChannel(BROWSER_ORIGIN)).toBe(false);
    expect(shouldSkipChannel(undefined)).toBe(false);
    expect(shouldSkipChannel(null)).toBe(false);
  });

  it("durable-sync skip = {file-sync, internal} — mode-release PERSISTS", () => {
    expect(shouldSkipDurableSync(MCP_ORIGIN)).toBe(false);
    expect(shouldSkipDurableSync(FILE_SYNC_ORIGIN)).toBe(true);
    expect(shouldSkipDurableSync(INTERNAL_ORIGIN)).toBe(true);
    expect(shouldSkipDurableSync(RELOAD_ORIGIN)).toBe(false);
    expect(shouldSkipDurableSync(BROWSER_ORIGIN)).toBe(false);
    // The cleared heldInSolo marker must reach disk so a restart won't re-hold.
    expect(shouldSkipDurableSync(MODE_RELEASE_ORIGIN)).toBe(false);
  });

  // Tombstone observer records for ALL origins — no skip predicate. The
  // per-origin behavioral coverage lives in tests/server/annotations/sync.test.ts
  // (FILE_SYNC: "FILE_SYNC-origin Y.Map.delete records a tombstone…",
  //  INTERNAL: "INTERNAL-origin Y.Map.delete records a tombstone…").
});
