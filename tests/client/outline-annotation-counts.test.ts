// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import OutlinePanel from "../../src/client/components/OutlinePanel.svelte";
import PanelSlot from "../../src/client/components/PanelSlot.svelte";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { AnnotationExtension } from "../../src/client/editor/extensions/annotation";
import type { HeadingEntry } from "../../src/client/utils/headings";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { extractText } from "../../src/server/mcp/document-model";
import { type FlatOffset, toFlatOffset } from "../../src/shared/positions/types";
import { anchorFlatRange } from "../../src/shared/positions/ydoc";
import type { Annotation } from "../../src/shared/types";

/**
 * #2002 — the outline's per-heading annotation counts must resolve through the
 * CRDT-anchored `relRange`, not the stored flat `range.from`.
 *
 * Flat offsets are the SERVER's coordinate system and the stored range is only
 * as fresh as the server's last refresh, so after a local edit moves text and
 * before that refresh lands, an annotation buckets under the wrong heading.
 * Every other client consumer already goes through `annotationToPmRange`.
 *
 * The count is inert in the shipped app today (`App.svelte`'s outline
 * `PanelSlot` passes no `annotations`), which is the issue's own reason for
 * fixing it anyway: a wrong count is not something anyone would think to look
 * for.
 */

const FIXTURE = "## Alpha\n\nfirst body\n\n## Beta\n\nsecond body\n";

const live: Editor[] = [];
afterEach(() => {
  for (const e of live.splice(0)) e.destroy();
});

interface Fixture {
  ydoc: Y.Doc;
  editor: Editor;
}

function boundEditor(markdown: string): Fixture {
  const ydoc = new Y.Doc();
  loadMarkdown(ydoc, markdown);
  const editor = new Editor({
    extensions: [
      ...buildSchemaExtensions(),
      Collaboration.configure({ document: ydoc }),
      AnnotationExtension.configure({ ydoc }),
    ],
  });
  live.push(editor);
  return { ydoc, editor };
}

/**
 * Flat-offset range of `needle` in the SERVER's projection (`extractText`) —
 * the projection a stored `range` is expressed in.
 */
function rangeOf(ydoc: Y.Doc, needle: string): { from: FlatOffset; to: FlatOffset } {
  const text = extractText(ydoc);
  const at = text.indexOf(needle);
  if (at === -1) throw new Error(`fixture does not contain ${JSON.stringify(needle)}`);
  return { from: toFlatOffset(at), to: toFlatOffset(at + needle.length) };
}

/** Rebuild the heading outline the way `createHeadings` does. */
function headingsOf(editor: Editor): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name !== "heading") return;
    if (node.attrs.level <= 3) {
      out.push({ text: node.textContent, level: node.attrs.level as number, pos: offset });
    }
  });
  return out;
}

/**
 * The count pill's text for one outline row, or `null` when it is absent.
 *
 * The pill renders only under `{#if count > 0}` and carries no testid, so it is
 * found by its `title` of the form "N annotation(s)" — the same helper shape as
 * `outline-panel-author-filter.test.ts`.
 */
function countBadge(container: HTMLElement, testid: string): string | null {
  const button = container.querySelector<HTMLElement>(`[data-testid='${testid}']`);
  expect(button, `expected the outline row ${testid}`).not.toBeNull();
  return (
    button
      ?.querySelector<HTMLElement>("[title$='annotation'],[title$='annotations']")
      ?.textContent?.trim() ?? null
  );
}

const ALPHA_ROW = "outline-heading-2-0";
const BETA_ROW = "outline-heading-2-1";

function annotationOn(ydoc: Y.Doc, needle: string, over: Partial<Annotation> = {}): Annotation {
  const range = rangeOf(ydoc, needle);
  const relRange = anchorFlatRange(ydoc, range.from, range.to);
  return {
    id: `ann-${needle.replace(/\s+/g, "-")}`,
    type: "comment",
    author: "claude",
    status: "pending",
    content: "body",
    range,
    ...(relRange ? { relRange } : {}),
    timestamp: 0,
    ...over,
  } as Annotation;
}

describe("OutlinePanel heading counts resolve through relRange (#2002)", () => {
  it("buckets an annotation under the heading it sits beneath", () => {
    const { ydoc, editor } = boundEditor(FIXTURE);
    const ann = annotationOn(ydoc, "second body");
    const { container } = render(OutlinePanel, {
      props: { editor, headings: headingsOf(editor), annotations: [ann], ydoc },
    });
    expect(countBadge(container, ALPHA_ROW)).toBeNull();
    expect(countBadge(container, BETA_ROW)).toBe("1");
  });

  it("follows the text through a local edit the server has not refreshed", () => {
    const { ydoc, editor } = boundEditor(FIXTURE);
    const ann = annotationOn(ydoc, "second body");
    // Rendered through PanelSlot, not OutlinePanel: the slot hop is the other
    // half of the fix and it cannot fail closed at the type level, because
    // PanelSlot's prop union carries a catch-all `[key: string]: any` member.
    const slot = render(PanelSlot, {
      props: {
        kind: "outline" as const,
        editor,
        headings: headingsOf(editor),
        annotations: [ann],
        ydoc,
      },
    });

    // Insert into the ALPHA body, leaving `ann.range` at its pre-edit values —
    // the "server has not refreshed yet" state. The length is arithmetic, not
    // taste: flat text is `## Alpha\nfirst body\n## Beta\nsecond body`, so the
    // Beta heading's flat start is 20 and `second body` starts at 28.
    // `flatOffsetToPmPos` maps any offset INSIDE a heading block — `"## "`
    // prefix included — to that heading's `pos + 1`, which still satisfies
    // `p >= h.pos` for the Beta bucket, so for any insert of 8 characters or
    // fewer the stale offset reads correctly on master too.
    const betaStart = extractText(ydoc).indexOf("## Beta");
    const secondBodyStart = rangeOf(ydoc, "second body").from;
    const shift = secondBodyStart - betaStart + 30;
    const alphaBody = editor.state.doc.resolve(1).after();
    editor.commands.insertContentAt(alphaBody + 2, "x".repeat(shift));
    expect(shift).toBeGreaterThan(30);

    // Re-render with a REBUILT headings array. `headingAnnotationCounts` is a
    // `$derived.by` whose tracked inputs are the props; it reads
    // `ed.state.doc` imperatively and a Tiptap transaction is invisible to
    // Svelte's dependency graph, so re-rendering with the same `headings`
    // reference recomputes nothing and reads the pre-edit numbers on fixed and
    // unfixed code alike.
    slot.rerender({
      kind: "outline" as const,
      editor,
      headings: headingsOf(editor),
      annotations: [ann],
      ydoc,
    });

    // The fix: still Beta. The control on master is Alpha "1", Beta none —
    // asserting both ends means a stale derived cannot look like a pass.
    expect(countBadge(slot.container, ALPHA_ROW)).toBeNull();
    expect(countBadge(slot.container, BETA_ROW)).toBe("1");
  });

  it("still counts a flat-only annotation (no relRange)", () => {
    const { ydoc, editor } = boundEditor(FIXTURE);
    const ann = annotationOn(ydoc, "second body");
    delete (ann as { relRange?: unknown }).relRange;
    const { container } = render(OutlinePanel, {
      props: { editor, headings: headingsOf(editor), annotations: [ann], ydoc },
    });
    expect(countBadge(container, BETA_ROW)).toBe("1");
  });

  it("skips an annotation with neither relRange nor range, without throwing", () => {
    const { ydoc, editor } = boundEditor(FIXTURE);
    const good = annotationOn(ydoc, "second body");
    const broken = annotationOn(ydoc, "first body", { id: "ann-broken" });
    delete (broken as { relRange?: unknown }).relRange;
    delete (broken as { range?: unknown }).range;
    const { container } = render(OutlinePanel, {
      props: { editor, headings: headingsOf(editor), annotations: [good, broken], ydoc },
    });
    expect(countBadge(container, ALPHA_ROW)).toBeNull();
    expect(countBadge(container, BETA_ROW)).toBe("1");
  });
});
