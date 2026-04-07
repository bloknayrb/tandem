import { describe, expect, it } from "vitest";
import type { TandemEvent } from "../../src/server/events/types.js";
import { formatEventContent, formatEventMeta } from "../../src/server/events/types.js";

function makeEvent(
  type: TandemEvent["type"],
  payload: Record<string, unknown>,
  documentId?: string,
): TandemEvent {
  return {
    id: "evt_1234_abc",
    type,
    timestamp: Date.now(),
    documentId,
    payload,
  };
}

describe("formatEventContent", () => {
  it("annotation:created with snippet", () => {
    const event = makeEvent(
      "annotation:created",
      { annotationType: "comment", content: "Needs work", textSnippet: "hello" },
      "doc1",
    );
    expect(formatEventContent(event)).toBe(
      'User created comment on "hello": Needs work [doc: doc1]',
    );
  });

  it("annotation:created without snippet", () => {
    const event = makeEvent(
      "annotation:created",
      { annotationType: "highlight", content: "", textSnippet: "" },
      "doc1",
    );
    expect(formatEventContent(event)).toBe("User created highlight: (no content) [doc: doc1]");
  });

  it("annotation:accepted with snippet", () => {
    const event = makeEvent(
      "annotation:accepted",
      { annotationId: "ann_1", textSnippet: "world" },
      "doc1",
    );
    expect(formatEventContent(event)).toBe('User accepted annotation ann_1 ("world") [doc: doc1]');
  });

  it("annotation:accepted without snippet", () => {
    const event = makeEvent("annotation:accepted", { annotationId: "ann_1" }, "doc1");
    expect(formatEventContent(event)).toBe("User accepted annotation ann_1 [doc: doc1]");
  });

  it("annotation:dismissed", () => {
    const event = makeEvent(
      "annotation:dismissed",
      { annotationId: "ann_2", textSnippet: "foo" },
      "doc1",
    );
    expect(formatEventContent(event)).toBe('User dismissed annotation ann_2 ("foo") [doc: doc1]');
  });

  it("chat:message plain", () => {
    const event = makeEvent("chat:message", { text: "Hello Claude" }, "doc1");
    expect(formatEventContent(event)).toBe("User says: Hello Claude [doc: doc1]");
  });

  it("chat:message with replyTo", () => {
    const event = makeEvent("chat:message", { text: "Thanks", replyTo: "msg_1" }, "doc1");
    expect(formatEventContent(event)).toBe("User says (replying to msg_1): Thanks [doc: doc1]");
  });

  it("selection:changed with text", () => {
    const event = makeEvent(
      "selection:changed",
      { from: 5, to: 10, selectedText: "world" },
      "doc1",
    );
    expect(formatEventContent(event)).toBe(
      'User is pointing at text (5-10): "world" [doc: doc1] — respond via tandem_reply',
    );
  });

  it("selection:changed cleared", () => {
    const event = makeEvent("selection:changed", { from: 0, to: 0 }, "doc1");
    expect(formatEventContent(event)).toBe("User cleared selection [doc: doc1]");
  });

  it("selection:changed with truncated text", () => {
    const longText = "a".repeat(250);
    const event = makeEvent(
      "selection:changed",
      { from: 0, to: 250, selectedText: longText },
      "doc1",
    );
    const expected = `User is pointing at text (0-250): "${"a".repeat(250)}" [doc: doc1] — respond via tandem_reply`;
    expect(formatEventContent(event)).toBe(expected);
  });

  it("document:opened", () => {
    const event = makeEvent(
      "document:opened",
      { fileName: "README.md", format: "markdown" },
      "doc1",
    );
    expect(formatEventContent(event)).toBe(
      "User opened document: README.md (markdown) [doc: doc1]",
    );
  });

  it("document:closed", () => {
    const event = makeEvent("document:closed", { fileName: "old.md" }, "doc1");
    expect(formatEventContent(event)).toBe("User closed document: old.md [doc: doc1]");
  });

  it("document:switched", () => {
    const event = makeEvent("document:switched", { fileName: "new.md" }, "doc1");
    expect(formatEventContent(event)).toBe("User switched to document: new.md [doc: doc1]");
  });

  it("omits doc suffix when documentId is absent", () => {
    const event = makeEvent("chat:message", { text: "Hi" });
    expect(formatEventContent(event)).toBe("User says: Hi");
  });
});

describe("formatEventMeta", () => {
  it("includes event_type", () => {
    const event = makeEvent("chat:message", { text: "hi" }, "doc1");
    const meta = formatEventMeta(event);
    expect(meta.event_type).toBe("chat:message");
  });

  it("includes document_id when present", () => {
    const event = makeEvent("chat:message", { text: "hi" }, "doc1");
    expect(formatEventMeta(event).document_id).toBe("doc1");
  });

  it("omits document_id when absent", () => {
    const event = makeEvent("chat:message", { text: "hi" });
    expect(formatEventMeta(event)).not.toHaveProperty("document_id");
  });

  it("includes annotation_id when payload has annotationId", () => {
    const event = makeEvent(
      "annotation:created",
      { annotationId: "ann_1", annotationType: "comment", content: "", textSnippet: "" },
      "doc1",
    );
    expect(formatEventMeta(event).annotation_id).toBe("ann_1");
  });

  it("includes message_id when payload has messageId", () => {
    const event = makeEvent("chat:message", { messageId: "msg_1", text: "hi" }, "doc1");
    expect(formatEventMeta(event).message_id).toBe("msg_1");
  });

  it("omits annotation_id and message_id when not in payload", () => {
    const event = makeEvent("selection:changed", { from: 0, to: 0 }, "doc1");
    const meta = formatEventMeta(event);
    expect(meta).not.toHaveProperty("annotation_id");
    expect(meta).not.toHaveProperty("message_id");
  });

  it("selection:changed includes respond_via tandem_reply", () => {
    const event = makeEvent(
      "selection:changed",
      { from: 5, to: 10, selectedText: "world" },
      "doc1",
    );
    expect(formatEventMeta(event).respond_via).toBe("tandem_reply");
  });

  it("all keys use underscores (no hyphens)", () => {
    const event = makeEvent(
      "annotation:created",
      { annotationId: "ann_1", annotationType: "comment", content: "", textSnippet: "" },
      "doc1",
    );
    const meta = formatEventMeta(event);
    for (const key of Object.keys(meta)) {
      expect(key).not.toContain("-");
    }
  });
});
