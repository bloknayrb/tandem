import { describe, expect, it } from "vitest";
import { exportChatMarkdown, localChatDateLabel } from "../../src/client/panels/chat-export";
import { toFlatOffset } from "../../src/shared/positions/types";
import type { ChatMessage } from "../../src/shared/types";

describe("chat export", () => {
  it("sorts deterministically and includes filenames, anchors, and verbatim bodies without paths", () => {
    const messages: ChatMessage[] = [
      {
        id: "b",
        author: "claude",
        text: "**answer**\n\n- one",
        timestamp: Date.UTC(2026, 0, 2, 3, 4, 5),
        documentId: "doc",
        read: true,
      },
      {
        id: "a",
        author: "user",
        text: "question",
        timestamp: Date.UTC(2026, 0, 1, 2, 3, 4),
        documentId: "doc",
        anchor: {
          from: toFlatOffset(0),
          to: toFlatOffset(4),
          textSnapshot: "line one\nline two",
        },
        read: false,
      },
    ];
    const markdown = exportChatMarkdown(messages, [{ id: "doc", fileName: "notes.md" }]);
    expect(markdown.indexOf("question")).toBeLessThan(markdown.indexOf("**answer**"));
    expect(markdown).toContain("## 2026-01-01");
    expect(markdown).toContain("**You** · 02:03:04Z · `notes.md`");
    expect(markdown).toContain("> line one\n> line two");
    expect(markdown).toContain("**answer**\n\n- one");
    expect(markdown).not.toContain("C:\\");
    expect(markdown).not.toContain("/Users/");
  });

  it("uses local-calendar Today and Yesterday labels", () => {
    const now = new Date(2026, 6, 10, 12);
    expect(localChatDateLabel(new Date(2026, 6, 10, 1).getTime(), now)).toBe("Today");
    expect(localChatDateLabel(new Date(2026, 6, 9, 23).getTime(), now)).toBe("Yesterday");
  });

  it("uses a persisted closed-document filename while stripping path input defensively", () => {
    const message: ChatMessage = {
      id: "closed",
      author: "claude",
      text: "answer",
      timestamp: Date.UTC(2026, 0, 1),
      documentId: "opaque-document-id",
      read: true,
    };
    const markdown = exportChatMarkdown(
      [message],
      [{ id: "opaque-document-id", fileName: "C:\\secret\\Closed.md" }],
    );
    expect(markdown).toContain("`Closed.md`");
    expect(markdown).not.toContain("secret");
    expect(markdown).not.toContain("opaque-document-id");
  });
});
