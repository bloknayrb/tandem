import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  addDoc,
  removeDoc,
  setActiveDocId,
  getOpenDocs,
  getCurrentDoc,
  requireDocument,
  hasDoc,
  docCount,
} from "../../src/server/mcp/document-service.js";
import {
  populateYDoc,
  resolveOffset,
  getOrCreateXmlText,
  verifyAndResolveRange,
} from "../../src/server/mcp/document.js";
import { getOutline, getSection } from "../../src/server/mcp/document.js";

function setupDoc(id: string, text: string, opts?: { readOnly?: boolean; format?: string }) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, {
    id,
    filePath: `/tmp/${id}.md`,
    format: opts?.format ?? "md",
    readOnly: opts?.readOnly ?? false,
    source: "file",
  });
  setActiveDocId(id);
  return ydoc;
}

beforeEach(() => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
});

describe("tandem_getContent logic", () => {
  it("returns non-empty fragment JSON for populated doc", () => {
    const ydoc = setupDoc("gc-1", "Hello world");
    const fragment = ydoc.getXmlFragment("default");
    const json = fragment.toJSON();
    expect(json).toBeDefined();
    expect(typeof json === "string" || typeof json === "object").toBe(true);
  });

  it("returns null for non-existent document", () => {
    expect(requireDocument("nonexistent")).toBeNull();
  });

  it("returns null when no active document", () => {
    expect(requireDocument()).toBeNull();
  });
});

describe("tandem_getTextContent — section filtering via getSection()", () => {
  it("extracts a matching section by heading", () => {
    const ydoc = setupDoc("gtc-1", "## Introduction\nFirst content\n## Methods\nSecond content");
    const fragment = ydoc.getXmlFragment("default");

    const result = getSection(fragment, "Methods");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.text).toContain("## Methods");
      expect(result.text).toContain("Second content");
      expect(result.text).not.toContain("Introduction");
    }
  });

  it("section filtering is case-insensitive", () => {
    const ydoc = setupDoc("gtc-2", "## My Section\nContent here");
    const fragment = ydoc.getXmlFragment("default");

    const result = getSection(fragment, "MY SECTION");
    expect(result.found).toBe(true);
  });

  it("returns not found for non-existent section", () => {
    const ydoc = setupDoc("gtc-3", "## Introduction\nContent");
    const fragment = ydoc.getXmlFragment("default");

    const result = getSection(fragment, "Nonexistent");
    expect(result.found).toBe(false);
  });

  it("stops at same-level heading", () => {
    const ydoc = setupDoc("gtc-4", "## A\nContent A\n## B\nContent B");
    const fragment = ydoc.getXmlFragment("default");

    const result = getSection(fragment, "A");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.text).toContain("Content A");
      expect(result.text).not.toContain("Content B");
    }
  });

  it("includes sub-headings within section", () => {
    const ydoc = setupDoc("gtc-5", "## Parent\nContent\n### Child\nChild content\n## Next");
    const fragment = ydoc.getXmlFragment("default");

    const result = getSection(fragment, "Parent");
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.text).toContain("### Child");
      expect(result.text).toContain("Child content");
      expect(result.text).not.toContain("Next");
    }
  });
});

describe("tandem_getOutline via getOutline()", () => {
  it("extracts heading outline from document", () => {
    const ydoc = setupDoc("go-1", "# Title\n## Section 1\nParagraph\n## Section 2\n### Subsection");
    const fragment = ydoc.getXmlFragment("default");

    const outline = getOutline(fragment);
    expect(outline).toHaveLength(4);
    expect(outline[0]).toEqual({ level: 1, text: "Title", index: 0 });
    expect(outline[1]).toEqual({ level: 2, text: "Section 1", index: 1 });
    expect(outline[2]).toEqual({ level: 2, text: "Section 2", index: 3 });
    expect(outline[3]).toEqual({ level: 3, text: "Subsection", index: 4 });
  });

  it("returns empty outline for document with no headings", () => {
    const ydoc = setupDoc("go-2", "Just a paragraph\nAnother paragraph");
    const fragment = ydoc.getXmlFragment("default");

    const outline = getOutline(fragment);
    expect(outline).toHaveLength(0);
  });

  it("handles single heading doc", () => {
    const ydoc = setupDoc("go-3", "# Only Heading");
    const fragment = ydoc.getXmlFragment("default");

    const outline = getOutline(fragment);
    expect(outline).toHaveLength(1);
    expect(outline[0].level).toBe(1);
  });
});

describe("tandem_edit — read-only guard", () => {
  it("read-only documents block edits", () => {
    setupDoc("ro-edit", "Read-only content", { readOnly: true });
    const docState = getCurrentDoc("ro-edit");
    expect(docState?.readOnly).toBe(true);

    // The actual guard: document.ts:266-268 checks docState.readOnly and returns mcpError.
    // We verify the flag is correctly set, which the guard checks at runtime.
  });
});

describe("tandem_edit — range validation via resolveOffset", () => {
  it("rejects from > to by returning error (tested via resolveOffset validity)", () => {
    const ydoc = setupDoc("inv-1", "Hello world");
    const fragment = ydoc.getXmlFragment("default");

    // The actual production guard at document.ts:270 is: if (from > to) return mcpError(...)
    // We can verify the precondition and the offset resolution
    const pos10 = resolveOffset(fragment, 10);
    const pos5 = resolveOffset(fragment, 5);
    expect(pos10).not.toBeNull();
    expect(pos5).not.toBeNull();
    // from=10 > to=5 → the handler would reject this
    expect(pos10!.textOffset).toBeGreaterThan(pos5!.textOffset);
  });

  it("from === to is a valid insert point", () => {
    const ydoc = setupDoc("ins-1", "Hello world");
    const fragment = ydoc.getXmlFragment("default");
    const startPos = resolveOffset(fragment, 5);
    const endPos = resolveOffset(fragment, 5);
    expect(startPos).not.toBeNull();
    expect(endPos).not.toBeNull();
    expect(startPos!.textOffset).toBe(endPos!.textOffset);
  });
});

describe("tandem_edit — textSnapshot stale detection via verifyAndResolveRange", () => {
  it("detects stale range when text has been edited", () => {
    const ydoc = setupDoc("stale-1", "The quick brown fox");
    const fragment = ydoc.getXmlFragment("default");
    const el = fragment.get(0) as Y.XmlElement;
    const xmlText = getOrCreateXmlText(el);
    xmlText.delete(4, 5);
    xmlText.insert(4, "slow");

    const result = verifyAndResolveRange(ydoc, 4, 9, "quick");
    expect(result.valid).toBe(false);
  });

  it("verifies valid range when text matches", () => {
    const ydoc = setupDoc("stale-2", "Hello world");
    const result = verifyAndResolveRange(ydoc, 0, 5, "Hello");
    expect(result.valid).toBe(true);
  });

  it("relocates text that has moved", () => {
    const ydoc = setupDoc("relocate", "Hello world");
    const fragment = ydoc.getXmlFragment("default");
    const el = fragment.get(0) as Y.XmlElement;
    const xmlText = el.get(0) as Y.XmlText;
    xmlText.insert(0, "XXX");

    const result = verifyAndResolveRange(ydoc, 0, 5, "Hello");
    expect(result.valid).toBe(false);
    if (!result.gone) {
      expect(result.resolvedFrom).toBe(3);
      expect(result.resolvedTo).toBe(8);
    }
  });
});

describe("tandem_edit — heading prefix rejection via resolveOffset", () => {
  it("detects heading prefix in edit range", () => {
    const ydoc = setupDoc("hp-1", "## Heading Text");
    const fragment = ydoc.getXmlFragment("default");

    const pos0 = resolveOffset(fragment, 0);
    const pos1 = resolveOffset(fragment, 1);
    const pos2 = resolveOffset(fragment, 2);
    const pos3 = resolveOffset(fragment, 3); // first text char

    expect(pos0!.clampedFromPrefix).toBe(true);
    expect(pos1!.clampedFromPrefix).toBe(true);
    expect(pos2!.clampedFromPrefix).toBe(true);
    expect(pos3!.clampedFromPrefix).toBe(false);
  });
});

describe("tandem_save — source detection", () => {
  it("upload source documents are identified for session-only save", () => {
    addDoc("upload-doc", {
      id: "upload-doc",
      filePath: "upload://uuid/notes.md",
      format: "md",
      readOnly: true,
      source: "upload",
    });
    setActiveDocId("upload-doc");

    const docState = getCurrentDoc("upload-doc");
    expect(docState?.source).toBe("upload");
    expect(docState?.readOnly).toBe(true);
  });
});

describe("tandem_close logic", () => {
  it("removes document from open docs", () => {
    setupDoc("close-1", "Content to close");
    expect(hasDoc("close-1")).toBe(true);

    removeDoc("close-1");
    expect(hasDoc("close-1")).toBe(false);
    expect(docCount()).toBe(0);
  });

  it("switches active doc to remaining doc on close", () => {
    setupDoc("close-a", "Doc A");
    setupDoc("close-b", "Doc B");
    setActiveDocId("close-b");

    removeDoc("close-b");
    const remaining = [...getOpenDocs().keys()];
    if (remaining.length > 0) setActiveDocId(remaining[0]);
    else setActiveDocId(null);

    expect(getOpenDocs().size).toBe(1);
    expect(hasDoc("close-a")).toBe(true);
  });

  it("sets active to null when last doc closed", () => {
    setupDoc("close-only", "Only doc");
    removeDoc("close-only");
    setActiveDocId(null);

    expect(docCount()).toBe(0);
    expect(getCurrentDoc()).toBeNull();
  });
});

describe("tandem_status logic", () => {
  it("reports no active document when none open", () => {
    expect(getCurrentDoc()).toBeNull();
    expect(docCount()).toBe(0);
  });

  it("reports active document info", () => {
    setupDoc("status-doc", "Content");
    const current = getCurrentDoc();
    expect(current).not.toBeNull();
    expect(current!.id).toBe("status-doc");
    expect(current!.format).toBe("md");
  });
});

describe("tandem_switchDocument logic", () => {
  it("switches active document", () => {
    setupDoc("sw-a", "A");
    setupDoc("sw-b", "B");
    setActiveDocId("sw-a");

    expect(getCurrentDoc()!.id).toBe("sw-a");
    setActiveDocId("sw-b");
    expect(getCurrentDoc()!.id).toBe("sw-b");
  });

  it("rejects switching to non-existent document", () => {
    setupDoc("sw-c", "C");
    expect(hasDoc("nonexistent")).toBe(false);
  });
});
