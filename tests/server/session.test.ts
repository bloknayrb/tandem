import fs from "fs/promises";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  Y_MAP_ACTIVE_DOCUMENT_EPOCH,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
  Y_MAP_DOCUMENT_META,
} from "../../src/shared/constants.js";

// Isolate session tests in a unique temp directory to avoid races with other test files
vi.mock("../../src/server/platform", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  return {
    ...mod,
    SESSION_DIR: pathMod.join(osMod.tmpdir(), `tandem-test-session-${cryptoMod.randomUUID()}`),
  };
});

// `manager.ts` imports `atomicWrite` as a NAMED ESM binding, so `vi.spyOn` on
// the namespace never reaches it. A hoisted PARTIAL mock whose default
// implementation passes through to the real one is what lets a single case make
// one save throw while the ~30 real-disk round-trips in this file keep working.
const atomicWriteMock = vi.hoisted(() => ({ impl: null as null | (() => Promise<void>) }));
vi.mock("../../src/server/file-io/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/file-io/index.js")>();
  return {
    ...actual,
    atomicWrite: vi.fn(async (...args: Parameters<typeof actual.atomicWrite>) => {
      if (atomicWriteMock.impl) return atomicWriteMock.impl();
      return actual.atomicWrite(...args);
    }),
  };
});

import { docHash } from "../../src/server/annotations/doc-hash";
import { SESSION_DIR } from "../../src/server/platform";
import {
  deleteSession,
  legacySessionKey,
  listSessionFilePaths,
  loadCtrlSession,
  loadSession,
  restoreCtrlDoc,
  restoreYDoc,
  saveCtrlSession,
  saveSession,
  sessionKey,
  sourceFileChanged,
} from "../../src/server/session/manager";

describe("Session persistence", () => {
  beforeAll(async () => {
    await fs.mkdir(SESSION_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(SESSION_DIR, { recursive: true, force: true });
  });

  // Create a Y.Doc with some content and annotations
  function createTestDoc(): Y.Doc {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("Hello world")]);
    fragment.insert(0, [p]);

    // Add an annotation
    const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
    annotations.set("ann_test_1", {
      id: "ann_test_1",
      author: "claude",
      type: "highlight",
      range: { from: 0, to: 5 },
      content: "test note",
      status: "pending",
      timestamp: Date.now(),
      color: "yellow",
    });

    return doc;
  }

  describe("sessionKey (#1750)", () => {
    afterEach(() => {
      atomicWriteMock.impl = null;
    });

    it("hashes disk paths to a fixed 64 hex characters", () => {
      // `encodeURIComponent` turned every `/` into a 3-byte `%2F`, so a
      // 90-character path became a 200+-byte filename and ext4/NTFS refused it
      // at 255. This is the whole of #1750's first fault.
      const key = sessionKey(path.resolve("C:/Users/test/doc.md"));
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(Buffer.byteLength(`${key}.json`)).toBe(69);
    });

    it("is deterministic and separator-invariant", () => {
      const key1 = sessionKey("C:\\Users\\test\\doc.md");
      const key2 = sessionKey("C:/Users/test/doc.md");
      expect(key1).toBe(key2);
      expect(key1).toBe(docHash("C:/Users/test/doc.md"));
    });

    it.skipIf(process.platform !== "win32")(
      "gives case-variant spellings ONE key on win32 (they already share one Hocuspocus room)",
      () => {
        // Skipped off win32 because `docHash` deliberately preserves case on
        // POSIX, where paths are case-sensitive: two spellings there still get
        // two session files and one room, which is pre-existing and not fixed
        // here.
        //
        // NO CI JOB RUNS THIS — because this file is not on a list, not
        // because the mechanism is missing. The only vitest CI runs on Windows
        // are the specs in `WINDOWS_ACL_PROOF_SPECS`
        // (`scripts/ci/windows-acl-proof.mjs`, spawned by the
        // `windows-acl-proof` job on `windows-latest`); this file is not one of
        // them, and every other vitest job is ubuntu. So a change that stopped
        // `docHash` lowercasing on win32 is invisible to CI — honest `skipIf`
        // rather than the silently-vacuous #1529 shape, but a green `check` is
        // not evidence about this case. Adding the spec to that list is the
        // available fix, at the price of the >=1-passed/0-skipped-per-describe
        // contract the job enforces.
        expect(sessionKey("C:\\Docs\\A.md")).toBe(sessionKey("c:/docs/a.md"));
      },
    );

    it("keeps the legacy encoded key for upload paths", () => {
      // `docHash` collapses EVERY scratchpad to `upload_scratchpad`, and
      // sessions are written for scratchpads on every 60 s tick — two open
      // scratchpads would clobber one file. Upload paths are ~60 synthetic
      // characters and were never in #1750's scope.
      const p = "upload://abc123/notes.md";
      expect(sessionKey(p)).toBe(legacySessionKey(p));
    });

    it("gives two concurrently open scratchpads two distinct session files", () => {
      const a = "upload://scratchpad/11111111-1111-1111-1111-111111111111/Scratchpad.md";
      const b = "upload://scratchpad/22222222-2222-2222-2222-222222222222/Scratchpad.md";
      expect(sessionKey(a)).not.toBe(sessionKey(b));
      // …and this is exactly what hashing them would have broken.
      expect(docHash(a)).toBe(docHash(b));
    });

    it("cannot collide with a legacy name in either direction", () => {
      // An `encodeURIComponent` name of an absolute path always contains
      // `%2F`, so it can never look like 64 hex.
      expect(legacySessionKey(path.resolve("/tmp/x.md"))).toContain("%2F");
    });

    it("saves and loads a path whose legacy key would have been ENAMETOOLONG", async () => {
      const deep = path.join(
        SESSION_DIR,
        "..",
        `${"d".repeat(60)}`,
        `${"e".repeat(60)}`,
        `${"f".repeat(60)}`,
        `${"g".repeat(60)}`,
        "doc.md",
      );
      expect(Buffer.byteLength(`${legacySessionKey(deep)}.json`)).toBeGreaterThan(255);
      const doc = createTestDoc();
      await saveSession(deep, "md", doc);
      const loaded = await loadSession(deep);
      expect(loaded).not.toBeNull();
      expect(loaded!.filePath).toBe(deep);
      await deleteSession(deep);
    });
  });

  describe("session key migration (#1750)", () => {
    const migPath = path.resolve("tests/fixtures/session-migration.md");
    const newFile = () => path.join(SESSION_DIR, `${sessionKey(migPath)}.json`);
    const oldFile = () => path.join(SESSION_DIR, `${legacySessionKey(migPath)}.json`);

    async function writeRecord(target: string, over: Record<string, unknown> = {}): Promise<void> {
      const doc = createTestDoc();
      await fs.mkdir(SESSION_DIR, { recursive: true });
      await fs.writeFile(
        target,
        JSON.stringify({
          filePath: migPath,
          format: "md",
          ydocState: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
          sourceFileMtime: 0,
          lastAccessed: Date.now(),
          modelRevision: 99,
          ...over,
        }),
        "utf-8",
      );
    }

    beforeEach(async () => {
      await fs.mkdir(path.dirname(migPath), { recursive: true });
      await fs.writeFile(migPath, "# migration\n", "utf-8");
      await fs.rm(newFile(), { force: true });
      await fs.rm(oldFile(), { force: true });
    });

    afterEach(async () => {
      atomicWriteMock.impl = null;
      await deleteSession(migPath);
      await fs.rm(migPath, { force: true });
    });

    it("a path with no spellable legacy name still saves, loads and deletes", async () => {
      // `legacySessionKey` is `encodeURIComponent`, which throws `URIError` on a
      // lone surrogate. That derivation happens AFTER `saveSession`'s
      // `atomicWrite`, so the throw reported failure for a session write that
      // had fully succeeded — the #1750 class this branch exists to close — and
      // it falsified `saveDocumentToDisk`'s catch, which deletes the record it
      // believes is stale (`deleteSession` throws the same `URIError`, so it
      // deleted nothing) and tells the user their recovery state was not
      // recorded while the current record sat on disk and correct.
      //
      // `legacySessionPath` now answers null: a path whose legacy encoding does
      // not exist cannot have a legacy file. All three callers go total.
      const lone = path.resolve(`C:/docs/lone-${String.fromCharCode(0xd800)}.md`);
      expect(() => legacySessionKey(lone)).toThrow(URIError);

      await expect(saveSession(lone, "md", createTestDoc())).resolves.toBeUndefined();
      const loaded = await loadSession(lone);
      expect(loaded).not.toBeNull();
      expect(loaded!.filePath).toBe(lone);
      await expect(deleteSession(lone)).resolves.toBeUndefined();
      expect(await loadSession(lone)).toBeNull();
    });

    it("loads a session written under the OLD name", async () => {
      await writeRecord(oldFile());
      const loaded = await loadSession(migPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.filePath).toBe(migPath);
    });

    it("the NEWER mtime wins when both names exist, and the loser survives the load", async () => {
      // "Successful load" is only a successful `JSON.parse` — a record whose
      // `ydocState` is corrupt parses fine and throws later in `restoreYDoc`.
      // A load-time delete of the healthy older sibling, followed by a
      // quarantine of the corrupt newer one, destroys BOTH records.
      await writeRecord(newFile(), { format: "new-name" });
      await new Promise((r) => setTimeout(r, 20));
      await writeRecord(oldFile(), { format: "old-name" });

      const loaded = await loadSession(migPath);
      expect(loaded!.format).toBe("old-name");
      await expect(fs.stat(newFile())).resolves.toBeDefined();
    });

    it("the NEWER mtime wins in the OTHER direction: the new name beats a lingering legacy file", async () => {
      // The mirror, and the case that makes the comparison provable at all.
      // Every other mtime fixture here writes the NEW name first, so "the
      // legacy file won" is the only proposition any of them assert — a mutant
      // that deletes the comparison outright and always prefers the legacy path
      // was measured green across the whole suite. This is the steady state
      // after migration: `saveSession`'s unlink of the old name is best-effort
      // and only logs a non-ENOENT, so a Windows AV/indexer EPERM leaves the
      // superseded file on disk, and preferring it restores a stale session
      // over correct disk bytes.
      await writeRecord(oldFile(), { format: "old-name" });
      await new Promise((r) => setTimeout(r, 20));
      await writeRecord(newFile(), { format: "new-name" });

      const loaded = await loadSession(migPath);
      expect(loaded!.format).toBe("new-name");
      await expect(fs.stat(oldFile())).resolves.toBeDefined();
    });

    it("falls back to the CURRENT key when the newer legacy file wins the tie-break and will not read", async () => {
      // `mtimeOf` succeeds where `readFile` does not — a legacy file truncated
      // by an interrupted pre-#1750 write, or EACCES to an AV/indexer — so the
      // loser it beat is a perfectly good record at the current key. Without
      // the fallback the SyntaxError branch unlinks the legacy file and returns
      // null, discarding both.
      await writeRecord(newFile(), { format: "new-name" });
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(oldFile(), "{ truncated", "utf-8");

      const loaded = await loadSession(migPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.format).toBe("new-name");
      // …and the corrupt one was quarantined on the way past, so the next load
      // does not pay for it again.
      await expect(fs.stat(oldFile())).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("the first successful saveSession removes the old name", async () => {
      await writeRecord(oldFile());
      await saveSession(migPath, "md", createTestDoc());
      await expect(fs.stat(newFile())).resolves.toBeDefined();
      await expect(fs.stat(oldFile())).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("a FAILED save leaves the old name intact (the unlink is ordered after the write)", async () => {
      // Inverted, this destroys the only record on ENOSPC.
      await writeRecord(oldFile());
      atomicWriteMock.impl = async () => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      };
      await expect(saveSession(migPath, "md", createTestDoc())).rejects.toThrow("ENOSPC");
      atomicWriteMock.impl = null;
      await expect(fs.stat(oldFile())).resolves.toBeDefined();
    });

    it("deleteSession removes BOTH names", async () => {
      // A first-found return leaves an old-name orphan that
      // `listSessionFilePaths` still enumerates, so "Clear all" appears to work
      // and the document is back on the next restart.
      await writeRecord(oldFile());
      await writeRecord(newFile());
      await deleteSession(migPath);
      await expect(fs.stat(oldFile())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(newFile())).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("listSessionFilePaths yields the path ONCE, with the newer-mtime record's readOnly", async () => {
      // Two rules that could pick different records would restore with the
      // loser's `readOnly` — #1591's class.
      await writeRecord(newFile(), { readOnly: true });
      await new Promise((r) => setTimeout(r, 20));
      await writeRecord(oldFile(), { readOnly: false });

      const entries = (await listSessionFilePaths()).filter((e) => e.filePath === migPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].readOnly).toBe(false);
    });

    it("listSessionFilePaths mirrors it: the NEW name's readOnly wins when the new name is newer", async () => {
      // The stated design invariant is that the dedupe and `loadSession` use
      // the SAME criterion, so it has to be provable in both directions here
      // too — with only the one-directional fixture above, dropping the mtime
      // comparison from `dedupeByFilePath` is green.
      await writeRecord(oldFile(), { readOnly: true });
      await new Promise((r) => setTimeout(r, 20));
      await writeRecord(newFile(), { readOnly: false });

      const entries = (await listSessionFilePaths()).filter((e) => e.filePath === migPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].readOnly).toBe(false);
    });

    it("listSessionFilePaths still SORTS by lastAccessed, not by mtime", async () => {
      // The dedupe uses file mtime; the sort keeps `lastAccessed`. The two
      // clocks answer different questions, and a fixture where they DISAGREE is
      // what stops a later simplification from unifying them.
      const older = path.resolve("tests/fixtures/session-sort-a.md");
      const newer = path.resolve("tests/fixtures/session-sort-b.md");
      const aFile = path.join(SESSION_DIR, `${sessionKey(older)}.json`);
      const bFile = path.join(SESSION_DIR, `${sessionKey(newer)}.json`);
      try {
        // `older` gets the HIGHER lastAccessed but is written FIRST (lower mtime).
        await fs.writeFile(
          aFile,
          JSON.stringify({
            filePath: older,
            format: "md",
            ydocState: "",
            sourceFileMtime: 0,
            lastAccessed: 9_000,
          }),
          "utf-8",
        );
        await new Promise((r) => setTimeout(r, 20));
        await fs.writeFile(
          bFile,
          JSON.stringify({
            filePath: newer,
            format: "md",
            ydocState: "",
            sourceFileMtime: 0,
            lastAccessed: 1_000,
          }),
          "utf-8",
        );
        const entries = (await listSessionFilePaths()).filter(
          (e) => e.filePath === older || e.filePath === newer,
        );
        expect(entries.map((e) => e.filePath)).toEqual([older, newer]);
      } finally {
        await fs.rm(aFile, { force: true });
        await fs.rm(bFile, { force: true });
      }
    });

    it("the CTRL session keeps its literal name and is still skipped by the restore list", async () => {
      const ctrlDoc = new Y.Doc();
      ctrlDoc.getMap(Y_MAP_CHAT).set("m1", { role: "user", content: "hi" });
      await saveCtrlSession(ctrlDoc);
      const ctrlFile = path.join(SESSION_DIR, `${encodeURIComponent("__tandem_ctrl__")}.json`);
      await expect(fs.stat(ctrlFile)).resolves.toBeDefined();
      const entries = await listSessionFilePaths();
      expect(entries.some((e) => e.filePath === "__tandem_ctrl__")).toBe(false);
      expect(await loadCtrlSession()).not.toBeNull();
    });
  });

  describe("save and restore round-trip", () => {
    const testFilePath = path.resolve("tests/fixtures/session-test.md");

    beforeEach(async () => {
      // Create a temp fixture file
      await fs.mkdir(path.dirname(testFilePath), { recursive: true });
      await fs.writeFile(testFilePath, "# Test\nHello world\n", "utf-8");
    });

    afterEach(async () => {
      await deleteSession(testFilePath);
      try {
        await fs.unlink(testFilePath);
      } catch {}
    });

    it("saves and loads session data", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      const session = await loadSession(testFilePath);
      expect(session).not.toBeNull();
      expect(session!.filePath).toBe(testFilePath);
      expect(session!.format).toBe("md");
      expect(session!.ydocState).toBeTruthy();
      expect(session!.lastAccessed).toBeGreaterThan(0);
    });

    it("restores Y.Doc content from session", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      const session = await loadSession(testFilePath);
      expect(session).not.toBeNull();

      // Restore into a fresh Y.Doc
      const restored = new Y.Doc();
      restoreYDoc(restored, session!);

      // Check document content
      const fragment = restored.getXmlFragment("default");
      expect(fragment.length).toBeGreaterThan(0);
    });

    it("restores annotations from session", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      const session = await loadSession(testFilePath);
      const restored = new Y.Doc();
      restoreYDoc(restored, session!);

      // Check annotations survived
      const annotations = restored.getMap(Y_MAP_ANNOTATIONS);
      const ann = annotations.get("ann_test_1") as any;
      expect(ann).toBeTruthy();
      expect(ann.id).toBe("ann_test_1");
      expect(ann.content).toBe("test note");
      expect(ann.color).toBe("yellow");
    });

    it("detects unchanged source file", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      const session = await loadSession(testFilePath);
      const changed = await sourceFileChanged(session!);
      expect(changed).toBe(false);
    });

    it("detects changed source file", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      // Modify the source file
      await new Promise((r) => setTimeout(r, 50)); // Ensure mtime differs
      await fs.writeFile(testFilePath, "# Modified\nDifferent content\n", "utf-8");

      const session = await loadSession(testFilePath);
      const changed = await sourceFileChanged(session!);
      expect(changed).toBe(true);
    });

    it("returns null for non-existent session", async () => {
      const session = await loadSession("/nonexistent/path.md");
      expect(session).toBeNull();
    });
  });

  describe("ctrl session restore clears stale document metadata", () => {
    it("preserves chat but clears openDocuments and activeDocumentId", async () => {
      // Build a ctrl doc with both chat history and stale document metadata
      const ctrlDoc = new Y.Doc();
      const chat = ctrlDoc.getMap(Y_MAP_CHAT);
      chat.set("msg1", { id: "msg1", author: "user", text: "hello", timestamp: Date.now() });
      chat.set("msg2", { id: "msg2", author: "claude", text: "hi back", timestamp: Date.now() });

      const meta = ctrlDoc.getMap(Y_MAP_DOCUMENT_META);
      meta.set("openDocuments", [
        {
          id: "stale-doc-1",
          filePath: "/old/path1.md",
          fileName: "path1.md",
          format: "md",
          readOnly: false,
        },
      ]);
      meta.set("activeDocumentId", "stale-doc-1");
      meta.set(Y_MAP_ACTIVE_DOCUMENT_EPOCH, 7);

      // Save it
      await saveCtrlSession(ctrlDoc);

      // Restore into a fresh doc (simulating server restart)
      const restored = new Y.Doc();
      const savedState = await loadCtrlSession();
      expect(savedState).not.toBeNull();
      restoreCtrlDoc(restored, savedState!);

      // Simulate the clear that restoreCtrlSession() now does
      const restoredMeta = restored.getMap(Y_MAP_DOCUMENT_META);
      restoredMeta.delete("openDocuments");
      restoredMeta.delete("activeDocumentId");
      restoredMeta.delete(Y_MAP_ACTIVE_DOCUMENT_EPOCH);

      // Chat should survive
      const restoredChat = restored.getMap(Y_MAP_CHAT);
      expect(restoredChat.get("msg1")).toBeTruthy();
      expect(restoredChat.get("msg2")).toBeTruthy();
      expect((restoredChat.get("msg1") as any).text).toBe("hello");

      // Document metadata should be cleared
      expect(restoredMeta.get("openDocuments")).toBeUndefined();
      expect(restoredMeta.get("activeDocumentId")).toBeUndefined();
      expect(restoredMeta.get(Y_MAP_ACTIVE_DOCUMENT_EPOCH)).toBeUndefined();
    });

    it("round-trips ctrl doc with only chat (no stale metadata)", async () => {
      const ctrlDoc = new Y.Doc();
      const chat = ctrlDoc.getMap(Y_MAP_CHAT);
      chat.set("msg1", { id: "msg1", author: "user", text: "test", timestamp: 12345 });

      await saveCtrlSession(ctrlDoc);

      const restored = new Y.Doc();
      const savedState = await loadCtrlSession();
      expect(savedState).not.toBeNull();
      restoreCtrlDoc(restored, savedState!);

      const restoredChat = restored.getMap(Y_MAP_CHAT);
      expect((restoredChat.get("msg1") as any).text).toBe("test");
    });
  });

  describe("empty session restore fallback", () => {
    const testFilePath = path.resolve("tests/fixtures/session-fallback.md");

    beforeEach(async () => {
      await fs.mkdir(path.dirname(testFilePath), { recursive: true });
      await fs.writeFile(testFilePath, "# Fallback Test\nContent here\n", "utf-8");
    });

    afterEach(async () => {
      await deleteSession(testFilePath);
      try {
        await fs.unlink(testFilePath);
      } catch {}
    });

    it("detects empty doc after restore via XmlFragment length", async () => {
      // Save a session from an empty Y.Doc (simulates the bug)
      const emptyDoc = new Y.Doc();
      await saveSession(testFilePath, "md", emptyDoc);

      // Load and restore
      const session = await loadSession(testFilePath);
      expect(session).not.toBeNull();

      const restored = new Y.Doc();
      restoreYDoc(restored, session!);

      // The restored doc should be empty — this is the check tandem_open uses
      const fragment = restored.getXmlFragment("default");
      expect(fragment.length).toBe(0);
    });

    it("detects populated doc after restore via XmlFragment length", async () => {
      const doc = createTestDoc();
      await saveSession(testFilePath, "md", doc);

      const session = await loadSession(testFilePath);
      const restored = new Y.Doc();
      restoreYDoc(restored, session!);

      const fragment = restored.getXmlFragment("default");
      expect(fragment.length).toBeGreaterThan(0);
    });
  });
});
