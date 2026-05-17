/**
 * Tests for the ADR-033 document registry seam.
 *
 * The registry owns the multi-document state (openDocs map + activeDocId)
 * previously embedded in `document-service.ts`. These tests verify the
 * public API and the keep-alive predicate contract.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  addDoc,
  docCount,
  getActiveDocId,
  getCurrentDoc,
  getOpenDocs,
  hasDoc,
  removeDoc,
  requireDocument,
  setActiveDocId,
} from "../../src/server/documents/registry.js";

function reset() {
  for (const id of Array.from(getOpenDocs().keys())) removeDoc(id);
  setActiveDocId(null);
}

beforeEach(reset);

const FIXTURE = {
  id: "doc-1",
  filePath: "/tmp/doc-1.md",
  format: "md",
  readOnly: false,
  source: "file" as const,
};

describe("DocumentRegistry — open-docs map", () => {
  it("addDoc + hasDoc + docCount + getOpenDocs reflect the same store", () => {
    expect(docCount()).toBe(0);
    expect(hasDoc(FIXTURE.id)).toBe(false);

    addDoc(FIXTURE.id, FIXTURE);

    expect(docCount()).toBe(1);
    expect(hasDoc(FIXTURE.id)).toBe(true);
    expect(getOpenDocs().get(FIXTURE.id)).toEqual(FIXTURE);
  });

  it("removeDoc returns true when the entry existed", () => {
    addDoc(FIXTURE.id, FIXTURE);
    expect(removeDoc(FIXTURE.id)).toBe(true);
    expect(removeDoc(FIXTURE.id)).toBe(false);
    expect(docCount()).toBe(0);
  });

  it("getOpenDocs returns a live view (reflects subsequent mutations)", () => {
    const view = getOpenDocs();
    expect(view.size).toBe(0);
    addDoc(FIXTURE.id, FIXTURE);
    expect(view.size).toBe(1);
  });
});

describe("DocumentRegistry — active doc id", () => {
  it("setActiveDocId / getActiveDocId round-trip", () => {
    expect(getActiveDocId()).toBeNull();
    setActiveDocId("doc-a");
    expect(getActiveDocId()).toBe("doc-a");
    setActiveDocId(null);
    expect(getActiveDocId()).toBeNull();
  });
});

describe("DocumentRegistry — getCurrentDoc", () => {
  it("returns null when no doc is open and no documentId provided", () => {
    expect(getCurrentDoc()).toBeNull();
    expect(getCurrentDoc(undefined)).toBeNull();
  });

  it("returns null when documentId is not in the registry", () => {
    expect(getCurrentDoc("nonexistent")).toBeNull();
  });

  it("defaults to the active doc when no documentId is provided", () => {
    addDoc(FIXTURE.id, FIXTURE);
    setActiveDocId(FIXTURE.id);
    const current = getCurrentDoc();
    expect(current).not.toBeNull();
    expect(current?.docName).toBe(FIXTURE.id);
    expect(current?.filePath).toBe(FIXTURE.filePath);
  });

  it("honours an explicit documentId over the active doc", () => {
    addDoc("active", { ...FIXTURE, id: "active", filePath: "/tmp/active.md" });
    addDoc("other", { ...FIXTURE, id: "other", filePath: "/tmp/other.md" });
    setActiveDocId("active");
    const current = getCurrentDoc("other");
    expect(current?.docName).toBe("other");
    expect(current?.filePath).toBe("/tmp/other.md");
  });
});

describe("DocumentRegistry — requireDocument", () => {
  it("returns null when no doc is open", () => {
    expect(requireDocument()).toBeNull();
  });

  it("returns { doc, filePath, docId } when a doc is open", () => {
    addDoc(FIXTURE.id, FIXTURE);
    setActiveDocId(FIXTURE.id);
    const req = requireDocument();
    expect(req).not.toBeNull();
    expect(req?.docId).toBe(FIXTURE.id);
    expect(req?.filePath).toBe(FIXTURE.filePath);
    expect(req?.doc).toBeDefined();
  });
});
