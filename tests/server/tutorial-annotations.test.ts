/**
 * Anchor-drift regression test for tutorial annotations.
 *
 * Guards against the silent-failure mode documented in
 * `feedback_tutorial_anchors_drift_silently`: when `sample/welcome.md` copy
 * changes, `injectTutorialAnnotations` falls back to a stderr log and skips
 * the annotation without any test failure. This test asserts:
 *
 *   1. Count: every TUTORIAL_ANNOTATION definition produces an entry.
 *   2. Range correctness: each injected range slices to the configured targetText.
 *   3. Uniqueness: each targetText appears exactly once in the snapshot, so
 *      `indexOf` cannot drift to a second occurrence on a future copy edit.
 *
 * The test pins to a committed fixture (`tests/fixtures/welcome-snapshot.md`)
 * rather than the live `sample/welcome.md` so concurrent worktree edits cannot
 * influence the result.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { extractText } from "../../src/server/mcp/document-model.js";
import {
  injectTutorialAnnotations,
  TUTORIAL_ANNOTATIONS,
} from "../../src/server/mcp/tutorial-annotations.js";
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap, makeMarkdownDoc } from "../helpers/ydoc-factory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "welcome-snapshot.md");

// Derived from the production definitions so a `targetText` VALUE edit (not
// just an add/remove) is caught — a hand-mirrored list would silently validate
// stale strings.
const EXPECTED_TARGETS = TUTORIAL_ANNOTATIONS.map((d) => d.targetText);

describe("tutorial-annotations anchor drift", () => {
  it("injects every defined annotation against the welcome.md snapshot", () => {
    const markdown = readFileSync(FIXTURE_PATH, "utf8");
    const doc = makeMarkdownDoc(markdown);
    try {
      injectTutorialAnnotations(doc);

      const injected = Array.from(getAnnotationsMap(doc).values()) as Annotation[];

      // Assertion 1: every defined annotation injects (count pinned to the
      // production list directly).
      expect(injected.length).toBe(TUTORIAL_ANNOTATIONS.length);

      const fullText = extractText(doc);

      for (const target of EXPECTED_TARGETS) {
        // Assertion 3: uniqueness guard. `indexOf` returns the FIRST match;
        // if a future copy edit introduces a second occurrence the anchor
        // can silently land on the wrong instance.
        expect(
          fullText.indexOf(target),
          `targetText "${target}" should appear at least once in fixture`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          fullText.indexOf(target),
          `targetText "${target}" must be unique in fixture (drift hazard)`,
        ).toBe(fullText.lastIndexOf(target));

        // Assertion 2: range correctness — find the matching injected
        // annotation and verify its range slices back to the targetText.
        const ann = injected.find((a) => a.textSnapshot === target);
        expect(ann, `no injected annotation for "${target}"`).toBeDefined();
        if (!ann) continue;
        const slice = fullText.slice(ann.range.from, ann.range.to);
        expect(slice).toBe(target);
      }
    } finally {
      doc.destroy();
    }
  });

  it("live sample/welcome.md stays anchor-equivalent to the snapshot fixture", () => {
    // The snapshot fixture is what the assertions above pin to (for worktree
    // isolation). This guard closes the gap that lets the LIVE welcome.md drift
    // away from the snapshot — and thus break real injection — without any test
    // failure. We compare the FLAT-TEXT projection (extractText: heading prefixes
    // + `\n` joins), the coordinate system `injectTutorialAnnotations` actually
    // resolves against — NOT raw markdown bytes (the parser collapses trailing
    // newline / CRLF / list-marker cosmetics, so a byte diff would be both too
    // strict and, for offset-shifting changes, beside the point).
    const LIVE_PATH = path.join(__dirname, "..", "..", "sample", "welcome.md");
    const liveDoc = makeMarkdownDoc(readFileSync(LIVE_PATH, "utf8"));
    const snapDoc = makeMarkdownDoc(readFileSync(FIXTURE_PATH, "utf8"));
    try {
      const liveFlat = extractText(liveDoc);
      const snapFlat = extractText(snapDoc);
      expect(
        liveFlat,
        "welcome-snapshot.md is stale — regenerate it from sample/welcome.md " +
          "(tutorial anchors validate against the snapshot; live drift breaks injection silently).",
      ).toBe(snapFlat);

      // The load-bearing invariant, asserted against the LIVE file directly:
      // every tutorial target still resolves, exactly once.
      for (const target of EXPECTED_TARGETS) {
        expect(
          liveFlat.indexOf(target),
          `target "${target}" missing from live welcome.md`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          liveFlat.indexOf(target),
          `target "${target}" not unique in live welcome.md (drift hazard)`,
        ).toBe(liveFlat.lastIndexOf(target));
      }
    } finally {
      liveDoc.destroy();
      snapDoc.destroy();
    }
  });
});
