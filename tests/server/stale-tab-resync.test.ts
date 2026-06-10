import net from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Hocuspocus } from "@hocuspocus/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { populateYDoc } from "../../src/server/mcp/document.js";
import {
  getDocument,
  getOrCreateDocument,
  setGenerationTokenSource,
  startHocuspocus,
} from "../../src/server/yjs/provider.js";
import { CTRL_ROOM } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { makeDoc } from "../helpers/ydoc-factory.js";

/**
 * Integration tests for the stale-tab generation gate: a browser tab that
 * survives a server restart must NOT be able to CRDT-merge its old Y.Doc
 * state back into the server's freshly-loaded document. The gate lives in
 * Hocuspocus `onAuthenticate` (sync messages are queued per-document until
 * the Auth message validates; a throw never drains the queue), keyed on a
 * per-server-run generation id that clients pin as their provider token.
 *
 * Real WebSockets, real Hocuspocus — not mocks: the ordering guarantee
 * (rejection precedes ALL sync processing) is exactly what mocks can't prove.
 */

/** ws subclass that presents an allowlisted Origin (the server's DNS-rebinding
 *  check requires one; the v3 provider constructs the socket with one arg). */
class LoopbackOriginWebSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url, [], { headers: { Origin: "http://127.0.0.1" } });
  }
}

/** ws subclass presenting a disallowed Origin — simulates a DNS-rebinding page. */
class EvilOriginWebSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url, [], { headers: { Origin: "http://evil.example.com" } });
  }
}

/** OS-assigned free port — avoids Windows' reserved 49152–49251 collisions. */
function freeEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForEvent<T = unknown>(
  provider: HocuspocusProvider,
  event: string,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for provider "${event}"`)),
      timeoutMs,
    );
    provider.on(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Populate a server doc's default fragment with one text paragraph. */
function populateServerDoc(roomName: string, text: string): Y.Doc {
  const doc = getOrCreateDocument(roomName);
  withInternal(doc, () => populateYDoc(doc, text));
  return doc;
}

function makeClient(port: number, roomName: string, token: string | null, ydoc?: Y.Doc) {
  return new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: roomName,
    document: ydoc ?? new Y.Doc(),
    token,
    WebSocketPolyfill: LoopbackOriginWebSocket as unknown as typeof globalThis.WebSocket,
  });
}

describe("stale-tab generation gate", () => {
  let hp: Hocuspocus;
  let port: number;
  let currentGen: string | null;
  const clients: HocuspocusProvider[] = [];

  beforeEach(async () => {
    currentGen = "gen-current";
    setGenerationTokenSource(() => currentGen);
    port = await freeEphemeralPort();
    hp = await startHocuspocus(port);
  });

  afterEach(async () => {
    for (const c of clients) c.destroy();
    clients.length = 0;
    await hp.destroy();
  });

  it("documents the failure mode: disjoint-history merge duplicates content", () => {
    // No server involved — this is WHY the gate exists. Two Y.Docs that never
    // shared history (server reloaded from disk; tab kept its old doc) merge
    // to the UNION of both contents, not a replacement.
    const serverDoc = makeDoc("fresh from disk");
    const staleDoc = makeDoc("stale tab content");

    Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(staleDoc));

    const merged = serverDoc.getXmlFragment("default").toString();
    expect(merged).toContain("fresh from disk");
    expect(merged).toContain("stale tab content"); // the corruption
  });

  it("syncs a current-generation client both ways", async () => {
    populateServerDoc("room-happy", "hello from server");

    const client = makeClient(port, "room-happy", "gen-current");
    clients.push(client);
    await waitForEvent(client, "synced");

    expect(client.document.getXmlFragment("default").toString()).toContain("hello from server");

    // Client edit propagates to the server's authoritative doc.
    client.document.transact(() => {
      const p = new Y.XmlElement("paragraph");
      client.document.getXmlFragment("default").insert(0, [p]);
      p.insert(0, [new Y.XmlText("typed in browser")]);
    });
    await expect
      .poll(() => getDocument("room-happy")?.getXmlFragment("default").toString() ?? "", {
        timeout: 5000,
      })
      .toContain("typed in browser");
  });

  it("rejects a stale-generation client before its state can merge back", async () => {
    populateServerDoc("room-gated", "fresh server content");

    // The stale tab: a ydoc with disjoint history, pinned to the OLD generation.
    const staleYdoc = makeDoc("stale tab content");
    const stale = makeClient(port, "room-gated", "gen-previous-run", staleYdoc);
    clients.push(stale);

    await waitForEvent(stale, "authenticationFailed");
    // Give any (wrongly) queued sync messages time to surface if the gate leaked.
    await sleep(300);

    const serverContent = getDocument("room-gated")?.getXmlFragment("default").toString() ?? "";
    expect(serverContent).toContain("fresh server content");
    expect(serverContent).not.toContain("stale tab content");
    expect(stale.isAuthenticated).toBe(false);
  });

  it("gates CTRL_ROOM too — a stale ctrl client cannot clobber the control channel", async () => {
    const stale = makeClient(port, CTRL_ROOM, "gen-previous-run");
    clients.push(stale);
    await waitForEvent(stale, "authenticationFailed");
    expect(stale.isAuthenticated).toBe(false);
  });

  it("rejects a client with no token at all", async () => {
    // The v3 provider sends an empty-string Auth message when token is null —
    // it must not pass the gate.
    const tokenless = makeClient(port, "room-no-token", null);
    clients.push(tokenless);
    await waitForEvent(tokenless, "authenticationFailed");
    expect(tokenless.isAuthenticated).toBe(false);
  });

  it("rejects a disallowed origin even with a valid generation token", async () => {
    // Pins the origin check that runs inside onAuthenticate (the authoritative
    // DNS-rebinding copy — onConnect's copy races queued message processing).
    // The token is VALID so only the origin can be what rejects this client.
    populateServerDoc("room-evil-origin", "server content");
    const evil = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}`,
      name: "room-evil-origin",
      document: makeDoc("evil content"),
      token: "gen-current",
      WebSocketPolyfill: EvilOriginWebSocket as unknown as typeof globalThis.WebSocket,
    });
    clients.push(evil);

    // Either gate may win the race (onAuthenticate → authenticationFailed,
    // onConnect → socket close); the invariant is that sync NEVER happens.
    const outcome = await Promise.race([
      waitForEvent(evil, "synced").then(() => "synced"),
      waitForEvent(evil, "authenticationFailed").then(() => "rejected"),
      waitForEvent(evil, "disconnect").then(() => "rejected"),
    ]);
    expect(outcome).toBe("rejected");
    await sleep(300);
    const serverContent =
      getDocument("room-evil-origin")?.getXmlFragment("default").toString() ?? "";
    expect(serverContent).toContain("server content");
    expect(serverContent).not.toContain("evil content");
  });

  it("fails closed when no generation exists yet", async () => {
    currentGen = null; // simulates a connection before writeGenerationId()
    const client = makeClient(port, "room-preboot", "anything");
    clients.push(client);
    await waitForEvent(client, "authenticationFailed");
    expect(client.isAuthenticated).toBe(false);
  });

  it("admits a re-created client after the generation rotates (the rebuild path)", async () => {
    populateServerDoc("room-rebuild", "post-restart content");

    // Old-generation provider is rejected...
    const stale = makeClient(port, "room-rebuild", "gen-previous-run");
    clients.push(stale);
    await waitForEvent(stale, "authenticationFailed");
    stale.destroy();

    // ...the client fetches the new generation (via /api/info in production)
    // and reconnects with a FRESH ydoc + the new token.
    const rebuilt = makeClient(port, "room-rebuild", "gen-current");
    clients.push(rebuilt);
    await waitForEvent(rebuilt, "synced");
    expect(rebuilt.document.getXmlFragment("default").toString()).toContain("post-restart content");
  });
});
