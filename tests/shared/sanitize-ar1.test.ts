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

describe("AR1: audience derivation for legacy annotations (no audience field)", () => {
  it("derives audience:private for legacy highlight — no audience-derived event", () => {
    const { result, events } = collect({ ...baseAnn, type: "highlight" });
    expect(result.audience).toBe("private");
    // Computing a default is normative — must not emit any event
    expect(events.some((e) => e.kind === ("audience-derived" as string))).toBe(false);
  });

  it("derives audience:private for legacy note — no audience-derived event", () => {
    const { result, events } = collect({ ...baseAnn, type: "note" });
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === ("audience-derived" as string))).toBe(false);
  });

  it("derives audience:private for legacy flag (pre-mutation type) — no audience-derived event", () => {
    const { result, events } = collect({ ...baseAnn, type: "flag" });
    // flag→note rewrite still fires; audience is private because flag was in private set
    expect(result.type).toBe("note");
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === "flag-to-note")).toBe(true);
    expect(events.some((e) => e.kind === ("audience-derived" as string))).toBe(false);
  });

  it("derives audience:outbound for legacy comment (claude author) — no audience-derived event", () => {
    const { result, events } = collect({ ...baseAnn, author: "claude", type: "comment" });
    expect(result.audience).toBe("outbound");
    expect(events.some((e) => e.kind === ("audience-derived" as string))).toBe(false);
  });

  it("derives audience:outbound for legacy comment (user author) — no audience-derived event", () => {
    // user-authored comments are Claude-visible per design brief — comment = outbound type
    const { result, events } = collect({ ...baseAnn, author: "user", type: "comment" });
    expect(result.audience).toBe("outbound");
    expect(events.some((e) => e.kind === ("audience-derived" as string))).toBe(false);
  });

  it("derives audience:outbound for legacy question (comment after migration) — no audience-derived event", () => {
    const { result, events } = collect({ ...baseAnn, type: "question" });
    expect(result.type).toBe("comment");
    expect(result.audience).toBe("outbound");
    expect(events.some((e) => e.kind === ("audience-derived" as string))).toBe(false);
    expect(events.some((e) => e.kind === "question-to-comment")).toBe(true);
  });

  it("derives audience:outbound for unknown type (coerced to comment) — no audience-derived event", () => {
    const { result, events } = collect({ ...baseAnn, type: "mystery-type" });
    expect(result.type).toBe("comment");
    expect(result.audience).toBe("outbound");
    expect(events.some((e) => e.kind === ("audience-derived" as string))).toBe(false);
    expect(events.some((e) => e.kind === "unknown-type")).toBe(true);
  });

  it("import annotation gets audience:private (user triages before Claude sees them)", () => {
    // import-note-to-comment rewrites type to "comment" per ADR-027,
    // but audience stays "private" — the new routing signal for AR1.
    const { result, events } = collect({ ...baseAnn, author: "import", type: "note" });
    expect(result.type).toBe("comment");
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === "import-note-to-comment")).toBe(true);
    expect(events.some((e) => e.kind === ("audience-derived" as string))).toBe(false);
  });

  it("import comment annotation gets audience:private (not yet promoted by user)", () => {
    // An import annotation already stored as type:"comment" (after ADR-027 migration)
    // should still be private until the user explicitly promotes it.
    const { result, events } = collect({ ...baseAnn, author: "import", type: "comment" });
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === ("audience-derived" as string))).toBe(false);
  });
});

describe("AR1: explicit audience — no events for already-migrated annotations", () => {
  it("does not emit any event for annotation with explicit audience:outbound", () => {
    const { result, events } = collect({ ...baseAnn, type: "comment", audience: "outbound" });
    expect(result.audience).toBe("outbound");
    expect(events).toHaveLength(0);
  });

  it("preserves explicit audience:private without emitting any event", () => {
    const { result, events } = collect({ ...baseAnn, type: "comment", audience: "private" });
    expect(result.audience).toBe("private");
    expect(events).toHaveLength(0);
  });

  it("newly created highlight with explicit audience:private emits no events", () => {
    const { result, events } = collect({
      ...baseAnn,
      type: "highlight",
      audience: "private",
      color: "yellow",
    });
    expect(result.audience).toBe("private");
    expect(events).toHaveLength(0);
  });

  it("newly created note with explicit audience:private emits no events", () => {
    const { result, events } = collect({ ...baseAnn, type: "note", audience: "private" });
    expect(result.audience).toBe("private");
    expect(events).toHaveLength(0);
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

describe("AR1: audience-conflict-resolved — user note/highlight with explicit audience:outbound", () => {
  it("user note with audience:outbound is forced to private and emits audience-conflict-resolved", () => {
    const { result, events } = collect({ ...baseAnn, type: "note", audience: "outbound" });
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === "audience-conflict-resolved")).toBe(true);
  });

  it("user highlight with audience:outbound is forced to private and emits audience-conflict-resolved", () => {
    const { result, events } = collect({
      ...baseAnn,
      type: "highlight",
      audience: "outbound",
      color: "yellow",
    });
    expect(result.audience).toBe("private");
    expect(events.some((e) => e.kind === "audience-conflict-resolved")).toBe(true);
  });

  it("import-promoted comment with audience:outbound is NOT changed — no audience-conflict-resolved", () => {
    // author:"import" annotations promoted to comment remain outbound-eligible
    const { result, events } = collect({
      ...baseAnn,
      author: "import",
      type: "comment",
      audience: "outbound",
    });
    expect(result.audience).toBe("outbound");
    expect(events.some((e) => e.kind === "audience-conflict-resolved")).toBe(false);
  });

  it("claude comment with audience:outbound is NOT changed — guard only covers author:user", () => {
    const { result, events } = collect({
      ...baseAnn,
      author: "claude",
      type: "comment",
      audience: "outbound",
    });
    expect(result.audience).toBe("outbound");
    expect(events.some((e) => e.kind === "audience-conflict-resolved")).toBe(false);
  });
});

describe("AR1: suggestion path emits no audience-derived event", () => {
  it("suggestion with valid JSON emits no events", () => {
    const events: SanitizationEvent[] = [];
    sanitizeAnnotation(
      {
        ...baseAnn,
        type: "suggestion",
        content: JSON.stringify({ newText: "x", reason: "y" }),
      } as Annotation,
      (e) => events.push(e),
    );
    // No audience-derived event, no other events for valid suggestion
    expect(events).toHaveLength(0);
  });

  it("malformed suggestion emits only malformed-suggestion-json, not audience-derived", () => {
    const events: SanitizationEvent[] = [];
    sanitizeAnnotation(
      {
        ...baseAnn,
        type: "suggestion",
        content: "not-json",
      } as Annotation,
      (e) => events.push(e),
    );
    expect(events.some((e) => e.kind === "malformed-suggestion-json")).toBe(true);
    expect(events.some((e) => e.kind === ("audience-derived" as string))).toBe(false);
  });
});
