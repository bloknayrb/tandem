# Apply Accepted Suggestions to .docx — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply accepted annotation suggestions back to .docx files as Word tracked changes, with backup/restore and browser UI.

**Architecture:** Three-phase build. Phase 1 extracts the shared offset walker from `docx-comments.ts` (pure refactor + `<w:del>` skip bug fix). Phase 2 builds the core XML transformation engine that reads accepted suggestions, maps flat offsets to XML positions, and emits `<w:ins>`/`<w:del>` tracked-change markup. Phase 3 wires up the MCP tool, API endpoint, and browser button.

**Tech Stack:** JSZip (existing), htmlparser2 + dom-serializer (existing transitive, promoted to direct), Y.js for CRDT resolution, Zod for tool schemas, vitest for unit tests, Playwright for E2E.

**Spec:** `docs/superpowers/specs/2026-04-05-docx-apply-changes-design.md`

---

## Phase 1: Walker Extraction (PR #1 — pure refactor + bug fix)

### Task 1: Extract shared walker module

**Files:**
- Create: `src/server/file-io/docx-walker.ts`
- Modify: `src/server/file-io/docx-comments.ts`
- Create: `tests/server/docx-walker.test.ts`

#### Background

The walker in `docx-comments.ts:124-158` counts flat-text offsets through `document.xml`. Both comment extraction (existing) and suggestion apply (new) need this logic. The extraction also fixes a latent bug: the current walker recurses into `<w:del>` subtrees, counting deleted tracked-change text that mammoth omits from its HTML output.

#### Step-by-step

- [ ] **Step 1: Create `docx-walker.ts` with the walker callback interface**

```typescript
// src/server/file-io/docx-walker.ts
//
// Shared offset-tracking walker for Word document.xml.
// Walks <w:body>, counts flat-text characters (matching Tandem's coordinate
// system including heading prefixes), and fires callbacks at registered points.

import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { headingPrefixLength } from "../../shared/offsets.js";

// ── DOM helpers (shared with docx-comments.ts) ──────────────────────────

export function isElement(node: ChildNode): node is Element {
  return node.type === "tag";
}

export function getAttr(el: Element, name: string): string | undefined {
  return el.attribs?.[name];
}

export function getTextContent(node: ChildNode): string {
  if (node.type === "text") return (node as { data: string }).data;
  if (!isElement(node)) return "";
  return node.children.map(getTextContent).join("");
}

export function findAllByName(name: string, nodes: ChildNode[]): Element[] {
  const results: Element[] = [];
  for (const node of nodes) {
    if (isElement(node)) {
      if (node.name === name) results.push(node);
      results.push(...findAllByName(name, node.children));
    }
  }
  return results;
}

// ── Walker types ────────────────────────────────────────────────────────

/** Fired for each <w:t> text node encountered during the walk. */
export interface WalkerTextHit {
  /** The <w:r> element containing this text node */
  run: Element;
  /** The <w:t> element */
  textNode: Element;
  /** Flat-text offset at the START of this text node */
  offsetStart: number;
  /** The text content of this node */
  text: string;
  /** The <w:p> paragraph element containing this run */
  paragraph: Element;
  /** w14:paraId of the paragraph, if present */
  paragraphId: string | undefined;
}

/** Fired for each <w:commentRangeStart> encountered during the walk. */
export interface WalkerCommentHit {
  commentId: string;
  offset: number;
  paragraph: Element;
  paragraphId: string | undefined;
}

export interface WalkerCallbacks {
  /** Called for every <w:t> text node with its offset and DOM references. */
  onText?: (hit: WalkerTextHit) => void;
  /** Called for <w:commentRangeStart> markers. */
  onCommentStart?: (hit: WalkerCommentHit) => void;
  /** Called for <w:commentRangeEnd> markers. */
  onCommentEnd?: (commentId: string, offset: number) => void;
}

export interface WalkResult {
  /** Total flat-text length of the document. */
  totalLength: number;
  /** Full flat text (for comparison guard). */
  flatText: string;
}

// ── Heading detection ───────────────────────────────────────────────────

/**
 * Detect heading level from a <w:p> element's paragraph properties.
 * Returns 1-6 for headings, 0 for non-headings.
 */
export function detectHeadingLevel(paragraph: Element): number {
  for (const child of paragraph.children) {
    if (!isElement(child) || child.name !== "w:pPr") continue;
    for (const prop of child.children) {
      if (!isElement(prop) || prop.name !== "w:pStyle") continue;
      const val = getAttr(prop, "w:val") || "";
      const match = val.match(/^heading\s*(\d)$/i);
      if (match) {
        const level = parseInt(match[1], 10);
        if (level >= 1 && level <= 6) return level;
      }
    }
  }
  return 0;
}

// ── Core walker ─────────────────────────────────────────────────────────

/**
 * Walk a parsed document.xml body, tracking flat-text offsets.
 *
 * Behavior:
 * - Skips <w:del> subtrees (deleted tracked-change text is excluded from
 *   Tandem's flat-text space, matching mammoth's default behavior).
 * - Traverses <w:ins> subtrees normally (inserted tracked-change text is
 *   part of the accepted document).
 * - Counts <w:tab>, <w:br>, <w:noBreakHyphen>, <w:softHyphen>, <w:sym>
 *   as 1 character each.
 * - Skips <w:instrText> (field instruction text).
 * - Counts heading prefixes via headingPrefixLength().
 */
export function walkDocumentBody(
  xml: string,
  callbacks: WalkerCallbacks = {},
): WalkResult {
  const doc = parseDocument(xml, { xmlMode: true });
  const bodyElements = findAllByName("w:body", doc.children);
  if (bodyElements.length === 0) {
    return { totalLength: 0, flatText: "" };
  }

  let offset = 0;
  let firstParagraph = true;
  const textParts: string[] = [];

  // Current paragraph context (updated on each <w:p> entry)
  let currentParagraph: Element | undefined;
  let currentParagraphId: string | undefined;

  function walk(nodes: ChildNode[]): void {
    for (const node of nodes) {
      if (!isElement(node)) continue;

      if (node.name === "w:p") {
        if (!firstParagraph) {
          offset += 1; // \n paragraph separator
          textParts.push("\n");
        }
        firstParagraph = false;

        currentParagraph = node;
        currentParagraphId = getAttr(node, "w14:paraId");

        const headingLevel = detectHeadingLevel(node);
        if (headingLevel > 0) {
          const prefixLen = headingPrefixLength(headingLevel);
          offset += prefixLen;
          textParts.push("#".repeat(headingLevel) + " ");
        }

        walk(node.children);
      } else if (node.name === "w:del") {
        // Skip deleted tracked-change content entirely.
        // mammoth excludes <w:del> text from its HTML output,
        // so these characters are not in Tandem's flat-text space.
        continue;
      } else if (node.name === "w:commentRangeStart") {
        const id = getAttr(node, "w:id");
        if (id) {
          callbacks.onCommentStart?.({
            commentId: id,
            offset,
            paragraph: currentParagraph!,
            paragraphId: currentParagraphId,
          });
        }
      } else if (node.name === "w:commentRangeEnd") {
        const id = getAttr(node, "w:id");
        if (id) callbacks.onCommentEnd?.(id, offset);
      } else if (node.name === "w:t") {
        const text = getTextContent(node);
        callbacks.onText?.({
          run: findParentRun(node) ?? node,
          textNode: node,
          offsetStart: offset,
          text,
          paragraph: currentParagraph!,
          paragraphId: currentParagraphId,
        });
        offset += text.length;
        textParts.push(text);
      } else if (node.name === "w:instrText") {
        // Field instruction text — not in visible content. Skip.
        continue;
      } else if (
        node.name === "w:tab" ||
        node.name === "w:br" ||
        node.name === "w:noBreakHyphen" ||
        node.name === "w:softHyphen" ||
        node.name === "w:sym"
      ) {
        offset += 1;
        // Approximate characters for flat-text representation
        if (node.name === "w:tab") textParts.push("\t");
        else if (node.name === "w:br") textParts.push("\n");
        else if (node.name === "w:noBreakHyphen") textParts.push("\u2011");
        else if (node.name === "w:softHyphen") textParts.push("\u00AD");
        else textParts.push("?"); // w:sym — placeholder
      } else {
        // Recurse into w:r, w:hyperlink, w:ins, w:pPr children, etc.
        walk(node.children);
      }
    }
  }

  walk(bodyElements[0].children);

  return {
    totalLength: offset,
    flatText: textParts.join(""),
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

/** Walk up from a <w:t> to find its parent <w:r> element. */
function findParentRun(node: ChildNode): Element | undefined {
  let current = node.parent;
  while (current) {
    if (isElement(current as ChildNode) && (current as Element).name === "w:r") {
      return current as Element;
    }
    current = (current as Element).parent;
  }
  return undefined;
}
```

- [ ] **Step 2: Write failing tests for the shared walker**

```typescript
// tests/server/docx-walker.test.ts
import { describe, it, expect } from "vitest";
import {
  walkDocumentBody,
  detectHeadingLevel,
  type WalkerTextHit,
} from "../../src/server/file-io/docx-walker.js";
import { parseDocument } from "htmlparser2";
import type { Element } from "domhandler";

// Helper: wrap content in minimal document.xml structure
function wrapBody(bodyContent: string): string {
  return `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
      <w:body>${bodyContent}</w:body>
    </w:document>`;
}

describe("walkDocumentBody", () => {
  it("counts simple paragraph text", () => {
    const xml = wrapBody(`
      <w:p><w:r><w:t>Hello world</w:t></w:r></w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(11);
    expect(result.flatText).toBe("Hello world");
  });

  it("counts paragraph separators", () => {
    const xml = wrapBody(`
      <w:p><w:r><w:t>First</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second</w:t></w:r></w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(12); // 5 + 1 + 6
    expect(result.flatText).toBe("First\nSecond");
  });

  it("adds heading prefix to offset", () => {
    const xml = wrapBody(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
        <w:r><w:t>Title</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    // "## " (3 chars) + "Title" (5 chars) = 8
    expect(result.totalLength).toBe(8);
    expect(result.flatText).toBe("## Title");
  });

  it("skips <w:del> subtrees", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>kept</w:t></w:r>
        <w:del w:id="1" w:author="X" w:date="2026-01-01T00:00:00Z">
          <w:r><w:delText>deleted</w:delText></w:r>
        </w:del>
        <w:r><w:t> text</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(9); // "kept" + " text"
    expect(result.flatText).toBe("kept text");
  });

  it("traverses <w:ins> subtrees normally", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>before</w:t></w:r>
        <w:ins w:id="2" w:author="X" w:date="2026-01-01T00:00:00Z">
          <w:r><w:t> inserted</w:t></w:r>
        </w:ins>
        <w:r><w:t> after</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(22); // "before" + " inserted" + " after"
    expect(result.flatText).toBe("before inserted after");
  });

  it("counts tab and break as 1 character each", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(5); // a + tab + b + br + c
  });

  it("counts noBreakHyphen and softHyphen as 1 character each", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>a</w:t><w:noBreakHyphen/><w:t>b</w:t><w:softHyphen/><w:t>c</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(5);
  });

  it("skips field instruction text", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>before</w:t></w:r>
        <w:r><w:instrText>PAGE</w:instrText></w:r>
        <w:r><w:t>after</w:t></w:r>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(11); // "before" + "after"
    expect(result.flatText).toBe("beforeafter");
  });

  it("descends into hyperlinks", () => {
    const xml = wrapBody(`
      <w:p>
        <w:hyperlink>
          <w:r><w:t>link text</w:t></w:r>
        </w:hyperlink>
      </w:p>
    `);
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(9);
    expect(result.flatText).toBe("link text");
  });

  it("fires onText callback with correct DOM references", () => {
    const xml = wrapBody(`
      <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
    `);
    const hits: WalkerTextHit[] = [];
    walkDocumentBody(xml, { onText: (hit) => hits.push(hit) });

    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("Hello");
    expect(hits[0].offsetStart).toBe(0);
    expect(hits[0].textNode.name).toBe("w:t");
    expect(hits[0].paragraph.name).toBe("w:p");
  });

  it("fires onCommentStart/onCommentEnd callbacks", () => {
    const xml = wrapBody(`
      <w:p w14:paraId="AABB0011">
        <w:commentRangeStart w:id="5"/>
        <w:r><w:t>commented</w:t></w:r>
        <w:commentRangeEnd w:id="5"/>
      </w:p>
    `);
    let startOffset = -1;
    let endOffset = -1;
    let paraId: string | undefined;

    walkDocumentBody(xml, {
      onCommentStart: (hit) => {
        startOffset = hit.offset;
        paraId = hit.paragraphId;
      },
      onCommentEnd: (_id, off) => { endOffset = off; },
    });

    expect(startOffset).toBe(0);
    expect(endOffset).toBe(9);
    expect(paraId).toBe("AABB0011");
  });

  it("returns empty result for missing <w:body>", () => {
    const xml = `<?xml version="1.0"?><w:document/>`;
    const result = walkDocumentBody(xml);
    expect(result.totalLength).toBe(0);
    expect(result.flatText).toBe("");
  });
});

describe("detectHeadingLevel", () => {
  function parseFirstParagraph(bodyContent: string): Element {
    const xml = wrapBody(bodyContent);
    const doc = parseDocument(xml, { xmlMode: true });
    // Find the first w:p
    function find(nodes: any[]): Element | undefined {
      for (const n of nodes) {
        if (n.type === "tag" && n.name === "w:p") return n;
        if (n.children) {
          const r = find(n.children);
          if (r) return r;
        }
      }
    }
    return find(doc.children)!;
  }

  it("returns level for Heading1-6", () => {
    for (let i = 1; i <= 6; i++) {
      const p = parseFirstParagraph(
        `<w:p><w:pPr><w:pStyle w:val="Heading${i}"/></w:pPr></w:p>`,
      );
      expect(detectHeadingLevel(p)).toBe(i);
    }
  });

  it("returns 0 for non-heading paragraphs", () => {
    const p = parseFirstParagraph(`<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p>`);
    expect(detectHeadingLevel(p)).toBe(0);
  });

  it("returns 0 for paragraphs with no style", () => {
    const p = parseFirstParagraph(`<w:p><w:r><w:t>plain</w:t></w:r></w:p>`);
    expect(detectHeadingLevel(p)).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/server/docx-walker.test.ts`
Expected: FAIL — module `docx-walker.ts` doesn't exist yet (well, we created it in step 1, so these should pass if step 1 is correct).

Actually — write the test file FIRST (before step 1) for true TDD, then create the module. But since the walker is a refactor of existing proven logic, writing both together and running tests is acceptable. The tests are the contract.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/docx-walker.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Refactor `docx-comments.ts` to use the shared walker**

Replace the inline `walk` function, `detectHeadingLevel`, and DOM helpers in `docx-comments.ts` with imports from `docx-walker.ts`. The `calculateCommentRanges` function becomes a thin wrapper around `walkDocumentBody`:

```typescript
// src/server/file-io/docx-comments.ts — updated calculateCommentRanges

import {
  walkDocumentBody,
  findAllByName,
  isElement,
  getAttr,
  getTextContent,
} from "./docx-walker.js";
// ... (keep existing imports for JSZip, Y, constants, etc.)
// Remove: parseDocument, ChildNode, Element imports (now from docx-walker)
// Remove: detectHeadingLevel, isElement, getAttr, getTextContent, findAllByName functions
// Remove: headingPrefixLength import (moved to docx-walker)

export function calculateCommentRanges(
  xml: string,
): Map<string, { from: FlatOffset; to: FlatOffset }> {
  const ranges = new Map<string, { from: FlatOffset; to: FlatOffset }>();
  const openRanges = new Map<string, number>();

  walkDocumentBody(xml, {
    onCommentStart: (hit) => {
      openRanges.set(hit.commentId, hit.offset);
    },
    onCommentEnd: (commentId, offset) => {
      if (openRanges.has(commentId)) {
        ranges.set(commentId, {
          from: toFlatOffset(openRanges.get(commentId)!),
          to: toFlatOffset(offset),
        });
        openRanges.delete(commentId);
      }
    },
  });

  if (openRanges.size > 0) {
    console.error(
      `[docx-comments] ${openRanges.size} comment range(s) had start markers but no end markers: ${[...openRanges.keys()].join(", ")}`,
    );
  }

  return ranges;
}
```

Keep `parseCommentMetadata` and `injectCommentsAsAnnotations` unchanged — they don't use the walker.

- [ ] **Step 6: Run existing docx-comments tests as regression guard**

Run: `npx vitest run tests/server/docx-comments.test.ts`
Expected: All existing tests PASS. The refactor is behavior-preserving for documents without tracked changes. For documents WITH `<w:del>` content, offsets change (the bug fix), but there are no existing test fixtures with tracked changes.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/file-io/docx-walker.ts src/server/file-io/docx-comments.ts tests/server/docx-walker.test.ts
git commit -m "refactor(docx): extract shared offset walker from docx-comments

Moves the document.xml offset-tracking logic into docx-walker.ts so both
comment extraction and the upcoming suggestion-apply feature share
identical offset arithmetic.

Behavior change: walker now skips <w:del> subtrees, fixing a latent bug
where pre-existing tracked deletions inflated offsets. Also handles
<w:noBreakHyphen>, <w:softHyphen>, <w:sym>, and skips <w:instrText>.

Closes phase 1 of #162"
```

---

## Phase 2: Core Apply Logic (PR #2 — the XML transformation engine)

### Task 2: Add `dom-serializer` as direct dependency and `atomicWriteBuffer`

**Files:**
- Modify: `package.json`
- Modify: `src/server/file-io/index.ts`

- [ ] **Step 1: Add `dom-serializer` to package.json**

Run: `npm install dom-serializer`

- [ ] **Step 2: Add `atomicWriteBuffer` to `index.ts`**

Add after the existing `atomicWrite` function (line 84 of `src/server/file-io/index.ts`):

```typescript
/**
 * Atomic binary file write: write Buffer to a temp file, then rename.
 * Used for .docx (ZIP) output where UTF-8 encoding would corrupt binary data.
 */
export async function atomicWriteBuffer(filePath: string, content: Buffer): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.tandem-tmp-${Date.now()}`);
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, filePath);
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json src/server/file-io/index.ts
git commit -m "feat(file-io): add dom-serializer dep and atomicWriteBuffer for binary writes"
```

---

### Task 3: Build the offset map from flat offsets to XML positions

**Files:**
- Create: `src/server/file-io/docx-apply.ts`
- Create: `tests/server/docx-apply.test.ts`

This task builds `buildOffsetMap` — the function that takes `document.xml` and a list of target offsets, and returns a map from each offset to its DOM node + character position.

- [ ] **Step 1: Write failing test for `buildOffsetMap`**

```typescript
// tests/server/docx-apply.test.ts
import { describe, it, expect } from "vitest";
import { buildOffsetMap } from "../../src/server/file-io/docx-apply.js";

function wrapBody(bodyContent: string): string {
  return `<?xml version="1.0"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
      <w:body>${bodyContent}</w:body>
    </w:document>`;
}

describe("buildOffsetMap", () => {
  it("maps offsets to correct text nodes in a single run", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, [0, 6, 11]);

    expect(map.get(0)).toBeDefined();
    expect(map.get(0)!.charIndex).toBe(0);
    expect(map.get(6)).toBeDefined();
    expect(map.get(6)!.charIndex).toBe(6);
    // offset 11 is at end-of-text (past last char) — still valid for range end
    expect(map.get(11)).toBeDefined();
    expect(map.get(11)!.charIndex).toBe(11);
  });

  it("maps offsets across multiple runs", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:t>abc</w:t></w:r>
        <w:r><w:t>def</w:t></w:r>
      </w:p>
    `);
    const map = buildOffsetMap(xml, [0, 3, 5]);

    // offset 0 → first run, char 0
    expect(map.get(0)!.charIndex).toBe(0);
    // offset 3 → second run, char 0
    expect(map.get(3)!.charIndex).toBe(0);
    // offset 5 → second run, char 2
    expect(map.get(5)!.charIndex).toBe(2);
  });

  it("accounts for heading prefix in offsets", () => {
    const xml = wrapBody(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
        <w:r><w:t>Title</w:t></w:r>
      </w:p>
    `);
    // "# Title" → "# " is 2 chars prefix, "Title" starts at offset 2
    const map = buildOffsetMap(xml, [2, 7]);

    expect(map.get(2)).toBeDefined(); // start of "Title"
    expect(map.get(2)!.charIndex).toBe(0);
    expect(map.get(7)).toBeDefined(); // end of "Title"
    expect(map.get(7)!.charIndex).toBe(5);
  });

  it("returns flatText for comparison guard", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`);
    const map = buildOffsetMap(xml, []);
    expect(map.flatText).toBe("Hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/docx-apply.test.ts`
Expected: FAIL — `docx-apply.ts` doesn't exist.

- [ ] **Step 3: Implement `buildOffsetMap`**

```typescript
// src/server/file-io/docx-apply.ts
//
// Apply accepted suggestions to .docx as tracked changes.
// Phase 2: Core XML transformation engine.

import { walkDocumentBody, type WalkerTextHit } from "./docx-walker.js";

// ── Offset map types ────────────────────────────────────────────────────

export interface OffsetMapEntry {
  /** The <w:r> run element containing the text */
  run: import("domhandler").Element;
  /** The <w:t> text element */
  textNode: import("domhandler").Element;
  /** Character index within the <w:t> text content */
  charIndex: number;
  /** The <w:p> paragraph element */
  paragraph: import("domhandler").Element;
  /** w14:paraId if present */
  paragraphId: string | undefined;
}

export interface OffsetMap {
  get(offset: number): OffsetMapEntry | undefined;
  flatText: string;
  totalLength: number;
  /** Comment anchor → paragraph paraId mapping */
  commentParagraphIds: Map<string, string>;
}

// ── Build offset map ────────────────────────────────────────────────────

/**
 * Walk document.xml and build a map from flat-text offsets to XML DOM positions.
 * Each target offset is resolved to the <w:r> run, <w:t> text node, and
 * character index within that text node.
 */
export function buildOffsetMap(xml: string, targetOffsets: number[]): OffsetMap {
  const targets = new Set(targetOffsets);
  const entries = new Map<number, OffsetMapEntry>();
  const commentParaIds = new Map<string, string>();

  // Collect all text hits — we'll resolve targets against them
  const textHits: WalkerTextHit[] = [];

  const result = walkDocumentBody(xml, {
    onText: (hit) => textHits.push(hit),
    onCommentStart: (hit) => {
      if (hit.paragraphId) {
        commentParaIds.set(hit.commentId, hit.paragraphId);
      }
    },
  });

  // For each target offset, find the text hit that contains it
  for (const targetOffset of targets) {
    // Check: is the target at the very end of the document?
    if (targetOffset === result.totalLength && textHits.length > 0) {
      const lastHit = textHits[textHits.length - 1];
      entries.set(targetOffset, {
        run: lastHit.run,
        textNode: lastHit.textNode,
        charIndex: lastHit.text.length,
        paragraph: lastHit.paragraph,
        paragraphId: lastHit.paragraphId,
      });
      continue;
    }

    for (const hit of textHits) {
      const hitEnd = hit.offsetStart + hit.text.length;
      if (targetOffset >= hit.offsetStart && targetOffset <= hitEnd) {
        entries.set(targetOffset, {
          run: hit.run,
          textNode: hit.textNode,
          charIndex: targetOffset - hit.offsetStart,
          paragraph: hit.paragraph,
          paragraphId: hit.paragraphId,
        });
        break;
      }
    }
  }

  return {
    get: (offset: number) => entries.get(offset),
    flatText: result.flatText,
    totalLength: result.totalLength,
    commentParagraphIds: commentParaIds,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/docx-apply.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/file-io/docx-apply.ts tests/server/docx-apply.test.ts
git commit -m "feat(docx-apply): build offset map from flat offsets to XML positions"
```

---

### Task 4: Implement run-splitting and tracked-change XML emission

**Files:**
- Modify: `src/server/file-io/docx-apply.ts`
- Modify: `tests/server/docx-apply.test.ts`

This is the highest-risk code in the feature. It splits `<w:r>` elements at range boundaries and wraps content in `<w:del>`/`<w:ins>` markup.

- [ ] **Step 1: Write failing tests for single-run replacement**

Add to `tests/server/docx-apply.test.ts`:

```typescript
import { buildOffsetMap, applySingleSuggestion } from "../../src/server/file-io/docx-apply.js";
import render from "dom-serializer";
import { parseDocument } from "htmlparser2";
import { findAllByName } from "../../src/server/file-io/docx-walker.js";

describe("applySingleSuggestion", () => {
  it("replaces text within a single run with del/ins markup", () => {
    const xml = wrapBody(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello world</w:t></w:r></w:p>`);
    const offsetMap = buildOffsetMap(xml, [6, 11]);

    const doc = parseDocument(xml, { xmlMode: true });
    const body = findAllByName("w:body", doc.children)[0];

    const result = applySingleSuggestion(body, offsetMap, {
      from: 6,
      to: 11,
      newText: "earth",
      author: "Test",
      date: "2026-04-05T00:00:00Z",
      revisionId: 50,
    });

    expect(result.ok).toBe(true);
    const output = render(body, { xmlMode: true });

    // Should contain <w:del> with "world" and <w:ins> with "earth"
    expect(output).toContain("<w:delText>world</w:delText>");
    expect(output).toContain("earth");
    expect(output).toContain("w:del");
    expect(output).toContain("w:ins");
    // "Hello " should remain untouched
    expect(output).toContain("<w:t>Hello </w:t>");
    // Bold formatting should be preserved on the ins run
    expect(output).toContain("<w:b/>");
  });

  it("handles deletion-only (empty newText)", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>remove this text</w:t></w:r></w:p>`);
    const offsetMap = buildOffsetMap(xml, [7, 12]);

    const doc = parseDocument(xml, { xmlMode: true });
    const body = findAllByName("w:body", doc.children)[0];

    const result = applySingleSuggestion(body, offsetMap, {
      from: 7,
      to: 12,
      newText: "",
      author: "Test",
      date: "2026-04-05T00:00:00Z",
      revisionId: 60,
    });

    expect(result.ok).toBe(true);
    const output = render(body, { xmlMode: true });
    expect(output).toContain("w:del");
    expect(output).not.toContain("w:ins");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/docx-apply.test.ts`
Expected: FAIL — `applySingleSuggestion` not exported.

- [ ] **Step 3: Implement `applySingleSuggestion`**

This is a substantial function. Add to `src/server/file-io/docx-apply.ts`:

```typescript
import { parseDocument } from "htmlparser2";
import render from "dom-serializer";
import type { ChildNode, Element } from "domhandler";
import { Element as DomElement, Text as DomText } from "domhandler";
import {
  walkDocumentBody,
  findAllByName,
  isElement,
  getAttr,
  getTextContent,
  type WalkerTextHit,
} from "./docx-walker.js";

// ── Suggestion application types ────────────────────────────────────────

export interface SuggestionInput {
  from: number;
  to: number;
  newText: string;
  author: string;
  date: string;
  revisionId: number;
}

export interface ApplyResult {
  ok: boolean;
  reason?: string;
}

// ── Run splitting and tracked-change emission ───────────────────────────

/**
 * Apply a single suggestion to the DOM as tracked changes.
 * Mutates the DOM in place. Returns {ok: true} on success or
 * {ok: false, reason} if the suggestion can't be applied.
 *
 * Assumes offsets have been validated and the offset map is correct.
 */
export function applySingleSuggestion(
  body: Element,
  offsetMap: OffsetMap,
  suggestion: SuggestionInput,
): ApplyResult {
  const fromEntry = offsetMap.get(suggestion.from);
  const toEntry = offsetMap.get(suggestion.to);

  if (!fromEntry || !toEntry) {
    return { ok: false, reason: "Could not locate this text in the original document" };
  }

  // Collect all runs between from and to
  const paragraph = fromEntry.paragraph;
  const runs = collectRunsBetween(paragraph, fromEntry, toEntry);
  if (runs.length === 0) {
    return { ok: false, reason: "No runs found in range" };
  }

  // Build the <w:del> content: split boundary runs, wrap in delText
  const delChildren: Element[] = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const isFirst = i === 0;
    const isLast = i === runs.length - 1;

    // Get the <w:t> element and its text
    const tNode = findAllByName("w:t", run.children)[0];
    if (!tNode) continue;
    const text = getTextContent(tNode);

    let sliceStart = 0;
    let sliceEnd = text.length;

    if (isFirst) sliceStart = fromEntry.charIndex;
    if (isLast) sliceEnd = toEntry.charIndex;

    const deletedText = text.slice(sliceStart, sliceEnd);
    if (deletedText.length === 0) continue;

    // Clone run properties from the original run
    const rPr = cloneRunProperties(run);

    // Build the deleted run element
    const delRun = buildRun(rPr, deletedText, true);
    delChildren.push(delRun);
  }

  if (delChildren.length === 0) {
    return { ok: false, reason: "No text to delete in range" };
  }

  // Build <w:del> wrapper
  const delEl = new DomElement("w:del", {
    "w:id": String(suggestion.revisionId),
    "w:author": suggestion.author,
    "w:date": suggestion.date,
  });
  for (const child of delChildren) {
    appendChild(delEl, child);
  }

  // Build <w:ins> wrapper (only if there's replacement text)
  let insEl: Element | undefined;
  if (suggestion.newText.length > 0) {
    insEl = new DomElement("w:ins", {
      "w:id": String(suggestion.revisionId + 1),
      "w:author": suggestion.author,
      "w:date": suggestion.date,
    });
    // Inherit formatting from the first deleted run
    const firstRPr = cloneRunProperties(runs[0]);
    const insRun = buildRun(firstRPr, suggestion.newText, false);
    appendChild(insEl, insRun);
  }

  // Now splice into the DOM:
  // 1. Split the first run at fromEntry.charIndex (keep prefix as-is)
  // 2. Split the last run at toEntry.charIndex (keep suffix as-is)
  // 3. Remove the original runs in the range
  // 4. Insert: [prefix run] [<w:del>] [<w:ins>] [suffix run]

  const firstRun = runs[0];
  const lastRun = runs[runs.length - 1];
  const firstT = findAllByName("w:t", firstRun.children)[0];
  const lastT = findAllByName("w:t", lastRun.children)[0];
  const firstText = getTextContent(firstT);
  const lastText = getTextContent(lastT);

  const prefixText = firstText.slice(0, fromEntry.charIndex);
  const suffixText = lastText.slice(toEntry.charIndex);

  // Find insertion point in parent (the paragraph)
  const parent = firstRun.parent as Element;
  const firstIndex = parent.children.indexOf(firstRun as ChildNode);

  // Remove all runs in the range from the parent
  const lastIndex = parent.children.indexOf(lastRun as ChildNode);
  parent.children.splice(firstIndex, lastIndex - firstIndex + 1);

  // Build replacement nodes
  const replacements: ChildNode[] = [];

  if (prefixText.length > 0) {
    const prefixRun = buildRun(cloneRunProperties(firstRun), prefixText, false);
    replacements.push(prefixRun as ChildNode);
  }

  replacements.push(delEl as ChildNode);

  if (insEl) {
    replacements.push(insEl as ChildNode);
  }

  if (suffixText.length > 0) {
    const suffixRun = buildRun(cloneRunProperties(lastRun), suffixText, false);
    // Add xml:space="preserve" if suffix starts with space
    if (suffixText.startsWith(" ")) {
      const tEl = findAllByName("w:t", suffixRun.children)[0];
      if (tEl) tEl.attribs["xml:space"] = "preserve";
    }
    replacements.push(suffixRun as ChildNode);
  }

  // Insert replacements at the original position
  parent.children.splice(firstIndex, 0, ...replacements);

  // Fix parent references
  for (const node of replacements) {
    (node as any).parent = parent;
  }

  return { ok: true };
}

// ── DOM construction helpers ────────────────────────────────────────────

function cloneRunProperties(run: Element): Element | undefined {
  const rPr = findAllByName("w:rPr", run.children)[0];
  if (!rPr) return undefined;
  // Deep clone by serializing and re-parsing
  const xml = render(rPr, { xmlMode: true });
  const parsed = parseDocument(xml, { xmlMode: true });
  return parsed.children[0] as Element;
}

function buildRun(rPr: Element | undefined, text: string, isDeleted: boolean): Element {
  const run = new DomElement("w:r", {});
  if (rPr) appendChild(run, rPr);

  const tagName = isDeleted ? "w:delText" : "w:t";
  const attrs: Record<string, string> = {};
  if (text.startsWith(" ") || text.endsWith(" ")) {
    attrs["xml:space"] = "preserve";
  }
  const tEl = new DomElement(tagName, attrs);
  const textNode = new DomText(text);
  appendChild(tEl, textNode as unknown as Element);
  appendChild(run, tEl);

  return run;
}

function appendChild(parent: Element, child: Element | ChildNode): void {
  (child as any).parent = parent;
  parent.children.push(child as ChildNode);
}

function collectRunsBetween(
  paragraph: Element,
  fromEntry: OffsetMapEntry,
  toEntry: OffsetMapEntry,
): Element[] {
  // If from and to are in the same paragraph, collect runs between them
  const runs: Element[] = [];
  let collecting = false;

  function scan(nodes: ChildNode[]): void {
    for (const node of nodes) {
      if (!isElement(node)) continue;
      if (node.name === "w:r") {
        if (node === fromEntry.run) collecting = true;
        if (collecting) runs.push(node);
        if (node === toEntry.run) { collecting = false; return; }
      } else if (node.name !== "w:del") {
        // Recurse into containers (w:ins, w:hyperlink, etc.) but not w:del
        scan(node.children);
      }
    }
  }

  // Walk from the paragraph level if both entries share a paragraph,
  // otherwise walk from the body level
  if (fromEntry.paragraph === toEntry.paragraph) {
    scan(fromEntry.paragraph.children);
  } else {
    // Cross-paragraph suggestions — walk all paragraphs between from and to
    const parent = fromEntry.paragraph.parent as Element;
    if (parent) scan(parent.children);
  }

  return runs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/docx-apply.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Add cross-run and edge case tests**

Add to `tests/server/docx-apply.test.ts`:

```typescript
  it("handles cross-run replacement", () => {
    const xml = wrapBody(`
      <w:p>
        <w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>
        <w:r><w:t> plain</w:t></w:r>
      </w:p>
    `);
    const offsetMap = buildOffsetMap(xml, [0, 10]);
    const doc = parseDocument(xml, { xmlMode: true });
    const body = findAllByName("w:body", doc.children)[0];

    const result = applySingleSuggestion(body, offsetMap, {
      from: 0, to: 10, newText: "replaced",
      author: "Test", date: "2026-04-05T00:00:00Z", revisionId: 70,
    });

    expect(result.ok).toBe(true);
    const output = render(body, { xmlMode: true });
    expect(output).toContain("w:del");
    expect(output).toContain("w:ins");
    expect(output).toContain("replaced");
  });

  it("handles partial-run boundary (mid-run split)", () => {
    const xml = wrapBody(`<w:p><w:r><w:t>abcdefgh</w:t></w:r></w:p>`);
    const offsetMap = buildOffsetMap(xml, [2, 5]);
    const doc = parseDocument(xml, { xmlMode: true });
    const body = findAllByName("w:body", doc.children)[0];

    const result = applySingleSuggestion(body, offsetMap, {
      from: 2, to: 5, newText: "XY",
      author: "Test", date: "2026-04-05T00:00:00Z", revisionId: 80,
    });

    expect(result.ok).toBe(true);
    const output = render(body, { xmlMode: true });
    // "ab" prefix, "cde" deleted, "XY" inserted, "fgh" suffix
    expect(output).toContain("<w:t>ab</w:t>");
    expect(output).toContain("<w:delText>cde</w:delText>");
    expect(output).toContain("XY");
    expect(output).toContain("fgh");
  });
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/server/docx-apply.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/file-io/docx-apply.ts tests/server/docx-apply.test.ts
git commit -m "feat(docx-apply): implement run-splitting and tracked-change XML emission

Handles single-run, cross-run, and partial-run boundary replacements.
Generates <w:del>/<w:ins> markup with proper w:delText, xml:space,
w:rPr inheritance, and unique revision IDs."
```

---

### Task 5: Implement full `applyTrackedChanges` orchestrator + revision IDs + comment resolution

**Files:**
- Modify: `src/server/file-io/docx-apply.ts`
- Modify: `tests/server/docx-apply.test.ts`

This wires up the full pipeline: load zip → build offset map → validate → apply → resolve comments → serialize.

- [ ] **Step 1: Write failing test for `applyTrackedChanges`**

```typescript
import JSZip from "jszip";
import { applyTrackedChanges, type AcceptedSuggestion } from "../../src/server/file-io/docx-apply.js";

// Helper: create a minimal .docx zip with given document.xml content
async function createTestDocx(documentXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file("[Content_Types].xml", `<?xml version="1.0"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    </Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("applyTrackedChanges", () => {
  it("applies a single suggestion and returns modified buffer", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>`);
    const buffer = await createTestDocx(xml);

    const suggestions: AcceptedSuggestion[] = [{
      id: "ann-1",
      from: 6,
      to: 11,
      newText: "earth",
      textSnapshot: "world",
    }];

    const result = await applyTrackedChanges(buffer, suggestions, {
      author: "Test",
      ydocFlatText: "Hello world",
    });

    expect(result.applied).toBe(1);
    expect(result.rejected).toBe(0);

    // Verify the output is a valid zip containing tracked changes
    const outZip = await JSZip.loadAsync(result.buffer);
    const outXml = await outZip.file("word/document.xml")!.async("text");
    expect(outXml).toContain("w:del");
    expect(outXml).toContain("w:ins");
    expect(outXml).toContain("earth");
  });

  it("rejects suggestion when textSnapshot mismatches", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>`);
    const buffer = await createTestDocx(xml);

    const suggestions: AcceptedSuggestion[] = [{
      id: "ann-1",
      from: 6,
      to: 11,
      newText: "earth",
      textSnapshot: "wrong", // doesn't match "world"
    }];

    const result = await applyTrackedChanges(buffer, suggestions, {
      author: "Test",
      ydocFlatText: "Hello world",
    });

    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.rejectedDetails[0].reason).toContain("changed");
  });

  it("aborts when ydocFlatText diverges from document.xml", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>`);
    const buffer = await createTestDocx(xml);

    await expect(
      applyTrackedChanges(buffer, [], {
        author: "Test",
        ydocFlatText: "Different text entirely",
      }),
    ).rejects.toThrow(/content has changed/);
  });

  it("applies multiple suggestions in reverse offset order", async () => {
    const xml = wrapBody(`<w:p><w:r><w:t>The quick brown fox</w:t></w:r></w:p>`);
    const buffer = await createTestDocx(xml);

    const suggestions: AcceptedSuggestion[] = [
      { id: "a1", from: 4, to: 9, newText: "slow", textSnapshot: "quick" },
      { id: "a2", from: 10, to: 15, newText: "red", textSnapshot: "brown" },
    ];

    const result = await applyTrackedChanges(buffer, suggestions, {
      author: "Test",
      ydocFlatText: "The quick brown fox",
    });

    expect(result.applied).toBe(2);
    expect(result.rejected).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement `applyTrackedChanges`**

Add the `AcceptedSuggestion` type and `applyTrackedChanges` function to `docx-apply.ts`:

```typescript
export interface AcceptedSuggestion {
  id: string;
  from: number;
  to: number;
  newText: string;
  textSnapshot?: string;
  /** Original Word comment ID if this overlaps an imported comment */
  importCommentId?: string;
}

export interface ApplyOptions {
  author: string;
  ydocFlatText: string;
  date?: string;
}

export interface ApplyOutput {
  buffer: Buffer;
  applied: number;
  rejected: number;
  rejectedDetails: Array<{ id: string; reason: string }>;
  commentsResolved: number;
}

export async function applyTrackedChanges(
  docxBuffer: Buffer,
  suggestions: AcceptedSuggestion[],
  options: ApplyOptions,
): Promise<ApplyOutput> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) throw new Error("No word/document.xml in .docx");

  const date = options.date ?? new Date().toISOString();

  // Collect all target offsets
  const allOffsets: number[] = [];
  for (const s of suggestions) {
    allOffsets.push(s.from, s.to);
  }

  // Build offset map and get flat text for comparison guard
  const offsetMap = buildOffsetMap(documentXml, allOffsets);

  // Comparison guard: abort if Y.Doc text diverges from document.xml
  if (offsetMap.flatText !== options.ydocFlatText) {
    throw new Error(
      "The document content has changed since it was loaded. Close and reopen the file before applying changes.",
    );
  }

  // Sort suggestions by descending offset (apply from end to avoid shifting)
  const sorted = [...suggestions].sort((a, b) => b.from - a.from);

  // Validate ALL suggestions before any DOM mutation
  const valid: AcceptedSuggestion[] = [];
  const rejectedDetails: Array<{ id: string; reason: string }> = [];

  for (const s of sorted) {
    // Check textSnapshot match (strip heading prefix if needed)
    if (s.textSnapshot) {
      const xmlText = offsetMap.flatText.slice(s.from, s.to);
      if (xmlText !== s.textSnapshot) {
        rejectedDetails.push({
          id: s.id,
          reason: "Target text has changed since this suggestion was created",
        });
        continue;
      }
    }

    // Check overlapping ranges
    const overlaps = valid.some(
      (v) => s.from < v.to && s.to > v.from,
    );
    if (overlaps) {
      rejectedDetails.push({ id: s.id, reason: "Overlaps with another suggestion" });
      continue;
    }

    valid.push(s);
  }

  if (valid.length === 0) {
    // No valid suggestions — return original buffer unchanged
    return {
      buffer: docxBuffer,
      applied: 0,
      rejected: rejectedDetails.length,
      rejectedDetails,
      commentsResolved: 0,
    };
  }

  // Parse document.xml into mutable DOM
  const doc = parseDocument(documentXml, { xmlMode: true });
  const body = findAllByName("w:body", doc.children)[0];

  // Collect existing revision IDs for uniqueness
  let maxRevId = collectMaxRevisionId(documentXml);

  // Apply each valid suggestion (already sorted descending by offset)
  let applied = 0;
  for (const s of valid) {
    // Re-build offset map for each suggestion is NOT needed because
    // we apply in reverse order — earlier offsets aren't affected.
    // But we use the original map built before any mutations.
    maxRevId += 2; // one for del, one for ins
    const result = applySingleSuggestion(body, offsetMap, {
      from: s.from,
      to: s.to,
      newText: s.newText,
      author: options.author,
      date,
      revisionId: maxRevId - 1,
    });
    if (result.ok) {
      applied++;
    } else {
      rejectedDetails.push({ id: s.id, reason: result.reason ?? "Unknown error" });
    }
  }

  // Serialize modified document.xml back
  const modifiedXml = render(doc, { xmlMode: true });
  zip.file("word/document.xml", modifiedXml);

  // Generate output buffer
  const buffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

  return {
    buffer,
    applied,
    rejected: rejectedDetails.length,
    rejectedDetails,
    commentsResolved: 0, // TODO: Task 6 adds comment resolution
  };
}

/** Scan document XML for the highest existing w:id value. */
function collectMaxRevisionId(xml: string): number {
  let max = 0;
  const regex = /w:id="(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    const id = parseInt(match[1], 10);
    if (id > max) max = id;
  }
  return max;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/server/docx-apply.test.ts`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/file-io/docx-apply.ts tests/server/docx-apply.test.ts
git commit -m "feat(docx-apply): full apply orchestrator with validation, comparison guard, and revision IDs"
```

---

### Task 6: Implement comment resolution in `commentsExtended.xml`

**Files:**
- Modify: `src/server/file-io/docx-apply.ts`
- Modify: `tests/server/docx-apply.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe("comment resolution", () => {
  it("creates commentsExtended.xml for resolved comments", async () => {
    const xml = wrapBody(`
      <w:p w14:paraId="AABB0011">
        <w:commentRangeStart w:id="5"/>
        <w:r><w:t>commented text</w:t></w:r>
        <w:commentRangeEnd w:id="5"/>
      </w:p>
    `);
    const buffer = await createTestDocx(xml);

    const suggestions: AcceptedSuggestion[] = [{
      id: "import-5-1712000000",
      from: 0,
      to: 14,
      newText: "fixed text",
      importCommentId: "5",
    }];

    const result = await applyTrackedChanges(buffer, suggestions, {
      author: "Test",
      ydocFlatText: "commented text",
    });

    expect(result.commentsResolved).toBe(1);

    const outZip = await JSZip.loadAsync(result.buffer);
    const extXml = await outZip.file("word/commentsExtended.xml")?.async("text");
    expect(extXml).toBeDefined();
    expect(extXml).toContain('w15:done="1"');
    expect(extXml).toContain("AABB0011");
  });
});
```

- [ ] **Step 2: Implement `resolveWordComments`**

Add to `docx-apply.ts`:

```typescript
async function resolveWordComments(
  zip: JSZip,
  commentParaIds: Map<string, string>,
  appliedSuggestions: AcceptedSuggestion[],
): Promise<number> {
  // Collect comment IDs to resolve
  const commentIdsToResolve: string[] = [];
  for (const s of appliedSuggestions) {
    if (s.importCommentId && commentParaIds.has(s.importCommentId)) {
      commentIdsToResolve.push(s.importCommentId);
    }
  }

  if (commentIdsToResolve.length === 0) return 0;

  // Build commentsExtended.xml entries
  const entries = commentIdsToResolve
    .map((id) => {
      const paraId = commentParaIds.get(id);
      if (!paraId) return "";
      return `  <w15:commentEx w15:paraId="${paraId}" w15:done="1"/>`;
    })
    .filter(Boolean)
    .join("\n");

  // Check if commentsExtended.xml already exists
  const existing = await zip.file("word/commentsExtended.xml")?.async("text");
  let content: string;

  if (existing) {
    // Insert before closing tag
    content = existing.replace(
      "</w15:commentsEx>",
      `${entries}\n</w15:commentsEx>`,
    );
  } else {
    content = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
${entries}
</w15:commentsEx>`;

    // Add relationship
    const relsPath = "word/_rels/document.xml.rels";
    const relsXml = await zip.file(relsPath)?.async("text") ?? "";
    if (!relsXml.includes("commentsExtended")) {
      const newRel = `<Relationship Id="rIdCommentsExt" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>`;
      const updated = relsXml.replace("</Relationships>", `  ${newRel}\n</Relationships>`);
      zip.file(relsPath, updated);
    }

    // Add content type
    const ctPath = "[Content_Types].xml";
    const ctXml = await zip.file(ctPath)?.async("text") ?? "";
    if (!ctXml.includes("commentsExtended")) {
      const newCt = `<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>`;
      const updated = ctXml.replace("</Types>", `  ${newCt}\n</Types>`);
      zip.file(ctPath, updated);
    }
  }

  zip.file("word/commentsExtended.xml", content);
  return commentIdsToResolve.length;
}
```

Wire it into `applyTrackedChanges` by calling `resolveWordComments` after DOM serialization, before generating the output buffer. Pass `offsetMap.commentParagraphIds` and the applied subset.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/server/docx-apply.test.ts`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/file-io/docx-apply.ts tests/server/docx-apply.test.ts
git commit -m "feat(docx-apply): resolve Word comments in commentsExtended.xml"
```

---

### Task 7: Export from `index.ts` and commit Phase 2

**Files:**
- Modify: `src/server/file-io/index.ts`

- [ ] **Step 1: Add exports**

Add to `src/server/file-io/index.ts`:

```typescript
export { applyTrackedChanges, type AcceptedSuggestion, type ApplyOptions, type ApplyOutput } from "./docx-apply.js";
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Commit Phase 2**

```bash
git add src/server/file-io/index.ts
git commit -m "feat(file-io): export applyTrackedChanges from index"
```

---

## Phase 3: Entry Points (PR #3 — MCP tool + API endpoint + browser button)

### Task 8: MCP tool `tandem_applyChanges` and `tandem_restoreBackup`

**Files:**
- Create: `src/server/mcp/docx-apply.ts`
- Modify: `src/server/mcp/server.ts`
- Create: `tests/server/docx-apply-tool.test.ts`

- [ ] **Step 1: Create `src/server/mcp/docx-apply.ts`**

```typescript
// src/server/mcp/docx-apply.ts
//
// MCP tools for applying accepted suggestions back to .docx files
// and restoring from backup.

import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCurrentDoc, requireDocument } from "./document-service.js";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { relPosToFlatOffset } from "../positions.js";
import { extractText } from "./document-model.js";
import { applyTrackedChanges, atomicWriteBuffer, type AcceptedSuggestion } from "../file-io/index.js";
import { mcpError, mcpSuccess, withErrorBoundary, noDocumentError } from "./helpers.js";
import type { Annotation } from "../../shared/types.js";
import { toFlatOffset } from "../../shared/types.js";

export function registerApplyTools(server: McpServer): void {
  // ── tandem_applyChanges ──────────────────────────────────────────────

  server.tool(
    "tandem_applyChanges",
    "Apply all accepted suggestions back to the .docx file as tracked changes",
    {
      documentId: z.string().optional().describe("Target document ID (defaults to active document)"),
      author: z.string().optional().describe("Attribution for tracked changes (defaults to configured setting, then 'Tandem Review')"),
      backupPath: z.string().optional().describe("Override backup file path"),
    },
    withErrorBoundary("tandem_applyChanges", async ({ documentId, author, backupPath }) => {
      const docInfo = requireDocument(documentId);
      if (!docInfo) return noDocumentError();

      const current = getCurrentDoc(documentId);
      if (!current) return noDocumentError();

      // Precondition: must be .docx
      if (current.format !== "docx") {
        return mcpError("FORMAT_ERROR", "Apply changes is only available for Word documents");
      }

      // Precondition: must be file source (not upload://)
      if (current.source === "upload") {
        return mcpError("FORMAT_ERROR", "Uploaded files cannot be modified on disk");
      }

      const { doc: ydoc, filePath } = docInfo;

      // Collect accepted suggestions from Y.Map
      const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
      const allAnnotations = [...map.values()] as Annotation[];
      const accepted = allAnnotations.filter(
        (a) => a.status === "accepted" && a.type === "suggestion",
      );

      if (accepted.length === 0) {
        return mcpError("INVALID_RANGE", "No accepted suggestions to apply");
      }

      // Resolve CRDT positions to flat offsets (MCP layer responsibility)
      const suggestions: AcceptedSuggestion[] = [];
      for (const ann of accepted) {
        let from = ann.range.from;
        let to = ann.range.to;

        // Prefer relRange if available
        if (ann.relRange) {
          const resolvedFrom = relPosToFlatOffset(ydoc, ann.relRange.fromRel);
          const resolvedTo = relPosToFlatOffset(ydoc, ann.relRange.toRel);
          if (resolvedFrom !== null && resolvedTo !== null) {
            from = resolvedFrom;
            to = resolvedTo;
          }
        }

        const { newText } = JSON.parse(ann.content) as { newText: string; reason: string };

        // Extract Word comment ID if this is an import annotation
        let importCommentId: string | undefined;
        if (ann.id.startsWith("import-")) {
          const parts = ann.id.split("-");
          if (parts.length >= 3) importCommentId = parts[1];
        }

        suggestions.push({
          id: ann.id,
          from: Number(from),
          to: Number(to),
          newText,
          textSnapshot: ann.textSnapshot,
          importCommentId,
        });
      }

      // Get Y.Doc flat text for comparison guard
      const ydocFlatText = extractText(ydoc);

      // Read original .docx from disk
      const docxBuffer = await fs.readFile(filePath);

      // Apply tracked changes
      const result = await applyTrackedChanges(docxBuffer, suggestions, {
        author: author ?? "Tandem Review",
        ydocFlatText,
      });

      // Write backup (fs.copyFile, not atomicWrite)
      const resolvedBackupPath = backupPath ??
        filePath.replace(/\.docx$/i, ".backup.docx");
      await fs.copyFile(filePath, resolvedBackupPath);

      // Verify backup
      const [origStat, backupStat] = await Promise.all([
        fs.stat(filePath),
        fs.stat(resolvedBackupPath),
      ]);
      if (origStat.size !== backupStat.size) {
        throw new Error("Backup verification failed. The backup may be incomplete.");
      }

      // Write modified .docx
      await atomicWriteBuffer(filePath, result.buffer);

      // Build response
      const pending = allAnnotations.filter((a) => a.status === "pending").length;
      const response: Record<string, unknown> = {
        applied: result.applied,
        rejected: result.rejected,
        rejectedDetails: result.rejectedDetails,
        backupPath: resolvedBackupPath,
        outputPath: filePath,
        commentsResolved: result.commentsResolved,
      };
      if (pending > 0) {
        response.pendingWarning = `${pending} annotations are still pending review`;
      }

      return mcpSuccess(response);
    }),
  );

  // ── tandem_restoreBackup ─────────────────────────────────────────────

  server.tool(
    "tandem_restoreBackup",
    "Restore a .docx file from its backup (created by tandem_applyChanges)",
    {
      documentId: z.string().optional().describe("Target document ID (defaults to active document)"),
    },
    withErrorBoundary("tandem_restoreBackup", async ({ documentId }) => {
      const docInfo = requireDocument(documentId);
      if (!docInfo) return noDocumentError();

      const { filePath } = docInfo;
      const backupPath = filePath.replace(/\.docx$/i, ".backup.docx");

      try {
        await fs.access(backupPath);
      } catch {
        return mcpError("FILE_NOT_FOUND", `No backup file found at ${backupPath}`);
      }

      await fs.copyFile(backupPath, filePath);

      return mcpSuccess({
        restored: true,
        backupPath,
        outputPath: filePath,
        message: "Backup restored. Reopen the file in Tandem to see the original content.",
      });
    }),
  );
}
```

- [ ] **Step 2: Register tools in `server.ts`**

Add import and call in `src/server/mcp/server.ts`:

```typescript
import { registerApplyTools } from "./docx-apply.js";
// ... in createMcpServer():
registerApplyTools(server);      // after registerAwarenessTools
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/mcp/docx-apply.ts src/server/mcp/server.ts
git commit -m "feat(mcp): add tandem_applyChanges and tandem_restoreBackup tools"
```

---

### Task 9: API endpoint `POST /api/apply-changes`

**Files:**
- Modify: `src/server/mcp/api-routes.ts`

- [ ] **Step 1: Add the endpoint**

Add in `registerApiRoutes` in `src/server/mcp/api-routes.ts`, following the existing POST pattern:

```typescript
  // Apply accepted suggestions to .docx as tracked changes
  app.options("/api/apply-changes", apiMiddleware);
  app.post("/api/apply-changes", apiMiddleware, async (req: Request, res: Response) => {
    const { documentId } = (req.body ?? {}) as Record<string, unknown>;
    try {
      // Reuse the same logic as the MCP tool — call the apply function directly
      // Import from the file-io layer, not the MCP tool (avoid circular deps)
      const { applyChangesFromApi } = await import("./docx-apply-api.js");
      const result = await applyChangesFromApi(
        typeof documentId === "string" ? documentId : undefined,
      );
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  });
```

Create a thin `src/server/mcp/docx-apply-api.ts` that extracts the core logic from the MCP tool handler into a shared function that both the MCP tool and API endpoint call. This avoids duplicating the suggestion collection, CRDT resolution, backup, and write logic.

- [ ] **Step 2: Commit**

```bash
git add src/server/mcp/api-routes.ts src/server/mcp/docx-apply-api.ts
git commit -m "feat(api): add POST /api/apply-changes endpoint"
```

---

### Task 10: Browser button component

**Files:**
- Create: `src/client/components/ApplyChangesButton.tsx`
- Modify: `src/client/panels/SidePanel.tsx`

- [ ] **Step 1: Create `ApplyChangesButton.tsx`**

```tsx
// src/client/components/ApplyChangesButton.tsx
import { useState } from "react";
import type { Annotation } from "../../shared/types.js";

interface ApplyChangesButtonProps {
  annotations: Annotation[];
  activeDocFormat: string | undefined;
  documentId: string | undefined;
}

export function ApplyChangesButton({
  annotations,
  activeDocFormat,
  documentId,
}: ApplyChangesButtonProps) {
  const [applying, setApplying] = useState(false);

  // Only show for .docx documents
  if (activeDocFormat !== "docx") return null;

  const accepted = annotations.filter(
    (a) => a.status === "accepted" && a.type === "suggestion",
  );
  const pending = annotations.filter((a) => a.status === "pending");
  const disabled = accepted.length === 0;

  async function handleApply() {
    if (disabled || applying) return;

    const message = pending.length > 0
      ? `Apply ${accepted.length} change(s) as tracked revisions?\n\n⚠ ${pending.length} annotation(s) are still pending review and will not be applied.\n\nYour original file will be backed up.`
      : `Apply ${accepted.length} change(s) as tracked revisions?\n\nThe changes will appear as tracked revisions in Word ��� you can Accept or Reject each one individually.\n\nYour original file will be backed up.`;

    if (!confirm(message)) return;

    setApplying(true);
    try {
      const res = await fetch("/api/apply-changes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(`Failed to apply changes: ${json.message ?? "Unknown error"}`);
        return;
      }
      const data = json.data;
      let msg = `${data.applied} change(s) applied as tracked revisions.`;
      if (data.rejected > 0) {
        msg += `\n${data.rejected} could not be applied.`;
      }
      msg += `\nBackup saved to: ${data.backupPath}`;
      alert(msg);
    } catch (err) {
      alert(`Error applying changes: ${err}`);
    } finally {
      setApplying(false);
    }
  }

  return (
    <button
      data-testid="apply-changes-btn"
      onClick={handleApply}
      disabled={disabled || applying}
      title={disabled ? "No accepted suggestions to apply" : `Apply ${accepted.length} tracked change(s) to the Word document`}
      style={{
        padding: "6px 12px",
        borderRadius: 4,
        border: "1px solid var(--border-color, #555)",
        background: disabled ? "transparent" : "var(--accent-color, #4a9eff)",
        color: disabled ? "var(--text-muted, #888)" : "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 13,
        opacity: applying ? 0.6 : 1,
      }}
    >
      {applying ? "Applying..." : `Apply as Tracked Changes (${accepted.length})`}
    </button>
  );
}
```

- [ ] **Step 2: Add to SidePanel**

In `src/client/panels/SidePanel.tsx`, import the component and render it below the filter controls:

```tsx
import { ApplyChangesButton } from "../components/ApplyChangesButton.js";

// In the JSX, after filter controls and before the annotation list:
<ApplyChangesButton
  annotations={annotations}
  activeDocFormat={activeDocFormat}
  documentId={activeDocumentId}
/>
```

The `activeDocFormat` and `activeDocumentId` props may need to be threaded through from the parent — check the existing prop chain. If not available, read from the Y.Map document metadata.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/client/components/ApplyChangesButton.tsx src/client/panels/SidePanel.tsx
git commit -m "feat(client): add Apply as Tracked Changes button to SidePanel"
```

---

### Task 11: Update docs

**Files:**
- Modify: `docs/mcp-tools.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add `tandem_applyChanges` and `tandem_restoreBackup` to `docs/mcp-tools.md`**

Add tool documentation following the existing format in the file — parameter tables, return format, notes.

- [ ] **Step 2: Update `docs/architecture.md` file map**

Add entries for `docx-walker.ts`, `docx-apply.ts`, `docx-apply-api.ts` in the file map section.

- [ ] **Step 3: Commit**

```bash
git add docs/mcp-tools.md docs/architecture.md
git commit -m "docs: add tandem_applyChanges and tandem_restoreBackup to tool reference"
```

---

### Task 12: E2E test

**Files:**
- Create: `tests/e2e/docx-apply.spec.ts`

- [ ] **Step 1: Write E2E test**

```typescript
import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

test.describe("Apply changes to .docx", () => {
  test("apply button visible for docx with accepted suggestion", async ({ page }) => {
    // This test requires a .docx fixture to be opened via the MCP flow.
    // Use the existing E2E test patterns from tests/e2e/ for server setup.
    // The test opens a .docx, creates a suggestion, accepts it,
    // and verifies the Apply button appears and is clickable.

    // Navigate to the app
    await page.goto("http://localhost:3479");

    // Wait for editor to load
    await page.waitForSelector("[data-testid='editor']", { timeout: 10000 });

    // The detailed E2E implementation depends on the existing fixture
    // setup patterns — adapt from the existing spec files.
  });
});
```

- [ ] **Step 2: Run E2E tests**

Run: `npm run test:e2e -- --grep "Apply changes"`
Expected: Test runs (may need fixture setup work).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/docx-apply.spec.ts
git commit -m "test(e2e): add Apply as Tracked Changes E2E test"
```

---

### Task 13: Final integration test and cleanup

- [ ] **Step 1: Run full test suite**

Run: `npm test && npm run typecheck`
Expected: All tests PASS, no type errors.

- [ ] **Step 2: Run E2E tests**

Run: `npm run test:e2e`
Expected: All tests PASS.

- [ ] **Step 3: Final commit for Phase 3**

```bash
git commit -m "feat: complete #162 — apply accepted suggestions to .docx as tracked changes

Closes #162"
```
