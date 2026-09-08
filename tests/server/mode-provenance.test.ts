/**
 * #1733 — server-side mode provenance.
 *
 * `tandem_status` once reported `solo` for minutes while the user's toggle read
 * Tandem, and nothing anywhere could say WHO had written the losing value. The
 * client-side detector compares the room against its own last broadcast, so it
 * sees only disagreements it is party to. The server sees every write's
 * transaction origin, and now records the last one.
 *
 * This spec is the provenance field and nothing more — the conditional release
 * is #1769's.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  attachCtrlObservers,
  reattachCtrlObservers,
  resetForTesting,
} from "../../src/server/events/queue.js";
import {
  _resetModeProvenanceForTests,
  installModeProvenanceObserver,
  readModeProvenance,
} from "../../src/server/mode.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_MODE, Y_MAP_USER_AWARENESS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";

const SOCKET_A = "0123456789abcdef";
const SOCKET_B = "fedcba9876543210";

function ctrl(): Y.Doc {
  return getOrCreateDocument(CTRL_ROOM);
}

function setMode(mode: string | undefined): void {
  withInternal(ctrl(), () => {
    const aw = ctrl().getMap(Y_MAP_USER_AWARENESS);
    if (mode === undefined) aw.delete(Y_MAP_MODE);
    else aw.set(Y_MAP_MODE, mode);
  });
}

/**
 * A browser window writing the mode over its CRDT socket, the way Hocuspocus
 * applies it: sync-first (so the write is causally after the incumbent rather
 * than concurrent), then `Y.applyUpdate` with a `Connection`-shaped origin.
 */
function clientWritesMode(socketId: string, mode: string): void {
  const doc = ctrl();
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(scratch);
  scratch.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, mode);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(scratch, before), { socketId });
}

let cleanup: (() => void) | undefined;

beforeEach(() => {
  resetForTesting();
  removeDocument(CTRL_ROOM);
  _resetModeProvenanceForTests();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  resetForTesting();
  removeDocument(CTRL_ROOM);
  _resetModeProvenanceForTests();
});

describe("mode provenance (#1733)", () => {
  it("is null on an empty ctrl doc — no fabricated `restore`", () => {
    cleanup = installModeProvenanceObserver(ctrl());
    expect(readModeProvenance()).toBeNull();
  });

  it("records the writing connection by an opaque tag, and the LAST writer wins", () => {
    cleanup = installModeProvenanceObserver(ctrl());

    clientWritesMode(SOCKET_A, "solo");
    const first = readModeProvenance();
    expect(first).toMatchObject({
      source: "client",
      connection: SOCKET_A.slice(0, 8),
      value: "solo",
    });
    expect(typeof first?.at).toBe("number");

    // Kills "first writer wins": the field names the LAST transaction that
    // touched the key.
    clientWritesMode(SOCKET_B, "tandem");
    expect(readModeProvenance()).toMatchObject({
      source: "client",
      connection: SOCKET_B.slice(0, 8),
      value: "tandem",
    });
  });

  it("classifies a server-tagged write and an origin-less apply", () => {
    cleanup = installModeProvenanceObserver(ctrl());

    setMode("solo");
    expect(readModeProvenance()).toMatchObject({
      source: "server",
      origin: "internal",
      value: "solo",
    });

    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(ctrl()));
    const before = Y.encodeStateVector(scratch);
    scratch.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, "tandem");
    Y.applyUpdate(ctrl(), Y.encodeStateAsUpdate(scratch, before));
    expect(readModeProvenance()).toMatchObject({ source: "unknown", value: "tandem" });
  });

  it("attributes a key already present at install to the ctrl-session restore", () => {
    // `restoreCtrlSession` runs BEFORE `attachCtrlObservers`, so its replayed
    // write is never observed — attribution at install is the only way to see it.
    setMode("solo");
    cleanup = installModeProvenanceObserver(ctrl());
    expect(readModeProvenance()).toMatchObject({ source: "restore", value: "solo" });

    clientWritesMode(SOCKET_A, "tandem");
    expect(readModeProvenance()).toMatchObject({ source: "client", value: "tandem" });
  });

  it("survives the Hocuspocus doc swap without being reset or relabelled", () => {
    attachCtrlObservers();
    clientWritesMode(SOCKET_A, "solo");
    expect(readModeProvenance()).toMatchObject({ source: "client", value: "solo" });

    // The production swap copies the old doc's state, so the key IS present when
    // the observer re-installs. Without the `=== null` conjunct at install, the
    // live `client` record would be relabelled `restore` mid-session.
    const oldState = Y.encodeStateAsUpdate(ctrl());
    removeDocument(CTRL_ROOM);
    Y.applyUpdate(ctrl(), oldState);
    reattachCtrlObservers();

    expect(readModeProvenance()).toMatchObject({
      source: "client",
      connection: SOCKET_A.slice(0, 8),
      value: "solo",
    });

    clientWritesMode(SOCKET_B, "tandem");
    expect(readModeProvenance()).toMatchObject({
      source: "client",
      connection: SOCKET_B.slice(0, 8),
      value: "tandem",
    });
  });
});
