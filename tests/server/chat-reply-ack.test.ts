/**
 * Ack-before-work chat: `inProgress` on a Claude reply, and the read stamp a
 * `replyTo` reply puts on the user message it answers.
 *
 * The stamp is `markUserChatRead`, called by `tandem_reply` and
 * `/api/channel-reply` — deliberately not folded into `appendClaudeChatMessage`,
 * whose third caller, the local-model collaborator, replies to EVERY user chat
 * with `replyTo` set: stamping on its behalf would hide each message from
 * Claude's inbox the moment `BYO_MODELS_ENABLED` flips. The "append alone does not
 * stamp" case below is that caller's exact call shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendClaudeChatMessage,
  markUserChatRead,
  onTandemReply,
  REPLY_TO_UNMATCHED_WARNING,
} from "../../src/server/mcp/awareness.js";
import { registerChannelRoutes } from "../../src/server/mcp/channel-routes.js";
import {
  isGreetingReply,
  setGreetingReplyClassifier,
  snapshotUserChat,
} from "../../src/server/mcp/greeting-reply.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { API_CHANNEL_REPLY } from "../../src/shared/api-paths.js";
import { CTRL_ROOM, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";
import type { ChatMessage } from "../../src/shared/types.js";
import { appendedId } from "../helpers/chat-append.js";
import { callRoute, makeRecorderApp } from "../helpers/route-recorder.js";

function chatMap() {
  return getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT);
}

function seedUser(id: string, read = false): void {
  const doc = getOrCreateDocument(CTRL_ROOM);
  const msg: ChatMessage = { id, author: "user", text: "please", timestamp: Date.now(), read };
  withBrowser(doc, () => chatMap().set(id, msg));
}

function row(id: string): ChatMessage | undefined {
  return chatMap().get(id) as ChatMessage | undefined;
}

beforeEach(() => {
  chatMap().clear();
});

describe("appendClaudeChatMessage", () => {
  it("stores inProgress only when it is true", () => {
    const ack = appendedId(appendClaudeChatMessage("on it", { inProgress: true }));
    const plain = appendedId(appendClaudeChatMessage("done", { inProgress: false }));
    const none = appendedId(appendClaudeChatMessage("hi"));
    expect(row(ack)?.inProgress).toBe(true);
    expect(row(plain)).not.toHaveProperty("inProgress");
    expect(row(none)).not.toHaveProperty("inProgress");
  });

  it("tells no tandem_reply listener (#2197): the local-model collaborator is not Tandem's Claude", () => {
    const seen = vi.fn();
    const off = onTandemReply(seen);
    try {
      appendedId(appendClaudeChatMessage("hello"));
      expect(seen).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("stores greeting only when it is true (#2227)", () => {
    const hello = appendedId(appendClaudeChatMessage("hi", { greeting: true }));
    const plain = appendedId(appendClaudeChatMessage("answer", { greeting: false }));
    expect(row(hello)?.greeting).toBe(true);
    expect(row(plain)).not.toHaveProperty("greeting");
  });

  it("does not stamp the message it replies to (the collaborator's call shape)", () => {
    seedUser("u1");
    appendClaudeChatMessage("streamed answer", { replyTo: "u1" });
    expect(row("u1")?.read).toBe(false);
  });
});

describe("snapshotUserChat (#2227)", () => {
  it("lists user message ids only, and whether any is unread", () => {
    expect(snapshotUserChat()).toEqual({ ids: new Set(), unread: false });
    seedUser("u1", true);
    appendClaudeChatMessage("a Claude row is not the user's");
    expect(snapshotUserChat()).toEqual({ ids: new Set(["u1"]), unread: false });
    seedUser("u2");
    expect(snapshotUserChat()).toEqual({ ids: new Set(["u1", "u2"]), unread: true });
  });
});

describe("isGreetingReply (#2227)", () => {
  const Q = { sessionId: undefined, replyTo: undefined, inProgress: undefined };
  it("is false with nothing registered, and after its own unregister", () => {
    expect(isGreetingReply(Q)).toBe(false);
    const off = setGreetingReplyClassifier(() => true);
    expect(isGreetingReply(Q)).toBe(true);
    off();
    expect(isGreetingReply(Q)).toBe(false);
  });

  it("a stale unregister cannot remove a newer registration", () => {
    const offOld = setGreetingReplyClassifier(() => false);
    const offNew = setGreetingReplyClassifier(() => true);
    offOld();
    expect(isGreetingReply(Q)).toBe(true);
    offNew();
  });

  it("a throwing classifier reads false and is logged", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const off = setGreetingReplyClassifier(() => {
      throw new Error("bug");
    });
    try {
      expect(isGreetingReply(Q)).toBe(false);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      off();
      errSpy.mockRestore();
    }
  });
});

describe("markUserChatRead", () => {
  it("stamps an unread user message and reports the match", () => {
    seedUser("u1");
    expect(markUserChatRead("u1")).toBe(true);
    expect(row("u1")?.read).toBe(true);
  });

  it("reports a match for an already-read user message without writing", () => {
    seedUser("read", true);
    const before = row("read");
    expect(markUserChatRead("read")).toBe(true);
    expect(row("read")).toBe(before);
  });

  it("writes nothing for an unknown, Claude-authored or already-read message", () => {
    seedUser("read", true);
    const claudeId = appendedId(appendClaudeChatMessage("earlier"));
    const before = { read: row("read"), claude: row(claudeId) };

    expect(markUserChatRead("nope")).toBe(false);
    expect(markUserChatRead(claudeId)).toBe(false);
    markUserChatRead("read");

    expect(row("nope")).toBeUndefined();
    expect(row(claudeId)).toBe(before.claude);
    expect(row("read")).toBe(before.read);
  });
});

describe("POST /api/channel-reply", () => {
  type ReplyBody = { messageId?: string; warning?: string; error?: string };

  function postRaw(body: unknown) {
    const { app, routes } = makeRecorderApp();
    registerChannelRoutes(app as never, (() => {}) as never);
    return callRoute(routes, `POST ${API_CHANNEL_REPLY}`, body);
  }

  function post(body: unknown): ReplyBody {
    return postRaw(body)._body as ReplyBody;
  }

  it("tells the greeting's listeners with the shim's session id (#2197): the plugin's shim can be Tandem's own Claude", () => {
    const seen = vi.fn();
    const off = onTandemReply(seen);
    try {
      const { app, routes } = makeRecorderApp();
      registerChannelRoutes(app as never, (() => {}) as never);
      callRoute(
        routes,
        `POST ${API_CHANNEL_REPLY}`,
        { text: "hello" },
        {
          "x-claude-session-id": "0b9c2a4e-1d2f-4a5b-8c6d-7e8f9a0b1c2d",
        },
      );
      expect(seen).toHaveBeenCalledWith("0b9c2a4e-1d2f-4a5b-8c6d-7e8f9a0b1c2d");
      post({ text: "no header" });
      expect(seen).toHaveBeenLastCalledWith(undefined);
      // A refused body writes nothing and tells no one.
      seen.mockClear();
      postRaw({ text: 7 });
      expect(seen).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("asks the greeting classifier with the shim's session id and tags the hello (#2227)", () => {
    const asked: Array<{ sessionId?: string; replyTo?: string; inProgress?: boolean }> = [];
    const off = setGreetingReplyClassifier((q) => {
      asked.push({ sessionId: q.sessionId, replyTo: q.replyTo, inProgress: q.inProgress });
      return q.replyTo === undefined;
    });
    try {
      const { app, routes } = makeRecorderApp();
      registerChannelRoutes(app as never, (() => {}) as never);
      const res = callRoute(
        routes,
        `POST ${API_CHANNEL_REPLY}`,
        { text: "hello" },
        { "x-claude-session-id": "0b9c2a4e-1d2f-4a5b-8c6d-7e8f9a0b1c2d" },
      );
      const hello = (res._body as ReplyBody).messageId;
      expect(row(hello!)?.greeting).toBe(true);
      expect(asked[0]).toEqual({
        sessionId: "0b9c2a4e-1d2f-4a5b-8c6d-7e8f9a0b1c2d",
        replyTo: undefined,
        inProgress: false,
      });
      seedUser("u1");
      const { messageId } = post({ text: "answer", replyTo: "u1" });
      expect(row(messageId!)).not.toHaveProperty("greeting");
    } finally {
      off();
    }
  });

  it("forwards inProgress and stamps the answered message", () => {
    seedUser("u1");
    const { messageId } = post({ text: "on it", replyTo: "u1", inProgress: true });
    expect(row(messageId!)?.inProgress).toBe(true);
    expect(row(messageId!)?.replyTo).toBe("u1");
    expect(row("u1")?.read).toBe(true);
  });

  it("refuses a non-boolean inProgress rather than storing the ack as an answer", () => {
    const before = chatMap().size;
    const res = postRaw({ text: "x", inProgress: "true" });
    expect(res._status).toBe(400);
    expect(chatMap().size).toBe(before);
  });

  it("stores nothing extra for inProgress: false", () => {
    const { messageId } = post({ text: "x", inProgress: false });
    expect(row(messageId!)).not.toHaveProperty("inProgress");
  });

  it("warns when replyTo names no user message, and still sends", () => {
    const body = post({ text: "x", replyTo: "nope" });
    expect(body.warning).toBe(REPLY_TO_UNMATCHED_WARNING);
    expect(row(body.messageId!)?.author).toBe("claude");
  });

  it("ignores a non-string replyTo", () => {
    seedUser("u1");
    const body = post({ text: "x", replyTo: 42 });
    expect(row("u1")?.read).toBe(false);
    expect(body.warning).toBeUndefined();
  });

  it("stamps nothing without a replyTo", () => {
    seedUser("u1");
    post({ text: "a note" });
    expect(row("u1")?.read).toBe(false);
  });
});
