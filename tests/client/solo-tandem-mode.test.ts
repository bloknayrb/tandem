import { describe, it, expect } from "vitest";
import { shouldShowInMode } from "../../src/client/hooks/useModeGate.js";
import type { Annotation, TandemMode } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

/**
 * Inline implementation of the useModeGate hook logic (without React useMemo).
 * This lets us test the filtering + counting logic the hook performs.
 */
function gateAnnotations(annotations: Annotation[], mode: TandemMode) {
  const visibleAnnotations: Annotation[] = [];
  let heldCount = 0;
  for (const a of annotations) {
    if (shouldShowInMode(a, mode)) {
      visibleAnnotations.push(a);
    } else if (a.status === "pending") {
      heldCount++;
    }
  }
  return { visibleAnnotations, heldCount };
}

describe("shouldShowInMode", () => {
  describe('mode = "tandem"', () => {
    it("shows pending claude annotations", () => {
      expect(
        shouldShowInMode(makeAnnotation({ author: "claude", status: "pending" }), "tandem"),
      ).toBe(true);
    });

    it("shows pending user annotations", () => {
      expect(
        shouldShowInMode(makeAnnotation({ author: "user", status: "pending" }), "tandem"),
      ).toBe(true);
    });

    it("shows accepted annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ status: "accepted" }), "tandem")).toBe(true);
    });

    it("shows dismissed annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ status: "dismissed" }), "tandem")).toBe(true);
    });
  });

  describe('mode = "solo"', () => {
    it("hides pending claude annotations", () => {
      expect(
        shouldShowInMode(makeAnnotation({ author: "claude", status: "pending" }), "solo"),
      ).toBe(false);
    });

    it("shows pending user annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ author: "user", status: "pending" }), "solo")).toBe(
        true,
      );
    });

    it("shows pending import annotations", () => {
      expect(
        shouldShowInMode(makeAnnotation({ author: "import", status: "pending" }), "solo"),
      ).toBe(true);
    });

    it("shows accepted claude annotations (resolved always visible)", () => {
      expect(
        shouldShowInMode(makeAnnotation({ author: "claude", status: "accepted" }), "solo"),
      ).toBe(true);
    });

    it("shows dismissed claude annotations (resolved always visible)", () => {
      expect(
        shouldShowInMode(makeAnnotation({ author: "claude", status: "dismissed" }), "solo"),
      ).toBe(true);
    });

    it("shows accepted user annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ author: "user", status: "accepted" }), "solo")).toBe(
        true,
      );
    });

    it("shows dismissed user annotations", () => {
      expect(
        shouldShowInMode(makeAnnotation({ author: "user", status: "dismissed" }), "solo"),
      ).toBe(true);
    });
  });
});

describe("gateAnnotations (useModeGate hook logic)", () => {
  it("tandem mode shows all annotations, heldCount is 0", () => {
    const anns = [
      makeAnnotation({ id: "a1", author: "claude", status: "pending" }),
      makeAnnotation({ id: "a2", author: "user", status: "pending" }),
      makeAnnotation({ id: "a3", author: "claude", status: "accepted" }),
    ];
    const result = gateAnnotations(anns, "tandem");
    expect(result.visibleAnnotations).toHaveLength(3);
    expect(result.heldCount).toBe(0);
  });

  it("solo mode hides pending claude annotations", () => {
    const anns = [
      makeAnnotation({ id: "a1", author: "claude", status: "pending" }),
      makeAnnotation({ id: "a2", author: "claude", status: "pending" }),
    ];
    const result = gateAnnotations(anns, "solo");
    expect(result.visibleAnnotations).toHaveLength(0);
    expect(result.heldCount).toBe(2);
  });

  it("solo mode shows pending user annotations", () => {
    const anns = [
      makeAnnotation({ id: "a1", author: "user", status: "pending" }),
      makeAnnotation({ id: "a2", author: "claude", status: "pending" }),
    ];
    const result = gateAnnotations(anns, "solo");
    expect(result.visibleAnnotations).toHaveLength(1);
    expect(result.visibleAnnotations[0].id).toBe("a1");
    expect(result.heldCount).toBe(1);
  });

  it("solo mode shows resolved annotations from any author", () => {
    const anns = [
      makeAnnotation({ id: "a1", author: "claude", status: "accepted" }),
      makeAnnotation({ id: "a2", author: "claude", status: "dismissed" }),
      makeAnnotation({ id: "a3", author: "user", status: "accepted" }),
    ];
    const result = gateAnnotations(anns, "solo");
    expect(result.visibleAnnotations).toHaveLength(3);
    expect(result.heldCount).toBe(0);
  });

  it("heldCount counts only pending hidden annotations", () => {
    const anns = [
      makeAnnotation({ id: "a1", author: "claude", status: "pending" }), // held
      makeAnnotation({ id: "a2", author: "claude", status: "pending" }), // held
      makeAnnotation({ id: "a3", author: "claude", status: "accepted" }), // visible (resolved)
      makeAnnotation({ id: "a4", author: "user", status: "pending" }), // visible (user)
    ];
    const result = gateAnnotations(anns, "solo");
    expect(result.visibleAnnotations).toHaveLength(2);
    expect(result.heldCount).toBe(2);
  });

  it("returns empty results for empty input", () => {
    const result = gateAnnotations([], "solo");
    expect(result.visibleAnnotations).toHaveLength(0);
    expect(result.heldCount).toBe(0);
  });

  it("returns empty results for empty input in tandem mode", () => {
    const result = gateAnnotations([], "tandem");
    expect(result.visibleAnnotations).toHaveLength(0);
    expect(result.heldCount).toBe(0);
  });
});
