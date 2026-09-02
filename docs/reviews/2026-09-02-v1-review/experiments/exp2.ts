import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { extractText, replaceFlatRangeInElement, collectBlocks } from "../../../../src/server/mcp/document-model.ts";
import { flatOffsetToRelPos, resolveToTextblock, elementAtPath } from "../../../../src/shared/positions/ydoc.ts";
import { relPosToFlatOffset, anchoredRange, refreshRange, validateRange } from "../../../../src/server/positions.ts";
import { restoreYDoc } from "../../../../src/server/session/manager.ts";
import { toFlatOffset } from "../../../../src/shared/positions/types.ts";

function load(md: string) { const d = new Y.Doc(); d.transact(() => loadMarkdown(d, md), "internal"); return d; }

// 1. Marks inside a markdownRaw paragraph / codeBlock -> toString() leak
{
  const doc = load("---\ntitle: X\n---\n\n[^1]: A footnote def.\n\n```js\nlet x = 1;\n```\n");
  const frag = doc.getXmlFragment("default");
  // user bolds "title" in the frontmatter block (a regular editable paragraph)
  const fm = frag.get(0) as Y.XmlElement;
  const t = fm.get(0) as Y.XmlText;
  doc.transact(() => t.format(0, 5, { bold: {} }), "browser");
  const def = frag.get(1) as Y.XmlElement;
  const dt = def.get(0) as Y.XmlText;
  doc.transact(() => dt.format(6, 8, { italic: {} }), "browser");
  const code = frag.get(2) as Y.XmlElement;
  const ct = code.get(0) as Y.XmlText;
  doc.transact(() => ct.format(0, 3, { bold: {} }), "browser");
  console.log("=== marks in raw/code blocks ===");
  console.log(JSON.stringify(saveMarkdown(doc)));
}

// 2. Surrogate pair split via tandem_edit's replaceFlatRangeInElement
{
  const doc = load("Hello 👋 world\n");
  const flat = extractText(doc);
  console.log("=== surrogate ===");
  console.log("flat length", flat.length, JSON.stringify(flat));
  // Claude counts "Hello " = 6, emoji = 1 char (naively) -> wants to replace "world" at [8,13) but JS index is [9,14)
  const v = validateRange(doc, toFlatOffset(7), toFlatOffset(8));
  console.log("validateRange(7,8) inside pair:", JSON.stringify(v));
  const frag = doc.getXmlFragment("default");
  const pos = resolveToTextblock(frag, toFlatOffset(7))!;
  const el = elementAtPath(frag, pos.path)!;
  doc.transact(() => replaceFlatRangeInElement(el, 7, 7, "X"), "mcp"); // insert in the middle of the pair
  console.log("after insert at 7:", JSON.stringify(extractText(doc)));
  const doc2 = load("Hello 👋 world\n");
  const frag2 = doc2.getXmlFragment("default");
  const el2 = elementAtPath(frag2, [0])!;
  doc2.transact(() => replaceFlatRangeInElement(el2, 7, 9, ""), "mcp"); // delete from mid-pair to after space
  console.log("after delete [7,9):", JSON.stringify(extractText(doc2)), JSON.stringify(saveMarkdown(doc2)));
  // anchoredRange at mid-pair
  const doc3 = load("Hello 👋 world\n");
  const ar = anchoredRange(doc3, toFlatOffset(7), toFlatOffset(9));
  console.log("anchoredRange(7,9):", JSON.stringify(ar));
}

// 3. Offset round-trip property: flat -> rel -> flat for every offset in a structured doc
{
  const md = [
    "# Heading",
    "",
    "Para one  ",
    "with break and *em* and `code`.",
    "",
    "- item one",
    "- item two",
    "  - nested",
    "",
    "> quote",
    "",
    "![img](x.png)",
    "",
    "---",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```js",
    "code",
    "block",
    "```",
    "",
    "Last[^1] para.",
    "",
    "[^1]: note",
    "",
  ].join("\n");
  const doc = load(md);
  const flat = extractText(doc);
  console.log("=== offset roundtrip ===");
  console.log(JSON.stringify(flat));
  const bad: string[] = [];
  for (let i = 0; i <= flat.length; i++) {
    for (const assoc of [0, -1] as const) {
      const rel = flatOffsetToRelPos(doc, toFlatOffset(i), assoc);
      if (!rel) { bad.push(`i=${i} assoc=${assoc} -> null (char=${JSON.stringify(flat[i] ?? "EOF")})`); continue; }
      const back = relPosToFlatOffset(doc, rel);
      if (back !== i) bad.push(`i=${i} assoc=${assoc} -> ${back} (char=${JSON.stringify(flat[i] ?? "EOF")})`);
    }
  }
  console.log("mismatches:", bad.length);
  console.log(bad.join("\n"));
  // collectBlocks slices
  for (const b of collectBlocks(doc)) {
    const slice = flat.slice(b.from, b.to);
    console.log(`block ${b.node} path=${b.path} [${b.from},${b.to}) = ${JSON.stringify(slice)}`);
  }
}

// 4. Corrupt session ydocState
{
  const doc = new Y.Doc();
  try {
    restoreYDoc(doc, { filePath: "/x.md", format: "md", ydocState: "AAAAgarbage", sourceFileMtime: 0, lastAccessed: 0 } as any);
    console.log("=== corrupt session: no throw, fragment len", doc.getXmlFragment("default").length);
  } catch (e) { console.log("=== corrupt session throws:", String(e).slice(0, 100)); }
  try {
    restoreYDoc(doc, { filePath: "/x.md", format: "md", sourceFileMtime: 0, lastAccessed: 0 } as any);
    console.log("=== missing ydocState: no throw");
  } catch (e) { console.log("=== missing ydocState throws:", String(e).slice(0, 100)); }
}

// 5. refreshRange after hard-break paragraph + annotation spanning the break
{
  const doc = load("a **b  \nc** d\n");
  const flat = extractText(doc);
  console.log("=== hardbreak ann ===", JSON.stringify(flat));
  const ar = anchoredRange(doc, toFlatOffset(2), toFlatOffset(7), flat.slice(2,7));
  console.log(JSON.stringify(ar));
  if (ar.ok && ar.fullyAnchored) {
    const ann: any = { id: "x", range: ar.range, relRange: ar.relRange };
    console.log("refresh:", JSON.stringify(refreshRange(ann, doc).kind));
  }
}
