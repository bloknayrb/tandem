/**
 * #1920: two writes to one annotation made without seeing each other were
 * resolved by Yjs's clientID, not by any application rule. The server now
 * arbitrates them (`src/server/annotations/write-arbiter.ts`).
 *
 * Each scenario runs with BOTH clientID orders, because the defect was that the
 * outcome depended on which peer drew the higher id. The browser is a second
 * `Y.Doc` whose updates reach the server through `Y.applyUpdate` with an object
 * origin — the shape a Hocuspocus `Connection` has — so the server sees a
 * remote, non-local transaction exactly as in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  makeAnnotationWriteArbiter,
  mergePatch,
} from "../../src/server/annotations/write-arbiter.js";
import {
  attachObservers,
  detachObservers,
  resetForTesting,
} from "../../src/server/events/queue.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import {
  BROWSER_ORIGIN,
  MCP_ORIGIN,
  withBrowser,
  withInternal,
  withMcp,
} from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { collectEvents } from "../helpers/event-collector.js";

type Rec = Record<string, unknown>;

/** Stands in for a Hocuspocus `Connection`: a non-null, non-string origin. */
const connection = { kind: "test-connection" };

function push(from: Y.Doc, to: Y.Doc, origin: unknown): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), origin);
}

function claudeSuggestion(extra: Rec = {}): Rec {
  return {
    id: "a1",
    author: "claude",
    type: "comment",
    audience: "outbound",
    range: { from: 2, to: 7 },
    content: "tighten this",
    suggestedText: "orig",
    status: "pending",
    timestamp: 1,
    textSnapshot: "hello",
    rev: 1,
    ...extra,
  };
}

interface Pair {
  server: Y.Doc;
  browser: Y.Doc;
  sMap: Y.Map<unknown>;
  bMap: Y.Map<unknown>;
  origins: unknown[];
  detach: () => void;
}

/** A server with the arbiter attached and one synced browser. */
function makePair(serverWins: boolean, seed: Rec = claudeSuggestion()): Pair {
  const server = new Y.Doc();
  const browser = new Y.Doc();
  server.clientID = serverWins ? 2000 : 1000;
  browser.clientID = serverWins ? 1000 : 2000;
  const sMap = server.getMap(Y_MAP_ANNOTATIONS);
  const origins: unknown[] = [];
  sMap.observe((_e, txn) => {
    if (txn.local) origins.push(txn.origin);
  });
  const detach = makeAnnotationWriteArbiter({ docName: "arbiter-doc", doc: server });
  withMcp(server, () => sMap.set("a1", seed));
  push(server, browser, connection);
  origins.length = 0;
  return { server, browser, sMap, bMap: browser.getMap(Y_MAP_ANNOTATIONS), origins, detach };
}

/** Deliver both sides' pending writes and let the server's repair reach the browser. */
function exchange(p: Pair): void {
  push(p.browser, p.server, connection);
  push(p.server, p.browser, connection);
}

const get = (m: Y.Map<unknown>) => m.get("a1") as Rec | undefined;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  [true, "server clientID higher"],
  [false, "browser clientID higher"],
])("write arbiter (%s: %s)", (serverWins) => {
  it("an Accept survives a concurrent Claude edit of the proposal", () => {
    const p = makePair(serverWins);
    withMcp(p.server, () =>
      p.sMap.set("a1", { ...get(p.sMap), suggestedText: "edited", editedAt: 50, rev: 2 }),
    );
    withBrowser(p.browser, () => p.bMap.set("a1", { ...get(p.bMap), status: "accepted" }));
    exchange(p);

    const s = get(p.sMap);
    expect(s?.status).toBe("accepted");
    // The text the user saw and applied, not Claude's concurrent rewrite.
    expect(s?.suggestedText).toBe("orig");
    expect(s?.editedAt).toBeUndefined();
    expect(get(p.bMap)).toEqual(s);
    p.detach();
  });

  it("an Accept survives a concurrent re-anchor, and keeps the new anchor", () => {
    const p = makePair(serverWins);
    withMcp(p.server, () =>
      p.sMap.set("a1", { ...get(p.sMap), range: { from: 4, to: 9 }, rev: 2 }),
    );
    withBrowser(p.browser, () => p.bMap.set("a1", { ...get(p.bMap), status: "accepted" }));
    exchange(p);

    const s = get(p.sMap);
    expect(s?.status).toBe("accepted");
    expect(s?.range).toEqual({ from: 4, to: 9 });
    expect(get(p.bMap)).toEqual(s);
    p.detach();
  });

  it("re-applies the losing side under that side's own origin", () => {
    const p = makePair(serverWins);
    withMcp(p.server, () =>
      p.sMap.set("a1", { ...get(p.sMap), range: { from: 4, to: 9 }, rev: 2 }),
    );
    withBrowser(p.browser, () => p.bMap.set("a1", { ...get(p.bMap), status: "accepted" }));
    p.origins.length = 0;
    push(p.browser, p.server, connection);
    // Server won: the browser's Accept is re-applied as a browser write.
    // Browser won: the server's re-anchor is re-applied as the mcp write it was.
    expect(p.origins).toEqual([serverWins ? BROWSER_ORIGIN : MCP_ORIGIN]);
    p.detach();
  });

  it("a concurrent delete wins over a browser write", () => {
    const p = makePair(serverWins);
    withMcp(p.server, () => p.sMap.delete("a1"));
    withBrowser(p.browser, () => p.bMap.set("a1", { ...get(p.bMap), status: "accepted" }));
    exchange(p);

    expect(p.sMap.has("a1")).toBe(false);
    expect(p.bMap.has("a1")).toBe(false);
    p.detach();
  });

  it("a delete the browser had not seen wins even after a later server write", () => {
    const p = makePair(serverWins);
    withMcp(p.server, () =>
      p.sMap.set("a1", { ...get(p.sMap), rev: 2, range: { from: 3, to: 8 } }),
    );
    withMcp(p.server, () => p.sMap.delete("a1"));
    withBrowser(p.browser, () => p.bMap.set("a1", { ...get(p.bMap), status: "dismissed" }));
    exchange(p);

    expect(p.sMap.has("a1")).toBe(false);
    expect(p.bMap.has("a1")).toBe(false);
    p.detach();
  });

  it("a user's content edit survives a concurrent held-in-Solo stamp, and keeps it", () => {
    const p = makePair(
      serverWins,
      claudeSuggestion({ author: "user", suggestedText: undefined, content: "draft" }),
    );
    withMcp(p.server, () => p.sMap.set("a1", { ...get(p.sMap), heldInSolo: true, rev: 2 }));
    withBrowser(p.browser, () =>
      p.bMap.set("a1", { ...get(p.bMap), content: "final", editedAt: 99 }),
    );
    exchange(p);

    const s = get(p.sMap);
    expect(s?.content).toBe("final");
    expect(s?.editedAt).toBe(99);
    expect(s?.heldInSolo).toBe(true);
    expect(get(p.bMap)).toEqual(s);
    p.detach();
  });

  it("two browsers: a promotion keeps what the user sent, not text typed into the note elsewhere", () => {
    const note = claudeSuggestion({
      author: "user",
      type: "note",
      audience: "private",
      suggestedText: undefined,
      content: "private draft",
    });
    const p = makePair(serverWins, note);
    const other = new Y.Doc();
    other.clientID = 1500;
    push(p.server, other, connection);
    const oMap = other.getMap(Y_MAP_ANNOTATIONS);

    withBrowser(p.browser, () =>
      p.bMap.set("a1", {
        ...get(p.bMap),
        type: "comment",
        audience: "outbound",
        promotedFrom: "note",
      }),
    );
    withBrowser(other, () =>
      oMap.set("a1", { ...(oMap.get("a1") as Rec), content: "more private text", editedAt: 7 }),
    );
    push(p.browser, p.server, connection);
    push(other, p.server, connection);
    push(p.server, p.browser, connection);
    push(p.server, other, connection);

    const s = get(p.sMap);
    expect(s?.type).toBe("comment");
    expect(s?.content).toBe("private draft");
    expect(oMap.get("a1")).toEqual(s);
    p.detach();
  });

  it("leaves sequential writes alone", () => {
    const p = makePair(serverWins);
    withBrowser(p.browser, () => p.bMap.set("a1", { ...get(p.bMap), status: "dismissed" }));
    p.origins.length = 0;
    push(p.browser, p.server, connection);
    expect(p.origins).toEqual([]);
    expect(get(p.sMap)?.status).toBe("dismissed");
    p.detach();
  });
});

describe("write arbiter — limits", () => {
  it("leaves a conflict whose base fell out of history as Yjs resolved it", () => {
    const p = makePair(true);
    withBrowser(p.browser, () => p.bMap.set("a1", { ...get(p.bMap), status: "accepted" }));
    for (let i = 0; i < 20; i++) {
      withMcp(p.server, () => p.sMap.set("a1", { ...get(p.sMap), rev: 10 + i }));
    }
    p.origins.length = 0;
    push(p.browser, p.server, connection);
    expect(p.origins).toEqual([]);
    expect(get(p.sMap)?.status).toBe("pending");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("out of history"),
      "arbiter-doc",
    );
    p.detach();
  });

  it("never arbitrates a transaction with a null origin", () => {
    const p = makePair(true);
    withMcp(p.server, () => p.sMap.set("a1", { ...get(p.sMap), suggestedText: "edited" }));
    withBrowser(p.browser, () => p.bMap.set("a1", { ...get(p.bMap), status: "accepted" }));
    p.origins.length = 0;
    push(p.browser, p.server, null);
    expect(p.origins).toEqual([]);
    p.detach();
  });
});

describe("mergePatch", () => {
  const base = claudeSuggestion();
  const server = { loserIsBrowser: false };

  it("hands the content to the side that decided", () => {
    const w = { ...base, suggestedText: "edited", editedAt: 5 };
    const l = { ...base, status: "accepted", resolvedBy: "user" };
    expect(Object.fromEntries(mergePatch(base, w, l, server))).toEqual({
      status: "accepted",
      resolvedBy: "user",
      suggestedText: "orig",
      editedAt: undefined,
    });
  });

  it("keeps the winner's groups when both sides decided", () => {
    const w = { ...base, status: "dismissed" };
    const l = { ...base, status: "accepted" };
    expect(mergePatch(base, w, l, server).size).toBe(0);
  });

  it("lets a browser Accept that applied text beat a concurrent Claude resolve", () => {
    const w = { ...base, status: "dismissed", resolvedBy: "claude" };
    const l = { ...base, status: "accepted" };
    expect(Object.fromEntries(mergePatch(base, w, l, { loserIsBrowser: true }))).toEqual({
      status: "accepted",
      resolvedBy: undefined,
    });
  });

  it("moves the anchor as one unit", () => {
    const w = { ...base, status: "accepted" };
    const l = { ...base, range: { from: 9, to: 14 }, relRange: { fromRel: 1, toRel: 2 } };
    expect(Object.fromEntries(mergePatch(base, w, l, server))).toEqual({
      range: { from: 9, to: 14 },
      relRange: { fromRel: 1, toRel: 2 },
    });
  });

  it("never merges rev", () => {
    expect(mergePatch(base, { ...base, rev: 5 }, { ...base, rev: 9 }, server).size).toBe(0);
  });
});

describe("write arbiter wired into attachObservers", () => {
  let server: Y.Doc;
  beforeEach(() => {
    server = new Y.Doc();
    server.clientID = 2000;
    attachObservers("arbiter-events-doc", server);
    setCtrlMode("tandem");
  });
  afterEach(() => {
    detachObservers("arbiter-events-doc");
    server.destroy();
    resetForTesting();
  });

  it("emits the annotation:accepted a lost browser Accept should have produced", () => {
    const sMap = server.getMap(Y_MAP_ANNOTATIONS);
    withInternal(server, () => sMap.set("a1", claudeSuggestion()));
    const browser = new Y.Doc();
    browser.clientID = 1000;
    push(server, browser, connection);
    const bMap = browser.getMap(Y_MAP_ANNOTATIONS);

    withMcp(server, () =>
      sMap.set("a1", { ...(sMap.get("a1") as Rec), range: { from: 4, to: 9 }, rev: 2 }),
    );
    withBrowser(browser, () => bMap.set("a1", { ...(bMap.get("a1") as Rec), status: "accepted" }));

    const { events, cleanup } = collectEvents();
    push(browser, server, connection);
    cleanup();

    expect((sMap.get("a1") as Rec).status).toBe("accepted");
    const accepted = events.filter((e) => e.type === "annotation:accepted");
    expect(accepted).toHaveLength(1);
    browser.destroy();
  });
});

describe("write arbiter beside a write nested in the same remote transaction", () => {
  afterEach(() => {
    detachObservers("arbiter-solo-doc");
    resetForTesting();
  });

  // In Solo, the held-in-solo observer stamps a user comment edited by a browser
  // from INSIDE the remote transaction's observers, before the arbiter runs. The
  // key's live head is then that stamp, not anything the remote update wrote.
  it.each([
    [true, "server clientID higher"],
    [false, "browser clientID higher"],
  ])("still merges both sides (%s: %s)", (serverWins) => {
    const server = new Y.Doc();
    server.clientID = serverWins ? 2000 : 1000;
    attachObservers("arbiter-solo-doc", server);
    setCtrlMode("solo");
    const sMap = server.getMap(Y_MAP_ANNOTATIONS);
    withInternal(server, () =>
      sMap.set(
        "a1",
        claudeSuggestion({ author: "user", suggestedText: undefined, content: "draft" }),
      ),
    );
    const browser = new Y.Doc();
    browser.clientID = serverWins ? 1000 : 2000;
    push(server, browser, connection);
    const bMap = browser.getMap(Y_MAP_ANNOTATIONS);

    withMcp(server, () =>
      sMap.set("a1", { ...(sMap.get("a1") as Rec), range: { from: 4, to: 9 }, rev: 2 }),
    );
    withBrowser(browser, () =>
      bMap.set("a1", { ...(bMap.get("a1") as Rec), content: "final", editedAt: 99 }),
    );
    push(browser, server, connection);
    push(server, browser, connection);

    const s = sMap.get("a1") as Rec;
    expect(s.content).toBe("final");
    expect(s.range).toEqual({ from: 4, to: 9 });
    expect(s.heldInSolo).toBe(true);
    expect(bMap.get("a1")).toEqual(s);
    browser.destroy();
    server.destroy();
  });
});
