import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  registerDirtyObserver,
  resetForTesting as resetDirtyState,
} from "../../src/server/documents/dirty.js";
import type { OpenDoc } from "../../src/server/mcp/document-service.js";
import {
  addDoc,
  autoSaveAllToDisk,
  broadcastOpenDocs,
  broadcastStoreReadOnly,
  closeDocumentById,
  docCount,
  getActiveDocId,
  getCurrentDoc,
  getOpenDocs,
  hasDoc,
  removeDoc,
  requireDocument,
  saveDocumentAsToDisk,
  saveDocumentToDisk,
  serializeDocument,
  setActiveDocId,
  toDocListEntry,
} from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ACTIVE_DOCUMENT_EPOCH,
  Y_MAP_DOCUMENT_META,
  Y_MAP_SAVED_AT_VERSION,
  Y_MAP_STORE_READ_ONLY,
} from "../../src/shared/constants.js";

// Mock session manager to avoid filesystem side effects
vi.mock("../../src/server/session/manager.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    saveSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    stopAutoSave: vi.fn(),
  };
});

// Mock file-io for save tests. `atomicWrite` delegates to the real impl so the
// durable-annotation round-trip test (save-as promote) actually writes the
// annotation envelope to disk; the spy wrapper still lets save tests assert it
// was called. Doc saves in these tests target /tmp paths (harmless real writes).
vi.mock("../../src/server/file-io/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realAtomicWrite = actual.atomicWrite as (p: string, c: string) => Promise<void>;
  const realAtomicWriteBuffer = actual.atomicWriteBuffer as (p: string, b: Buffer) => Promise<void>;
  return {
    ...actual,
    atomicWrite: vi.fn((p: string, c: string) => realAtomicWrite(p, c)),
    // Spied so the .docx post-write-verify block test (#1123 0e) can assert the
    // binary write NEVER happens when verification blocks. Delegates to real so
    // any legitimate binary write still lands.
    atomicWriteBuffer: vi.fn((p: string, b: Buffer) => realAtomicWriteBuffer(p, b)),
  };
});

// Mock file-watcher
vi.mock("../../src/server/file-watcher.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    suppressNextChange: vi.fn(),
    unwatchFile: vi.fn(),
  };
});

// Mock notifications
vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pushNotification: vi.fn(),
  };
});

// Mock pre-overwrite snapshots — the real impl would write into the actual
// app-data dir as a save side effect. The spy also lets the save test assert
// the call-site contract (path + documentId).
vi.mock("../../src/server/file-io/doc-backup.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    snapshotBeforeFirstWrite: vi.fn().mockResolvedValue("written"),
  };
});

// Mock fs/promises for stat checks
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    default: {
      ...(actual.default as Record<string, unknown>),
      stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
    },
  };
});

function makeOpenDoc(id: string, filePath = `/tmp/${id}.md`): OpenDoc {
  return { id, filePath, format: "md", readOnly: false, source: "file" };
}

// Clean up state between tests — document-service uses module-level singletons
beforeEach(() => {
  // Clear all open docs
  for (const id of [...getOpenDocs().keys()]) {
    removeDoc(id);
  }
  setActiveDocId(null);
  resetDirtyState();
});

/** Insert a paragraph of text into a doc's body AFTER its dirty observer is
 *  registered, so the edit marks the doc dirty (mirrors a real content edit). */
function editBody(docId: string, text: string): void {
  const doc = getOrCreateDocument(docId);
  registerDirtyObserver(docId, doc);
  const frag = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  frag.insert(frag.length, [p]);
  p.insert(0, [new Y.XmlText(text)]);
}

describe("addDoc / removeDoc / hasDoc / docCount", () => {
  it("adds a document and reports it exists", () => {
    addDoc("doc-1", makeOpenDoc("doc-1"));
    expect(hasDoc("doc-1")).toBe(true);
    expect(docCount()).toBe(1);
  });

  it("removes a document", () => {
    addDoc("doc-2", makeOpenDoc("doc-2"));
    expect(removeDoc("doc-2")).toBe(true);
    expect(hasDoc("doc-2")).toBe(false);
    expect(docCount()).toBe(0);
  });

  it("removeDoc returns false for non-existent doc", () => {
    expect(removeDoc("no-such-doc")).toBe(false);
  });

  it("tracks multiple documents", () => {
    addDoc("a", makeOpenDoc("a"));
    addDoc("b", makeOpenDoc("b"));
    addDoc("c", makeOpenDoc("c"));
    expect(docCount()).toBe(3);
    expect(hasDoc("a")).toBe(true);
    expect(hasDoc("b")).toBe(true);
    expect(hasDoc("c")).toBe(true);
  });
});

describe("getActiveDocId / setActiveDocId", () => {
  it("defaults to null", () => {
    expect(getActiveDocId()).toBeNull();
  });

  it("sets and gets active doc ID", () => {
    setActiveDocId("doc-x");
    expect(getActiveDocId()).toBe("doc-x");
  });

  it("can be set to null", () => {
    setActiveDocId("doc-x");
    setActiveDocId(null);
    expect(getActiveDocId()).toBeNull();
  });
});

describe("getCurrentDoc", () => {
  it("returns null when no docs are open and no active doc", () => {
    expect(getCurrentDoc()).toBeNull();
  });

  it("returns null for non-existent documentId", () => {
    expect(getCurrentDoc("ghost")).toBeNull();
  });

  it("returns the active doc when no documentId specified", () => {
    addDoc("active-doc", makeOpenDoc("active-doc", "/tmp/active.md"));
    setActiveDocId("active-doc");

    const result = getCurrentDoc();
    expect(result).not.toBeNull();
    expect(result!.id).toBe("active-doc");
    expect(result!.docName).toBe("active-doc");
    expect(result!.filePath).toBe("/tmp/active.md");
  });

  it("returns specified doc by documentId even if different from active", () => {
    addDoc("doc-a", makeOpenDoc("doc-a", "/tmp/a.md"));
    addDoc("doc-b", makeOpenDoc("doc-b", "/tmp/b.md"));
    setActiveDocId("doc-a");

    const result = getCurrentDoc("doc-b");
    expect(result!.id).toBe("doc-b");
    expect(result!.filePath).toBe("/tmp/b.md");
  });

  it("returns null if active doc was removed", () => {
    addDoc("temp", makeOpenDoc("temp"));
    setActiveDocId("temp");
    removeDoc("temp");

    expect(getCurrentDoc()).toBeNull();
  });
});

describe("requireDocument", () => {
  it("returns null when no document is available", () => {
    expect(requireDocument()).toBeNull();
    expect(requireDocument("missing")).toBeNull();
  });

  it("returns Y.Doc, filePath, and docId for an open document", () => {
    addDoc("req-doc", makeOpenDoc("req-doc", "/tmp/req.md"));
    setActiveDocId("req-doc");

    const result = requireDocument();
    expect(result).not.toBeNull();
    expect(result!.docId).toBe("req-doc");
    expect(result!.filePath).toBe("/tmp/req.md");
    expect(result!.doc).toBeInstanceOf(Y.Doc);
  });

  it("returns Y.Doc for specified documentId", () => {
    addDoc("doc-x", makeOpenDoc("doc-x", "/tmp/x.md"));
    addDoc("doc-y", makeOpenDoc("doc-y", "/tmp/y.md"));
    setActiveDocId("doc-x");

    const result = requireDocument("doc-y");
    expect(result!.docId).toBe("doc-y");
    expect(result!.filePath).toBe("/tmp/y.md");
  });
});

describe("toDocListEntry", () => {
  it("builds a client-facing entry with fileName from filePath", () => {
    const doc: OpenDoc = {
      id: "entry-doc",
      filePath: "/home/user/documents/report.md",
      format: "md",
      readOnly: false,
      source: "file",
    };

    const entry = toDocListEntry(doc);
    expect(entry.id).toBe("entry-doc");
    expect(entry.fileName).toBe("report.md");
    expect(entry.format).toBe("md");
    expect(entry.readOnly).toBe(false);
  });

  it("handles upload:// paths", () => {
    const doc: OpenDoc = {
      id: "upload-doc",
      filePath: "upload://uuid-123/notes.txt",
      format: "txt",
      readOnly: true,
      source: "upload",
    };

    const entry = toDocListEntry(doc);
    expect(entry.fileName).toBe("notes.txt");
    expect(entry.readOnly).toBe(true);
  });
});

describe("broadcastOpenDocs", () => {
  it("writes open documents to CTRL_ROOM documentMeta", () => {
    addDoc("bc-1", makeOpenDoc("bc-1", "/tmp/bc1.md"));
    addDoc("bc-2", makeOpenDoc("bc-2", "/tmp/bc2.md"));
    setActiveDocId("bc-1");

    broadcastOpenDocs();

    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const meta = ctrl.getMap(Y_MAP_DOCUMENT_META);
    const docs = meta.get("openDocuments") as any[];
    const activeId = meta.get("activeDocumentId");

    expect(docs).toHaveLength(2);
    expect(activeId).toBe("bc-1");
    expect(docs.find((d: any) => d.id === "bc-1")).toBeTruthy();
    expect(docs.find((d: any) => d.id === "bc-2")).toBeTruthy();
  });

  it("writes to each open document room as well", () => {
    addDoc("room-a", makeOpenDoc("room-a"));
    addDoc("room-b", makeOpenDoc("room-b"));
    setActiveDocId("room-a");

    broadcastOpenDocs();

    const docA = getOrCreateDocument("room-a");
    const metaA = docA.getMap(Y_MAP_DOCUMENT_META);
    const docsA = metaA.get("openDocuments") as any[];
    expect(docsA).toHaveLength(2);

    const docB = getOrCreateDocument("room-b");
    const metaB = docB.getMap(Y_MAP_DOCUMENT_META);
    const docsB = metaB.get("openDocuments") as any[];
    expect(docsB).toHaveLength(2);
  });

  it("handles empty open docs without errors", () => {
    broadcastOpenDocs();

    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const meta = ctrl.getMap(Y_MAP_DOCUMENT_META);
    const docs = meta.get("openDocuments") as any[];
    expect(docs).toEqual([]);
    expect(meta.get("activeDocumentId")).toBeNull();
  });

  it("broadcasts an advancing activation epoch to CTRL_ROOM and per-doc rooms", () => {
    addDoc("ep-a", makeOpenDoc("ep-a"));
    setActiveDocId("ep-a");
    broadcastOpenDocs();

    const ctrlMeta = getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_DOCUMENT_META);
    const first = ctrlMeta.get(Y_MAP_ACTIVE_DOCUMENT_EPOCH) as number;
    expect(typeof first).toBe("number");
    // Mirrored into the doc's own room so a per-tab observer sees the same epoch.
    expect(
      getOrCreateDocument("ep-a").getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_ACTIVE_DOCUMENT_EPOCH),
    ).toBe(first);

    // Every setActiveDocId advances the epoch — even re-selecting the same id
    // (the intentional re-focus the client must honor).
    setActiveDocId("ep-a");
    broadcastOpenDocs();
    const second = ctrlMeta.get(Y_MAP_ACTIVE_DOCUMENT_EPOCH) as number;
    expect(second).toBeGreaterThan(first);
  });
});

describe("getOpenDocs", () => {
  it("returns a read-only view of open docs", () => {
    addDoc("ro-1", makeOpenDoc("ro-1"));
    const docs = getOpenDocs();
    expect(docs.size).toBe(1);
    expect(docs.get("ro-1")).toBeDefined();
  });
});

describe("closeDocumentById", () => {
  it("closes an open document and removes it from tracking", async () => {
    addDoc("close-1", makeOpenDoc("close-1", "/tmp/close1.md"));
    setActiveDocId("close-1");

    const result = await closeDocumentById("close-1");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.closedPath).toBe("/tmp/close1.md");
    }
    expect(hasDoc("close-1")).toBe(false);
    expect(docCount()).toBe(0);
  });

  it("returns error for non-existent document", async () => {
    const result = await closeDocumentById("no-such-doc");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not found");
    }
  });

  it("picks a new active doc when closing the active one", async () => {
    addDoc("active-close", makeOpenDoc("active-close"));
    addDoc("other-doc", makeOpenDoc("other-doc"));
    setActiveDocId("active-close");

    const result = await closeDocumentById("active-close");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.activeDocumentId).toBe("other-doc");
    }
    expect(getActiveDocId()).toBe("other-doc");
  });

  it("sets active to null when closing the last document", async () => {
    addDoc("last-doc", makeOpenDoc("last-doc"));
    setActiveDocId("last-doc");

    const result = await closeDocumentById("last-doc");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.activeDocumentId).toBeNull();
    }
    expect(getActiveDocId()).toBeNull();
  });

  it("does not change active doc when closing a non-active doc", async () => {
    addDoc("stay-active", makeOpenDoc("stay-active"));
    addDoc("close-me", makeOpenDoc("close-me"));
    setActiveDocId("stay-active");

    await closeDocumentById("close-me");
    expect(getActiveDocId()).toBe("stay-active");
    expect(hasDoc("close-me")).toBe(false);
  });

  it("calls stopAutoSave when closing the last document", async () => {
    const { stopAutoSave } = await import("../../src/server/session/manager.js");
    addDoc("final-doc", makeOpenDoc("final-doc"));
    setActiveDocId("final-doc");

    await closeDocumentById("final-doc");
    expect(stopAutoSave).toHaveBeenCalled();
  });

  it("deletes the session file on close", async () => {
    const { deleteSession, saveSession } = await import("../../src/server/session/manager.js");
    vi.mocked(saveSession).mockClear();
    addDoc("del-session", makeOpenDoc("del-session", "/tmp/del.md"));
    setActiveDocId("del-session");

    await closeDocumentById("del-session");
    expect(deleteSession).toHaveBeenCalledWith("/tmp/del.md");
    expect(saveSession).not.toHaveBeenCalled();
  });

  it("succeeds even when deleteSession rejects", async () => {
    const { deleteSession } = await import("../../src/server/session/manager.js");
    vi.mocked(deleteSession).mockClear();
    vi.mocked(deleteSession).mockRejectedValueOnce(new Error("EPERM"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    addDoc("fail-del", makeOpenDoc("fail-del", "/tmp/fail.md"));
    setActiveDocId("fail-del");

    const result = await closeDocumentById("fail-del");
    expect(result.success).toBe(true);
    expect(hasDoc("fail-del")).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete session"),
      "fail-del",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("broadcasts updated doc list after close", async () => {
    addDoc("bc-close-1", makeOpenDoc("bc-close-1"));
    addDoc("bc-close-2", makeOpenDoc("bc-close-2"));
    setActiveDocId("bc-close-1");
    broadcastOpenDocs();

    await closeDocumentById("bc-close-1");

    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const meta = ctrl.getMap(Y_MAP_DOCUMENT_META);
    const docs = meta.get("openDocuments") as any[];
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe("bc-close-2");
  });
});

describe("saveDocumentToDisk", () => {
  it("skips non-existent documents", async () => {
    const result = await saveDocumentToDisk("nonexistent");
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("not open");
  });

  it("skips upload-only documents", async () => {
    addDoc("upload-doc", {
      id: "upload-doc",
      filePath: "upload://uuid/file.md",
      format: "md",
      readOnly: true,
      source: "upload",
    });
    const result = await saveDocumentToDisk("upload-doc");
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("Upload");
  });

  it("skips read-only documents", async () => {
    addDoc("ro-doc", {
      id: "ro-doc",
      filePath: "/tmp/file.md",
      format: "md",
      readOnly: true,
      source: "file",
    });
    const result = await saveDocumentToDisk("ro-doc");
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("Read-only");
  });

  it("skips .html format", async () => {
    addDoc("html-doc", {
      id: "html-doc",
      filePath: "/tmp/file.html",
      format: "html",
      readOnly: false,
      source: "file",
    });
    const result = await saveDocumentToDisk("html-doc");
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("not eligible");
  });

  it("saves eligible .md documents to disk", async () => {
    const { atomicWrite } = await import("../../src/server/file-io/index.js");
    const { suppressNextChange } = await import("../../src/server/file-watcher.js");
    const { snapshotBeforeFirstWrite } = await import("../../src/server/file-io/doc-backup.js");

    addDoc("md-doc", makeOpenDoc("md-doc", "/tmp/test.md"));

    // Populate the Y.Doc so the adapter has content to save
    const doc = getOrCreateDocument("md-doc");
    const frag = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    frag.insert(0, [p]);
    const text = new Y.XmlText("Hello world");
    p.insert(0, [text]);

    // Set baseline so external-modification check passes
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    meta.set(Y_MAP_SAVED_AT_VERSION, Date.now());

    const result = await saveDocumentToDisk("md-doc");
    expect(result.status).toBe("saved");
    expect(atomicWrite).toHaveBeenCalled();
    expect(suppressNextChange).toHaveBeenCalledWith("/tmp/test.md");
    // Pre-overwrite snapshot runs before the write, keyed by path + doc id.
    expect(snapshotBeforeFirstWrite).toHaveBeenCalledWith(
      "/tmp/test.md",
      expect.objectContaining({ documentId: "md-doc" }),
    );
  });

  it("saves eligible .txt documents to disk", async () => {
    const { atomicWrite } = await import("../../src/server/file-io/index.js");

    addDoc("txt-doc", {
      id: "txt-doc",
      filePath: "/tmp/test.txt",
      format: "txt",
      readOnly: false,
      source: "file",
    });

    const doc = getOrCreateDocument("txt-doc");
    const frag = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    frag.insert(0, [p]);
    const text = new Y.XmlText("Hello");
    p.insert(0, [text]);

    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    meta.set(Y_MAP_SAVED_AT_VERSION, Date.now());

    const result = await saveDocumentToDisk("txt-doc");
    expect(result.status).toBe("saved");
    expect(atomicWrite).toHaveBeenCalled();
  });

  it("updates Y_MAP_SAVED_AT_VERSION after successful save", async () => {
    addDoc("ver-doc", makeOpenDoc("ver-doc", "/tmp/ver.md"));
    const doc = getOrCreateDocument("ver-doc");
    const frag = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    frag.insert(0, [p]);
    const text = new Y.XmlText("content");
    p.insert(0, [text]);

    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    const before = Date.now() - 10000;
    meta.set(Y_MAP_SAVED_AT_VERSION, before);

    await saveDocumentToDisk("ver-doc");

    const after = meta.get(Y_MAP_SAVED_AT_VERSION) as number;
    expect(after).toBeGreaterThan(before);
  });

  it("aborts the binary write (never overwrites) when post-write verify BLOCKS (#1123 0e)", async () => {
    addDoc("blk-doc", {
      id: "blk-doc",
      filePath: "/tmp/blk.docx",
      format: "docx",
      readOnly: false,
      source: "file",
    });
    const doc = getOrCreateDocument("blk-doc");
    const frag = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    frag.insert(0, [p]);
    p.insert(0, [new Y.XmlText("real body content the user typed")]);

    const { getAdapter, atomicWriteBuffer } = await import("../../src/server/file-io/index.js");
    const { suppressNextChange } = await import("../../src/server/file-watcher.js");
    const { pushNotification } = await import("../../src/server/notifications.js");
    // Force the export to emit garbage bytes → the verify reimport can't re-open
    // them → a confirmed-broken (blocked) verdict.
    const adapter = getAdapter("docx");
    vi.spyOn(adapter, "saveBinary").mockResolvedValue(Buffer.from("not a real docx") as never);

    // These spies are module-level singletons that accumulate across tests in
    // this file — clear them so the assertions below reflect only THIS save.
    vi.mocked(atomicWriteBuffer).mockClear();
    vi.mocked(suppressNextChange).mockClear();

    const result = await saveDocumentToDisk("blk-doc", "manual");

    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("VERIFY_BLOCKED");
    // The crown-jewel guarantee: corrupt bytes were NEVER written, and the
    // watcher suppressor was never armed for a write that didn't happen.
    expect(atomicWriteBuffer).not.toHaveBeenCalled();
    expect(suppressNextChange).not.toHaveBeenCalled();
    expect(pushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: "save-error", errorCode: "VERIFY_BLOCKED" }),
    );
  });
});

describe("broadcastStoreReadOnly", () => {
  it("writes storeReadOnly=true to CTRL_ROOM Y_MAP_DOCUMENT_META", () => {
    broadcastStoreReadOnly(true);
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const meta = ctrl.getMap(Y_MAP_DOCUMENT_META);
    expect(meta.get(Y_MAP_STORE_READ_ONLY)).toBe(true);
  });

  it("writes storeReadOnly=false to CTRL_ROOM Y_MAP_DOCUMENT_META", () => {
    // Set to true first, then clear it.
    broadcastStoreReadOnly(true);
    broadcastStoreReadOnly(false);
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const meta = ctrl.getMap(Y_MAP_DOCUMENT_META);
    expect(meta.get(Y_MAP_STORE_READ_ONLY)).toBe(false);
  });
});

describe("saveDocumentAsToDisk", () => {
  it("rejects unsupported formats", async () => {
    addDoc("save-as-doc", {
      id: "save-as-doc",
      filePath: "upload://scratchpad/x/Scratchpad.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    // Cast through unknown so we can verify runtime guard rejects non-allowlist formats.
    const result = await saveDocumentAsToDisk(
      "save-as-doc",
      "/tmp/anywhere.html",
      "html" as unknown as "md",
    );
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("UNSUPPORTED_FORMAT");
  });

  it("rejects when target extension doesn't match the chosen format", async () => {
    addDoc("ext-mismatch", {
      id: "ext-mismatch",
      filePath: "upload://scratchpad/x/Scratchpad.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    const result = await saveDocumentAsToDisk("ext-mismatch", "/tmp/promoted.txt", "md");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("EXTENSION_MISMATCH");
  });

  it("rejects unknown document IDs", async () => {
    const result = await saveDocumentAsToDisk("ghost-doc", "/tmp/anywhere.md", "md");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("NOT_FOUND");
  });

  it("rejects read-only documents", async () => {
    addDoc("ro-doc", {
      id: "ro-doc",
      filePath: "/tmp/locked.md",
      format: "md",
      readOnly: true,
      source: "file",
    });
    const result = await saveDocumentAsToDisk("ro-doc", "/tmp/elsewhere.md", "md");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("READ_ONLY");
  });

  it("rejects already-on-disk docs (source: file) with NOT_PROMOTABLE and writes nothing (#827 Medium)", async () => {
    const { atomicWrite } = await import("../../src/server/file-io/index.js");
    const { deleteSession } = await import("../../src/server/session/manager.js");
    vi.mocked(atomicWrite).mockClear();
    vi.mocked(deleteSession).mockClear();

    addDoc("real-file", {
      id: "real-file",
      filePath: "/tmp/already-on-disk.md",
      format: "md",
      readOnly: false,
      source: "file",
    });

    const result = await saveDocumentAsToDisk("real-file", "/tmp/promoted-target.md", "md");
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("NOT_PROMOTABLE");
    // Nothing is written, no session is re-keyed/deleted — the real file's
    // annotations and session must remain untouched.
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  // POSIX-only: Probe 1 asserts the literal absolute path reaches atomicWrite,
  // but win32 path.resolve rewrites "/etc/x" → "C:\etc\x". The path-widening
  // behavior itself works on win32; only the hard-coded POSIX assertion doesn't.
  // Linux CI exercises this; win32 path policy is covered by the UNC test below.
  it.skipIf(process.platform === "win32")(
    "allows a target path outside home/tmp — Save-As is user-driven, not PATH_REJECTED (#827 user decision)",
    async () => {
      const os = await import("node:os");
      const fsReal = await import("node:fs/promises");
      const pathMod = await import("node:path");
      const { atomicWrite } = await import("../../src/server/file-io/index.js");

      // Probe 1: an absolute path that exists outside both homedir() and
      // tmpdir() (`/etc`) must no longer be refused by the home/tmp
      // confinement. The old behavior returned PATH_REJECTED here; the user
      // decision is that any absolute path the user pointed the native Save
      // dialog at passes the path-safety gate (symlink + UNC guards aside).
      // Stub atomicWrite to a no-op so we assert the path-policy DECISION
      // without writing into a system directory (`/etc` would pollute and may
      // even be writable as root in CI).
      vi.mocked(atomicWrite).mockClear();
      vi.mocked(atomicWrite).mockResolvedValueOnce(undefined);
      addDoc("path-allow", {
        id: "path-allow",
        filePath: "upload://scratchpad/x/Scratchpad.md",
        format: "md",
        readOnly: false,
        source: "upload",
      });
      const doc = getOrCreateDocument("path-allow");
      const frag = doc.getXmlFragment("default");
      const p = new Y.XmlElement("paragraph");
      frag.insert(0, [p]);
      p.insert(0, [new Y.XmlText("content")]);

      const result = await saveDocumentAsToDisk("path-allow", "/etc/tandem-evil-827.md", "md");
      // The key assertion: the home/tmp confinement no longer rejects this.
      expect(result.errorCode).not.toBe("PATH_REJECTED");
      // The path-safety gate let it through to the (stubbed) write.
      expect(atomicWrite).toHaveBeenCalledWith("/etc/tandem-evil-827.md", expect.any(String));

      // Probe 2: end-to-end save into a freshly created dir outside the home
      // tree, proving the widening lets a legitimate user-chosen external
      // location through to a real disk write (atomicWrite delegates to the
      // real impl for non-stubbed calls).
      const writableDir = await fsReal.mkdtemp(pathMod.join(os.tmpdir(), "tandem-saveas-"));
      try {
        addDoc("path-allow-2", {
          id: "path-allow-2",
          filePath: "upload://scratchpad/y/Scratchpad.md",
          format: "md",
          readOnly: false,
          source: "upload",
        });
        const doc2 = getOrCreateDocument("path-allow-2");
        const frag2 = doc2.getXmlFragment("default");
        const p2 = new Y.XmlElement("paragraph");
        frag2.insert(0, [p2]);
        p2.insert(0, [new Y.XmlText("content")]);

        const okResult = await saveDocumentAsToDisk(
          "path-allow-2",
          pathMod.join(writableDir, "Promoted.md"),
          "md",
        );
        expect(okResult.errorCode).not.toBe("PATH_REJECTED");
        expect(okResult.status).toBe("saved");
      } finally {
        await fsReal.rm(writableDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  // POSIX-only: real fsReal.symlink() throws EPERM on win32 without Developer
  // Mode/admin, so the fixture can't be built. The symlink-rejection behavior
  // (assertPathSafe's realpath walk) is exercised on Linux CI.
  it.skipIf(process.platform === "win32")(
    "still rejects a symlinked target path with PATH_REJECTED and writes nothing (#827 keeps symlink guard)",
    async () => {
      const os = await import("node:os");
      const fsReal = await import("node:fs/promises");
      const pathMod = await import("node:path");
      const { atomicWrite } = await import("../../src/server/file-io/index.js");
      vi.mocked(atomicWrite).mockClear();

      // Create a real symlinked directory and aim the Save-As target through
      // it. assertPathSafe's realpath/symlink walk must still refuse: a planted
      // symlink redirecting the write is a genuine attack we keep guarding,
      // even though the home/tmp root confinement was widened.
      const baseDir = await fsReal.mkdtemp(pathMod.join(os.tmpdir(), "tandem-symlink-"));
      const realDir = pathMod.join(baseDir, "real");
      const linkDir = pathMod.join(baseDir, "link");
      await fsReal.mkdir(realDir);
      await fsReal.symlink(realDir, linkDir, "dir");

      try {
        addDoc("symlink-reject", {
          id: "symlink-reject",
          filePath: "upload://scratchpad/x/Scratchpad.md",
          format: "md",
          readOnly: false,
          source: "upload",
        });
        const doc = getOrCreateDocument("symlink-reject");
        const frag = doc.getXmlFragment("default");
        const p = new Y.XmlElement("paragraph");
        frag.insert(0, [p]);
        p.insert(0, [new Y.XmlText("content")]);

        const result = await saveDocumentAsToDisk(
          "symlink-reject",
          pathMod.join(linkDir, "Promoted.md"),
          "md",
        );
        expect(result.status).toBe("error");
        expect(result.errorCode).toBe("PATH_REJECTED");
        expect(atomicWrite).not.toHaveBeenCalled();
      } finally {
        await fsReal.rm(baseDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  it("rejects a UNC target path on win32 with INVALID_PATH and writes nothing (#827 Low)", async () => {
    const pathMod = (await import("node:path")).default;
    const { atomicWrite } = await import("../../src/server/file-io/index.js");
    vi.mocked(atomicWrite).mockClear();

    addDoc("unc-reject", {
      id: "unc-reject",
      filePath: "upload://scratchpad/x/Scratchpad.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });

    // Simulate win32: the UNC guard checks `process.platform === "win32"` on the
    // resolved path. On a POSIX test host `path.resolve` won't preserve the
    // leading `\\`, so stub both platform and resolve to reproduce the branch.
    const origPlatform = process.platform;
    const resolveSpy = vi.spyOn(pathMod, "resolve").mockReturnValue("\\\\server\\share\\evil.md");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const result = await saveDocumentAsToDisk("unc-reject", "\\\\server\\share\\evil.md", "md");
      expect(result.status).toBe("error");
      expect(result.errorCode).toBe("INVALID_PATH");
      expect(atomicWrite).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
      resolveSpy.mockRestore();
    }
  });

  it("re-keys the durable annotation store so post-promote annotations persist under the real path's docHash (#827 Medium 2)", async () => {
    const os = await import("node:os");
    const fsReal = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const { docHash } = await import("../../src/server/annotations/doc-hash.js");
    const { createStore, resetForTesting: storeReset } = await import(
      "../../src/server/annotations/store.js"
    );
    const { resetForTesting: syncReset } = await import("../../src/server/annotations/sync.js");
    const { resetForTesting: queueReset } = await import("../../src/server/events/queue.js");
    const { withBrowser } = await import("../../src/shared/origins.js");
    const { Y_MAP_ANNOTATIONS } = await import("../../src/shared/constants.js");

    // Isolated app-data dir so the annotation envelope round-trips on real disk.
    const appData = await fsReal.mkdtemp(pathMod.join(os.tmpdir(), "tandem-promote-"));
    const prevAppData = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = appData;
    storeReset();
    syncReset();
    queueReset();

    // Real disk target for the promoted file (saveSession is mocked, so only
    // the doc content + annotation envelope hit disk).
    const targetDir = await fsReal.mkdtemp(pathMod.join(os.tmpdir(), "tandem-target-"));
    const targetPath = pathMod.join(targetDir, "Promoted.md");

    try {
      const docId = "promote-annotations";
      const uploadPath = "upload://scratchpad/promote-uuid/Scratchpad.md";
      addDoc(docId, {
        id: docId,
        filePath: uploadPath,
        format: "md",
        readOnly: false,
        source: "upload",
      });
      setActiveDocId(docId);

      // Seed some content so the markdown adapter has something to serialize.
      const doc = getOrCreateDocument(docId);
      const frag = doc.getXmlFragment("default");
      const p = new Y.XmlElement("paragraph");
      frag.insert(0, [p]);
      p.insert(0, [new Y.XmlText("scratch content")]);

      const result = await saveDocumentAsToDisk(docId, targetPath, "md");
      expect(result.status).toBe("saved");

      // Add an annotation AFTER promote via a browser-origin transact so the
      // durable-sync observer (now wired to the real path's docHash) queues a
      // write.
      const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
      const annotation = {
        id: "ann-post-promote",
        type: "comment",
        author: "user",
        content: "created after promote",
        range: { from: 0, to: 5 },
        status: "pending",
        timestamp: Date.now(),
        rev: 1,
      };
      withBrowser(doc, () => annMap.set(annotation.id, annotation));

      // Flush the per-doc store (module-keyed by docHash) so the debounced
      // write lands, then read it back through a fresh handle keyed to the
      // PROMOTED path's docHash — proving continuity under the real-path key.
      const promotedHash = docHash(targetPath);
      const verifyStore = createStore(promotedHash, { filePath: targetPath });
      await verifyStore.flush();
      const loaded = await verifyStore.load();

      expect(loaded.annotations.map((a) => a.id)).toContain("ann-post-promote");
      // And NOT under the old upload docHash.
      const uploadHash = docHash(uploadPath);
      expect(uploadHash).not.toBe(promotedHash);
    } finally {
      // Restore env + clean module state so later tests aren't polluted.
      if (prevAppData === undefined) delete process.env.TANDEM_APP_DATA_DIR;
      else process.env.TANDEM_APP_DATA_DIR = prevAppData;
      storeReset();
      syncReset();
      queueReset();
      await fsReal.rm(appData, { recursive: true, force: true }).catch(() => {});
      await fsReal.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("serializeDocument", () => {
  it("serializes an upload-backed scratchpad to markdown bytes", () => {
    addDoc("ser-doc", {
      id: "ser-doc",
      filePath: "upload://scratchpad/uuid/Scratchpad.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    const doc = getOrCreateDocument("ser-doc");
    const frag = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    frag.insert(0, [p]);
    p.insert(0, [new Y.XmlText("serialize me")]);

    const result = serializeDocument("ser-doc", "md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("serialize me");
      // Stem preserved, extension swapped to chosen format.
      expect(result.fileName).toBe("Scratchpad.md");
    }
  });

  it("re-stems the proposed filename to match the requested format", () => {
    addDoc("ser-doc-txt", {
      id: "ser-doc-txt",
      filePath: "upload://scratchpad/uuid/Scratchpad.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    const result = serializeDocument("ser-doc-txt", "txt");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fileName).toBe("Scratchpad.txt");
    }
  });

  it("returns error for unknown documents", () => {
    const result = serializeDocument("nope", "md");
    expect(result.ok).toBe(false);
  });

  it("returns error for unsupported formats", () => {
    addDoc("ser-doc-bad", {
      id: "ser-doc-bad",
      filePath: "upload://scratchpad/uuid/Scratchpad.md",
      format: "md",
      readOnly: false,
      source: "upload",
    });
    const result = serializeDocument("ser-doc-bad", "html" as unknown as "md");
    expect(result.ok).toBe(false);
  });
});

describe("autoSaveAllToDisk", () => {
  it("saves only eligible (and dirty) documents", async () => {
    const { atomicWrite } = await import("../../src/server/file-io/index.js");
    vi.mocked(atomicWrite).mockClear();

    // Add one eligible .md doc AND edit its body so it's dirty
    addDoc("auto-md", makeOpenDoc("auto-md", "/tmp/auto.md"));
    editBody("auto-md", "content");
    getOrCreateDocument("auto-md")
      .getMap(Y_MAP_DOCUMENT_META)
      .set(Y_MAP_SAVED_AT_VERSION, Date.now());

    // Add one ineligible .docx doc
    addDoc("auto-docx", {
      id: "auto-docx",
      filePath: "/tmp/auto.docx",
      format: "docx",
      readOnly: true,
      source: "file",
    });

    await autoSaveAllToDisk();

    // Only the .md doc should have been saved
    expect(atomicWrite).toHaveBeenCalledTimes(1);
  });

  // #851: opening a file to view it (no edits) must produce ZERO disk writes.
  it("does NOT write a doc that was opened but never edited", async () => {
    const { atomicWrite } = await import("../../src/server/file-io/index.js");
    vi.mocked(atomicWrite).mockClear();

    addDoc("auto-clean", makeOpenDoc("auto-clean", "/tmp/auto-clean.md"));
    const doc = getOrCreateDocument("auto-clean");
    // Simulate the open-time content load that happens BEFORE the dirty
    // observer is registered (finalizeDocOpen order) — content is present but
    // the doc is not dirty.
    const frag = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    frag.insert(0, [p]);
    p.insert(0, [new Y.XmlText("pre-existing on-disk content")]);
    registerDirtyObserver("auto-clean", doc);
    doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_SAVED_AT_VERSION, Date.now());

    await autoSaveAllToDisk();

    expect(atomicWrite).not.toHaveBeenCalled();
  });

  // #851 regression guard: Claude's tandem_edit writes are mcp-origin, NOT
  // browser-origin. A body edit (regardless of origin) must mark the doc dirty
  // so autosave persists it — a browser-only gate would silently drop them.
  it("DOES write a doc after a (mcp-style) body edit", async () => {
    const { atomicWrite } = await import("../../src/server/file-io/index.js");
    vi.mocked(atomicWrite).mockClear();

    addDoc("auto-edited", makeOpenDoc("auto-edited", "/tmp/auto-edited.md"));
    editBody("auto-edited", "Claude added this");
    getOrCreateDocument("auto-edited")
      .getMap(Y_MAP_DOCUMENT_META)
      .set(Y_MAP_SAVED_AT_VERSION, Date.now());

    await autoSaveAllToDisk();

    expect(atomicWrite).toHaveBeenCalledTimes(1);
  });

  // After a save the doc is clean; a second autosave pass with no new edit
  // must not write again.
  it("does not re-write a doc after it was saved with no further edits", async () => {
    const { atomicWrite } = await import("../../src/server/file-io/index.js");

    addDoc("auto-once", makeOpenDoc("auto-once", "/tmp/auto-once.md"));
    editBody("auto-once", "edit once");
    getOrCreateDocument("auto-once")
      .getMap(Y_MAP_DOCUMENT_META)
      .set(Y_MAP_SAVED_AT_VERSION, Date.now());

    vi.mocked(atomicWrite).mockClear();
    await autoSaveAllToDisk();
    expect(atomicWrite).toHaveBeenCalledTimes(1);

    // Second pass — no new edit, so no write.
    vi.mocked(atomicWrite).mockClear();
    await autoSaveAllToDisk();
    expect(atomicWrite).not.toHaveBeenCalled();
  });
});
