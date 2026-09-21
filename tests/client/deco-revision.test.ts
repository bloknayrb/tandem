import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import { shouldBumpDecoRevision } from "../../src/client/editor/deco-revision";
import { annotationPluginKey } from "../../src/client/editor/extensions/annotation";

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
