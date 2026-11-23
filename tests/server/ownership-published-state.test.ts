/**
 * The published ownership state (#2358 PR 5a-3, ADR-054's 5a-3 amendment;
 * ownership design §10.2, §10.3): the owner fields on every
 * `Y_MAP_OPEN_DOCUMENTS` entry, step 4's republish, the restore against a
 * client write, the `CTRL_ROOM` composer summary and the stale tick.
 *
 * The first part runs in process against the real registry, the real
 * ownership module and the provider's Y.Docs, with a fake transport view,
 * fake launcher facts and a fake oldest-waiting probe. The last describe
 * boots a real Hocuspocus with the production lifecycle's `onDocSwapped` and
 * forges from a real client connection, so the guard is shown on the Y.Doc
 * the load swapped in.
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HocuspocusProvider, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import type { Hocuspocus } from "@hocuspocus/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { createHocuspocusLifecycle } from "../../src/server/bootstrap/hocuspocus-lifecycle.js";
import {
  broadcastOpenDocs,
  closeDocument,
  getActiveDocEpoch,
  getOpenDocs,
  type OpenDoc,
  openDocument,
  toDocListEntry,
} from "../../src/server/documents/registry.js";
import {
  removeDoc,
  resetPublished,
  setActiveDocId,
} from "../../src/server/documents/registry-testing.js";
import {
  attachCtrlObservers,
  resetForTesting as resetEventsForTesting,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import {
  guardOwnershipRoom,
  ownershipRestoresForTests,
  requestOwnershipPublish,
  runOwnershipTickForTests,
  startOwnershipPublishing,
  stopOwnershipPublishingForTests,
} from "../../src/server/ownership-publish.js";
import {
  type LauncherFacts,
  noteRecordPoll,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSummary,
  publishedOwnerFields,
  resetOwnershipForTests,
  setDocOwner,
  setLauncherFactsSource,
  setLossForTests,
  setOldestWaitingProbe,
  setOwnershipPublishSink,
  setOwnershipTransportMode,
  setTandemPresenceSource,
  setTransportView,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import {
  getOrCreateDocument,
  installHocuspocusLifecycle,
  removeDocument,
  resetHocuspocusLifecycleForTesting,
  startHocuspocus,
} from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ACTIVE_DOCUMENT_EPOCH,
  Y_MAP_ACTIVE_DOCUMENT_ID,
  Y_MAP_DOCUMENT_META,
  Y_MAP_OPEN_DOCUMENTS,
  Y_MAP_OWNERSHIP_SUMMARY,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { BROWSER_ORIGIN, withInternal } from "../../src/shared/origins.js";
import {
  OWNERSHIP_STALE_AFTER_MS,
  type OwnershipSummary,
} from "../../src/shared/ownership-published.js";

const T = "claude:published-terminal";
const U = "claude:published-other";
/** A client's write: neither a server helper's tag nor null. */
const CLIENT = { client: true };
const MIN = 60_000;

let view: TransportViewEntry[];
let present: boolean;
let facts: LauncherFacts | null;
let oldest: Map<string, number>;
const opened: string[] = [];

const FACTS: LauncherFacts = {
  running: false,
  startPending: false,
  off: false,
  notSetUp: false,
  stayingDown: false,
  bindFailed: false,
  startable: true,
};

function doc(id: string): OpenDoc {
  return {
    id,
    filePath: path.join(os.tmpdir(), `${id}.md`),
    format: "md",
    readOnly: false,
    source: "file",
  };
}

function open(id: string): void {
  opened.push(id);
  openDocument(doc(id));
}

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 1 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

const meta = (room: string) => getOrCreateDocument(room).getMap(Y_MAP_DOCUMENT_META);
const listIn = (room: string) =>
  meta(room).get(Y_MAP_OPEN_DOCUMENTS) as Array<Record<string, unknown>> | undefined;
const entryIn = (room: string, id: string) => listIn(room)?.find((e) => e.id === id);
const awareness = () => getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_USER_AWARENESS);
const summaryIn = () => awareness().get(Y_MAP_OWNERSHIP_SUMMARY) as OwnershipSummary | undefined;

/** One microtask (the republish), then one event-loop turn (a restore). */
const settle = async () => {
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/** A client's write to a room's tab list. */
function forge(room: string, list: unknown, origin: unknown = CLIENT): void {
  const ydoc = getOrCreateDocument(room);
  ydoc.transact(() => ydoc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_OPEN_DOCUMENTS, list), origin);
}

/** The current CTRL list with one entry's owner replaced by a forged Tandem's Claude. */
function forgedOwner(room: string, id: string) {
  return (listIn(room) ?? []).map((e) =>
    e.id === id
      ? { ...e, owner: { label: "owner-zzzz", displayKind: "Tandem's Claude", kind: "assigned" } }
      : e,
  );
}

function wire(flag: "1" | "", mode: "http" | "stdio" = "http"): void {
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  view = [];
  present = false;
  facts = { ...FACTS };
  oldest = new Map();
  setTransportView(() => view);
  setTandemPresenceSource(() => present);
  setLauncherFactsSource(() => facts);
  setOldestWaitingProbe((id) => oldest.get(id) ?? null);
  setOwnershipPublishSink(requestOwnershipPublish);
  setOwnershipTransportMode(mode);
}

function clearWorld(): void {
  stopOwnershipPublishingForTests();
  resetPublished();
  resetOwnershipForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  for (const id of opened.splice(0)) removeDocument(id);
  removeDocument(CTRL_ROOM);
}

describe("in process", () => {
  beforeEach(() => {
    clearWorld();
    wire("1");
  });

  afterEach(() => {
    clearWorld();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("flag off: behaviour-identical", () => {
    it("entries carry no owner key, CTRL gains no key, nothing is restored, nothing is logged", async () => {
      vi.stubEnv("TANDEM_OWNERSHIP", "");
      const logs = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
        vi.spyOn(console, m),
      );
      const stop = startOwnershipPublishing();
      open("dark-a");
      open("dark-b");
      register(T);
      setDocOwner("dark-a", { ownerId: T, kind: "claimed" }, "claim", T);
      requestOwnershipPublish();
      await settle();
      const exact = [toDocListEntry(doc("dark-a")), toDocListEntry(doc("dark-b"))];
      for (const room of [CTRL_ROOM, "dark-a", "dark-b"]) {
        expect(listIn(room), room).toEqual(exact);
        for (const e of listIn(room) ?? []) {
          expect(Object.keys(e).sort(), room).toEqual(
            ["fileName", "filePath", "format", "id", "readOnly", "source"].sort(),
          );
        }
      }
      expect(awareness().has(Y_MAP_OWNERSHIP_SUMMARY)).toBe(false);
      expect(publishedOwnerFields("dark-a")).toBeUndefined();
      expect(ownershipSummary()).toBeUndefined();
      // No guard: a client's forgery stays, and no restore pass runs.
      const forged = [{ ...exact[0], owner: { label: "x" } }];
      forge(CTRL_ROOM, forged);
      guardOwnershipRoom(CTRL_ROOM, getOrCreateDocument(CTRL_ROOM));
      forge(CTRL_ROOM, forged);
      await settle();
      expect(listIn(CTRL_ROOM)).toEqual(forged);
      expect(ownershipRestoresForTests()).toBe(0);
      runOwnershipTickForTests();
      expect(listIn(CTRL_ROOM)).toEqual(forged);
      expect(awareness().has(Y_MAP_OWNERSHIP_SUMMARY)).toBe(false);
      for (const spy of logs) expect(spy).not.toHaveBeenCalled();
      stop();
      // Nothing was attached while dark: with the flag on now, a forgery on
      // the same Y.Doc still stands, since no observer exists to see it.
      vi.stubEnv("TANDEM_OWNERSHIP", "1");
      forge(CTRL_ROOM, [{ id: "after-dark" }]);
      await settle();
      expect(listIn(CTRL_ROOM)).toEqual([{ id: "after-dark" }]);
      expect(ownershipRestoresForTests()).toBe(0);
    });
  });

  describe("the owner fields (ownership design §10.2)", () => {
    it("are on every entry in CTRL_ROOM and in each document room: null owner when unowned", () => {
      startOwnershipPublishing();
      open("own-a");
      for (const room of [CTRL_ROOM, "own-a"]) {
        expect(entryIn(room, "own-a")).toEqual({
          ...toDocListEntry(doc("own-a")),
          owner: null,
          stale: null,
          hint: null,
          waitingSince: null,
        });
      }
      // The tool shape (`tandem_listDocuments`) never carries them.
      expect(Object.keys(toDocListEntry(doc("own-a")))).not.toContain("owner");
    });

    it("step 4 republishes the holder's label, display kind and kind; never an owner id; no focus event", async () => {
      startOwnershipPublishing();
      open("own-b");
      open("own-c");
      register(T);
      const epoch = getActiveDocEpoch();
      const active = meta(CTRL_ROOM).get(Y_MAP_ACTIVE_DOCUMENT_ID);
      setDocOwner("own-b", { ownerId: T, kind: "claimed" }, "claim", T);
      // Coalesced: nothing yet in this synchronous run.
      expect(entryIn(CTRL_ROOM, "own-b")?.owner).toBeNull();
      await settle();
      for (const room of [CTRL_ROOM, "own-b", "own-c"]) {
        const owner = entryIn(room, "own-b")?.owner as Record<string, unknown>;
        expect(owner).toMatchObject({ displayKind: "terminal", kind: "claimed" });
        expect(String(owner.label)).toMatch(/^owner-[0-9a-z]{4}$/);
        expect(JSON.stringify(listIn(room))).not.toContain(T);
      }
      expect(meta(CTRL_ROOM).get(Y_MAP_ACTIVE_DOCUMENT_EPOCH)).toBe(epoch);
      expect(meta(CTRL_ROOM).get(Y_MAP_ACTIVE_DOCUMENT_ID)).toBe(active);
      setDocOwner("own-b", null, "lapse");
      await settle();
      expect(entryIn(CTRL_ROOM, "own-b")?.owner).toBeNull();
    });

    it("Tandem's Claude shows as Tandem's Claude, with its kind", async () => {
      startOwnershipPublishing();
      present = true;
      open("own-d");
      setDocOwner("own-d", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "presence");
      await settle();
      expect(entryIn("own-d", "own-d")?.owner).toMatchObject({
        displayKind: "Tandem's Claude",
        kind: "default",
      });
    });

    it("an ownership change during an open's prepare does not publish the tab early", async () => {
      startOwnershipPublishing();
      open("early-a");
      register(T);
      const { openDocumentWhenReady } = await import("../../src/server/documents/registry.js");
      opened.push("early-b");
      let release = () => {};
      const pending = openDocumentWhenReady(
        doc("early-b"),
        () => new Promise<void>((r) => (release = r)),
      );
      setDocOwner("early-a", { ownerId: T, kind: "claimed" }, "claim", T);
      await settle();
      expect(entryIn(CTRL_ROOM, "early-a")?.owner).not.toBeNull();
      expect(entryIn(CTRL_ROOM, "early-b")).toBeUndefined();
      release();
      await pending;
      expect(entryIn(CTRL_ROOM, "early-b")?.owner).toBeNull();
    });
  });

  describe("stale (ownership design §10.2)", () => {
    it("a holder in its grace reads disconnected, and stops when attached again", async () => {
      startOwnershipPublishing();
      open("st-a");
      register(T);
      setDocOwner("st-a", { ownerId: T, kind: "claimed" }, "claim", T);
      await settle();
      expect(entryIn(CTRL_ROOM, "st-a")?.stale).toBeNull();
      view[0] = { ownerId: T, openStreams: 0, streamEver: true };
      noteTransportChanged(T);
      await settle();
      expect(entryIn(CTRL_ROOM, "st-a")?.stale).toBe("disconnected");
      view[0] = { ownerId: T, openStreams: 1, streamEver: true };
      noteTransportChanged(T);
      await settle();
      expect(entryIn(CTRL_ROOM, "st-a")?.stale).toBeNull();
    });

    it("not-checking-in: the oldest waiting item is over 5 minutes old and the holder has not polled since; the tick publishes it", async () => {
      startOwnershipPublishing();
      open("st-b");
      register(T);
      setDocOwner("st-b", { ownerId: T, kind: "claimed" }, "claim", T);
      await settle();
      const at = Date.now() - OWNERSHIP_STALE_AFTER_MS + MIN;
      oldest.set("st-b", at);
      runOwnershipTickForTests();
      expect(entryIn(CTRL_ROOM, "st-b")?.stale, "under 5 minutes").toBeNull();
      oldest.set("st-b", Date.now() - OWNERSHIP_STALE_AFTER_MS - MIN);
      runOwnershipTickForTests();
      expect(entryIn(CTRL_ROOM, "st-b")?.stale).toBe("not-checking-in");
      // A poll after the item arrived clears it at the next tick.
      noteRecordPoll(T);
      runOwnershipTickForTests();
      expect(entryIn(CTRL_ROOM, "st-b")?.stale).toBeNull();
      // A terminal holder's stale flag carries no hint or time.
      expect(entryIn(CTRL_ROOM, "st-b")).toMatchObject({ hint: null, waitingSince: null });
    });

    it("a poll before the item arrived does not count", () => {
      open("st-c");
      register(T);
      setDocOwner("st-c", { ownerId: T, kind: "claimed" }, "claim", T);
      noteRecordPoll(T);
      // The item arrives a second after the poll; judged six minutes later.
      const arrived = Date.now() + 1000;
      oldest.set("st-c", arrived);
      const later = arrived + OWNERSHIP_STALE_AFTER_MS + MIN;
      expect(publishedOwnerFields("st-c", later)?.stale).toBe("not-checking-in");
      // A poll after it arrived: not stale.
      oldest.set("st-c", Date.now() - 1000);
      expect(
        publishedOwnerFields("st-c", Date.now() + OWNERSHIP_STALE_AFTER_MS + MIN)?.stale,
      ).toBeNull();
    });

    it("for Tandem's Claude, suppressed while a start is pending", () => {
      present = true;
      open("st-d");
      setDocOwner("st-d", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "presence");
      oldest.set("st-d", Date.now() - OWNERSHIP_STALE_AFTER_MS - MIN);
      facts = { ...FACTS, running: true };
      expect(publishedOwnerFields("st-d")?.stale).toBe("not-checking-in");
      facts = { ...FACTS, running: true, startPending: true };
      expect(publishedOwnerFields("st-d")?.stale).toBeNull();
    });
  });

  describe("hints (ownership design §10.2)", () => {
    it("unowned and waiting: at once when no session could claim it, with the arrival time", () => {
      open("h-a");
      const at = Date.now() - 1000;
      oldest.set("h-a", at);
      expect(publishedOwnerFields("h-a")).toEqual({
        owner: null,
        stale: null,
        hint: "unowned-waiting",
        waitingSince: at,
      });
    });

    it("unowned and waiting: after 5 minutes when a session could claim it", () => {
      open("h-b");
      register(T);
      oldest.set("h-b", Date.now() - 1000);
      expect(publishedOwnerFields("h-b")?.hint).toBeNull();
      expect(publishedOwnerFields("h-b")?.waitingSince).toBeNull();
      oldest.set("h-b", Date.now() - OWNERSHIP_STALE_AFTER_MS - MIN);
      expect(publishedOwnerFields("h-b")?.hint).toBe("unowned-waiting");
    });

    it("a session with a blocking loss on the document cannot claim it, so the hint shows at once", () => {
      open("h-c");
      register(T);
      setLossForTests("h-c", T, "released");
      oldest.set("h-c", Date.now() - 1000);
      expect(publishedOwnerFields("h-c")?.hint).toBe("unowned-waiting");
      register(U);
      expect(publishedOwnerFields("h-c")?.hint).toBeNull();
    });

    it("nothing waiting: no hint", () => {
      open("h-d");
      expect(publishedOwnerFields("h-d")?.hint).toBeNull();
    });

    it("Waiting — Start to answer: Tandem's Claude holds it, not running, no start pending", () => {
      present = true;
      open("h-e");
      setDocOwner("h-e", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "presence");
      const at = Date.now() - 1000;
      oldest.set("h-e", at);
      expect(publishedOwnerFields("h-e")).toMatchObject({
        hint: "start-to-answer",
        waitingSince: at,
      });
      facts = { ...FACTS, running: true };
      expect(publishedOwnerFields("h-e")?.hint).toBeNull();
      facts = { ...FACTS, startPending: true };
      expect(publishedOwnerFields("h-e")?.hint).toBeNull();
      facts = null;
      expect(publishedOwnerFields("h-e")?.hint, "no launcher").toBeNull();
      facts = { ...FACTS };
      oldest.delete("h-e");
      expect(publishedOwnerFields("h-e")?.hint, "nothing waiting").toBeNull();
    });

    it("a terminal holder never gets start-to-answer", () => {
      open("h-f");
      register(T);
      setDocOwner("h-f", { ownerId: T, kind: "claimed" }, "claim", T);
      oldest.set("h-f", Date.now() - 1000);
      expect(publishedOwnerFields("h-f")?.hint).toBeNull();
    });
  });

  describe("the composer summary (ownership design §10.2)", () => {
    const reason = () => ownershipSummary()?.notPresentReason;

    it("is written to CTRL_ROOM's user awareness map, and follows the launcher's facts", async () => {
      startOwnershipPublishing();
      expect(summaryIn()).toEqual({
        tandemPresent: false,
        tandemRunning: false,
        tandemStartable: true,
        notPresentReason: "not-started",
        otherAiAttached: false,
      });
      present = true;
      facts = { ...FACTS, running: true };
      register(T);
      await settle();
      expect(summaryIn()).toEqual({
        tandemPresent: true,
        tandemRunning: true,
        tandemStartable: true,
        notPresentReason: null,
        otherAiAttached: true,
      });
    });

    it("notPresentReason: off > not-set-up > staying-down > bind-failed > not-started (Bryan, 'Add \"not set up\"')", () => {
      const all = { off: true, notSetUp: true, stayingDown: true, bindFailed: true };
      facts = { ...FACTS, ...all };
      expect(reason()).toBe("off");
      facts = { ...FACTS, ...all, off: false };
      expect(reason()).toBe("not-set-up");
      facts = { ...FACTS, ...all, off: false, notSetUp: false };
      expect(reason()).toBe("staying-down");
      facts = { ...FACTS, bindFailed: true };
      expect(reason()).toBe("bind-failed");
      facts = { ...FACTS, running: true };
      expect(reason(), "a running child not yet bound").toBe("not-started");
      present = true;
      facts = { ...FACTS, ...all };
      expect(reason(), "present").toBeNull();
    });

    it("otherAiAttached: an attached session, not one in its grace, never Tandem's Claude", () => {
      present = true;
      expect(ownershipSummary()?.otherAiAttached).toBe(false);
      register(T);
      expect(ownershipSummary()?.otherAiAttached).toBe(true);
      view[0] = { ownerId: T, openStreams: 0, streamEver: true };
      noteTransportChanged(T);
      expect(ownershipSummary()?.otherAiAttached).toBe(false);
    });

    it("stdio mode, or no launcher, writes none, and a summary written before is deleted", async () => {
      startOwnershipPublishing();
      expect(summaryIn()).toBeDefined();
      facts = null;
      runOwnershipTickForTests();
      expect(awareness().has(Y_MAP_OWNERSHIP_SUMMARY)).toBe(false);
      facts = { ...FACTS };
      runOwnershipTickForTests();
      expect(summaryIn()).toBeDefined();
      // The mode is set once per run: a stdio server is a fresh one.
      resetOwnershipForTests();
      wire("1", "stdio");
      runOwnershipTickForTests();
      expect(awareness().has(Y_MAP_OWNERSHIP_SUMMARY)).toBe(false);
    });
  });

  describe("the stale tick", () => {
    it("writes only on a change", () => {
      startOwnershipPublishing();
      open("tick-a");
      const updates: number[] = [];
      for (const room of [CTRL_ROOM, "tick-a"]) {
        getOrCreateDocument(room).on("update", () => updates.push(1));
      }
      runOwnershipTickForTests();
      runOwnershipTickForTests();
      expect(updates).toEqual([]);
      oldest.set("tick-a", Date.now() - 1000);
      runOwnershipTickForTests();
      expect(updates.length).toBe(2);
      runOwnershipTickForTests();
      expect(updates.length).toBe(2);
    });

    it("is armed by startOwnershipPublishing at 60 seconds, unref'd, and stopped by its stop", () => {
      const spy = vi.spyOn(globalThis, "setInterval");
      startOwnershipPublishing();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
    });
  });

  describe("the guard (ownership design §10.3)", () => {
    it("restores a forged Tandem's Claude in CTRL_ROOM and in a document room", async () => {
      startOwnershipPublishing();
      open("g-a");
      register(T);
      setDocOwner("g-a", { ownerId: T, kind: "claimed" }, "claim", T);
      await settle();
      const truth = listIn(CTRL_ROOM);
      for (const room of [CTRL_ROOM, "g-a"]) {
        forge(room, forgedOwner(room, "g-a"));
        expect(entryIn(room, "g-a")?.owner).toMatchObject({ displayKind: "Tandem's Claude" });
        await settle();
        expect(listIn(room), room).toEqual(truth);
      }
    });

    it("restores a forged summary, and deletes one forged where none is written", async () => {
      startOwnershipPublishing();
      const truth = summaryIn();
      const ctrl = getOrCreateDocument(CTRL_ROOM);
      ctrl.transact(
        () => awareness().set(Y_MAP_OWNERSHIP_SUMMARY, { ...truth, tandemPresent: true }),
        CLIENT,
      );
      await settle();
      expect(summaryIn()).toEqual(truth);
      // The mode is set once per run: a stdio server is a fresh one.
      resetOwnershipForTests();
      wire("1", "stdio");
      runOwnershipTickForTests();
      ctrl.transact(() => awareness().set(Y_MAP_OWNERSHIP_SUMMARY, truth), CLIENT);
      await settle();
      expect(awareness().has(Y_MAP_OWNERSHIP_SUMMARY)).toBe(false);
    });

    it("a client writing in a loop costs one restore per event-loop turn", async () => {
      startOwnershipPublishing();
      open("g-b");
      const truth = listIn(CTRL_ROOM);
      for (let i = 0; i < 20; i++) forge(CTRL_ROOM, [{ id: `junk-${i}` }]);
      await settle();
      expect(ownershipRestoresForTests()).toBe(1);
      expect(listIn(CTRL_ROOM)).toEqual(truth);
    });

    it("treats a browser-tagged and an untagged write as a client's, and never restores a server helper's", async () => {
      startOwnershipPublishing();
      open("g-c");
      const truth = listIn(CTRL_ROOM);
      forge(CTRL_ROOM, [], BROWSER_ORIGIN);
      await settle();
      expect(listIn(CTRL_ROOM)).toEqual(truth);
      forge(CTRL_ROOM, [], null);
      await settle();
      expect(listIn(CTRL_ROOM)).toEqual(truth);
      const ctrl = getOrCreateDocument(CTRL_ROOM);
      withInternal(ctrl, () => meta(CTRL_ROOM).set(Y_MAP_OPEN_DOCUMENTS, []));
      await settle();
      expect(listIn(CTRL_ROOM)).toEqual([]);
    });

    it("restores a forged tab id too, and the restore's withInternal write emits the document:* that undoes the forgery's (Bryan, 'Yes, emit them')", async () => {
      startOwnershipPublishing();
      open("g-d");
      resetEventsForTesting();
      attachCtrlObservers();
      const events: TandemEvent[] = [];
      const cb = (e: TandemEvent) => events.push(e);
      subscribe(cb, "internal");
      const lifecycle = () =>
        events.filter((e) => e.type.startsWith("document:")).map((e) => [e.type, e.documentId]);
      // Owner fields only: the ids stand, so neither write emits anything.
      forge(CTRL_ROOM, forgedOwner(CTRL_ROOM, "g-d"));
      await settle();
      expect(lifecycle()).toEqual([]);
      // A forged extra tab: its own opened, then the restore's closed.
      forge(CTRL_ROOM, [...(listIn(CTRL_ROOM) ?? []), { id: "ghost", fileName: "ghost.md" }]);
      expect(lifecycle()).toEqual([["document:opened", "ghost"]]);
      await settle();
      expect(lifecycle()).toEqual([
        ["document:opened", "ghost"],
        ["document:closed", "ghost"],
      ]);
      expect(listIn(CTRL_ROOM)?.map((e) => e.id)).toEqual(["g-d"]);
      unsubscribe(cb);
      resetEventsForTesting();
    });

    it("leaves a closed document's room alone", async () => {
      startOwnershipPublishing();
      open("g-e");
      open("g-f");
      closeDocument("g-f");
      forge("g-f", [{ id: "stale" }]);
      await settle();
      expect(listIn("g-f")).toEqual([{ id: "stale" }]);
    });
  });
});

// ---------------------------------------------------------------------------
// A real client connection, and the swap Hocuspocus makes at load.

class LoopbackOriginWebSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url, [], { headers: { Origin: "http://127.0.0.1" } });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("through a real Hocuspocus connection (the guard after the load's swap)", () => {
  const GEN = "gen-published-state";
  let hp: Hocuspocus;
  let port: number;
  const providers: HocuspocusProvider[] = [];

  beforeAll(async () => {
    clearWorld();
    wire("1");
    const production = createHocuspocusLifecycle();
    installHocuspocusLifecycle({ ...production, expectedGenerationToken: () => GEN });
    port = await freePort();
    hp = await startHocuspocus(port);
  });

  afterAll(async () => {
    for (const p of providers) p.destroy();
    await hp.destroy();
    resetHocuspocusLifecycleForTesting();
    resetEventsForTesting();
    clearWorld();
    vi.unstubAllEnvs();
  });

  async function connect(room: string): Promise<Y.Doc> {
    const clientDoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}`,
      name: room,
      document: clientDoc,
      token: GEN,
      WebSocketPolyfill: LoopbackOriginWebSocket as unknown as typeof globalThis.WebSocket,
    } as HocuspocusProviderConfiguration);
    providers.push(provider);
    await waitFor(() => provider.isSynced, `the ${room} provider to sync`);
    return clientDoc;
  }

  it("a forged Tandem's Claude from a client is reverted in CTRL_ROOM and in a document room, on the server and on the client", async () => {
    startOwnershipPublishing();
    open("live-a");
    register(T);
    setDocOwner("live-a", { ownerId: T, kind: "claimed" }, "claim", T);
    await settle();
    const before = { ctrl: getOrCreateDocument(CTRL_ROOM), doc: getOrCreateDocument("live-a") };
    const clients = { ctrl: await connect(CTRL_ROOM), doc: await connect("live-a") };
    // The load swapped both rooms' Y.Docs (the guard must follow the swap).
    expect(getOrCreateDocument(CTRL_ROOM)).not.toBe(before.ctrl);
    expect(getOrCreateDocument("live-a")).not.toBe(before.doc);
    const truth = JSON.stringify(listIn(CTRL_ROOM));
    for (const [room, clientDoc] of [
      [CTRL_ROOM, clients.ctrl],
      ["live-a", clients.doc],
    ] as const) {
      const clientMeta = clientDoc.getMap(Y_MAP_DOCUMENT_META);
      const list = clientMeta.get(Y_MAP_OPEN_DOCUMENTS) as Array<Record<string, unknown>>;
      const restores = ownershipRestoresForTests();
      clientMeta.set(
        Y_MAP_OPEN_DOCUMENTS,
        list.map((e) => ({
          ...e,
          owner: { label: "owner-zzzz", displayKind: "Tandem's Claude", kind: "assigned" },
        })),
      );
      // The forgery reached the server's swapped-in Y.Doc and was seen there.
      await waitFor(() => ownershipRestoresForTests() > restores, `a restore of ${room}`);
      await waitFor(() => JSON.stringify(listIn(room)) === truth, `the server's ${room} restored`);
      await waitFor(
        () => JSON.stringify(clientMeta.get(Y_MAP_OPEN_DOCUMENTS)) === truth,
        `the client's ${room} restored`,
      );
    }
    // The summary key, forged by the CTRL client, comes back too.
    const summary = JSON.stringify(summaryIn());
    clients.ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_OWNERSHIP_SUMMARY, { forged: true });
    await waitFor(
      () =>
        JSON.stringify(clients.ctrl.getMap(Y_MAP_USER_AWARENESS).get(Y_MAP_OWNERSHIP_SUMMARY)) ===
        summary,
      "the client's summary restored",
    );
    // Untouched: the broadcast keeps working on the swapped doc.
    broadcastOpenDocs();
    expect(JSON.stringify(listIn(CTRL_ROOM))).toBe(truth);
  });
});
