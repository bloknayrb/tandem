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
  arbiterHistoryForTesting,
  makeAnnotationWriteArbiter,
  mergePatch,
} from "../../src/server/annotations/write-arbiter.js";
import { createHocuspocusLifecycle } from "../../src/server/bootstrap/hocuspocus-lifecycle.js";
import {
  attachObservers,
  detachObservers,
  resetForTesting,
} from "../../src/server/events/queue.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import {
  BROWSER_ORIGIN,
  INTERNAL_ORIGIN,
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

  it("a delete made in the same transaction as a set still wins", () => {
    const p = makePair(serverWins);
    withMcp(p.server, () => {
      p.sMap.set("a1", { ...get(p.sMap), rev: 2, range: { from: 3, to: 8 } });
      p.sMap.delete("a1");
    });
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

  it("merges the content when both sides made the same governing change", () => {
    const w = { ...base, status: "dismissed", range: { from: 4, to: 9 } };
    const l = { ...base, status: "dismissed", content: "reworded" };
    expect(Object.fromEntries(mergePatch(base, w, l, server))).toEqual({ content: "reworded" });
  });

  it("never merges rev", () => {
    expect(mergePatch(base, { ...base, rev: 5 }, { ...base, rev: 9 }, server).size).toBe(0);
  });

  it("moves author and color with the identity, so a promotion is never half-applied", () => {
    const note: Rec = {
      ...base,
      author: "import",
      type: "note",
      audience: "private",
      suggestedText: undefined,
      color: "yellow",
    };
    // One window recolors the note while another promotes it, which changes
    // the author and strips the color along with the type and audience.
    const recolored = { ...note, color: "blue" };
    const { color: _color, ...uncolored } = note;
    const promoted = {
      ...uncolored,
      author: "user",
      type: "comment",
      audience: "outbound",
      promotedFrom: "note",
    };
    for (const [w, l] of [
      [recolored, promoted],
      [promoted, recolored],
    ]) {
      const merged: Rec = { ...w };
      for (const [f, v] of mergePatch(note, w, l, { loserIsBrowser: true })) {
        if (v === undefined) delete merged[f];
        else merged[f] = v;
      }
      if (merged.type === "comment") {
        expect(merged).toMatchObject({ author: "user", audience: "outbound" });
        expect(merged.color).toBeUndefined();
      } else {
        expect(merged).toMatchObject({ type: "note", author: "import", audience: "private" });
        expect(merged.promotedFrom).toBeUndefined();
      }
    }
  });

  it("does not count a sanitize migration both sides carry as a governing change", () => {
    // A legacy record with no `audience`: every sanitized write adds one, so a
    // plain re-anchor must not beat a concurrent Dismiss on that alone.
    const legacy = { ...base, audience: undefined };
    const w = { ...legacy, audience: "outbound", range: { from: 4, to: 9 } };
    const l = { ...legacy, audience: "outbound", status: "dismissed" };
    expect(Object.fromEntries(mergePatch(legacy, w, l, { loserIsBrowser: true }))).toEqual({
      status: "dismissed",
    });
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

  it("does not fire a held browser Accept's event twice when a remote write displaces it", () => {
    server.clientID = 500;
    const sMap = server.getMap(Y_MAP_ANNOTATIONS);
    withInternal(server, () => sMap.set("a1", claudeSuggestion()));
    const a = new Y.Doc();
    a.clientID = 1000;
    const b = new Y.Doc();
    b.clientID = 3000;
    push(server, a, connection);
    push(server, b, connection);
    const aMap = a.getMap(Y_MAP_ANNOTATIONS);
    const bMap = b.getMap(Y_MAP_ANNOTATIONS);
    withBrowser(a, () => aMap.set("a1", { ...(aMap.get("a1") as Rec), status: "accepted" }));
    withBrowser(b, () => bMap.set("a1", { ...(bMap.get("a1") as Rec), range: { from: 3, to: 8 } }));

    const { events, cleanup } = collectEvents();
    push(a, server, connection);
    push(b, server, connection);
    cleanup();

    const s = sMap.get("a1") as Rec;
    expect(s.status).toBe("accepted");
    expect(s.range).toEqual({ from: 3, to: 8 });
    expect(events.filter((e) => e.type === "annotation:accepted")).toHaveLength(1);
    a.destroy();
    b.destroy();
  });

  /** Two browsers decide one proposal concurrently: A Accepts, B Dismisses and wins by clientID. */
  function acceptVsDismiss(): { sMap: Y.Map<unknown>; done: () => void } {
    server.clientID = 500;
    const sMap = server.getMap(Y_MAP_ANNOTATIONS);
    withInternal(server, () => sMap.set("a1", claudeSuggestion()));
    const a = new Y.Doc();
    a.clientID = 1000;
    const b = new Y.Doc();
    b.clientID = 3000;
    push(server, a, connection);
    push(server, b, connection);
    const aMap = a.getMap(Y_MAP_ANNOTATIONS);
    const bMap = b.getMap(Y_MAP_ANNOTATIONS);
    withBrowser(a, () => aMap.set("a1", { ...(aMap.get("a1") as Rec), status: "accepted" }));
    withBrowser(b, () => bMap.set("a1", { ...(bMap.get("a1") as Rec), status: "dismissed" }));
    push(a, server, connection);
    push(b, server, connection);
    return {
      sMap,
      done: () => {
        a.destroy();
        b.destroy();
      },
    };
  }

  const decisions = (events: { type: string }[]) =>
    events
      .map((e) => e.type)
      .filter((t) => t === "annotation:accepted" || t === "annotation:dismissed");

  it("re-emits the decision when a held Accept is restored over a concurrent Dismiss", () => {
    const { events, cleanup } = collectEvents();
    const { sMap, done } = acceptVsDismiss();
    cleanup();

    expect((sMap.get("a1") as Rec).status).toBe("accepted");
    // The last decision Claude was pushed must be the one the pull path reads.
    expect(decisions(events)).toEqual([
      "annotation:accepted",
      "annotation:dismissed",
      "annotation:accepted",
    ]);
    done();
  });

  it("holds that corrective event behind the Solo gate like any other", () => {
    setCtrlMode("solo");
    const external = collectEvents("external");
    const internal = collectEvents("internal");
    const { sMap, done } = acceptVsDismiss();
    external.cleanup();
    internal.cleanup();

    expect((sMap.get("a1") as Rec).status).toBe("accepted");
    expect(decisions(external.events)).toEqual([]);
    expect(decisions(internal.events).at(-1)).toBe("annotation:accepted");
    done();
  });

  it("keeps its history across a re-attach to the same doc (the reload paths)", () => {
    server.clientID = 5000;
    const sMap = server.getMap(Y_MAP_ANNOTATIONS);
    withInternal(server, () => sMap.set("a1", claudeSuggestion()));
    const browser = new Y.Doc();
    browser.clientID = 1000;
    push(server, browser, connection);
    const bMap = browser.getMap(Y_MAP_ANNOTATIONS);

    // A reload remaps the record, then re-runs `attachObservers` on the same doc.
    withInternal(server, () =>
      sMap.set("a1", { ...(sMap.get("a1") as Rec), range: { from: 4, to: 9 }, rev: 2 }),
    );
    attachObservers("arbiter-events-doc", server);
    withBrowser(browser, () => bMap.set("a1", { ...(bMap.get("a1") as Rec), status: "accepted" }));
    push(browser, server, connection);

    const s = sMap.get("a1") as Rec;
    expect(s.status).toBe("accepted");
    expect(s.range).toEqual({ from: 4, to: 9 });
    browser.destroy();
  });

  it("keeps a head's attribution across a re-attach when a lost write was recorded after it", () => {
    server.clientID = 5000;
    const sMap = server.getMap(Y_MAP_ANNOTATIONS);
    withInternal(server, () => sMap.set("a1", claudeSuggestion()));
    const loser = new Y.Doc();
    loser.clientID = 1000;
    const late = new Y.Doc();
    late.clientID = 9000;
    push(server, loser, connection);
    push(server, late, connection);
    const lMap = loser.getMap(Y_MAP_ANNOTATIONS);
    const tMap = late.getMap(Y_MAP_ANNOTATIONS);

    // The server and one browser make the SAME re-anchor; the browser's loses
    // and the merge is empty, so its lost item is the last history entry.
    const moved = { ...(sMap.get("a1") as Rec), range: { from: 4, to: 9 }, rev: 2 };
    withMcp(server, () => sMap.set("a1", moved));
    withBrowser(loser, () => lMap.set("a1", { ...moved }));
    push(loser, server, connection);
    attachObservers("arbiter-events-doc", server);

    // A browser that never saw the re-anchor wins by clientID; the server's
    // re-anchor must still be merged back under its own origin.
    withBrowser(late, () => tMap.set("a1", { ...(tMap.get("a1") as Rec), status: "accepted" }));
    push(late, server, connection);

    const s = sMap.get("a1") as Rec;
    expect(s.status).toBe("accepted");
    expect(s.range).toEqual({ from: 4, to: 9 });
    loser.destroy();
    late.destroy();
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

describe("write arbiter — attribution across nested and later transactions", () => {
  afterEach(() => {
    detachObservers("arbiter-nest-doc");
    resetForTesting();
  });

  // A's Accept arrives and the held-in-Solo stamp is nested on top of it in the
  // same remote transaction. B's concurrent Dismiss then wins by clientID. The
  // loser is A's Accept — a browser write that has already applied its text —
  // not the stamp the server nested over it.
  // When B's write is a decision too, the restore re-decides and is re-applied
  // as the browser write it was; when it is not, A's Accept is restored under
  // `internal` (its events already fired). Never as a held-in-Solo stamp.
  it.each([
    ["a concurrent Dismiss", { status: "dismissed" }, BROWSER_ORIGIN],
    ["a concurrent re-anchor", { range: { from: 3, to: 8 } }, INTERNAL_ORIGIN],
  ])(
    "attributes a loser to the browser write, not a server write nested over it (%s)",
    (_name, bWrite, repairOrigin) => {
      const server = new Y.Doc();
      server.clientID = 500;
      attachObservers("arbiter-nest-doc", server);
      setCtrlMode("solo");
      const sMap = server.getMap(Y_MAP_ANNOTATIONS);
      withInternal(server, () =>
        sMap.set("a1", claudeSuggestion({ author: "user", content: "rewrite" })),
      );
      const a = new Y.Doc();
      a.clientID = 1000;
      const b = new Y.Doc();
      b.clientID = 3000;
      push(server, a, connection);
      push(server, b, connection);
      const aMap = a.getMap(Y_MAP_ANNOTATIONS);
      const bMap = b.getMap(Y_MAP_ANNOTATIONS);
      withBrowser(a, () => aMap.set("a1", { ...(aMap.get("a1") as Rec), status: "accepted" }));
      withBrowser(b, () => bMap.set("a1", { ...(bMap.get("a1") as Rec), ...bWrite }));
      push(a, server, connection);
      expect((sMap.get("a1") as Rec).heldInSolo).toBe(true);

      const origins: unknown[] = [];
      const rec = (_e: unknown, t: Y.Transaction) => {
        if (t.local) origins.push(t.origin);
      };
      sMap.observe(rec);
      push(b, server, connection);
      sMap.unobserve(rec);

      const s = sMap.get("a1") as Rec;
      expect(s.status).toBe("accepted");
      expect(s.heldInSolo).toBe(true);
      expect(origins.at(-1)).toBe(repairOrigin);
      a.destroy();
      b.destroy();
      server.destroy();
    },
  );

  it("records each item once, under the transaction that wrote it", () => {
    const server = new Y.Doc();
    server.clientID = 1000;
    attachObservers("arbiter-nest-doc", server);
    setCtrlMode("solo");
    const sMap = server.getMap(Y_MAP_ANNOTATIONS);
    withInternal(server, () =>
      sMap.set(
        "a1",
        claudeSuggestion({ author: "user", suggestedText: undefined, content: "draft" }),
      ),
    );
    const browser = new Y.Doc();
    browser.clientID = 2000;
    push(server, browser, connection);
    const bMap = browser.getMap(Y_MAP_ANNOTATIONS);
    withMcp(server, () =>
      sMap.set("a1", { ...(sMap.get("a1") as Rec), range: { from: 4, to: 9 }, rev: 2 }),
    );
    withBrowser(browser, () =>
      bMap.set("a1", { ...(bMap.get("a1") as Rec), content: "final", editedAt: 99 }),
    );
    // The browser wins; the stamp is nested in its transaction and the repair
    // is written after it, before the stamp's own transaction is cleaned up.
    push(browser, server, connection);
    expect((sMap.get("a1") as Rec).range).toEqual({ from: 4, to: 9 });

    const live = arbiterHistoryForTesting(server, "a1").filter((e) => !e.deleted);
    expect(new Set(live.map((e) => e.id)).size).toBe(live.length);
    // The repair re-applies the mcp re-anchor, so it is recorded as mcp only.
    expect(live.at(-1)?.writer).toBe(MCP_ORIGIN);
    browser.destroy();
    server.destroy();
  });

  it("keeps its history across the Hocuspocus doc swap", () => {
    const oldDoc = new Y.Doc();
    oldDoc.clientID = 500;
    attachObservers("arbiter-nest-doc", oldDoc);
    setCtrlMode("tandem");
    const oMap = oldDoc.getMap(Y_MAP_ANNOTATIONS);
    withInternal(oldDoc, () => oMap.set("a1", claudeSuggestion()));
    const a = new Y.Doc();
    a.clientID = 1000;
    const b = new Y.Doc();
    b.clientID = 3000;
    push(oldDoc, a, connection);
    push(oldDoc, b, connection);
    const aMap = a.getMap(Y_MAP_ANNOTATIONS);
    withBrowser(a, () => aMap.set("a1", { ...(aMap.get("a1") as Rec), status: "accepted" }));
    push(a, oldDoc, connection);

    // What `onLoadDocument` does: merge the old doc into Hocuspocus's, then swap.
    const newDoc = new Y.Doc();
    newDoc.clientID = 600;
    Y.applyUpdate(newDoc, Y.encodeStateAsUpdate(oldDoc));
    createHocuspocusLifecycle().onDocSwapped("arbiter-nest-doc", newDoc, oldDoc);

    // B never saw A's Accept and wins by clientID; A's Accept applied its text.
    const bMap = b.getMap(Y_MAP_ANNOTATIONS);
    withBrowser(b, () => bMap.set("a1", { ...(bMap.get("a1") as Rec), status: "dismissed" }));
    push(b, newDoc, connection);

    expect((newDoc.getMap(Y_MAP_ANNOTATIONS).get("a1") as Rec).status).toBe("accepted");
    a.destroy();
    b.destroy();
    oldDoc.destroy();
    newDoc.destroy();
  });
});
