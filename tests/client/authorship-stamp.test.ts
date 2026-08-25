// @vitest-environment happy-dom

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Editor, Extension } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { findWrapping, Mapping, StepMap } from "@tiptap/pm/transform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  _resetAuthorshipWarnLatch,
  AUTHORSHIP_ORIGIN_META,
  AuthorshipExtension,
  firstMirroredMapIndex,
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

  describe("a structural step and a deletion in the SAME transaction (#1481)", () => {
    /**
     * #1481 asked whether the reap's before-frame mapping —
     * `new Mapping(transaction.mapping.maps.slice(0, i)).invert()` — loses
     * accuracy by dropping `transaction.mapping`'s `mirror` array, since
     * ProseMirror uses mirrored step pairs for exact position recovery across
     * a replace-around. It does not, because nothing in this stack ever sets
     * a mirror; the long comment at that line records the survey.
     *
     * WHAT THE FIRST TWO ARE FOR, PRECISELY. They do not test mirror handling —
     * they cannot, because no transaction here carries a mirror, so a wrong
     * filter of `undefined` is still `undefined` and would stay green. (The
     * DEV-guard cases at the bottom of this block do exercise a mirror, by
     * fabricating one no editor in this repo can produce.) Their
     * value is that they are the first tests to drive `toBefore` with `i > 0`
     * THROUGH A STRUCTURAL STEP and then assert a REAP outcome. The multi-step
     * test above reaches `i = 1` but asserts only on insertion spans, and
     * "does not reap on a formatting change that deletes no text" dispatches
     * its wrap and its delete as separate transactions, so neither one covers
     * this path. Verified by mutation: swapping the construction for the
     * known-broken `transaction.mapping.slice(0, i).invert()` idiom reds the
     * wrap-first case below — alongside the two single-step reap tests above,
     * which that idiom already broke. So the mutation proves PATH COVERAGE
     * (the deletion's `old*` positions really do travel back through the
     * structural step), not mirror coverage. The delete-first case survives
     * that mutation, which is exactly why it is written down: it is the shape
     * a bounds bug leaves working.
     */
    function wrapInBulletList(tr: Transaction, pos: number, schema: Editor["schema"]) {
      const $pos = tr.doc.resolve(pos);
      const range = $pos.blockRange($pos);
      expect(range, "premise: the paragraph must form a block range").not.toBeNull();
      const wrapping = range && findWrapping(range, schema.nodes.bulletList);
      expect(wrapping, "premise: the block range must be wrappable in a bullet list").toBeTruthy();
      if (range && wrapping) tr.wrap(range, wrapping);
    }

    it("reaps an entry deleted by a transaction that also wraps the block in a list", () => {
      editor.commands.insertContentAt(6, "brave ");
      const stamped = entries();
      expect(stamped).toHaveLength(1);
      // THE PREMISE, asserted rather than assumed. `reapableEntryIds` returns
      // early for any entry carrying a `relRange` (#1480), so against a
      // Collaboration-bound editor this test would pass without the reap
      // running at all. This editor has no binding, so the mint declines and
      // the entry is unanchored — the only kind the scan looks at.
      expect(stamped[0].relRange).toBeUndefined();

      const tr = editor.state.tr;
      // Wrap FIRST, so the deletion is step 1 and its `old*` positions have to
      // travel back through the ReplaceAroundStep to reach the before frame.
      // That is the `i > 0` case; getting it wrong shifts the recovered span
      // off the stamped text and the containment check silently misses.
      wrapInBulletList(tr, 6, editor.schema);
      tr.delete(tr.mapping.map(6, 1), tr.mapping.map(12, -1));
      expect(tr.mapping.maps.length, "premise: two steps, structural then text").toBe(2);
      editor.view.dispatch(tr);

      expect(editor.state.doc.textBetween(0, editor.state.doc.content.size)).not.toContain("brave");
      expect(entries().map((e) => e.id)).not.toContain(stamped[0].id);
    });

    it("reaps it with the deletion first too — the step order must not matter", () => {
      editor.commands.insertContentAt(6, "brave ");
      const stamped = entries();
      expect(stamped).toHaveLength(1);
      expect(stamped[0].relRange).toBeUndefined();

      const tr = editor.state.tr;
      tr.delete(6, 12);
      // Now `i = 0` for the deletion, so `toBefore` is the inverse of NOTHING.
      // Pinned as the other half of the pair: it is the case that a bounds bug
      // in the slice would leave working, which is how such a bug hides.
      wrapInBulletList(tr, 3, editor.schema);
      expect(tr.mapping.maps.length).toBe(2);
      editor.view.dispatch(tr);

      expect(entries().map((e) => e.id)).not.toContain(stamped[0].id);
    });

    /**
     * A throwaway editor plus a transaction recorder, torn down whichever way
     * `run` exits. Separate from the suite's shared `editor` because these
     * cases need their own starting content (a list to lift out of, a second
     * item to sink) and must not leave the shared one restructured.
     */
    function withProbe<T>(content: string, run: (editor: Editor, seen: Transaction[]) => T): T {
      const seen: Transaction[] = [];
      const probeYdoc = new Y.Doc();
      const probeEditor = new Editor({
        extensions: [
          ...buildSchemaExtensions(),
          AuthorshipExtension.configure({ ydoc: probeYdoc }),
          Extension.create({
            name: "mirrorProbe",
            onTransaction({ transaction }) {
              seen.push(transaction);
            },
          }),
        ],
        content,
      });
      try {
        return run(probeEditor, seen);
      } finally {
        probeEditor.destroy();
        probeYdoc.destroy();
      }
    }

    /** Position inside `text`, so a case does not hard-code a PM offset. */
    function posInText(editor: Editor, text: string): number {
      let found = -1;
      editor.state.doc.descendants((node, pos) => {
        if (found >= 0) return false;
        const at = node.isText ? (node.text ?? "").indexOf(text) : -1;
        if (at >= 0) found = pos + at + 1;
        return true;
      });
      expect(found, `premise: the probe document must contain "${text}"`).toBeGreaterThan(0);
      return found;
    }

    it("observes no mirror on the transaction the reap maps through", () => {
      // The runtime half of the assumption. It asserts POSITIVELY before it
      // asserts an absence: an assertion of the form "the field is undefined"
      // also passes when the capture never fired, when the transaction was not
      // the one meant, and — since `mirror` is `@internal` and absent from the
      // published typings — when a dependency bump renames the field out from
      // under a cast. So: the probe must have seen THIS transaction object, it
      // must have changed the doc, it must carry the two step maps, and only
      // then is the mirror read — through `getMirror`, which IS public and
      // would fail loudly rather than read `undefined` if it were removed.
      //
      // This is the runtime half only. It cannot see a collab plugin added to
      // `src/client/editor/`, because this editor will never configure one;
      // the static walk at the bottom of this file is what covers that.
      withProbe("<p>hello world</p>", (probeEditor, seen) => {
        probeEditor.commands.insertContentAt(6, "brave ");
        seen.length = 0;

        const tr = probeEditor.state.tr;
        wrapInBulletList(tr, 6, probeEditor.schema);
        tr.delete(tr.mapping.map(6, 1), tr.mapping.map(12, -1));
        probeEditor.view.dispatch(tr);

        const observed = seen.find((candidate) => candidate === tr);
        expect(observed, "the probe must have observed the dispatched transaction").toBeDefined();
        if (!observed) return;
        expect(observed.docChanged).toBe(true);
        expect(observed.mapping.maps.length).toBeGreaterThanOrEqual(2);
        for (let i = 0; i < observed.mapping.maps.length; i++) {
          expect(observed.mapping.getMirror(i)).toBeUndefined();
        }
      });
    });

    /**
     * Every structural command the source comment names, driven for real. The
     * comment asserts they all append mirror-free; a claim about five commands
     * backed by a probe that drives one is a pin whose evidence lives where the
     * reader cannot look, and this is an editor the file already builds, so the
     * loop is cheaper than the prose it replaces.
     *
     * Note what is NOT here: history undo. There is no prosemirror-history
     * plugin in this editor to undo through (`StarterKit.configure({ history:
     * false })`), and Yjs undo arrives tagged with `ySyncPluginKey`, which the
     * handler skips before it ever builds a mapping — see
     * `authorship-undo-redo.test.ts`. A case for it here would assert against a
     * plugin the product does not register.
     */
    const STRUCTURAL_COMMANDS: {
      name: string;
      content: string;
      drive: (editor: Editor) => boolean;
    }[] = [
      {
        name: "list wrap",
        content: "<p>hello world</p>",
        drive: (e) => e.commands.toggleBulletList(),
      },
      {
        name: "liftListItem",
        content: "<ul><li><p>hello world</p></li></ul>",
        drive: (e) =>
          e.chain().setTextSelection(posInText(e, "hello")).liftListItem("listItem").run(),
      },
      {
        name: "sinkListItem",
        content: "<ul><li><p>first</p></li><li><p>second</p></li></ul>",
        drive: (e) =>
          e.chain().setTextSelection(posInText(e, "second")).sinkListItem("listItem").run(),
      },
      {
        name: "blockquote toggle",
        content: "<p>hello world</p>",
        drive: (e) => e.commands.toggleBlockquote(),
      },
      {
        name: "heading toggle",
        content: "<p>hello world</p>",
        drive: (e) => e.commands.toggleHeading({ level: 2 }),
      },
    ];

    it.each(STRUCTURAL_COMMANDS)("appends mirror-free through $name", ({ content, drive }) => {
      withProbe(content, (probeEditor, seen) => {
        seen.length = 0;
        expect(drive(probeEditor), "premise: the command must have applied").toBe(true);

        const changing = seen.filter((candidate) => candidate.docChanged);
        // Zero-of-zero guard, twice over: a command that silently no-opped, or
        // a doc-changing transaction with no step maps, would satisfy the
        // mirror assertion vacuously.
        expect(changing.length, "premise: the command must have changed the doc").toBeGreaterThan(
          0,
        );
        for (const observed of changing) {
          expect(observed.mapping.maps.length).toBeGreaterThan(0);
          for (let i = 0; i < observed.mapping.maps.length; i++) {
            expect(observed.mapping.getMirror(i), `map ${i} carried a mirror`).toBeUndefined();
          }
          expect(firstMirroredMapIndex(observed.mapping)).toBeNull();
        }
      });
    });

    describe("the DEV-only runtime guard", () => {
      // The detector is route-independent where the static walk is not: it
      // reads the mapping in hand, so it fires whether collab was imported
      // directly, pulled in transitively by some future Tiptap extension, or
      // named through a specifier the walk's regex cannot see.
      beforeEach(() => {
        _resetAuthorshipWarnLatch();
      });
      afterEach(() => {
        _resetAuthorshipWarnLatch();
      });

      /** The mirror warning specifically — this editor emits others. */
      const mirrorWarnings = (warn: { mock: { calls: unknown[][] } }): string[] =>
        warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("mirror"));

      it("stays silent on the mirror-free transactions the reap actually sees", () => {
        // The false-positive direction, and the only thing that catches a
        // detector that answers "mirrored" unconditionally — every other test
        // in this file would stay green through that mutation.
        //
        // Filtered rather than `not.toHaveBeenCalled()`: this editor has no
        // Collaboration binding, so every stamp fails to anchor and warns
        // (#1471). Asserting on the whole console would couple this case to
        // that unrelated line.
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          editor.commands.insertContentAt(6, "brave ");
          const tr = editor.state.tr;
          wrapInBulletList(tr, 6, editor.schema);
          tr.delete(tr.mapping.map(6, 1), tr.mapping.map(12, -1));
          editor.view.dispatch(tr);

          expect(mirrorWarnings(warn)).toEqual([]);
        } finally {
          warn.mockRestore();
        }
      });

      it("warns once when the mapping does carry a mirror", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          editor.commands.insertContentAt(6, "brave ");
          const stamped = entries();
          expect(stamped).toHaveLength(1);

          const tr = editor.state.tr;
          tr.delete(6, 12);
          // Fabricate what only `prosemirror-collab`'s `rebaseSteps` produces
          // in the wild. The appended map is EMPTY, so it contributes no ranges
          // and the reap behaves exactly as it would without it — the mirror is
          // the single observable difference, which is what makes the pair of
          // assertions below separable.
          tr.mapping.appendMap(new StepMap([]), 0);
          expect(tr.mapping.getMirror(1), "premise: the fabricated pair must be mirrored").toBe(0);
          editor.view.dispatch(tr);

          // The reap still ran…
          expect(entries().map((e) => e.id)).not.toContain(stamped[0].id);
          // …and it said so, naming the issue rather than the symptom.
          expect(mirrorWarnings(warn)).toHaveLength(1);
          expect(mirrorWarnings(warn)[0]).toContain("#1481");

          // ONCE, not once per transaction. A mirror that survives is a
          // standing condition, so an unlatched warning would fire on every
          // deleting keystroke for the rest of the session and get muted
          // wholesale — which is how the signal would be lost.
          editor.commands.insertContentAt(6, "bold ");
          const second = editor.state.tr;
          second.delete(6, 11);
          second.mapping.appendMap(new StepMap([]), 0);
          editor.view.dispatch(second);
          expect(mirrorWarnings(warn)).toHaveLength(1);
        } finally {
          warn.mockRestore();
        }
      });

      it("reports the first mirrored index, not merely that one exists", () => {
        // Direct, because no editor in this repo can produce a mapping with a
        // mirror at a non-zero index — and an index-returning detector that
        // always answered 0 would be indistinguishable through the handler.
        const plain = new StepMap([]);
        const mirrorless = new Mapping([plain, plain, plain]);
        expect(firstMirroredMapIndex(mirrorless)).toBeNull();

        const mirrored = new Mapping([plain]);
        mirrored.appendMap(plain);
        mirrored.appendMap(plain, 1);
        expect(mirrored.getMirror(2), "premise: maps 1 and 2 must be a mirrored pair").toBe(1);
        expect(firstMirroredMapIndex(mirrored)).toBe(1);
      });
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
      content: "reword this",
      suggestedText: "planet",
      timestamp: Date.now(),
    } as Annotation;

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

/**
 * The static half of #1481's assumption, and the only half that can catch the
 * trigger the source comment actually names.
 *
 * The reap's before-frame mapping is built without a `mirror` array, which is
 * safe because no transaction in this stack carries one. `prosemirror-collab`'s
 * `rebaseSteps` is the sole producer in the whole dependency tree — and it is
 * INSTALLED, not absent: it ships as a dependency of `@tiptap/pm` and is one
 * `@tiptap/pm/collab` import away. Importing it is therefore a one-line change
 * that would invalidate the reasoning at `authorship.ts` silently, and no
 * runtime test in this file could see it, because the editors here will never
 * configure a collab plugin.
 *
 * WHAT IT DOES NOT COVER, so nobody reads it as the whole guard: it matches a
 * literal specifier under `src/`. A collab plugin pulled in transitively by
 * some future third-party Tiptap extension, or named through a specifier built
 * by concatenation, populates `transaction.mapping.mirror` while leaving this
 * walk green. That route belongs to the DEV-only `firstMirroredMapIndex` guard
 * wired at the reap; this one is the half that fails in CI.
 */
describe("the mirror-free assumption's static half (#1481)", () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  // Anchored on an import CONTEXT, not on the bare specifier. Matching any
  // quoted occurrence fails closed, so it was never dangerous — but the source
  // comment this pairs with names both packages in prose, and the repair for a
  // spurious red is to LOOSEN the pattern, which is the one direction that
  // makes it miss a real import. Covering `from "x"`, `import "x"`,
  // `import("x")` and `require("x")` keeps prose out of it without widening.
  const COLLAB =
    /\b(?:from|import|require)\s*\(?\s*["'](?:prosemirror-collab|@tiptap\/pm\/collab)["']/;
  const SCANNED = new Set([".ts", ".tsx", ".js", ".mjs", ".svelte"]);

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (SCANNED.has(path.extname(entry.name))) out.push(full);
    }
    return out;
  }

  it("no file under src/ imports prosemirror-collab", () => {
    const files = walk(SRC);
    // The zero-of-zero guard. A walk that silently stopped scanning reports
    // exactly the same "no offenders" as a clean tree — this repo has shipped
    // that shape before (see `tests/scripts/audit-origins.test.ts`).
    expect(files.length).toBeGreaterThan(300);

    const offenders = files
      .filter((file) => COLLAB.test(readFileSync(file, "utf-8")))
      .map((file) => path.relative(SRC, file));
    // If this fails, the mirror survey in `authorship.ts`'s reap comment no
    // longer holds: a collab plugin rebases steps through `setMirror`, so
    // `transaction.mapping.mirror` becomes populated and dropping it when
    // building `toBefore` starts costing exact position recovery. Re-open
    // #1481 rather than deleting this test.
    expect(offenders).toEqual([]);
  });
});
