import { describe, it, expect } from "vitest";
import { shouldShow } from "../../src/client/hooks/useAnnotationGate.js";
import type { Annotation, InterruptionMode } from "../../src/shared/types.js";

/**
 * Inline implementation of the useAnnotationGate hook logic (without React useMemo).
 * This lets us test the filtering + counting logic the hook performs.
 */
function gateAnnotations(annotations: Annotation[], mode: InterruptionMode) {
  const visibleAnnotations: Annotation[] = [];
  let heldCount = 0;
  for (const a of annotations) {
    if (shouldShow(a, mode)) {
      visibleAnnotations.push(a);
    } else if (a.status === "pending") {
      heldCount++;
    }
  }
  return { visibleAnnotations, heldCount };
}

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
    it("hides pending comment annotations without priority", () => {
      expect(
        shouldShow(makeAnnotation({ status: "pending", type: "comment" }), "urgent-only"),
      ).toBe(false);
    });

    it("hides pending highlight annotations without priority", () => {
      expect(
        shouldShow(makeAnnotation({ status: "pending", type: "highlight" }), "urgent-only"),
      ).toBe(false);
    });

    it("hides pending suggestion annotations without priority", () => {
      expect(
        shouldShow(makeAnnotation({ status: "pending", type: "suggestion" }), "urgent-only"),
      ).toBe(false);
    });

    it("shows pending urgent-priority annotations", () => {
      expect(
        shouldShow(makeAnnotation({ status: "pending", priority: "urgent" }), "urgent-only"),
      ).toBe(true);
    });

    it("shows pending flag annotations (implicitly urgent)", () => {
      expect(shouldShow(makeAnnotation({ status: "pending", type: "flag" }), "urgent-only")).toBe(
        true,
      );
    });

    it("shows pending question annotations (implicitly urgent)", () => {
      expect(
        shouldShow(makeAnnotation({ status: "pending", type: "question" }), "urgent-only"),
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
    it("comment annotations without explicit priority are hidden in urgent-only", () => {
      const ann = makeAnnotation({ status: "pending", type: "comment" });
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

describe("gateAnnotations (useAnnotationGate hook logic)", () => {
  it("shows all pending annotations in 'all' mode, heldCount is 0", () => {
    const anns = [
      makeAnnotation({ id: "a1", status: "pending" }),
      makeAnnotation({ id: "a2", status: "pending" }),
      makeAnnotation({ id: "a3", status: "accepted" }),
    ];
    const result = gateAnnotations(anns, "all");
    expect(result.visibleAnnotations).toHaveLength(3);
    expect(result.heldCount).toBe(0);
  });

  it("holds non-urgent pending in 'urgent-only' mode", () => {
    const anns = [
      makeAnnotation({ id: "a1", status: "pending", type: "comment" }), // comment → held
      makeAnnotation({ id: "a2", status: "pending", priority: "urgent" }), // explicit urgent → visible
      makeAnnotation({ id: "a3", status: "accepted" }), // resolved → visible
    ];
    const result = gateAnnotations(anns, "urgent-only");
    expect(result.visibleAnnotations).toHaveLength(2);
    expect(result.heldCount).toBe(1);
  });

  it("shows flags and questions in 'urgent-only' mode (implicitly urgent)", () => {
    const anns = [
      makeAnnotation({ id: "a1", status: "pending", type: "flag" }), // flag → visible
      makeAnnotation({ id: "a2", status: "pending", type: "question" }), // question → visible
      makeAnnotation({ id: "a3", status: "pending", type: "comment" }), // comment → held
      makeAnnotation({ id: "a4", status: "pending", type: "highlight" }), // highlight → held
    ];
    const result = gateAnnotations(anns, "urgent-only");
    expect(result.visibleAnnotations).toHaveLength(2);
    expect(result.heldCount).toBe(2);
  });

  it("holds all pending in 'paused' mode", () => {
    const anns = [
      makeAnnotation({ id: "a1", status: "pending" }),
      makeAnnotation({ id: "a2", status: "pending", priority: "urgent" }),
      makeAnnotation({ id: "a3", status: "dismissed" }),
    ];
    const result = gateAnnotations(anns, "paused");
    expect(result.visibleAnnotations).toHaveLength(1); // only dismissed
    expect(result.heldCount).toBe(2);
  });

  it("returns empty for empty input", () => {
    const result = gateAnnotations([], "all");
    expect(result.visibleAnnotations).toHaveLength(0);
    expect(result.heldCount).toBe(0);
  });

  it("does not count resolved annotations as held", () => {
    const anns = [
      makeAnnotation({ id: "a1", status: "accepted" }),
      makeAnnotation({ id: "a2", status: "dismissed" }),
    ];
    const result = gateAnnotations(anns, "paused");
    // Both resolved → visible, none held
    expect(result.visibleAnnotations).toHaveLength(2);
    expect(result.heldCount).toBe(0);
  });
});
