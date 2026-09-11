import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { MAX_FILE_SIZE, TAURI_HOSTNAME, TAURI_LINUX_ORIGIN } from "../../shared/constants.js";
import { applyConnectionGate } from "../license/connection-gate.js";
import { GATE_ENABLED } from "../license/gate-flag.js";
import { resolveLiveLicenseState } from "../license/license-state.js";
import { sanitizeForLog } from "../log-sanitize.js";
import type { HocuspocusLifecycle } from "./lifecycle.js";

let hocuspocusInstance: Hocuspocus | null = null;
const documents = new Map<string, Y.Doc>();

/**
 * The installed lifecycle (ADR-033). Replaces four independent free setters —
 * `setShouldKeepDocument`, `setDocLifecycleCallbacks` and
 * `setGenerationTokenSource` — with one named seam, so "is the lifecycle
 * installed?" is a single observable fact rather than four.
 *
 * Still injected rather than imported: the registry, the event queue and the
 * document-service all import THIS module, so reaching back for any of them
 * would close a cycle. `provider.ts` must never import a default
 * implementation as a fallback — that is the cycle, just spelled differently.
 *
 * Installed by `bootstrap/hocuspocus-lifecycle.ts` from `index.ts`, before
 * every `startHocuspocus` call. `tests/server/index.startup-ordering.test.ts`
 * is what holds that order.
 */
let lifecycle: HocuspocusLifecycle | null = null;

export function installHocuspocusLifecycle(installed: HocuspocusLifecycle): void {
  lifecycle = installed;
}

/** Drop the installed lifecycle. Tests only — production installs exactly once. */
export function resetHocuspocusLifecycleForTesting(): void {
  lifecycle = null;
}

/**
 * Get a document by room name. Returns undefined if it doesn't exist.
 */
export function getDocument(name: string): Y.Doc | undefined {
  return documents.get(name);
}

/**
 * Get or create a Y.Doc for the given room name.
 * If Hocuspocus has already created a doc for this room (browser connected first),
 * returns that doc. Otherwise creates a new one that will be merged into the
 * Hocuspocus doc when a browser connects.
 */
export function getOrCreateDocument(name: string): Y.Doc {
  let doc = documents.get(name);
  if (!doc) {
    doc = new Y.Doc();
    documents.set(name, doc);
  }
  return doc;
}

/**
 * Remove a document from the map. Called by afterUnloadDocument when
 * Hocuspocus destroys a room's doc after all clients disconnect.
 */
export function removeDocument(name: string): boolean {
  return documents.delete(name);
}

/**
 * Reject WebSocket upgrades whose Origin is not 127.0.0.1 / tauri.localhost /
 * the Linux `tauri://localhost`. Narrowed in #477 PR 2: bare `localhost` is no
 * longer accepted. Mirrors `isHostAllowed` / CORS in api-routes.ts. Exported for
 * direct unit coverage — the early exact-match return (before `new URL()`) is
 * the load-bearing correctness detail and must stay pinned.
 */
export function assertAllowedOrigin(origin: string | undefined): void {
  if (!origin) {
    console.error("[Hocuspocus] Rejected connection: missing Origin header");
    throw new Error("Connection rejected: missing origin header");
  }
  // Linux Tauri WebView uses the custom `tauri://` scheme (unforgeable by remote
  // content). Exact-match it before the URL parse — `new URL("tauri://localhost")`
  // yields hostname "localhost", which the 127.0.0.1/tauri.localhost check below
  // would reject. Windows' http://tauri.localhost is handled by that check.
  if (origin === TAURI_LINUX_ORIGIN) return;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // e.g. the literal "null" Origin from sandboxed/opaque contexts. Hocuspocus
    // catches a bare URL TypeError too (still fail-closed), but without this
    // log the rejection would be the only origin-deny path with no trace.
    console.error(
      "[Hocuspocus] Rejected connection: unparseable origin: %s",
      sanitizeForLog(origin),
    );
    throw new Error("Connection rejected: invalid origin");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== TAURI_HOSTNAME) {
    console.error(`[Hocuspocus] Rejected connection from origin: ${sanitizeForLog(origin)}`);
    throw new Error("Connection rejected: invalid origin");
  }
}

/**
 * Render a rejected generation token for the operator's log (#1822 item 1 class).
 *
 * `token` is whatever the peer put in the Yjs Auth message, and `onAuthenticate`
 * runs before anything has accepted that peer — so this is an UNAUTHENTICATED
 * string reaching `console.error`, which Critical Rule 3 redirects to stderr,
 * i.e. the operator's terminal. Eight raw characters are enough for a complete
 * OSC-0 title sequence (`ESC ]0;x BEL` is six), so the old
 * `token.slice(0, 8)` was a full escape channel despite the truncation.
 *
 * Sanitize BEFORE slicing, not after: slicing first can cut a multi-character
 * escape in half and leave the introducer, and it also spends the eight-
 * character budget on bytes that are about to be stripped.
 *
 * Extracted and exported so the log hygiene is unit-testable — provoking it in
 * place needs a real Hocuspocus socket carrying a hand-encoded Auth message.
 */
export function describeRejectedToken(token: string | undefined): string {
  if (!token) return "missing";
  return `"${sanitizeForLog(token).slice(0, 8)}…"`;
}

/**
 * Largest inbound WebSocket frame Hocuspocus will accept (#1822 item 2).
 *
 * Without it `ws` keeps its 100 MiB default, and a peer that never authenticates
 * can make the process buffer that much: a measured 90 MiB frame moved RSS from
 * 179 MB to 331 MB before any hook ran. `events/wake-socket.ts` already caps its
 * own upgrade at 1024 bytes for exactly this reason; this is the same control on
 * the collaboration socket.
 *
 * **Rejection happens at the frame header**, on the declared `_payloadLength`,
 * which is structurally before `onConnect`/`onAuthenticate` — so an
 * unauthenticated peer is refused without the bytes ever being read. ws answers
 * close code 1009.
 *
 * Derivation: `MAX_FILE_SIZE` (the on-disk / upload ceiling for a document) plus
 * 16 MiB of headroom. The cap bounds INBOUND frames only — server→client is
 * unbounded — and the repo has no client-side Yjs persistence (no
 * `y-indexeddb` anywhere in `src/` or `package.json`), so a browser's
 * first-connect `syncStep2` is empty and every later frame carries only what
 * that client typed or pasted. Ordinary editing frames are bytes, not megabytes.
 *
 * **Measured, and the measurement is why this is a bound on the frame rather
 * than a guarantee about documents.** A whole-document Yjs update is 1.02x–3.09x
 * the text it carries, the ratio driven by BLOCK COUNT rather than text volume
 * (2 MB of text: 1.02x at 2000 chars/paragraph, 1.51x at 80, 3.09x at 20). So a
 * `MAX_FILE_SIZE` (50 MiB) document's full state spans ~51–154 MiB depending on
 * block shape — which STRADDLES this cap rather than sitting above it.
 *
 * **This cap therefore narrows the supported band, and the narrowing is the
 * cost being paid.** An earlier draft of this comment claimed "no cap at or
 * below ws's 100 MiB default fits such a document"; that is false at the low
 * end by its own arithmetic — 50 MiB of text at 1.02x is ~51 MiB, which BOTH
 * this cap and the default accept, so there was never a document size for which
 * every cap failed equally. The band that regresses is real and worth naming:
 * a whole-document update landing in (66 MiB, 100 MiB] synced under the old
 * default and is now refused. Within `MAX_FILE_SIZE` that band is reachable
 * from ~21 MiB of text at the densest measured block shape (3.09x, 20
 * chars/paragraph) and from ~44 MiB at 1.51x; at 1.02x it is unreachable,
 * because the text needed (~65 MiB) exceeds `MAX_FILE_SIZE` itself. Above
 * 100 MiB nothing changed — that was already broken, and #1982 tracks it.
 *
 * Reaching the cap still needs an inbound frame carrying whole-document state,
 * which normal editing does not produce: a reconnect after the server dropped
 * the room, or one enormous paste. When it happens ws answers close 1009 and
 * `HocuspocusProvider` reconnects and re-sends the identical frame, so the
 * symptom is a silent wedge rather than a dropped message — which is why
 * `logOversizedFrame` below turns it into one named log line naming this
 * constant. That log is the only thing standing between the band above and an
 * undiagnosable "the document stopped syncing".
 *
 * Raising the cap above ws's default was considered and declined: at that point
 * it bounds nothing the default did not already bound, and the DoS this exists
 * to close (a measured 90 MiB frame from an UNAUTHENTICATED peer moved RSS
 * 179 MB → 331 MB) comes straight back.
 *
 * This closes the PER-FRAME bound only. N connections each just under the cap
 * remain unbounded — a connection ceiling was considered and declined.
 */
export const MAX_SYNC_PAYLOAD_BYTES = MAX_FILE_SIZE + 16 * 1024 * 1024; // 66 MiB

/**
 * Turn a cap rejection into one named log line (#1822 item 2, review round 1).
 *
 * `ws` answers an over-cap frame with close 1009 and `HocuspocusProvider`
 * reconnects and re-sends the identical frame, so without this the only symptom
 * of the regressed band described on `MAX_SYNC_PAYLOAD_BYTES` is a document
 * that silently stops syncing. Hocuspocus attaches its own `error` listener to
 * every incoming socket and routes it to `this.hocuspocus.debugger.log`, which
 * is off unless debugging is enabled — so it swallows exactly this signal.
 * Listeners are additive; ours does not displace theirs.
 *
 * Discriminates on `err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"`, the code
 * `ws`'s receiver sets alongside status 1009. Every other socket error stays
 * silent here — an aborted connection is normal and this is not a general ws
 * error log.
 *
 * Exported for direct unit coverage: the wiring runs inside `startHocuspocus`,
 * and a spec that had to provoke a real 66 MiB frame to see the line would be
 * a memory test rather than a behaviour one.
 */
export function logOversizedFrame(err: unknown): void {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code !== "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") return;
  console.error(
    `[Hocuspocus] Rejected an inbound frame over MAX_SYNC_PAYLOAD_BYTES ` +
      `(${MAX_SYNC_PAYLOAD_BYTES} bytes) — ws closed the socket with 1009. ` +
      `The client will reconnect and re-send the same frame, so sync for that ` +
      `document will not converge until the frame gets smaller.`,
  );
}

export async function startHocuspocus(port: number): Promise<Hocuspocus> {
  hocuspocusInstance = new Hocuspocus({
    port,
    // Hocuspocus always binds loopback — the MCP bind-host env var does not apply here.
    // WebSocket collaboration traffic stays local-only per the Cowork architecture.
    address: "127.0.0.1",
    quiet: true, // stdout is the MCP wire — suppress the startup banner

    async onConnect({ request, documentName }) {
      // Origin validation: reject connections not from 127.0.0.1 / tauri.localhost
      // (prevents DNS rebinding). Belt-and-braces only — in @hocuspocus/server 2.x
      // a thrown onConnect races already-queued message processing, so the
      // authoritative copy of this check lives in onAuthenticate below.
      assertAllowedOrigin(request?.headers?.origin);
      console.error(`[Hocuspocus] Client connected to: ${documentName}`);
    },

    // Generation gate. Defining this hook flips requiresAuthentication on for
    // EVERY room: sync messages are queued per-document until the Auth message
    // is validated, and a throw here sends PermissionDenied without ever
    // draining the queue — the ordering guarantee onConnect cannot give.
    // Clients present the generation id from GET /api/info as their token,
    // pinned at provider construction; a tab that survived a server restart
    // presents the previous run's id and is rejected before its stale Y.Doc
    // state can CRDT-merge into (and corrupt) the freshly-loaded document.
    // CTRL_ROOM is deliberately NOT exempt: a stale ctrl client merging back
    // can clobber the broadcast openDocuments list itself (and in the old
    // design could clobber a map-broadcast generation id — which is why the
    // id now lives in module state and travels over HTTP only).
    async onAuthenticate({ token, documentName, requestHeaders, connection }) {
      assertAllowedOrigin(requestHeaders?.origin);
      const expected = lifecycle?.expectedGenerationToken() ?? null;
      if (expected === null || token !== expected) {
        console.error(
          `[Hocuspocus] Rejected stale-generation connection to ${documentName} ` +
            `(client token ${describeRejectedToken(token)})`,
        );
        throw new Error("Connection rejected: stale server generation");
      }

      // License gate — Surface A (#1116, ADR-040). In restricted mode mark
      // document-room connections read-only so browser edits + annotations are
      // rejected server-side (no CRDT revert). CTRL_ROOM stays writable so
      // chat / mode / awareness keep working — the read-only escape hatch.
      // No-op when the gate is dark.
      // `GATE_ENABLED` is the fast-path guard: in a dark build we skip the
      // per-connection license file read entirely. `applyConnectionGate` does
      // the predicate + the load-bearing `connection.readOnly = true` assignment
      // (extracted so that assignment is unit-testable).
      if (GATE_ENABLED) {
        const clamped = applyConnectionGate(connection, documentName, resolveLiveLicenseState());
        if (clamped) {
          console.error(
            `[Hocuspocus] License restricted — read-only connection to ${documentName}`,
          );
        }
      }
    },

    async onDisconnect({ documentName }) {
      console.error(`[Hocuspocus] Client disconnected from: ${documentName}`);
    },

    async onLoadDocument({ document, documentName }) {
      console.error(`[Hocuspocus] Loading document: ${documentName}`);

      // If MCP tools have already created and populated a doc for this room,
      // merge its state into the Hocuspocus-provided doc, then swap the map entry
      const existing = documents.get(documentName);
      if (existing && existing !== document) {
        const update = Y.encodeStateAsUpdate(existing);
        Y.applyUpdate(document, update);
        existing.destroy();
        console.error(`[Hocuspocus] Merged pre-existing content into document: ${documentName}`);
      }

      // The Hocuspocus-provided doc is now the authoritative instance
      documents.set(documentName, document);

      // Notify event queue to reattach observers to the new doc instance
      if (lifecycle) {
        lifecycle.onDocSwapped(documentName, document);
      } else {
        console.error(
          `[Tandem] WARN: onDocSwapped callback not registered during doc load for ${documentName}. ` +
            `Server-side observers will NOT be attached. Call installHocuspocusLifecycle() before starting Hocuspocus.`,
        );
      }

      return document;
    },

    async afterUnloadDocument({ documentName }) {
      if (lifecycle?.shouldKeepDocument(documentName)) {
        console.error(`[Hocuspocus] Kept document in map (MCP still tracking): ${documentName}`);
        return;
      }
      if (documents.has(documentName)) {
        lifecycle?.onDocUnloaded(documentName);
        documents.delete(documentName);
        console.error(`[Hocuspocus] Unloaded document from map: ${documentName}`);
      }
    },
  });

  // Hocuspocus.listen() never rejects on EADDRINUSE — the error goes to
  // uncaughtException instead. Race listen() against an error listener on the
  // internal httpServer so we surface bind failures properly.
  // NOTE: Hocuspocus creates .server (and .server.httpServer) inside listen(),
  // so it's not available before the call. We call listen() first, then attach
  // the error listener on the next tick if the internal is available.
  // The websocket options are `listen`'s THIRD positional argument — they reach
  // `new Server(this, websocketOptions)` → `new WebSocketServer({ noServer: true,
  // ...websocketOptions })`. `typeof null !== "number"`, so passing null for the
  // port leaves the constructor's `port` in place. A `maxPayload` put on the
  // Hocuspocus config object instead is silently ignored, which is why
  // `hocuspocus-max-payload.test.ts` reads it back off the live WebSocketServer.
  await hocuspocusInstance.listen(null, null, { maxPayload: MAX_SYNC_PAYLOAD_BYTES });

  // Post-listen: attach an error handler for runtime bind errors (e.g., port stolen)
  // biome-ignore lint/suspicious/noExplicitAny: reaching into Hocuspocus internals
  const internal = (hocuspocusInstance as any).server?.httpServer;
  if (internal) {
    internal.on("error", (err: Error) => {
      console.error(`[Tandem] Hocuspocus httpServer error: ${err.message}`);
    });
  }

  // Surface the frame-cap rejection. Same reach-in as above: Hocuspocus creates
  // the WebSocketServer inside listen(), so this cannot be wired earlier.
  // biome-ignore lint/suspicious/noExplicitAny: reaching into Hocuspocus internals
  const wss = (hocuspocusInstance as any).server?.webSocketServer;
  if (wss) {
    wss.on("connection", (socket: { on: (ev: string, fn: (err: unknown) => void) => void }) => {
      socket.on("error", logOversizedFrame);
    });
  }
  return hocuspocusInstance;
}
