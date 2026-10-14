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

import { openFromDisk } from "../../src/server/documents/open.js";
import { aiRefusal } from "../../src/server/license/ai-refusal.js";
import { GATE_ENABLED } from "../../src/server/license/gate-flag.js";
import { resolveLiveLicenseState } from "../../src/server/license/license-state.js";
import { trialFilePath } from "../../src/server/license/paths.js";
import { extractText, populateYDoc } from "../../src/server/mcp/document-model.js";
import {
  getDocument,
  getOrCreateDocument,
  installHocuspocusLifecycle,
  resetHocuspocusLifecycleForTesting,
  startHocuspocus,
} from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_MODE,
  Y_MAP_OPEN_DOCUMENTS,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";
import type { Annotation } from "../../src/shared/types.js";
import { clearOpenDocs } from "../helpers/doc-service.js";
import { createAnnotation, rangeOf } from "../helpers/ydoc-factory.js";

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

/**
 * A browser-shaped client of `room`, synced. The caller destroys the provider.
 *
 * Server-side reads must re-fetch the room every time: `onLoadDocument` merges
 * any pre-existing server doc into Hocuspocus's own and DESTROYS the old one,
 * so a reference captured before the connect is a dead doc afterwards.
 */
async function connect(room: string): Promise<{ clientDoc: Y.Doc; provider: HocuspocusProvider }> {
  const clientDoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: room,
    document: clientDoc,
    token: GEN,
    WebSocketPolyfill: LoopbackOriginWebSocket as unknown as typeof globalThis.WebSocket,
  } as HocuspocusProviderConfiguration);
  await waitFor(() => provider.isSynced, `the provider for ${room} to sync`);
  return { clientDoc, provider };
}

/** The server's current record for `id` in `room`. */
const serverAnnotation = (room: string, id: string) =>
  getDocument(room)?.getMap(Y_MAP_ANNOTATIONS).get(id) as Annotation | undefined;

/**
 * Seed a document room the way the server does: body via `populateYDoc`, then
 * a Claude-authored comment minted by `mintAnnotation` (what
 * `AnnotationLifecycle.create` calls). Headingless on purpose, so flat offset 0
 * is the first character of the body and `[0, 5)` is "Hello".
 */
function seedClaudeComment(room: string, suggestedText?: string): string {
  const ydoc = getOrCreateDocument(room);
  populateYDoc(ydoc, "Hello world");
  return createAnnotation(
    ydoc.getMap(Y_MAP_ANNOTATIONS),
    ydoc,
    "comment",
    rangeOf(0, 5, ydoc),
    "Swap the greeting",
    suggestedText === undefined ? undefined : { suggestedText },
  );
}

describe("armed and keyless: the browser's document writes land (#1521)", () => {
  // Every probe below asserts a write LANDS, so it cannot pass because nothing
  // ran. What it could pass on is a fixture that is not really armed — then
  // "the editor is not refused" would be saying nothing about a restricted
  // install. `onAuthenticate` has no licence branch, so a fresh-trial twin of
  // these probes would be byte-identical; the twin is this arming assertion,
  // repeated at the top of each probe so an env change mid-file cannot slip by.
  it("is actually armed and refusing the AI (anti-vacuity)", () => {
    expect(GATE_ENABLED).toBe(true);
    expect(resolveLiveLicenseState()).toMatchObject({ gateActive: true, status: "restricted" });
    expect(aiRefusal()).toMatchObject({ kind: "unlicensed" });
  });

  it("a write over Hocuspocus to a document room persists on the server", async () => {
    const room = "license-armed-editing-room";
    getOrCreateDocument(room); // the server side of the room
    const { clientDoc, provider } = await connect(room);
    try {
      clientDoc.getText("probe").insert(0, "keyless edit");
      await waitFor(
        () => getOrCreateDocument(room).getText("probe").toString() === "keyless edit",
        "the server document to carry the edit",
      );
    } finally {
      provider.destroy();
    }
  });

  // #1521 acceptance: accept and dismiss are the user's review actions, and a
  // keyless install still has Claude's earlier comments to review. Each write
  // below is the one `useAnnotationReview.svelte.ts` makes — a status write via
  // `withBrowser` into `Y_MAP_ANNOTATIONS`, and for accept the text replacement
  // y-prosemirror makes on the body fragment first (Tiptap does not run in
  // Node, so the XmlText edit stands in for `applySuggestion`'s transaction).
  // A read-only clamp drops both silently, so either `waitFor` would time out.
  describe("accept and dismiss of a Claude suggestion (#1521 acceptance)", () => {
    it("dismiss: the user's status write lands on the server", async () => {
      expect(aiRefusal()).toMatchObject({ kind: "unlicensed" });
      const room = "license-armed-dismiss-room";
      const id = seedClaudeComment(room);
      const { clientDoc, provider } = await connect(room);
      try {
        const map = clientDoc.getMap(Y_MAP_ANNOTATIONS);
        const raw = map.get(id) as Annotation | undefined;
        expect(raw?.status).toBe("pending");
        withBrowser(clientDoc, () => map.set(id, { ...(raw as Annotation), status: "dismissed" }));
        await waitFor(
          () => serverAnnotation(room, id)?.status === "dismissed",
          "the server to see the dismissal",
        );
        // Dismiss rewrites nothing.
        expect(extractText(getDocument(room) as Y.Doc)).toBe("Hello world");
      } finally {
        provider.destroy();
      }
    });

    it("accept: the replaced text and the accepted status both land on the server", async () => {
      expect(aiRefusal()).toMatchObject({ kind: "unlicensed" });
      const room = "license-armed-accept-room";
      const id = seedClaudeComment(room, "Howdy");
      const { clientDoc, provider } = await connect(room);
      try {
        const map = clientDoc.getMap(Y_MAP_ANNOTATIONS);
        const raw = map.get(id) as Annotation | undefined;
        expect(raw).toMatchObject({ status: "pending", author: "claude", suggestedText: "Howdy" });

        // Apply BEFORE the status write, each its own transaction (#1826).
        const paragraph = clientDoc.getXmlFragment("default").get(0) as Y.XmlElement;
        const text = paragraph.get(0) as Y.XmlText;
        withBrowser(clientDoc, () => {
          text.delete(0, 5);
          text.insert(0, "Howdy");
        });
        withBrowser(clientDoc, () => map.set(id, { ...(raw as Annotation), status: "accepted" }));

        await waitFor(
          () => serverAnnotation(room, id)?.status === "accepted",
          "the server to see the acceptance",
        );
        await waitFor(
          () => extractText(getDocument(room) as Y.Doc) === "Howdy world",
          "the server body to carry the accepted text",
        );
      } finally {
        provider.destroy();
      }
    });
  });

  // #1521 acceptance: CTRL_ROOM is the bootstrap room every tab joins, and it
  // was never clamped — but a clamp re-added "for every room" would take it
  // too, which breaks Solo/Tandem mode and the tab list without any error.
  describe("CTRL_ROOM (#1521 acceptance)", () => {
    it("the browser's Solo/Tandem mode write lands on the server", async () => {
      expect(aiRefusal()).toMatchObject({ kind: "unlicensed" });
      const { clientDoc, provider } = await connect(CTRL_ROOM);
      try {
        const awareness = clientDoc.getMap(Y_MAP_USER_AWARENESS);
        const serverMode = () =>
          getDocument(CTRL_ROOM)?.getMap(Y_MAP_USER_AWARENESS).get(Y_MAP_MODE);
        // Two writes, so a value that happened to be there already cannot pass.
        withBrowser(clientDoc, () => awareness.set(Y_MAP_MODE, "solo"));
        await waitFor(() => serverMode() === "solo", "the server to see mode=solo");
        withBrowser(clientDoc, () => awareness.set(Y_MAP_MODE, "tandem"));
        await waitFor(() => serverMode() === "tandem", "the server to see mode=tandem");
      } finally {
        provider.destroy();
      }
    });

    it("the browser receives the server's openDocuments broadcast after an open", async () => {
      expect(aiRefusal()).toMatchObject({ kind: "unlicensed" });
      // Sync FIRST, so this proves a live server→client push rather than the
      // initial state merge.
      const { clientDoc, provider } = await connect(CTRL_ROOM);
      const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-license-editing-docs-"));
      try {
        const file = path.join(docsDir, "broadcast.md");
        fs.writeFileSync(file, "# Broadcast\n\nBody.\n");
        const clientList = () =>
          clientDoc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_OPEN_DOCUMENTS) as
            | Array<{ id: string }>
            | undefined;
        const opened = await openFromDisk(file);
        await waitFor(
          () => clientList()?.some((d) => d.id === opened.documentId) ?? false,
          "the client's openDocuments to list the opened document",
        );
      } finally {
        provider.destroy();
        clearOpenDocs();
        try {
          fs.rmSync(docsDir, { recursive: true, force: true });
        } catch {
          // A live fs.watch handle can hold the dir on Windows; the OS temp
          // reaper gets it.
        }
      }
    });
  });
});
