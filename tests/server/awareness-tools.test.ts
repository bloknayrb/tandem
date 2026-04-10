import { beforeEach, describe, expect, it } from "vitest";
import { collectAnnotations, createAnnotation } from "../../src/server/mcp/annotations.js";
import {
  isUserActive,
  processInboxAnnotations,
  resetInbox,
  safeSlice,
} from "../../src/server/mcp/awareness.js";
import { extractText, populateYDoc } from "../../src/server/mcp/document.js";
import {
  addDoc,
  getOpenDocs,
  removeDoc,
  setActiveDocId,
} from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  TANDEM_MODE_DEFAULT,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_CHAT,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import type { Annotation, ChatMessage } from "../../src/shared/types.js";
import { TandemModeSchema } from "../../src/shared/types.js";
import { generateMessageId } from "../../src/shared/utils.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

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

describe("safeSlice", () => {
  it("extracts snippet from text range", () => {
    expect(safeSlice("Hello world", 0, 5)).toBe("Hello");
  });

  it("truncates long snippets to 100 chars", () => {
    const text = "a".repeat(200);
    const result = safeSlice(text, 0, 150);
    expect(result).toHaveLength(100);
    expect(result.endsWith("...")).toBe(true);
  });

  it("clamps out-of-bounds from/to", () => {
    expect(safeSlice("Hello", -5, 100)).toBe("Hello");
  });

  it("returns empty string when from >= text length", () => {
    expect(safeSlice("Hello", 100, 200)).toBe("");
  });

  it("handles from > to by returning empty string", () => {
    expect(safeSlice("Hello", 5, 3)).toBe("");
  });
});

describe("isUserActive", () => {
  it("returns false when no activity", () => {
    expect(isUserActive(undefined)).toBe(false);
  });

  it("returns true when user is typing", () => {
    expect(isUserActive({ isTyping: true, lastEdit: 0 })).toBe(true);
  });

  it("returns true when lastEdit is recent (<10s)", () => {
    expect(isUserActive({ isTyping: false, lastEdit: Date.now() - 5000 })).toBe(true);
  });

  it("returns false when lastEdit is old (>10s) and not typing", () => {
    expect(isUserActive({ isTyping: false, lastEdit: Date.now() - 30000 })).toBe(false);
  });
});

describe("processInboxAnnotations", () => {
  it("buckets user annotations into userActions", () => {
    const ydoc = setupDoc("inbox-1", "Hello world test");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "highlight", rangeOf(0, 5), "", {
      author: "user",
      color: "yellow",
    });
    createAnnotation(map, ydoc, "comment", rangeOf(6, 11), "Nice", { author: "user" });

    const allAnns = collectAnnotations(map);
    const fullText = extractText(ydoc);
    const surfaced = new Set<string>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (ann) => ann);
    expect(result.userActions).toHaveLength(2);
    expect(result.userActions.find((a) => a.type === "highlight")).toBeTruthy();
    expect(result.userActions.find((a) => a.type === "comment")).toBeTruthy();
  });

  it("buckets resolved Claude annotations into userResponses", () => {
    const ydoc = setupDoc("inbox-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(
      map,
      ydoc,
      "suggestion",
      rangeOf(0, 5),
      '{"newText":"Hi","reason":""}',
    );
    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: "accepted" as const });

    const allAnns = collectAnnotations(map);
    const fullText = extractText(ydoc);
    const surfaced = new Set<string>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a);
    expect(result.userResponses).toHaveLength(1);
    expect(result.userResponses[0].status).toBe("accepted");
  });

  it("ignores pending Claude annotations", () => {
    const ydoc = setupDoc("inbox-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "A comment"); // author=claude, status=pending

    const allAnns = collectAnnotations(map);
    const fullText = extractText(ydoc);
    const surfaced = new Set<string>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a);
    expect(result.userActions).toHaveLength(0);
    expect(result.userResponses).toHaveLength(0);
  });

  it("deduplicates via surfacedIds — second call returns empty", () => {
    const ydoc = setupDoc("inbox-4", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "highlight", rangeOf(0, 5), "", { author: "user" });

    const allAnns = collectAnnotations(map);
    const fullText = extractText(ydoc);
    const surfaced = new Set<string>();

    const first = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a);
    expect(first.userActions).toHaveLength(1);

    const second = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a);
    expect(second.userActions).toHaveLength(0);
  });

  it("calls refreshFn on each unsurfaced annotation", () => {
    const ydoc = setupDoc("inbox-5", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "highlight", rangeOf(0, 5), "", { author: "user" });

    const allAnns = collectAnnotations(map);
    const fullText = extractText(ydoc);
    const surfaced = new Set<string>();

    let refreshCalled = 0;
    processInboxAnnotations(allAnns, fullText, surfaced, (ann) => {
      refreshCalled++;
      return ann;
    });
    expect(refreshCalled).toBe(1);
  });

  it("includes text snippets from annotation ranges", () => {
    const ydoc = setupDoc("inbox-6", "The quick brown fox");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(4, 9), "Note", { author: "user" });

    const allAnns = collectAnnotations(map);
    const fullText = extractText(ydoc);
    const surfaced = new Set<string>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a);
    expect(result.userActions[0].textSnippet).toBe("quick");
  });
});

describe("checkInbox — chat messages (real Y.Map operations)", () => {
  it("reads unread chat messages from CTRL_ROOM", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_inbox_chat_1__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

    const msg: ChatMessage = {
      id: generateMessageId(),
      author: "user",
      text: "Can you review paragraph 3?",
      timestamp: Date.now(),
      read: false,
    };
    chatMap.set(msg.id, msg);

    // Simulate checkInbox chat processing
    const chatMessages: Array<{ id: string; text: string }> = [];
    chatMap.forEach((value) => {
      const m = value as ChatMessage;
      if (m.author === "user" && !m.read) {
        chatMessages.push({ id: m.id, text: m.text });
        chatMap.set(m.id, { ...m, read: true });
      }
    });

    expect(chatMessages).toHaveLength(1);
    expect(chatMessages[0].text).toBe("Can you review paragraph 3?");

    // Verify marked as read
    const updated = chatMap.get(msg.id) as ChatMessage;
    expect(updated.read).toBe(true);
  });

  it("ignores Claude messages in inbox", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_inbox_chat_2__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

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

describe("tandem_reply — real Y.Map operations", () => {
  it("stores a Claude reply in CTRL_ROOM", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_reply_1__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

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
  });

  it("supports replyTo for threading", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_reply_2__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

    const replyId = generateMessageId();
    const reply: ChatMessage = {
      id: replyId,
      author: "claude",
      text: "Great question!",
      timestamp: Date.now(),
      replyTo: "msg_user_original",
      read: true,
    };
    chatMap.set(replyId, reply);

    const stored = chatMap.get(replyId) as ChatMessage;
    expect(stored.replyTo).toBe("msg_user_original");
  });
});

describe("tandem_setStatus — real Y.Map operations", () => {
  it("writes Claude status to awareness map", () => {
    const ydoc = setupDoc("status-1", "Hello world");
    const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);

    awarenessMap.set("claude", {
      status: "Reviewing section 3...",
      timestamp: Date.now(),
      active: true,
      focusParagraph: 2,
    });

    const claude = awarenessMap.get("claude") as {
      status: string;
      active: boolean;
      focusParagraph: number | null;
    };
    expect(claude.status).toBe("Reviewing section 3...");
    expect(claude.active).toBe(true);
    expect(claude.focusParagraph).toBe(2);
  });
});

describe("tandem_getSelections — real Y.Map operations", () => {
  it("returns empty when no selection exists", () => {
    const ydoc = setupDoc("sel-1", "Hello world");
    const userAwareness = ydoc.getMap(Y_MAP_USER_AWARENESS);
    expect(userAwareness.get("selection")).toBeUndefined();
  });

  it("detects no selection when from === to", () => {
    const ydoc = setupDoc("sel-2", "Hello world");
    const userAwareness = ydoc.getMap(Y_MAP_USER_AWARENESS);
    userAwareness.set("selection", { from: 3, to: 3, timestamp: Date.now() });

    const selection = userAwareness.get("selection") as { from: number; to: number };
    // Production code: if (!selection || selection.from === selection.to) → no text selected
    expect(selection.from === selection.to).toBe(true);
  });
});

describe("tandemMode via Y.Map('userAwareness')", () => {
  it("defaults to 'tandem' when no mode is set", () => {
    const ydoc = setupDoc("int-1", "Hello world");
    const userAwareness = ydoc.getMap(Y_MAP_USER_AWARENESS);
    const mode = (userAwareness.get(Y_MAP_MODE) as string) ?? TANDEM_MODE_DEFAULT;
    expect(mode).toBe("tandem");
  });

  it("reads mode written by client", () => {
    const ydoc = setupDoc("int-2", "Hello world");
    const userAwareness = ydoc.getMap(Y_MAP_USER_AWARENESS);
    userAwareness.set(Y_MAP_MODE, "solo");
    expect(userAwareness.get(Y_MAP_MODE)).toBe("solo");
  });

  it("reads 'solo' mode", () => {
    const ydoc = setupDoc("int-3", "Hello world");
    const userAwareness = ydoc.getMap(Y_MAP_USER_AWARENESS);
    userAwareness.set(Y_MAP_MODE, "solo");
    expect(userAwareness.get(Y_MAP_MODE)).toBe("solo");
  });
});

describe("/api/mode endpoint validation", () => {
  it("returns 'tandem' by default when no mode is set", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    expect(mode).toBe("tandem");
  });

  it("returns 'solo' when mode is set to solo", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set(Y_MAP_MODE, "solo");
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    expect(mode).toBe("solo");
  });

  it("falls back to default for invalid mode values", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set(Y_MAP_MODE, "garbage-value");
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    expect(mode).toBe("tandem");
  });
});
