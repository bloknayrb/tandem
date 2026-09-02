import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { extractText } from "../../../../src/server/mcp/document-model.ts";
import { validateRange } from "../../../../src/server/positions.ts";
import { toFlatOffset } from "../../../../src/shared/types.ts";
const load = (md: string) => { const d = new Y.Doc(); d.transact(() => loadMarkdown(d, md), "internal"); return d; };
for (const [l, md] of [["para hardBreak", "a\\\nb\n"], ["heading hardBreak", "a\\\nb\n===\n"], ["h2 hardBreak", "a\\\nb\n---\n"]] as [string,string][]) {
  const d = load(md); const out = saveMarkdown(d); const d2 = load(out);
  console.log(l, "| flat", JSON.stringify(extractText(d)), "| save", JSON.stringify(out), "| resave", JSON.stringify(saveMarkdown(d2)), "| hardBreak survives:", out.includes("\\\n") || out.includes("  \n"));
}
// control: does rejectHeadingOverlap fire at all?
{
  const d = load("# abc\n\ntail\n");
  console.log("control flat", JSON.stringify(extractText(d)));
  console.log("  range over prefix (0,3):", JSON.stringify(validateRange(d, toFlatOffset(0), toFlatOffset(3), { rejectHeadingOverlap: true })));
  console.log("  range over text  (2,5):", JSON.stringify(validateRange(d, toFlatOffset(2), toFlatOffset(5), { rejectHeadingOverlap: true })));
}
