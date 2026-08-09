import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { _pushEventForTests, getSubscriberCount } from "../../../src/server/events/queue.js";
import type { TandemEvent } from "../../../src/server/events/types.js";
import {
  attachWakeSocket,
  getWakeEndpoint,
  verifyWakeUpgrade,
} from "../../../src/server/events/wake-socket.js";
import { setCtrlMode } from "../../helpers/ctrl-mode.js";

/**
 * The wake socket's guard and its frames.
 *
 * The guard gets the most attention here because a WebSocket upgrade is NOT
 * subject to the same-origin policy — CORS, which does most of the work on
 * `/api/*`, does nothing on a WS handshake. A page on any origin can open a
 * socket to `ws://127.0.0.1:3479` and read every frame unless the server itself
 * refuses. So each rejection below is a control, not a nicety.
 */

const LOOPBACK = { host: "127.0.0.1:3479", remoteAddress: "127.0.0.1" };

describe("verifyWakeUpgrade", () => {
  it("accepts a loopback native client on the wake path", () => {
    expect(verifyWakeUpgrade({ url: "/api/wake", origin: undefined, ...LOOPBACK })).toBe("accept");
  });

  it("classifies a non-wake path rather than rejecting it", () => {
    // Registering an `upgrade` listener removes Node's default of destroying
    // unhandled upgrade sockets, so the caller has to know the difference
    // between "not mine" and "mine and refused" to clean up correctly.
    expect(verifyWakeUpgrade({ url: "/api/events", origin: undefined, ...LOOPBACK })).toBe(
      "not-wake-path",
    );
  });

  it("matches the PATHNAME, not a prefix", () => {
    // `startsWith` would accept both of these.
    expect(verifyWakeUpgrade({ url: "/api/wakeful", origin: undefined, ...LOOPBACK })).toBe(
      "not-wake-path",
    );
    expect(verifyWakeUpgrade({ url: "/api/wake/../mcp", origin: undefined, ...LOOPBACK })).toBe(
      "not-wake-path",
    );
  });

  it("accepts a query string on the wake path", () => {
    expect(verifyWakeUpgrade({ url: "/api/wake?since=1", origin: undefined, ...LOOPBACK })).toBe(
      "accept",
    );
  });

  it("rejects a non-loopback peer even with a perfect Host and Origin", () => {
    // `Monitor`'s ws source takes `{url, protocols}` and has no header field,
    // so a remote consumer could not present a Bearer token even if we allowed
    // one. Loopback is the whole posture here, not merely the default.
    expect(
      verifyWakeUpgrade({
        url: "/api/wake",
        host: "127.0.0.1:3479",
        origin: "http://127.0.0.1:5173",
        remoteAddress: "192.168.1.50",
      }),
    ).toBe("reject-remote");
  });

  it("fails closed on an unknown remote address", () => {
    expect(
      verifyWakeUpgrade({
        url: "/api/wake",
        host: "127.0.0.1",
        origin: undefined,
        remoteAddress: undefined,
      }),
    ).toBe("reject-remote");
  });

  it("rejects a rebound Host from loopback", () => {
    expect(
      verifyWakeUpgrade({
        url: "/api/wake",
        host: "evil.com",
        origin: undefined,
        remoteAddress: "127.0.0.1",
      }),
    ).toBe("reject-host");
  });

  it("rejects a cross-origin browser socket", () => {
    // The case CORS would have caught on a normal fetch and does not catch
    // here. A page on evil.com CAN open this socket; only the server can say no.
    expect(verifyWakeUpgrade({ url: "/api/wake", origin: "https://evil.com", ...LOOPBACK })).toBe(
      "reject-origin",
    );
  });

  it("rejects Origin: null rather than treating it as absent", () => {
    // `null` is the origin serialization of OPAQUE contexts, so a sandboxed or
    // `data:` iframe on any page sends it. Collapsing it into the no-Origin
    // native-client case would hand the excluded attacker the pass. Same trap
    // as #1291, reached by a different road.
    expect(verifyWakeUpgrade({ url: "/api/wake", origin: "null", ...LOOPBACK })).toBe(
      "reject-origin",
    );
  });

  it("accepts the origins Tandem's own UI actually uses", () => {
    for (const origin of ["http://127.0.0.1:5173", "http://tauri.localhost", "tauri://localhost"]) {
      expect(verifyWakeUpgrade({ url: "/api/wake", origin, ...LOOPBACK })).toBe("accept");
    }
  });

  it("rejects bare localhost, which the allowlist deliberately dropped", () => {
    expect(
      verifyWakeUpgrade({ url: "/api/wake", origin: "http://localhost:5173", ...LOOPBACK }),
    ).toBe("reject-origin");
  });
});

describe("the wake socket end to end", () => {
  let server: Server;
  let detach: () => void;
  let url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    setCtrlMode("tandem");
    server = createServer((_req, res) => res.end("ok"));
    detach = attachWakeSocket(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    // Await every close. `ws.close()` is a handshake, not a synchronous
    // release, so returning before the server has processed it leaks the
    // subscriber slot into the NEXT test's baseline — which is exactly how the
    // subscriber-count assertion below first failed.
    await Promise.all(
      sockets.splice(0).map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) return resolve();
            ws.once("close", () => resolve());
            ws.terminate();
          }),
      ),
    );
    detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Poll until `read()` matches, or fail loudly rather than racing. */
  async function settlesTo(read: () => number, want: number, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (read() === want) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(read(), label).toBe(want);
  }

  function open(path: string, opts?: WebSocket.ClientOptions): WebSocket {
    const ws = new WebSocket(`${url}${path}`, opts);
    sockets.push(ws);
    return ws;
  }

  function opened(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  }

  it("delivers a payload-free frame for a wake-worthy event", async () => {
    const ws = open("/api/wake");
    await opened(ws);

    const frame = new Promise<string>((resolve) => ws.once("message", (d) => resolve(String(d))));
    _pushEventForTests({
      id: "evt_ws_1",
      type: "chat:message",
      timestamp: Date.now(),
      payload: { messageId: "m1", text: "the secret is hunter2" },
    } as TandemEvent);

    const raw = await frame;
    expect(JSON.parse(raw)).toEqual({
      id: "evt_ws_1",
      type: "chat:message",
      timestamp: expect.any(Number),
    });
    expect(raw).not.toContain("hunter2");
  });

  it("does not wake on document:* churn", async () => {
    const ws = open("/api/wake");
    await opened(ws);

    let got = 0;
    ws.on("message", () => got++);
    _pushEventForTests({
      id: "evt_ws_doc",
      type: "document:switched",
      timestamp: Date.now(),
      payload: { documentId: "d1" },
    } as TandemEvent);

    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe(0);
  });

  it("reports the port it actually bound, not the configured default", async () => {
    // `SKILL.md` used to hardcode :3479. Under an overridden port that fails
    // SILENTLY — the model opens a socket to whatever unrelated service holds
    // 3479 and believes it is armed. The ephemeral port this suite binds is a
    // real instance of the mismatch, so the assertion only passes if the URL
    // comes from `address()` rather than from `DEFAULT_MCP_PORT`.
    const port = (server.address() as AddressInfo).port;
    expect(port).not.toBe(3479);
    expect(getWakeEndpoint()).toBe(`ws://127.0.0.1:${port}/api/wake`);

    // And the URL it hands out has to be one a consumer can actually connect on.
    const ws = new WebSocket(getWakeEndpoint() as string);
    sockets.push(ws);
    await opened(ws);
  });

  it("reports nothing once the transport is gone", async () => {
    // Absence is the honest answer in stdio mode, where no HTTP server exists to
    // attach a wake socket to. A guessed URL there would be pure fabrication.
    detach();
    expect(getWakeEndpoint()).toBeNull();
    detach = () => {}; // afterEach must not double-detach
  });

  it("does not wake on the user's own annotation in Solo", async () => {
    // The module's central privacy claim, and the whole reason it subscribes as
    // "external" rather than "internal". Every other test here runs in Tandem,
    // so without this the `"external"` argument could be changed to `"internal"`
    // — pushing Solo-held annotations at a model, the precise leak WS-A2 exists
    // to prevent — with the suite still fully green.
    setCtrlMode("solo");
    const ws = open("/api/wake");
    await opened(ws);

    const got: string[] = [];
    ws.on("message", (d) => got.push(String(d)));
    _pushEventForTests({
      id: "evt_ws_solo",
      type: "annotation:created",
      timestamp: Date.now(),
      payload: { annotationId: "a1", documentId: "d1", author: "user" },
    } as unknown as TandemEvent);

    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([]);
  });

  it("still wakes on chat in Solo — the always-delivered channel", async () => {
    // The pair to the test above: Solo is not a blanket mute, and asserting the
    // silence without asserting the exception would let an over-broad gate
    // (`readModeState() === "tandem"` with no chat carve-out) pass as correct.
    setCtrlMode("solo");
    const ws = open("/api/wake");
    await opened(ws);

    const frame = new Promise<string>((resolve) => ws.once("message", (d) => resolve(String(d))));
    _pushEventForTests({
      id: "evt_ws_solo_chat",
      type: "chat:message",
      timestamp: Date.now(),
      payload: { messageId: "m1", text: "still reaches you" },
    } as TandemEvent);

    expect(JSON.parse(await frame).id).toBe("evt_ws_solo_chat");
  });

  it("closes a socket that sends data on a push-only channel", async () => {
    const ws = open("/api/wake");
    await opened(ws);

    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.send("hello?");
    await closed;
  });

  it("counts as an EXTERNAL subscriber, and releases the slot on close", async () => {
    // "external" is what puts it behind the queue's Solo gate. It is also what
    // keeps `subscribers === 0` — the one sound negative the whole
    // connection-honesty surface rests on — reachable after it disconnects.
    const baseline = getSubscriberCount();
    const ws = open("/api/wake");
    await opened(ws);
    await settlesTo(getSubscriberCount, baseline + 1, "slot taken on connect");

    ws.close();
    await settlesTo(getSubscriberCount, baseline, "slot released on close");
  });

  it("refuses the 17th consumer rather than accumulating", async () => {
    // The cap is not a memory argument — these sockets are tiny. It bounds how
    // far the honesty signal can be degraded: every attached consumer makes
    // `subscribers === 0` unreachable, and a runaway arm-loop in a model or a
    // script would otherwise hold it up forever.
    for (let i = 0; i < 16; i++) await opened(open("/api/wake"));
    await expect(opened(open("/api/wake"))).rejects.toThrow();
  });

  it("refuses a cross-origin socket at the handshake", async () => {
    const ws = open("/api/wake", { origin: "https://evil.com" });
    await expect(opened(ws)).rejects.toThrow();
  });

  it("refuses an opaque-origin socket", async () => {
    const ws = open("/api/wake", { origin: "null" });
    await expect(opened(ws)).rejects.toThrow();
  });

  it("refuses an upgrade on any other path", async () => {
    const ws = open("/api/events");
    await expect(opened(ws)).rejects.toThrow();
  });

  it("leaves no subscriber behind after a refused handshake", async () => {
    const baseline = getSubscriberCount();
    const ws = open("/api/wake", { origin: "https://evil.com" });
    await expect(opened(ws)).rejects.toThrow();
    expect(getSubscriberCount()).toBe(baseline);
  });
});
