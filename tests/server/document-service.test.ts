import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  getOpenDocs,
  addDoc,
  removeDoc,
  hasDoc,
  docCount,
  getActiveDocId,
  setActiveDocId,
  getCurrentDoc,
  requireDocument,
  toDocListEntry,
  broadcastOpenDocs,
} from "../../src/server/mcp/document-service.js";
import type { OpenDoc } from "../../src/server/mcp/document-service.js";
import { CTRL_ROOM } from "../../src/shared/constants.js";

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
    const meta = ctrl.getMap("documentMeta");
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
    const metaA = docA.getMap("documentMeta");
    const docsA = metaA.get("openDocuments") as any[];
    expect(docsA).toHaveLength(2);

    const docB = getOrCreateDocument("room-b");
    const metaB = docB.getMap("documentMeta");
    const docsB = metaB.get("openDocuments") as any[];
    expect(docsB).toHaveLength(2);
  });

  it("handles empty open docs without errors", () => {
    broadcastOpenDocs();

    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const meta = ctrl.getMap("documentMeta");
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
