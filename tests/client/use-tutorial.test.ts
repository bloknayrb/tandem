import { describe, expect, it } from "vitest";
import { isNonTutorialUserAnnotation } from "../../src/client/hooks/useTutorial.svelte.js";
import { TUTORIAL_ANNOTATION_PREFIX } from "../../src/shared/constants.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

/**
 * Tests the step-1 user-action predicate exported from useTutorial.svelte.ts.
 *
 * The filter is the regression-vector PR-A2b fixed: after PR-A2 made the
 * tutorial note `author='user'` (correct per ADR-027), step 1 auto-advanced
 * on tutorial load instead of waiting for a real user annotation. Excluding
 * tutorial-prefixed IDs from this check restores the gate.
 *
 * Importing the production predicate directly (instead of mirroring it
 * inline) ensures a revert of `isNonTutorialUserAnnotation` would fail
 * this test, not silently pass.
 */
describe("isNonTutorialUserAnnotation (step-1 user-action predicate)", () => {
  it("tutorial-seeded user note does NOT count", () => {
    const seed = makeAnnotation({
      id: `${TUTORIAL_ANNOTATION_PREFIX}note-1`,
      author: "user",
      type: "note",
    });
    expect(isNonTutorialUserAnnotation(seed)).toBe(false);
  });

  it("real user annotation counts", () => {
    const real = makeAnnotation({
      id: "user-created-note-1",
      author: "user",
      type: "note",
    });
    expect(isNonTutorialUserAnnotation(real)).toBe(true);
  });

  it("claude-authored tutorial annotation does NOT count", () => {
    const tutorialHighlight = makeAnnotation({
      id: `${TUTORIAL_ANNOTATION_PREFIX}highlight-1`,
      author: "claude",
      type: "highlight",
    });
    expect(isNonTutorialUserAnnotation(tutorialHighlight)).toBe(false);
  });

  it("tutorial seed mutated to status=accepted still does NOT count", () => {
    // Locks in current behavior: status mutations don't promote a tutorial
    // seed to a real user-authored annotation. The predicate looks only at
    // author and id prefix — not status.
    const mutated = makeAnnotation({
      id: `${TUTORIAL_ANNOTATION_PREFIX}note-1`,
      author: "user",
      type: "note",
      status: "accepted",
    });
    expect(isNonTutorialUserAnnotation(mutated)).toBe(false);
  });

  it("mixed list — some(...) returns true when one real user annotation present", () => {
    const seed = makeAnnotation({
      id: `${TUTORIAL_ANNOTATION_PREFIX}note-1`,
      author: "user",
    });
    const real = makeAnnotation({ id: "real-1", author: "user" });
    expect([seed, real].some(isNonTutorialUserAnnotation)).toBe(true);
  });

  it("empty list — some(...) returns false", () => {
    expect([].some(isNonTutorialUserAnnotation)).toBe(false);
  });
});
