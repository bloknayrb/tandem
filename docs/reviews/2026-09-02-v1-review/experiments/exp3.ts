import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { restoreYDoc } from "../../../../src/server/session/manager.ts";
// truncated session update
const src = new Y.Doc(); src.transact(() => loadMarkdown(src, "# Title\n\nSome paragraph with **bold** and a [link](u).\n\n- a\n- b\n"), "internal");
const full = Buffer.from(Y.encodeStateAsUpdate(src));
for (const cut of [full.length - 1, Math.floor(full.length/2), 10]) {
  const doc = new Y.Doc();
  try {
    restoreYDoc(doc, { filePath: "/x.md", format: "md", ydocState: full.subarray(0, cut).toString("base64"), sourceFileMtime: 0, lastAccessed: 0 } as any);
    console.log(`cut=${cut}/${full.length}: no throw, fragment len`, doc.getXmlFragment("default").length, JSON.stringify(saveMarkdown(doc)).slice(0,80));
  } catch (e) { console.log(`cut=${cut}/${full.length}: THROWS`, String(e).slice(0, 90)); }
}
// bit flip
const flipped = Buffer.from(full); flipped[Math.floor(full.length/2)] ^= 0xff;
{ const doc = new Y.Doc(); try { restoreYDoc(doc, { filePath: "/x.md", format: "md", ydocState: flipped.toString("base64"), sourceFileMtime: 0, lastAccessed: 0 } as any); console.log("bitflip: no throw, len", doc.getXmlFragment("default").length, JSON.stringify(saveMarkdown(doc)).slice(0,120)); } catch (e) { console.log("bitflip THROWS", String(e).slice(0,90)); } }
