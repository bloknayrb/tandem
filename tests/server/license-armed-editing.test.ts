import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HocuspocusProvider, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import type { Hocuspocus } from "@hocuspocus/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";

/**
 * Keyless editing, armed (#1521): an unlicensed Tandem is a fully editable
 * editor. Until #1521, Surface A marked every Hocuspocus document room
 * read-only when restricted, so the browser's own edits were silently dropped
 * server-side. This drives a REAL browser-shaped connection with the gate armed
 * and an expired trial, and asserts the write lands on the server's document —
 * so re-adding a read-only clamp anywhere in `onAuthenticate` turns it red.
 */
vi.hoisted(() => {
  process.env.TANDEM_LICENSE_GATE = "1";
});

import { aiRefusal } from "../../src/server/license/ai-refusal.js";
import { trialFilePath } from "../../src/server/license/paths.js";
import {
  getOrCreateDocument,
  installHocuspocusLifecycle,
  resetHocuspocusLifecycleForTesting,
  startHocuspocus,
} from "../../src/server/yjs/provider.js";

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

const DAY = 86_400_000;
const GEN = "gen-armed-editing";
let hp: Hocuspocus;
let port: number;
let dir: string;
let savedDir: string | undefined;
let savedGate: string | undefined;

beforeAll(async () => {
  savedDir = process.env.TANDEM_APP_DATA_DIR;
  savedGate = process.env.TANDEM_LICENSE_GATE;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-license-editing-"));
  fs.writeFileSync(
    trialFilePath(dir),
    JSON.stringify({ version: 1, firstRunAt: new Date(Date.now() - 30 * DAY).toISOString() }),
  );
  process.env.TANDEM_APP_DATA_DIR = dir;
  installHocuspocusLifecycle({
    shouldKeepDocument: () => false,
    onDocSwapped: () => {},
    onDocUnloaded: () => {},
    expectedGenerationToken: () => GEN,
  });
  port = await freePort();
  hp = await startHocuspocus(port);
});

afterAll(async () => {
  await hp.destroy();
  resetHocuspocusLifecycleForTesting();
  if (savedDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = savedDir;
  if (savedGate === undefined) delete process.env.TANDEM_LICENSE_GATE;
  else process.env.TANDEM_LICENSE_GATE = savedGate;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("armed and keyless: the browser's document writes land (#1521)", () => {
  it("is actually refusing the AI (anti-vacuity)", () => {
    expect(aiRefusal()).toMatchObject({ kind: "unlicensed" });
  });

  it("a write over Hocuspocus to a document room persists on the server", async () => {
    const room = "license-armed-editing-room";
    getOrCreateDocument(room); // the server side of the room
    const clientDoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}`,
      name: room,
      document: clientDoc,
      token: GEN,
      WebSocketPolyfill: LoopbackOriginWebSocket as unknown as typeof globalThis.WebSocket,
    } as HocuspocusProviderConfiguration);
    try {
      await waitFor(() => provider.isSynced, "the provider to sync");
      clientDoc.getText("probe").insert(0, "keyless edit");
      await waitFor(
        () => getOrCreateDocument(room).getText("probe").toString() === "keyless edit",
        "the server document to carry the edit",
      );
    } finally {
      provider.destroy();
    }
  });
});
