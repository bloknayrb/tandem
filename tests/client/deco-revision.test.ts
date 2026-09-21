import type { Transaction } from "@tiptap/pm/state";
import { yCursorPluginKey, ySyncPluginKey } from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import { shouldBumpDecoRevision } from "../../src/client/editor/deco-revision";
import { annotationPluginKey } from "../../src/client/editor/extensions/annotation";
import { authorshipPluginKey } from "../../src/client/editor/extensions/authorship";
import { awarenessPluginKey } from "../../src/client/editor/extensions/awareness";

/**
 * #1963 — the gate on `Editor.svelte`'s decoration-rebuild counter.
 *
 * Transactions are hand-built plain objects (the shape
 * `annotation-decoration.test.ts` already uses); nothing here touches the DOM.
 */

function tr(docChanged: boolean, metas: Map<unknown, unknown> = new Map()): Transaction {
  return {
    docChanged,
    getMeta: (key: unknown) => metas.get(key),
  } as unknown as Transaction;
}

describe("shouldBumpDecoRevision", () => {
  it("bumps on an ordinary content change", () => {
    expect(shouldBumpDecoRevision(tr(true))).toBe(true);
  });

  it("bumps on the y-sync doc replacement with no docChanged (#1669)", () => {
    const metas = new Map<unknown, unknown>([[ySyncPluginKey, { isChangeOrigin: true }]]);
    expect(shouldBumpDecoRevision(tr(false, metas))).toBe(true);
  });

  it("bumps on the annotation plugin's own rebuild signal", () => {
    const metas = new Map<unknown, unknown>([[annotationPluginKey, true]]);
    expect(shouldBumpDecoRevision(tr(false, metas))).toBe(true);
  });

  // The three redraw signals that arrive AFTER the y-sync doc replacement and
  // strip `.tandem-annotation-active` again. None of them rebuilds annotation
  // decorations; each repaints the `[data-annotation-id]` span and rewrites the
  // merged `class` attribute, which is the half of #1963 that survived the
  // first fix. All three carry `docChanged: false` and none of the other metas,
  // so without their own terms here nothing re-applies the pulse and the user
  // still sees the highlight vanish on a remote write.
  it("bumps on the remote-caret redraw (yjs-cursor)", () => {
    const metas = new Map<unknown, unknown>([[yCursorPluginKey, { awarenessUpdated: true }]]);
    expect(shouldBumpDecoRevision(tr(false, metas))).toBe(true);
  });

  it("bumps on the Claude-awareness redraw", () => {
    const metas = new Map<unknown, unknown>([[awarenessPluginKey, true]]);
    expect(shouldBumpDecoRevision(tr(false, metas))).toBe(true);
  });

  it("bumps on the authorship plugin's rebuild dispatch", () => {
    const metas = new Map<unknown, unknown>([[authorshipPluginKey, { type: "rebuild" }]]);
    expect(shouldBumpDecoRevision(tr(false, metas))).toBe(true);
  });

  it("does NOT bump on a bare cursor move", () => {
    // The discriminating negative: without it, `return true` passes every
    // positive case above and the cursor-move churn the gate suppresses is back.
    expect(shouldBumpDecoRevision(tr(false))).toBe(false);
  });

  it("bumps on the object-shaped annotation meta, not just `true`", () => {
    // `AnnotationToggleMeta | true | undefined` — `App.svelte` dispatches the
    // object form, so `=== true` would drop every decoration-visibility toggle
    // and silently reinstate the missing pulse.
    const metas = new Map<unknown, unknown>([
      [
        annotationPluginKey,
        { type: "toggle-decorations", visible: { comment: true, highlight: false, note: true } },
      ],
    ]);
    expect(shouldBumpDecoRevision(tr(false, metas))).toBe(true);
  });
});
