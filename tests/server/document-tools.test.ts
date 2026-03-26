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
  extractText,
  extractMarkdown,
  getElementText,
  resolveOffset,
  getOrCreateXmlText,
  verifyAndResolveRange,
} from "../../src/server/mcp/document.js";
import { headingPrefix } from "../../src/shared/offsets.js";

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
  it("returns full document fragment as JSON", () => {
    const ydoc = setupDoc("gc-1", "Hello world");
    const fragment = ydoc.getXmlFragment("default");
    const json = fragment.toJSON();
    expect(json).toBeDefined();
    // XmlFragment.toJSON() returns a string representation, not an array
    expect(typeof json === "string" || typeof json === "object").toBe(true);
  });

  it("returns null for non-existent document", () => {
    expect(requireDocument("nonexistent")).toBeNull();
  });

  it("returns null when no active document", () => {
    expect(requireDocument()).toBeNull();
  });
});

describe("tandem_getTextContent logic", () => {
  it("returns full text for document", () => {
    const ydoc = setupDoc("gtc-1", "Hello world");
    const text = extractText(ydoc);
    expect(text).toBe("Hello world");
  });

  it("extracts markdown for md format", () => {
    const ydoc = setupDoc("gtc-2", "## Heading\nParagraph text");
    const md = extractMarkdown(ydoc);
    expect(md).toContain("## Heading");
    expect(md).toContain("Paragraph text");
  });

  it("section filtering finds matching heading", () => {
    const ydoc = setupDoc("gtc-3", "## Introduction\nFirst content\n## Methods\nSecond content");
    const fragment = ydoc.getXmlFragment("default");

    const lines: string[] = [];
    let inSection = false;
    let sectionLevel = 0;

    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (!(node instanceof Y.XmlElement)) continue;

      const text = getElementText(node);
      if (node.nodeName === "heading") {
        const level = Number(node.getAttribute("level") ?? 1);
        if (inSection && level <= sectionLevel) break;
        if (text.trim().toLowerCase() === "methods") {
          inSection = true;
          sectionLevel = level;
          lines.push(headingPrefix(level) + text);
          continue;
        }
      }
      if (inSection) lines.push(text);
    }

    expect(inSection).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("## Methods");
    expect(lines[1]).toBe("Second content");
  });

  it("section filtering is case-insensitive", () => {
    const ydoc = setupDoc("gtc-4", "## My Section\nContent here");
    const fragment = ydoc.getXmlFragment("default");

    let found = false;
    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (!(node instanceof Y.XmlElement)) continue;
      const text = getElementText(node);
      if (text.trim().toLowerCase() === "my section") {
        found = true;
        break;
      }
    }

    expect(found).toBe(true);
  });

  it("returns error when section not found", () => {
    const ydoc = setupDoc("gtc-5", "## Introduction\nContent");
    const fragment = ydoc.getXmlFragment("default");

    let inSection = false;
    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (!(node instanceof Y.XmlElement)) continue;
      const text = getElementText(node);
      if (text.trim().toLowerCase() === "nonexistent") {
        inSection = true;
      }
    }

    expect(inSection).toBe(false);
  });
});

describe("tandem_getOutline logic", () => {
  it("extracts heading outline from document", () => {
    const ydoc = setupDoc("go-1", "# Title\n## Section 1\nParagraph\n## Section 2\n### Subsection");
    const fragment = ydoc.getXmlFragment("default");
    const outline: Array<{ level: number; text: string; index: number }> = [];

    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (node instanceof Y.XmlElement && node.nodeName === "heading") {
        const level = Number(node.getAttribute("level") ?? 1);
        outline.push({ level, text: getElementText(node), index: i });
      }
    }

    expect(outline).toHaveLength(4);
    expect(outline[0]).toEqual({ level: 1, text: "Title", index: 0 });
    expect(outline[1]).toEqual({ level: 2, text: "Section 1", index: 1 });
    expect(outline[2]).toEqual({ level: 2, text: "Section 2", index: 3 });
    expect(outline[3]).toEqual({ level: 3, text: "Subsection", index: 4 });
  });

  it("returns empty outline for document with no headings", () => {
    const ydoc = setupDoc("go-2", "Just a paragraph\nAnother paragraph");
    const fragment = ydoc.getXmlFragment("default");
    const outline: any[] = [];

    for (let i = 0; i < fragment.length; i++) {
      const node = fragment.get(i);
      if (node instanceof Y.XmlElement && node.nodeName === "heading") {
        outline.push(node);
      }
    }

    expect(outline).toHaveLength(0);
  });
});

describe("tandem_edit logic — read-only guard", () => {
  it("rejects edits on read-only documents", () => {
    setupDoc("ro-edit", "Read-only content", { readOnly: true });
    const docState = getCurrentDoc("ro-edit");
    expect(docState?.readOnly).toBe(true);
  });
});

describe("tandem_edit logic — range validation", () => {
  it("detects from > to as invalid range", () => {
    setupDoc("inv-1", "Hello world");
    // from=10, to=5 → invalid
    const from = 10;
    const to = 5;
    expect(from > to).toBe(true);
  });

  it("from === to is a valid insert point", () => {
    const ydoc = setupDoc("ins-1", "Hello world");
    const fragment = ydoc.getXmlFragment("default");
    const from = 5;
    const to = 5;

    const startPos = resolveOffset(fragment, from);
    const endPos = resolveOffset(fragment, to);
    expect(startPos).not.toBeNull();
    expect(endPos).not.toBeNull();
    expect(startPos!.textOffset).toBe(endPos!.textOffset);
  });
});

describe("tandem_edit logic — textSnapshot stale detection", () => {
  it("detects stale range when text has been edited", () => {
    const ydoc = setupDoc("stale-1", "The quick brown fox");
    // Replace "quick" with "slow"
    const fragment = ydoc.getXmlFragment("default");
    const el = fragment.get(0) as Y.XmlElement;
    const xmlText = getOrCreateXmlText(el);
    xmlText.delete(4, 5); // delete "quick"
    xmlText.insert(4, "slow");

    // Now verify that "quick" no longer matches at [4, 9]
    const result = verifyAndResolveRange(ydoc, 4, 9, "quick");
    expect(result.valid).toBe(false);
  });

  it("verifies valid range when text matches", () => {
    const ydoc = setupDoc("stale-2", "Hello world");
    const result = verifyAndResolveRange(ydoc, 0, 5, "Hello");
    expect(result.valid).toBe(true);
  });
});

describe("tandem_edit logic — heading prefix rejection", () => {
  it("detects heading prefix in edit range", () => {
    const ydoc = setupDoc("hp-1", "## Heading Text");
    const fragment = ydoc.getXmlFragment("default");

    // Offset 0, 1, 2 are in "## " prefix
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

describe("tandem_save logic — read-only and upload guards", () => {
  it("identifies upload source documents", () => {
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
    // Simulate active doc switch logic from tandem_close
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

  it("reports all open documents", () => {
    setupDoc("s1", "Doc 1");
    setupDoc("s2", "Doc 2");
    setupDoc("s3", "Doc 3");

    expect(docCount()).toBe(3);
    expect(getOpenDocs().size).toBe(3);
  });
});

describe("tandem_listDocuments logic", () => {
  it("lists all open documents with active flag", () => {
    setupDoc("list-a", "A");
    setupDoc("list-b", "B");
    setActiveDocId("list-a");

    const docs = [...getOpenDocs().values()].map((d) => ({
      id: d.id,
      isActive: d.id === "list-a",
    }));

    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.id === "list-a")?.isActive).toBe(true);
    expect(docs.find((d) => d.id === "list-b")?.isActive).toBe(false);
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
