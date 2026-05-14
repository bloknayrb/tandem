import { describe, expect, it } from "vitest";
import {
  indexOfId,
  nextAnnotationId,
  prevAnnotationId,
  sortAnnotationsByPosition,
} from "../../src/client/hooks/useAnnotationOrder.js";
import type { Annotation } from "../../src/shared/types";

const ann = (id: string, from: number, to = from + 5): Annotation =>
  ({
    id,
    type: "comment",
    author: "claude",
    range: { from, to },
    status: "pending",
    audience: "outbound",
    createdAt: 0,
    body: "",
    textSnapshot: "",
  }) as unknown as Annotation;

describe("sortAnnotationsByPosition", () => {
  it("orders by range.from ascending", () => {
    const out = sortAnnotationsByPosition([ann("c", 30), ann("a", 10), ann("b", 20)]);
    expect(out.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it("tie-breaks by id when range.from is equal", () => {
    const out = sortAnnotationsByPosition([ann("z", 5), ann("a", 5), ann("m", 5)]);
    expect(out.map((a) => a.id)).toEqual(["a", "m", "z"]);
  });

  it("returns a new array (input not mutated)", () => {
    const input = [ann("b", 20), ann("a", 10)];
    const out = sortAnnotationsByPosition(input);
    expect(input.map((a) => a.id)).toEqual(["b", "a"]);
    expect(out.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("indexOfId", () => {
  const sorted = [ann("a", 1), ann("b", 2), ann("c", 3)];

  it("returns the index of the matching id", () => {
    expect(indexOfId(sorted, "b")).toBe(1);
  });

  it("returns -1 for null currentId", () => {
    expect(indexOfId(sorted, null)).toBe(-1);
  });

  it("returns -1 for an unknown id", () => {
    expect(indexOfId(sorted, "missing")).toBe(-1);
  });
});

describe("nextAnnotationId", () => {
  const sorted = [ann("a", 1), ann("b", 2), ann("c", 3)];

  it("returns the next id in order", () => {
    expect(nextAnnotationId(sorted, "a")).toBe("b");
    expect(nextAnnotationId(sorted, "b")).toBe("c");
  });

  it("wraps from last to first", () => {
    expect(nextAnnotationId(sorted, "c")).toBe("a");
  });

  it("returns first annotation when currentId is null", () => {
    expect(nextAnnotationId(sorted, null)).toBe("a");
  });

  it("returns first annotation when currentId is not in the list (e.g. resolved)", () => {
    expect(nextAnnotationId(sorted, "deleted-id")).toBe("a");
  });

  it("returns null with an empty list", () => {
    expect(nextAnnotationId([], "a")).toBeNull();
    expect(nextAnnotationId([], null)).toBeNull();
  });
});

describe("prevAnnotationId", () => {
  const sorted = [ann("a", 1), ann("b", 2), ann("c", 3)];

  it("returns the previous id in order", () => {
    expect(prevAnnotationId(sorted, "c")).toBe("b");
    expect(prevAnnotationId(sorted, "b")).toBe("a");
  });

  it("wraps from first to last", () => {
    expect(prevAnnotationId(sorted, "a")).toBe("c");
  });

  it("returns last annotation when currentId is null", () => {
    expect(prevAnnotationId(sorted, null)).toBe("c");
  });

  it("returns last annotation when currentId is not in the list", () => {
    expect(prevAnnotationId(sorted, "deleted-id")).toBe("c");
  });

  it("returns null with an empty list", () => {
    expect(prevAnnotationId([], "a")).toBeNull();
  });
});
