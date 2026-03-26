import { describe, it, expect } from "vitest";
import { shouldShow } from "../../src/client/hooks/useAnnotationGate.js";
import type { Annotation } from "../../src/shared/types.js";

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann_test_001",
    author: "claude",
    type: "comment",
    range: { from: 0, to: 5 },
    content: "test",
    status: "pending",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("shouldShow", () => {
  describe('mode = "all"', () => {
    it("shows pending normal-priority annotations", () => {
      expect(shouldShow(makeAnnotation({ status: "pending" }), "all")).toBe(true);
    });

    it("shows pending urgent-priority annotations", () => {
      expect(shouldShow(makeAnnotation({ status: "pending", priority: "urgent" }), "all")).toBe(
        true,
      );
    });

    it("shows accepted annotations", () => {
      expect(shouldShow(makeAnnotation({ status: "accepted" }), "all")).toBe(true);
    });

    it("shows dismissed annotations", () => {
      expect(shouldShow(makeAnnotation({ status: "dismissed" }), "all")).toBe(true);
    });
  });

  describe('mode = "urgent-only"', () => {
    it("hides pending normal-priority annotations", () => {
      expect(shouldShow(makeAnnotation({ status: "pending" }), "urgent-only")).toBe(false);
    });

    it("shows pending urgent-priority annotations", () => {
      expect(
        shouldShow(makeAnnotation({ status: "pending", priority: "urgent" }), "urgent-only"),
      ).toBe(true);
    });

    it("shows accepted annotations (resolved always visible)", () => {
      expect(shouldShow(makeAnnotation({ status: "accepted" }), "urgent-only")).toBe(true);
    });

    it("shows dismissed annotations (resolved always visible)", () => {
      expect(shouldShow(makeAnnotation({ status: "dismissed" }), "urgent-only")).toBe(true);
    });
  });

  describe('mode = "paused"', () => {
    it("hides pending normal-priority annotations", () => {
      expect(shouldShow(makeAnnotation({ status: "pending" }), "paused")).toBe(false);
    });

    it("hides pending urgent-priority annotations", () => {
      expect(shouldShow(makeAnnotation({ status: "pending", priority: "urgent" }), "paused")).toBe(
        false,
      );
    });

    it("shows accepted annotations", () => {
      expect(shouldShow(makeAnnotation({ status: "accepted" }), "paused")).toBe(true);
    });

    it("shows dismissed annotations", () => {
      expect(shouldShow(makeAnnotation({ status: "dismissed" }), "paused")).toBe(true);
    });
  });

  describe("annotation types", () => {
    const types = ["highlight", "comment", "suggestion", "question", "flag"] as const;

    for (const type of types) {
      it(`works with ${type} type in 'all' mode`, () => {
        expect(shouldShow(makeAnnotation({ type, status: "pending" }), "all")).toBe(true);
      });
    }
  });

  describe("edge cases", () => {
    it("annotations without explicit priority are treated as normal", () => {
      const ann = makeAnnotation({ status: "pending" });
      // No priority field set → should be hidden in urgent-only
      expect(shouldShow(ann, "urgent-only")).toBe(false);
    });

    it("user-authored annotations follow the same rules", () => {
      expect(shouldShow(makeAnnotation({ author: "user", status: "pending" }), "all")).toBe(true);
      expect(shouldShow(makeAnnotation({ author: "user", status: "pending" }), "paused")).toBe(
        false,
      );
    });
  });
});
