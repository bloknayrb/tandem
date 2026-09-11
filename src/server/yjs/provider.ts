import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { MAX_FILE_SIZE, TAURI_HOSTNAME, TAURI_LINUX_ORIGIN } from "../../shared/constants.js";
import { applyConnectionGate } from "../license/connection-gate.js";
import { GATE_ENABLED } from "../license/gate-flag.js";
import { resolveLiveLicenseState } from "../license/license-state.js";
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
    console.error("[Hocuspocus] Rejected connection: unparseable origin: %s", origin);
    throw new Error("Connection rejected: invalid origin");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== TAURI_HOSTNAME) {
    console.error(`[Hocuspocus] Rejected connection from origin: ${origin}`);
    throw new Error("Connection rejected: invalid origin");
  }
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
 * `MAX_FILE_SIZE` document's full state is ~51–154 MiB — above this cap, and
 * above `ws`'s own 100 MiB default as well. **No cap at or below the default
 * fits such a document**, which means this constant does not introduce that
 * failure class; it lowers the size at which it bites, from ~32–98 MB of text to
 * ~21–65 MB depending on block shape.
 *
 * Reaching it still needs an inbound frame carrying whole-document state, which
 * normal use does not produce: a reconnect after the server dropped the room, or
 * one enormous paste. ws answers 1009, the provider reconnects and re-sends, so
 * the symptom is a wedged sync loop rather than a dropped message. Tracked
 * separately — see the PR body.
 *
 * This closes the PER-FRAME bound only. N connections each just under the cap
 * remain unbounded — a connection ceiling was considered and declined.
 */
export const MAX_SYNC_PAYLOAD_BYTES = MAX_FILE_SIZE + 16 * 1024 * 1024; // 66 MiB

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
            `(client token ${token ? `"${token.slice(0, 8)}…"` : "missing"})`,
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
  const internal = (hocuspocusInstance as any).server?.httpServer;
  if (internal) {
    internal.on("error", (err: Error) => {
      console.error(`[Tandem] Hocuspocus httpServer error: ${err.message}`);
    });
  }
  return hocuspocusInstance;
}
