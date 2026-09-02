import { describe, expect, it } from "vitest";
import { processInboxAnnotations } from "../../../../../src/server/mcp/awareness.js";
import type { Annotation } from "../../../../../src/shared/types.js";

const base: Annotation = {
  id: "c1", author: "claude", type: "comment", range: { from: 0, to: 5 } as any,
  content: "x", status: "accepted", timestamp: 1, textSnapshot: "hello", suggestedText: "HELLO",
} as Annotation;

describe("inbox ledger after undo", () => {
  it("does not re-surface a second decision after an undo (accept -> poll -> undo -> dismiss -> poll)", () => {
    const surfaced = new Map<string, number>();
    const r1 = processInboxAnnotations([base], "hello world", surfaced, (a) => a, "doc", "tandem", () => false);
    expect(r1.userResponses.map((a) => a.status)).toEqual(["accepted"]);
    // user clicks Undo, then Dismiss
    const dismissed = { ...base, status: "dismissed" } as Annotation;
    const r2 = processInboxAnnotations([dismissed], "hello world", surfaced, (a) => a, "doc", "tandem", () => false);
    console.log("second poll userResponses:", r2.userResponses.map((a) => a.status));
    expect(r2.userResponses).toHaveLength(0); // documents the bug: the dismiss is never pulled
  });
  it("surfaces a user comment Claude resolved as a fresh userAction (no status gate on the user bucket)", () => {
    const surfaced = new Map<string, number>();
    const userDismissed = { id: "u1", author: "user", type: "comment", range: { from: 0, to: 5 }, content: "please fix", status: "dismissed", timestamp: 1 } as unknown as Annotation;
    const r = processInboxAnnotations([userDismissed], "hello world", surfaced, (a) => a, "doc", "tandem", () => false);
    console.log("dismissed user comment in userActions:", r.userActions.length);
    expect(r.userActions).toHaveLength(1);
  });
});
