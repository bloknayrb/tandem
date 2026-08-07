/**
 * `ws://127.0.0.1:<api-port>/api/wake` — the self-armed wake transport.
 *
 * ADR-047 decision 1 makes this required rather than preferred. A Claude Code
 * session can arm its own watch with the host's `Monitor` tool, and `Monitor`'s
 * `ws` source is pure JSON config — no shell. The proven `curl … | grep` shell
 * fallback works on win32 ONLY because git-bash is installed (`curl` resolves to
 * `/mingw64/bin/curl`); neither binary is a stock Windows default, and
 * `Monitor`'s `command` runs in that same shell. So on Windows this endpoint is
 * the only self-arm path there is.
 *
 * Frames are payload-free (`toWakeFrame`) — see ADR-047 decision 2 and that
 * function's docblock. This carries the same contract as the supervisor's stdin
 * wake: enough to know something happened, never what.
 *
 * ## Why the guard is not `apiMiddleware`
 *
 * A WebSocket upgrade is NOT subject to the same-origin policy. CORS is the
 * control doing most of the work on `/api/*` — and on a WS handshake it does
 * nothing at all: a page on any origin may open a socket to
 * `ws://127.0.0.1:3479` and read every frame, because there is no preflight and
 * no `Access-Control-Allow-Origin` check on the client side. The browser does
 * still SEND `Origin`, so the check has to move server-side and become a
 * rejection rather than a withheld response header.
 *
 * Three checks, all of which must pass:
 *
 *  1. **Loopback only**, from `socket.remoteAddress` and never the `Host`
 *     header — the rule that makes DNS rebinding non-exploitable. Unlike
 *     `/api/events` this is not merely the default posture, it is the whole
 *     posture: `Monitor`'s `ws` source accepts `{url, protocols}` and has no
 *     header field, so a remote consumer could not present a Bearer token even
 *     if we wanted to allow one. A wake consumer is a Claude session on this
 *     machine by construction. Cowork's remote case is served by the channel
 *     shim over HTTP, which does carry auth.
 *  2. **Host allowlist**, same as `apiMiddleware`, so a rebound name cannot
 *     reach this even from loopback.
 *  3. **Origin**: absent is fine (a native client — `Monitor`, `curl`, a test),
 *     but any Origin that IS present must be allowlisted. `null` is explicitly
 *     not allowlisted: it is the origin serialization of opaque contexts, so a
 *     sandboxed iframe on any page sends it, and treating it as "no origin"
 *     would hand exactly the attacker we are excluding the native-client pass.
 *     Same trap as #1291, reached by a different road.
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { API_WAKE } from "../../shared/api-paths.js";
import { CHANNEL_SSE_KEEPALIVE_MS } from "../../shared/constants.js";
import { isLoopback } from "../auth/middleware.js";
import { isHostAllowed, isLocalhostOrigin } from "../mcp/api-routes.js";
import { subscribe, unsubscribe } from "./queue.js";
import type { TandemEvent } from "./types.js";
import { isWakeWorthy, toWakeFrame } from "./wake-scope.js";

export type WakeUpgradeVerdict =
  | "accept"
  | "not-wake-path"
  | "reject-remote"
  | "reject-host"
  | "reject-origin";

export interface WakeUpgradeInput {
  url: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  remoteAddress: string | undefined;
}

/**
 * Pure so the rejections can be tested without standing up a socket. Order is
 * deliberate: path first (so a non-wake upgrade is classified, not rejected),
 * then the checks cheapest-and-most-decisive first.
 */
export function verifyWakeUpgrade(
  input: WakeUpgradeInput,
  extraHosts: string[] = [],
): WakeUpgradeVerdict {
  // `url` on an upgrade is origin-form ("/api/wake?x=1"), never absolute. Parse
  // against a dummy base and compare the PATHNAME — a `startsWith` would accept
  // `/api/wakeful` and `/api/wake/../admin`.
  let pathname: string;
  try {
    pathname = new URL(input.url ?? "", "http://127.0.0.1").pathname;
  } catch {
    return "not-wake-path";
  }
  if (pathname !== API_WAKE) return "not-wake-path";

  if (!isLoopback(input.remoteAddress)) return "reject-remote";
  if (!isHostAllowed(input.host, extraHosts)) return "reject-host";
  // Absent means a native client. Present means a browser, and a browser must
  // prove it is one of ours — including `null`, which `isLocalhostOrigin`
  // rejects and which must NOT be collapsed into the absent case.
  if (input.origin !== undefined && !isLocalhostOrigin(input.origin)) return "reject-origin";
  return "accept";
}

/**
 * Attach the wake socket to a running HTTP server. Returns a detach function.
 *
 * Registering ANY `upgrade` listener removes Node's default behaviour of
 * destroying unhandled upgrade sockets, so this handler must destroy the ones
 * it declines — otherwise adding a wake endpoint would silently turn every
 * other upgrade attempt into a leaked socket.
 */
export function attachWakeSocket(httpServer: Server, extraHosts: string[] = []): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakSet<WebSocket>();

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const verdict = verifyWakeUpgrade(
      {
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        remoteAddress: req.socket.remoteAddress,
      },
      extraHosts,
    );
    if (verdict !== "accept") {
      // 404 for a path we do not own, 403 for one we do and refused. The
      // difference matters to a human reading it and to nobody else — both
      // destroy the socket.
      const status = verdict === "not-wake-path" ? "404 Not Found" : "403 Forbidden";
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  }

  wss.on("connection", (ws: WebSocket) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));

    const onEvent = (event: TandemEvent) => {
      if (!isWakeWorthy(event)) return;
      try {
        ws.send(JSON.stringify(toWakeFrame(event)));
      } catch (err) {
        console.error(
          "[Wake] Send failed, closing socket:",
          err instanceof Error ? err.message : err,
        );
        ws.terminate();
      }
    };
    // "external": a consumer outside this process, so it MUST sit behind the
    // queue's Solo gate exactly as the SSE consumers do. Subscribing as
    // "internal" would push the user's Solo-held annotations at a model — the
    // precise leak WS-A2 exists to prevent.
    subscribe(onEvent, "external");

    ws.on("close", () => unsubscribe(onEvent));
    ws.on("error", () => {
      unsubscribe(onEvent);
      ws.terminate();
    });
    console.error("[Wake] Consumer connected to /api/wake");
  });

  // Reap sockets whose peer vanished without a close frame — a killed Claude
  // session, a suspended laptop. Without this they hold an `externalSubscribers`
  // slot forever, and a phantom consumer is worse than none: it makes
  // `subscribers === 0` unreachable, which is the ONE sound negative the whole
  // connection-honesty surface rests on.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, CHANNEL_SSE_KEEPALIVE_MS);
  // Never hold the process open for a diagnostic heartbeat.
  heartbeat.unref?.();

  httpServer.on("upgrade", onUpgrade);

  return () => {
    clearInterval(heartbeat);
    httpServer.removeListener("upgrade", onUpgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
