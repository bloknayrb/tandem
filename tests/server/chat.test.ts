import { Y_MAP_CHAT } from "../../src/shared/constants.js";
import { describe, it, expect } from "vitest";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { generateMessageId } from "../../src/shared/utils.js";
import type { ChatMessage } from "../../src/shared/types.js";

describe("generateMessageId", () => {
  it("produces msg_ prefixed IDs", () => {
    const id = generateMessageId();
    expect(id).toMatch(/^msg_\d+_[a-z0-9]+$/);
  });

  it("produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateMessageId()));
    expect(ids.size).toBe(100);
  });
});

describe("Y.Map chat message operations", () => {
  it("reads unread user messages from __tandem_ctrl__ chat map", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_chat_test_1__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

    const msg: ChatMessage = {
      id: "msg_test_001",
      author: "user",
      text: "Look at this paragraph",
      timestamp: Date.now(),
      documentId: "test-doc",
      read: false,
    };
    chatMap.set(msg.id, msg);

    const unread: ChatMessage[] = [];
    chatMap.forEach((value) => {
      const m = value as ChatMessage;
      if (m.author === "user" && !m.read) {
        unread.push(m);
      }
    });

    expect(unread).toHaveLength(1);
    expect(unread[0].text).toBe("Look at this paragraph");
  });

  it("marks messages as read after processing", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_chat_test_2__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

    const msg: ChatMessage = {
      id: "msg_test_002",
      author: "user",
      text: "Check this section",
      timestamp: Date.now(),
      read: false,
    };
    chatMap.set(msg.id, msg);

    const existing = chatMap.get(msg.id) as ChatMessage;
    chatMap.set(msg.id, { ...existing, read: true });

    const afterRead = chatMap.get(msg.id) as ChatMessage;
    expect(afterRead.read).toBe(true);
  });

  it("writes a claude reply to chat map", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_chat_test_3__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

    const id = generateMessageId();
    const reply: ChatMessage = {
      id,
      author: "claude",
      text: "I see the issue. Here is a suggestion...",
      timestamp: Date.now(),
      read: true,
    };
    chatMap.set(id, reply);

    const stored = chatMap.get(id) as ChatMessage;
    expect(stored.author).toBe("claude");
    expect(stored.text).toContain("I see the issue");
    expect(stored.read).toBe(true);
  });

  it("links reply to original message via replyTo", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_chat_test_4__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

    const originalId = "msg_original_123";
    const replyId = generateMessageId();
    const reply: ChatMessage = {
      id: replyId,
      author: "claude",
      text: "Response to your question",
      timestamp: Date.now(),
      replyTo: originalId,
      read: true,
    };
    chatMap.set(replyId, reply);

    const stored = chatMap.get(replyId) as ChatMessage;
    expect(stored.replyTo).toBe(originalId);
  });
});
