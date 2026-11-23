/**
 * The greeting by bound transport (#2358 PR 3b-2c; ADR-054; ownership design
 * §7.3): what the two reply paths hand the greeting classifier and the reply
 * listeners. Flag on for every test except the dark ones.
 *
 * With ownership on, the real `tandem_reply` tool passes the caller's
 * transport fact — `bound: true` only for a caller on the `tandem` record,
 * which rule 0 gives a transport only once its bind to the current spawn is
 * confirmed — and `/api/channel-reply` passes `bound: false`. The supervisor's
 * classifier (pinned in `launcher/supervisor-turn-delivery.test.ts`) keys on
 * that fact and never on the session id. Here a stand-in classifier answers
 * `bound === true`, so the chat row's `greeting` tag shows the fact reached
 * the append. Flag off, neither path passes the fact at all: the query and
 * the listener call are exactly master's.
 *
 * Platform: none; nothing touches the filesystem but vitest's throwaway
 * app-data dir.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onTandemReply,
  registerAwarenessTools,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import { registerChannelRoutes } from "../../src/server/mcp/channel-routes.js";
import {
  type GreetingReplyQuery,
  resetGreetingReplyClassifierForTesting,
  setGreetingReplyClassifier,
} from "../../src/server/mcp/greeting-reply.js";
import {
  noteTransportRegistered,
  resetOwnershipForTests,
  setOwnershipTransportMode,
  setTandemPresenceSource,
  setTransportView,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { API_CHANNEL_REPLY } from "../../src/shared/api-paths.js";
import { CTRL_ROOM, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { ChatMessage } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { callRoute, makeRecorderApp } from "../helpers/route-recorder.js";

/** Tandem's own child's Claude Code session id, as an unbound transport might carry it. */
const CHILD_SESSION = "0b9c2a4e-1d2f-4a5b-8c6d-7e8f9a0b1c2d";
/** A terminal's record: not bound, whatever session id it carries. */
const TERMINAL = "claude:greeting-terminal";

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs: { ownerId: string; claudeSessionId?: string } = { ownerId: TANDEM_OWNER_ID };
let asked: GreetingReplyQuery[];
let heard: unknown[][];
let offHeard: (() => void) | undefined;

const ctrl = () => getOrCreateDocument(CTRL_ROOM);
const chatMap = () => ctrl().getMap(Y_MAP_CHAT);
const row = (id: string) => chatMap().get(id) as ChatMessage | undefined;

function clearChat(): void {
  withInternal(ctrl(), () => {
    for (const k of [...chatMap().keys()]) chatMap().delete(k);
  });
}

async function build(flag: "1" | ""): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  resetInbox();
  resetOwnershipForTests();
  clearChat();
  setOwnershipTransportMode("http");
  view = [{ ownerId: TERMINAL, openStreams: 0 }];
  setTransportView(() => view);
  noteTransportRegistered(TERMINAL, { recordKind: "claude" });
  setCtrlMode("tandem");
  asked = [];
  heard = [];
  // The stand-in classifier: the transport fact alone decides.
  setGreetingReplyClassifier((q) => {
    asked.push({ ...q });
    return q.bound === true;
  });
  offHeard = onTandemReply((...args: unknown[]) => {
    heard.push(args);
  });
  ({ client, close } = await setupMcpServer([registerAwarenessTools], {
    dispatch: (fn) => asTestCaller(fn, callingAs),
  }));
}

async function replyAs(who: { ownerId: string; claudeSessionId?: string }) {
  callingAs = who;
  const res = parseResult(
    await client.callTool({ name: "tandem_reply", arguments: { text: "Hello from Tandem" } }),
  ) as { error: boolean; data?: { messageId?: string } };
  expect(res.error, JSON.stringify(res)).toBe(false);
  return res.data?.messageId as string;
}

function channelReply(sessionId?: string): string {
  const { app, routes } = makeRecorderApp();
  registerChannelRoutes(app as never, (() => {}) as never);
  const res = callRoute(
    routes,
    `POST ${API_CHANNEL_REPLY}`,
    { text: "Hello from the shim" },
    sessionId === undefined ? {} : { "x-claude-session-id": sessionId },
  );
  return (res._body as { messageId: string }).messageId;
}

beforeEach(async () => {
  await build("1");
});

afterEach(async () => {
  await close?.();
  close = undefined;
  offHeard?.();
  offHeard = undefined;
  resetGreetingReplyClassifierForTesting();
  resetOwnershipForTests();
  resetInbox();
  clearChat();
  vi.unstubAllEnvs();
});

describe("flag on: the reply's transport decides, never its session id", () => {
  it("a reply on the bound transport (the `tandem` record) is the greeting", async () => {
    setTandemPresenceSource(() => true);
    const id = await replyAs({ ownerId: TANDEM_OWNER_ID, claudeSessionId: CHILD_SESSION });
    expect(asked).toEqual([
      { sessionId: CHILD_SESSION, replyTo: undefined, inProgress: undefined, bound: true },
    ]);
    expect(row(id)?.greeting).toBe(true);
    expect(heard).toEqual([[CHILD_SESSION, true]]);
  });

  it("an unbound transport carrying the child's own session id is not the greeting", async () => {
    const id = await replyAs({ ownerId: TERMINAL, claudeSessionId: CHILD_SESSION });
    expect(asked).toEqual([
      { sessionId: CHILD_SESSION, replyTo: undefined, inProgress: undefined, bound: false },
    ]);
    expect(row(id)).not.toHaveProperty("greeting");
    expect(heard).toEqual([[CHILD_SESSION, false]]);
  });

  it("a /api/channel-reply reply is never the greeting, whatever session id it carries", () => {
    const id = channelReply(CHILD_SESSION);
    expect(asked).toEqual([
      { sessionId: CHILD_SESSION, replyTo: undefined, inProgress: false, bound: false },
    ]);
    expect(row(id)).not.toHaveProperty("greeting");
    expect(heard).toEqual([[CHILD_SESSION, false]]);
  });
});

describe("dark: master's classification, byte for byte", () => {
  beforeEach(async () => {
    await close?.();
    offHeard?.();
    await build("");
  });

  it("tandem_reply hands the classifier and the listeners the session id alone", async () => {
    // Even a caller context naming the `tandem` record passes no fact: dark,
    // nothing is ever routed there, and the session id decides as before.
    const id = await replyAs({ ownerId: TANDEM_OWNER_ID, claudeSessionId: CHILD_SESSION });
    expect(asked).toEqual([
      { sessionId: CHILD_SESSION, replyTo: undefined, inProgress: undefined },
    ]);
    expect(Object.keys(asked[0] as object)).not.toContain("bound");
    expect(row(id)).not.toHaveProperty("greeting");
    expect(heard).toEqual([[CHILD_SESSION]]);
  });

  it("/api/channel-reply hands them the session id alone", () => {
    channelReply(CHILD_SESSION);
    expect(asked).toEqual([{ sessionId: CHILD_SESSION, replyTo: undefined, inProgress: false }]);
    expect(Object.keys(asked[0] as object)).not.toContain("bound");
    expect(heard).toEqual([[CHILD_SESSION]]);
  });
});
