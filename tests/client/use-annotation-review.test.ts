import { describe, expect, it } from "vitest";
import type { Annotation } from "../../src/shared/types.js";
import { isReviewTarget } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

/**
 * Inline implementation of the getReviewTargets filter — mirrors
 * useAnnotationReview.svelte.ts so we can test the predicate without
 * a Svelte rune environment.
 */
function getReviewTargets(annotations: Annotation[]): Annotation[] {
  return annotations.filter((a) => a.status === "pending" && isReviewTarget(a));
}

describe("isReviewTarget", () => {
  it("returns true for claude-authored annotations", () => {
    expect(isReviewTarget(makeAnnotation({ author: "claude" }))).toBe(true);
  });

  it("returns true for import-authored annotations (.docx Word comments)", () => {
    expect(isReviewTarget(makeAnnotation({ author: "import" }))).toBe(true);
  });

  it("returns false for user-authored annotations (private notes)", () => {
    expect(isReviewTarget(makeAnnotation({ author: "user" }))).toBe(false);
  });

  // Future-proofing: every value in Annotation["author"] must have a clear result.
  it.each([
    { author: "claude" as const, expected: true },
    { author: "import" as const, expected: true },
    { author: "user" as const, expected: false },
  ])("author=$author -> $expected", ({ author, expected }) => {
    expect(isReviewTarget(makeAnnotation({ author }))).toBe(expected);
  });
});

describe("getReviewTargets (filter applied at review callsite)", () => {
  const claudePending = makeAnnotation({ id: "c1", author: "claude", status: "pending" });
  const importPending = makeAnnotation({ id: "i1", author: "import", status: "pending" });
  const userPending = makeAnnotation({ id: "u1", author: "user", status: "pending" });
  const claudeAccepted = makeAnnotation({ id: "c2", author: "claude", status: "accepted" });

  it("includes claude-authored pending annotations", () => {
    const result = getReviewTargets([claudePending]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c1");
  });

  it("includes import-authored pending annotations (.docx Word comments)", () => {
    const result = getReviewTargets([importPending]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("i1");
  });

  it("excludes user-authored pending annotations (private notes)", () => {
    expect(getReviewTargets([userPending])).toHaveLength(0);
  });

  it("excludes resolved annotations regardless of author", () => {
    expect(getReviewTargets([claudeAccepted])).toHaveLength(0);
  });

  it("returns only claude + import when all three author types are pending", () => {
    const result = getReviewTargets([claudePending, importPending, userPending]);
    expect(result).toHaveLength(2);
    const ids = result.map((a) => a.id);
    expect(ids).toContain("c1");
    expect(ids).toContain("i1");
    expect(ids).not.toContain("u1");
  });
});
