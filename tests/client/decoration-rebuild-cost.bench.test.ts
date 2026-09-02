// @vitest-environment happy-dom

import { writeFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import {
  AnnotationExtension,
  annotationPluginKey,
} from "../../src/client/editor/extensions/annotation";
import { loadMarkdown } from "../../src/server/file-io/markdown";
import { extractText } from "../../src/server/mcp/document-model";
import { anchoredRange } from "../../src/server/positions";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants";

/**
 * What one remote keystroke costs with N annotations painted (#1669).
 *
 * NOT a gate, and deliberately asserts nothing about the timings — a wall-clock
 * threshold on a shared CI box is a flake generator, and #1734 is what a
 * permanently-red perf gate costs. It exists so the numbers can be RE-DERIVED
 * on demand (`BENCH_OUT=<path> npx vitest run <this file>`), which is what keeps
 * the table quoted in `annotation.ts` and `docs/gotchas.md` from becoming a
 * measurement that outlives the design it measured. What it does assert is that
 * all three fixtures actually built — a benchmark that silently anchors zero
 * annotations reports a number for the wrong thing.
 *
 * The measurement exists because the rebuild's justification was wrong: an earlier
 * draft of the branch's comment justified the rebuild as "affordable because
 * `_typeChanged` is already re-serializing the whole fragment on the same
 * transaction", and that is false — `createNodeIfNotExists`
 * (y-prosemirror/src/plugins/sync-plugin.js) returns the CACHED ProseMirror node
 * for every top-level child whose Y type was not in `transaction.changed`, so
 * the baseline is the changed subtree plus a whole-document ReplaceStep, not a
 * whole-document re-serialization.
 *
 * The rebuild is therefore genuinely additional work, O(annotations) index-
 * parallel Y/PM walks, and the only honest way to decide whether it belongs on
 * the synchronous path is to run it.
 */

const live: Editor[] = [];

afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
});

function paragraphs(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `Paragraph ${i} carries some annotated words here.`,
  ).join("\n\n");
}

describe("#1669 y-sync rebuild cost", () => {
  it("reports the per-remote-transaction cost at 0, 50 and 150 annotations", () => {
    const rows: string[] = [];

    for (const count of [0, 50, 150]) {
      const ydoc = new Y.Doc();
      loadMarkdown(ydoc, `${paragraphs(200)}\n`);
      const editor = new Editor({
        extensions: [
          ...buildSchemaExtensions(),
          Collaboration.configure({ document: ydoc }),
          AnnotationExtension.configure({ ydoc }),
        ],
      });
      live.push(editor);

      const text = extractText(ydoc);
      const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
      let placed = 0;
      for (let i = 0; i < count; i++) {
        const needle = `Paragraph ${i}`;
        const at = text.indexOf(needle);
        if (at === -1) continue;
        const anchored = anchoredRange(ydoc, at as never, (at + needle.length) as never, needle);
        if (!anchored.ok) continue;
        map.set(`ann-${i}`, {
          id: `ann-${i}`,
          type: "highlight",
          status: "pending",
          content: "",
          author: "user",
          createdAt: Date.now(),
          range: anchored.range,
          relRange: anchored.relRange,
        });
        placed++;
      }
      expect(placed, `fixture: expected ${count} annotations to anchor`).toBe(count);
      editor.view.dispatch(editor.state.tr.setMeta(annotationPluginKey, true));

      // The remote keystrokes. Each one is a real `_typeChanged` whole-document
      // replacement carrying `ySyncPluginKey`, which is what the branch fires on.
      const fragment = ydoc.getXmlFragment("default");
      const KEYSTROKES = 20;
      const start = performance.now();
      for (let k = 0; k < KEYSTROKES; k++) {
        ydoc.transact(() => {
          const last = fragment.get(fragment.length - 1) as Y.XmlElement;
          (last.get(0) as Y.XmlText).insert(0, "x");
        }, "remote-peer");
      }
      const perTx = (performance.now() - start) / KEYSTROKES;
      rows.push(
        `  ${String(count).padStart(3)} annotations: ${perTx.toFixed(2)}ms per remote transaction`,
      );
    }

    // Only when asked: a plain suite run must not drop a file in the working
    // tree. `BENCH_OUT=<path> npx vitest run tests/client/decoration-rebuild-cost.bench.test.ts`
    const out = process.env.BENCH_OUT;
    if (out) {
      writeFileSync(
        out,
        `#1669 y-sync rebuild cost (200-paragraph document)\n${rows.join("\n")}\n`,
      );
    }
    expect(rows).toHaveLength(3);
  });
});
