// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { AwarenessExtension } from "../../src/client/editor/extensions/awareness";
import { flatOffsetToPmPos, pmPosToFlatOffset } from "../../src/client/positions";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { extractText } from "../../src/server/mcp/document-model";
import {
  TYPING_DEBOUNCE,
  Y_MAP_ACTIVITY,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants";
import { toFlatOffset, toPmPos } from "../../src/shared/positions/types";

/**
 * `activity.cursor` is published to MCP clients, which hold no ProseMirror
 * document — so it has to leave the client in the flat coordinate system
 * (#1776). Until this fix it was `state.selection.from` written raw, while
 * `Y_MAP_SELECTION`, written 40 lines earlier in the same `update()`, went
 * through `pmSelectionToFlat`: two numbers in one payload in two systems,
 * neither labelled on the wire.
 *
 * FIXTURE IS LOAD-BEARING, TWICE OVER.
 *
 *  - It must carry a heading AND a list. In a single-paragraph document PM
 *    positions and flat offsets coincide and every assertion below passes with
 *    the bug in place — test (1) exists to red if that ever becomes true again.
 *  - It must be built with `loadMarkdown` FIRST and bound afterwards, not
 *    `new Editor({ content })` into an empty doc. Test (3) compares the
 *    client's `pmPosToFlatOffset` against the server's `extractText`, and that
 *    is only sound if the heading `level` reaches the Y.XmlElement as a JS
 *    *number*: `isHeadingLevel` requires `typeof level === "number"`, and a
 *    non-numeric attribute makes `extractText` charge 0 for the `# ` prefix
 *    while the client charges 2. A two-character mismatch on (3) is the
 *    heading attribute, not the conversion.
 */
const MARKDOWN = "# Title\n\nSome text here\n\n- one\n- two three\n";

const live: Editor[] = [];

function boundEditor(markdown: string) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  const editor = new Editor({
    extensions: [
      ...buildSchemaExtensions(),
      Collaboration.configure({ document: ydoc }),
      AwarenessExtension.configure({ ydoc }),
    ],
  });
  live.push(editor);
  const activity = () =>
    ydoc.getMap(Y_MAP_USER_AWARENESS).get(Y_MAP_ACTIVITY) as
      | { isTyping: boolean; cursor: number; lastEdit: number }
      | undefined;
  return { ydoc, editor, activity };
}

/** The flat offset the caret is at, derived the way a correct client would. */
function caretFlat(editor: Editor): number {
  return pmPosToFlatOffset(editor.state.doc, toPmPos(editor.state.selection.from));
}

afterEach(() => {
  vi.useRealTimers();
  for (const editor of live.splice(0)) editor.destroy();
});

/** The first Y.XmlText under `node` whose content contains `needle`. */
function findText(node: Y.XmlFragment | Y.XmlElement, needle: string): Y.XmlText | null {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      if (child.toString().includes(needle)) return child;
    } else if (child instanceof Y.XmlElement) {
      const hit = findText(child, needle);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Apply `mutate` on a peer doc and deliver the delta, as a server edit arrives.
 * Module-scope since #1918 — both the activity and the selection blocks need it.
 */
function remoteChange(ydoc: Y.Doc, mutate: (fragment: Y.XmlFragment) => void): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
  mutate(peer.getXmlFragment("default"));
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(ydoc)));
  peer.destroy();
}

/**
 * One `Z` inserted immediately before `three`. Typed anywhere else, (1) and
 * (3) are unsatisfiable. Module-scope since #1918, which reuses it.
 */
function typeZBeforeThree() {
  const { ydoc, editor, activity } = boundEditor(MARKDOWN);
  const target = toFlatOffset(extractText(ydoc).indexOf("three"));
  editor.commands.setTextSelection(flatOffsetToPmPos(editor.state.doc, target));
  vi.useFakeTimers();
  editor.commands.insertContent("Z");
  return { ydoc, editor, activity };
}

describe("activity.cursor is a flat text offset (#1776)", () => {
  it("(1) the fixture still discriminates: PM position !== flat offset", () => {
    const { editor } = typeZBeforeThree();
    // `editor.state.selection.from` is a ProseMirror position; `caretFlat` is
    // the flat offset for the same caret. Spelled out in full because this
    // file's whole subject is two identically-shaped numbers in two systems.
    expect(editor.state.selection.from).not.toBe(caretFlat(editor));
  });

  it("(2) the 200ms typing write publishes the flat offset", async () => {
    const { editor, activity } = typeZBeforeThree();
    await vi.advanceTimersByTimeAsync(250);

    const written = activity();
    expect(written?.isTyping).toBe(true);
    // Derived independently of `Y_MAP_SELECTION` so this survives a fixture
    // where the sibling key is absent.
    expect(written?.cursor).toBe(caretFlat(editor));
  });

  it("(3) flat means flat, not merely self-consistent", async () => {
    const { ydoc, activity } = typeZBeforeThree();
    await vi.advanceTimersByTimeAsync(250);

    const cursor = activity()?.cursor as number;
    const slice = extractText(ydoc).slice(cursor, cursor + 5);
    expect(slice).not.toBe("");
    expect(slice).toBe("three");
  });

  it("(4) the typing-clear write publishes the flat offset too", async () => {
    const { ydoc, editor, activity } = typeZBeforeThree();
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE + 50);

    const written = activity();
    expect(written?.isTyping).toBe(false);
    expect(written?.cursor).toBe(caretFlat(editor));
    const cursor = written?.cursor as number;
    expect(extractText(ydoc).slice(cursor, cursor + 5)).toBe("three");
  });
  /**
   * The freshness claim on all three prose surfaces (docs/mcp-tools.md, the
   * `tandem_getActivity` description, skills/tandem/SKILL.md) is "only a
   * document change TRIGGERS a write", not "the value only moves when the
   * document changes". The typing-clear timer reads `view.state` at fire time
   * rather than the `lastCursor` captured at the edit, so a caret moved inside
   * the `TYPING_DEBOUNCE` window rides out on a write the earlier edit armed.
   * (5a) pins that; (5b) pins the half that is still true.
   */
  it("(5a) the armed typing-clear write publishes the caret's live position", async () => {
    const { ydoc, editor, activity } = typeZBeforeThree();
    await vi.advanceTimersByTimeAsync(250);
    const typedAt = activity()?.cursor as number;

    // Move the caret with no edit at all, still inside the typing window.
    // INTO THE LIST, deliberately: this assertion is also the typing-clear
    // site's only units pin, and in the leading paragraph the PM position and
    // the flat offset both equal 8, so a regression to `selection.from` there
    // passes. The list item separates them (flat 23 / PM 26).
    const elsewhere = toFlatOffset(extractText(ydoc).indexOf("one"));
    editor.commands.setTextSelection(flatOffsetToPmPos(editor.state.doc, elsewhere));
    // Same guard test (1) provides for the typed caret, at the moved caret.
    expect(editor.state.selection.from).not.toBe(caretFlat(editor));
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE + 50);

    const written = activity();
    expect(written?.isTyping).toBe(false);
    expect(written?.cursor).not.toBe(typedAt);
    expect(written?.cursor).toBe(caretFlat(editor));
    expect(extractText(ydoc).slice(written?.cursor as number)).toMatch(/^one/);
  });

  it("(5b) a caret move with no preceding edit writes nothing", async () => {
    const { ydoc, editor, activity } = boundEditor(MARKDOWN);
    vi.useFakeTimers();

    const target = toFlatOffset(extractText(ydoc).indexOf("three"));
    editor.commands.setTextSelection(flatOffsetToPmPos(editor.state.doc, target));
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE + 250);

    expect(activity()).toBeUndefined();
  });
});

/**
 * #1918: `Y_MAP_ACTIVITY` describes what the USER is doing. A remote y-tiptap
 * transaction (`tandem_edit`, initial ySync, another tab's undo) replaces
 * `state.doc`, and the old `state.doc !== prevState.doc` gate published
 * `isTyping: true` with a fresh `lastEdit` for an edit the user did not make.
 */
describe("activity is not published for a remote change (#1918)", () => {
  /** A remote insert into the leading paragraph, above everything else. */
  function remoteInsert(ydoc: Y.Doc): void {
    remoteChange(ydoc, (fragment) => {
      const leading = findText(fragment, "Some text here");
      expect(leading, "fixture: the leading paragraph exists").not.toBeNull();
      leading?.insert(0, "AB");
    });
  }

  it("(6) a remote insert writes no activity record at all", async () => {
    const { ydoc, activity } = boundEditor(MARKDOWN);
    vi.useFakeTimers();

    remoteInsert(ydoc);
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE + 250);

    // Not merely `isTyping: false`: any write costs a fresh `lastEdit`, which
    // `tandem_getActivity` reports as `active: true`.
    expect(activity()).toBeUndefined();
  });

  it("(7) a local keystroke still publishes", async () => {
    const { editor, activity } = typeZBeforeThree();
    await vi.advanceTimersByTimeAsync(250);

    const written = activity();
    expect(written?.isTyping).toBe(true);
    expect(written?.cursor).toBe(caretFlat(editor));
  });

  /**
   * The remote change must not make the user look active — and must not leave
   * the published `cursor` behind either. A remote insert above the caret
   * shifts the flat coordinate system the last write was expressed in, so an
   * untouched `cursor` would point two characters short of the caret in the
   * text every MCP client now reads, and it is Claude's own `tandem_edit` that
   * created the skew. Both halves in one `toStrictEqual`: `cursor` moves by
   * exactly the insert's width, every other key is carried over verbatim.
   */
  it("(8) a remote change refreshes the cursor without extending the record", async () => {
    const { ydoc, editor, activity } = typeZBeforeThree();
    // Past TYPING_DEBOUNCE so BOTH local writes have landed and the record is
    // quiescent. Capturing at +250 instead reds even with a correct guard,
    // because the typing-clear timer overwrites it — that is the ordering,
    // never the guard.
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE + 250);
    const captured = { ...(activity() as object) };

    await vi.advanceTimersByTimeAsync(5000);
    remoteInsert(ydoc);
    await vi.advanceTimersByTimeAsync(250);

    expect(activity()).toStrictEqual({
      ...captured,
      cursor: (captured as { cursor: number }).cursor + 2,
    });
    // Independently of the arithmetic: the published offset is where the caret
    // actually is in the post-remote document.
    expect(activity()?.cursor).toBe(caretFlat(editor));
  });

  it("(8b) a remote change mints no record when there is none", async () => {
    // The refresh in (8) merges into an EXISTING record. With no local
    // activity to carry over, silence is still the only honest answer — (6)
    // with a longer window, so a refresh that mints cannot hide behind it.
    const { ydoc, activity } = boundEditor(MARKDOWN);
    vi.useFakeTimers();

    remoteInsert(ydoc);
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE + 2000);

    expect(activity()).toBeUndefined();
  });

  it("(10) a remote edit inside the armed window moves the pending cursor", async () => {
    // The `lastCursor` refresh sits deliberately OUTSIDE the `!isRemoteChange`
    // guard, and nothing else pins it: fold it into the guarded block and the
    // 200 ms write below converts a remapped caret against the PRE-remote doc.
    // The assertion lands at +250, before the remote-cursor refresh's own
    // 200 ms timer (armed at +100) could paper over it.
    const { ydoc, editor, activity } = typeZBeforeThree();
    await vi.advanceTimersByTimeAsync(100);
    remoteInsert(ydoc);
    await vi.advanceTimersByTimeAsync(150);

    const written = activity();
    expect(written?.isTyping).toBe(true);
    expect(written?.cursor).toBe(caretFlat(editor));
    expect(extractText(ydoc).slice(written?.cursor as number)).toMatch(/^three/);
  });

  it("(9) a local undo still counts as the user", async () => {
    const { editor, activity } = typeZBeforeThree();
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE + 50);
    const before = activity()?.lastEdit as number;
    expect(typeof before).toBe("number");

    // Routed through the Y UndoManager (StarterKit's own history is off), so
    // it arrives as a change-origin transaction with `isUndoRedoOperation`.
    // This row is the only one that kills a guard without that term.
    await vi.advanceTimersByTimeAsync(10);
    editor.commands.undo();
    await vi.advanceTimersByTimeAsync(250);

    const after = activity();
    expect(after?.isTyping).toBe(true);
    expect(after?.lastEdit).toBeGreaterThan(before);
  });
});

/**
 * What `tandem_checkInbox`'s `activity.selectedText` / `activity.selectionAt`
 * are documented to mean (#1624) — the schema `.describe`, both tool
 * descriptions, docs/mcp-tools.md and skills/tandem/SKILL.md all rest on these
 * five client facts, so each is pinned by its own row. Remote changes arrive
 * the way a server edit does: an update applied from a second `Y.Doc`.
 */
describe("Y_MAP_SELECTION lifetime (#1624)", () => {
  type SelectionRecord = { from: number; to: number; timestamp?: number; selectedText?: string };

  function selectionRecord(ydoc: Y.Doc): SelectionRecord | undefined {
    return ydoc.getMap(Y_MAP_USER_AWARENESS).get(Y_MAP_SELECTION) as SelectionRecord | undefined;
  }

  /** Select the first occurrence of `word`, by flat offset, as the user would. */
  function selectWord(editor: Editor, ydoc: Y.Doc, word: string): void {
    const from = toFlatOffset(extractText(ydoc).indexOf(word));
    const to = toFlatOffset(from + word.length);
    editor.commands.setTextSelection({
      from: flatOffsetToPmPos(editor.state.doc, from),
      to: flatOffsetToPmPos(editor.state.doc, to),
    });
  }

  /** (a)'s state: `three` selected and its debounced write landed. */
  async function selectThree() {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { ydoc, editor } = boundEditor(MARKDOWN);
    selectWord(editor, ydoc, "three");
    await vi.advanceTimersByTimeAsync(200);
    return { ydoc, editor };
  }

  it("(a) a non-empty selection is written after the 150ms debounce, with a timestamp", async () => {
    const { ydoc } = await selectThree();
    const rec = selectionRecord(ydoc);
    expect(rec?.selectedText).toBe("three");
    expect(extractText(ydoc).slice(rec?.from, rec?.to)).toBe("three");
    expect(typeof rec?.timestamp).toBe("number");
  });

  it("(b) a collapse is written immediately, clearing the selection", async () => {
    const { ydoc, editor } = await selectThree();
    editor.commands.setTextSelection(editor.state.selection.from);
    // No timer advance: the collapsed write is synchronous, not debounced.
    const rec = selectionRecord(ydoc);
    expect(rec?.from).toBe(rec?.to);
  });

  it("(c) a remote edit that shifts a lingering selection does NOT re-stamp it (#1991)", async () => {
    const { ydoc } = await selectThree();
    const before = selectionRecord(ydoc) as SelectionRecord;
    const t0 = before.timestamp as number;

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    remoteChange(ydoc, (fragment) => {
      const leading = findText(fragment, "Some text here");
      expect(leading, "fixture: the leading paragraph precedes the selection").not.toBeNull();
      leading?.insert(0, "AB");
    });
    await vi.advanceTimersByTimeAsync(300);

    const after = selectionRecord(ydoc) as SelectionRecord;
    // Both assertions discriminate: `from` kills a fix that suppresses the
    // write (the offsets would go stale and `selectedText` be sliced wrong),
    // `timestamp` kills the re-stamp.
    expect(after.from).toBe(before.from + 2);
    expect(after.timestamp).toBe(t0);
  });

  it("(c2) a user selection made after a remote shift stamps now (#1991)", async () => {
    const { ydoc, editor } = await selectThree();
    const t0 = (selectionRecord(ydoc) as SelectionRecord).timestamp as number;

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    remoteChange(ydoc, (fragment) => {
      findText(fragment, "Some text here")?.insert(0, "AB");
    });
    await vi.advanceTimersByTimeAsync(300);

    selectWord(editor, ydoc, "Some");
    const now = Date.now();
    await vi.advanceTimersByTimeAsync(200);

    const rec = selectionRecord(ydoc) as SelectionRecord;
    expect(rec.selectedText).toBe("Some");
    expect(rec.timestamp).toBe(now);
    expect(rec.timestamp as number).toBeGreaterThan(t0);
  });

  it("(c3) a fresh local selection inside the 150ms debounce keeps its own time (#1991)", async () => {
    const { ydoc, editor } = await selectThree();
    const t0 = (selectionRecord(ydoc) as SelectionRecord).timestamp as number;

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    // Select span B locally; its write is still pending 50 ms later when a
    // remote insert lands and re-arms the debounce. The published stamp must
    // be B's, not A's — this row is what forbids assigning the stamp inside
    // the debounce callback.
    selectWord(editor, ydoc, "Some");
    const t1 = Date.now();

    await vi.advanceTimersByTimeAsync(50);
    remoteChange(ydoc, (fragment) => {
      const heading = findText(fragment, "Title");
      expect(heading, "fixture: the heading precedes span B").not.toBeNull();
      heading?.insert(0, "AB");
    });
    await vi.advanceTimersByTimeAsync(300);

    const rec = selectionRecord(ydoc) as SelectionRecord;
    expect(rec.selectedText).toBe("Some");
    expect(rec.timestamp).toBe(t1);
    expect(rec.timestamp).not.toBe(t0);
  });

  it("(c4) a local undo that shifts a lingering selection does NOT re-stamp it (#1991)", async () => {
    // The undo path is the one #1918's `isUndoRedoOperation` carve-out leaks
    // into: this tab's undo IS the user editing, so it must keep counting as
    // activity, but it moves a lingering selection through
    // `restoreRelativeSelection` exactly as a remote edit does. Stamping it
    // would tell Claude the user selected this text just now.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { ydoc, editor } = boundEditor(MARKDOWN);

    // A local edit ABOVE the selection, so undoing it shifts the selection.
    const editAt = toFlatOffset(extractText(ydoc).indexOf("Some"));
    editor.commands.setTextSelection(flatOffsetToPmPos(editor.state.doc, editAt));
    editor.commands.insertContent("AB");
    await vi.advanceTimersByTimeAsync(TYPING_DEBOUNCE + 250);

    selectWord(editor, ydoc, "three");
    await vi.advanceTimersByTimeAsync(200);
    const before = selectionRecord(ydoc) as SelectionRecord;
    expect(before.selectedText).toBe("three");

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    editor.commands.undo();
    await vi.advanceTimersByTimeAsync(300);

    const after = selectionRecord(ydoc) as SelectionRecord;
    expect(after.timestamp).toBe(before.timestamp);
  });

  it("(d) a remote deletion of the selected text clears the selection", async () => {
    const { ydoc } = await selectThree();
    remoteChange(ydoc, (fragment) => {
      const item = findText(fragment, "two three");
      expect(item, "fixture: the list item holds the selection").not.toBeNull();
      item?.delete(item.toString().indexOf("three"), "three".length);
    });
    await vi.advanceTimersByTimeAsync(300);

    const rec = selectionRecord(ydoc);
    expect(rec?.from).toBe(rec?.to);
  });

  it("(e) blurring the editor writes nothing", async () => {
    const { ydoc, editor } = await selectThree();
    const before = selectionRecord(ydoc);
    editor.commands.blur();
    await vi.advanceTimersByTimeAsync(300);
    expect(selectionRecord(ydoc)).toStrictEqual(before);
  });
});
