/**
 * Structure probe for Issue #377 — understanding Y.Doc shapes for list items
 * and the separator boundary behavior with loadMarkdown (remark-based).
 */
import { describe, expect, it, afterEach } from "vitest";
import * as Y from "yjs";
import { loadMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText, getElementText, resolveOffset } from "../../src/server/mcp/document-model.js";
import { flatOffsetToRelPos, resolveToElement } from "../../src/server/positions.js";
import { toFlatOffset } from "../../src/shared/positions/index.js";

let doc: Y.Doc;

afterEach(() => {
  doc?.destroy();
});

describe("Y.Doc structure probe for list items", () => {
  it("shows what loadMarkdown produces for a bullet list", () => {
    doc = new Y.Doc();
    loadMarkdown(doc, "- Progressive Web App (PWA) — lower priority");
    const frag = doc.getXmlFragment("default");

    const flat = extractText(doc);
    console.log("[probe] bullet list flat text:", JSON.stringify(flat));
    console.log("[probe] fragment length:", frag.length);

    for (let i = 0; i < frag.length; i++) {
      const node = frag.get(i) as Y.XmlElement;
      console.log(`[probe] element ${i}: nodeName=${node.nodeName}`);
      const recurse = (el: Y.XmlElement, indent: string) => {
        for (let j = 0; j < el.length; j++) {
          const child = el.get(j);
          if (child instanceof Y.XmlElement) {
            console.log(`${indent}child ${j}: <${child.nodeName}>`);
            recurse(child, indent + "  ");
          } else if (child instanceof Y.XmlText) {
            console.log(`${indent}child ${j}: XmlText="${child.toString()}"`);
          }
        }
      };
      recurse(node, "  ");
    }
  });

  it("shows what loadMarkdown produces for two plain paragraphs", () => {
    doc = new Y.Doc();
    loadMarkdown(doc, "first\nsecond");
    const frag = doc.getXmlFragment("default");

    const flat = extractText(doc);
    console.log("[probe] two-para flat text:", JSON.stringify(flat));
    console.log("[probe] fragment length:", frag.length);

    for (let i = 0; i < frag.length; i++) {
      const node = frag.get(i) as Y.XmlElement;
      console.log(
        `[probe] element ${i}: nodeName=${node.nodeName}, text="${getElementText(node)}"`,
      );
    }

    // Check resolveToElement at separator boundary
    const atSep = resolveToElement(frag, toFlatOffset(5)); // offset 5 = \n in "first\nsecond"
    console.log("[probe] resolveToElement at offset 5 (\\n):", atSep);

    const afterSep = resolveToElement(frag, toFlatOffset(6)); // offset 6 = start of "second"
    console.log("[probe] resolveToElement at offset 6 (after \\n):", afterSep);
  });

  it("shows what loadMarkdown produces for a PWA-like bullet in context", () => {
    doc = new Y.Doc();
    const md =
      "## Future Extensions\n\n- **Progressive Web App (PWA)** — lower priority\n- Spreadsheet component";
    loadMarkdown(doc, md);
    const frag = doc.getXmlFragment("default");

    const flat = extractText(doc);
    console.log("[probe] PWA section flat text:", JSON.stringify(flat));
    console.log("[probe] fragment length:", frag.length);

    for (let i = 0; i < frag.length; i++) {
      const node = frag.get(i) as Y.XmlElement;
      console.log(`[probe] element ${i}: nodeName=${node.nodeName}`);
    }

    const pwaIdx = flat.indexOf("Progressive Web App");
    console.log("[probe] PWA index in flat:", pwaIdx);
    if (pwaIdx >= 0) {
      const relPos = flatOffsetToRelPos(doc, toFlatOffset(pwaIdx), 0);
      console.log(
        "[probe] flatOffsetToRelPos at PWA start:",
        relPos !== null ? "non-null" : "null",
      );

      // Also check resolveOffset at the PWA position
      const resolved = resolveOffset(frag, pwaIdx);
      console.log("[probe] resolveOffset at PWA:", resolved);
    }
  });

  it("resolveOffset handles nested list items (does NOT return null but finds wrong XmlText)", () => {
    // The critical question: when the Y.Doc element is a bulletList > listItem > paragraph,
    // getElementText() and findXmlText() need to recurse. If they don't,
    // flatOffsetToRelPos returns null for list item content.
    doc = new Y.Doc();
    loadMarkdown(doc, "- Item one\n- Item two");
    const frag = doc.getXmlFragment("default");

    const flat = extractText(doc);
    console.log("[probe] list flat:", JSON.stringify(flat));

    const itemTwoIdx = flat.indexOf("Item two");
    console.log("[probe] 'Item two' index:", itemTwoIdx);

    if (itemTwoIdx >= 0) {
      const relPos = flatOffsetToRelPos(doc, toFlatOffset(itemTwoIdx), 0);
      console.log(
        "[probe] flatOffsetToRelPos for 'Item two':",
        relPos !== null ? "non-null (anchored)" : "null (CANNOT anchor)",
      );
    }
  });
});
