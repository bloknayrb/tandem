import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { CTRL_ROOM, TAURI_HOSTNAME, TAURI_LINUX_ORIGIN } from "../../shared/constants.js";
import { connectionShouldBeReadOnly } from "../license/connection-gate.js";
import { GATE_ENABLED } from "../license/gate-flag.js";
import { resolveLicenseState } from "../license/license-state.js";
import { resolveAppDataDir } from "../platform.js";

let hocuspocusInstance: Hocuspocus | null = null;
const documents = new Map<string, Y.Doc>();

// Callback predicate: returns true if Hocuspocus should keep a document in the
// map even after all WebSocket clients disconnect.  Registered by document-service
// to avoid a circular import (provider -> document-service -> provider).
let shouldKeepDocument: ((name: string) => boolean) | null = null;

// Callback for event queue observer lifecycle (registered by events/queue.ts to avoid circular import).
let onDocSwapped: ((docName: string, newDoc: Y.Doc) => void) | null = null;
let onDocUnloaded: ((docName: string) => void) | null = null;

export function setDocLifecycleCallbacks(
  swapped: (docName: string, newDoc: Y.Doc) => void,
  unloaded: (docName: string) => void,
): void {
  onDocSwapped = swapped;
  onDocUnloaded = unloaded;
}

/** Register a predicate that prevents afterUnloadDocument from evicting docs
 *  that MCP (or the bootstrap channel) still needs. */
export function setShouldKeepDocument(fn: (name: string) => boolean): void {
  shouldKeepDocument = fn;
}

// Source of the expected generation token for the onAuthenticate gate.
// Registered by document-service's writeGenerationId() (same callback pattern
// as setShouldKeepDocument — provider must not import document-service back).
// Fail-closed: while unregistered (or before a generation exists), every
// connection is rejected; production always registers before Hocuspocus binds.
let getExpectedGenerationToken: (() => string | null) | null = null;
export function setGenerationTokenSource(fn: () => string | null): void {
  getExpectedGenerationToken = fn;
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
      const expected = getExpectedGenerationToken?.() ?? null;
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
      if (GATE_ENABLED) {
        const state = resolveLicenseState({
          appDataDir: resolveAppDataDir(),
          now: () => Date.now(),
          gateEnabled: GATE_ENABLED,
        });
        if (connectionShouldBeReadOnly(documentName, CTRL_ROOM, state.status)) {
          connection.readOnly = true;
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
      if (onDocSwapped) {
        onDocSwapped(documentName, document);
      } else {
        console.error(
          `[Tandem] WARN: onDocSwapped callback not registered during doc load for ${documentName}. ` +
            `Server-side observers will NOT be attached. Call setDocLifecycleCallbacks() before starting Hocuspocus.`,
        );
      }

      return document;
    },

    async afterUnloadDocument({ documentName }) {
      if (shouldKeepDocument?.(documentName)) {
        console.error(`[Hocuspocus] Kept document in map (MCP still tracking): ${documentName}`);
        return;
      }
      if (documents.has(documentName)) {
        onDocUnloaded?.(documentName);
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
  await hocuspocusInstance.listen();

  // Post-listen: attach an error handler for runtime bind errors (e.g., port stolen)
  const internal = (hocuspocusInstance as any).server?.httpServer;
  if (internal) {
    internal.on("error", (err: Error) => {
      console.error(`[Tandem] Hocuspocus httpServer error: ${err.message}`);
    });
  }
  return hocuspocusInstance;
}
