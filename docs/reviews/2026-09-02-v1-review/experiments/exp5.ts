import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../../src/server/file-io/markdown.ts";
const rt = (md: string) => { const d = new Y.Doc(); d.transact(() => loadMarkdown(d, md), "internal"); return saveMarkdown(d); };
for (const md of ["# a\n## b\n### c\n#### d\n##### e\n###### f\n", "See [[Other Note]] and [[Note|alias]] and ![[image.png]]\n", "Price is \\$5 and \\$10 total; math \\(x\\).\n", "Obsidian: ==hl== #tag %%comment%% > [!NOTE]\n> callout\n"]) {
  const out = rt(md);
  console.log(JSON.stringify(md), "->", JSON.stringify(out), out === md ? "SAME" : "DIFF");
}
