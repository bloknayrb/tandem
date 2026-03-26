import { describe, it, expect, beforeEach } from "vitest";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { resetInbox } from "../../src/server/mcp/awareness.js";
import { collectAnnotations } from "../../src/server/mcp/annotations.js";
import {
  addDoc,
  removeDoc,
  setActiveDocId,
  getOpenDocs,
} from "../../src/server/mcp/document-service.js";
import { populateYDoc, extractText } from "../../src/server/mcp/document.js";
import { generateMessageId } from "../../src/shared/utils.js";
import { CTRL_ROOM } from "../../src/shared/constants.js";
import type { Annotation, ChatMessage } from "../../src/shared/types.js";

function setupDoc(id: string, text: string) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  return ydoc;
}

beforeEach(() => {
  resetInbox();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
});

describe("checkInbox logic — user annotations", () => {
  it("surfaces new user highlight", () => {
    const ydoc = setupDoc("inbox-1", "Hello world test");
    const map = ydoc.getMap("annotations");
    const ann: Annotation = {
      id: "ann_user_001",
      author: "user",
      type: "highlight",
      range: { from: 0, to: 5 },
      content: "",
      status: "pending",
      timestamp: Date.now(),
      color: "yellow",
    };
    map.set(ann.id, ann);

    const all = collectAnnotations(map);
    const userActions = all.filter((a) => a.author === "user");
    expect(userActions).toHaveLength(1);
    expect(userActions[0].type).toBe("highlight");
  });

  it("surfaces multiple user annotations of different types", () => {
    const ydoc = setupDoc("inbox-2", "Hello world test");
    const map = ydoc.getMap("annotations");

    for (const type of ["highlight", "comment", "question", "flag"] as const) {
      map.set(`ann_${type}`, {
        id: `ann_${type}`,
        author: "user",
        type,
        range: { from: 0, to: 5 },
        content: `${type} content`,
        status: "pending",
        timestamp: Date.now(),
      });
    }

    const userAnns = collectAnnotations(map).filter((a) => a.author === "user");
    expect(userAnns).toHaveLength(4);
  });
});

describe("checkInbox logic — Claude annotation responses", () => {
  it("surfaces accepted Claude annotations", () => {
    const ydoc = setupDoc("inbox-3", "Hello world");
    const map = ydoc.getMap("annotations");
    map.set("ann_claude_1", {
      id: "ann_claude_1",
      author: "claude",
      type: "suggestion",
      range: { from: 0, to: 5 },
      content: JSON.stringify({ newText: "Hi", reason: "" }),
      status: "accepted",
      timestamp: Date.now(),
    });

    const responses = collectAnnotations(map).filter(
      (a) => a.author === "claude" && a.status !== "pending",
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe("accepted");
  });

  it("ignores still-pending Claude annotations", () => {
    const ydoc = setupDoc("inbox-4", "Hello world");
    const map = ydoc.getMap("annotations");
    map.set("ann_claude_2", {
      id: "ann_claude_2",
      author: "claude",
      type: "comment",
      range: { from: 0, to: 5 },
      content: "A comment",
      status: "pending",
      timestamp: Date.now(),
    });

    const responses = collectAnnotations(map).filter(
      (a) => a.author === "claude" && a.status !== "pending",
    );
    expect(responses).toHaveLength(0);
  });
});

describe("checkInbox logic — text snippet extraction", () => {
  it("extracts snippet from annotation range", () => {
    const ydoc = setupDoc("snippet-1", "The quick brown fox");
    const fullText = extractText(ydoc);

    const snippet = fullText.slice(Math.max(0, 4), Math.min(fullText.length, 9));
    expect(snippet).toBe("quick");
  });

  it("truncates long snippets to 100 chars", () => {
    const longText = "a".repeat(200);
    const ydoc = setupDoc("snippet-2", longText);
    const fullText = extractText(ydoc);

    // Simulate the safeSlice logic from awareness.ts
    const raw = fullText.slice(0, 150);
    const snippet = raw.length > 100 ? raw.slice(0, 97) + "..." : raw;
    expect(snippet).toHaveLength(100);
    expect(snippet.endsWith("...")).toBe(true);
  });
});

describe("checkInbox logic — chat messages", () => {
  it("reads unread chat messages from CTRL_ROOM", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const chatMap = ctrlDoc.getMap("chat");

    const msg: ChatMessage = {
      id: generateMessageId(),
      author: "user",
      text: "Can you review paragraph 3?",
      timestamp: Date.now(),
      read: false,
    };
    chatMap.set(msg.id, msg);

    const unread: ChatMessage[] = [];
    chatMap.forEach((value) => {
      const m = value as ChatMessage;
      if (m.author === "user" && !m.read) unread.push(m);
    });

    expect(unread).toHaveLength(1);
    expect(unread[0].text).toBe("Can you review paragraph 3?");
  });

  it("marks chat messages as read after processing", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const chatMap = ctrlDoc.getMap("chat");

    const msg: ChatMessage = {
      id: "msg_mark_read",
      author: "user",
      text: "Hello",
      timestamp: Date.now(),
      read: false,
    };
    chatMap.set(msg.id, msg);

    // Process: mark as read
    const existing = chatMap.get(msg.id) as ChatMessage;
    chatMap.set(msg.id, { ...existing, read: true });

    const updated = chatMap.get(msg.id) as ChatMessage;
    expect(updated.read).toBe(true);
  });

  it("ignores claude messages in inbox", () => {
    // Use a unique room to avoid leaking state from other tests on CTRL_ROOM
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_ignore_claude__");
    const chatMap = ctrlDoc.getMap("chat");

    chatMap.set("msg_claude_only", {
      id: "msg_claude_only",
      author: "claude",
      text: "I see the issue",
      timestamp: Date.now(),
      read: true,
    } as ChatMessage);

    const unread: ChatMessage[] = [];
    chatMap.forEach((value) => {
      const m = value as ChatMessage;
      if (m.author === "user" && !m.read) unread.push(m);
    });
    expect(unread).toHaveLength(0);
  });
});

describe("checkInbox logic — user activity", () => {
  it("reads user selection from userAwareness map", () => {
    const ydoc = setupDoc("activity-1", "Hello world");
    const userAwareness = ydoc.getMap("userAwareness");

    userAwareness.set("selection", { from: 0, to: 5, timestamp: Date.now() });

    const selection = userAwareness.get("selection") as
      | { from: number; to: number; timestamp: number }
      | undefined;
    expect(selection).toBeDefined();
    expect(selection!.from).toBe(0);
    expect(selection!.to).toBe(5);
  });

  it("detects no selection when from === to", () => {
    const ydoc = setupDoc("activity-2", "Hello world");
    const userAwareness = ydoc.getMap("userAwareness");

    userAwareness.set("selection", { from: 3, to: 3, timestamp: Date.now() });

    const selection = userAwareness.get("selection") as { from: number; to: number } | undefined;
    const hasSelection = selection && selection.from !== selection.to;
    expect(hasSelection).toBeFalsy();
  });

  it("reads typing activity", () => {
    const ydoc = setupDoc("activity-3", "Hello world");
    const userAwareness = ydoc.getMap("userAwareness");

    userAwareness.set("activity", {
      isTyping: true,
      cursor: 5,
      lastEdit: Date.now(),
    });

    const activity = userAwareness.get("activity") as {
      isTyping: boolean;
      cursor: number;
      lastEdit: number;
    };
    expect(activity.isTyping).toBe(true);
    expect(activity.cursor).toBe(5);
  });

  it("considers user inactive when no activity exists", () => {
    const ydoc = setupDoc("activity-4", "Hello world");
    const userAwareness = ydoc.getMap("userAwareness");

    const activity = userAwareness.get("activity") as any;
    expect(activity).toBeUndefined();
  });
});

describe("tandem_reply logic", () => {
  it("stores a Claude reply in CTRL_ROOM chat map", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const chatMap = ctrlDoc.getMap("chat");

    const id = generateMessageId();
    const msg: ChatMessage = {
      id,
      author: "claude",
      text: "Here is my response",
      timestamp: Date.now(),
      read: true,
    };
    chatMap.set(id, msg);

    const stored = chatMap.get(id) as ChatMessage;
    expect(stored.author).toBe("claude");
    expect(stored.text).toBe("Here is my response");
    expect(stored.read).toBe(true);
  });

  it("supports replyTo field for threading", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const chatMap = ctrlDoc.getMap("chat");

    const userMsgId = "msg_user_original";
    const replyId = generateMessageId();
    const reply: ChatMessage = {
      id: replyId,
      author: "claude",
      text: "Great question!",
      timestamp: Date.now(),
      replyTo: userMsgId,
      read: true,
    };
    chatMap.set(replyId, reply);

    const stored = chatMap.get(replyId) as ChatMessage;
    expect(stored.replyTo).toBe(userMsgId);
  });

  it("supports optional documentId context", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const chatMap = ctrlDoc.getMap("chat");

    const id = generateMessageId();
    const msg: ChatMessage = {
      id,
      author: "claude",
      text: "About this document...",
      timestamp: Date.now(),
      documentId: "doc-abc",
      read: true,
    };
    chatMap.set(id, msg);

    const stored = chatMap.get(id) as ChatMessage;
    expect(stored.documentId).toBe("doc-abc");
  });
});

describe("tandem_setStatus logic", () => {
  it("writes Claude status to awareness map", () => {
    const ydoc = setupDoc("status-1", "Hello world");
    const awarenessMap = ydoc.getMap("awareness");

    awarenessMap.set("claude", {
      status: "Reviewing section 3...",
      timestamp: Date.now(),
      active: true,
      focusParagraph: 2,
    });

    const claude = awarenessMap.get("claude") as any;
    expect(claude.status).toBe("Reviewing section 3...");
    expect(claude.active).toBe(true);
    expect(claude.focusParagraph).toBe(2);
  });

  it("allows null focusParagraph", () => {
    const ydoc = setupDoc("status-2", "Hello world");
    const awarenessMap = ydoc.getMap("awareness");

    awarenessMap.set("claude", {
      status: "Idle",
      timestamp: Date.now(),
      active: true,
      focusParagraph: null,
    });

    const claude = awarenessMap.get("claude") as any;
    expect(claude.focusParagraph).toBeNull();
  });
});

describe("tandem_getSelections logic", () => {
  it("returns empty when no selection exists", () => {
    const ydoc = setupDoc("sel-1", "Hello world");
    const userAwareness = ydoc.getMap("userAwareness");

    const selection = userAwareness.get("selection");
    expect(selection).toBeUndefined();
  });

  it("returns selection range when user has selected text", () => {
    const ydoc = setupDoc("sel-2", "Hello world");
    const userAwareness = ydoc.getMap("userAwareness");

    userAwareness.set("selection", { from: 0, to: 5, timestamp: Date.now() });

    const selection = userAwareness.get("selection") as { from: number; to: number };
    expect(selection.from).toBe(0);
    expect(selection.to).toBe(5);
  });
});

describe("tandem_getActivity logic", () => {
  it("detects active user via isTyping", () => {
    const ydoc = setupDoc("act-1", "Hello");
    const userAwareness = ydoc.getMap("userAwareness");

    userAwareness.set("activity", {
      isTyping: true,
      cursor: 3,
      lastEdit: Date.now(),
    });

    const activity = userAwareness.get("activity") as any;
    const isActive = activity.isTyping || Date.now() - activity.lastEdit < 10000;
    expect(isActive).toBe(true);
  });

  it("detects active user via recent lastEdit", () => {
    const ydoc = setupDoc("act-2", "Hello");
    const userAwareness = ydoc.getMap("userAwareness");

    userAwareness.set("activity", {
      isTyping: false,
      cursor: 3,
      lastEdit: Date.now() - 5000, // 5 seconds ago
    });

    const activity = userAwareness.get("activity") as any;
    const isActive = activity.isTyping || Date.now() - activity.lastEdit < 10000;
    expect(isActive).toBe(true);
  });

  it("detects inactive user when lastEdit is old", () => {
    const ydoc = setupDoc("act-3", "Hello");
    const userAwareness = ydoc.getMap("userAwareness");

    userAwareness.set("activity", {
      isTyping: false,
      cursor: 3,
      lastEdit: Date.now() - 30000, // 30 seconds ago
    });

    const activity = userAwareness.get("activity") as any;
    const isActive = activity.isTyping || Date.now() - activity.lastEdit < 10000;
    expect(isActive).toBe(false);
  });
});
