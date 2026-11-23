/**
 * The `/api/channel-reply` permit (#2358 PR 4b, ships dark; ADR-054's
 * amendment of that name; ownership design §9.2, §9.3, R1.3, R3.3, R4.8).
 *
 * With ownership on, the route maps the shim's `X-Claude-Session-Id` in
 * ownership design §9.1's order and judges the reply by `tandem_reply`'s
 * rule, before the greeting classifier and the append:
 *
 * - Tandem's Claude's current session id, bound or not: refused, `unlinked`
 *   (a header is never enough to act as Tandem's Claude, R3.3);
 * - a live `claude:<id>` record: accepted or refused as that record (replies,
 *   acknowledgements and posts, ownership design §7.3, §5.5), and an accepted
 *   reply claims, owns and answers as `tandem_reply`'s does;
 * - unmapped (no header, no live record, an earlier child's id): refused,
 *   `chat` naming Tandem's Claude when the message is Tandem's Claude's,
 *   otherwise `unlinked` (ownership design §9.3).
 *
 * A refusal is HTTP 409 with the `NOT_DOC_OWNER` body and writes nothing: no
 * row, no read stamp, no listener told, no round closed. Flag off, the route
 * is master's.
 *
 * The world: the real route through the route recorder, the real chat side
 * and registry, records made as a transport's `initialize` makes them.
 *
 * Platform: none; registry-only documents, no sockets.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { addDoc, removeDoc } from "../../src/server/documents/registry-testing.js";
import {
  keyedDeliveryRoundsForTests,
  resetDeliveryStateForTests,
} from "../../src/server/events/delivery-state.js";
import {
  documentWaiting,
  handOverDocumentInbox,
  onTandemReply,
  ownershipChatSide,
  resetInbox,
} from "../../src/server/mcp/awareness.js";
import {
  CHANNEL_REPLY_GATE_FAILED,
  registerChannelRoutes,
} from "../../src/server/mcp/channel-routes.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  getDocOwner,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setOwnershipTransportMode,
  setOwnSpawnSource,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { UNLINKED_REPLY } from "../../src/server/sessions/ownership-refusal.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { API_CHANNEL_REPLY } from "../../src/shared/api-paths.js";
import { CTRL_ROOM, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";
import type { ChatMessage } from "../../src/shared/types.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { callRoute, makeRecorderApp } from "../helpers/route-recorder.js";

/** Header values, and the records they name. */
const ID_A = "shim-a";
const ID_B = "shim-b";
const A = `claude:${ID_A}`;
const B = `claude:${ID_B}`;

let view: TransportViewEntry[];
let run = 0;
let clock = 1_000;
const docIds: string[] = [];
let heard: unknown[][];
let offHeard: (() => void) | undefined;

const ctrl = () => getOrCreateDocument(CTRL_ROOM);
const chatMap = () => ctrl().getMap(Y_MAP_CHAT);
const row = (id: string) => chatMap().get(id) as ChatMessage | undefined;
const claudeRows = () =>
  [...chatMap().values()].filter((m) => (m as ChatMessage).author === "claude");

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

function mkDoc(name: string): { id: string; ydoc: Y.Doc } {
  const id = `chreply${run}-${name}`;
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document.");
  }
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  docIds.push(id);
  return { id, ydoc };
}

function hold(documentId: string, ownerId: string): void {
  setDocOwner(documentId, { ownerId, kind: "claimed" }, "claim", ownerId);
}

/** An unread user chat message, written from the browser. */
function userChat(name: string, documentId?: string): string {
  const id = `chreply${run}-${name}`;
  withBrowser(ctrl(), () =>
    chatMap().set(id, {
      id,
      author: "user",
      text: `text of ${id}`,
      timestamp: clock++,
      read: false,
      ...(documentId !== undefined ? { documentId } : {}),
    }),
  );
  return id;
}

function clearChat(): void {
  withInternal(ctrl(), () => {
    for (const k of [...chatMap().keys()]) chatMap().delete(k);
  });
}

interface Reply {
  status: number;
  body: {
    sent?: boolean;
    messageId?: string;
    error?: string;
    message?: string;
    details?: { reason?: string; holder?: { displayKind: string } | null; documentId?: string };
  };
}

/** A reply through the channel shim, sending `sessionId` as `X-Claude-Session-Id` (none if undefined). */
function shimReply(sessionId: string | undefined, body: Record<string, unknown>): Reply {
  const { app, routes } = makeRecorderApp();
  registerChannelRoutes(app as never, (() => {}) as never);
  const res = callRoute(
    routes,
    `POST ${API_CHANNEL_REPLY}`,
    { text: "via the shim", ...body },
    sessionId === undefined ? {} : { "x-claude-session-id": sessionId },
  );
  return { status: res._status ?? 200, body: res._body as Reply["body"] };
}

/** Expect a refusal that wrote nothing: no Claude row, nothing read, no listener told. */
function expectNothingWritten(r: Reply, before: number, messages: string[] = []): void {
  expect(r.status, JSON.stringify(r.body)).toBe(409);
  expect(r.body.error).toBe("NOT_DOC_OWNER");
  expect(r.body).not.toHaveProperty("messageId");
  expect(claudeRows()).toHaveLength(before);
  for (const m of messages) expect(row(m)?.read).toBe(false);
  expect(heard).toEqual([]);
}

beforeEach(() => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  run++;
  resetInbox();
  resetOwnershipForTests();
  resetDeliveryStateForTests();
  clearChat();
  view = [];
  setOwnershipTransportMode("http");
  setTransportView(() => view);
  setTandemPresenceSource(() => false);
  // The lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setWaitingProbe(documentWaiting);
  setOpenDocumentIdsSource(() => getOpenDocs().keys());
  setOwnershipChatSide(ownershipChatSide);
  setCtrlMode("tandem");
  heard = [];
  offHeard = onTandemReply((...args: unknown[]) => {
    heard.push(args);
  });
});

afterEach(() => {
  offHeard?.();
  offHeard = undefined;
  for (const id of docIds.splice(0)) removeDoc(id);
  resetOwnershipForTests();
  resetInbox();
  resetDeliveryStateForTests();
  setWaitingProbe(() => false);
  clearChat();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a mapped shim is judged as its record (ownership design §9.2, §7.3)", () => {
  it("answers a message on a document its record holds: accepted, stamped with the message's document, read, and A is its answerer", () => {
    register(A);
    register(B);
    const d = mkDoc("held");
    hold(d.id, A);
    const m = userChat("m", d.id);
    const r = shimReply(ID_A, { replyTo: m });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sent).toBe(true);
    const reply = row(r.body.messageId as string);
    expect(reply).toMatchObject({ author: "claude", replyTo: m, documentId: d.id });
    expect(row(m)?.read).toBe(true);
    expect(heard).toEqual([[ID_A, false]]);
    // `apply` ran: A answered it and wrote the row.
    const snap = ownershipSnapshotForTests();
    expect(snap.chatAnswerers).toEqual([[m, A]]);
    expect(snap.repliers).toEqual([[r.body.messageId, A]]);
    // Answered once (ownership design §5.5): the document moves to B, whose
    // shim may not answer it again.
    setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
    heard = [];
    const before = claudeRows().length;
    const again = shimReply(ID_B, { replyTo: m });
    expect(again.body.details?.reason).toBe("answered");
    expectNothingWritten(again, before);
  });

  it("a message on a document another record holds is refused with `chat` naming its holder, and its round stays open", () => {
    register(A);
    register(B);
    const d = mkDoc("b-held");
    hold(d.id, B);
    const m = userChat("m", d.id);
    const roundsBefore = keyedDeliveryRoundsForTests();
    const r = shimReply(ID_A, { replyTo: m, inProgress: true });
    expect(r.body.details).toMatchObject({ reason: "chat", documentId: d.id });
    expect(r.body.details?.holder?.displayKind).toBe("terminal");
    expectNothingWritten(r, 0, [m]);
    expect(keyedDeliveryRoundsForTests()).toEqual(roundsBefore);
  });

  it("an acknowledgement of a message on an open, unowned document claims the document", () => {
    register(A);
    const d = mkDoc("free");
    const m = userChat("m", d.id);
    const r = shimReply(ID_A, { replyTo: m, inProgress: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(row(r.body.messageId as string)).toMatchObject({ inProgress: true, documentId: d.id });
    expect(getDocOwner(d.id)?.ownerId).toBe(A);
  });

  it("a doc-less message with Tandem's Claude not present: the reply makes A its per-message owner, and B's shim is then refused", () => {
    register(A);
    register(B);
    const m = userChat("m");
    expect(shimReply(ID_A, { replyTo: m, inProgress: true }).status).toBe(200);
    expect(ownershipSnapshotForTests().messageOwners.map(([k, o]) => [k, o.ownerId])).toEqual([
      [m, A],
    ]);
    heard = [];
    const before = claudeRows().length;
    const r = shimReply(ID_B, { replyTo: m });
    expect(r.body.details?.reason).toBe("chat");
    expectNothingWritten(r, before);
  });

  it("a documentId that is not the message's is the caller's mistake: 400, nothing written", () => {
    register(A);
    const d = mkDoc("held");
    hold(d.id, A);
    const m = userChat("m", d.id);
    const r = shimReply(ID_A, { replyTo: m, documentId: "some-other-doc" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("INVALID_ARGUMENT");
    expect(claudeRows()).toHaveLength(0);
    expect(row(m)?.read).toBe(false);
  });

  it("posts: doc-less while Tandem's Claude is present is refused with `post`; absent, accepted; on a held document, stamped with it", () => {
    register(A);
    setTandemPresenceSource(() => true);
    const refused = shimReply(ID_A, {});
    expect(refused.body.details?.reason).toBe("post");
    expect(refused.body.details?.holder?.displayKind).toBe("Tandem's Claude");
    expectNothingWritten(refused, 0);
    setTandemPresenceSource(() => false);
    const docless = shimReply(ID_A, {});
    expect(docless.status).toBe(200);
    expect(row(docless.body.messageId as string)).not.toHaveProperty("documentId");
    const d = mkDoc("held");
    hold(d.id, A);
    const onDoc = shimReply(ID_A, { documentId: d.id });
    expect(onDoc.status).toBe(200);
    expect(row(onDoc.body.messageId as string)?.documentId).toBe(d.id);
    // The document is judged open: with Tandem's Claude present, a post on a
    // document A holds is still A's to make.
    setTandemPresenceSource(() => true);
    const onDocPresent = shimReply(ID_A, { documentId: d.id });
    expect(onDocPresent.status, JSON.stringify(onDocPresent.body)).toBe(200);
    expect(row(onDocPresent.body.messageId as string)?.documentId).toBe(d.id);
  });

  it("an acknowledgement is not an answer: it sets no answerer, and the final reply that follows does", () => {
    register(A);
    const d = mkDoc("held");
    hold(d.id, A);
    const m = userChat("m", d.id);
    expect(shimReply(ID_A, { replyTo: m, inProgress: true }).status).toBe(200);
    expect(ownershipSnapshotForTests().chatAnswerers).toEqual([]);
    expect(shimReply(ID_A, { replyTo: m }).status).toBe(200);
    expect(ownershipSnapshotForTests().chatAnswerers).toEqual([[m, A]]);
  });
});

describe("an unmapped shim (ownership design §9.2, §9.3)", () => {
  for (const [label, header] of [
    ["no header", undefined],
    ["a session id no record carries", "shim-nobody"],
  ] as const) {
    it(`${label}: a reply to Tandem's Claude's message is refused with \`chat\` naming Tandem's Claude`, () => {
      setTandemPresenceSource(() => true);
      const m = userChat("m");
      const r = shimReply(header, { replyTo: m });
      expect(r.body.details).toMatchObject({ reason: "chat" });
      expect(r.body.details?.holder?.displayKind).toBe("Tandem's Claude");
      expectNothingWritten(r, 0, [m]);
    });

    it(`${label}: a reply to any other message, and a post, are refused with \`unlinked\``, () => {
      register(A);
      const d = mkDoc("a-held");
      hold(d.id, A);
      const onA = userChat("on-a", d.id);
      const claimable = userChat("claimable");
      const r = shimReply(header, { replyTo: onA });
      expect(r.body).toEqual({
        error: "NOT_DOC_OWNER",
        message: UNLINKED_REPLY,
        details: { reason: "unlinked", holder: null, documentId: d.id },
      });
      expectNothingWritten(r, 0, [onA]);
      const r2 = shimReply(header, { replyTo: claimable, inProgress: true });
      expect(r2.body.details).toEqual({ reason: "unlinked", holder: null });
      expectNothingWritten(r2, 0, [claimable]);
      const post = shimReply(header, {});
      expect(post.body.details).toEqual({ reason: "unlinked", holder: null });
      expectNothingWritten(post, 0);
      // The remedy leads to the `tandem` server's own `tandem_reply`.
      expect(UNLINKED_REPLY).toContain("`tandem` server's `tandem_reply`");
    });
  }
});

describe("Tandem's Claude's session id never acts as Tandem's Claude (R3.3)", () => {
  const CHILD = "child-current";
  const OLD = "child-old";

  function world(present: { value: boolean }, spawn: { value: boolean }) {
    setTandemPresenceSource(() => present.value);
    setOwnSpawnSource(
      () => (spawn.value ? { n: 3, sessionId: CHILD } : null),
      (id) => id === CHILD || id === OLD,
    );
    const dT = mkDoc("tandem");
    setDocOwner(dT.id, { ownerId: TANDEM_OWNER_ID, kind: "default" }, "claim", TANDEM_OWNER_ID);
    return { onTandem: userChat("on-tandem", dT.id), docless: userChat("docless") };
  }

  it("bound (present): refused with `unlinked`, even on Tandem's Claude's own message and for a post", () => {
    const { onTandem, docless } = world({ value: true }, { value: true });
    for (const body of [{ replyTo: onTandem }, { replyTo: docless }, {}]) {
      const r = shimReply(CHILD, body);
      expect(r.body.message).toBe(UNLINKED_REPLY);
      expectNothingWritten(r, 0, [onTandem, docless]);
    }
    // The case-folded id is the same id.
    expect(shimReply(CHILD.toUpperCase(), { replyTo: docless }).body.message).toBe(UNLINKED_REPLY);
  });

  it("unbound: refused with `unlinked` too, never as the spawn's unbound-child record", () => {
    const { docless } = world({ value: false }, { value: true });
    // Tandem's Claude is not present, so the doc-less message is claimable:
    // a mapped record could take it; the child's id may not.
    const r = shimReply(CHILD, { replyTo: docless });
    expect(r.body.message).toBe(UNLINKED_REPLY);
    expectNothingWritten(r, 0, [docless]);
  });

  it("an earlier child's id is unmapped, never through rule 2: `chat` on Tandem's Claude's message, else `unlinked`", () => {
    const spawn = { value: true };
    const { onTandem } = world({ value: true }, spawn);
    // A `claude:` record under the old child's id must not map its reply.
    register(`claude:${OLD}`);
    const r = shimReply(OLD, { replyTo: onTandem });
    expect(r.body.details).toMatchObject({ reason: "chat" });
    expect(r.body.details?.holder?.displayKind).toBe("Tandem's Claude");
    expectNothingWritten(r, 0, [onTandem]);
    spawn.value = false;
    expect(shimReply(OLD, {}).body.message).toBe(UNLINKED_REPLY);
  });
});

describe("a throw inside the permit", () => {
  it("is a structured 500 INTERNAL_ERROR, never Express's default, and writes, stamps and tells nothing", () => {
    register(A);
    const m = userChat("m");
    setOwnershipChatSide({
      ...ownershipChatSide,
      message: () => {
        throw new Error("chat side exploded");
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = shimReply(ID_A, { replyTo: m });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "INTERNAL_ERROR", message: CHANNEL_REPLY_GATE_FAILED });
    expect(claudeRows()).toHaveLength(0);
    expect(row(m)?.read).toBe(false);
    expect(heard).toEqual([]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("chat side exploded"));
  });
});

describe("dark: master's route", () => {
  it("flag off, a header-less shim answers a message, stamped with the body's document, changing no ownership state and logging nothing", () => {
    // State that would refuse it flag on: B holds the message's document.
    register(B);
    const d = mkDoc("doc");
    hold(d.id, B);
    const m = userChat("m", d.id);
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const logged = [
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
    ];
    const ownershipBefore = ownershipSnapshotForTests();
    const r = shimReply(undefined, { replyTo: m, documentId: "the-body-says" });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["messageId", "sent"]);
    expect(row(r.body.messageId as string)).toMatchObject({
      author: "claude",
      replyTo: m,
      documentId: "the-body-says",
    });
    expect(row(m)?.read).toBe(true);
    expect(heard).toEqual([[undefined]]);
    // Ownership is not consulted: nothing in it moved.
    expect(ownershipSnapshotForTests()).toEqual(ownershipBefore);
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });
});
