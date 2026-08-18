// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  AUTHORSHIP_ORIGIN_META,
  AuthorshipExtension,
} from "../../src/client/editor/extensions/authorship";
import { insertChatMarkdown } from "../../src/client/panels/chat-insert";
import { applySuggestion } from "../../src/client/panels/useAnnotationReview.svelte";
import { Y_MAP_AUTHORSHIP } from "../../src/shared/constants";
import type { Annotation, AuthorshipRange } from "../../src/shared/types";

/**
 * Flipped by the one test that needs the flat-offset conversion to fail.
 * Mocking `pmSelectionToFlat` is the only honest way in: breaking ProseMirror's
 * own `resolve` takes the transaction down before `onTransaction` ever runs, so
 * it proves nothing about the handler's catch.
 */
let failConversion = false;

vi.mock("../../src/client/positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/positions")>();
  return {
    ...actual,
    pmSelectionToFlat: (...args: Parameters<typeof actual.pmSelectionToFlat>) => {
      if (failConversion) throw new Error("synthetic conversion failure");
      return actual.pmSelectionToFlat(...args);
    },
  };
});

/**
 * The stamp path — `Authorship.onTransaction`, which decides WHO an insertion
 * is attributed to. It had no tests at all, which is how #1388 shipped:
 * `author: "user"` was hardcoded, so accepting a Claude suggestion or
 * inserting a Claude chat message rendered the words as the user's own.
 *
 * Distinct from `authorship-decoration.test.ts`, which mocks ProseMirror
 * wholesale and tests only how stored entries are PAINTED. Nothing there could
 * have caught a wrong author, because a wrong author paints perfectly.
 */
describe("authorship stamp path", () => {
  let ydoc: Y.Doc;
  let editor: Editor;

  const entries = (): AuthorshipRange[] =>
    [...ydoc.getMap(Y_MAP_AUTHORSHIP).values()] as AuthorshipRange[];

  beforeEach(() => {
    ydoc = new Y.Doc();
    editor = new Editor({
      extensions: [...buildSchemaExtensions(), AuthorshipExtension.configure({ ydoc })],
      content: "<p>hello world</p>",
    });
  });
  afterEach(() => {
    // Reset here, not at the end of the test that sets it: if that test throws
    // mid-way the flag leaks `true` into every case below and reds the suite
    // for a reason unrelated to any of them.
    failConversion = false;
    editor.destroy();
    ydoc.destroy();
  });

  it("attributes an untagged local edit to the user", () => {
    // Pins the DEFAULT, which is the half a fix for #1388 could quietly
    // invert. Without this, stamping everything "claude" would leave every
    // other test in this file green.
    editor.commands.insertContentAt(6, "brave ");

    expect(entries()).toHaveLength(1);
    expect(entries()[0].author).toBe("user");
    expect(entries()[0].id.startsWith("user")).toBe(true);
  });

  it("attributes a tagged edit to Claude, id and field together", () => {
    const tr = editor.state.tr.insertText("XYZ", 6).setMeta(AUTHORSHIP_ORIGIN_META, "claude");
    editor.view.dispatch(tr);

    expect(entries()).toHaveLength(1);
    expect(entries()[0].author).toBe("claude");
    // The id encodes the author. A pair that disagrees is a debugging trap:
    // whichever one the reader happens to check tells them a different story.
    expect(entries()[0].id.startsWith("claude")).toBe(true);
  });

  it("falls back to the user for an off-schema origin rather than writing it through", () => {
    // `getMeta` is untyped, and this value lands in a Y.Map that outlives the
    // session and that the decoration builder switches on.
    const tr = editor.state.tr.insertText("XYZ", 6).setMeta(AUTHORSHIP_ORIGIN_META, "gpt-9");
    editor.view.dispatch(tr);

    expect(entries()[0].author).toBe("user");
  });

  it("records nothing for a remote y-sync transaction", () => {
    const tr = editor.state.tr
      .insertText("XYZ", 6)
      .setMeta(ySyncPluginKey, { isChangeOrigin: true });
    editor.view.dispatch(tr);

    // A remote edit is somebody else's authorship, already carried in their
    // own Y.Map entry. Stamping it here would double-attribute it, locally as
    // "user". The new meta read must not disturb this skip.
    expect(entries()).toHaveLength(0);
  });

  it("attributes each step of a multi-step transaction to the text it actually inserted", () => {
    // Find-and-replace-all applies its matches in REVERSE document order, so
    // every step but the last is shifted by the ones that follow it. Reading
    // step positions against `transaction.doc` (the final doc) puts the marks
    // on the wrong characters — invisible in a single-step transaction, which
    // is every other test here.
    editor.commands.setContent("<p>aaa bbb aaa</p>");
    ydoc.getMap(Y_MAP_AUTHORSHIP).clear();

    const tr = editor.state.tr;
    // Later match first, exactly as replace-all does it.
    tr.insertText("ZZZZZZ", 9, 12);
    tr.insertText("ZZZZZZ", 1, 4);
    editor.view.dispatch(tr);

    const text = editor.state.doc.textBetween(0, editor.state.doc.content.size);
    expect(text).toBe("ZZZZZZ bbb ZZZZZZ");
    const spans = entries()
      .map((e) => e.range)
      .sort((a, b) => a.from - b.from);
    expect(spans).toHaveLength(2);
    // Both spans must land on the Zs. The first replacement's recorded range
    // is the one the un-remapped read gets wrong: it stays at 8–14 while its
    // text has moved to 11–17.
    for (const span of spans) {
      expect(text.slice(span.from, span.to)).toBe("ZZZZZZ");
    }
  });

  describe("reaping entries the same transaction deleted", () => {
    it("drops an entry whose text is entirely replaced", () => {
      editor.commands.insertContentAt(6, "brave ");
      const original = entries();
      expect(original).toHaveLength(1);

      // Replace exactly the stamped span with Claude's text — the accept-a-
      // suggestion shape. Leaving the old entry behind would put a "user"
      // range on top of the new "claude" one, and the decoration builder
      // paints both.
      const tr = editor.state.tr
        .insertText("BOLDLY ", 6, 12)
        .setMeta(AUTHORSHIP_ORIGIN_META, "claude");
      editor.view.dispatch(tr);

      const after = entries();
      expect(after.map((e) => e.id)).not.toContain(original[0].id);
      expect(after).toHaveLength(1);
      expect(after[0].author).toBe("claude");
    });

    it("keeps an entry the deletion only partially overlaps", () => {
      editor.commands.insertContentAt(6, "brave ");
      const original = entries()[0];

      // Half of the stamped span. Dropping it would erase attribution for the
      // surviving half; rewriting its range needs a relRange client stamps do
      // not carry yet (#1471). Keeping the (now drifted) entry is deliberate.
      editor.view.dispatch(editor.state.tr.delete(6, 9));

      expect(entries().map((e) => e.id)).toContain(original.id);
    });

    it("reaps a claude entry too — the reap keys on the span, never the author", () => {
      const tr = editor.state.tr.insertText("XYZ", 6).setMeta(AUTHORSHIP_ORIGIN_META, "claude");
      editor.view.dispatch(tr);
      const claudeEntry = entries()[0];
      expect(claudeEntry.author).toBe("claude");

      editor.view.dispatch(editor.state.tr.delete(6, 9));

      expect(entries().map((e) => e.id)).not.toContain(claudeEntry.id);
    });

    it("without a Collaboration binding, a drifted entry still escapes the reap", () => {
      // THE GRACEFUL-DEGRADATION CONTRACT, and it did not change when #1471
      // landed. This editor has no `Collaboration` extension, so
      // `ydoc.getXmlFragment("default")` is empty, the anchor mint declines, and
      // the entry keeps exactly the frozen-flat-offset behaviour described
      // below: one unrelated keystroke ABOVE a stamped span moves its text out
      // from under its recorded range, the reap compares a current-frame deleted
      // span against a stale entry, containment fails, and the entry survives.
      //
      // It was titled "KNOWN LIMITATION (#1471)" and expected to invert when the
      // fix landed. It cannot invert HERE — with no binding there is nothing to
      // anchor into, so the limitation remains real in this context. The
      // inverted case lives in `authorship-anchor.test.ts` against a genuinely
      // bound editor; what is pinned here is that declining to anchor still
      // costs nothing beyond the drift, which this change needs asserted
      // somewhere and would otherwise not have.
      editor.commands.insertContentAt(6, "brave ");
      editor.view.dispatch(editor.state.tr.insertText("X", 1));

      const at = editor.getText().indexOf("brave ") + 1;
      editor.view.dispatch(
        editor.state.tr.insertText("BOLDLY ", at, at + 6).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
      );

      expect(entries().some((e) => e.author === "claude")).toBe(true);
      expect(entries().some((e) => e.range.from === 5 && e.range.to === 11)).toBe(true);
    });

    it("does not reap on a formatting change that deletes no text", () => {
      // A heading toggle or list wrap emits a step whose map reports a deleted
      // NODE-boundary range, which is exactly the shape that would make a reap
      // eat a whole block's attribution. It does not, because those ranges
      // carry no text and collapse to zero flat width. Pinned here because the
      // reasoning is a property of ReplaceAroundStep's step map, not of our
      // code — a prosemirror-transform change could take it away silently.
      editor.commands.insertContentAt(6, "brave ");
      const before = entries().map((e) => e.id);

      editor.commands.setTextSelection(3);
      editor.commands.toggleHeading({ level: 2 });
      editor.commands.toggleBulletList();

      expect(entries().map((e) => e.id)).toEqual(expect.arrayContaining(before));
    });
  });

  it("applySuggestion attributes an accepted suggestion to Claude", () => {
    // The real function, not a reconstruction of its shape. `applySuggestion`
    // is exported solely for this: the hook's own suite drives it through a
    // fully mocked editor that cannot observe a transaction, and a mutation
    // deleting its `.setMeta()` step passes every assertion over there.
    //
    // This also pins the mechanism the whole approach rests on — a Tiptap
    // chain batches its steps into ONE transaction, so a `.setMeta()` step
    // tags the insertion three steps later. Asserted on the resulting entry,
    // never on a `dispatch` call count: `.focus()` adds a second,
    // non-doc-changing dispatch, so a count would fail for a reason that has
    // nothing to do with attribution.
    const ann = {
      id: "ann_stamp_001",
      author: "claude",
      type: "comment",
      status: "pending",
      // Flat offsets: "world" in "hello world".
      range: { from: 6, to: 11 },
      text: "reword this",
      suggestedText: "planet",
      timestamp: Date.now(),
    } as unknown as Annotation;

    expect(applySuggestion(ann, editor, ydoc)).toBe(true);
    expect(editor.getText()).toBe("hello planet");
    expect(entries()).toHaveLength(1);
    expect(entries()[0].author).toBe("claude");
  });

  // Both rows are load-bearing and neither subsumes the other: the "claude"
  // row catches a lost tag, the "user" row catches a hardcoded one. The Insert
  // affordance is rendered for EVERY chat message, the user's included
  // (`ChatPanel.svelte` has no author guard), so hardcoding "claude" inside
  // `insertChatMarkdown` would have replaced #1388 with its mirror image.
  it.each(["claude", "user"] as const)("attributes a %s chat message to %s", (author) => {
    insertChatMarkdown(editor, "**a message**", author);
    expect(entries().length).toBeGreaterThan(0);
    expect(entries().every((e) => e.author === author)).toBe(true);
  });

  it("writes no entry when position conversion throws", () => {
    // The handler swallows conversion failures so a keystroke is never lost.
    // That must mean "no entry", not "an entry with garbage coordinates" — a
    // bad range would be painted somewhere, and a range painted on the wrong
    // text is the defect this whole file is about.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failConversion = true;

    editor.commands.insertContentAt(6, "brave ");

    expect(entries()).toHaveLength(0);
    // …and it said so. A swallow that logs nothing is how a coordinate bug
    // becomes a silent no-op instead of a bug report.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
