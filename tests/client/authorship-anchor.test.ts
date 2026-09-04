// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  _resetAuthorshipWarnLatch,
  AUTHORSHIP_ORIGIN_META,
  AuthorshipExtension,
  buildAuthorshipDecorations,
} from "../../src/client/editor/extensions/authorship";
import { flatOffsetToPmPos, relRangeToPmPositions } from "../../src/client/positions";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { Y_MAP_AUTHORSHIP } from "../../src/shared/constants";
import { anchorFlatRange } from "../../src/shared/positions/ydoc";
import type { AuthorshipRange } from "../../src/shared/types";
import { off } from "../helpers/positions";

/**
 * Client authorship stamps carry a CRDT anchor (#1471 gap 1).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `authorship-stamp.test.ts`. That file
 * builds its Editor with no `Collaboration` extension, so
 * `ydoc.getXmlFragment("default")` is EMPTY and a mint there can only ever
 * decline. Every test in it would still pass with this change reverted, proving
 * nothing — the `a-mock-cannot-see-a-correspondence-bug` shape. A real
 * y-prosemirror binding is the prerequisite for testing any of this, not a
 * nicety.
 *
 * That is also why the "KNOWN LIMITATION (#1471)" case over there could not be
 * inverted where it stood: with no binding, the limitation it pins is still
 * genuinely true there. It is re-homed here against a bound editor, and the
 * original is retitled as the graceful-degradation contract — which this change
 * needs pinned anyway and would otherwise not have.
 */

const live: Editor[] = [];

/**
 * Seed Y FIRST, then bind. Sidesteps y-prosemirror's `initialContentChanged`
 * latch rather than betting on it, and is the shape
 * `structural-snapshot-undo.test.ts` already uses.
 */
function boundEditor(markdown: string) {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  const editor = new Editor({
    extensions: [
      ...buildSchemaExtensions(),
      Collaboration.configure({ document: ydoc }),
      AuthorshipExtension.configure({ ydoc }),
    ],
  });
  live.push(editor);
  const entries = () => [...ydoc.getMap(Y_MAP_AUTHORSHIP).values()] as AuthorshipRange[];
  return { ydoc, editor, entries };
}

/**
 * The text each INLINE AUTHORSHIP DECORATION actually covers, per author.
 *
 * Goes through `buildAuthorshipDecorations` — the real render path — rather than
 * re-deriving positions from `relRangeToPmPositions` here. An earlier draft of
 * this file did the latter and it was worthless: reverting the resolver fix in
 * production left all five tests green, because the test was asserting against
 * its own copy of the logic under test. That is the shape
 * `a-mock-cannot-see-a-correspondence-bug` names, reproduced exactly.
 *
 * Keyed by author because that is what the decoration carries
 * (`data-tandem-author`); entry ids are not in the spec.
 */
function decoratedTextByAuthor(ydoc: Y.Doc, editor: Editor): Record<string, string[]> {
  const doc = editor.state.doc;
  const set = buildAuthorshipDecorations(doc, ydoc.getMap(Y_MAP_AUTHORSHIP), ydoc, true);
  const out: Record<string, string[]> = {};
  for (const decoration of set.find()) {
    const author = (decoration as { type?: { attrs?: Record<string, string> } }).type?.attrs?.[
      "data-tandem-author"
    ];
    // The gutter pass adds node decorations too; only inline spans carry it.
    if (!author) continue;
    (out[author] ??= []).push(doc.textBetween(decoration.from, decoration.to));
  }
  for (const key of Object.keys(out)) out[key].sort();
  return out;
}

/** The anchor's own resolution, for asserting the MINT rather than the render. */
function anchoredText(ydoc: Y.Doc, editor: Editor, entry: AuthorshipRange): string | null {
  if (!entry.relRange) return null;
  const at = relRangeToPmPositions(ydoc, editor.state.doc, entry.relRange);
  return at && at.from < at.to ? editor.state.doc.textBetween(at.from, at.to) : null;
}

afterEach(() => {
  // Destroying every editor matters more than it looks: an undestroyed Tiptap
  // Editor's DOMObserver timer fires after happy-dom tears the document down,
  // which surfaces as "everything passed, exit 1" with no failing test named.
  for (const editor of live.splice(0)) editor.destroy();
  _resetAuthorshipWarnLatch();
});

describe("client stamps are CRDT-anchored", () => {
  it("TEST 0 — the binding is real and the mint works", () => {
    // ANTI-VACUUM GUARD, and the most important test in the file. Without it a
    // regression in the harness silently turns every test below into a green
    // test of the degraded path — precisely the state the pre-existing suite
    // was already in, which is why it proved nothing for months.
    const { ydoc, editor, entries } = boundEditor("hello world\n");

    expect(ydoc.getXmlFragment("default").length, "Y fragment must be populated").toBeGreaterThan(
      0,
    );

    editor.view.dispatch(editor.state.tr.insertText("X", 1));
    expect(entries()).toHaveLength(1);
    expect(entries()[0].relRange, "a stamp on a bound editor must mint an anchor").toBeDefined();
  });

  it("keeps a stamp on its own text after an edit earlier in the document", () => {
    // RE-HOMED from `authorship-stamp.test.ts`. One unrelated keystroke ABOVE a
    // stamped span used to move its text out from under its recorded flat
    // offsets, permanently and silently.
    //
    // Asserted by resolved TEXT rather than by literal offsets: this change
    // deliberately does not rewrite the stored flat `range`, so an offset
    // assertion would pin the stale numbers and pass for the wrong reason. What
    // must be true is that the anchor still names the same characters.
    const { ydoc, editor, entries } = boundEditor("alpha bravo charlie\n");

    const at = editor.getText().indexOf("bravo") + 1;
    editor.view.dispatch(
      editor.state.tr.insertText("BOLDLY ", at).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );
    const claude = entries().find((entry) => entry.author === "claude");
    expect(claude?.relRange, "the claude stamp must be anchored").toBeDefined();
    expect(anchoredText(ydoc, editor, claude as AuthorshipRange)).toBe("BOLDLY ");

    // The unrelated keystroke, well before the stamped span.
    editor.view.dispatch(editor.state.tr.insertText("X", 1));

    expect(
      anchoredText(ydoc, editor, claude as AuthorshipRange),
      "anchor must survive an earlier edit",
    ).toBe("BOLDLY ");
    // And the RENDER must agree, which is the part the user sees.
    expect(decoratedTextByAuthor(ydoc, editor).claude).toEqual(["BOLDLY "]);
  });

  it("renders a recovered live anchor without a flat-offset degradation warning", () => {
    const { ydoc, editor } = boundEditor("alpha bravo charlie\n");
    const from = editor.getText().indexOf("bravo");
    const relRange = anchorFlatRange(ydoc, off(from), off(from + "bravo".length));
    if (!relRange) throw new Error("recovered fixture failed to mint a live server-shaped anchor");

    ydoc.getMap(Y_MAP_AUTHORSHIP).set("recovered", {
      id: "recovered",
      author: "claude",
      range: { from: off(from), to: off(from + "bravo".length) },
      relRange,
      timestamp: 1700000000000,
    } satisfies AuthorshipRange);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(decoratedTextByAuthor(ydoc, editor).claude).toEqual(["bravo"]);
      editor.view.dispatch(editor.state.tr.insertText("12345", 1));
      expect(decoratedTextByAuthor(ydoc, editor).claude).toEqual(["bravo"]);
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("Falling back to flat offsets for range"),
        ),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("paints nothing when a DRIFTED entry loses its text, instead of painting elsewhere", () => {
    // THE RESOLVER FIX, and getting this scenario right took two attempts.
    //
    // A simple delete-what-you-stamped is NOT a test of it: that deletion is
    // exactly what the existing reap catches, so no entry survives for either
    // version of the resolver to get wrong, and the test passes identically with
    // the fix reverted. The fix only matters for an entry the reap MISSES.
    //
    // Which is the #1471 entry itself. Drift the stored flat offsets first with
    // an unrelated edit above; the reap then compares a current-frame deleted
    // span against stale offsets, containment fails, and the entry survives with
    // a collapsed anchor and a stale flat range. Before the fix, that range
    // resolved through `flatOffsetToPmPos` — which CLAMPS rather than failing —
    // and painted confidently on whatever text now sat at those numbers. That is
    // #1388's render reached from the other side.
    const { ydoc, editor, entries } = boundEditor("alpha bravo charlie delta\n");

    const at = editor.getText().indexOf("bravo") + 1;
    editor.view.dispatch(
      editor.state.tr.insertText("ZZZZ", at).setMeta(AUTHORSHIP_ORIGIN_META, "claude"),
    );
    const claude = entries().find((entry) => entry.author === "claude") as AuthorshipRange;
    expect(decoratedTextByAuthor(ydoc, editor).claude).toEqual(["ZZZZ"]);
    const storedRange = { ...claude.range };

    // Drift: an unrelated insertion ABOVE the stamp, so the stored offsets no
    // longer describe where the text is.
    editor.view.dispatch(editor.state.tr.insertText("XX", 1));

    // Now delete the stamped text. The reap misses it, by construction.
    const from = editor.getText().indexOf("ZZZZ") + 1;
    editor.view.dispatch(editor.state.tr.delete(from, from + 4));
    const survivor = entries().find((entry) => entry.id === claude.id);
    expect(survivor, "the drifted entry must survive the reap — that is the premise").toBeDefined();
    expect(survivor?.range, "and still carry its stale offsets").toEqual(storedRange);

    // The stale offsets must still name real, non-empty text, or the assertion
    // below would pass for the boring reason rather than the intended one.
    const doc = editor.state.doc;
    expect(
      doc.textBetween(
        flatOffsetToPmPos(doc, storedRange.from),
        flatOffsetToPmPos(doc, storedRange.to),
      ),
      "the stale range must resolve to SOMETHING for this test to mean anything",
    ).not.toBe("");

    expect(
      decoratedTextByAuthor(ydoc, editor).claude,
      "a collapsed anchor must paint nothing, never fall back to stale offsets",
    ).toBeUndefined();
  });

  it("still stamps, unanchored, when there is no Collaboration binding", () => {
    // THE DEGRADATION CONTRACT. Declining to anchor must never cost the stamp
    // itself: an unanchored entry behaves exactly as every entry did before this
    // change — worse than anchored, but not broken.
    const ydoc = new Y.Doc();
    const editor = new Editor({
      extensions: [...buildSchemaExtensions(), AuthorshipExtension.configure({ ydoc })],
      content: "<p>hello world</p>",
    });
    live.push(editor);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      editor.view.dispatch(editor.state.tr.insertText("X", 1));
      const entries = [...ydoc.getMap(Y_MAP_AUTHORSHIP).values()] as AuthorshipRange[];
      expect(entries).toHaveLength(1);
      expect(entries[0].relRange, "no fragment to anchor into").toBeUndefined();
      expect(entries[0].range, "but the flat stamp must still happen").toBeDefined();

      // Unlike an out-of-bounds fallback entry dropped by the server recovery,
      // a valid client stamp whose mint declined still reaches the renderer.
      // It must remain visible, but the once-per-session warning makes the
      // flat-offset degradation observable instead of silently drifting.
      expect(decoratedTextByAuthor(ydoc, editor).user).toEqual(["X"]);
      expect(decoratedTextByAuthor(ydoc, editor).user).toEqual(["X"]);
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("Falling back to flat offsets for range"),
        ),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("anchors against the final frame, not a per-step intermediate", () => {
    // A multi-step transaction applied in reverse document order — the
    // find-replace-all shape. Y holds only the transaction's FINAL state, never
    // a per-step intermediate, so anchoring raw step positions would mint a
    // confidently wrong anchor on every step but the last.
    const { ydoc, editor, entries } = boundEditor("one TARGET two TARGET three\n");

    const text = editor.getText();
    const second = text.lastIndexOf("TARGET") + 1;
    const first = text.indexOf("TARGET") + 1;
    const tr = editor.state.tr;
    // Pure insertions, LATER POSITION FIRST — the order find-replace-all
    // applies its matches in. Deliberately not replacements: a replacement that
    // shrinks the text has `insertedLen <= 0` and is never stamped at all, so a
    // fixture built that way asserts nothing while looking like it does.
    //
    // Step 0 lands at `second`; step 1 then inserts BEFORE it and shifts it. So
    // step 0's own `newStart` no longer addresses `transaction.doc` by the time
    // the handler reads it, which is exactly the case `toFinal` exists for and
    // the case a raw-position anchor would get confidently wrong.
    tr.insertText("AAA", second);
    tr.insertText("BBB", first);
    editor.view.dispatch(tr.setMeta(AUTHORSHIP_ORIGIN_META, "claude"));

    const anchored = entries().filter((entry) => entry.relRange);
    expect(anchored.length, "both replacements must anchor").toBe(2);
    expect(
      anchored.map((entry) => anchoredText(ydoc, editor, entry)).sort(),
      "each anchor must name its own replacement",
    ).toEqual(["AAA", "BBB"]);
  });
});
