/**
 * Change notices and `ownership.changed` (#2358, the change-notice PR; ownership
 * design §6.6 and §4.3 step 3 as that PR's brief rules them).
 *
 * A Claude session is told, in `tandem_checkInbox`'s response, when the set of
 * documents it holds changes, and why. `holding` is the truth; `changed`
 * explains it and may be incomplete. Everything goes through the real
 * `tandem_checkInbox` tool with registered records, each with its own cursor,
 * and both production seams wired as `src/server/index.ts` wires them. The
 * changes under test are made through the paths production uses: a take is a
 * `tandem_open` (or `tandem_scratchpad`), a write's claim a `tandem_comment`, a
 * poll's claim a poll, a tab close `POST /api/close` or `tandem_close`, a lapse
 * the grace (fake timers past `DEFAULT_GRACE_MS`) or the detached-record cap.
 * Setup alone uses `setDocOwner` (the cap's 64 filler records).
 *
 * The client lists tools first, so the SDK client validates every response
 * against the JSON Schema `tools/list` advertised (Ajv, as a real client does).
 *
 * Platform: real files under `os.tmpdir()` joined with `path.join` for
 * `tandem_open`; fixtures elsewhere use synthetic paths and touch no file.
 * Nothing is gated.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import Ajv from "ajv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { z } from "zod";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { unwatchFile } from "../../src/server/file-watcher.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  documentLabelCallsForTests,
  handOverDocumentInbox,
  registerAwarenessTools,
  resetInbox,
  setInboxResponseCorruptorForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { decodeCursor, deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  checkInboxOutputShape,
  checkInboxOwnershipShape,
} from "../../src/server/mcp/output-schemas.js";
import { handleClose } from "../../src/server/mcp/routes/close.js";
import { handleOpen } from "../../src/server/mcp/routes/open.js";
import {
  CHANGE_CAUSES,
  DEFAULT_GRACE_MS,
  getDocOwner,
  MAX_CHANGE_NOTICES,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setChangeNoticeFaultForTests,
  setCompositeObserverForTests,
  setDocOwner,
  setInboxClaimCheckForTests,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTransportView,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import {
  CAUSE_FIELD_DESCRIPTION,
  CHANGE_CAUSE_FACTS,
  CHANGE_FIELD_DESCRIPTION,
  CHANGED_FIELD_DESCRIPTION,
} from "../../src/server/sessions/ownership-refusal.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";
import { makeRes } from "../helpers/route-recorder.js";

/** Set to make the next `resolveDeliveryRound` throw: a throw after the drain point. */
const roundThrows = vi.hoisted(() => ({ next: false }));
vi.mock("../../src/server/events/delivery-state.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/events/delivery-state.js")>();
  return {
    ...real,
    resolveDeliveryRound: (...args: Parameters<typeof real.resolveDeliveryRound>) => {
      if (roundThrows.next) {
        roundThrows.next = false;
        throw new Error("after the drain point");
      }
      return real.resolveDeliveryRound(...args);
    },
  };
});

const A = "claude:change-a";
const B = "claude:change-b";
/** A third record, for setup that must not touch A's or B's queue. */
const C = "claude:change-c";

const TOOK = "another session took it" as const;
const CLOSED = "its tab was closed" as const;
const LAPSED = "Tandem stopped counting this session as attached" as const;
const WROTE = "your write claimed it" as const;
const POLLED = "a poll of yours claimed it" as const;
const OPENED = "you opened or created it" as const;

const inboxSchema = z.object({ ...checkInboxOutputShape, ...checkInboxOwnershipShape });
type Inbox = z.infer<typeof inboxSchema>;
type Changed = NonNullable<Inbox["ownership"]>["changed"];

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;
let run = 0;
let prefix = "";
let tmpDir = "";

const docId = (name: string) => `${prefix}-${name}`;

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

interface Doc {
  id: string;
  ydoc: Y.Doc;
  filePath: string;
}

/** An open in-memory document nobody holds, with a synthetic path. */
function mkDoc(name: string, filePath = `/tmp/${docId(name)}.md`): Doc {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document.");
  }
  addDoc(id, { id, filePath, format: "md", readOnly: false, source: "file" });
  return { id, ydoc, filePath };
}

/** A real file for `tandem_open`. */
function realFile(name: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, "Hello world, this is a test document.\n");
  return filePath;
}

/** A user comment the poll hands out. */
function comment(ydoc: Y.Doc, id: string): void {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: `text of ${id}`,
      status: "pending",
      timestamp: 1000,
      rev: 1,
    }),
  );
}

async function as(owner: string, tool: string, args: Record<string, unknown> = {}) {
  callingAs = owner;
  return parseResult(await client.callTool({ name: tool, arguments: args })) as {
    error: boolean;
    code?: string;
    data?: Record<string, unknown>;
  };
}

async function pollAs(owner: string, args: Record<string, unknown> = {}): Promise<Inbox> {
  callingAs = owner;
  const result = await client.callTool({ name: "tandem_checkInbox", arguments: args });
  expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
  return inboxSchema.parse((result as { structuredContent: unknown }).structuredContent);
}

/** A cursor reader: each poll passes back the cursor its last poll returned. */
function reader(owner: string) {
  let cursor = "start";
  return {
    async poll(args: Record<string, unknown> = {}): Promise<Inbox> {
      const inbox = await pollAs(owner, { cursor, ...args });
      cursor = inbox.cursor;
      return inbox;
    },
    get cursor() {
      return cursor;
    },
  };
}

const changedOf = (inbox: Inbox): Changed => inbox.ownership?.changed ?? [];
const holdingOf = (inbox: Inbox): string[] => [...(inbox.ownership?.holding ?? [])].sort();

type Cause = Changed[number]["cause"];
const gained = (documentId: string, cause: Cause): Changed[number] => ({
  documentId,
  change: "gained",
  cause,
});
const lost = (documentId: string, cause: Cause): Changed[number] => ({
  documentId,
  change: "lost",
  cause,
});

/** A's write on an unowned document: its claim is applied at the outcome. */
async function writeAs(owner: string, doc: { id: string }): Promise<void> {
  const wrote = await as(owner, "tandem_comment", {
    from: 0,
    to: 5,
    text: "a note",
    documentId: doc.id,
  });
  expect(wrote.error, JSON.stringify(wrote)).toBe(false);
}

async function openAs(owner: string, filePath: string): Promise<string> {
  const opened = await as(owner, "tandem_open", { filePath });
  expect(opened.error, JSON.stringify(opened)).toBe(false);
  return opened.data?.documentId as string;
}

/** The user opens a file (`POST /api/open`): the default rule, so unowned. */
async function userOpen(filePath: string): Promise<string> {
  const res = makeRes();
  await handleOpen(
    { body: { filePath }, socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
    res as never,
  );
  expect(res._status, JSON.stringify(res._body)).toBe(200);
  return (res._body as { data: { documentId: string } }).data.documentId;
}

async function closeByRoute(id: string): Promise<void> {
  const res = makeRes();
  await handleClose(
    { body: { documentId: id }, socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
    res as never,
  );
  expect(res._status, JSON.stringify(res._body)).toBe(200);
}

function entryOf(owner: string): TransportViewEntry {
  return view.find((e) => e.ownerId === owner) as TransportViewEntry;
}

/**
 * Lapse `owner` through the grace: its stream drops (`streamEver`, no open
 * stream), or its transport leaves the registry, and fake timers run past
 * `DEFAULT_GRACE_MS`. A record whose transport stays registered survives.
 */
function lapseByGrace(owner: string, how: "stream dropped" | "transport removed"): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  if (how === "transport removed") {
    view = view.filter((e) => e.ownerId !== owner);
  } else {
    const entry = entryOf(owner);
    entry.streamEver = true;
    entry.openStreams = 0;
  }
  noteTransportChanged(owner);
  vi.advanceTimersByTime(DEFAULT_GRACE_MS + 1);
  vi.useRealTimers();
}

/** The stream of `owner` opens again: attached. */
function reattach(owner: string): void {
  const entry = entryOf(owner);
  entry.openStreams = 1;
  noteTransportChanged(owner);
}

/** Past 64 detached records, C's claim re-arms its grace and the cap lapses C (setup). */
function lapsingClaimant(claimant: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  const t0 = Date.now();
  vi.setSystemTime(t0 + 1_000);
  for (let i = 0; i < 64; i++) {
    const id = `claude:change-cap-${i}`;
    register(id);
    setDocOwner(`${prefix}-held-${i}`, { ownerId: id, kind: "opened" }, "take", id);
    const entry = entryOf(id);
    entry.streamEver = true;
    noteTransportChanged(id);
  }
  vi.setSystemTime(t0);
  const c = entryOf(claimant);
  c.streamEver = true;
  noteTransportChanged(claimant);
}

/**
 * The next polls of `owner` with the cursor `r` holds, with `"start"` and with
 * no cursor report none of `drained` again.
 */
async function notReportedAgain(
  owner: string,
  r: { poll(): Promise<Inbox> },
  drained: Changed,
): Promise<void> {
  for (const [how, poll] of [
    ["the returned cursor", () => r.poll()],
    ['"start"', () => pollAs(owner, { cursor: "start" })],
    ["no cursor", () => pollAs(owner)],
  ] as const) {
    const again = changedOf(await poll());
    for (const entry of drained) expect(again, `${how}`).not.toContainEqual(entry);
  }
}

async function buildWorld(flag: "1" | "" = "1"): Promise<void> {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  run++;
  prefix = `change${run}`;
  callingAs = A;
  resetInbox();
  resetOwnershipForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  register(C);
  // The two lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setCtrlMode("tandem");
  // An active document none of the tests' own, so theirs are background ones.
  const front = mkDoc("front");
  setActiveDocId(front.id);
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
  // Cache the advertised output schemas, so the SDK client validates every
  // response against them, as a real client does.
  await client.listTools();
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-change-notices-"));
  await buildWorld();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  roundThrows.next = false;
  setInboxClaimCheckForTests(undefined);
  setInboxResponseCorruptorForTests(undefined);
  setCompositeObserverForTests(undefined);
  setChangeNoticeFaultForTests(undefined);
  for (const [id, doc] of [...getOpenDocs()]) {
    unwatchFile(doc.filePath);
    removeDoc(id);
  }
  resetOwnershipForTests();
  resetInbox();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------

/** `tools/list`'s `tandem_checkInbox` output schema, as advertised. */
async function advertisedInboxSchema(): Promise<Record<string, unknown>> {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "tandem_checkInbox");
  return tool?.outputSchema as Record<string, unknown>;
}

describe("R1: the field", () => {
  it("flag on, tools/list advertises `changed` with its descriptions, its entries closed to other keys", async () => {
    const schema = await advertisedInboxSchema();
    const ownership = (schema.properties as Record<string, Record<string, unknown>>).ownership;
    const props = ownership.properties as Record<string, Record<string, unknown>>;
    expect(ownership.required).toEqual(["holding", "notYours", "changed"]);
    expect(props.changed.description).toBe(CHANGED_FIELD_DESCRIPTION);
    const item = props.changed.items as Record<string, unknown>;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["documentId", "change", "cause"]);
    const fields = item.properties as Record<string, Record<string, unknown>>;
    expect(fields.change.enum).toEqual(["gained", "lost"]);
    expect(fields.change.description).toBe(CHANGE_FIELD_DESCRIPTION);
    expect(fields.cause.enum).toEqual([...CHANGE_CAUSES]);
    expect(fields.cause.description).toBe(CAUSE_FIELD_DESCRIPTION);
  });

  it("flag off, tools/list carries no `changed`", async () => {
    await close?.();
    await buildWorld("");
    const json = JSON.stringify(await advertisedInboxSchema());
    expect(json).not.toContain('"changed"');
    expect(json).not.toContain('"ownership"');
  });

  it("`changed` is [] when there is nothing to report, never absent", async () => {
    const inbox = await reader(A).poll();
    expect(inbox.ownership).toEqual({ holding: [], notYours: [], changed: [] });
  });

  it("the descriptions, exactly", () => {
    expect(CHANGED_FIELD_DESCRIPTION).toBe(
      "Changes, oldest first, to which documents this session held, since the last poll that returned them. `holding` is the truth: when `changed` and `holding` disagree, `holding` is right. `changed` only explains past changes to `holding`, and may be incomplete: after Tandem restarts; after a poll's response did not arrive once its entries were taken from the list (an error in Tandem after the poll ran, rejection by the server or by the client, or loss in transit); past the most recent 100 entries; when recording a change failed; and when Tandem forgot this session and later counted it again under the same identity. Everything that polls as this session (several connections, or agents sharing one) shares one list, so whichever polls first gets the explanation. A poll that names a documentId reports changes on every document, so an entry may name a document that neither `holding` nor `notYours` mentions. It does not change what this session may do; `notYours`, the summary's other sentences and refusals say what it may do.",
    );
    expect(MAX_CHANGE_NOTICES).toBe(100);
    expect(CHANGE_FIELD_DESCRIPTION).toBe(
      '"gained": this session held the document after the change and not before; "lost": it held it before and not after',
    );
    expect(CAUSE_FIELD_DESCRIPTION).toBe(
      'What happened, as a past-tense fact. "your write claimed it": a write of yours claimed it; "a poll of yours claimed it": a tandem_checkInbox poll of yours claimed it; "you opened or created it": an open or create of yours (tandem_open, tandem_scratchpad) made it yours; "another session took it": another session opened or created it and took it; "its tab was closed": its tab was closed; "Tandem stopped counting this session as attached": Tandem stopped counting this session as attached, and this session stopped holding it',
    );
  });

  it("no instruction in `changed`'s descriptions; each fact is past tense and says nothing it may not", () => {
    for (const text of [
      CHANGED_FIELD_DESCRIPTION,
      CHANGE_FIELD_DESCRIPTION,
      CAUSE_FIELD_DESCRIPTION,
      ...Object.values(CHANGE_CAUSE_FACTS),
    ]) {
      for (const word of [
        /\bdo not\b/i,
        /\bdon't\b/i,
        /\bshould\b/i,
        /\bmust\b/i,
        /carry on/i,
        /after this point/i,
        /\bcall tandem_/i,
        /\bstop\b/i,
        /\bleave\b/i,
        /\btell the user\b/i,
        /\breopen\b/i,
      ]) {
        expect(text, `${word} in: ${text}`).not.toMatch(word);
      }
    }
    // The R1.3 points, each named.
    for (const point of [
      "`holding` is the truth",
      "`holding` is right",
      "Tandem restarts",
      "an error in Tandem after the poll ran",
      "rejection by the server or by the client",
      "loss in transit",
      "past the most recent 100 entries",
      "recording a change failed",
      "counted it again under the same identity",
      "shares one list, so whichever polls first gets the explanation",
      "neither `holding` nor `notYours` mentions",
      "It does not change what this session may do",
    ]) {
      expect(CHANGED_FIELD_DESCRIPTION).toContain(point);
    }
    for (const [word, fact] of Object.entries(CHANGE_CAUSE_FACTS)) {
      // Past tense: each word and fact carries a past-tense verb.
      expect(`${word} | ${fact}`).toMatch(/\b(claimed|opened|created|took|was closed|stopped)\b/);
      // Never another session's identity, never the user's choice, never a state now.
      expect(fact).not.toMatch(/owner-|terminal|Claude Desktop|other app|label/i);
      expect(fact).not.toMatch(/\buser\b|\bchose\b/i);
      expect(fact).not.toMatch(/\b(holds|is held|is open|is closed|now)\b/i);
      expect(word).not.toMatch(/^(claim|take|lapse|stale|poll-claim|user-open|take-back)$/);
    }
    const lapse = CHANGE_CAUSE_FACTS[LAPSED];
    expect(lapse).not.toMatch(/released/i);
    expect(lapse).not.toMatch(/Tandem's Claude|unowned|nobody|another/);
    expect(CHANGE_CAUSE_FACTS[POLLED]).not.toMatch(/handed|answer every/i);
    expect(CHANGE_CAUSE_FACTS[OPENED]).toContain("tandem_scratchpad");
    expect(CHANGE_CAUSE_FACTS[TOOK]).toBe("another session opened or created it and took it");
  });

  it("each producible cause, built through its path, validates against the advertised JSON Schema (Ajv) and through both SDKs", async () => {
    const validate = new Ajv({ strict: false }).compile(await advertisedInboxSchema());
    const seen = new Set<string>();
    const check = (inbox: Inbox, raw: unknown) => {
      expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
      for (const entry of changedOf(inbox)) {
        expect(Object.keys(entry).sort()).toEqual(["cause", "change", "documentId"]);
        seen.add(entry.cause);
      }
    };
    const rawPoll = async (owner: string) => {
      callingAs = owner;
      const result = await client.callTool({ name: "tandem_checkInbox", arguments: {} });
      expect(parseResult(result).error, JSON.stringify(result)).toBe(false);
      const raw = (result as { structuredContent: unknown }).structuredContent;
      check(inboxSchema.parse(raw), raw);
    };
    // a write's claim
    const w = mkDoc("w");
    await writeAs(A, w);
    // a poll's claim
    const p = mkDoc("p");
    comment(p.ydoc, "cp");
    // a take, both sides: B claims by writing, A's open takes it
    const t = await userOpen(realFile("t.md"));
    await writeAs(B, { id: t });
    await openAs(A, path.join(tmpDir, "t.md"));
    // a close
    await closeByRoute(w.id);
    await rawPoll(A);
    await rawPoll(B);
    // a lapse
    await writeAs(A, mkDoc("l"));
    lapseByGrace(A, "stream dropped");
    await rawPoll(A);
    expect(seen).toEqual(new Set(CHANGE_CAUSES));
  });
});

describe("R2: which changes queue a notice", () => {
  it("a write's claim: A gained by its write; B reports nothing", async () => {
    const d = mkDoc("d");
    await writeAs(A, d);
    expect(changedOf(await reader(A).poll())).toEqual([gained(d.id, WROTE)]);
    expect(changedOf(await reader(B).poll())).toEqual([]);
  });

  it("a poll's claim: A gained by its poll", async () => {
    const d = mkDoc("d");
    comment(d.ydoc, "c1");
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual([gained(d.id, POLLED)]);
    expect(holdingOf(inbox)).toEqual([d.id]);
    expect(changedOf(await reader(B).poll())).toEqual([]);
  });

  it("a take from unowned: A gained by its open", async () => {
    const id = await userOpen(realFile("u.md"));
    expect(getDocOwner(id)).toBeUndefined();
    await openAs(A, path.join(tmpDir, "u.md"));
    expect(changedOf(await reader(A).poll())).toEqual([gained(id, OPENED)]);
    expect(changedOf(await reader(B).poll())).toEqual([]);
  });

  it("a take from another record: A gained, B lost to another session's open", async () => {
    const file = realFile("t.md");
    const id = await openAs(B, file);
    expect(changedOf(await reader(B).poll())).toEqual([gained(id, OPENED)]);
    // B's hold is `opened`, which nobody can take: make it a claim. B lapses
    // through the grace (its stream drops; it survives), its stream returns,
    // and its own write claims the unowned document.
    lapseByGrace(B, "stream dropped");
    reattach(B);
    expect(changedOf(await reader(B).poll())).toEqual([lost(id, LAPSED)]);
    await writeAs(B, { id });
    expect(changedOf(await reader(B).poll())).toEqual([gained(id, WROTE)]);
    await openAs(A, file);
    expect(changedOf(await reader(A).poll())).toEqual([gained(id, OPENED)]);
    expect(changedOf(await reader(B).poll())).toEqual([lost(id, TOOK)]);
  });

  it("tandem_scratchpad: A gained by its create", async () => {
    const made = await as(A, "tandem_scratchpad", {});
    expect(made.error, JSON.stringify(made)).toBe(false);
    const id = made.data?.documentId as string;
    expect(changedOf(await reader(A).poll())).toEqual([gained(id, OPENED)]);
    expect(changedOf(await reader(B).poll())).toEqual([]);
  });

  it("a lapse through the grace, the record surviving: B lost by the lapse, holding empty", async () => {
    const d = mkDoc("d");
    await writeAs(B, d);
    await reader(B).poll();
    lapseByGrace(B, "stream dropped");
    const inbox = await reader(B).poll();
    expect(changedOf(inbox)).toEqual([lost(d.id, LAPSED)]);
    expect(inbox.ownership?.holding).toEqual([]);
    expect(changedOf(await reader(A).poll())).toEqual([]);
  });

  it("a lapse through the detached-record cap, the record surviving: lost by the lapse", async () => {
    const d = mkDoc("d");
    comment(d.ydoc, "c1");
    lapsingClaimant(C);
    const inbox = await pollAs(C);
    vi.useRealTimers();
    expect(changedOf(inbox)).toEqual([gained(d.id, POLLED), lost(d.id, LAPSED)]);
  });

  for (const via of ["POST /api/close", "tandem_close"] as const) {
    it(`a tab close through ${via}: B lost, its tab was closed`, async () => {
      const d = mkDoc("d");
      await writeAs(B, d);
      await reader(B).poll();
      if (via === "POST /api/close") await closeByRoute(d.id);
      else expect((await as(B, "tandem_close", { documentId: d.id })).error).toBe(false);
      const inbox = await reader(B).poll();
      expect(changedOf(inbox)).toEqual([lost(d.id, CLOSED)]);
      expect(inbox.ownership?.holding).toEqual([]);
      expect(changedOf(await reader(A).poll())).toEqual([]);
    });
  }

  it("R2.1: A's own tandem_open of its claimed document queues nothing for anyone", async () => {
    const file = realFile("own.md");
    const id = await userOpen(file);
    await writeAs(A, { id });
    expect(changedOf(await reader(A).poll())).toEqual([gained(id, WROTE)]);
    expect(getDocOwner(id)?.kind).toBe("claimed");
    await openAs(A, file);
    expect(getDocOwner(id)?.kind).toBe("opened");
    expect(changedOf(await reader(A).poll())).toEqual([]);
    expect(changedOf(await reader(B).poll())).toEqual([]);
  });

  it("R2.2: a write refused on its arguments queues nothing, holding exact", async () => {
    const d = mkDoc("d");
    // An inverted range: refused on its arguments alone, which never claims.
    const refused = await as(A, "tandem_comment", {
      from: 5,
      to: 0,
      text: "inverted",
      documentId: d.id,
    });
    expect(refused.error).toBe(true);
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual([]);
    expect(inbox.ownership?.holding).toEqual([]);
  });

  it("R2.2: a write whose document is closed during it queues nothing, holding exact", async () => {
    const d = mkDoc("d");
    // Close the tab while the write runs: the write's claim is cancelled.
    const unsubscribe = (() => {
      const map = d.ydoc.getMap(Y_MAP_ANNOTATIONS);
      const observer = () => {
        map.unobserve(observer);
        void closeByRoute(d.id);
      };
      map.observe(observer);
      return () => map.unobserve(observer);
    })();
    await as(A, "tandem_comment", { from: 0, to: 5, text: "racing a close", documentId: d.id });
    unsubscribe();
    await vi.waitFor(() => expect(getOpenDocs().has(d.id)).toBe(false));
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual([]);
    expect(inbox.ownership?.holding).toEqual([]);
  });

  it("R2.2: a poll's claim refused at commit queues nothing", async () => {
    const d = mkDoc("d");
    comment(d.ydoc, "c1");
    setInboxClaimCheckForTests((check) => check !== "scope");
    const inbox = await reader(A).poll();
    setInboxClaimCheckForTests(undefined);
    expect(changedOf(inbox)).toEqual([]);
    expect(inbox.ownership?.holding).toEqual([]);
    expect(getDocOwner(d.id)).toBeUndefined();
  });

  it("R2.3: a stale entry cleared by the backstop, then a record under that owner id: its first poll reports []", async () => {
    const ghost = "claude:change-ghost";
    const d = mkDoc("d");
    // Fabricated: no production path writes an entry for a record that does not exist.
    setDocOwner(d.id, { ownerId: ghost, kind: "claimed" }, "claim");
    await writeAs(A, d); // the backstop clears the stale entry, then A claims
    expect(getDocOwner(d.id)?.ownerId).toBe(A);
    register(ghost);
    const inbox = await reader(ghost).poll();
    expect(changedOf(inbox)).toEqual([]);
    expect(changedOf(await reader(A).poll())).toEqual([gained(d.id, WROTE)]);
  });

  it("R2.4: a close of an unowned document queues nothing for anyone", async () => {
    const d = mkDoc("d");
    await closeByRoute(d.id);
    for (const owner of [A, B, C]) expect(changedOf(await reader(owner).poll())).toEqual([]);
  });

  it("R2.4: a reopen queues nothing for the record that held it before the close", async () => {
    const d = mkDoc("d");
    await writeAs(A, d);
    await reader(A).poll();
    await closeByRoute(d.id);
    mkDoc("d");
    expect(changedOf(await reader(A).poll())).toEqual([lost(d.id, CLOSED)]);
    expect(getDocOwner(d.id)).toBeUndefined();
  });

  it("R2.5: a throw in step 3: the change stands, steps 4 and 5 run, holding exact", async () => {
    const d = mkDoc("d");
    const steps: string[] = [];
    setCompositeObserverForTests((step) => steps.push(step));
    setChangeNoticeFaultForTests((at) => {
      if (at === "change") throw new Error("queueing failed");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeAs(A, d);
    setChangeNoticeFaultForTests(undefined);
    setCompositeObserverForTests(undefined);
    expect(steps).toEqual(["loss", "entry", "notices", "publish", "wake"]);
    expect(getDocOwner(d.id)?.ownerId).toBe(A);
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain(
      "[ownership] a document changed hands but its change notice could not be queued; the change stands",
    );
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual([]);
    expect(holdingOf(inbox)).toEqual([d.id]);
  });

  it("R2.4: a throw in the close's queueing: the handover still ran, holding exact", async () => {
    const d = mkDoc("d");
    await writeAs(A, d);
    comment(d.ydoc, "c1");
    expect((await pollAs(A)).userActions.map((x) => x.id)).toEqual(["c1"]);
    const markBefore = new Map(ownershipSnapshotForTests().handoverSeq).get(d.id);
    setChangeNoticeFaultForTests((at) => {
      if (at === "close") throw new Error("queueing failed");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await closeByRoute(d.id);
    setChangeNoticeFaultForTests(undefined);
    expect(new Map(ownershipSnapshotForTests().handoverSeq).get(d.id)).not.toBe(markBefore);
    // The reopened document's comment is re-owed: the handover's inbox half ran.
    const reopened = mkDoc("d");
    comment(reopened.ydoc, "c1");
    const inbox = await pollAs(A);
    expect(inbox.userActions.map((x) => x.id)).toEqual(["c1"]);
    expect(changedOf(inbox)).toEqual([gained(d.id, POLLED)]);
    expect(holdingOf(inbox)).toEqual([d.id]);
  });
});

describe("R3: the property and the cap", () => {
  /** previous holding + changed, in order. */
  function replay(previous: readonly string[], changed: Changed): string[] {
    const held = new Set(previous);
    for (const entry of changed) {
      if (entry.change === "gained") held.add(entry.documentId);
      else held.delete(entry.documentId);
    }
    return [...held].sort();
  }

  it("a scripted run mixing every row: previous holding with changed applied equals holding, after every poll", async () => {
    const a = reader(A);
    const b = reader(B);
    const holding = new Map<string, string[]>([
      [A, []],
      [B, []],
    ]);
    const reported = new Map<string, Set<string>>([
      [A, new Set()],
      [B, new Set()],
    ]);
    const pollBoth = async () => {
      for (const [owner, r] of [
        [A, a],
        [B, b],
      ] as const) {
        const inbox = await r.poll();
        expect(holdingOf(inbox), `${owner}`).toEqual(
          replay(holding.get(owner) ?? [], changedOf(inbox)),
        );
        for (const e of changedOf(inbox)) reported.get(owner)?.add(e.change);
        holding.set(owner, holdingOf(inbox));
      }
    };
    const d1 = mkDoc("d1");
    const d2 = mkDoc("d2");
    const f3 = realFile("d3.md");
    await writeAs(A, d1); // A gained (write)
    await pollBoth();
    comment(d2.ydoc, "c2");
    await pollBoth(); // A's poll claims d2 (poll)
    const d3 = await openAs(B, f3); // B gained (open)
    await pollBoth();
    lapseByGrace(B, "stream dropped"); // B lost (lapse, grace), so B's next hold is a claim
    reattach(B);
    await pollBoth();
    await writeAs(B, { id: d3 });
    await pollBoth();
    await openAs(A, f3); // A gained, B lost (take)
    await pollBoth();
    await closeByRoute(d1.id); // A lost (close)
    await pollBoth();
    const made = await as(A, "tandem_scratchpad", {}); // A gained (create)
    expect(made.error).toBe(false);
    await pollBoth();
    await writeAs(B, mkDoc("d4"));
    await pollBoth();
    lapseByGrace(B, "stream dropped"); // B lost (lapse, grace)
    reattach(B);
    await pollBoth();
    // B lost (lapse, the detached-record cap): B detaches first and holds
    // d5, then 64 records holding documents detach after it; the cap lapses
    // the holder detached longest, B. The fillers are setup.
    await writeAs(B, mkDoc("d5"));
    await pollBoth();
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    entryOf(B).streamEver = true;
    entryOf(B).openStreams = 0;
    noteTransportChanged(B);
    vi.setSystemTime(t0 + 1_000);
    for (let i = 0; i < 64; i++) {
      const id = `claude:change-cap-${i}`;
      register(id);
      setDocOwner(`${prefix}-held-${i}`, { ownerId: id, kind: "opened" }, "take", id);
      entryOf(id).streamEver = true;
      noteTransportChanged(id);
    }
    vi.useRealTimers();
    expect(getDocOwner(docId("d5"))).toBeUndefined();
    await pollBoth();
    for (const owner of [A, B]) expect(reported.get(owner)).toEqual(new Set(["gained", "lost"]));
  });

  it("changes that cancel out are both reported, in order: lost then gained", async () => {
    const file = realFile("d.md");
    const id = await userOpen(file);
    await writeAs(A, { id });
    const a = reader(A);
    expect(changedOf(await a.poll())).toEqual([gained(id, WROTE)]);
    await openAs(B, file); // A lost
    lapseByGrace(B, "stream dropped"); // D goes unowned
    expect(getDocOwner(id)).toBeUndefined();
    await writeAs(A, { id }); // A gained
    const inbox = await a.poll();
    expect(changedOf(inbox)).toEqual([lost(id, TOOK), gained(id, WROTE)]);
    expect(holdingOf(inbox)).toEqual([id]);
  });

  it("the cap: past it the oldest are dropped, the newest reported in order, holding exact", async () => {
    const d = mkDoc("d");
    const file = realFile("cap.md");
    const id = await userOpen(file);
    // Each round: A claims by writing (gained), B's open takes it (lost), the
    // setup lapse makes it unowned again (B's notices, not A's).
    const expected: Changed = [];
    const rounds = MAX_CHANGE_NOTICES / 2 + 5;
    for (let i = 0; i < rounds; i++) {
      await writeAs(A, { id });
      expected.push(gained(id, WROTE));
      await openAs(B, file);
      expected.push(lost(id, TOOK));
      // B lapses through the grace (it survives) and its stream returns:
      // the document is unowned again, and only B's queue hears of it.
      lapseByGrace(B, "stream dropped");
      reattach(B);
    }
    await writeAs(A, d);
    expected.push(gained(d.id, WROTE));
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual(expected.slice(-MAX_CHANGE_NOTICES));
    expect(holdingOf(inbox)).toEqual([d.id]);
  });
});

describe("R4: draining", () => {
  it('after a poll that reported entries: the returned cursor, "start" and no cursor report none again', async () => {
    const d = mkDoc("d");
    await writeAs(A, d);
    const a = reader(A);
    const first = changedOf(await a.poll());
    expect(first).toEqual([gained(d.id, WROTE)]);
    await notReportedAgain(A, a, first);
  });

  it("a cursor-less poll drains", async () => {
    const d = mkDoc("d");
    await writeAs(A, d);
    const first = changedOf(await pollAs(A));
    expect(first).toEqual([gained(d.id, WROTE)]);
    await notReportedAgain(A, reader(A), first);
  });

  it("a poll that fails validation drains nothing: the next poll reports the notices", async () => {
    const d = mkDoc("d");
    await writeAs(A, d);
    vi.spyOn(console, "error").mockImplementation(() => {});
    setInboxResponseCorruptorForTests(() => ({ broken: true }));
    callingAs = A;
    expect(
      parseResult(await client.callTool({ name: "tandem_checkInbox", arguments: {} })).error,
    ).toBe(true);
    setInboxResponseCorruptorForTests(undefined);
    expect(changedOf(await reader(A).poll())).toEqual([gained(d.id, WROTE)]);
  });

  it("a throw after the drain point, on a poll that also claims: given back in order, before a newer notice; the claim stands", async () => {
    const d1 = mkDoc("d1");
    await writeAs(A, d1); // an earlier notice
    const d2 = mkDoc("d2");
    comment(d2.ydoc, "c2"); // this poll claims d2
    roundThrows.next = true;
    callingAs = A;
    const failed = parseResult(await client.callTool({ name: "tandem_checkInbox", arguments: {} }));
    expect(failed.error).toBe(true);
    expect(getDocOwner(d2.id)?.ownerId, "the claim stands").toBe(A);
    const d3 = mkDoc("d3");
    await writeAs(A, d3); // a notice queued after the throw
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual([
      gained(d1.id, WROTE),
      gained(d2.id, POLLED),
      gained(d3.id, WROTE),
    ]);
    expect(holdingOf(inbox)).toEqual([d1.id, d2.id, d3.id].sort());
  });

  it("a named poll of D1 reports a `lost` entry for D2", async () => {
    const d1 = mkDoc("d1");
    const d2 = mkDoc("d2");
    await writeAs(A, d1);
    await writeAs(A, d2);
    await reader(A).poll();
    await closeByRoute(d2.id);
    const inbox = await reader(A).poll({ documentId: d1.id });
    expect(changedOf(inbox)).toEqual([lost(d2.id, CLOSED)]);
    expect(inbox.ownership?.notYours).toEqual([]);
    expect(holdingOf(inbox)).toEqual([d1.id]);
  });

  it("a caller with no record reports [] and drains nobody's queue", async () => {
    const d1 = mkDoc("d1");
    const d2 = mkDoc("d2");
    await writeAs(A, d1);
    const nobody = await reader("claude:change-nobody").poll();
    expect(changedOf(nobody)).toEqual([]);
    await writeAs(A, d2);
    expect(changedOf(await reader(A).poll())).toEqual([gained(d1.id, WROTE), gained(d2.id, WROTE)]);
  });

  it("not in the cursor: two records with the same holdings get byte-identical cursors, one with notices queued", async () => {
    const d = mkDoc("d");
    await writeAs(A, d);
    await closeByRoute(d.id); // A holds nothing, two notices queued
    expect(ownershipSnapshotForTests().changeNotices.map(([o]) => o)).toEqual([A]);
    const a = await pollAs(A, { cursor: "start" });
    const b = await pollAs(B, { cursor: "start" });
    expect(changedOf(a).length).toBeGreaterThan(0);
    expect(changedOf(b)).toEqual([]);
    expect(a.cursor).toBe(b.cursor);
    expect(JSON.stringify(decodeCursor(a.cursor))).not.toContain("gained");
  });

  it("a returned response discarded (lost in transit): the next poll reports none of it, holding exact", async () => {
    const d = mkDoc("d");
    await writeAs(A, d);
    await pollAs(A); // returned, then lost: the test drops it
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual([]);
    expect(holdingOf(inbox)).toEqual([d.id]);
  });
});

describe("R5: a poll's own claims", () => {
  it("in its own response: gained by its poll, in holding, and not reported again", async () => {
    const d = mkDoc("d");
    comment(d.ydoc, "c1");
    const a = reader(A);
    const inbox = await a.poll();
    expect(changedOf(inbox)).toEqual([gained(d.id, POLLED)]);
    expect(holdingOf(inbox)).toEqual([d.id]);
    await notReportedAgain(A, a, changedOf(inbox));
  });

  for (const check of ["claimable", "open", "unowned", "record", "scope"] as const) {
    it(`a claim refused by the ${check} check is in neither field`, async () => {
      const d = mkDoc("d");
      comment(d.ydoc, "c1");
      setInboxClaimCheckForTests((c) => c !== check);
      const inbox = await reader(A).poll();
      setInboxClaimCheckForTests(undefined);
      expect(changedOf(inbox)).toEqual([]);
      expect(inbox.ownership?.holding).toEqual([]);
    });
  }

  it("claim outcome `changed`: gained then lost, holding without it, through both SDKs' validation", async () => {
    const d = mkDoc("d");
    comment(d.ydoc, "c1");
    lapsingClaimant(C);
    const inbox = await pollAs(C);
    vi.useRealTimers();
    expect(changedOf(inbox)).toEqual([gained(d.id, POLLED), lost(d.id, LAPSED)]);
    expect(inbox.ownership?.holding).toEqual([]);
    // A lapse is not named in the summary.
    expect(inbox.summary).not.toContain("You stopped holding");
  });

  it("a queued notice from before comes first, then the poll's own claim", async () => {
    const d1 = mkDoc("d1");
    await writeAs(A, d1);
    const d2 = mkDoc("d2");
    comment(d2.ydoc, "c2");
    expect(changedOf(await reader(A).poll())).toEqual([
      gained(d1.id, WROTE),
      gained(d2.id, POLLED),
    ]);
  });
});

describe("R6: where the state lives and when it goes", () => {
  it("a record whose transport is removed lapses, is deleted, and a new record under its id polls []", async () => {
    const d = mkDoc("d");
    await writeAs(B, d);
    lapseByGrace(B, "transport removed");
    expect(ownershipSnapshotForTests().records.map((r) => r.ownerId)).not.toContain(B);
    expect(ownershipSnapshotForTests().changeNotices.map(([o]) => o)).not.toContain(B);
    register(B);
    expect(changedOf(await reader(B).poll())).toEqual([]);
  });

  it("a record whose only state is queued notices, with no registered transport, is deleted when its grace runs out", async () => {
    const d = mkDoc("d");
    await writeAs(B, d);
    await closeByRoute(d.id); // B holds nothing, one notice queued
    expect(ownershipSnapshotForTests().changeNotices.map(([o]) => o)).toEqual([B]);
    lapseByGrace(B, "transport removed");
    expect(ownershipSnapshotForTests().records.map((r) => r.ownerId)).not.toContain(B);
  });

  it("under the cap, a record holding only queued notices lapses before records that hold documents", async () => {
    const d = mkDoc("d");
    await writeAs(B, d);
    await closeByRoute(d.id); // B holds nothing, one notice queued
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    // B detaches LAST, so by expiry order it would go last; holding nothing, it goes first.
    vi.setSystemTime(t0);
    for (let i = 0; i < 64; i++) {
      const id = `claude:change-cap-${i}`;
      register(id);
      setDocOwner(`${prefix}-held-${i}`, { ownerId: id, kind: "opened" }, "take", id);
      entryOf(id).streamEver = true;
      noteTransportChanged(id);
    }
    vi.setSystemTime(t0 + 1_000);
    entryOf(B).streamEver = true;
    noteTransportChanged(B);
    vi.useRealTimers();
    const b = ownershipSnapshotForTests().records.find((r) => r.ownerId === B);
    expect(b?.lapsed, "B lapsed first").toBe(true);
    const others = ownershipSnapshotForTests().records.filter((r) =>
      r.ownerId.startsWith("claude:change-cap-"),
    );
    expect(others.every((r) => r.lapsed !== true)).toBe(true);
  });

  it("the snapshot exposes the queue, and a reset clears it", async () => {
    const d = mkDoc("d");
    await writeAs(A, d);
    expect(ownershipSnapshotForTests().changeNotices).toEqual([
      [A, [{ documentId: d.id, change: "gained", cause: WROTE }]],
    ]);
    resetOwnershipForTests();
    expect(ownershipSnapshotForTests().changeNotices).toEqual([]);
  });
});

describe("R8: the summary", () => {
  const TOOK_SENTENCE = (name: string) => ` You stopped holding ${name} (another session took it).`;
  const CLOSED_SENTENCE = (name: string) => ` You stopped holding ${name} (its tab was closed).`;

  async function takenFromA(name = "taken.md"): Promise<string> {
    const file = realFile(name);
    const id = await userOpen(file);
    await writeAs(A, { id });
    await reader(A).poll();
    await openAs(B, file);
    return id;
  }

  /**
   * After {@link takenFromA}: B lapses (its stream drops), A's write claims the
   * document again and B's open takes it again, so A has the same take queued
   * once more. Returns the document id.
   */
  async function takenFromAgain(id: string): Promise<string> {
    // The file's path as `tandem_open` stored it (canonical: on Windows a
    // short-name temp directory is expanded), not as this test spelled it.
    const file = getOpenDocs().get(id)?.filePath as string;
    lapseByGrace(B, "stream dropped");
    reattach(B);
    await writeAs(A, { id });
    await openAs(B, file);
    return id;
  }

  it("a poll whose only news is a take: the exact sentence, last, and hasNew false", async () => {
    await takenFromA();
    const inbox = await reader(A).poll();
    expect(inbox.summary.endsWith(TOOK_SENTENCE("taken.md"))).toBe(true);
    expect(inbox.hasNew).toBe(false);
  });

  it("a poll whose only news is a close: the exact sentence, by the file's name, and hasNew false", async () => {
    const d = mkDoc("d", "/tmp/closed-one.md");
    await writeAs(A, d);
    await reader(A).poll();
    await closeByRoute(d.id);
    const inbox = await reader(A).poll();
    expect(inbox.summary.endsWith(CLOSED_SENTENCE("closed-one.md"))).toBe(true);
    expect(inbox.summary).not.toContain(d.id);
    expect(inbox.hasNew).toBe(false);
  });

  it("after inboxExcludedSomeNote (a default poll that read some documents)", async () => {
    const mine = mkDoc("mine");
    await writeAs(A, mine);
    const id = await takenFromA(); // B now holds it: left out of A's poll
    const inbox = await reader(A).poll();
    expect(inbox.ownership?.notYours).toContain(id);
    expect(inbox.summary).toContain("not yours to answer right now");
    expect(inbox.summary.endsWith(TOOK_SENTENCE("taken.md"))).toBe(true);
  });

  it("after inboxExcludedAllNote (a default poll that read none)", async () => {
    // The active document is B's too, so A reads nothing.
    const front = [...getOpenDocs().keys()].find((id) => id.endsWith("-front")) as string;
    await writeAs(B, { id: front });
    await takenFromA();
    const inbox = await reader(A).poll();
    expect(inbox.summary.startsWith("No comments, thread replies")).toBe(true);
    expect(inbox.summary.endsWith(TOOK_SENTENCE("taken.md"))).toBe(true);
  });

  it("after inboxExcludedNamedNote (a named poll)", async () => {
    const id = await takenFromA();
    const inbox = await reader(A).poll({ documentId: id });
    expect(inbox.summary.startsWith(`Document ${id} is open but is not yours`)).toBe(true);
    expect(inbox.summary.endsWith(TOOK_SENTENCE("taken.md"))).toBe(true);
  });

  it("after noDocumentInboxNote: a named poll of an id that is not open, carrying a take sentence", async () => {
    await takenFromA();
    const inbox = await reader(A).poll({ documentId: "not-open-anywhere" });
    expect(inbox.summary).toContain("not-open-anywhere");
    expect(inbox.summary.endsWith(TOOK_SENTENCE("taken.md"))).toBe(true);
  });

  it("after noDocumentInboxNote: no document open once the last tab A held was closed", async () => {
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);
    const d = mkDoc("only", "/tmp/only-one.md");
    await writeAs(A, d);
    await reader(A).poll();
    await closeByRoute(d.id);
    expect(getOpenDocs().size).toBe(0);
    const inbox = await reader(A).poll();
    expect(inbox.summary.startsWith("No document is open")).toBe(true);
    expect(inbox.summary.endsWith(CLOSED_SENTENCE("only-one.md"))).toBe(true);
  });

  it("nothing in the sentence reads as an instruction", async () => {
    await takenFromA();
    const sentence = TOOK_SENTENCE("taken.md") + CLOSED_SENTENCE("x.md");
    expect(sentence).not.toMatch(/\b(do not|don't|should|must|call|stop|leave|reopen|please)\b/i);
  });

  it("one sentence naming D1 (taken) and D2 (closed); a longer list is shortened", async () => {
    const id1 = await takenFromA("one.md");
    const d2 = mkDoc("d2", "/tmp/two.md");
    await writeAs(A, d2);
    await closeByRoute(d2.id);
    const inbox = await reader(A).poll();
    expect(
      inbox.summary.endsWith(
        " You stopped holding one.md (another session took it), two.md (its tab was closed).",
      ),
    ).toBe(true);
    expect(getDocOwner(id1)?.ownerId).toBe(B);
    // Seven closes: five named, the rest counted.
    const names: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = mkDoc(`many${i}`, `/tmp/many-${i}.md`);
      names.push(`many-${i}.md (its tab was closed)`);
      await writeAs(A, d);
      await closeByRoute(d.id);
    }
    const many = await reader(A).poll();
    expect(
      many.summary.endsWith(` You stopped holding ${names.slice(0, 5).join(", ")} and 2 more.`),
    ).toBe(true);
  });

  it("lost by a take, then closed: named once, as closed (its last loss)", async () => {
    const file = realFile("tc.md");
    const id = await userOpen(file);
    await writeAs(A, { id });
    await reader(A).poll();
    await openAs(B, file); // A lost: take
    lapseByGrace(B, "stream dropped");
    await writeAs(A, { id }); // A gained again
    await closeByRoute(id); // A lost: close
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual([lost(id, TOOK), gained(id, WROTE), lost(id, CLOSED)]);
    expect(inbox.summary.endsWith(CLOSED_SENTENCE("tc.md"))).toBe(true);
    expect(inbox.summary.match(/tc\.md/g)).toHaveLength(1);
  });

  it("closed, then taken: named once, as taken", async () => {
    const file = realFile("ct.md");
    let id = await userOpen(file);
    await writeAs(A, { id });
    await reader(A).poll();
    await closeByRoute(id); // A lost: close
    id = await userOpen(file);
    await writeAs(A, { id }); // A gained
    await openAs(B, file); // A lost: take
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual([lost(id, CLOSED), gained(id, WROTE), lost(id, TOOK)]);
    expect(inbox.summary.endsWith(TOOK_SENTENCE("ct.md"))).toBe(true);
    // Named once in the sentence (B holds it, so the exclusion note names it too).
    const sentence = inbox.summary.slice(inbox.summary.indexOf(" You stopped holding"));
    expect(sentence).toBe(TOOK_SENTENCE("ct.md"));
  });

  it("lost then held again: not named", async () => {
    const file = realFile("back.md");
    const id = await userOpen(file);
    await writeAs(A, { id });
    await reader(A).poll();
    await openAs(B, file);
    lapseByGrace(B, "stream dropped");
    await writeAs(A, { id });
    const inbox = await reader(A).poll();
    expect(holdingOf(inbox)).toContain(id);
    expect(inbox.summary).not.toContain("You stopped holding");
  });

  it("a lapse as the last loss: not named; the entry is in changed", async () => {
    const d = mkDoc("d", "/tmp/lapsed.md");
    await writeAs(A, d);
    await reader(A).poll();
    lapseByGrace(A, "stream dropped");
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual([lost(d.id, LAPSED)]);
    expect(inbox.summary).not.toContain("You stopped holding");
  });

  it("a closed notes.md while another notes.md is open: told apart", async () => {
    const closed = mkDoc("closed", "/tmp/a/notes.md");
    const open = mkDoc("open", "/tmp/b/notes.md");
    await writeAs(A, closed);
    await reader(A).poll();
    await closeByRoute(closed.id);
    comment(open.ydoc, "c1"); // the open one is named too: an item from a background document
    const inbox = await reader(A).poll();
    expect(inbox.summary).toContain(`notes.md (${open.id})`);
    expect(inbox.summary.endsWith(CLOSED_SENTENCE(`notes.md (${closed.id})`))).toBe(true);
  });

  it("the stored name is used only for a last-loss close: closed, reopened, claimed, taken, closed under B -> named by its id", async () => {
    const file = realFile("stored.md");
    let id = await userOpen(file);
    await writeAs(A, { id });
    await reader(A).poll();
    await closeByRoute(id); // A lost: close (name stored)
    id = await userOpen(file);
    await writeAs(A, { id }); // A gained
    await openAs(B, file); // A lost: take
    await closeByRoute(id); // closed while B holds it: nothing for A
    const inbox = await reader(A).poll();
    expect(changedOf(inbox)).toEqual([lost(id, CLOSED), gained(id, WROTE), lost(id, TOOK)]);
    expect(inbox.summary.endsWith(TOOK_SENTENCE(id))).toBe(true);
    for (const entry of changedOf(inbox)) {
      expect(Object.keys(entry).sort()).toEqual(["cause", "change", "documentId"]);
    }
  });

  it("documentLabels runs once per poll, and the text before the sentence is what it would be without the claims", async () => {
    const takenId = await takenFromA();
    const claimable = mkDoc("claimable");
    comment(claimable.ydoc, "c1");
    const sentence = TOOK_SENTENCE("taken.md");
    // Baseline: the same poll with its claim refused at commit. The refused
    // claim takes back what the pass left, so the next poll reads the same
    // items; this one drains the notice, so it carries the sentence.
    setInboxClaimCheckForTests((check) => check !== "scope");
    const before = documentLabelCallsForTests();
    const refused = await pollAs(A);
    expect(documentLabelCallsForTests() - before).toBe(1);
    setInboxClaimCheckForTests(undefined);
    expect(holdingOf(refused)).not.toContain(claimable.id);
    expect(refused.summary.endsWith(sentence)).toBe(true);
    const baseline = refused.summary.slice(0, -sentence.length);
    // The same poll with its claim applied: queue the same take again so it
    // carries the sentence too, then compare the text before it.
    await takenFromAgain(takenId);
    const between = documentLabelCallsForTests();
    const claimed = await pollAs(A);
    expect(documentLabelCallsForTests() - between).toBe(1);
    expect(holdingOf(claimed)).toContain(claimable.id);
    expect(claimed.summary.endsWith(sentence)).toBe(true);
    expect(claimed.summary.slice(0, -sentence.length)).toBe(baseline);
  });

  it("flag off: no sentence, no field, the summary master gives, and nothing queued", async () => {
    await close?.();
    await buildWorld("");
    const d = mkDoc("d");
    await writeAs(A, d);
    await closeByRoute(d.id);
    const inbox = await pollAs(A);
    expect(inbox.ownership).toBeUndefined();
    expect(Object.keys(inbox)).not.toContain("ownership");
    // The whole summary, as master gives it for a poll with nothing new. (The
    // structure is what keeps it master's: no field, no labelling input, no
    // sentence; this pins the observable result.)
    expect(inbox.summary).toBe("No new actions.");
    expect(ownershipSnapshotForTests().changeNotices).toEqual([]);
  });
});
