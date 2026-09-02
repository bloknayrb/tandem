import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { extractText, replaceFlatRangeInElement, mergeInlineTail, getElementTextLength } from "../../../../src/server/mcp/document-model.ts";
// cross-block tandem_edit from inside a code block into a bold paragraph (mirrors document.ts steps 1-5)
const doc = new Y.Doc(); doc.transact(() => loadMarkdown(doc, "```\nlet x = 1;\n```\n\n**bold tail** here\n"), "internal");
const flat = extractText(doc); console.log(JSON.stringify(flat));
const frag = doc.getXmlFragment("default");
const start = frag.get(0) as Y.XmlElement; const tail = frag.get(1) as Y.XmlElement;
const from = 6 /* inside code */, toInTail = 4 /* after "bold" */;
doc.transact(() => {
  replaceFlatRangeInElement(start, from, getElementTextLength(start), "");
  replaceFlatRangeInElement(tail, 0, toInTail, "");
  replaceFlatRangeInElement(start, from, from, "X");
  mergeInlineTail(start, tail);
  frag.delete(1, 1);
}, "mcp");
console.log("flat after:", JSON.stringify(extractText(doc)));
console.log("saved:", JSON.stringify(saveMarkdown(doc)));
// link-mark inheritance: insert right after a link
const d2 = new Y.Doc(); d2.transact(() => loadMarkdown(d2, "See [the docs](https://x) now.\n"), "internal");
const p = d2.getXmlFragment("default").get(0) as Y.XmlElement;
d2.transact(() => replaceFlatRangeInElement(p, 12, 12, " (updated)"), "mcp");
console.log("link inherit:", JSON.stringify(saveMarkdown(d2)));
