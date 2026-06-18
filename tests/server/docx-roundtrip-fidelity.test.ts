/**
 * .docx round-trip fidelity scoreboard (Phase 0d).
 *
 * Drives a single-concern corpus through the REAL import→export→reimport cycle
 * (`runRoundTrip`) and asserts each feature's CURRENT fidelity via a capability
 * manifest. The manifest IS the assertion driver — each entry's `check` is a
 * POSITIVE assertion of the present shape (not a snapshot), so:
 *   - a `survives` feature regressing fails RED, and
 *   - a `degrades`/`breaks` feature being FIXED also fails RED (the check pins
 *     the current loss), forcing a contributor to promote the entry. Losses
 *     can't silently regress and improvements can't go unnoticed.
 *
 * Stability (`gen1.tree` deep-equals `gen2.tree`) is the "survives" signal and
 * is asserted only where the feature actually round-trips; degrade/break
 * fixtures diverge by design, so their checks assert the specific divergence.
 *
 * Empirical baseline (this corpus, established when the harness was written):
 * the import is the fidelity ceiling; the export is faithful to whatever
 * reached the model. See `.claude/plans/docx-roundtrip-0d-harness.md`.
 */

import { describe, expect, it } from "vitest";
import * as corpus from "../helpers/docx-corpus.js";
import {
  hasNode,
  marksIn,
  nodesOfType,
  type RoundTrip,
  runRoundTrip,
} from "../helpers/docx-fidelity-harness.js";

type Status = "survives" | "degrades" | "breaks";

interface Fixture {
  name: string;
  build: () => Promise<Buffer>;
  status: Status;
  reason: string;
  check: (rt: RoundTrip) => void;
}

/** The round-trip is a fixed point — the "survives" signal. */
const expectStable = (rt: RoundTrip): void => {
  expect(rt.gen1.tree).toEqual(rt.gen2.tree);
};

const CORPUS: Fixture[] = [
  {
    name: "headings",
    build: corpus.buildHeadings,
    status: "survives",
    reason: "canonical Heading1-3 styles round-trip as heading nodes with levels",
    check(rt) {
      expectStable(rt);
      expect(nodesOfType(rt.gen1, "heading").map((h) => h.attrs.level)).toEqual([1, 2, 3]);
    },
  },
  {
    name: "text marks",
    build: corpus.buildMarks,
    status: "degrades",
    reason: "bold/italic/strike/sup/sub survive; underline is dropped (mammoth omits <u>)",
    check(rt) {
      expectStable(rt);
      const marks = marksIn(rt.gen1);
      for (const mark of ["bold", "italic", "strike", "superscript", "subscript"]) {
        expect(marks.has(mark), `expected mark ${mark}`).toBe(true);
      }
      // CURRENT LOSS — underline dropped at the mammoth layer. When mammoth is
      // wired to emit <u> (Tier-A), this flips → promote this fixture to survives.
      expect(marks.has("underline")).toBe(false);
    },
  },
  {
    name: "external link",
    build: corpus.buildLink,
    status: "survives",
    reason: "https links round-trip as the link mark",
    check(rt) {
      expectStable(rt);
      expect(marksIn(rt.gen1).has("link")).toBe(true);
    },
  },
  {
    name: "bullet list",
    build: corpus.buildBulletList,
    status: "survives",
    reason: "bullet lists round-trip as bulletList > listItem > paragraph",
    check(rt) {
      expectStable(rt);
      expect(hasNode(rt.gen1, "bulletList")).toBe(true);
    },
  },
  {
    name: "nested list",
    build: corpus.buildNestedList,
    status: "survives",
    reason: "nesting depth is preserved (a sublist nests inside its parent listItem)",
    check(rt) {
      expectStable(rt);
      // Pin actual nesting (a bulletList under a bulletList), not merely two
      // lists — two sibling top-level lists would also count 2.
      expect(rt.gen1.tree.some((n) => n.path.filter((p) => p === "bulletList").length === 2)).toBe(
        true,
      );
    },
  },
  {
    name: "ordered list",
    build: corpus.buildOrderedList,
    status: "survives",
    reason: "ordered lists round-trip as orderedList",
    check(rt) {
      expectStable(rt);
      expect(hasNode(rt.gen1, "orderedList")).toBe(true);
    },
  },
  {
    name: "simple table",
    build: corpus.buildSimpleTable,
    status: "survives",
    reason: "a 2x2 table round-trips with all four cells",
    check(rt) {
      expectStable(rt);
      expect(hasNode(rt.gen1, "table")).toBe(true);
      expect(nodesOfType(rt.gen1, "tableCell").length).toBe(4);
    },
  },
  {
    name: "merged-cell table",
    build: corpus.buildMergedTable,
    status: "survives",
    reason: "colspan round-trips — the exporter now emits columnSpan from the cell's colspan attr",
    check(rt) {
      // Import preserved the merge…
      expect(nodesOfType(rt.gen1, "tableCell").some((c) => Number(c.attrs.colspan) === 2)).toBe(
        true,
      );
      // …and export now carries it through: gen2 keeps the colspan. (rowspan is
      // not yet carried — a separate vertical-merge change.)
      expect(nodesOfType(rt.gen2, "tableCell").some((c) => Number(c.attrs.colspan) === 2)).toBe(
        true,
      );
    },
  },
  {
    name: "footnote",
    build: corpus.buildFootnote,
    status: "degrades",
    reason:
      "mammoth renders footnotes as a trailing ordered list — content kept, footnote semantic + anchor links lost",
    check(rt) {
      expect(rt.gen1.flatText).toContain("The footnote body text.");
      expect(nodesOfType(rt.gen1, "orderedList").length).toBeGreaterThan(0);
      // inline ref survives as a superscript run
      expect(marksIn(rt.gen1).has("superscript")).toBe(true);
    },
  },
  {
    name: "header / footer",
    build: corpus.buildHeaderFooter,
    status: "breaks",
    reason:
      "mammoth does not extract headers/footers — recoverable only via preserve-the-package (Tier-B)",
    check(rt) {
      expectStable(rt);
      // CURRENT LOSS — header/footer text never reaches the model. When Tier-B
      // recovers them, this flips → promote.
      expect(rt.gen1.flatText).not.toContain("Running header text");
      expect(rt.gen1.flatText).not.toContain("Running footer text");
    },
  },
  {
    name: "embedded image",
    build: corpus.buildEmbeddedImage,
    status: "breaks",
    reason: "mammoth wraps images in <p>; htmlToYDoc drops inline images (no top-level <img>)",
    check(rt) {
      // CURRENT LOSS — no image node survives the import.
      expect(hasNode(rt.gen1, "image")).toBe(false);
    },
  },
  {
    name: "custom-style heading",
    build: corpus.buildCustomStyleHeading,
    status: "degrades",
    reason:
      "a custom (non-canonical) paragraph style isn't recognized — text kept, heading semantic lost",
    check(rt) {
      expectStable(rt);
      expect(rt.importWarnings.length).toBeGreaterThan(0);
      expect(rt.gen1.flatText).toContain("A heading via a corporate style");
      // CURRENT LOSS — degrades to a plain paragraph, no heading node.
      expect(hasNode(rt.gen1, "heading")).toBe(false);
    },
  },
  {
    name: "Word comment",
    build: corpus.buildComment,
    status: "survives",
    reason:
      "imported Word comments round-trip back to the file as private notes (writeback) — Claude-invisible, but not dropped on save",
    check(rt) {
      // Body text is stable — comment range markers aren't body content.
      expectStable(rt);
      // Import preserved the comment as a private import-authored note...
      expect(rt.gen1.annotations).toHaveLength(1);
      expect(rt.gen1.annotations[0].author).toBe("import");
      expect(rt.gen1.annotations[0].anchorText).toBe("anchored text");
      // ...and the writeback gate now round-trips it: gen2 keeps the import,
      // anchored to the same text. (It stays a private note — ADR-027 governs
      // Claude visibility, not the .docx file round-trip.)
      expect(rt.gen2.annotations).toHaveLength(1);
      expect(rt.gen2.annotations[0].author).toBe("import");
      expect(rt.gen2.annotations[0].anchorText).toBe("anchored text");
    },
  },
  {
    name: "tracked changes",
    build: corpus.buildTrackedChange,
    status: "breaks",
    reason: "mammoth accepts <w:ins> as body text and drops <w:del> + all revision metadata",
    check(rt) {
      expectStable(rt);
      expect(rt.gen1.flatText).toContain("added"); // insertion accepted as plain text
      expect(rt.gen1.flatText).not.toContain("removed"); // deletion gone
    },
  },
];

describe("docx round-trip fidelity scoreboard (0d)", () => {
  for (const fixture of CORPUS) {
    it(`[${fixture.status}] ${fixture.name} — ${fixture.reason}`, async () => {
      const rt = await runRoundTrip(await fixture.build());
      fixture.check(rt);
    });
  }
});
