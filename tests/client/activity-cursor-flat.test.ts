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

describe("activity.cursor is a flat text offset (#1776)", () => {
  /**
   * One `Z` inserted immediately before `three`. Typed anywhere else, (1) and
   * (3) are unsatisfiable.
   */
  function typeZBeforeThree() {
    const { ydoc, editor, activity } = boundEditor(MARKDOWN);
    const target = toFlatOffset(extractText(ydoc).indexOf("three"));
    editor.commands.setTextSelection(flatOffsetToPmPos(editor.state.doc, target));
    vi.useFakeTimers();
    editor.commands.insertContent("Z");
    return { ydoc, editor, activity };
  }

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

  /** Apply `mutate` on a peer doc and deliver the delta, as a server edit arrives. */
  function remoteChange(ydoc: Y.Doc, mutate: (fragment: Y.XmlFragment) => void): void {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    mutate(peer.getXmlFragment("default"));
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(ydoc)));
    peer.destroy();
  }

  /** (a)'s state: `three` selected and its debounced write landed. */
  async function selectThree() {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { ydoc, editor } = boundEditor(MARKDOWN);
    const from = toFlatOffset(extractText(ydoc).indexOf("three"));
    const to = toFlatOffset(from + "three".length);
    editor.commands.setTextSelection({
      from: flatOffsetToPmPos(editor.state.doc, from),
      to: flatOffsetToPmPos(editor.state.doc, to),
    });
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

  it("(c) a remote edit that shifts a lingering selection RE-STAMPS it", async () => {
    // Pins #1991's current behaviour; when #1991 lands, remove the re-stamp
    // caveat from the schema, both descriptions, docs/mcp-tools.md and SKILL.md
    // in the same change.
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
    expect(after.from).toBe(before.from + 2);
    expect(after.timestamp).toBeGreaterThan(t0);
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
