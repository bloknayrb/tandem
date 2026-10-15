/**
 * `isStartWorthy` (#2196): which events start a Tandem's Claude that is not
 * running by choice. Bryan's line is the user talking TO Claude — a chat, or
 * the user's reply on a thread Claude started — so every other event, including
 * the ones that wake a running Claude, must answer false.
 */
import { describe, expect, it } from "vitest";
import type { TandemEvent } from "../../src/shared/events/types.js";
import { isStartWorthy, isWakeWorthy } from "../../src/shared/events/wake-scope.js";

function ev(type: TandemEvent["type"], payload: Record<string, unknown> = {}): TandemEvent {
  return { id: "e", type, timestamp: 0, documentId: "d", payload } as unknown as TandemEvent;
}

function reply(replyAuthor: string, parentAuthor: string): TandemEvent {
  return ev("annotation:reply", {
    annotationId: "a",
    replyId: "r",
    replyText: "t",
    replyAuthor,
    textSnippet: "",
    parentAuthor,
  });
}

describe("isStartWorthy", () => {
  it("a chat message starts Claude", () => {
    expect(isStartWorthy(ev("chat:message"))).toBe(true);
  });

  it("the user's reply on Claude's comment starts Claude", () => {
    expect(isStartWorthy(reply("user", "claude"))).toBe(true);
  });

  const NOT_START_WORTHY: Array<[string, TandemEvent]> = [
    ["a user reply on a user-authored parent", reply("user", "user")],
    ["a user reply on an imported Word comment", reply("user", "import")],
    ["Claude's own reply", reply("claude", "claude")],
    ["an imported reply", reply("import", "claude")],
    ["a new comment", ev("annotation:created")],
    ["an accept", ev("annotation:accepted")],
    ["a dismiss", ev("annotation:dismissed")],
    ["an edit", ev("annotation:edited")],
    ["a document opening", ev("document:opened")],
    ["a tab switch", ev("document:switched")],
  ];

  it.each(NOT_START_WORTHY)("%s does not", (_label, event) => {
    expect(isStartWorthy(event)).toBe(false);
  });

  it("is never wider than isWakeWorthy: whatever starts Claude also wakes it", () => {
    const all = [
      ev("chat:message"),
      reply("user", "claude"),
      ...NOT_START_WORTHY.map(([, e]) => e),
    ];
    for (const event of all) expect(!isStartWorthy(event) || isWakeWorthy(event)).toBe(true);
  });
});
