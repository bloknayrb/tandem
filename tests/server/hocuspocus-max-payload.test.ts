/**
 * Hocuspocus inbound frame cap (#1822 item 2).
 *
 * `hocuspocusInstance.listen()` used to take no websocket options, so `ws` kept
 * its 100 MiB default: an UNAUTHENTICATED peer's 90 MiB frame moved the process
 * RSS from 179 MB to 331 MB. Hocuspocus always binds 127.0.0.1, so this is
 * loopback-only — the cap is a resource bound, not a network control.
 *
 * Two behavioural specs, and no assertion on the constant's arithmetic: a number
 * pinned against its own derivation guards nothing these two do not.
 *
 * MEMORY — spec (b) sends one frame of MAX_SYNC_PAYLOAD_BYTES + 1 (~66 MiB) and
 * the buffer is transiently allocated on the client side, so the worker peaks
 * around 130 MB while it runs. Both frame specs carry a 60s timeout for the
 * same reason.
 *
 * TEARDOWN ORDER IS LOAD-BEARING. `startHocuspocus` writes a module singleton
 * and exports no stop helper: terminate every ws client FIRST, then
 * `await instance.destroy()`. An un-terminated ~66 MB socket keeps `destroy()`
 * from settling and hangs the worker.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MAX_SYNC_PAYLOAD_BYTES, startHocuspocus } from "../../src/server/yjs/provider.js";
import { allocPort } from "../helpers/alloc-port.js";

let instance: Hocuspocus | null = null;
let port = 0;
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const ws of clients.splice(0)) {
    try {
      ws.terminate();
    } catch {
      // Already closed — nothing to do.
    }
  }
  if (instance) {
    await instance.destroy();
    instance = null;
  }
});

async function start(): Promise<void> {
  port = await allocPort();
  instance = await startHocuspocus(port);
}

/**
 * `assertAllowedOrigin` throws from `onConnect` when the Origin header is
 * missing, and Hocuspocus's Forbidden close would then race the 1009 this spec
 * is asserting. Sending a loopback Origin removes the race.
 */
function connect(): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/max-payload-spec`, {
    origin: `http://127.0.0.1:${port}`,
  });
  clients.push(ws);
  return ws;
}

describe("#1822 item 2 — Hocuspocus caps inbound WebSocket frames", () => {
  it("(a) the live WebSocketServer carries maxPayload === MAX_SYNC_PAYLOAD_BYTES", {
    timeout: 60_000,
  }, async () => {
    await start();
    // Discriminating on purpose: the options are `listen`'s THIRD positional
    // argument, and a maxPayload placed on the constructor config or in the
    // wrong position is accepted and silently ignored. Reading it back off the
    // real server is the only thing that tells those apart.
    // biome-ignore lint/suspicious/noExplicitAny: reaching into Hocuspocus internals is the point
    const wss = (instance as any).server?.webSocketServer;
    expect(wss, "Hocuspocus did not expose server.webSocketServer").toBeTruthy();
    expect(wss.options.maxPayload).toBe(MAX_SYNC_PAYLOAD_BYTES);
  });

  it("(b) an over-cap frame is closed with code 1009", { timeout: 60_000 }, async () => {
    await start();
    const ws = connect();
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.once("error", reject);
      ws.once("close", (code: number) => resolve(code));
      ws.once("open", () => {
        ws.send(Buffer.alloc(MAX_SYNC_PAYLOAD_BYTES + 1));
      });
    });
    // Exactly 1009 (Message Too Big). Never loosen this to "the socket
    // closed": an origin rejection, an auth failure and a crash all close the
    // socket too, and only 1009 says the frame cap is what did it.
    expect(closeCode).toBe(1009);
  });
});
