import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createAnnotation, collectAnnotations } from "../../src/server/mcp/annotations.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";

function makeResult(from: number, to: number) {
  return { ok: true as const, fullyAnchored: false as const, range: { from, to } };
}

describe("annotation textSnapshot", () => {
  it("stores textSnapshot when provided via extras", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", makeResult(0, 10), "Nice paragraph", {
      textSnapshot: "hello worl",
    });
    const annotations = collectAnnotations(map);
    const stored = annotations.find((a) => a.id === id);
    expect(stored).toBeDefined();
    expect(stored?.textSnapshot).toBe("hello worl");
  });

  it("works without textSnapshot (legacy compatibility)", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "highlight", makeResult(0, 5), "Looks good");
    const annotations = collectAnnotations(map);
    const stored = annotations.find((a) => a.id === id);
    expect(stored).toBeDefined();
    expect(stored?.textSnapshot).toBeUndefined();
  });

  it("stores textSnapshot alongside priority", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "flag", makeResult(5, 20), "Needs review", {
      priority: "urgent",
      textSnapshot: "flagged text",
    });
    const annotations = collectAnnotations(map);
    const stored = annotations.find((a) => a.id === id);
    expect(stored?.textSnapshot).toBe("flagged text");
    expect(stored?.priority).toBe("urgent");
  });
});

describe("snapshot truncation (inline logic)", () => {
  const cap = 200;
  function truncate(text: string): string {
    return text.length > cap ? text.slice(0, cap - 3) + "..." : text;
  }

  it("truncates text longer than 200 chars", () => {
    const long = "a".repeat(250);
    expect(truncate(long)).toHaveLength(200);
    expect(truncate(long).endsWith("...")).toBe(true);
  });

  it("keeps text at exactly 200 chars unchanged", () => {
    const exact = "b".repeat(200);
    expect(truncate(exact)).toBe(exact);
  });

  it("keeps short text unchanged", () => {
    expect(truncate("short")).toBe("short");
  });
});
