// @vitest-environment happy-dom

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Editor, Extension } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { findWrapping } from "@tiptap/pm/transform";
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

  describe("a structural step and a deletion in the SAME transaction (#1481)", () => {
    /**
     * #1481 asked whether the reap's before-frame mapping —
     * `new Mapping(transaction.mapping.maps.slice(0, i)).invert()` — loses
     * accuracy by dropping `transaction.mapping`'s `mirror` array, since
     * ProseMirror uses mirrored step pairs for exact position recovery across
     * a replace-around. It does not, because nothing in this stack ever sets
     * a mirror; the long comment at that line records the survey.
     *
     * WHAT THESE TESTS ARE FOR, PRECISELY. They do not test mirror handling —
     * they cannot, because no transaction here carries a mirror, so a wrong
     * filter of `undefined` is still `undefined` and would stay green. Their
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
        content: "<p>hello world</p>",
      });
      try {
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
      } finally {
        probeEditor.destroy();
        probeYdoc.destroy();
      }
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
 */
describe("the mirror-free assumption's static half (#1481)", () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  const COLLAB = /["'](?:prosemirror-collab|@tiptap\/pm\/collab)["']/;
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
