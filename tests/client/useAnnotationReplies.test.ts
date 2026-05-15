import { describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { groupReplies } from "../../src/client/hooks/useAnnotationReplies.svelte";
import type { AnnotationReply } from "../../src/shared/types";

// `groupReplies` accepts `Pick<Y.Map<AnnotationReply>, "forEach">`. We type the
// double's `forEach` property as `Y.Map<AnnotationReply>["forEach"]` directly,
// so any future Y.js signature change to `forEach` becomes a compile error
// here instead of silently passing through an `unknown` cast.
function makeSource(values: readonly unknown[]): Pick<Y.Map<AnnotationReply>, "forEach"> {
  const forEach: Y.Map<AnnotationReply>["forEach"] = (cb) => {
    // The `skips malformed entries` test feeds non-AnnotationReply items; cast
    // each value through the declared MapType so the structural contract is
    // exercised even though the runtime guards in `groupReplies` filter them.
    // Cast the third arg through `unknown` because we don't construct a real
    // YMap in tests; future signature changes to `forEach` itself still break
    // here because `forEach` is typed as `Y.Map<AnnotationReply>["forEach"]`.
    const map = undefined as unknown as Y.Map<AnnotationReply>;
    for (const v of values) {
      const key = (v as { id?: string } | null)?.id ?? "";
      cb(v as AnnotationReply, key, map);
    }
  };
  return { forEach };
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
