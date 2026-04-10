import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { OpenDoc } from "../../src/server/mcp/document-service.js";
import {
  addDoc,
  broadcastOpenDocs,
  closeDocumentById,
  docCount,
  getActiveDocId,
  getCurrentDoc,
  getOpenDocs,
  hasDoc,
  removeDoc,
  requireDocument,
  setActiveDocId,
  toDocListEntry,
} from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_DOCUMENT_META } from "../../src/shared/constants.js";

// Mock session manager to avoid filesystem side effects
vi.mock("../../src/server/session/manager.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    saveSession: vi.fn().mockResolvedValue(undefined),
    stopAutoSave: vi.fn(),
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
});

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
