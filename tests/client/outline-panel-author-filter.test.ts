// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import OutlinePanel from "../../src/client/components/OutlinePanel.svelte";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types";

/**
 * The outline's per-heading annotation counts respect the author filter, and a
 * promoted import counts as an import (#1714).
 *
 * This branch had no coverage at all before — not for promoted records and not
 * for the filter generally — so reverting it to the raw `author` left the whole
 * suite green. It is inert in the shipped app today (`App.svelte`'s outline
 * `PanelSlot` passes neither `annotations` nor the filters, and nothing
 * supplies `onFilterChange`), which is precisely why a spec is worth having:
 * whoever wires it up will not think to re-derive whether the outline and the
 * rail select the same set.
 */

const live: Editor[] = [];
afterEach(() => {
  for (const e of live.splice(0)) e.destroy();
});

function editorWithHeading() {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, "# Intro\n\nSome body text under the heading.\n");
  const editor = new Editor({
    extensions: [...buildSchemaExtensions(), Collaboration.configure({ document: ydoc })],
  });
  live.push(editor);
  return editor;
}

function annotation(id: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    type: "comment",
    author: "user",
    status: "pending",
    content: "body",
    // Inside the "Intro" section — the document has exactly one heading, so
    // every valid offset buckets into it.
    range: { from: toFlatOffset(10), to: toFlatOffset(14) },
    timestamp: 0,
    ...over,
  } as Annotation;
}

function countBadge(container: HTMLElement): string | null {
  const button = container.querySelector<HTMLElement>("[data-testid='outline-heading-1-0']");
  expect(button, "expected the Intro heading row").not.toBeNull();
  // The count pill is the only descendant carrying a `title` of the form
  // "N annotation(s)"; it is absent entirely when the count is zero.
  return (
    button
      ?.querySelector<HTMLElement>("[title$='annotation'],[title$='annotations']")
      ?.textContent?.trim() ?? null
  );
}

function renderOutline(activeFilterAuthor: "all" | "user" | "import", annotations: Annotation[]) {
  return render(OutlinePanel, {
    props: {
      editor: editorWithHeading(),
      headings: [{ level: 1, text: "Intro", pos: 0 }],
      annotations,
      activeFilterAuthor,
    },
  });
}

describe("OutlinePanel author filter counts a promoted import as an import (#1714)", () => {
  const promoted = annotation("ann-promoted", {
    importSource: { author: "Dana Reviewer", file: "/draft.docx" },
  });
  const plain = annotation("ann-plain");

  it("counts both under the 'all' filter", () => {
    // The anchor. Without it a broken position lookup — which silently drops
    // annotations via the `catch` in `headingAnnotationCounts` — would make
    // every filtered assertion below pass for the wrong reason.
    const { container } = renderOutline("all", [promoted, plain]);
    expect(countBadge(container)).toBe("2");
  });

  it("counts only the promoted import under the 'import' filter", () => {
    const { container } = renderOutline("import", [promoted, plain]);
    expect(countBadge(container)).toBe("1");
  });

  it("counts only the ordinary comment under the 'user' filter", () => {
    // The negative control, and the half that pins the accessor rather than a
    // hard-coded answer: keyed on the raw `author` both records are "user" and
    // this reads 2.
    const { container } = renderOutline("user", [promoted, plain]);
    expect(countBadge(container)).toBe("1");
  });
});
