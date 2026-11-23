/**
 * The mode-unknown observer (#2358, the restart question; ADR-054's
 * mode-unknown observer amendment; Bryan, 2026-11-23: "Build an observer").
 *
 * After a restart CTRL_ROOM's mode key can be absent (`readModeState()` reads
 * `"indeterminate"`) until a client writes it, and the waiting decision treats
 * that as not-Tandem, so nothing waiting starts or wakes Tandem's Claude. The
 * observer `attachCtrlObservers` installs reports the mode at install and at
 * every change of the key to `noteModeObserved`, which forwards
 * `startOrWake("mode-known")` once per server run, the first time the mode
 * reads Tandem after reading unknown. The supervisor's half (Off, the licence,
 * the pass asking the waiting decision) is in
 * `tests/server/launcher/supervisor-presence.test.ts`.
 *
 * "A restart" is fresh module state: the queue, the ownership module and the
 * CTRL_ROOM document reset, then `attachCtrlObservers()` as `index.ts` calls it
 * at boot. A client's write is applied as Hocuspocus applies it, with a
 * `Connection`-shaped origin.
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as Y from "yjs";
import {
  attachCtrlObservers,
  reattachCtrlObservers,
  resetForTesting,
} from "../../src/server/events/queue.js";
import {
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setStartOrWakeSink,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_MODE, Y_MAP_USER_AWARENESS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";

let forwarded: string[] = [];
let errSpy: MockInstance;

function ctrl(): Y.Doc {
  return getOrCreateDocument(CTRL_ROOM);
}

/** A browser window writing the mode over its socket, as Hocuspocus applies it. */
function clientWritesMode(mode: "solo" | "tandem"): void {
  const doc = ctrl();
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(scratch);
  scratch.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, mode);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(scratch, before), { socketId: "0123456789abcdef" });
}

/** The mode a restored ctrl session carries, written before the boot attach. */
function restoredMode(mode: "solo" | "tandem"): void {
  withInternal(ctrl(), () => ctrl().getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, mode));
}

/** Hocuspocus's swap: a new CTRL_ROOM document carrying the old one's state. */
function swapCtrlDoc(): void {
  const oldState = Y.encodeStateAsUpdate(ctrl());
  removeDocument(CTRL_ROOM);
  Y.applyUpdate(ctrl(), oldState);
  reattachCtrlObservers();
}

function restart(): void {
  resetForTesting();
  removeDocument(CTRL_ROOM);
  resetOwnershipForTests();
  forwarded = [];
  setStartOrWakeSink((cause) => forwarded.push(cause));
}

beforeEach(() => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  restart();
});

afterEach(() => {
  resetForTesting();
  removeDocument(CTRL_ROOM);
  resetOwnershipForTests();
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe("the mode-unknown observer (#2358, the restart question)", () => {
  it("a restart with the mode unknown, then a client writes tandem: one forward, mode-known", () => {
    attachCtrlObservers();
    expect(forwarded).toEqual([]);
    clientWritesMode("tandem");
    expect(forwarded).toEqual(["mode-known"]);
  });

  it("the client writes solo instead: none; and tandem after that is the release route's, so none", () => {
    attachCtrlObservers();
    clientWritesMode("solo");
    expect(forwarded).toEqual([]);
    clientWritesMode("tandem");
    expect(forwarded).toEqual([]);
  });

  it("a second tandem write in the same run: none (once per server run, even after unknown again)", () => {
    attachCtrlObservers();
    clientWritesMode("tandem");
    clientWritesMode("tandem");
    clientWritesMode("solo");
    clientWritesMode("tandem");
    withInternal(ctrl(), () => ctrl().getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE));
    clientWritesMode("tandem");
    expect(forwarded).toEqual(["mode-known"]);
  });

  it("a mode restored at boot is known: tandem or solo, nothing that follows forwards", () => {
    restoredMode("tandem");
    attachCtrlObservers();
    clientWritesMode("tandem");
    clientWritesMode("solo");
    clientWritesMode("tandem");
    expect(forwarded).toEqual([]);
    restart();
    restoredMode("solo");
    attachCtrlObservers();
    clientWritesMode("tandem");
    expect(forwarded).toEqual([]);
  });

  it("a CTRL_ROOM swap while still unknown re-attaches, and the client's tandem on the new document forwards once", () => {
    attachCtrlObservers();
    swapCtrlDoc();
    clientWritesMode("tandem");
    expect(forwarded).toEqual(["mode-known"]);
    swapCtrlDoc();
    clientWritesMode("tandem");
    expect(forwarded).toEqual(["mode-known"]);
  });

  it("a swap that copies a tandem in while unknown forwards at the re-attach, once", () => {
    attachCtrlObservers();
    // A tandem the old document's observer never saw (written while it was
    // detached), carried in by the swap.
    resetForTesting();
    restoredMode("tandem");
    swapCtrlDoc();
    expect(forwarded).toEqual(["mode-known"]);
    swapCtrlDoc();
    expect(forwarded).toEqual(["mode-known"]);
  });

  it("flag off: nothing forwards, nothing is recorded, and the log is the attach line alone", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const before = JSON.stringify(ownershipSnapshotForTests());
    attachCtrlObservers();
    clientWritesMode("tandem");
    swapCtrlDoc();
    clientWritesMode("solo");
    clientWritesMode("tandem");
    expect(forwarded).toEqual([]);
    expect(JSON.stringify(ownershipSnapshotForTests())).toBe(before);
    expect(errSpy.mock.calls.map((c) => c.join(" "))).toEqual([
      "[EventQueue] Attached CTRL_ROOM observers (chat + documentMeta)",
      "[EventQueue] Attached CTRL_ROOM observers (chat + documentMeta)",
    ]);
    // Turned on later in the same run, the flag-off stretch left nothing armed.
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    clientWritesMode("tandem");
    expect(forwarded).toEqual([]);
  });
});
