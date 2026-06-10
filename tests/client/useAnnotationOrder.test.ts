import { describe, expect, it } from "vitest";
import {
  indexOfId,
  nextAnnotationId,
  prevAnnotationId,
  sortAnnotations,
  sortAnnotationsByPosition,
  sortAnnotationsByTimestamp,
} from "../../src/client/hooks/useAnnotationOrder.js";
import type { Annotation } from "../../src/shared/types";

const ann = (id: string, from: number, to = from + 5, timestamp = 0): Annotation =>
  ({
    id,
    type: "comment",
    author: "claude",
    range: { from, to },
    status: "pending",
    audience: "outbound",
    timestamp,
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

  it("sorts annotations missing position data to the end", () => {
    const broken = ann("broken", 0);
    (broken as unknown as { range: undefined }).range = undefined;
    const out = sortAnnotationsByPosition([broken, ann("b", 20), ann("a", 10)]);
    expect(out.map((a) => a.id)).toEqual(["a", "b", "broken"]);
  });

  it("tie-breaks by id when BOTH records are missing position data", () => {
    const brokenZ = ann("z-broken", 0);
    const brokenA = ann("a-broken", 0);
    (brokenZ as unknown as { range: undefined }).range = undefined;
    (brokenA as unknown as { range: undefined }).range = undefined;
    const out = sortAnnotationsByPosition([brokenZ, brokenA, ann("x", 10)]);
    expect(out.map((a) => a.id)).toEqual(["x", "a-broken", "z-broken"]);
  });
});

describe("sortAnnotationsByTimestamp", () => {
  it("orders by timestamp ascending (oldest first)", () => {
    const out = sortAnnotationsByTimestamp([
      ann("newest", 5, 10, 3000),
      ann("oldest", 50, 55, 1000),
      ann("middle", 20, 25, 2000),
    ]);
    expect(out.map((a) => a.id)).toEqual(["oldest", "middle", "newest"]);
  });

  it("tie-breaks by id when timestamps are equal", () => {
    const out = sortAnnotationsByTimestamp([
      ann("z", 1, 6, 1000),
      ann("a", 2, 7, 1000),
      ann("m", 3, 8, 1000),
    ]);
    expect(out.map((a) => a.id)).toEqual(["a", "m", "z"]);
  });

  it("treats a missing timestamp as oldest", () => {
    const noTs = ann("no-ts", 1);
    (noTs as unknown as { timestamp: undefined }).timestamp = undefined;
    const out = sortAnnotationsByTimestamp([ann("b", 2, 7, 2000), noTs, ann("a", 3, 8, 1000)]);
    expect(out.map((a) => a.id)).toEqual(["no-ts", "a", "b"]);
  });

  it("returns a new array (input not mutated)", () => {
    const input = [ann("b", 1, 6, 2000), ann("a", 2, 7, 1000)];
    const out = sortAnnotationsByTimestamp(input);
    expect(input.map((a) => a.id)).toEqual(["b", "a"]);
    expect(out.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("sortAnnotations", () => {
  // Position order: a, b, c. Chronological order: c, b, a.
  const anns = [ann("b", 20, 25, 2000), ann("c", 30, 35, 1000), ann("a", 10, 15, 3000)];

  it('"position" mode sorts by document anchor position', () => {
    expect(sortAnnotations(anns, "position").map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  it('"chronological" mode sorts oldest first', () => {
    expect(sortAnnotations(anns, "chronological").map((a) => a.id)).toEqual(["c", "b", "a"]);
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
