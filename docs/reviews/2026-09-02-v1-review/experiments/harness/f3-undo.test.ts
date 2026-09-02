// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { describe, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../../../../src/client/editor/editor-extensions";
import { loadMarkdown } from "../../../../../src/server/file-io/markdown";
import { extractText } from "../../../../../src/server/mcp/document-model";
import { anchoredRange, refreshRange } from "../../../../../src/server/positions";
import { toFlatOffset } from "../../../../../src/shared/positions/types";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function refresh(tag: string, ydoc: Y.Doc, ann: any) {
  const flat = extractText(ydoc);
  const res: any = refreshRange(ann, ydoc, ydoc.getMap("annotations"));
  const rg = res.annotation.range;
  console.log(`    ${tag}: kind=${res.kind} range=${JSON.stringify(rg)} covers=${JSON.stringify(flat.slice(rg.from, rg.to))} collapsed=${rg.from === rg.to}`);
  return res.annotation;
}
describe("F3: undo after the collapsed record was RE-ANCHORED (reload / lazy attach)", () => {
  it("split at ann start, re-anchor from collapsed offsets, then undo", async () => {
    const ydoc = new Y.Doc();
    loadMarkdown(ydoc, "aaa bbb ccc\n");
    const editor = new Editor({ extensions: [...buildSchemaExtensions(), Collaboration.configure({ document: ydoc })] });
    const ar: any = anchoredRange(ydoc, toFlatOffset(4), toFlatOffset(7), "bbb");
    let ann: any = { id: "a1", type: "comment", author: "claude", status: "pending", range: ar.range, relRange: ar.relRange, textSnapshot: "bbb" };
    refresh("before split", ydoc, { ...ann });
    editor.commands.setTextSelection(5);
    editor.commands.splitBlock();
    await sleep(30);
    ann = refresh("after split ", ydoc, ann);
    // Simulate a durable reload / lazy re-attachment: the relRange is dropped, so the
    // next refresh re-anchors from the COLLAPSED flat offsets.
    const stripped: any = { ...ann }; delete stripped.relRange;
    const reattached = refresh("re-anchored ", ydoc, stripped);
    (editor.commands as any).undo();
    await sleep(30);
    console.log("    html after undo:", editor.getHTML());
    refresh("undo(reanch)", ydoc, reattached);
    editor.destroy();
  });
});
