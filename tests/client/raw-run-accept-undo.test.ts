// @vitest-environment happy-dom

/**
 * Undo of an accept over a raw markdown run puts the run back RAW (#1823).
 *
 * Since `RawMarkdownMark` became `inclusive: false`, accepting a suggestion over
 * exactly `[^1]` writes plain text — right, it is new text. But Undo used to take
 * its marks from the ACCEPTED text (`marksAcrossRange` over it), which no longer
 * carries the raw mark, so the footnote came back plain and was saved escaped as
 * `\[^1\]`. Accept now records the replaced span's own marks and Undo restores
 * with those.
 *
 * Driven through the real hook against a live editor synced to a Y.Doc loaded by
 * the real markdown loader, so the restored run is checked where it matters: in
 * the Y.Doc delta and in the saved markdown.
 *
 * FIXTURE NOTE (as in `reply-suggestion-accept.test.ts`): the record carries no
 * `relRange`, so the range falls back to stored flat offsets; the suggestion is
 * exactly as long as the target so those offsets stay right after the accept.
 */

import { render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import type {
  UseAnnotationReviewParams,
  UseAnnotationReviewReturn,
} from "../../src/client/panels/useAnnotationReview.svelte";
import UseAnnotationReviewHarness from "../../src/client/svelte-harness/UseAnnotationReviewHarness.svelte";
import { saveMarkdown } from "../../src/server/file-io/markdown";
import { RAW_MARKDOWN_MARK, Y_MAP_ANNOTATIONS } from "../../src/shared/constants";
import type { Annotation } from "../../src/shared/types";
import { range } from "../helpers/positions";
import { makeMarkdownDoc } from "../helpers/ydoc-factory";

const live: Editor[] = [];
afterEach(() => {
  while (live.length > 0) live.pop()?.destroy();
});

function rawRuns(ydoc: Y.Doc): string[] {
  const para = ydoc.getXmlFragment("default").get(0) as Y.XmlElement;
  return (
    (para.get(0) as Y.XmlText).toDelta() as Array<{
      insert: string;
      attributes?: Record<string, unknown>;
    }>
  )
    .filter((d) => d.attributes?.[RAW_MARKDOWN_MARK] !== undefined)
    .map((d) => d.insert);
}

function setup(md: string, ann: Partial<Annotation>) {
  const ydoc = makeMarkdownDoc(md);
  const annotations = ydoc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
  annotations.set("a1", {
    id: "a1",
    type: "comment",
    author: "claude",
    status: "pending",
    content: "why",
    timestamp: 0,
    ...ann,
  } as Annotation);
  const editor = new Editor({
    extensions: [...buildSchemaExtensions(), Collaboration.configure({ document: ydoc })],
  });
  live.push(editor);
  let api: UseAnnotationReviewReturn | undefined;
  const params: UseAnnotationReviewParams = {
    getYdoc: () => ydoc,
    getEditor: () => editor,
    getAnnotations: () => [annotations.get("a1") as Annotation],
    onActiveAnnotationChange: () => {},
    getScrollBehavior: () => "auto" as ScrollBehavior,
  };
  render(UseAnnotationReviewHarness, {
    props: { params, onReady: (r: UseAnnotationReviewReturn) => (api = r) },
  });
  if (!api) throw new Error("useAnnotationReview did not report ready");
  return { ydoc, review: api };
}

describe("#1823: Undo restores a raw run as raw", () => {
  it("accept over exactly [^1] writes plain text; Undo brings the footnote back raw", () => {
    const { ydoc, review } = setup("see[^1] after\n\n[^1]: the note\n", {
      range: range(3, 7),
      textSnapshot: "[^1]",
      suggestedText: "WXYZ",
    });
    expect(rawRuns(ydoc)).toEqual(["[^1]"]);

    review.resolveAnnotation("a1", "accepted");
    expect(rawRuns(ydoc)).toEqual([]);
    expect(saveMarkdown(ydoc)).toContain("seeWXYZ after");

    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(rawRuns(ydoc)).toEqual(["[^1]"]);
    expect(saveMarkdown(ydoc)).toContain("see[^1] after");
  });

  it("an accept over plain text still undoes to plain text", () => {
    const { ydoc, review } = setup("see[^1] after\n\n[^1]: the note\n", {
      range: range(8, 13),
      textSnapshot: "after",
      suggestedText: "*x*yz",
    });
    review.resolveAnnotation("a1", "accepted");
    expect(review.undoResolveAnnotation("a1")).toBe(true);
    expect(rawRuns(ydoc)).toEqual(["[^1]"]);
    expect(saveMarkdown(ydoc)).toContain("see[^1] after");
  });
});
