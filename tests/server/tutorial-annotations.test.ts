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
import { injectTutorialAnnotations } from "../../src/server/mcp/tutorial-annotations.js";
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap, makeMarkdownDoc } from "../helpers/ydoc-factory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "welcome-snapshot.md");

// Mirror of TUTORIAL_ANNOTATIONS targetText values for explicit per-target
// assertions. Kept in sync with `src/server/mcp/tutorial-annotations.ts`.
// If this list drifts from the production module, the count assertion below
// will catch it.
const EXPECTED_TARGETS = [
  "highlight text and Claude sees it",
  "edit this document at the same time",
  "simplify onboarding",
  "accept or dismiss",
] as const;

describe("tutorial-annotations anchor drift", () => {
  it("injects every defined annotation against the welcome.md snapshot", () => {
    const markdown = readFileSync(FIXTURE_PATH, "utf8");
    const doc = makeMarkdownDoc(markdown);
    try {
      injectTutorialAnnotations(doc);

      const injected = Array.from(getAnnotationsMap(doc).values()) as Annotation[];

      // Assertion 1: count match — `injected.length === TUTORIAL_ANNOTATIONS.length`.
      // We use EXPECTED_TARGETS.length as a proxy; if the production module
      // gains/loses an annotation without updating this list, the test fails.
      expect(injected.length).toBe(EXPECTED_TARGETS.length);

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
});
