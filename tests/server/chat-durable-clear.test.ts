import fs from "fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  Y_MAP_CHAT,
  Y_MAP_CHAT_DOCUMENT_NAMES,
  Y_MAP_CHAT_STREAM,
} from "../../src/shared/constants";

const controls = vi.hoisted(() => ({
  failWrite: false,
  blockWrite: false,
  release: null as (() => void) | null,
  sessionDir: "",
}));

vi.mock("../../src/server/platform", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/platform")>(
    "../../src/server/platform",
  );
  const pathMod = await import("node:path");
  const osMod = await import("node:os");
  const cryptoMod = await import("node:crypto");
  controls.sessionDir = pathMod.join(osMod.tmpdir(), `tandem-chat-clear-${cryptoMod.randomUUID()}`);
  return { ...actual, SESSION_DIR: controls.sessionDir };
});
vi.mock("../../src/server/file-io/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/file-io/index.js")>(
    "../../src/server/file-io/index.js",
  );
  return {
    ...actual,
    atomicWrite: async (...args: Parameters<typeof actual.atomicWrite>) => {
      if (controls.failWrite) throw new Error("simulated disk failure");
      if (controls.blockWrite) {
        controls.blockWrite = false;
        await new Promise<void>((resolve) => {
          controls.release = resolve;
        });
        controls.release = null;
      }
      return actual.atomicWrite(...args);
    },
  };
});

import {
  noteStreamSidecar,
  resetStreamStalenessForTests,
  STREAM_SIDECAR_WARN_MS,
} from "../../src/server/chat-stream-staleness";
import {
  clearCtrlChatDurably,
  loadCtrlSession,
  restoreCtrlDoc,
  saveCtrlSession,
} from "../../src/server/session/manager";

describe("durable chat clear", () => {
  beforeAll(() => fs.mkdir(controls.sessionDir, { recursive: true }));
  afterAll(() => fs.rm(controls.sessionDir, { recursive: true, force: true }));

  it("persists the cleared clone before deleting the same live IDs", async () => {
    const doc = new Y.Doc();
    doc.getMap(Y_MAP_CHAT).set("old", { id: "old", timestamp: 1 });
    expect(await clearCtrlChatDurably(doc)).toBe(1);
    expect(doc.getMap(Y_MAP_CHAT).size).toBe(0);
    const restored = new Y.Doc();
    restoreCtrlDoc(restored, (await loadCtrlSession())!);
    expect(restored.getMap(Y_MAP_CHAT).size).toBe(0);
  });

  it("removes orphan filename metadata even when chat is already empty", async () => {
    const doc = new Y.Doc();
    doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES).set("orphan", "Orphan.md");

    expect(await clearCtrlChatDurably(doc)).toBe(0);
    expect(doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES).size).toBe(0);
    const restored = new Y.Doc();
    restoreCtrlDoc(restored, (await loadCtrlSession())!);
    expect(restored.getMap(Y_MAP_CHAT_DOCUMENT_NAMES).size).toBe(0);
  });

  it("leaves live chat untouched when persistence fails", async () => {
    const doc = new Y.Doc();
    doc.getMap(Y_MAP_CHAT).set("keep", { id: "keep", timestamp: 2 });
    controls.failWrite = true;
    await expect(clearCtrlChatDurably(doc)).rejects.toThrow("simulated disk failure");
    controls.failWrite = false;
    expect(doc.getMap(Y_MAP_CHAT).has("keep")).toBe(true);
  });

  it("orders preceding and queued-after saves around clear while preserving arrivals", async () => {
    const doc = new Y.Doc();
    const chat = doc.getMap(Y_MAP_CHAT);
    const names = doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES);
    chat.set("old", { id: "old", timestamp: 3, documentId: "old-doc" });
    names.set("old-doc", "Old.md");
    names.set("orphan-doc", "Orphan.md");
    controls.blockWrite = true;
    const precedingSave = saveCtrlSession(doc);
    await vi.waitFor(() => expect(controls.release).toBeTypeOf("function"));
    const clear = clearCtrlChatDurably(doc);
    const queuedAfterClear = saveCtrlSession(doc);
    doc.transact(() => {
      names.set("new-doc", "C:\\private\\New.md");
      chat.set("new", { id: "new", timestamp: 4, documentId: "new-doc" });
    });
    controls.release?.();
    await precedingSave;
    expect(await clear).toBe(1);
    await queuedAfterClear;
    expect(Array.from(chat.keys())).toEqual(["new"]);
    expect(Array.from(names.entries())).toEqual([["new-doc", "New.md"]]);

    const restored = new Y.Doc();
    restoreCtrlDoc(restored, (await loadCtrlSession())!);
    expect(Array.from(restored.getMap(Y_MAP_CHAT).keys())).toEqual(["new"]);
    expect(Array.from(restored.getMap(Y_MAP_CHAT_DOCUMENT_NAMES).entries())).toEqual([
      ["new-doc", "New.md"],
    ]);
  });

  it("persists only filename snapshots across a server restart", async () => {
    const doc = new Y.Doc();
    doc.getMap(Y_MAP_CHAT).set("closed-message", {
      id: "closed-message",
      timestamp: 1,
      documentId: "closed",
    });
    doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES).set("closed", "C:\\private\\Closed.md");
    await saveCtrlSession(doc);
    const restored = new Y.Doc();
    restoreCtrlDoc(restored, (await loadCtrlSession())!);
    expect(restored.getMap(Y_MAP_CHAT_DOCUMENT_NAMES).get("closed")).toBe("Closed.md");
  });
});

describe("chatStream sidecar durability (#1340)", () => {
  beforeAll(() => fs.mkdir(controls.sessionDir, { recursive: true }));
  afterAll(() => fs.rm(controls.sessionDir, { recursive: true, force: true }));

  /** Decode the written session file RAW (no restore-time sweep) — asserts on
   *  the bytes that actually hit disk, not on what restoreCtrlDoc repairs. */
  async function decodeWrittenSnapshot(): Promise<Y.Doc> {
    const raw = new Y.Doc();
    Y.applyUpdate(raw, new Uint8Array(Buffer.from((await loadCtrlSession())!, "base64")));
    return raw;
  }

  function seedStreamingDoc(id: string, rowText: string, streamedText: string): Y.Doc {
    const doc = new Y.Doc();
    doc.getMap(Y_MAP_CHAT).set(id, {
      id,
      author: "claude",
      text: rowText,
      timestamp: 10,
      read: true,
    });
    const yText = new Y.Text();
    doc.transact(() => {
      doc.getMap(Y_MAP_CHAT_STREAM).set(id, yText); // attach before populate
      yText.insert(0, streamedText);
    });
    return doc;
  }

  it("saveCtrlSession mid-stream folds the sidecar into the durable row and never mutates the live doc", async () => {
    const doc = seedStreamingDoc("live-msg", "first flush", "first flush plus streamed tail");
    await saveCtrlSession(doc);

    const raw = await decodeWrittenSnapshot();
    // Crash-mid-stream guarantee: the last-flushed text survives durably…
    expect((raw.getMap(Y_MAP_CHAT).get("live-msg") as { text: string }).text).toBe(
      "first flush plus streamed tail",
    );
    // …and the durable file carries no LIVE sidecar entry.
    expect(raw.getMap(Y_MAP_CHAT_STREAM).size).toBe(0);

    // The fold ran on the snapshot CLONE only — the live doc still streams.
    expect((doc.getMap(Y_MAP_CHAT).get("live-msg") as { text: string }).text).toBe("first flush");
    expect(doc.getMap(Y_MAP_CHAT_STREAM).size).toBe(1);
  });

  it("clearing chat mid-stream does not let the snapshot fold resurrect the erased message", async () => {
    const doc = seedStreamingDoc("erased", "first flush", "first flush plus streamed tail");
    expect(await clearCtrlChatDurably(doc)).toBe(1);

    // The written snapshot: the erased id is gone from BOTH maps. What these
    // assertions actually pin is `foldChatStream`'s `existing &&` guard — the
    // row is deleted before the fold runs, so the fold must not re-`set` it
    // from the in-flight Y.Text and resurrect a message the user just erased.
    // (They do NOT pin `clearCtrlChatDurably`'s snapshot-side sidecar delete,
    // which is redundant with that guard: commenting it out leaves this suite
    // green. The LIVE-side sidecar delete is pinned below, by the last
    // assertion in this test.)
    const raw = await decodeWrittenSnapshot();
    expect(raw.getMap(Y_MAP_CHAT).size).toBe(0);
    expect(raw.getMap(Y_MAP_CHAT_STREAM).size).toBe(0);

    // The live doc: row and orphan sidecar entry both removed.
    expect(doc.getMap(Y_MAP_CHAT).size).toBe(0);
    expect(doc.getMap(Y_MAP_CHAT_STREAM).size).toBe(0);
  });

  it("restoreCtrlDoc sweeps live sidecar entries a snapshot carried: folds real ones, deletes malformed ones", async () => {
    // A snapshot from a future/buggy build that persisted live entries — the
    // write side can't prevent this file existing, so restore must repair it.
    const foreign = seedStreamingDoc("carried", "stale row", "stale row plus streamed tail");
    foreign.getMap(Y_MAP_CHAT_STREAM).set("orphan-no-row", "not-a-ytext");
    const base64 = Buffer.from(Y.encodeStateAsUpdate(foreign)).toString("base64");

    const restored = new Y.Doc();
    restoreCtrlDoc(restored, base64);
    // The Y.Text with a live row folded; the malformed value deleted outright.
    expect((restored.getMap(Y_MAP_CHAT).get("carried") as { text: string }).text).toBe(
      "stale row plus streamed tail",
    );
    expect(restored.getMap(Y_MAP_CHAT_STREAM).size).toBe(0);
    // The sweep never invents a chat row for an entry without one.
    expect(restored.getMap(Y_MAP_CHAT).has("orphan-no-row")).toBe(false);
  });

  it("an EMPTY sidecar Y.Text is dropped, never folded over the live row's text", async () => {
    // Not reachable from today's producer (`write()` no-ops on an empty
    // buffer), but the sweep's whole job is malformed input from some other
    // build — and an empty `Y.Text` is malformed. Folding it would blank a
    // chat row that holds real user-visible text.
    const foreign = new Y.Doc();
    foreign.getMap(Y_MAP_CHAT).set("m1", {
      id: "m1",
      author: "claude",
      text: "a real answer the user can read",
      timestamp: 10,
      read: true,
    });
    foreign.transact(() => {
      foreign.getMap(Y_MAP_CHAT_STREAM).set("m1", new Y.Text()); // attached, never populated
    });
    const base64 = Buffer.from(Y.encodeStateAsUpdate(foreign)).toString("base64");

    const restored = new Y.Doc();
    restoreCtrlDoc(restored, base64);
    expect((restored.getMap(Y_MAP_CHAT).get("m1") as { text: string }).text).toBe(
      "a real answer the user can read",
    );
    expect(restored.getMap(Y_MAP_CHAT_STREAM).size).toBe(0);
  });

  it("an abandoned sidecar entry is reported by the snapshot sweep, once per id", async () => {
    // The leak this tripwire exists for is a producer that crashed, hung or was
    // torn down without finalizing — it emits NO further writes, so nothing on
    // the write path can ever notice. The sweep enumerates live entries on
    // every persist regardless of producer activity, which is why it lives
    // there.
    resetStreamStalenessForTests();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const doc = seedStreamingDoc("abandoned", "first flush", "first flush plus tail");
      noteStreamSidecar("abandoned", Date.now() - STREAM_SIDECAR_WARN_MS - 1_000);

      await saveCtrlSession(doc);
      const warnings = () =>
        errors.mock.calls.filter((call) => String(call[0]).includes("chatStream entry abandoned"));
      expect(warnings()).toHaveLength(1);

      // Warn-once: a second persist with the entry still live stays silent.
      await saveCtrlSession(doc);
      expect(warnings()).toHaveLength(1);
    } finally {
      errors.mockRestore();
      resetStreamStalenessForTests();
    }
  });

  it("a sidecar entry within its lifetime is not reported", async () => {
    resetStreamStalenessForTests();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const doc = seedStreamingDoc("in-flight", "first flush", "first flush plus tail");
      noteStreamSidecar("in-flight", Date.now() - 1_000);
      await saveCtrlSession(doc);
      expect(
        errors.mock.calls.filter((call) => String(call[0]).includes("chatStream entry in-flight")),
      ).toHaveLength(0);
    } finally {
      errors.mockRestore();
      resetStreamStalenessForTests();
    }
  });
});
