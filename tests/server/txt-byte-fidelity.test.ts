/**
 * `.txt` bytes must survive any number of open/save cycles (#1460).
 *
 * This pins the claim a DISPOSITION rests on, which is why it exists as a test
 * rather than as a paragraph in an issue. #1460 is real and open: the plaintext
 * loader makes one paragraph per line while the saver joins blocks with `"\n"`,
 * and since paragraphs became `whitespace: "pre"` (#1448) a paragraph can hold a
 * literal newline — so the two stopped being inverses and one wrapped paragraph
 * reopens as two. It was triaged as *invisible*: the in-editor structure
 * changes, the file does not. Document-don't-fix is only the right call while
 * the second half of that sentence is true, and "we measured it once" is not a
 * mechanism that keeps it true.
 *
 * Driven through `getAdapter("txt")` rather than through `populateYDoc` /
 * `extractText` directly, and that is the whole point of the file. The adapter
 * is what a save actually calls, and it wraps the pair in
 * `normalizeAndRecordLineEnding` / `restoreLineEndings`. An earlier cut of this
 * test called the inner pair, which meant the CRLF case round-tripped by
 * accident — `populateYDoc` splitting on `"\n"` leaves the `\r` as ordinary
 * text — and proved nothing about the line-ending machinery it appeared to
 * cover. Test the layer the product uses.
 *
 * Five cycles rather than one, because a one-shot round-trip cannot see a
 * transform that converges after its first application — the failure mode where
 * the file is rewritten once and then stable forever, which is exactly what a
 * user would report as "Tandem changed my file".
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getAdapter } from "../../src/server/file-io/index.js";
import { extractText } from "../../src/server/mcp/document-model.js";

const CYCLES = 5;
const adapter = getAdapter("txt");

/** One open/save cycle through the real adapter. */
async function cycle(input: string): Promise<string> {
  const doc = new Y.Doc();
  try {
    adapter.apply(doc, await adapter.parse(input));
    return adapter.save?.(doc) ?? "";
  } finally {
    doc.destroy();
  }
}

/** Each case names the whitespace property it is here to defend. */
const CASES: Array<{ label: string; text: string }> = [
  {
    label: "a blank-line run between paragraphs",
    text: "alpha bravo\ncharlie delta\n\necho foxtrot\n",
  },
  { label: "a single line", text: "one line only\n" },
  { label: "trailing blank lines", text: "trailing blank lines\n\n\n" },
  { label: "no final newline", text: "no final newline" },
  { label: "leading tabs and trailing spaces", text: "\tleading tab\n  leading spaces  \n" },
  { label: "CRLF line endings", text: "a\r\nb\r\n" },
  { label: "a lone CR (classic Mac)", text: "a\rb\r" },
  { label: "an empty file", text: "" },
];

describe("#1460: .txt round-trips byte-identically", () => {
  for (const { label, text: original } of CASES) {
    it(`preserves ${label}`, async () => {
      let text = original;
      for (let i = 0; i < CYCLES; i++) {
        text = await cycle(text);
        expect(text, `diverged on cycle ${i}`).toBe(original);
      }
    });
  }

  it("changes STRUCTURE while leaving the bytes alone — the defect itself", () => {
    // The discriminating case, and the reason the cases above are evidence
    // rather than a tautology. Here a single paragraph holds a literal newline,
    // the shape `whitespace: "pre"` (#1448) made representable. Reopening splits
    // it in two — the divergence #1460 reports — and the file is unchanged.
    //
    // Built by hand rather than via the adapter because the adapter CANNOT
    // produce it: that is the finding. The loader never emits a paragraph
    // carrying a newline, so the shape only arrives from an edit.
    //
    // Without this, the suite above could pass with the loader and saver both
    // broken in mutually cancelling ways and nobody would learn anything.
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment("default");
    const paragraph = new Y.XmlElement("paragraph");
    // Attach BEFORE populating: a detached Y.XmlText reverses segment order.
    fragment.push([paragraph]);
    const inner = new Y.XmlText();
    paragraph.push([inner]);
    inner.insert(0, "wrapped\nparagraph");

    const bytes = extractText(ydoc);
    expect(bytes).toBe("wrapped\nparagraph");
    expect(fragment.length, "one paragraph on the way out").toBe(1);

    const reopened = new Y.Doc();
    reopened.getXmlFragment("default");
    adapter.apply(reopened, { format: "other", content: bytes, issues: [] });
    expect(adapter.save?.(reopened), "bytes survive").toBe(bytes);
    expect(reopened.getXmlFragment("default").length, "structure does not — this is #1460").toBe(2);

    ydoc.destroy();
    reopened.destroy();
  });
});
