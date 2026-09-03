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
 *
 * The two describes after those three are not about origins. They are the rest
 * of `documents/watcher.ts`'s reload wiring, and they live here because this is
 * the file that already drives a real `openFromDisk` + captured watcher
 * callback: the sanitization relay that runs over every stored annotation on a
 * reload, and the catch that keeps a watch that cannot be registered from
 * taking the open down with it.
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

import { docHash } from "../../src/server/annotations/doc-hash.js";
import { resetMigrationLog } from "../../src/server/annotations/migration-log.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { wireFileWatcher } from "../../src/server/documents/watcher.js";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { anchoredRange, refreshRange } from "../../src/server/positions.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { MCP_ORIGIN, RELOAD_ORIGIN, shouldSkipDurableSync } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types.js";
import { asChangedKey, listenForTransactions } from "../helpers/yjs-transactions.js";

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

async function setupOpenedFile(initialText: string): Promise<{
  filePath: string;
  doc: Y.Doc;
  triggerReload: () => Promise<void>;
}> {
  const filePath = path.join(tmpDir, "doc.md");
  await fs.writeFile(filePath, initialText, "utf-8");
  await openFromDisk(filePath);

  const docId = docIdFromPath(filePath);
  const doc = getOrCreateDocument(docId);

  // The watcher mock captured the (filePath, callback) — driving the callback
  // is exactly what fs.watch does on a real on-disk change.
  const lastCall = watcherMocks.watchFile.mock.calls.at(-1);
  if (!lastCall) throw new Error("watchFile was not called by openFromDisk");
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
      (r) => r.origin === RELOAD_ORIGIN && r.changedTypes.has(asChangedKey(annMapRef)),
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
      (r) => r.origin === RELOAD_ORIGIN && r.changedTypes.has(asChangedKey(annMapRef)),
    );

    expect(reloadAnnotationWrites).toHaveLength(1);

    // The reload's content-clearing transact also runs under RELOAD_ORIGIN
    // (touches the XmlFragment but not Y_MAP_ANNOTATIONS) — so at least
    // two RELOAD_ORIGIN transacts fire.
    const reloadTxns = records.filter((r) => r.origin === RELOAD_ORIGIN);
    expect(reloadTxns.length).toBeGreaterThanOrEqual(2);
  });
});

/** Every line `fn` printed to `console.error`, flattened. */
async function capturedErrors(fn: () => Promise<void>): Promise<string[]> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await fn();
    return spy.mock.calls.map((args) => args.map((a) => String(a)).join(" "));
  } finally {
    spy.mockRestore();
  }
}

describe("reloadFromDisk — legacy annotations are sanitized under THIS document's hash", () => {
  it("relays a flag→note migration keyed to the reloaded document, not anonymously", async () => {
    // Step 3 of the reload sanitizes every stored annotation, and hands
    // `sanitizeAnnotation` an `onLossy` that relays through the migration log.
    // The relay's dedup key is `${docHash}:${kind}`, so passing `undefined`
    // there instead of the reloaded document's hash still logs — it just logs
    // "(no docHash)" and dedups nothing, which is why asserting that SOMETHING
    // was written would not discriminate. The hash in the line is the contract.
    resetMigrationLog();
    const { doc, filePath, triggerReload } = await setupOpenedFile("Hello world foo bar");

    // The reload is the first thing to see this record, so the migration log
    // has not already fired (and been deduped) for this (doc, kind) pair.
    const watchedPath = watcherMocks.watchFile.mock.calls.at(-1)?.[0] as string;
    const id = "ann_legacy_flag";
    doc.transact(() => {
      doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, {
        id,
        author: "user",
        // The pre-v1 type. `sanitizeAnnotation` rewrites it to "note" and emits
        // `flag-to-note` on the way past.
        type: "flag",
        range: { from: toFlatOffset(0), to: toFlatOffset(5) },
        content: "legacy flag",
        status: "pending",
        timestamp: 0,
        rev: 1,
      } as unknown as Annotation);
    }, MCP_ORIGIN);

    const errors = await capturedErrors(async () => {
      await fs.writeFile(filePath, "Hello brave world foo bar", "utf-8");
      await triggerReload();
    });

    expect(errors).toContain(
      `[ANNOTATION-STORE] legacy migration: flag-to-note in ${docHash(watchedPath)}`,
    );
    // The rewrite the log is a receipt for actually reached the Y.Map, so the
    // line is evidence of a migration rather than of a discarded copy.
    expect((doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).get(id) as Annotation).type).toBe("note");
  });
});

describe("wireFileWatcher — a watch that cannot be registered", () => {
  it("does not abort the open that asked for it, and names the file it failed on", async () => {
    // `watchFile` throws for real: EMFILE, and on Windows an inaccessible
    // directory. The catch around it is the reason an open still completes —
    // without it `openFromDisk` rejects and the user gets no document at all,
    // rather than a document with no watcher.
    const filePath = path.join(tmpDir, "unwatchable.md");
    await fs.writeFile(filePath, "Body text that must survive\n", "utf-8");
    const boom = new Error("EMFILE: too many open files");
    watcherMocks.watchFile.mockImplementationOnce(() => {
      throw boom;
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(openFromDisk(filePath)).resolves.toBeDefined();
      const reported = spy.mock.calls.find(
        (args) => args[0] === "[FileWatcher] wireFileWatcher failed for %s:",
      );
      expect(reported, "the failure is reported, not swallowed silently").toBeDefined();
      expect(String(reported?.[1])).toContain("unwatchable.md");
      // The original error, not a re-wrapped one: it is the only thing that
      // says WHY the watch could not be registered.
      expect(reported?.[2]).toBe(boom);
    } finally {
      spy.mockRestore();
    }

    // The document is genuinely open and populated — the throw cost the watch,
    // nothing else.
    const opened = getOrCreateDocument(docIdFromPath(filePath));
    expect(extractText(opened)).toContain("Body text that must survive");
  });

  it("is reached through wireFileWatcher itself, not only through openFromDisk", async () => {
    // The direct call, so a future open path that stops wiring the watcher
    // cannot quietly take this arm out of the suite with it.
    const boom = new Error("watch registration refused");
    watcherMocks.watchFile.mockImplementationOnce(() => {
      throw boom;
    });
    const errors = await capturedErrors(async () => {
      expect(() =>
        wireFileWatcher("doc_direct", path.join(tmpDir, "direct.md"), "md"),
      ).not.toThrow();
    });
    expect(errors.some((line) => line.includes("[FileWatcher] wireFileWatcher failed for"))).toBe(
      true,
    );
  });
});
