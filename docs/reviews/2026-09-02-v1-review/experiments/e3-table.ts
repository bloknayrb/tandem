import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { extractText } from "../../../../src/server/mcp/document-model.ts";

const load = (md: string) => { const d = new Y.Doc(); d.transact(() => loadMarkdown(d, md), "internal"); return d; };
const dump = (d: Y.Doc) => {
  const frag = d.getXmlFragment("default");
  const out: string[] = [];
  for (let i = 0; i < frag.length; i++) {
    const el = frag.get(i) as any;
    out.push(`${el.nodeName}${JSON.stringify(el.getAttribute?.("markdownRaw") ?? "")}`);
  }
  return out.join(" | ");
};

const cases: [string, string][] = [
  ["escaped pipe in cell", "| h1 | h2 |\n| --- | --- |\n| a \\| b | c |\n"],
  ["plain table", "| h1 | h2 |\n| --- | --- |\n| a | c |\n"],
  ["inline code with pipe", "| h1 | h2 |\n| --- | --- |\n| `a | b` | c |\n"],
];

for (const [label, md] of cases) {
  const d = load(md);
  const out = saveMarkdown(d);
  const d2 = load(out);
  const out2 = saveMarkdown(d2);
  console.log(`--- ${label}`);
  console.log("  in  :", JSON.stringify(md));
  console.log("  flat:", JSON.stringify(extractText(d)));
  console.log("  nodes:", dump(d));
  console.log("  out :", JSON.stringify(out));
  console.log("  out2:", JSON.stringify(out2));
  console.log("  roundtrip stable:", out === out2, "| identical to input:", out === md);
}
