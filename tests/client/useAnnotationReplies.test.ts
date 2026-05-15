import { describe, expect, it } from "vitest";
import { groupReplies } from "../../src/client/hooks/useAnnotationReplies.svelte";
import type { AnnotationReply } from "../../src/shared/types";

function makeSource(values: unknown[]) {
  return {
    forEach(cb: (value: unknown) => void): void {
      for (const v of values) cb(v);
    },
  };
}

const r = (overrides: Partial<AnnotationReply>): AnnotationReply => ({
  id: "reply-" + Math.random().toString(36).slice(2),
  annotationId: "ann-1",
  author: "user",
  text: "hi",
  timestamp: 0,
  ...overrides,
});

describe("groupReplies", () => {
  it("returns an empty map for an empty source", () => {
    expect(groupReplies(makeSource([])).size).toBe(0);
  });

  it("groups replies by annotationId", () => {
    const grouped = groupReplies(
      makeSource([
        r({ annotationId: "a", text: "one" }),
        r({ annotationId: "b", text: "two" }),
        r({ annotationId: "a", text: "three" }),
      ]),
    );
    expect(grouped.get("a")?.length).toBe(2);
    expect(grouped.get("b")?.length).toBe(1);
  });

  it("sorts each group by ascending timestamp", () => {
    const grouped = groupReplies(
      makeSource([
        r({ annotationId: "a", text: "later", timestamp: 200 }),
        r({ annotationId: "a", text: "earlier", timestamp: 100 }),
        r({ annotationId: "a", text: "middle", timestamp: 150 }),
      ]),
    );
    const list = grouped.get("a") ?? [];
    expect(list.map((x) => x.text)).toEqual(["earlier", "middle", "later"]);
  });

  it("skips malformed entries (null, non-object, missing annotationId)", () => {
    const grouped = groupReplies(
      makeSource([
        null,
        undefined,
        "string-not-object",
        42,
        { id: "x", text: "no annotationId" },
        r({ annotationId: "real", text: "good" }),
      ]),
    );
    expect(grouped.size).toBe(1);
    expect(grouped.get("real")?.length).toBe(1);
  });
});
