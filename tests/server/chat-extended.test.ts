import { describe, it, expect } from "vitest";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { generateMessageId } from "../../src/shared/utils.js";
import type { ChatMessage } from "../../src/shared/types.js";

describe("chat message pruning logic", () => {
  it("prunes old messages keeping newest 200", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_prune_1__");
    const chatMap = ctrlDoc.getMap("chat");

    // Add 250 messages
    for (let i = 0; i < 250; i++) {
      const id = `msg_prune_${i.toString().padStart(3, "0")}`;
      chatMap.set(id, {
        id,
        author: i % 2 === 0 ? "user" : "claude",
        text: `Message ${i}`,
        timestamp: 1000 + i, // Ascending timestamps
        read: true,
      } as ChatMessage);
    }

    expect(chatMap.size).toBe(250);

    // Simulate pruning (same logic as saveCtrlSession)
    const msgs: ChatMessage[] = [];
    chatMap.forEach((v) => msgs.push(v as ChatMessage));
    msgs.sort((a, b) => a.timestamp - b.timestamp);

    const keep = msgs.slice(-200);
    const keepIds = new Set(keep.map((m) => m.id));

    // Delete old messages
    const toDelete: string[] = [];
    chatMap.forEach((_, key) => {
      if (!keepIds.has(key)) toDelete.push(key);
    });
    for (const key of toDelete) {
      chatMap.delete(key);
    }

    expect(chatMap.size).toBe(200);
    // Oldest kept should be message 50
    expect(chatMap.has("msg_prune_050")).toBe(true);
    // Messages 0-49 should be gone
    expect(chatMap.has("msg_prune_000")).toBe(false);
    expect(chatMap.has("msg_prune_049")).toBe(false);
  });

  it("does not prune when under 200 messages", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_prune_2__");
    const chatMap = ctrlDoc.getMap("chat");

    for (let i = 0; i < 50; i++) {
      const id = `msg_small_${i}`;
      chatMap.set(id, {
        id,
        author: "user",
        text: `Message ${i}`,
        timestamp: Date.now() + i,
        read: true,
      } as ChatMessage);
    }

    const msgs: ChatMessage[] = [];
    chatMap.forEach((v) => msgs.push(v as ChatMessage));
    msgs.sort((a, b) => a.timestamp - b.timestamp);

    const keep = msgs.slice(-200);
    expect(keep).toHaveLength(50); // All kept
  });
});

describe("chat message ordering", () => {
  it("messages can be sorted by timestamp", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_order_1__");
    const chatMap = ctrlDoc.getMap("chat");

    // Add messages out of order
    chatMap.set("msg_3", {
      id: "msg_3",
      author: "claude",
      text: "Third",
      timestamp: 3000,
      read: true,
    } as ChatMessage);
    chatMap.set("msg_1", {
      id: "msg_1",
      author: "user",
      text: "First",
      timestamp: 1000,
      read: false,
    } as ChatMessage);
    chatMap.set("msg_2", {
      id: "msg_2",
      author: "user",
      text: "Second",
      timestamp: 2000,
      read: false,
    } as ChatMessage);

    const msgs: ChatMessage[] = [];
    chatMap.forEach((v) => msgs.push(v as ChatMessage));
    msgs.sort((a, b) => a.timestamp - b.timestamp);

    expect(msgs[0].text).toBe("First");
    expect(msgs[1].text).toBe("Second");
    expect(msgs[2].text).toBe("Third");
  });
});

describe("chat message document context", () => {
  it("messages can reference a specific document", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_docctx_1__");
    const chatMap = ctrlDoc.getMap("chat");

    const msg: ChatMessage = {
      id: generateMessageId(),
      author: "user",
      text: "Look at this in the report",
      timestamp: Date.now(),
      documentId: "report-doc-123",
      read: false,
    };
    chatMap.set(msg.id, msg);

    const stored = chatMap.get(msg.id) as ChatMessage;
    expect(stored.documentId).toBe("report-doc-123");
  });

  it("messages can include text anchors", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_anchor_1__");
    const chatMap = ctrlDoc.getMap("chat");

    const msg: ChatMessage = {
      id: generateMessageId(),
      author: "user",
      text: "What about this sentence?",
      timestamp: Date.now(),
      anchor: { from: 10, to: 25, text: "selected text here" },
      read: false,
    };
    chatMap.set(msg.id, msg);

    const stored = chatMap.get(msg.id) as ChatMessage;
    expect(stored.anchor).toBeDefined();
    expect(stored.anchor!.text).toBe("selected text here");
    expect(stored.anchor!.from).toBe(10);
    expect(stored.anchor!.to).toBe(25);
  });
});

describe("chat message reply threading", () => {
  it("builds a conversation thread via replyTo", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_thread_1__");
    const chatMap = ctrlDoc.getMap("chat");

    const msg1: ChatMessage = {
      id: "msg_thread_1",
      author: "user",
      text: "Can you fix this?",
      timestamp: 1000,
      read: true,
    };
    chatMap.set(msg1.id, msg1);

    const msg2: ChatMessage = {
      id: "msg_thread_2",
      author: "claude",
      text: "I'll take a look.",
      timestamp: 2000,
      replyTo: "msg_thread_1",
      read: true,
    };
    chatMap.set(msg2.id, msg2);

    const msg3: ChatMessage = {
      id: "msg_thread_3",
      author: "user",
      text: "Thanks!",
      timestamp: 3000,
      replyTo: "msg_thread_2",
      read: false,
    };
    chatMap.set(msg3.id, msg3);

    // Verify the thread chain
    const stored2 = chatMap.get("msg_thread_2") as ChatMessage;
    const stored3 = chatMap.get("msg_thread_3") as ChatMessage;
    expect(stored2.replyTo).toBe("msg_thread_1");
    expect(stored3.replyTo).toBe("msg_thread_2");
  });
});

describe("chat mixed author messages", () => {
  it("separates user and claude messages in inbox", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_mixed_1__");
    const chatMap = ctrlDoc.getMap("chat");

    chatMap.set("u1", {
      id: "u1",
      author: "user",
      text: "User msg 1",
      timestamp: 1000,
      read: false,
    } as ChatMessage);
    chatMap.set("c1", {
      id: "c1",
      author: "claude",
      text: "Claude msg 1",
      timestamp: 2000,
      read: true,
    } as ChatMessage);
    chatMap.set("u2", {
      id: "u2",
      author: "user",
      text: "User msg 2",
      timestamp: 3000,
      read: false,
    } as ChatMessage);

    const unreadUser: ChatMessage[] = [];
    chatMap.forEach((v) => {
      const m = v as ChatMessage;
      if (m.author === "user" && !m.read) unreadUser.push(m);
    });

    expect(unreadUser).toHaveLength(2);
    expect(unreadUser.every((m) => m.author === "user")).toBe(true);
  });
});
