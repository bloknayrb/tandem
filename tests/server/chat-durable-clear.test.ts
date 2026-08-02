import fs from "fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Y_MAP_CHAT, Y_MAP_CHAT_DOCUMENT_NAMES } from "../../src/shared/constants";

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
