import { describe, expect, it } from "vitest";
import { TUTORIAL_ANNOTATION_PREFIX } from "../../src/shared/constants.js";
import type { Annotation } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

/**
 * Inline implementation of the step-1 user-action detection — mirrors
 * useTutorial.svelte.ts so we can test the predicate without a Svelte
 * rune environment.
 *
 * The filter is the regression-vector PR-A2b fixed: after PR-A2 made
 * the tutorial note author='user' (correct per ADR-027), step 1
 * auto-advanced on tutorial load instead of waiting for a real user
 * annotation. Excluding tutorial-prefixed IDs from this check restores
 * the gate.
 */
function hasUserAnnotation(annotations: Annotation[]): boolean {
  return annotations.some(
    (a) => a.author === "user" && !a.id.startsWith(TUTORIAL_ANNOTATION_PREFIX),
  );
}

describe("useTutorial step-1 user-action detection", () => {
  it("tutorial-seeded user note does NOT count as user action", () => {
    const seed = makeAnnotation({
      id: `${TUTORIAL_ANNOTATION_PREFIX}note-1`,
      author: "user",
      type: "note",
    });
    expect(hasUserAnnotation([seed])).toBe(false);
  });

  it("real user annotation counts", () => {
    const real = makeAnnotation({
      id: "user-created-note-1",
      author: "user",
      type: "note",
    });
    expect(hasUserAnnotation([real])).toBe(true);
  });

  it("claude-authored tutorial annotations are ignored regardless of prefix", () => {
    const tutorialHighlight = makeAnnotation({
      id: `${TUTORIAL_ANNOTATION_PREFIX}highlight-1`,
      author: "claude",
      type: "highlight",
    });
    expect(hasUserAnnotation([tutorialHighlight])).toBe(false);
  });

  it("mixed list with one real user annotation returns true", () => {
    const seed = makeAnnotation({
      id: `${TUTORIAL_ANNOTATION_PREFIX}note-1`,
      author: "user",
    });
    const real = makeAnnotation({ id: "real-1", author: "user" });
    expect(hasUserAnnotation([seed, real])).toBe(true);
  });

  it("empty list returns false", () => {
    expect(hasUserAnnotation([])).toBe(false);
  });
});
