import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../../src/server/file-io/markdown.ts";
const cases = [
  "| a | b |\n| - | - |\n| x \\| y | z |\n",
  "# T\n\nfoo\\|bar\n",
];
for (const src of cases) {
  const doc = new Y.Doc();
  loadMarkdown(doc, src);
  const out = saveMarkdown(doc);
  console.log(JSON.stringify(src), "=>", JSON.stringify(out), src === out ? "SAME" : "DIFF");
}
