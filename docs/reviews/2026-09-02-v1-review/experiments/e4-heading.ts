import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { extractText } from "../../../../src/server/mcp/document-model.ts";
import { validateRange, anchoredRange } from "../../../../src/server/positions.ts";
import { toFlatOffset } from "../../../../src/shared/types.ts";

const load = (md: string) => { const d = new Y.Doc(); d.transact(() => loadMarkdown(d, md), "internal"); return d; };
const dump = (d: Y.Doc) => {
  const frag = d.getXmlFragment("default");
  const out: string[] = [];
  for (let i = 0; i < frag.length; i++) {
    const el = frag.get(i) as any;
    const kids = (el.toArray?.() ?? []).map((k: any) => k.nodeName ?? `text:${JSON.stringify(k.toString())}`);
    out.push(`${i}:${el.nodeName}(lvl=${el.getAttribute?.("level")})[${kids.join(",")}]`);
  }
  return out.join("  ");
};

const cases: [string, string][] = [
  ["ATX + backslash break", "# a\\\nb\n"],
  ["setext h1 with backslash hard break", "a\\\nb\n===\n"],
  ["setext h2 with two-space hard break", "a  \nb\n---\n"],
  ["ATX heading with <br>", "# a<br>b\n"],
];

for (const [label, md] of cases) {
  const d = load(md);
  const flat = extractText(d);
  console.log(`--- ${label}`);
  console.log("  in   :", JSON.stringify(md));
  console.log("  flat :", JSON.stringify(flat), "len", flat.length);
  console.log("  nodes:", dump(d));
  console.log("  save :", JSON.stringify(saveMarkdown(d)));
  const bi = flat.lastIndexOf("b");
  if (bi >= 0) {
    const from = toFlatOffset(bi), to = toFlatOffset(bi + 1);
    console.log(`  target "b" at [${bi},${bi + 1})`);
    console.log("  validateRange plain      :", JSON.stringify(validateRange(d, from, to)));
    console.log("  validateRange rejectHead :", JSON.stringify(validateRange(d, from, to, { rejectHeadingOverlap: true })));
    console.log("  anchoredRange            :", JSON.stringify(anchoredRange(d, from, to)).slice(0, 220));
  }
}
