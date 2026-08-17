/**
 * `.txt` bytes must survive any number of open/save cycles (#1460).
 *
 * This pins the claim a DISPOSITION rests on, which is why it exists as a test
 * rather than as a paragraph in an issue. #1460 is real and open: `populateYDoc`
 * makes one paragraph per line while `extractText` joins blocks with `"\n"`, and
 * since paragraphs became `whitespace: "pre"` (#1448) a paragraph can hold a
 * literal newline — so the two stopped being inverses and one wrapped paragraph
 * reopens as two. It was triaged as *invisible*: the in-editor structure changes,
 * the file does not. Document-don't-fix is only the right call while the second
 * half of that sentence is true, and "we measured it once" is not a mechanism
 * that keeps it true.
 *
 * Five cycles rather than one, because a one-shot round-trip cannot see a
 * transform that converges after its first application — the failure mode where
 * the file is rewritten once and then stable forever, which is exactly what a
 * user would report as "Tandem changed my file".
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { extractText, populateYDoc } from "../../src/server/mcp/document-model.js";

const CYCLES = 5;

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
];

describe("#1460: .txt round-trips byte-identically", () => {
  for (const { label, text: original } of CASES) {
    it(`preserves ${label}`, () => {
      let text = original;
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        const ydoc = new Y.Doc();
        populateYDoc(ydoc, text, "txt");
        text = extractText(ydoc);
        expect(text, `diverged on cycle ${cycle}`).toBe(original);
      }
    });
  }

  it("changes STRUCTURE while leaving the bytes alone — the defect itself", () => {
    // The discriminating case, and the reason the cases above are evidence
    // rather than a tautology. Here a single paragraph holds a literal newline,
    // which is what a plain-text paste produces now that paragraphs are
    // `whitespace: "pre"`. Reopening splits it in two — the divergence #1460
    // reports — and the file is nonetheless unchanged.
    //
    // Without this, the suite above could pass with `populateYDoc` and
    // `extractText` both broken in mutually cancelling ways and nobody would
    // learn anything from it.
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
    populateYDoc(reopened, bytes, "txt");
    expect(extractText(reopened), "bytes survive").toBe(bytes);
    expect(reopened.getXmlFragment("default").length, "structure does not — this is #1460").toBe(2);
  });
});
