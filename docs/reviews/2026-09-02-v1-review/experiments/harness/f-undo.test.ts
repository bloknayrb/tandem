// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { describe, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../../../../src/client/editor/editor-extensions";
import { flatOffsetToPmPos } from "../../../../../src/client/positions";
import { loadMarkdown } from "../../../../../src/server/file-io/markdown";
import { extractText } from "../../../../../src/server/mcp/document-model";
import { anchoredRange, refreshRange } from "../../../../../src/server/positions";
import { toFlatOffset } from "../../../../../src/shared/positions/types";

function makeEditor(md: string) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, md);
  const editor = new Editor({
    extensions: [...buildSchemaExtensions(), Collaboration.configure({ document: ydoc })],
  });
  return { ydoc, editor };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function report(tag: string, ydoc: Y.Doc, ann: any) {
  const flat = extractText(ydoc);
  const res: any = refreshRange(ann, ydoc, ydoc.getMap("annotations"));
  const rg = res.annotation.range;
  console.log(
    `  ${tag}: flat=${JSON.stringify(flat)} kind=${res.kind} range=${JSON.stringify(rg)} ` +
      `covers=${JSON.stringify(flat.slice(rg.from, rg.to))} collapsed=${rg.from === rg.to}`,
  );
  return res.annotation;
}

describe("F: undo after a block split inside an annotated range", () => {
  it("Enter inside the range, then undo", async () => {
    const { ydoc, editor } = makeEditor("Alpha beta gamma delta\n");
    const flat0 = extractText(ydoc);
    const from = flat0.indexOf("beta");
    const to = flat0.indexOf("delta") + 5;
    const snap = flat0.slice(from, to);
    const ar: any = anchoredRange(ydoc, toFlatOffset(from), toFlatOffset(to), snap);
    const ann: any = {
      id: "a1", type: "comment", author: "claude", status: "pending",
      range: ar.range, relRange: ar.relRange, textSnapshot: snap,
    };
    console.log("  annotation:", JSON.stringify(snap), `[${from},${to})`, "anchored:", ar.ok, ar.fullyAnchored);
    report("before split", ydoc, ann);

    // Press Enter in the middle of the annotated range (between "gamma" and " delta")
    const splitAt = flat0.indexOf("gamma") + 5;
    const pm = flatOffsetToPmPos(editor.state.doc, toFlatOffset(splitAt));
    editor.commands.setTextSelection(pm);
    editor.commands.splitBlock();
    await sleep(50);
    console.log("  html after split:", editor.getHTML());
    const afterSplit = report("after split ", ydoc, { ...ann });

    // Undo — Yjs owns history (StarterKit history:false; Collaboration installs yUndoPlugin)
    const canUndo = typeof (editor.commands as any).undo === "function";
    console.log("  editor.commands.undo available:", canUndo);
    (editor.commands as any).undo?.();
    await sleep(50);
    console.log("  html after undo:", editor.getHTML());
    // refresh from the ORIGINAL record (relRange as stored pre-split)
    console.log("  -- refreshing the ORIGINAL stored record:");
    report("after undo  ", ydoc, ann);
    console.log("  -- refreshing the record as the split left it (what the server persisted):");
    report("after undo  ", ydoc, afterSplit);
    editor.destroy();
  });
});
