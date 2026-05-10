import { describe, expect, it } from "vitest";
import type { SanitizationEvent } from "../../src/shared/sanitize";
import { sanitizeAnnotation } from "../../src/shared/sanitize";
import type { Annotation } from "../../src/shared/types";

const baseAnn = {
  id: "test-id",
  author: "user" as const,
  range: { from: 0, to: 5 },
  content: "hello",
  status: "pending" as const,
  timestamp: 1000,
};

function collect(ann: object): { result: Annotation; events: SanitizationEvent[] } {
  const events: SanitizationEvent[] = [];
  const result = sanitizeAnnotation(ann as Annotation, (e) => events.push(e));
  return { result, events };
}

describe("AR1: audience derivation for legacy annotations", () => {
  it("derives audience:private for legacy highlight", () => {
    const { result, events } = collect({ ...baseAnn, type: "highlight" });
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === "audience-derived")).toBe(true);
  });

  it("derives audience:private for legacy note", () => {
    const { result, events } = collect({ ...baseAnn, type: "note" });
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === "audience-derived")).toBe(true);
  });

  it("derives audience:private for legacy flag (pre-mutation type)", () => {
    const { result, events } = collect({ ...baseAnn, type: "flag" });
    // flag→note rewrite still fires; audience is private because flag was in private set
    expect(result.type).toBe("note");
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === "audience-derived")).toBe(true);
  });

  it("derives audience:outbound for legacy comment (claude author)", () => {
    const { result, events } = collect({ ...baseAnn, author: "claude", type: "comment" });
    expect(result.audience).toBe("outbound");
    expect(events.some((e) => e.kind === "audience-derived")).toBe(true);
  });

  it("derives audience:outbound for legacy comment (user author)", () => {
    // user-authored comments are Claude-visible per design brief — comment = outbound type
    const { result, events } = collect({ ...baseAnn, author: "user", type: "comment" });
    expect(result.audience).toBe("outbound");
    expect(events.some((e) => e.kind === "audience-derived")).toBe(true);
  });

  it("derives audience:outbound for legacy question (comment after migration)", () => {
    const { result, events } = collect({ ...baseAnn, type: "question" });
    expect(result.type).toBe("comment");
    expect(result.audience).toBe("outbound");
    expect(events.some((e) => e.kind === "audience-derived")).toBe(true);
    expect(events.some((e) => e.kind === "question-to-comment")).toBe(true);
  });

  it("derives audience:outbound for unknown type (coerced to comment)", () => {
    const { result, events } = collect({ ...baseAnn, type: "mystery-type" });
    expect(result.type).toBe("comment");
    expect(result.audience).toBe("outbound");
    // Both audience-derived and unknown-type events must fire
    expect(events.some((e) => e.kind === "audience-derived")).toBe(true);
    expect(events.some((e) => e.kind === "unknown-type")).toBe(true);
  });

  it("import annotation gets audience:private (user triages before Claude sees them)", () => {
    // import-note-to-comment rewrites type to "comment" per ADR-027,
    // but audience stays "private" — the new routing signal for AR1.
    const { result, events } = collect({ ...baseAnn, author: "import", type: "note" });
    expect(result.type).toBe("comment");
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === "audience-derived")).toBe(true);
    expect(events.some((e) => e.kind === "import-note-to-comment")).toBe(true);
  });

  it("import comment annotation gets audience:private (not yet promoted by user)", () => {
    // An import annotation already stored as type:"comment" (after ADR-027 migration)
    // should still be private until the user explicitly promotes it.
    const { result, events } = collect({ ...baseAnn, author: "import", type: "comment" });
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === "audience-derived")).toBe(true);
  });

  it("does not emit audience-derived for already-migrated annotation", () => {
    const { result, events } = collect({ ...baseAnn, type: "comment", audience: "outbound" });
    expect(result.audience).toBe("outbound");
    expect(events.some((e) => e.kind === "audience-derived")).toBe(false);
  });

  it("preserves explicit audience:private without re-deriving", () => {
    const { result, events } = collect({ ...baseAnn, type: "comment", audience: "private" });
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === "audience-derived")).toBe(false);
  });
});

describe("AR1: promotedFrom pass-through", () => {
  it("passes promotedFrom:note through sanitize", () => {
    const { result } = collect({ ...baseAnn, type: "comment", promotedFrom: "note" });
    expect(result.promotedFrom).toBe("note");
  });

  it("omits promotedFrom when absent", () => {
    const { result } = collect({ ...baseAnn, type: "comment" });
    expect(result.promotedFrom).toBeUndefined();
  });
});

describe("AR1: importSource pass-through", () => {
  it("passes importSource through sanitize", () => {
    const src = { author: "Bob", file: "review.docx" };
    const { result } = collect({
      ...baseAnn,
      author: "import",
      type: "comment",
      importSource: src,
    });
    expect(result.importSource).toEqual(src);
  });

  it("omits importSource when absent", () => {
    const { result } = collect({ ...baseAnn, type: "comment" });
    expect(result.importSource).toBeUndefined();
  });
});

describe("AR1: audience-derived fires exactly once per call regardless of type path", () => {
  it("emits audience-derived exactly once even when suggestion path fires malformed-suggestion-json too", () => {
    const events: SanitizationEvent[] = [];
    // suggestion type goes through its own early path
    sanitizeAnnotation(
      {
        ...baseAnn,
        type: "suggestion",
        content: JSON.stringify({ newText: "x", reason: "y" }),
      } as Annotation,
      (e) => events.push(e),
    );
    const derived = events.filter((e) => e.kind === "audience-derived");
    expect(derived).toHaveLength(1);
    expect(derived[0].id).toBe("test-id");
  });
});
