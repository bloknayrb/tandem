/**
 * `ws://127.0.0.1:<api-port>/api/wake` — the self-armed wake transport.
 *
 * ADR-049 decision 1 makes this required rather than preferred. A Claude Code
 * session can arm its own watch with the host's `Monitor` tool, and `Monitor`'s
 * `ws` source is pure JSON config — no shell. The proven `curl … | grep` shell
 * fallback works on win32 ONLY because git-bash is installed (`curl` resolves to
 * `/mingw64/bin/curl`); neither binary is a stock Windows default, and
 * `Monitor`'s `command` runs in that same shell. So on Windows this endpoint is
 * the only self-arm path there is.
 *
 * Frames are payload-free (`toWakeFrame`) — see ADR-049 decision 2 and that
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
import { isWakeWorthy, toWakeFrame } from "../../shared/events/wake-scope.js";
import { isLoopback } from "../auth/middleware.js";
import { isHostAllowed, isLocalhostOrigin } from "../mcp/api-routes.js";
import { subscribe, unsubscribe } from "./queue.js";
import type { TandemEvent } from "./types.js";

/**
 * Ceiling on simultaneously-attached wake consumers.
 *
 * The memory argument for a cap is weak — these sockets are tiny and the accept
 * path already requires loopback. The argument that is NOT weak is the one this
 * whole track rests on: `getSubscriberCount() === 0` is the only sound negative
 * Tandem has, and it gates the wake advisory, the `consumer-detached` join
 * state, and `alreadyPushed` stamping. Every attached consumer makes that zero
 * unreachable, and the Origin allowlist is port-wildcarded — so any page served
 * from any `127.0.0.1:<port>` the user happens to be running can open these.
 *
 * A cap does not fix that (one socket is enough to silence the advisory, and a
 * page on an allowlisted origin could already hold an `/api/events` SSE stream
 * open for the same effect, with FULL payloads). What it bounds is unbounded
 * accumulation, and it converts a runaway arm-loop in a model or a script from
 * a slow leak into a loud, logged refusal. Sized for the real ceiling — a
 * handful of concurrent Claude sessions — not for a crowd.
 */
const MAX_WAKE_CONSUMERS = 16;

/**
 * The live `ws://…/api/wake` URL, or null when no wake socket is attached.
 *
 * Read from the http.Server's ACTUAL bound address, not from
 * `TANDEM_MCP_PORT || DEFAULT_MCP_PORT`. Two reasons, and the second is the one
 * that matters: an env re-read is a second copy of `index.ts:104` and would
 * drift, but more importantly a URL derived from configuration can be confidently
 * wrong, while one derived from `address()` cannot exist unless the endpoint
 * does. In stdio mode nothing attaches, so this stays null and
 * `tandem_status` reports no wake URL at all — which is the truth there.
 *
 * This exists because `SKILL.md` used to hardcode `ws://127.0.0.1:3479/api/wake`.
 * Under an overridden port that is a SILENT failure: the model opens a socket to
 * whatever unrelated service holds 3479 and sits there believing it is armed.
 */
let wakeEndpoint: string | null = null;

/** The live wake URL, or null if the transport is not running (stdio mode). */
export function getWakeEndpoint(): string | null {
  return wakeEndpoint;
}

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
 *
 * **That makes this handler the exclusive owner of `upgrade` on the API port.**
 * It destroys every socket it does not recognise, including one a second,
 * later-registered listener would have handled — that listener would find the
 * socket already dead, with no error to explain it. Correct today (Hocuspocus
 * is a separate server on :3478 and nothing else upgrades on :3479); if a
 * second WebSocket endpoint is ever added here, the two must share one listener
 * that dispatches on pathname rather than registering independently.
 *
 * Note also that `verifyWakeUpgrade`'s path test is a *classifier*, not a
 * security boundary — `new URL()` normalises `/api/./wake`, `/api\wake`,
 * `//evil.com/api/wake` and absolute-form targets all onto `/api/wake`, and it
 * discards the authority. That is harmless because the three real checks run
 * unconditionally for every accepted path and nothing downstream reads the
 * authority, but it would matter behind a proxy doing path-based ACLs.
 */
export function attachWakeSocket(httpServer: Server, extraHosts: string[] = []): () => void {
  // `maxPayload` is NOT the usual DoS boilerplate. A wake consumer never sends
  // anything — the socket is one-directional by design — but ws assembles a
  // full inbound message before anything can discard it, so the default 100 MB
  // is 100 MB of buffering per socket for a capability with no legitimate use.
  // 1 KiB is far above any frame a well-behaved client would send (none) and
  // far below anything worth buffering. Never `0`: in ws that means unlimited.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
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
      // Node strips its own `socketOnError` from the socket before emitting
      // `upgrade`, and ws only re-adds one on the accept path — so without this
      // the decline path runs with ZERO error listeners. An `ECONNRESET` from a
      // peer that vanished mid-write would then be an unhandled 'error' event,
      // and `ECONNRESET`/`EPIPE` are not matched by `isKnownHocuspocusError`,
      // so `handleFatalError` would `process.exit(1)` and skip the shutdown
      // dirty-doc flush. Killing the whole server over a refused handshake is a
      // wildly disproportionate outcome for two lines of guard.
      socket.on("error", () => {});
      // 404 for a path we do not own, 403 for one we do and refused. The
      // difference matters to a human reading it and to nobody else — both
      // destroy the socket.
      const status = verdict === "not-wake-path" ? "404 Not Found" : "403 Forbidden";
      if (socket.writable) socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    if (wss.clients.size >= MAX_WAKE_CONSUMERS) {
      socket.on("error", () => {});
      if (socket.writable) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      }
      socket.destroy();
      console.error(
        `[Wake] Refused a consumer: ${MAX_WAKE_CONSUMERS} already attached. ` +
          "Every attached consumer makes `subscribers === 0` unreachable, so this " +
          "is a bound on how far the honesty signal can be degraded, not just on memory.",
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  }

  wss.on("connection", (ws: WebSocket) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));

    // The wake socket is one-directional by design: the server pushes frames,
    // the client says nothing. A peer that sends data is therefore not one of
    // ours — either a confused client or something probing — and there is no
    // message it could send that we would act on. Dropping it is both the
    // correct semantics and what keeps `maxPayload` from being the only thing
    // standing between a chatty peer and per-socket buffering.
    ws.on("message", () => {
      console.error("[Wake] Consumer sent data on a push-only socket; closing it.");
      ws.terminate();
    });

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

  // Always 127.0.0.1 regardless of what the server bound to: `verifyWakeUpgrade`
  // rejects every non-loopback peer, so any other host in this URL would name an
  // address that cannot connect. Deferred until `listening` when attached to a
  // server that has not bound yet — `address()` is null before then, and
  // publishing null would report "no wake transport" for one that is merely
  // still starting.
  const publishEndpoint = () => {
    const address = httpServer.address();
    wakeEndpoint =
      address && typeof address === "object" ? `ws://127.0.0.1:${address.port}${API_WAKE}` : null;
  };
  if (httpServer.listening) publishEndpoint();
  else httpServer.once("listening", publishEndpoint);

  return () => {
    clearInterval(heartbeat);
    httpServer.removeListener("upgrade", onUpgrade);
    httpServer.removeListener("listening", publishEndpoint);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    wakeEndpoint = null;
  };
}
