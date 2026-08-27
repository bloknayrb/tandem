/**
 * Behavioural characterization of every file-open entry path (ADR-034, Unit 6).
 *
 * Written BEFORE the production callers are redirected from
 * `mcp/file-opener.ts` through `documents/open.ts`, and deliberately pinning
 * *outcomes and side effects* rather than which function was called. A redirect
 * is behaviour-preserving only if these stay green without being edited.
 *
 * Each case here exists because the pre-code review identified it as something
 * the existing suite is structurally blind to — a redirect could break it and
 * every current test would still pass:
 *
 *   - **Broadcast count.** Nothing counted `documentMeta` writes on an open. A
 *     wrapper in `documents/open.ts` that helpfully called `activateDocument`
 *     after `openFromDisk` passes every existing test while advancing the
 *     activation epoch twice, which the client reads as a second focus event
 *     and uses to override a tab switch the user made in between.
 *   - **Populate before wiring the annotation store.** Invisible on a clean
 *     store: with no envelope on disk `loadAndMerge` has nothing to re-anchor,
 *     so wiring early produces identical output. It needs a REAL envelope with
 *     real offsets, and it must assert the offsets survive — not that wiring
 *     happened. `file-opener-lifecycle.test.ts` only asserts
 *     `setFileSyncContext` was called with the doc id.
 *   - **The saved-at baseline VALUE.** Disk open uses the file's mtime; upload
 *     and scratchpad use `Date.now()`. No test asserts the value, only that
 *     opens succeed — so "normalizing" the split changes autosave's
 *     external-modification guard on any file whose mtime is in the past.
 *   - **Error-path identity.** HTTP status and MCP error code are both derived
 *     from the thrown `err.code`. Any wrapping — even a `try`/`catch` that
 *     rethrows a new Error — silently changes both.
 *   - **Scratchpad's populate bypass.** It calls `adapter.apply` directly
 *     rather than going through `populateDocFromContent`, so it is the one
 *     path where a "unification" could quietly lose the attach-before-populate
 *     ordering that keeps segment order correct.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-adr034-${cryptoMod.randomUUID()}`);
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});

// Real fs.watch leaks handles and races the tests' own writes. The open paths
// only need this to be callable.
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

import { docHash } from "../../src/server/annotations/doc-hash.js";
import { createStore, resetForTesting as storeReset } from "../../src/server/annotations/store.js";
import { getActiveDocId } from "../../src/server/documents/registry.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { watchFile } from "../../src/server/file-watcher.js";
import { extractText, restoreOpenDocuments } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import {
  openFileByPath,
  openFileFromContent,
  openScratchpad,
} from "../../src/server/mcp/file-opener.js";
import {
  getBuffer,
  resetForTesting as notificationsReset,
} from "../../src/server/notifications.js";
import { SESSION_DIR } from "../../src/server/platform.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  CHARS_PER_PAGE,
  CTRL_ROOM,
  LARGE_FILE_PAGE_THRESHOLD,
  VERY_LARGE_FILE_PAGE_THRESHOLD,
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_SAVED_AT_VERSION,
} from "../../src/shared/constants.js";

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) {
    removeDoc(id);
    removeDocument(id);
  }
  setActiveDocId(null);
  storeReset();
  notificationsReset();
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-adr034-"));
  // SESSION_DIR is shared across the whole file while tmpDir is per-test, so a
  // session written by one case would be restored by the next and silently
  // inflate its counts.
  await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
});

/** Count transactions on a room, so "exactly one broadcast" is measurable. */
function watchTransactions(doc: Y.Doc) {
  let count = 0;
  doc.on("afterTransaction", () => {
    count += 1;
  });
  return () => count;
}

// ---------------------------------------------------------------------------
// Exactly one documentMeta broadcast per open
// ---------------------------------------------------------------------------

describe("one open, one broadcast", () => {
  // `broadcastOpenDocs` writes into CTRL_ROOM *and* every open document's room,
  // so a duplicate is not cosmetic — it is N+1 extra Y.Doc transactions and a
  // second activation-epoch advance.

  it("publishes once for a fresh disk open", async () => {
    const filePath = path.join(tmpDir, "fresh.md");
    await fs.writeFile(filePath, "# Fresh\n\nBody.\n");

    const ctrlWrites = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const result = await openFileByPath(filePath);

    expect(result.documentId, "control: the open actually succeeded").toBeTruthy();
    expect(ctrlWrites(), "exactly one documentMeta publish").toBe(1);
  });

  it("publishes once for an upload", async () => {
    const ctrlWrites = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const result = await openFileFromContent("uploaded.md", "# Uploaded\n");

    expect(result.documentId).toBeTruthy();
    expect(ctrlWrites(), "exactly one documentMeta publish").toBe(1);
  });

  it("publishes once for a scratchpad", async () => {
    const ctrlWrites = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const result = await openScratchpad("# Scratch\n");

    expect(result.documentId).toBeTruthy();
    expect(ctrlWrites(), "exactly one documentMeta publish").toBe(1);
  });

  it("publishes once when re-opening an already-open document", async () => {
    const filePath = path.join(tmpDir, "again.md");
    await fs.writeFile(filePath, "# Again\n");
    await openFileByPath(filePath);

    const ctrlWrites = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const result = await openFileByPath(filePath);

    expect(result.alreadyOpen, "control: this is the already-open branch").toBe(true);
    expect(ctrlWrites(), "a re-open is still exactly one publish").toBe(1);
  });

  it("publishes once for a force reload", async () => {
    const filePath = path.join(tmpDir, "forced.md");
    await fs.writeFile(filePath, "# Before\n");
    await openFileByPath(filePath);
    await fs.writeFile(filePath, "# After\n");

    const ctrlWrites = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const result = await openFileByPath(filePath, { force: true });

    expect(result.forceReloaded, "control: this is the force branch").toBe(true);
    expect(ctrlWrites(), "a force reload is still exactly one publish").toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The annotation store is wired AFTER the Y.Doc is populated
// ---------------------------------------------------------------------------

describe("durable annotations survive an open", () => {
  it("re-anchors a stored annotation against populated content, not an empty doc", async () => {
    // The ordering this protects: populate → wireAnnotationStore. Inverted,
    // `loadAndMerge` runs `refreshRange` against an EMPTY XmlFragment, every
    // stored range resolves to nothing, the dead-relRange strip fires, and the
    // re-anchored garbage is then durably persisted. On a clean store the
    // inversion is invisible, which is why this writes a real envelope first.
    const filePath = path.join(tmpDir, "annotated.md");
    const body = "# Title\n\nThe quick brown fox jumps over the lazy dog.\n";
    await fs.writeFile(filePath, body);

    // The envelope's offsets are taken from the REAL flat-text coordinate
    // system, by opening once and reading it back, rather than from this
    // test's own model of how blocks are joined. Computing them from the file
    // bytes is off by one — flat text separates blocks with a single newline —
    // and a fixture built from my model would be testing the model, not the
    // property under test, which is that the offsets SURVIVE the second open.
    const probe = await openFileByPath(filePath);
    const flat = extractText(getOrCreateDocument(probe.documentId));
    const start = flat.indexOf("quick brown fox");
    const end = start + "quick brown fox".length;
    expect(start, "control: the fixture text is where the test thinks").toBeGreaterThan(0);

    // Drop the probe so the second open is a genuine cold open against the
    // envelope written below, not the already-open branch.
    removeDoc(probe.documentId);
    removeDocument(probe.documentId);
    setActiveDocId(null);
    storeReset();

    const hash = docHash(filePath);
    const store = createStore(hash, { filePath });
    store.queueWrite(() => ({
      schemaVersion: 1,
      docHash: hash,
      meta: { filePath, lastUpdated: Date.now() },
      annotations: [
        {
          id: "anno-1",
          author: "user",
          type: "highlight",
          range: { from: start, to: end },
          content: "",
          status: "pending",
          timestamp: Date.now(),
          textSnapshot: "quick brown fox",
          color: "yellow",
          rev: 1,
        },
      ],
      tombstones: [],
      replies: [],
    }));
    await store.flush();

    const result = await openFileByPath(filePath);
    const doc = getOrCreateDocument(result.documentId);
    const annotations = doc.getMap(Y_MAP_ANNOTATIONS);

    const loaded = annotations.get("anno-1") as { range: { from: number; to: number } };
    expect(loaded, "the stored annotation reached the Y.Map").toBeDefined();

    // The offsets must still select the same words. Asserting the TEXT rather
    // than the numbers is what makes this survive a legitimate re-anchor.
    const text = extractText(doc);
    expect(
      text.slice(loaded.range.from, loaded.range.to),
      "the annotation still covers the words it was anchored to",
    ).toBe("quick brown fox");
  });
});

// ---------------------------------------------------------------------------
// The saved-at baseline value differs by entry path, on purpose
// ---------------------------------------------------------------------------

describe("saved-at baseline", () => {
  function savedAt(documentId: string): number | undefined {
    return getOrCreateDocument(documentId)
      .getMap(Y_MAP_DOCUMENT_META)
      .get(Y_MAP_SAVED_AT_VERSION) as number | undefined;
  }

  it("uses the file's mtime for a disk open, not the wall clock", async () => {
    // Load-bearing: autosave's external-modification guard compares disk mtime
    // against this. Replacing it with `Date.now()` on a file whose mtime is in
    // the past changes when a save is refused — and no existing test asserts
    // the VALUE, only that opens succeed.
    const filePath = path.join(tmpDir, "mtime.md");
    await fs.writeFile(filePath, "# Mtime\n");
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(filePath, past, past);
    const stat = await fs.stat(filePath);

    const result = await openFileByPath(filePath);

    expect(savedAt(result.documentId)).toBe(stat.mtimeMs);
    expect(savedAt(result.documentId), "…which is NOT the wall clock").toBeLessThan(
      Date.now() - 30_000,
    );
  });

  it("uses the wall clock for an upload, which has no file to stat", async () => {
    const before = Date.now();
    const result = await openFileFromContent("no-file.md", "# Upload\n");

    const value = savedAt(result.documentId);
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });
});

// ---------------------------------------------------------------------------
// Scratchpad populates through the adapter directly — segment order must hold
// ---------------------------------------------------------------------------

describe("scratchpad content population", () => {
  it("keeps multi-block markdown in source order", async () => {
    // Scratchpad bypasses `populateDocFromContent` and calls `adapter.apply`
    // inline. The attach-before-populate rule lives inside the adapter, and a
    // detached Y.XmlText reverses segment order — so this is the path where a
    // "unification" could silently scramble a seeded buffer.
    const seeded = ["# Heading", "", "First paragraph.", "", "- one", "- two", ""].join("\n");
    const result = await openScratchpad(seeded);

    const text = extractText(getOrCreateDocument(result.documentId));

    expect(text.indexOf("Heading"), "control: the content actually landed").toBeGreaterThanOrEqual(
      0,
    );
    expect(text.indexOf("Heading")).toBeLessThan(text.indexOf("First paragraph."));
    expect(text.indexOf("First paragraph.")).toBeLessThan(text.indexOf("one"));
    expect(text.indexOf("one")).toBeLessThan(text.indexOf("two"));
  });
});

// ---------------------------------------------------------------------------
// Failure identity — the thrown `code` IS the HTTP status and MCP error code
// ---------------------------------------------------------------------------

describe("open failures keep their error codes", () => {
  // `errorCodeToHttpStatus` and `tandem_open`'s catch both branch on
  // `err.code`. A wrapper that rethrows a new Error changes the HTTP status
  // and the MCP error code without changing a single assertion elsewhere.

  async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await fn();
    } catch (err) {
      return (err as NodeJS.ErrnoException).code;
    }
    return undefined;
  }

  it("a missing path throws ENOENT (→ HTTP 404, MCP FILE_NOT_FOUND)", async () => {
    const code = await codeOf(() => openFileByPath(path.join(tmpDir, "nope.md")));
    expect(code).toBe("ENOENT");
  });

  it("an unsupported extension throws UNSUPPORTED_FORMAT (→ 400, FORMAT_ERROR)", async () => {
    const filePath = path.join(tmpDir, "binary.exe");
    await fs.writeFile(filePath, "MZ");
    expect(await codeOf(() => openFileByPath(filePath))).toBe("UNSUPPORTED_FORMAT");
  });

  it("an unsupported upload extension throws UNSUPPORTED_FORMAT", async () => {
    expect(await codeOf(() => openFileFromContent("payload.exe", "MZ"))).toBe("UNSUPPORTED_FORMAT");
  });

  it("a UNC path throws INVALID_PATH (→ 400) before any filesystem call", async () => {
    // The ordering matters as much as the code: `is_file()` on a UNC path
    // performs the SMB handshake the check exists to prevent.
    expect(await codeOf(() => openFileByPath("\\\\attacker.example\\share\\doc.md"))).toBe(
      "INVALID_PATH",
    );
  });
});

// ---------------------------------------------------------------------------
// Warnings ride on SUCCESSFUL opens, not just failures
// ---------------------------------------------------------------------------

describe("large-document warnings", () => {
  // `buildResult` attaches these to every success path. Unit 7b's sketched
  // `OpenResult` union puts `warnings` only on the `failed` arm, which would
  // drop them silently — nothing else asserts they exist.

  function pagesOf(chars: number): string {
    return "x".repeat(chars);
  }

  it("attaches no warning to an ordinary document", async () => {
    const filePath = path.join(tmpDir, "small.md");
    await fs.writeFile(filePath, "# Small\n\nShort body.\n");

    const result = await openFileByPath(filePath);
    expect(result.warnings ?? [], "control: the threshold is not always tripped").toEqual([]);
  });

  it("warns on a large document and keeps the open successful", async () => {
    const filePath = path.join(tmpDir, "large.md");
    await fs.writeFile(filePath, pagesOf(LARGE_FILE_PAGE_THRESHOLD * CHARS_PER_PAGE));

    const result = await openFileByPath(filePath);

    expect(result.documentId, "the open still succeeds — a warning is not a failure").toBeTruthy();
    expect(result.warnings?.join(" ")).toMatch(/Large document/);
    expect(result.warnings?.join(" "), "…and not the very-large wording").not.toMatch(/Very large/);
  });

  it("escalates the wording past the very-large threshold", async () => {
    const filePath = path.join(tmpDir, "huge.md");
    await fs.writeFile(filePath, pagesOf(VERY_LARGE_FILE_PAGE_THRESHOLD * CHARS_PER_PAGE));

    const result = await openFileByPath(filePath);
    expect(result.warnings?.join(" ")).toMatch(/Very large document/);
  });
});

// ---------------------------------------------------------------------------
// Force reload: the failure leaves the document open
// ---------------------------------------------------------------------------

describe("force reload failures", () => {
  it("throws ENOENT and leaves the existing document open and untouched", async () => {
    // The force branch validates the path before it touches the open document,
    // so a file deleted underneath a tab fails without destroying the buffer
    // the user still has on screen. A refactor that cleared state first — or
    // that unregistered the doc in a `catch` — would lose unsaved work with no
    // test noticing.
    const filePath = path.join(tmpDir, "vanishing.md");
    await fs.writeFile(filePath, "# Still here\n");
    const opened = await openFileByPath(filePath);
    await fs.rm(filePath);

    await expect(openFileByPath(filePath, { force: true })).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(getOpenDocs().has(opened.documentId), "the tab survives the failed reload").toBe(true);
    expect(
      extractText(getOrCreateDocument(opened.documentId)),
      "…and so does its content",
    ).toContain("Still here");
  });
});

// ---------------------------------------------------------------------------
// Session restore, characterized at its CURRENT call path (Unit 6 adds none)
// ---------------------------------------------------------------------------

describe("session restore", () => {
  // Deliberately exercised through `restoreOpenDocuments` as it stands today,
  // dynamic `file-opener` import and all. Unit 7a adds the named
  // `openFromRestore` entry point; these assertions are what it has to keep
  // true, so they pin outcomes rather than the import shape.

  async function writeSession(filePath: string, readOnly = false): Promise<void> {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    await fs.writeFile(
      path.join(SESSION_DIR, `${encodeURIComponent(docHash(filePath))}.json`),
      JSON.stringify({ filePath, lastAccessed: Date.now(), readOnly }),
    );
  }

  it("re-opens a persisted document and carries its read-only flag back", async () => {
    // Without the flag every restored tab takes `resolveAndValidatePath`'s
    // hardcoded `false`, and View Changelog comes back writable — which then
    // autosaves CHANGELOG.md through remark-stringify and rewrites the file.
    const writable = path.join(tmpDir, "writable.md");
    const locked = path.join(tmpDir, "locked.md");
    await fs.writeFile(writable, "# Writable\n");
    await fs.writeFile(locked, "# Locked\n");
    await writeSession(writable, false);
    await writeSession(locked, true);

    const count = await restoreOpenDocuments(null);

    expect(count, "control: both sessions restored").toBe(2);
    const byPath = new Map([...getOpenDocs().values()].map((d) => [path.basename(d.filePath), d]));
    expect(byPath.get("writable.md")?.readOnly).toBe(false);
    expect(byPath.get("locked.md")?.readOnly).toBe(true);
  });

  it("skips a session whose file is gone without failing the whole restore", async () => {
    const alive = path.join(tmpDir, "alive.md");
    await fs.writeFile(alive, "# Alive\n");
    await writeSession(alive);
    await writeSession(path.join(tmpDir, "deleted.md"));

    const count = await restoreOpenDocuments(null);

    expect(count, "the survivor is counted, the missing one is not").toBe(1);
    expect(getOpenDocs().size).toBe(1);
  });

  it("re-activates the previously active document only if it came back", async () => {
    const alive = path.join(tmpDir, "active.md");
    await fs.writeFile(alive, "# Active\n");
    await writeSession(alive);

    await restoreOpenDocuments(docHash(path.join(tmpDir, "never-restored.md")));

    // The id it was asked to activate is not open, so activation must fall
    // through to whatever the opens themselves established rather than
    // pointing the client at a document that does not exist.
    expect(getOpenDocs().has(getActiveDocId() ?? ""), "active id names an open document").toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Watcher notification — pinned as CURRENT behaviour, including a known defect
// ---------------------------------------------------------------------------

describe("file-watcher reload notification", () => {
  it("KNOWN DEFECT (#1641): reports a reload even when the reload was skipped", async () => {
    // `reloadFromDisk` returns false when a reload for the same document is
    // already in flight; the watcher callback discards that return and pushes
    // the success toast anyway. Unit 6 is behaviour-preserving, so this pins
    // what the code does today — it is NOT an endorsement. The fix belongs in
    // 7b, where the notification becomes a function of the result arm; when it
    // lands, this expectation flips to 1 and the test name loses its prefix.
    const filePath = path.join(tmpDir, "watched.md");
    await fs.writeFile(filePath, "# Watched\n");
    const opened = await openFileByPath(filePath);

    const registered = vi.mocked(watchFile).mock.calls.find(([p]) => p === filePath);
    expect(registered, "control: the open actually registered a watcher").toBeDefined();
    const onChange = registered?.[1] as () => Promise<void>;

    await fs.writeFile(filePath, "# Watched, changed\n");
    notificationsReset();

    // Both callbacks are started before either is awaited: the first holds
    // `reloadInProgress`, so the second takes the skip branch. Driving the real
    // callback is the point — a hand-built pair of promises could not see the
    // discarded return value.
    const first = onChange();
    const second = onChange();
    await Promise.all([first, second]);

    const reloaded = getBuffer().filter(
      (n) => n.type === "file-reloaded" && n.documentId === opened.documentId,
    );
    expect(reloaded.length, "two toasts for one reload — the defect").toBe(2);
  });

  it("reports a failure when the reload throws", async () => {
    const filePath = path.join(tmpDir, "doomed.md");
    await fs.writeFile(filePath, "# Doomed\n");
    const opened = await openFileByPath(filePath);

    const registered = vi.mocked(watchFile).mock.calls.find(([p]) => p === filePath);
    const onChange = registered?.[1] as () => Promise<void>;

    await fs.rm(filePath);
    notificationsReset();
    await onChange();

    const errors = getBuffer().filter(
      (n) => n.type === "general-error" && n.documentId === opened.documentId,
    );
    expect(errors.length, "the user is told the reload failed").toBe(1);
    expect(errors[0]?.severity).toBe("warning");
  });
});
