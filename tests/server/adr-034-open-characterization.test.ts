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
 *     happened. `open-pipeline-lifecycle.test.ts` only asserts
 *     `setFileSyncContext` was called with the doc id.
 *   - **The saved-at baseline VALUE.** Disk open uses the file's mtime; upload
 *     and scratchpad use `Date.now()`. No test asserts the value, only that
 *     opens succeed — so "normalizing" the split changes autosave's
 *     external-modification guard on any file whose mtime is in the past.
 *   - **Error-path identity.** HTTP status and MCP error code are both derived
 *     from the thrown `err.code`. Any wrapping — even a `try`/`catch` that
 *     rethrows a new Error — silently changes both.
 * Entry points are called through `documents/open.ts`, never through
 * `mcp/file-opener.ts`. This file's whole claim is that it stays green WITHOUT
 * being edited across the ADR-034 moves — and Unit 7a empties the
 * implementation module, so importing from it directly would have forced an
 * edit and voided the claim. That is the same mistake `documents-open.test.ts`
 * was rewritten to fix, and it was reintroduced one file over.
 *
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
import {
  openFromDisk,
  openFromUpload,
  openScratchpad,
  toWireResult,
} from "../../src/server/documents/open.js";
import { getActiveDocEpoch, getActiveDocId } from "../../src/server/documents/registry.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { MAX_DOCX_PART_BYTES } from "../../src/server/file-io/docx-size-gate.js";
import { watchFile } from "../../src/server/file-watcher.js";
import { extractText, restoreOpenDocuments } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import {
  getBuffer,
  resetForTesting as notificationsReset,
} from "../../src/server/notifications.js";
import { SESSION_DIR } from "../../src/server/platform.js";
import { saveSession } from "../../src/server/session/manager.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  CHARS_PER_PAGE,
  CTRL_ROOM,
  LARGE_FILE_PAGE_THRESHOLD,
  MAX_FILE_SIZE,
  VERY_LARGE_FILE_PAGE_THRESHOLD,
  Y_MAP_ACTIVE_DOCUMENT_EPOCH,
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

/**
 * The activation epoch, read straight off CTRL_ROOM.
 *
 * The transaction count above is a proxy: it is what "one broadcast" looks like
 * from outside, but an ADR-031-motivated split writing the doc list and the
 * active pointer under two different origin helpers would be behaviour-identical
 * to every client and turn all five counts red. The epoch delta is what the harm
 * is actually made of — the client reads an advance as a genuine focus event and
 * lets it override a tab switch the user made in between — so both are asserted:
 * the count catches a duplicated broadcast, the delta names why it matters.
 */
function activeEpoch(): number {
  return getActiveDocEpoch();
}

/** The epoch CTRL_ROOM currently advertises to clients. */
function publishedEpoch(): number {
  return (getOrCreateDocument(CTRL_ROOM)
    .getMap(Y_MAP_DOCUMENT_META)
    .get(Y_MAP_ACTIVE_DOCUMENT_EPOCH) ?? 0) as number;
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
    const epochBefore = activeEpoch();
    const result = await openFromDisk(filePath);

    expect(result.documentId, "control: the open actually succeeded").toBeTruthy();
    expect(ctrlWrites(), "exactly one documentMeta publish").toBe(1);
    expect(activeEpoch() - epochBefore, "…and exactly one activation-epoch advance").toBe(1);
    expect(publishedEpoch(), "…which is the epoch the broadcast carried").toBe(activeEpoch());
  });

  it("publishes once for an upload", async () => {
    const ctrlWrites = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const epochBefore = activeEpoch();
    const result = await openFromUpload("uploaded.md", "# Uploaded\n");

    expect(result.documentId).toBeTruthy();
    expect(ctrlWrites(), "exactly one documentMeta publish").toBe(1);
    expect(activeEpoch() - epochBefore, "…and exactly one activation-epoch advance").toBe(1);
    expect(publishedEpoch(), "…which is the epoch the broadcast carried").toBe(activeEpoch());
  });

  it("publishes once for a scratchpad", async () => {
    const ctrlWrites = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const epochBefore = activeEpoch();
    const result = await openScratchpad("# Scratch\n");

    expect(result.documentId).toBeTruthy();
    expect(ctrlWrites(), "exactly one documentMeta publish").toBe(1);
    expect(activeEpoch() - epochBefore, "…and exactly one activation-epoch advance").toBe(1);
    expect(publishedEpoch(), "…which is the epoch the broadcast carried").toBe(activeEpoch());
  });

  it("publishes once when re-opening an already-open document", async () => {
    const filePath = path.join(tmpDir, "again.md");
    await fs.writeFile(filePath, "# Again\n");
    await openFromDisk(filePath);

    const ctrlWrites = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const epochBefore = activeEpoch();
    const result = await openFromDisk(filePath);

    expect(result.kind, "control: this is the already-open branch").toBe("already-open");
    expect(ctrlWrites(), "a re-open is still exactly one publish").toBe(1);
    expect(activeEpoch() - epochBefore, "…and exactly one activation-epoch advance").toBe(1);
    expect(publishedEpoch(), "…which is the epoch the broadcast carried").toBe(activeEpoch());
  });

  it("publishes once for a force reload", async () => {
    const filePath = path.join(tmpDir, "forced.md");
    await fs.writeFile(filePath, "# Before\n");
    await openFromDisk(filePath);
    await fs.writeFile(filePath, "# After\n");

    const ctrlWrites = watchTransactions(getOrCreateDocument(CTRL_ROOM));
    const epochBefore = activeEpoch();
    const result = await openFromDisk(filePath, { force: true });

    expect(result.kind, "control: this is the force branch").toBe("force-reloaded");
    expect(ctrlWrites(), "a force reload is still exactly one publish").toBe(1);
    expect(activeEpoch() - epochBefore, "…and exactly one activation-epoch advance").toBe(1);
    expect(publishedEpoch(), "…which is the epoch the broadcast carried").toBe(activeEpoch());
  });
});

// ---------------------------------------------------------------------------
// The annotation store is wired AFTER the Y.Doc is populated
// ---------------------------------------------------------------------------

describe("durable annotations survive an open", () => {
  it("re-anchors a stored annotation against populated content, not an empty doc", async () => {
    // What this pins, exactly: a stored envelope reaches the Y.Map with its
    // offsets still selecting the text they were anchored to.
    //
    // It is deliberately narrower than the comment that used to sit here, which
    // claimed `loadAndMerge` re-anchors through `refreshRange` against an empty
    // XmlFragment when populate and wiring are inverted. It does not —
    // `refreshRange` appears nowhere in `annotations/sync.ts`, and `loadAndMerge`
    // copies `range` verbatim out of the envelope. The only re-anchoring on any
    // file-opener path is `reloadDocumentFromMarkdown`'s, which is the watcher
    // reload, not open.
    //
    // A reviewer proved the honest limit by inverting populate and
    // `finalizeDocOpen` in the real source: THIS test stayed green (two of the
    // watcher tests below caught it). Making it discriminating would need a real
    // `relRange` seeded via `anchoredRange()` AND an edit between the probe and
    // the cold open, so the flat and CRDT answers diverge. Until then it claims
    // only what it can see, and the inversion is covered elsewhere in the file.
    const filePath = path.join(tmpDir, "annotated.md");
    const body = "# Title\n\nThe quick brown fox jumps over the lazy dog.\n";
    await fs.writeFile(filePath, body);

    // The envelope's offsets are taken from the REAL flat-text coordinate
    // system, by opening once and reading it back, rather than from this
    // test's own model of how blocks are joined. Computing them from the file
    // bytes is off by one — flat text separates blocks with a single newline —
    // and a fixture built from my model would be testing the model, not the
    // property under test, which is that the offsets SURVIVE the second open.
    const probe = await openFromDisk(filePath);
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

    const result = await openFromDisk(filePath);
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

    const result = await openFromDisk(filePath);

    expect(savedAt(result.documentId)).toBe(stat.mtimeMs);
    expect(savedAt(result.documentId), "…which is NOT the wall clock").toBeLessThan(
      Date.now() - 30_000,
    );
  });

  it("uses the wall clock for an upload, which has no file to stat", async () => {
    const before = Date.now();
    const result = await openFromUpload("no-file.md", "# Upload\n");

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
    const code = await codeOf(() => openFromDisk(path.join(tmpDir, "nope.md")));
    expect(code).toBe("ENOENT");
  });

  it("an unsupported extension throws UNSUPPORTED_FORMAT (→ 400, FORMAT_ERROR)", async () => {
    const filePath = path.join(tmpDir, "binary.exe");
    await fs.writeFile(filePath, "MZ");
    expect(await codeOf(() => openFromDisk(filePath))).toBe("UNSUPPORTED_FORMAT");
  });

  it("an unsupported upload extension throws UNSUPPORTED_FORMAT", async () => {
    expect(await codeOf(() => openFromUpload("payload.exe", "MZ"))).toBe("UNSUPPORTED_FORMAT");
  });

  it("an oversized file on disk throws FILE_TOO_LARGE (→ 413) before any read", async () => {
    // Sparse: `truncate` sets the size without writing 50MB, and the gate reads
    // `stat.size`, so this exercises the real branch at real cost.
    const filePath = path.join(tmpDir, "huge-on-disk.md");
    await fs.writeFile(filePath, "");
    await fs.truncate(filePath, MAX_FILE_SIZE + 1);

    expect(await codeOf(() => openFromDisk(filePath))).toBe("FILE_TOO_LARGE");
  });

  it("an oversized upload throws FILE_TOO_LARGE from the content length", async () => {
    // The disk gate reads `stat.size`; the upload gate measures the payload.
    // They are separate checks producing the same code, and only the pairing of
    // code to status was pinned before (in the middleware test) — never the throw.
    expect(await codeOf(() => openFromUpload("huge.md", Buffer.alloc(MAX_FILE_SIZE + 1)))).toBe(
      "FILE_TOO_LARGE",
    );
  });

  it("a string-bodied .docx upload throws INVALID_SOURCE", async () => {
    // Reachable through the seam by any caller: `.docx` is a supported format,
    // so it passes the extension gate and fails in `prepareContent`, which needs
    // a Buffer. It falls to the default 500 arm, which makes `sendApiError` log
    // an unhandled-error stack for what is a caller mistake — worth pinning
    // before Unit 7b decides which failures become `OpenFailure` variants.
    expect(await codeOf(() => openFromUpload("payload.docx", "not a zip"))).toBe("INVALID_SOURCE");
  });

  it("a declared-size .docx bomb throws DOCX_TOO_LARGE through the OPEN path", async () => {
    // The one open error whose `code` comes from a class field rather than an
    // `Object.assign`, which makes it the most fragile to a normalizing
    // rewrap. `docx-size-gate-call-sites.test.ts` covers it by calling
    // `getAdapter("docx").parse(bomb)` directly — that test stays green no
    // matter what the open path does to the error on its way out, so this
    // pins the join: the gate fires inside `loadContentIntoDoc →
    // prepareContent` and the code survives to the caller.
    //
    // The archive over-declares its uncompressed size and is refused by the
    // declared-size pass, so nothing here inflates 32MB — the built zip is
    // under a megabyte.
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/media/blob.bin", Buffer.alloc(MAX_DOCX_PART_BYTES + 8 * 1024 * 1024, 0x41));
    const bomb = (await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    })) as Buffer;
    expect(bomb.length, "control: it sails through every COMPRESSED-size check").toBeLessThan(
      1024 * 1024,
    );

    const filePath = path.join(tmpDir, "bomb.docx");
    await fs.writeFile(filePath, bomb);

    expect(await codeOf(() => openFromDisk(filePath))).toBe("DOCX_TOO_LARGE");
  }, 60_000);

  it("an OS errno from the read reaches the caller unchanged", async () => {
    // EBUSY / EPERM are the most user-visible open failures the product has on
    // Windows — `document.ts` turns them into FILE_LOCKED with the "another
    // program (likely Microsoft Word) has it open" message, and `_shared.ts`
    // maps them to 423. Both are pure Node errno passthrough with no
    // `Object.assign` anywhere asserting them, so a selective rewrap in Unit 7a
    // would silently downgrade the lock message to a generic 500.
    const filePath = path.join(tmpDir, "locked.md");
    await fs.writeFile(filePath, "# Locked\n");

    const real = fs.readFile;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (String(args[0]) === filePath) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return real(...(args as Parameters<typeof real>));
    });

    try {
      expect(await codeOf(() => openFromDisk(filePath))).toBe("EBUSY");
      expect(spy, "control: the injected failure actually fired").toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("a UNC path throws INVALID_PATH (→ 400) before any filesystem call", async () => {
    // The ordering matters as much as the code, and the reason is specific:
    // `realpathSync` on `\\\\evil.example\\share\\x.md` OPENS the SMB connection
    // and leaks the NTLM hash. So the prefix rejection has to land before path
    // resolution, not merely before the read.
    expect(await codeOf(() => openFromDisk("\\\\attacker.example\\share\\doc.md"))).toBe(
      "INVALID_PATH",
    );
  });
});

// ---------------------------------------------------------------------------
// Warnings ride on SUCCESSFUL opens, not just failures
// ---------------------------------------------------------------------------

describe("large-document warnings", () => {
  // `buildResult` attaches these to every success path. Unit 7b's sketched
  // `OpenResult` union put `warnings` only on a `failed` arm, which would have
  // dropped them silently — nothing else asserts they exist. The shipped
  // `OpenSuccess` carries them on the success payload instead, and these are
  // what says so.

  function pagesOf(chars: number): string {
    return "x".repeat(chars);
  }

  it("attaches no warning to an ordinary document", async () => {
    const filePath = path.join(tmpDir, "small.md");
    await fs.writeFile(filePath, "# Small\n\nShort body.\n");

    const result = await openFromDisk(filePath);
    expect(result.warnings ?? [], "control: the threshold is not always tripped").toEqual([]);
  });

  it("warns on a large document and keeps the open successful", async () => {
    const filePath = path.join(tmpDir, "large.md");
    await fs.writeFile(filePath, pagesOf(LARGE_FILE_PAGE_THRESHOLD * CHARS_PER_PAGE));

    const result = await openFromDisk(filePath);

    expect(result.documentId, "the open still succeeds — a warning is not a failure").toBeTruthy();
    expect(result.warnings?.join(" ")).toMatch(/Large document/);
    expect(result.warnings?.join(" "), "…and not the very-large wording").not.toMatch(/Very large/);
  });

  it("escalates the wording past the very-large threshold", async () => {
    const filePath = path.join(tmpDir, "huge.md");
    await fs.writeFile(filePath, pagesOf(VERY_LARGE_FILE_PAGE_THRESHOLD * CHARS_PER_PAGE));

    const result = await openFromDisk(filePath);
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
    const opened = await openFromDisk(filePath);
    await fs.rm(filePath);

    await expect(openFromDisk(filePath, { force: true })).rejects.toMatchObject({
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
  it("reports one reload per reload, not one per callback (#1641)", async () => {
    // `reloadFromDisk` returns false when a reload for the same document is
    // already in flight. The watcher callback used to discard that and toast
    // anyway; Unit 6 pinned the defect here as current behaviour and 7b fixed
    // it, so this expectation flipped from 2 to 1 and the name lost its
    // KNOWN DEFECT prefix.
    //
    // "Two toasts for ONE reload" is the whole claim, so the reload count is
    // measured, not assumed. An earlier version asserted only the toast count —
    // which two REAL reloads also satisfy, so applying the fix and relocating
    // the in-flight dedupe left it green with the defect gone.
    async function fireWatcher(name: string, times: number) {
      const filePath = path.join(tmpDir, name);
      await fs.writeFile(filePath, "# Watched\n");
      const opened = await openFromDisk(filePath);

      const registered = vi.mocked(watchFile).mock.calls.find(([p]) => p === filePath);
      expect(registered, "control: the open actually registered a watcher").toBeDefined();
      const onChange = registered?.[1] as () => Promise<void>;

      await fs.writeFile(filePath, "# Watched, changed\n");
      notificationsReset();
      const docWrites = watchTransactions(getOrCreateDocument(opened.documentId));

      // Every callback is started before any is awaited: the first holds
      // `reloadInProgress`, so the rest take the skip branch. Driving the real
      // callback is the point — a hand-built pair of promises could not see the
      // discarded return value.
      await Promise.all(Array.from({ length: times }, () => onChange()));

      const toasts = getBuffer().filter(
        (n) => n.type === "file-reloaded" && n.documentId === opened.documentId,
      ).length;
      return { toasts, docWrites: docWrites() };
    }

    // Baseline: what exactly one reload costs in document-room transactions.
    const single = await fireWatcher("watched-single.md", 1);
    expect(single.toasts, "control: one callback, one toast").toBe(1);
    expect(single.docWrites, "control: one reload actually wrote to the doc").toBeGreaterThan(0);

    const pair = await fireWatcher("watched-pair.md", 2);
    expect(pair.docWrites, "control: still exactly ONE reload, as before the fix").toBe(
      single.docWrites,
    );
    expect(pair.toasts, "…and now exactly one toast to match it").toBe(1);
  });

  it("still toasts twice for two reloads that do not overlap", async () => {
    // The negative control for the fix above, and the thing a green
    // "exactly one toast" cannot distinguish on its own: suppressing the toast
    // whenever `reloadFromDisk` returns false is correct, but suppressing it
    // permanently after the first — a latch, a stuck `reloadInProgress`, a
    // guard never released — looks identical in the concurrent case. Two
    // callbacks fired one after the other, each awaited, are two REAL reloads
    // and owe the user two notifications.
    const filePath = path.join(tmpDir, "watched-sequential.md");
    await fs.writeFile(filePath, "# Watched\n");
    const opened = await openFromDisk(filePath);

    const registered = vi.mocked(watchFile).mock.calls.find(([p]) => p === filePath);
    expect(registered, "control: the open actually registered a watcher").toBeDefined();
    const onChange = registered?.[1] as () => Promise<void>;

    notificationsReset();
    await fs.writeFile(filePath, "# Watched, once\n");
    await onChange();
    await fs.writeFile(filePath, "# Watched, twice\n");
    await onChange();

    const toasts = getBuffer().filter(
      (n) => n.type === "file-reloaded" && n.documentId === opened.documentId,
    ).length;
    expect(toasts, "two separate reloads, two notifications").toBe(2);
  });

  it("reports a failure when the reload throws", async () => {
    const filePath = path.join(tmpDir, "doomed.md");
    await fs.writeFile(filePath, "# Doomed\n");
    const opened = await openFromDisk(filePath);

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

// ---------------------------------------------------------------------------
// The wire shape does not change (Unit 7b §5)
// ---------------------------------------------------------------------------

describe("toWireResult keeps the payload the wire sites already ship", () => {
  /**
   * The whole safety argument for Unit 7b.
   *
   * `OpenSuccess` is internal; six sites put a FLAT object on the MCP and HTTP
   * wire — `mcp/document.ts`'s `tandem_open`, `routes/{open,upload,scratchpad}.ts`,
   * plus field cherry-picks in `tandem_scratchpad` and `mcp/convert.ts`. Four of
   * them spread the result into an untyped response body, which means dropping
   * a field there **compiles silently**: that is exactly what happened when the
   * union first landed, and only one call site in the whole repo produced a type
   * error.
   *
   * So the control is the key set, and the results are produced by calling the
   * REAL entry points. A hand-built fixture could only confirm my own model of
   * what the pipeline emits — which is the model under test.
   *
   * Two fields have no reader anywhere in `src/`, `src/client/` or `src-tauri/`:
   * `tokenEstimate`/`pageEstimate` and `warnings`. They are pinned hardest,
   * because the MCP payload's consumer is the calling model, which no grep of
   * this repo can see. Unread-by-us is not unread.
   */
  const WIRE_KEYS = [
    "alreadyOpen",
    "documentId",
    "fileName",
    "filePath",
    "forceReloaded",
    "format",
    "pageEstimate",
    "readOnly",
    "restoredFromSession",
    "source",
    "tokenEstimate",
  ];

  function keysOf(o: object): string[] {
    return Object.keys(o).sort();
  }

  it("emits exactly the eleven always-present keys for a fresh disk open", async () => {
    const filePath = path.join(tmpDir, "wire-fresh.md");
    await fs.writeFile(filePath, "# Fresh\n");

    const wire = toWireResult(await openFromDisk(filePath));

    // `warnings` is ABSENT, not undefined. Assigning it unconditionally would
    // add a key to every payload that lacks one — invisible to
    // `JSON.stringify`, visible to `Object.keys` and to a strict client.
    expect(keysOf(wire)).toEqual(WIRE_KEYS);
    expect("warnings" in wire).toBe(false);
    expect(wire.tokenEstimate).toBeGreaterThan(0);
    expect(wire.pageEstimate).toBeGreaterThan(0);
  });

  it("adds `warnings` — and only then — for a document over the threshold", async () => {
    const filePath = path.join(tmpDir, "wire-large.md");
    await fs.writeFile(filePath, "x".repeat(LARGE_FILE_PAGE_THRESHOLD * CHARS_PER_PAGE));

    const wire = toWireResult(await openFromDisk(filePath));

    expect(keysOf(wire)).toEqual([...WIRE_KEYS, "warnings"].sort());
    expect(wire.warnings?.join(" ")).toMatch(/Large document/);
    // The estimates are computed from the POPULATED doc. Assembling the union
    // progressively — fields added as they become known rather than at the
    // final return — would read the text before population and silently zero
    // these, suppressing the warning with it. A stubbed Y.Doc cannot see that,
    // because zero is what a stub yields anyway.
    expect(wire.pageEstimate).toBeGreaterThanOrEqual(LARGE_FILE_PAGE_THRESHOLD);
  });

  it("sets alreadyOpen alone when the document is reopened", async () => {
    const filePath = path.join(tmpDir, "wire-reopen.md");
    await fs.writeFile(filePath, "# Reopen\n");
    await openFromDisk(filePath);

    const wire = toWireResult(await openFromDisk(filePath));

    expect(keysOf(wire)).toEqual(WIRE_KEYS);
    expect([wire.alreadyOpen, wire.forceReloaded, wire.restoredFromSession]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("sets forceReloaded alone on a force reload", async () => {
    const filePath = path.join(tmpDir, "wire-force.md");
    await fs.writeFile(filePath, "# Force\n");
    await openFromDisk(filePath);

    const wire = toWireResult(await openFromDisk(filePath, { force: true }));

    expect([wire.alreadyOpen, wire.forceReloaded, wire.restoredFromSession]).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("keeps upload provenance and sets no kind boolean", async () => {
    const wire = toWireResult(await openFromUpload("wire-upload.md", "# Upload\n"));

    expect(keysOf(wire)).toEqual(WIRE_KEYS);
    expect(wire.source).toBe("upload");
    expect([wire.alreadyOpen, wire.forceReloaded, wire.restoredFromSession]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("keeps the scratchpad payload identical in shape to a file open", async () => {
    const wire = toWireResult(await openScratchpad("# Scratch\n"));

    expect(keysOf(wire)).toEqual(WIRE_KEYS);
    expect(wire.source).toBe("upload");
  });

  it("encodes a genuinely restored open as restoredFromSession, through the real pipeline", async () => {
    // The `restored` arm is the one the unit tests hardest and exercises least:
    // every other kind has a wire spec above driven by a real entry point,
    // while `restored` was pinned only against a fixture this file builds
    // itself — which can only confirm my model of what the pipeline emits.
    // `kind: "restored"` is decided inside `openFromDisk` from
    // `maybeRestoreSession`, so the only honest witness is a real second open
    // over a real session file.
    const filePath = path.join(tmpDir, "restored.md");
    await fs.writeFile(filePath, "# Restored\n");
    const first = await openFromDisk(filePath);
    expect(first.kind, "control: the first open is fresh").toBe("fresh");
    await saveSession(filePath, "md", getOrCreateDocument(first.documentId));

    // Drop every trace of the open document, so the reopen takes the restore
    // path rather than `handleAlreadyOpen`.
    removeDoc(first.documentId);
    removeDocument(first.documentId);

    const second = await openFromDisk(filePath);
    expect(second.kind, "the session file is what the second open reads").toBe("restored");

    const wire = toWireResult(second);
    expect(keysOf(wire)).toEqual(WIRE_KEYS);
    expect([wire.restoredFromSession, wire.alreadyOpen, wire.forceReloaded]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("still exposes the three fields the cherry-picking sites name", async () => {
    // `tandem_scratchpad` takes documentId/fileName/format; `mcp/convert.ts`
    // takes documentId/fileName. Neither spreads, so neither would break at
    // compile time if a field changed MEANING rather than name — which is
    // where a correspondence bug hides. Both read them off the union directly,
    // so assert them there.
    const result = await openScratchpad("# Cherry\n");

    expect(result.documentId).toBeTruthy();
    expect(result.fileName).toBeTruthy();
    expect(result.format).toBe("md");
  });
});
