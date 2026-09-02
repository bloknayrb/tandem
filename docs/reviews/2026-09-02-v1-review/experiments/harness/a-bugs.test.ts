// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../../../../src/client/editor/editor-extensions";
import { AnnotationExtension } from "../../../../../src/client/editor/extensions/annotation";
import { AwarenessExtension } from "../../../../../src/client/editor/extensions/awareness";
import {
  FindReplaceExtension,
  getFindState,
  replaceActive,
  replaceAll,
} from "../../../../../src/client/editor/extensions/find-replace";
import {
  annotationToPmRange,
  flatOffsetToPmPos,
  pmDocFlatText,
  pmPosToFlatOffset,
} from "../../../../../src/client/positions";
import { loadMarkdown } from "../../../../../src/server/file-io/markdown";
import { extractText } from "../../../../../src/server/mcp/document-model";
import { anchoredRange, refreshRange } from "../../../../../src/server/positions";
import {
  Y_MAP_ACTIVITY,
  Y_MAP_ANNOTATIONS,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../../../../../src/shared/constants";
import { toFlatOffset, toPmPos } from "../../../../../src/shared/positions/types";

function makeEditor(md: string, extra: (ydoc: Y.Doc) => unknown[] = () => []) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, md);
  const editor = new Editor({
    extensions: [
      ...buildSchemaExtensions(),
      Collaboration.configure({ document: ydoc }),
      ...(extra(ydoc) as never[]),
    ],
  });
  return { ydoc, editor };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("A: activity.cursor is a PM position, not a flat offset", () => {
  it("shows the drift on a heading + list document", async () => {
    const { ydoc, editor } = makeEditor("# Title\n\nSome text here\n\n- one\n- two three\n", (y) => [
      AwarenessExtension.configure({ ydoc: y }),
    ]);
    const flat = extractText(ydoc);
    const target = toFlatOffset(flat.indexOf("three"));
    const pm = flatOffsetToPmPos(editor.state.doc, target);
    editor.commands.setTextSelection(pm);
    editor.commands.insertContent("Z");
    await sleep(300);
    const ua = ydoc.getMap(Y_MAP_USER_AWARENESS);
    const activity = ua.get(Y_MAP_ACTIVITY) as { cursor: number };
    const selection = ua.get(Y_MAP_SELECTION) as { from: number; to: number };
    const nowFlat = extractText(ydoc);
    console.log("flat text:", JSON.stringify(nowFlat));
    console.log("activity:", activity, "selection:", selection);
    console.log(
      "PM selection.from:",
      editor.state.selection.from,
      "flat of selection:",
      pmPosToFlatOffset(editor.state.doc, toPmPos(editor.state.selection.from)),
    );
    console.log(
      "text at activity.cursor read as flat offset:",
      JSON.stringify(nowFlat.slice(activity.cursor - 5, activity.cursor + 5)),
    );
    expect(activity.cursor).toBe(editor.state.selection.from); // PM position
    expect(selection.from).toBe(pmPosToFlatOffset(editor.state.doc, toPmPos(editor.state.selection.from)));
    expect(activity.cursor).not.toBe(selection.from);
    editor.destroy();
  });
});

describe("B: find-replace positions after a hardBreak", () => {
  it("matches the wrong characters and replaces the wrong text", () => {
    const editor = new Editor({
      extensions: [...buildSchemaExtensions(), FindReplaceExtension],
      content: "<p>alpha<br>bravo charlie</p>",
    });
    editor.commands.find({ query: "bravo", caseSensitive: false, wholeWord: false, regexMode: false });
    const st = getFindState(editor.state)!;
    const m = st.matches[0];
    const covered = editor.state.doc.textBetween(m.from, m.to, "|", (n) => `<${n.type.name}>`);
    console.log("match:", m, "covers:", JSON.stringify(covered));
    replaceActive(editor.view, "XXXXX");
    console.log("after replaceActive:", editor.getHTML());
    expect(covered).not.toBe("bravo");
    editor.destroy();
  });
  it("replaceAll with two breaks compounds the drift", async () => {
    const editor = new Editor({
      extensions: [...buildSchemaExtensions(), FindReplaceExtension],
      content: "<p>one<br>two<br>cat sat</p>",
    });
    editor.commands.find({ query: "cat", caseSensitive: false, wholeWord: false, regexMode: false });
    await replaceAll(editor.view, "dog");
    console.log("after replaceAll cat->dog:", editor.getHTML());
    editor.destroy();
  });
});

describe("C: structural edits vs annotation anchors", () => {
  function annotate(ydoc: Y.Doc, text: string, id: string) {
    const flat = extractText(ydoc);
    const from = toFlatOffset(flat.indexOf(text));
    const to = toFlatOffset(from + text.length);
    const res = anchoredRange(ydoc, from, to, text);
    if (!res.ok) throw new Error("anchor failed");
    const ann = {
      id,
      author: "claude",
      type: "comment",
      audience: "outbound",
      range: res.range,
      relRange: res.fullyAnchored ? res.relRange : undefined,
      content: "c",
      suggestedText: "REPL",
      status: "pending",
      timestamp: Date.now(),
      textSnapshot: text,
    };
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, ann);
    return ann;
  }
  function report(label: string, ydoc: Y.Doc, editor: Editor, id: string) {
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const ann = map.get(id) as never;
    const pmr = annotationToPmRange(ann, editor.state.doc, ydoc);
    const pmText = pmr ? editor.state.doc.textBetween(pmr.from, pmr.to, "\n", "\n") : null;
    const rr = refreshRange(ann, ydoc, map);
    const flat = extractText(ydoc);
    console.log(label, {
      clientResolve: pmr,
      clientText: pmText,
      serverKind: rr.kind,
      serverRange: rr.annotation.range,
      serverText: flat.slice(rr.annotation.range.from, rr.annotation.range.to),
      hasRelRangeAfter: !!rr.annotation.relRange,
    });
    return { pmText, rr, flat };
  }

  it("Enter in the middle of an annotated range", () => {
    const { ydoc, editor } = makeEditor("The quick brown fox jumps.\n", (y) => [AnnotationExtension.configure({ ydoc: y })]);
    annotate(ydoc, "quick brown", "a1");
    const flat = extractText(ydoc);
    const splitAt = flatOffsetToPmPos(editor.state.doc, toFlatOffset(flat.indexOf("brown")));
    editor.commands.setTextSelection(splitAt);
    editor.commands.splitBlock();
    console.log("doc after split:", JSON.stringify(pmDocFlatText(editor.state.doc)));
    const r = report("Enter mid-range", ydoc, editor, "a1");
    expect(r.pmText).not.toBe("quick brown");
    editor.destroy();
  });

  it("Backspace-join: annotation in the SECOND paragraph shifts by one", () => {
    const { ydoc, editor } = makeEditor("alpha\n\nbravo charlie delta\n", (y) => [AnnotationExtension.configure({ ydoc: y })]);
    annotate(ydoc, "charlie", "a2");
    const flat = extractText(ydoc);
    const joinAt = flatOffsetToPmPos(editor.state.doc, toFlatOffset(flat.indexOf("bravo")));
    editor.commands.setTextSelection(joinAt);
    const ok = editor.commands.joinBackward();
    console.log("joinBackward ok:", ok, "doc:", JSON.stringify(pmDocFlatText(editor.state.doc)));
    report("Backspace join", ydoc, editor, "a2");
    // A second refresh (what the next MCP read does) after the first stripped/re-anchored
    const r2 = report("Backspace join (second refresh)", ydoc, editor, "a2");
    expect(r2.rr.annotation.range).toBeDefined();
    editor.destroy();
  });

  it("Enter at START of an annotated paragraph (control, should survive)", () => {
    const { ydoc, editor } = makeEditor("alpha\n\nbravo charlie delta\n", (y) => [AnnotationExtension.configure({ ydoc: y })]);
    annotate(ydoc, "charlie", "a3");
    const flat = extractText(ydoc);
    const at = flatOffsetToPmPos(editor.state.doc, toFlatOffset(flat.indexOf("bravo")));
    editor.commands.setTextSelection(at);
    editor.commands.splitBlock();
    const r = report("Enter at start", ydoc, editor, "a3");
    expect(r.pmText).toBe("charlie");
    editor.destroy();
  });

  it("Heading toggle on an annotated paragraph", () => {
    const { ydoc, editor } = makeEditor("alpha\n\nbravo charlie delta\n", (y) => [AnnotationExtension.configure({ ydoc: y })]);
    annotate(ydoc, "charlie", "a4");
    const flat = extractText(ydoc);
    const at = flatOffsetToPmPos(editor.state.doc, toFlatOffset(flat.indexOf("charlie")));
    editor.commands.setTextSelection(at);
    editor.commands.toggleHeading({ level: 2 });
    report("Heading toggle", ydoc, editor, "a4");
    editor.destroy();
  });

  it("Wrap annotated paragraph in a bullet list", () => {
    const { ydoc, editor } = makeEditor("alpha\n\nbravo charlie delta\n", (y) => [AnnotationExtension.configure({ ydoc: y })]);
    annotate(ydoc, "charlie", "a5");
    const flat = extractText(ydoc);
    const at = flatOffsetToPmPos(editor.state.doc, toFlatOffset(flat.indexOf("charlie")));
    editor.commands.setTextSelection(at);
    editor.commands.toggleBulletList();
    report("List wrap", ydoc, editor, "a5");
    editor.destroy();
  });
});
