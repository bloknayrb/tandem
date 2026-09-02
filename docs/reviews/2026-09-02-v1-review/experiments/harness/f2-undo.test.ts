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
  console.log(`    ${tag}: kind=${res.kind} range=${JSON.stringify(rg)} covers=${JSON.stringify(flat.slice(rg.from, rg.to))} collapsed=${rg.from === rg.to} flat=${JSON.stringify(flat)}`);
  return res.annotation;
}

async function shape(label: string, splitPm: number, from: number, to: number) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, "aaa bbb ccc\n");
  const editor = new Editor({ extensions: [...buildSchemaExtensions(), Collaboration.configure({ document: ydoc })] });
  const ar: any = anchoredRange(ydoc, toFlatOffset(from), toFlatOffset(to), "bbb");
  const ann: any = { id: "a1", type: "comment", author: "claude", status: "pending", range: ar.range, relRange: ar.relRange, textSnapshot: "bbb" };
  console.log(`--- ${label}`);
  refresh("before split", ydoc, { ...ann });
  editor.commands.setTextSelection(splitPm + 1);
  editor.commands.splitBlock();
  await sleep(30);
  const persisted = refresh("after split ", ydoc, { ...ann });
  (editor.commands as any).undo();
  await sleep(30);
  console.log("    html after undo:", editor.getHTML());
  refresh("undo(orig)  ", ydoc, { ...ann });
  refresh("undo(stored)", ydoc, { ...persisted });
  editor.destroy();
}

describe("F2: undo after a collapsing block split", () => {
  it("split AT annotation start (collapse case)", async () => { await shape("split at ann start (after 'aaa ')", 4, 4, 7); });
  it("split BEFORE annotation (collapse case)", async () => { await shape("split before ann (after 'a')", 1, 4, 7); });
  it("split INSIDE annotation", async () => { await shape("split inside ann (after 'aaa b')", 5, 4, 7); });
});
