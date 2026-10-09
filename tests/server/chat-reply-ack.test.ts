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
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendClaudeChatMessage,
  markUserChatRead,
  REPLY_TO_UNMATCHED_WARNING,
} from "../../src/server/mcp/awareness.js";
import { registerChannelRoutes } from "../../src/server/mcp/channel-routes.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { API_CHANNEL_REPLY } from "../../src/shared/api-paths.js";
import { CTRL_ROOM, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";
import type { ChatMessage } from "../../src/shared/types.js";
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
    const ack = appendClaudeChatMessage("on it", { inProgress: true });
    const plain = appendClaudeChatMessage("done", { inProgress: false });
    const none = appendClaudeChatMessage("hi");
    expect(row(ack)?.inProgress).toBe(true);
    expect(row(plain)).not.toHaveProperty("inProgress");
    expect(row(none)).not.toHaveProperty("inProgress");
  });

  it("does not stamp the message it replies to (the collaborator's call shape)", () => {
    seedUser("u1");
    appendClaudeChatMessage("streamed answer", { replyTo: "u1" });
    expect(row("u1")?.read).toBe(false);
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
    const claudeId = appendClaudeChatMessage("earlier");
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
