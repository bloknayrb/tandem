// @vitest-environment happy-dom

/**
 * Accepting a suggestion VERIFIES the target text first (#1629).
 *
 * The guard was on the wrong side. `undoResolveAnnotation` — the
 * non-destructive direction — re-reads the range and declines when it does not
 * hold what accept wrote. `applySuggestion` had no such check: it resolved a
 * range and called `deleteRange` on it unconditionally.
 *
 * Its one guard, `if (!resolved) return false`, is a required null check that
 * gates almost nothing on its own. `annotationToPmRange` does NOT fail when the
 * CRDT anchor dies — it warns and falls back to the stale flat offsets, and
 * `range` is required on `AnnotationBase` — so for any well-formed stored
 * annotation it returns non-null essentially always. That fallback is right for
 * RENDERING (the `buildDecorations` warn exists to make degradation visible
 * while still recovering) and wrong as the sole gate on a destructive mutation.
 *
 * The failure was silent: accept the suggestion after the target moved and it
 * delete-replaced whatever text now occupied those offsets, with no error and
 * no warning specific to the drift.
 *
 * The comparison itself is `snapshotContradicts`, shared with the `.docx` apply
 * guard and unit-tested in `tests/shared/snapshot-contradicts.test.ts`. What
 * these cases add is the behaviour around it — that a contradiction actually
 * stops the write, and that the document is left untouched when it does.
 *
 * These drive a LIVE Tiptap editor through the exported `applySuggestion`, for
 * the same reason `suggestion-literal-insert.test.ts` does: the hook's own
 * suite mocks the editor wholesale and cannot observe the document.
 */

import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { applySuggestion } from "../../src/client/panels/useAnnotationReview.svelte";
import { SNAPSHOT_CAP } from "../../src/shared/snapshot";
import type { Annotation } from "../../src/shared/types";

function suggestion(
  from: number,
  to: number,
  suggestedText: string,
  extras: Partial<Annotation> = {},
): Annotation {
  return {
    id: "a1",
    type: "comment",
    author: "claude",
    status: "pending",
    content: "why",
    suggestedText,
    timestamp: 0,
    range: { from, to },
    ...extras,
  } as Annotation;
}

/** Plain text of the whole document, in the same projection the guard uses. */
function docText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", "\n");
}

describe("#1629: accept verifies the target text before mutating", () => {
  let ydoc: Y.Doc;
  let editor: Editor;

  beforeEach(() => {
    ydoc = new Y.Doc();
    editor = new Editor({
      extensions: buildSchemaExtensions(),
      content: "<p>hello world</p>",
    });
  });
  afterEach(() => {
    editor.destroy();
    ydoc.destroy();
  });

  it("accepts when the target still reads as the snapshot (positive control)", () => {
    // Without this, every decline below could be passing because the guard
    // refuses everything.
    const ann = suggestion(0, 11, "goodbye world", { textSnapshot: "hello world" });
    expect(applySuggestion(ann, editor, ydoc)).toBe(true);
    expect(docText(editor)).toBe("goodbye world");
  });

  it("declines, and leaves the document untouched, when the target text changed", () => {
    // The whole defect. The annotation was written against "hello world"; the
    // document now says something else at those offsets. Before the fix this
    // returned true and overwrote the unrelated text.
    editor.commands.setContent("<p>totally other</p>");
    const before = docText(editor);

    const ann = suggestion(0, 11, "goodbye world", { textSnapshot: "hello world" });

    expect(applySuggestion(ann, editor, ydoc)).toBe(false);
    expect(docText(editor)).toBe(before);
  });

  it("declines when the range drifted onto neighbouring text of the same length", () => {
    // The nastiest shape: the offsets still resolve, still sit inside a
    // paragraph, and still span exactly as many characters — so nothing about
    // the RANGE looks wrong. Only the text says otherwise.
    editor.commands.setContent("<p>xxxxxxxxxxx and more</p>");
    const before = docText(editor);

    const ann = suggestion(0, 11, "goodbye world", { textSnapshot: "hello world" });

    expect(applySuggestion(ann, editor, ydoc)).toBe(false);
    expect(docText(editor)).toBe(before);
  });

  it("still applies when the annotation carries no snapshot to verify against", () => {
    // Documented limitation, pinned so it is a decision rather than an
    // oversight: with no `textSnapshot` there is nothing to compare, and
    // refusing every such annotation would break legacy records and any
    // suggestion written without one. Absent snapshot ⇒ prior behaviour.
    const ann = suggestion(0, 11, "goodbye world");
    expect(applySuggestion(ann, editor, ydoc)).toBe(true);
    expect(docText(editor)).toBe("goodbye world");
  });

  describe("truncated snapshots (#1486 interaction)", () => {
    // A capped snapshot is a real, contiguous PREFIX of the target, so the
    // guard has to match on the prefix. Comparing the full range against a
    // 200-character snapshot would decline every long suggestion — turning a
    // silent-overwrite bug into a can't-accept-anything bug.
    const long = `${"a".repeat(SNAPSHOT_CAP)} tail that was never captured`;

    beforeEach(() => {
      editor.commands.setContent(`<p>${long}</p>`);
    });

    it("accepts when the captured prefix still matches", () => {
      const ann = suggestion(0, long.length, "replacement", {
        textSnapshot: "a".repeat(SNAPSHOT_CAP),
        textSnapshotTruncated: true,
      });
      expect(applySuggestion(ann, editor, ydoc)).toBe(true);
      expect(docText(editor)).toBe("replacement");
    });

    it("declines when the captured prefix changed", () => {
      editor.commands.setContent(`<p>${"b".repeat(SNAPSHOT_CAP)} tail</p>`);
      const before = docText(editor);

      const ann = suggestion(0, long.length, "replacement", {
        textSnapshot: "a".repeat(SNAPSHOT_CAP),
        textSnapshotTruncated: true,
      });

      expect(applySuggestion(ann, editor, ydoc)).toBe(false);
      expect(docText(editor)).toBe(before);
    });
  });

  describe("shapes where the client and server projections disagree (#1631)", () => {
    // These are POSITIVE controls on documents nobody edited. The guard's first
    // implementation compared `textBetween(from, to, "\n", "\n")` against a
    // server-captured snapshot; each shape below made every suggestion touching
    // it permanently unacceptable, with a toast blaming the user for an edit
    // that never happened.
    //
    // The general form of this is `flat-projection-equivalence.test.ts`. These
    // stay because they pin the guard's BEHAVIOUR — a projection can be right
    // and still be wired into the guard wrongly.

    it("accepts across a heading prefix the flat text contains and PM does not", () => {
      // `validateRange` checks heading prefixes only at the two ENDPOINTS
      // (`positions.ts`), so a range legally runs from one block through the
      // next block's "## " — which `tandem_suggest` will happily create.
      const editor = new Editor({
        extensions: buildSchemaExtensions(),
        content: "<p>alpha beta</p><h2>Title Here</h2>",
      });
      const ydoc = new Y.Doc();
      const ann = suggestion(6, 19, "replaced", { textSnapshot: "beta\n## Title" });

      expect(applySuggestion(ann, editor, ydoc)).toBe(true);
      editor.destroy();
      ydoc.destroy();
    });

    it("accepts a heading whose hard break is a SPACE in flat text", () => {
      // `flattenHeadingText` is a 1:1 substitution, so the offsets match and
      // only the character differs — invisible to every length-based check.
      const editor = new Editor({
        extensions: buildSchemaExtensions(),
        content: "<h2>one<br>two</h2>",
      });
      const ydoc = new Y.Doc();
      const ann = suggestion(3, 10, "merged", { textSnapshot: "one two" });

      expect(applySuggestion(ann, editor, ydoc)).toBe(true);
      editor.destroy();
      ydoc.destroy();
    });

    it("accepts across a block leaf, which contributes no flat characters", () => {
      const editor = new Editor({
        extensions: buildSchemaExtensions(),
        content: "<p>alpha</p><hr><p>beta</p>",
      });
      const ydoc = new Y.Doc();
      const ann = suggestion(0, 11, "replaced", { textSnapshot: "alpha\n\nbeta" });

      expect(applySuggestion(ann, editor, ydoc)).toBe(true);
      editor.destroy();
      ydoc.destroy();
    });

    it("still DECLINES a real drift on one of those shapes", () => {
      // Without this the three cases above could pass because the guard stopped
      // checking anything on multi-block ranges.
      const editor = new Editor({
        extensions: buildSchemaExtensions(),
        content: "<p>alpha beta</p><h2>Different</h2>",
      });
      const ydoc = new Y.Doc();
      const ann = suggestion(6, 19, "replaced", { textSnapshot: "beta\n## Title" });

      expect(applySuggestion(ann, editor, ydoc)).toBe(false);
      editor.destroy();
      ydoc.destroy();
    });
  });

  it("compares in the server's projection, so a hard break is not read as drift", () => {
    // `textSnapshot` spells a hard break "\n" (the `extractText` convention).
    // A guard built on a bare `textBetween(from, to)` — no separators — reads
    // that break as a missing character and declines a suggestion whose target
    // never changed. This is the arm that catches it: revert `rangeText`'s
    // separators and this goes red while the plain-paragraph cases stay green.
    editor.commands.setContent("<p>one<br>two</p>");
    const ann = suggestion(0, 7, "merged", { textSnapshot: "one\ntwo" });

    expect(applySuggestion(ann, editor, ydoc)).toBe(true);
    expect(docText(editor)).toBe("merged");
  });
});
