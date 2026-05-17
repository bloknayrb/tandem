/**
 * Regression tests for the PR-A1 split-transaction fix in `reloadFromDisk`
 * (commit 8d9c0ce; CRDT-reviewer catch).
 *
 * `reloadFromDisk` runs TWO transactions:
 *   1. FILE_SYNC_ORIGIN — clears awareness + reloads content. Durable-sync
 *      observer skips this (file just came from disk; nothing to persist).
 *   2. MCP_ORIGIN — relocates stale annotation ranges via textSnapshot.
 *      Durable-sync observer MUST see this so the relocated ranges persist.
 *
 * Test B (origin sequence) is the tighter regression guard — it would fail
 * the moment someone flips transaction (2) back to FILE_SYNC_ORIGIN, even
 * if no real durable-sync wiring is present.
 *
 * Test A (mimicked durable-sync observer) is the behavior contract — it
 * proves that an observer with the production skip rule actually receives
 * the relocation write.
 *
 * Related GH issue: #622 (pre-existing two-write crash window). The fix
 * merges the two MCP_ORIGIN transactions into one via `skipTransact` —
 * Test C below is the dedicated single-transaction regression guard.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const cryptoMod = await import("node:crypto");
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-test-reload-${cryptoMod.randomUUID()}`);
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return {
    ...original,
    SESSION_DIR: pathMod.join(appDataDir, "sessions"),
  };
});

// Capture the watcher callback so we can drive reloadFromDisk synchronously
// from the test without depending on real fs.watch timing.
const watcherMocks = vi.hoisted(() => ({ watchFile: vi.fn() }));
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: watcherMocks.watchFile,
}));

vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/notifications.js")>();
  return { ...actual, pushNotification: vi.fn() };
});

import { MCP_ORIGIN } from "../../src/server/events/queue.js";
import { docIdFromPath } from "../../src/server/mcp/document-model.js";
import { getOpenDocs, removeDoc, setActiveDocId } from "../../src/server/mcp/document-service.js";
import { openFileByPath } from "../../src/server/mcp/file-opener.js";
import { anchoredRange, refreshRange } from "../../src/server/positions.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { RELOAD_ORIGIN, shouldSkipDurableSync } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types.js";

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-reload-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
});

interface TxnRecord {
  origin: unknown;
  changedTypes: Set<Y.AbstractType<unknown>>;
}

function listenForTransactions(doc: Y.Doc): { records: TxnRecord[]; detach: () => void } {
  const records: TxnRecord[] = [];
  const listener = (txn: {
    origin: unknown;
    changed: Map<Y.AbstractType<unknown>, Set<string | null>>;
  }) => {
    records.push({ origin: txn.origin, changedTypes: new Set(txn.changed.keys()) });
  };
  doc.on("afterTransaction", listener);
  return { records, detach: () => doc.off("afterTransaction", listener) };
}

async function setupOpenedFile(initialText: string): Promise<{
  filePath: string;
  doc: Y.Doc;
  triggerReload: () => Promise<void>;
}> {
  const filePath = path.join(tmpDir, "doc.md");
  await fs.writeFile(filePath, initialText, "utf-8");
  await openFileByPath(filePath);

  const docId = docIdFromPath(filePath);
  const doc = getOrCreateDocument(docId);

  // The watcher mock captured the (filePath, callback) — driving the callback
  // is exactly what fs.watch does on a real on-disk change.
  const lastCall = watcherMocks.watchFile.mock.calls.at(-1);
  if (!lastCall) throw new Error("watchFile was not called by openFileByPath");
  const onChanged = lastCall[1] as (p: string) => Promise<void>;
  const triggerReload = async () => {
    await onChanged(filePath);
  };

  return { filePath, doc, triggerReload };
}

function seedAnnotationOnText(doc: Y.Doc, snapshot: string, content: string): string {
  const text = doc
    .getXmlFragment("default")
    .toString()
    .replace(/<[^>]+>/g, "");
  const idx = text.indexOf(snapshot);
  if (idx < 0) throw new Error(`snapshot "${snapshot}" not found in doc text`);

  const result = anchoredRange(
    doc,
    toFlatOffset(idx),
    toFlatOffset(idx + snapshot.length),
    snapshot,
  );
  if (!result.ok) throw new Error(`anchoredRange failed for "${snapshot}"`);

  const id = `ann_reload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ann: Annotation = {
    id,
    author: "user",
    type: "comment",
    range: result.range,
    ...(result.fullyAnchored ? { relRange: result.relRange } : {}),
    content,
    status: "pending",
    timestamp: Date.now(),
    textSnapshot: snapshot,
    rev: 1,
  };
  const map = doc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
  doc.transact(() => map.set(id, ann), MCP_ORIGIN);
  return id;
}

describe("reloadFromDisk — origin sequence + persistence (PR-F1)", () => {
  it("Test B: reload runs ≥2 RELOAD_ORIGIN transactions; ≥1 touches Y_MAP_ANNOTATIONS", async () => {
    const { doc, filePath, triggerReload } = await setupOpenedFile("Hello world foo bar");

    // Seed an annotation on "foo" so the relocation pass has work to do.
    const annId = seedAnnotationOnText(doc, "foo", "annotation on foo");

    // Move "foo" to a new offset on disk so textSnapshot-based relocation
    // is exercised. We add a prefix so "foo" still appears in the doc text.
    await fs.writeFile(filePath, "Greetings, world — foo bar\n", "utf-8");

    // Start capture AFTER the seed write so the watcher's two reload
    // transactions are the only ones recorded.
    const { records, detach } = listenForTransactions(doc);
    try {
      await triggerReload();
    } finally {
      detach();
    }

    const reloadRecords = records;
    expect(reloadRecords.length).toBeGreaterThanOrEqual(2);

    // First transaction: RELOAD_ORIGIN — content + awareness clear (ADR-031).
    const first = reloadRecords[0];
    expect(first.origin).toBe(RELOAD_ORIGIN);

    // At least one RELOAD_ORIGIN transact must mutate the annotations Y.Map
    // (the relocation pass). Using ref-equality on the map instance, NOT
    // constructor.name (all YMap variants share name).
    const annMapRef = doc.getMap(Y_MAP_ANNOTATIONS);
    const reloadAnnotationWrites = reloadRecords.filter(
      (r) => r.origin === RELOAD_ORIGIN && r.changedTypes.has(annMapRef),
    );
    expect(reloadAnnotationWrites.length).toBeGreaterThanOrEqual(1);

    // Sanity: the seeded annotation still exists post-reload, and its range
    // is refreshable (proves the annotation Y.Map entry survived).
    const updated = annMapRef.get(annId) as Annotation | undefined;
    expect(updated).toBeDefined();
    if (updated) {
      const refreshed = refreshRange(updated, doc, annMapRef);
      expect(refreshed).not.toBeNull();
    }
  });

  it("Test A: durable-sync-shaped observer fires for the relocation transact", async () => {
    const { doc, filePath, triggerReload } = await setupOpenedFile(
      "Once upon a time the brown fox jumped.",
    );

    seedAnnotationOnText(doc, "brown", "comment on brown");

    // Mimic registerAnnotationObserver's contract: an observer on
    // Y_MAP_ANNOTATIONS that uses the production ADR-031 durable-sync skip
    // rule (skip file-sync + internal; persist mcp / reload / browser).
    // The relocation transact MUST fire this observer; if it is flipped to
    // a skipped origin, durable persistence silently fails.
    const annMap = doc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
    let observedPersistableWrites = 0;
    let lastObservedRange: Annotation["range"] | undefined;
    const observer = (_ev: Y.YMapEvent<Annotation>, txn: Y.Transaction): void => {
      if (shouldSkipDurableSync(txn.origin)) return;
      observedPersistableWrites++;
      for (const [, ann] of annMap.entries()) {
        lastObservedRange = ann.range;
      }
    };
    annMap.observe(observer);

    try {
      // Move "brown" to a new offset on disk so the relocation pass writes.
      await fs.writeFile(filePath, "A long time ago, the brown fox jumped.\n", "utf-8");
      await triggerReload();
    } finally {
      annMap.unobserve(observer);
    }

    expect(observedPersistableWrites).toBeGreaterThanOrEqual(1);
    expect(lastObservedRange).toBeDefined();
  });

  it("Test C (#622): exactly ONE RELOAD_ORIGIN transaction writes to Y_MAP_ANNOTATIONS during reload", async () => {
    // Closes the two-write crash window: refreshAllRanges + textSnapshot
    // relocation are merged into a single transact via `skipTransact: true`,
    // both wrapped in `withReload` (ADR-031). A process kill between the
    // two passes can no longer leave annotations durably stored at
    // partially-refreshed ranges.
    const { doc, filePath, triggerReload } = await setupOpenedFile("Hello world foo bar baz");

    // Seed an annotation on "foo" so both passes have work to do (refresh +
    // textSnapshot relocation, since we move "foo" on disk below).
    seedAnnotationOnText(doc, "foo", "annotation on foo");

    // Move "foo" to a different offset so relocation actually runs.
    await fs.writeFile(filePath, "Greetings, world — foo bar baz\n", "utf-8");

    const { records, detach } = listenForTransactions(doc);
    try {
      await triggerReload();
    } finally {
      detach();
    }

    const annMapRef = doc.getMap(Y_MAP_ANNOTATIONS);
    const reloadAnnotationWrites = records.filter(
      (r) => r.origin === RELOAD_ORIGIN && r.changedTypes.has(annMapRef),
    );

    expect(reloadAnnotationWrites).toHaveLength(1);

    // The reload's content-clearing transact also runs under RELOAD_ORIGIN
    // (touches the XmlFragment but not Y_MAP_ANNOTATIONS) — so at least
    // two RELOAD_ORIGIN transacts fire.
    const reloadTxns = records.filter((r) => r.origin === RELOAD_ORIGIN);
    expect(reloadTxns.length).toBeGreaterThanOrEqual(2);
  });
});
