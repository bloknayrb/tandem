/**
 * Markdown fidelity audit (#981 / ADR-042).
 *
 * Loads a fixture exercising every CommonMark + GFM construct through a full
 * `open → save` round-trip and asserts:
 *  1. Idempotency — a second round-trip is a no-op fixed point.
 *  2. Content preservation — every construct's essential source survives (no
 *     silent drop), including the constructs Tandem keeps as raw passthrough
 *     (footnotes, reference-style links/defs, inline HTML).
 *  3. GFM task lists (#982) — checkbox state round-trips as a per-item `checked`
 *     attribute on the ordinary listItem; plain bullets and checkboxes coexist
 *     in one list (mixed lists stay faithful), and ordered task lists work.
 *  4. No stray newline leaks into a `markdownRaw` paragraph's flat text.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText } from "../../src/server/mcp/document-model.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/markdown-fidelity.md", import.meta.url));

let doc: Y.Doc;
afterEach(() => doc?.destroy());

function roundTrip(input: string): string {
  doc = new Y.Doc();
  loadMarkdown(doc, input);
  return saveMarkdown(doc);
}

describe("markdown fidelity fixture (#981)", () => {
  const input = readFileSync(FIXTURE, "utf-8");

  it("is a stable fixed point (round-trip is idempotent)", () => {
    const once = roundTrip(input);
    doc.destroy();
    const twice = roundTrip(once);
    expect(twice).toBe(once);
  });

  it("preserves every supported CommonMark + GFM construct", () => {
    const out = roundTrip(input);
    // Inline marks + links
    expect(out).toContain("**bold**");
    expect(out).toContain("*italic*");
    expect(out).toContain("~~strike~~");
    expect(out).toContain("`inline code`");
    expect(out).toContain("[inline link](https://example.com");
    // Autolinks (canonicalized to angle form — a documented normalization)
    expect(out).toContain("<https://example.com>");
    expect(out).toContain("<user@example.org>");
    // Hard break
    expect(out).toContain("ends this line\\");
    // Blockquote (nested)
    expect(out).toContain("> A blockquote.");
    expect(out).toContain("> > Nested deeper.");
    // Lists (nested + ordered custom start survives)
    expect(out).toContain("  - Nested bullet");
    expect(out).toContain("7. Ordered with a custom start");
    // Fenced code with language
    expect(out).toContain("```ts");
    // Thematic break
    expect(out).toMatch(/^---$/m);
    // GFM table with alignment
    expect(out).toContain("| :--- | :----: | ----: |");
    expect(out).toContain("**b2**");
    // Block image
    expect(out).toContain("![Standalone image](https://example.com/image.png");
    // Raw HTML block
    expect(out).toContain('<div class="raw-html-block">A raw HTML block.</div>');
  });

  it("preserves raw-passthrough constructs (footnotes, reference links, inline HTML)", () => {
    const out = roundTrip(input);
    // Footnote reference + definition, incl. two consecutive refs (not merged)
    expect(out).toContain("[^note]");
    expect(out).toContain("[^note]: The footnote definition body.");
    expect(out).toContain("[^a][^b]");
    expect(out).toContain("[^a]: First.");
    expect(out).toContain("[^b]: Second.");
    // Reference-style links: full, collapsed, shortcut + their definitions
    expect(out).toContain("[full link][ref]");
    expect(out).toContain("[collapsed][]");
    expect(out).toContain("[shortcut]");
    expect(out).toContain("[ref]: https://example.com/ref");
    expect(out).toContain("[collapsed]: https://example.com/collapsed");
    expect(out).toContain("[shortcut]: https://example.com/shortcut");
    // A definition sitting between two paragraphs keeps its position
    expect(out).toContain("A paragraph sitting between two reference definitions.");
    // Inline HTML wrapping real prose (per-node: prose between tags stays text)
    expect(out).toContain("Some <span>inline HTML</span> wrapping prose");
  });

  it("does not leak a trailing newline into a markdownRaw paragraph's flat text", () => {
    doc = new Y.Doc();
    loadMarkdown(doc, "ref[^1] tail.\n\n[^1]: a footnote body\n");
    const text = extractText(doc);
    // The footnote definition is a markdownRaw paragraph; its flat text must be
    // exactly the trimmed source with no stray trailing "\n".
    expect(text).toContain("[^1]: a footnote body");
    expect(text).not.toContain("a footnote body\n");
  });

  // #982: GFM task lists round-trip as a per-item `checked` attribute on the
  // ordinary listItem (the mdast-native model). Checkbox state survives, plain
  // bullets stay plain even when mixed with checkboxes in one list, and ordered
  // task lists work.
  it("preserves GFM task-list checkbox state (#982)", () => {
    const out = roundTrip(input);
    expect(out).toContain("- [ ] Unchecked task");
    expect(out).toContain("- [x] Checked task");
  });

  it("keeps plain bullets plain in a mixed list, and supports ordered task lists (#982)", () => {
    const out = roundTrip(input);
    // A plain bullet sharing a list with checkboxes is NOT rewritten to `- [ ]`.
    expect(out).toContain("- A plain bullet");
    expect(out).toContain("- [ ] An unchecked task");
    expect(out).toContain("- [x] A checked task");
    // Ordered task list.
    expect(out).toContain("1. [ ] First step");
    expect(out).toContain("2. [x] Second step");
  });
});
