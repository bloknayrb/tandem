import { beforeEach, describe, expect, it } from "vitest";
import { getAnnotationEditedChannelKey } from "../../src/server/events/queue.js";
import { collectAnnotations, createAnnotation } from "../../src/server/mcp/annotations.js";
import {
  collectInboxUserReplies,
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
import type { Annotation, AnnotationReply, ChatMessage } from "../../src/shared/types.js";
import { TandemModeSchema } from "../../src/shared/types.js";
import { generateMessageId } from "../../src/shared/utils.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

const DOC_HASH = "sha256:awareness-tools";

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
  it("buckets user comment annotations into userActions (not highlights/notes)", () => {
    const ydoc = setupDoc("inbox-1", "Hello world test");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "highlight", rangeOf(0, 5), "", {
      author: "user",
      color: "yellow",
    });
    createAnnotation(map, ydoc, "comment", rangeOf(6, 11), "Nice", { author: "user" });
    createAnnotation(map, ydoc, "note", rangeOf(0, 3), "private", { author: "user" });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (ann) => ann);
    // Only comments are surfaced; highlights and notes are excluded
    expect(result.userActions).toHaveLength(1);
    expect(result.userActions.find((a) => a.type === "comment")).toBeTruthy();
    expect(result.userActions.find((a) => a.type === "highlight")).toBeUndefined();
    expect(result.userActions.find((a) => a.type === "note")).toBeUndefined();
  });

  it("buckets resolved Claude annotations into userResponses", () => {
    const ydoc = setupDoc("inbox-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "", {
      suggestedText: "Hi",
    });
    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: "accepted" as const });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a);
    expect(result.userResponses).toHaveLength(1);
    expect(result.userResponses[0].status).toBe("accepted");
  });

  it("ignores pending Claude annotations", () => {
    const ydoc = setupDoc("inbox-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "A comment"); // author=claude, status=pending

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a);
    expect(result.userActions).toHaveLength(0);
    expect(result.userResponses).toHaveLength(0);
  });

  it("deduplicates via surfacedIds — second call returns empty", () => {
    const ydoc = setupDoc("inbox-4", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "test", { author: "user" });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const first = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a);
    expect(first.userActions).toHaveLength(1);

    const second = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a);
    expect(second.userActions).toHaveLength(0);
  });

  it("suppresses channel-delivered edits after the original comment was surfaced by polling", () => {
    const ydoc = setupDoc("inbox-edit-channel", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "before", {
      author: "user",
    });

    const surfaced = new Map<string, number>();
    const first = processInboxAnnotations(
      collectAnnotations(map, DOC_HASH),
      extractText(ydoc),
      surfaced,
      (a) => a,
    );
    expect(first.userActions).toHaveLength(1);

    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, content: "after", editedAt: 2000 });

    const second = processInboxAnnotations(
      collectAnnotations(map, DOC_HASH),
      extractText(ydoc),
      surfaced,
      (a) => a,
      "tandem",
      (payloadId) => payloadId === getAnnotationEditedChannelKey(id, 2000),
    );

    expect(second.userActions).toHaveLength(0);
    expect(surfaced.get(id)).toBe(2000);
  });

  it("marks polling-discovered edits when no channel event has delivered them", () => {
    const ydoc = setupDoc("inbox-edit-poll", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "before", {
      author: "user",
    });

    const surfaced = new Map<string, number>();
    processInboxAnnotations(
      collectAnnotations(map, DOC_HASH),
      extractText(ydoc),
      surfaced,
      (a) => a,
    );

    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, content: "after", editedAt: 3000 });

    const second = processInboxAnnotations(
      collectAnnotations(map, DOC_HASH),
      extractText(ydoc),
      surfaced,
      (a) => a,
    );

    expect(second.userActions).toHaveLength(1);
    expect(second.userActions[0].edited).toBe(true);
    expect(surfaced.get(id)).toBe(3000);
  });

  it("calls refreshFn on each unsurfaced annotation", () => {
    const ydoc = setupDoc("inbox-5", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "test", { author: "user" });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

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

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a);
    expect(result.userActions[0].textSnippet).toBe("quick");
  });
});

describe("processInboxAnnotations — WS-A2 Solo hold (kill-experiment A)", () => {
  // The load-bearing invariant: in Solo, a user comment must NOT surface AND
  // must NOT poison the dedup ledger. On the Solo→Tandem flip, the same
  // annotation surfaces on the next poll (pull-driven release). A ledger poison
  // would silently strand it forever — the failure this whole workstream fixes.

  it("holds a user comment in Solo — no surface, no ledger write", () => {
    const ydoc = setupDoc("inbox-solo-hold", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "held", {
      author: "user",
    });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a, "solo");
    expect(result.userActions).toHaveLength(0);
    // Ledger must be untouched — the item stays "unsurfaced" for release.
    expect(surfaced.has(id)).toBe(false);
  });

  it("releases the held comment on the Solo→Tandem flip (surfaces on next poll)", () => {
    const ydoc = setupDoc("inbox-solo-release", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "held", {
      author: "user",
    });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    // Solo poll: held.
    const solo = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a, "solo");
    expect(solo.userActions).toHaveLength(0);

    // Flip to Tandem: same annotation, same ledger — must now surface exactly once.
    const released = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a, "tandem");
    expect(released.userActions).toHaveLength(1);
    expect(released.userActions[0].id).toBe(id);
    expect(surfaced.get(id)).toBe(0);

    // A subsequent Tandem poll dedups normally (proves the release wrote the ledger).
    const again = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a, "tandem");
    expect(again.userActions).toHaveLength(0);
  });

  it("does not hold Claude responses in Solo (only user-authored records are held)", () => {
    const ydoc = setupDoc("inbox-solo-claude", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "claude note", {
      author: "claude",
    });
    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: "accepted" });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a, "solo");
    expect(result.userResponses).toHaveLength(1);
  });

  it("indeterminate mode holds ONLY the persisted heldInSolo marker (fail-closed restart)", () => {
    const ydoc = setupDoc("inbox-indeterminate", "Hello world again");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const heldId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5), "was held", {
      author: "user",
      heldInSolo: true,
    });
    const freshId = createAnnotation(map, ydoc, "comment", rangeOf(6, 11), "not held", {
      author: "user",
    });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (a) => a, "indeterminate");
    // Marked-held stays held; the unmarked user comment surfaces normally.
    const surfacedIds = result.userActions.map((a) => a.id);
    expect(surfacedIds).toContain(freshId);
    expect(surfacedIds).not.toContain(heldId);
    expect(surfaced.has(heldId)).toBe(false);
  });
});

describe("collectInboxUserReplies — WS-A2 reply bucket + Solo hold", () => {
  const commentParent: Annotation = {
    id: "parent-comment",
    author: "user",
    type: "comment",
    range: { from: 0, to: 5 },
    content: "parent",
    status: "pending",
    timestamp: 1000,
  };
  const noteParent: Annotation = { ...commentParent, id: "parent-note", type: "note" };
  const fullText = "Hello world";

  function reply(over: Partial<AnnotationReply>): AnnotationReply {
    return {
      id: "r1",
      annotationId: "parent-comment",
      author: "user",
      text: "a reply",
      timestamp: 2000,
      ...over,
    };
  }

  it("surfaces a user reply once in Tandem, then dedups", () => {
    const replies = [reply({})];
    const ledger = new Set<string>();
    const first = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      ledger,
      "tandem",
    );
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe("r1");
    expect(first[0].textSnippet).toBe("Hello");

    const second = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      ledger,
      "tandem",
    );
    expect(second).toHaveLength(0);
  });

  it("holds a user reply in Solo (no surface, no ledger write) and releases on flip", () => {
    const replies = [reply({})];
    const ledger = new Set<string>();
    const solo = collectInboxUserReplies([commentParent], fullText, () => replies, ledger, "solo");
    expect(solo).toHaveLength(0);
    expect(ledger.has("r1")).toBe(false);

    const released = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      ledger,
      "tandem",
    );
    expect(released).toHaveLength(1);
  });

  it("never surfaces a Claude reply (Claude doesn't need its own replies echoed)", () => {
    const replies = [reply({ id: "rc", author: "claude" })];
    const out = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      new Set(),
      "tandem",
    );
    expect(out).toHaveLength(0);
  });

  it("never surfaces a private reply or a note-thread reply (ADR-027)", () => {
    const privateOnComment = [reply({ id: "rp", private: true })];
    expect(
      collectInboxUserReplies(
        [commentParent],
        fullText,
        () => privateOnComment,
        new Set(),
        "tandem",
      ),
    ).toHaveLength(0);

    // A reply on a note parent must never surface even without the private flag.
    const noteReply = [reply({ id: "rn", annotationId: "parent-note" })];
    expect(
      collectInboxUserReplies([noteParent], fullText, () => noteReply, new Set(), "tandem"),
    ).toHaveLength(0);
  });

  it("dedups a reply already delivered via the push channel", () => {
    const replies = [reply({})];
    const ledger = new Set<string>();
    const out = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      ledger,
      "tandem",
      (id) => id === "r1",
    );
    expect(out).toHaveLength(0);
    expect(ledger.has("r1")).toBe(true); // marked so it stays deduped
  });

  it("indeterminate mode holds only replies carrying the persisted marker", () => {
    const replies = [reply({ id: "held", heldInSolo: true }), reply({ id: "fresh" })];
    const out = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      new Set(),
      "indeterminate",
    );
    const ids = out.map((r) => r.id);
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("held");
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

describe("tandem_status — real Y.Map operations", () => {
  it("writes Claude status to awareness map", () => {
    const ydoc = setupDoc("status-1", "Hello world");
    const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);

    awarenessMap.set("claude", {
      status: "Reviewing section 3...",
      timestamp: Date.now(),
      active: true,
      focusParagraph: 2,
      focusOffset: null,
    });

    const claude = awarenessMap.get("claude") as {
      status: string;
      active: boolean;
      focusParagraph: number | null;
      focusOffset: number | null;
    };
    expect(claude.status).toBe("Reviewing section 3...");
    expect(claude.active).toBe(true);
    expect(claude.focusParagraph).toBe(2);
    expect(claude.focusOffset).toBeNull();
  });

  it("writes focusOffset for character-level cursor positioning", () => {
    const ydoc = setupDoc("status-2", "Hello world, this is a test document.");
    const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);

    awarenessMap.set("claude", {
      status: "Editing at position 15...",
      timestamp: Date.now(),
      active: true,
      focusParagraph: 0,
      focusOffset: 15,
    });

    const claude = awarenessMap.get("claude") as {
      status: string;
      active: boolean;
      focusParagraph: number | null;
      focusOffset: number | null;
    };
    expect(claude.focusOffset).toBe(15);
    expect(claude.focusParagraph).toBe(0);
  });

  it("supports focusOffset without focusParagraph", () => {
    const ydoc = setupDoc("status-3", "Hello world");
    const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);

    awarenessMap.set("claude", {
      status: "Working...",
      timestamp: Date.now(),
      active: true,
      focusParagraph: null,
      focusOffset: 5,
    });

    const claude = awarenessMap.get("claude") as {
      focusParagraph: number | null;
      focusOffset: number | null;
    };
    expect(claude.focusParagraph).toBeNull();
    expect(claude.focusOffset).toBe(5);
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
