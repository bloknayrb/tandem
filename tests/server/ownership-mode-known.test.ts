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
import { addDoc, removeDoc } from "../../src/server/documents/registry-testing.js";
import {
  attachCtrlObservers,
  reattachCtrlObservers,
  resetForTesting,
} from "../../src/server/events/queue.js";
import {
  documentWaiting,
  ownershipChatSide,
  setWaitingWrittenSinceForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import {
  noteTransportRegistered,
  ownershipSnapshotForTests,
  replayModeKnownAfterSupervisorStart,
  resetOwnershipForTests,
  setDocOwner,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnershipFrameSink,
  setStartOrWakeSink,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";

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

  it("the supervisor's start replays the ask when the observer asked before it existed, and only then", () => {
    attachCtrlObservers();
    replayModeKnownAfterSupervisorStart();
    expect(forwarded).toEqual([]);
    clientWritesMode("tandem");
    expect(forwarded).toEqual(["mode-known"]);
    replayModeKnownAfterSupervisorStart();
    expect(forwarded).toEqual(["mode-known", "mode-known"]);
  });

  it("flag off, the replay forwards nothing", () => {
    attachCtrlObservers();
    clientWritesMode("tandem");
    forwarded = [];
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    replayModeKnownAfterSupervisorStart();
    expect(forwarded).toEqual([]);
  });
});

// The other-owner half (#2358, the flip-blocker row "The restart question's
// other-owner half"): the same first Tandem reading sends step 5's
// `ownership` frame (through ownership's frame sink, as `index.ts` sets it)
// when work waits for a session other than Tandem's Claude, or for nobody.
// The real waiting probe and chat side; a counting sink for the frame (the
// wake socket's writer, its coalescing and its licence ask are
// `ownership-wake-frame.test.ts`'s).
describe("the mode-unknown observer's other-owner half: the ownership frame", () => {
  const B = "claude:modeknown-b";
  let frames = 0;
  let run = 0;
  const docIds: string[] = [];

  function mkDoc(name: string): { id: string; ydoc: Y.Doc } {
    run++;
    const id = `modeknown${run}-${name}`;
    const ydoc = getOrCreateDocument(id);
    populateYDoc(ydoc, "Hello world, this is a test document.");
    addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
    docIds.push(id);
    return { id, ydoc };
  }

  /** A user comment, written as the browser writes one (while the mode is unknown). */
  function userComment(ydoc: Y.Doc, id: string): void {
    withBrowser(ydoc, () =>
      ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
        id,
        author: "user",
        type: "comment",
        audience: "outbound",
        range: { from: 0, to: 5 },
        content: `text of ${id}`,
        status: "pending",
        timestamp: Date.now(),
        rev: 1,
      }),
    );
  }

  /** An unread doc-less user chat message. */
  function userChat(key: string): void {
    withInternal(ctrl(), () =>
      ctrl()
        .getMap(Y_MAP_CHAT)
        .set(key, { id: key, author: "user", text: "hello", timestamp: Date.now(), read: false }),
    );
  }

  /** The seams `index.ts` wires for the frame, and B's record (after `restart()`). */
  function world(): void {
    frames = 0;
    setOwnershipFrameSink(() => frames++);
    setWaitingProbe(documentWaiting);
    setOpenDocumentIdsSource(() => getOpenDocs().keys());
    setOwnershipChatSide(ownershipChatSide);
    setTransportView(() => [{ ownerId: B, openStreams: 0 }]);
    noteTransportRegistered(B, { recordKind: "claude" });
  }

  beforeEach(() => {
    setWaitingWrittenSinceForTests(undefined);
    world();
  });

  afterEach(() => {
    for (const id of docIds.splice(0)) {
      removeDoc(id);
      removeDocument(id);
    }
    setWaitingProbe(() => false);
    setWaitingWrittenSinceForTests(Date.now());
  });

  it("another session holds a document with a comment made while the mode was unknown: one frame, beside Tandem's Claude's mode-known", () => {
    const d = mkDoc("held-by-b");
    setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
    attachCtrlObservers();
    userComment(d.ydoc, "c1");
    expect(frames).toBe(0);
    clientWritesMode("tandem");
    expect(forwarded).toEqual(["mode-known"]);
    expect(frames).toBe(1);
    // Once per run, as the forward is.
    clientWritesMode("tandem");
    expect(frames).toBe(1);
  });

  it("an unowned document with the comment: one frame (anchor: the row above)", () => {
    const d = mkDoc("unowned");
    attachCtrlObservers();
    userComment(d.ydoc, "c1");
    clientWritesMode("tandem");
    expect(frames).toBe(1);
  });

  it("a document only Tandem's Claude holds: no frame, its forward only (anchor: the first row)", () => {
    setTandemPresenceSource(() => true);
    const d = mkDoc("tandem");
    setDocOwner(d.id, { ownerId: TANDEM_OWNER_ID, kind: "claimed" }, "claim", TANDEM_OWNER_ID);
    attachCtrlObservers();
    userComment(d.ydoc, "c1");
    clientWritesMode("tandem");
    expect(forwarded).toEqual(["mode-known"]);
    expect(frames).toBe(0);
  });

  it("nothing waiting: no frame (anchor: the first row)", () => {
    const d = mkDoc("empty");
    setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
    attachCtrlObservers();
    clientWritesMode("tandem");
    expect(forwarded).toEqual(["mode-known"]);
    expect(frames).toBe(0);
  });

  it("doc-less chat claimable per message (Tandem's Claude not present): one frame; Tandem's Claude present makes it its own: none", () => {
    userChat("m1");
    attachCtrlObservers();
    clientWritesMode("tandem");
    expect(frames).toBe(1);
    restart();
    world();
    setTandemPresenceSource(() => true);
    userChat("m2");
    attachCtrlObservers();
    clientWritesMode("tandem");
    expect(forwarded).toEqual(["mode-known"]);
    expect(frames).toBe(0);
  });

  it("a Solo reading first: unknown→Solo→Tandem is the release route's, so no frame (anchor: the first row)", () => {
    const d = mkDoc("solo-first");
    setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
    attachCtrlObservers();
    userComment(d.ydoc, "c1");
    clientWritesMode("solo");
    clientWritesMode("tandem");
    expect(frames).toBe(0);
  });

  it("flag off: no frame (anchor: the first row)", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const d = mkDoc("dark");
    attachCtrlObservers();
    userComment(d.ydoc, "c1");
    clientWritesMode("tandem");
    expect(forwarded).toEqual([]);
    expect(frames).toBe(0);
  });
});
