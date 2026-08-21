import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import type { Server } from "http";
import { createRequire } from "module";

import { API_HEALTH } from "../../shared/api-paths.js";
import { CLAUDE_SESSION_HEADER, normalizeSessionId } from "../../shared/cli-runtime.js";
import { DEFAULT_BIND_HOST, DEFAULT_WS_PORT, TAURI_HOSTNAME } from "../../shared/constants.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { getTokenFilePath } from "../auth/token-store.js";
import { getDeliveryState } from "../events/delivery-state.js";
import { getPushConsumerLiveness } from "../events/push-liveness.js";
import { getSubscriberCount } from "../events/queue.js";
import { attachWakeSocket } from "../events/wake-socket.js";
import { registerIntegrationsRoutes } from "../integrations/api-routes.js";
import { readExistingTandemEntries } from "../integrations/existing-config.js";
import { createKeychain, KEYCHAIN_SERVICE_MODELS } from "../integrations/keychain.js";
import { createIntegrationsStore } from "../integrations/storage.js";
import { registerModelsRoutes } from "../models/api-routes.js";
import { resolveAppDataDir, SESSION_DIR } from "../platform.js";
import { runWithMcpContext } from "../sessions/context.js";
import { registerAnnotationTools } from "./annotations.js";
import {
  apiMiddleware,
  createApiMiddleware,
  enforceLoopbackMutation,
  registerApiRoutes,
} from "./api-routes.js";
import { registerAwarenessTools } from "./awareness.js";
import { registerChannelRoutes } from "./channel-routes.js";
import { type DiagnosticsToolDeps, registerDiagnosticsTools } from "./diagnostics.js";
import { registerDocumentTools } from "./document.js";
import { getGenerationId } from "./document-service.js";
import { registerApplyTools } from "./docx-apply.js";
import { registerNavigationTools } from "./navigation.js";
import { clearAllClaudePresence } from "./presence-expiry.js";
import type { DiagnosticsHandlerDeps } from "./routes/diagnostics.js";
import { makeHealthHandler } from "./routes/health.js";
import { installSchemaDialectStrip } from "./schema-dialect.js";
import {
  createMcpSessionRegistry,
  type McpSessionEntry,
  type McpSessionRegistry,
} from "./transport-registry.js";

// Injected by tsup at build time; absent in tsx dev and vitest, where createRequire
// reads ../../package.json. Tauri pkg has no package.json — define is the only source.
declare const __APP_VERSION__: string;
const esmRequire = createRequire(import.meta.url);
function _readVersionFromDisk(): string {
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try {
      return (esmRequire(rel) as { version: string }).version;
    } catch {
      // try next candidate
    }
  }
  console.error("[Tandem] Could not read version from package.json (all candidates failed)");
  return "0.0.0-unknown";
}
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : _readVersionFromDisk();

// __MCP_SDK_VERSION__ is injected by tsup at build time (see tsup.config.ts).
// In test environments (Vitest runs .ts directly, no tsup), the global is absent.
// The typeof guard avoids a ReferenceError in tests.
declare const __MCP_SDK_VERSION__: string;
const MCP_SDK_VERSION: string =
  typeof __MCP_SDK_VERSION__ !== "undefined" ? __MCP_SDK_VERSION__ : "0.0.0-unknown";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/server/ → dist/client/ (tsup bundles server into dist/server/index.js)
const CLIENT_DIST = join(__dirname, "../client");

// Resolve a file relative to the repo/package root. Checks direct __dirname-relative
// paths first so the function works reliably in the packaged Tauri sidecar layout,
// where package.json does NOT exist alongside the bundle (breaking the walk-based anchor).
//
// Layout reference:
//   dev:        src/server/mcp/  →  ../../<file>  (repo root)
//   bundled:    dist/server/     →  ../../<file>  (repo root)
//   Tauri pkg:  resource_dir/dist/server/  →  ../../<file>  (resource_dir root)
//               Files must be present in resource_dir via tauri.conf.json resources.
//
// Falls back to a package.json-anchored walk for unusual layouts.
export function findRepoFile(startDir: string, relPath: string): string | undefined {
  // Fast direct probes (covers all three layouts above)
  for (const prefix of ["../..", ".."]) {
    const candidate = join(startDir, prefix, relPath);
    if (existsSync(candidate)) return candidate;
  }
  // Fallback: walk up looking for package.json + file co-located at relPath
  // (covers unusual / monorepo layouts). Capped at 5 levels.
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, relPath);
    if (existsSync(candidate) && existsSync(join(dir, "package.json"))) {
      return candidate;
    }
    const parent = join(dir, "..");
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return undefined;
}

/** @deprecated Use findRepoFile(startDir, "CHANGELOG.md") instead. Kept for test compatibility. */
export function findChangelogPath(startDir: string): string | undefined {
  return findRepoFile(startDir, "CHANGELOG.md");
}
/**
 * Directories holding Tandem's own auto-opened documents, for the #1282 drift
 * preview's exclusion list. Canonicalized, because the candidate it is compared
 * against always is — an un-realpath'd entry silently fails to match wherever
 * the install path involves a junction or a Windows 8.3 short name.
 *
 * Warns when it resolves to nothing. Three `undefined`-tolerant seams sit
 * between `findRepoFile` and the consumer (`string | undefined` constants, an
 * optional dep, a `?? []` default), and the failure they would let through is
 * user-visible and specific: `welcome.md` opens on first run and `CHANGELOG.md`
 * after every upgrade, both from inside the app bundle, which on Windows lives
 * under `%LOCALAPPDATA%` — i.e. inside home, passing every other check. So a
 * silently empty list means every desktop user's first run opens with a
 * suggestion to move Claude into Tandem's install directory.
 *
 * **Two sample directories, not one, and the second is the one that matters.**
 * `WELCOME_PATH` comes from `findRepoFile(__dirname, …)`, which lands in the
 * *resource* dir. But `index.ts` opens `path.join(process.env.TANDEM_DATA_DIR ||
 * projectRoot, "sample/welcome.md")`, and the Tauri shell always sets
 * `TANDEM_DATA_DIR` to the app-data dir and copies `sample/*` into it. So on a
 * packaged desktop first run the document actually open is the app-data copy,
 * in a directory this list did not contain — and that path is inside home on all
 * three platforms (`%APPDATA%`, `~/Library/Application Support`, `~/.local/share`),
 * so it passes the home-confinement check, differs from the launcher's default
 * `$HOME`, and misses the exact-match exclusion. The result was the amber pill on
 * every desktop first run, offering to permanently repoint the launcher at
 * Tandem's own sample folder — the precise failure this exclusion exists to stop.
 *
 * Invisible in dev and in every test: `TANDEM_DATA_DIR` is unset there, which
 * collapses the two directories into one. Derive the app-data sample dir the same
 * way `index.ts` does rather than restating the join, so the two cannot drift
 * apart again.
 */
export function resolveBundledDocDirs(): string[] {
  const dataDir = process.env.TANDEM_DATA_DIR?.trim();
  const appDataSample = dataDir ? join(dataDir, "sample") : undefined;
  const dirs = [
    CHANGELOG_PATH === undefined ? undefined : dirname(CHANGELOG_PATH),
    WELCOME_PATH === undefined ? undefined : dirname(WELCOME_PATH),
    appDataSample,
  ]
    .filter((p): p is string => p !== undefined)
    .map((dir) => {
      try {
        return realpathSync(dir);
      } catch {
        return dir;
      }
    });
  if (dirs.length === 0) {
    console.error(
      "[Tandem] Could not locate CHANGELOG.md or sample/welcome.md — the working-folder " +
        "nudge may suggest restarting Claude inside Tandem's own install directory.",
    );
  }
  return dirs;
}

const CHANGELOG_PATH: string | undefined = findRepoFile(__dirname, "CHANGELOG.md");
const WORKFLOWS_PATH: string | undefined = findRepoFile(__dirname, "docs/workflows.md");
// Exposed via /api/info so the "Replay tutorial" affordance can reopen the
// welcome doc (force-reload → server re-injects the seed annotations).
const WELCOME_PATH: string | undefined = findRepoFile(__dirname, "sample/welcome.md");

// One McpServer per live transport session, keyed by Mcp-Session-Id (#438
// §3.2). The SDK's Protocol.connect() throws if a server already has a
// transport, so servers cannot be shared across sessions — see
// transport-registry.ts for why this is "Shape 2" and not a singleton.
//
// Module-level because the exported closeMcpSession/getMcpSessionCount are
// called from index.ts and the /health route. Null in stdio mode, which has no
// registry. `idleReaper` is held alongside so closeMcpSession can undo
// everything startMcpServerHttp set up — an interval nobody can clear outlives
// every server it was created for.
let sessions: McpSessionRegistry<McpServer, StreamableHTTPServerTransport> | null = null;
let idleReaper: ReturnType<typeof setInterval> | null = null;

/**
 * Server instructions, surfaced into the session's context at startup.
 *
 * ## Why this field, for this problem
 *
 * PR #1393 measured natural first-use dispatch of the `tandem` skill at 3 of 6 sessions, so the
 * arming instruction that lives in `SKILL.md` was never read in half of them. The traces say why:
 * every declining session called `ToolSearch` *before* `tandem_status`. With tool search on (the
 * default) only tool NAMES and server instructions load upfront — so at the moment the behaviour
 * was decided, the model had Tandem's tool names and an empty instructions string. Nothing about
 * wake monitoring was in context at all. This field is the documented mechanism for that gap
 * ("help Claude understand when to search for your tools, similar to how skills work"), and unlike
 * a skill it needs no discovery step and no judgment about whether guidance is worth loading.
 *
 * ADR-049 recorded this field's behaviour as UNVERIFIED because nothing sent one. Verified
 * 2026-08-11: a live session's context carries an "MCP Server Instructions" section rendering the
 * attached servers' strings verbatim. The channel shim already ships one (`src/channel/run.ts`).
 *
 * ## Constraints, each load-bearing
 *
 * - **Truncated at 2KB**, so the authority-of-checkInbox line comes first.
 * - **No arm command.** `wake-advisory.ts` refuses to emit one so Tandem output never teaches Claude
 *   that its responses carry commands to run — an imported Word comment could imitate that. A second
 *   emitter would re-open the pattern even though this text is metadata rather than tool content.
 * - **The launcher carve-out is not optional.** `SKILL.md` says do not arm if Tandem launched you: a
 *   launcher-spawned session is already woken on its stdin (#1266) and a second watch double-wakes
 *   every event. That caveat otherwise lives only in the skill body, which is read *second* and only
 *   if the skill is invoked — while these instructions arrive before any skill decision. An
 *   unconditional "arm one" here would regress the population that already works.
 * - **No coverage claim.** The server cannot know whether THIS session is armed; the subscriber count
 *   is stale by construction since #1354. So this is a standing instruction with an at-most-once
 *   bound, never "you are not covered" — that judgement belongs to `wake-advisory.ts`, which fires
 *   only on the one sound negative (nothing attached at all).
 * - **Client-agnostic.** A non-Claude MCP client gets no `SKILL.md`, so this must not require a
 *   Claude-Code-specific tool by name — hence "if your client can hold a persistent watch".
 */
export const SERVER_INSTRUCTIONS = [
  "Tandem is a collaborative document editor — the user edits the same document alongside you.",
  "Always treat tandem_checkInbox as the authority on user activity, and poll it every few tool calls.",
  "Nothing polls between your turns: if your client can hold a persistent watch, arm one (at most once",
  "per session) on the wakeUrl from tandem_status. Skip that if Tandem launched this session — it is",
  "already woken on its input, and a second watch double-wakes every event.",
  "In solo mode, hold annotations rather than surfacing them.",
].join(" ");

/** Create an McpServer with all tool groups registered (no transport). */
function createMcpServer(diagnostics: DiagnosticsToolDeps = {}): McpServer {
  const server = new McpServer(
    {
      name: "tandem",
      version: APP_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerDocumentTools(server);
  registerAnnotationTools(server);
  registerNavigationTools(server);
  registerAwarenessTools(server);
  registerApplyTools(server);
  registerDiagnosticsTools(server, diagnostics);

  // AFTER registration: the SDK installs its tools/list handler lazily on the
  // first registerTool, and this wraps that handler (#1564). The return value
  // is deliberately not acted on — it logs on drift, and the gate that actually
  // catches drift is `tests/server/mcp-schema-dialect.test.ts` in CI.
  installSchemaDialectStrip(server);

  return server;
}

/** Extract the JSON-RPC `id` from a request body (single message only, not batches). */
export function jsonrpcId(body: unknown): unknown {
  return body && typeof body === "object" && !Array.isArray(body) && "id" in body
    ? (body as Record<string, unknown>).id
    : null;
}

/** Read the SDK's session id from a request. Header names are lower-cased by Node. */
function readMcpSessionHeader(req: import("express").Request): string | undefined {
  const raw = req.headers["mcp-session-id"];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Read the calling Claude Code session id, if the transport carries one.
 *
 * Only the stdio-bridge config path does: it runs as a Claude Code subprocess,
 * so `CLAUDE_CODE_SESSION_ID` is in its environment and `mcp-stdio.ts` forwards
 * it. A direct-HTTP `.mcp.json` entry has no subprocess and only static headers,
 * so this returns undefined there — callers must degrade, not assume.
 *
 * The value is re-validated rather than trusted: it arrives over HTTP and only
 * the *sending* side (`resolveClaudeSessionId`) applied the guards. Anything
 * oversized or non-printable is dropped rather than stored as a map key.
 */
function readClaudeSessionHeader(req: import("express").Request): string | undefined {
  return normalizeSessionId(req.headers[CLAUDE_SESSION_HEADER.toLowerCase()]);
}

/** Send a JSON-RPC error response. */
function sendJsonRpcError(
  res: import("express").Response,
  status: number,
  code: number,
  message: string,
  id: unknown = null,
): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id });
}

/**
 * Build a server + transport for one new client session, connect them, and run
 * the initialize request through it.
 *
 * Deliberately does NOT touch any other session — that non-eviction is the
 * whole point of #438 §3.2. Registration is driven by `onsessioninitialized`
 * rather than by this function, because the SDK mints `transport.sessionId`
 * while *handling* the initialize request, not at construction.
 *
 * Owning the handshake (rather than returning the parts for a caller to
 * assemble) keeps the leak cleanup with the code that creates the thing being
 * leaked: a handshake that ends without initializing leaves a connected server
 * nothing holds a key to, and the registry cannot reap an entry it never
 * received.
 */
async function openSession(
  registry: McpSessionRegistry<McpServer, StreamableHTTPServerTransport>,
  buildServer: () => McpServer,
  claudeSessionId: string | undefined,
  handshake: (transport: StreamableHTTPServerTransport) => Promise<void>,
): Promise<void> {
  const server = buildServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: async (sessionId) => {
      await registry.add({ sessionId, server, transport, claudeSessionId });
      console.error(
        `[Tandem] MCP session established: ${sessionId}` +
          `${claudeSessionId ? ` (claude session ${claudeSessionId})` : ""} — ${registry.size} live`,
      );
    },
    // Fires on DELETE /mcp. Dropping the entry here (rather than only in the
    // DELETE route) also covers session closes the SDK initiates itself.
    onsessionclosed: async (sessionId) => {
      await registry.close(sessionId);
      console.error(`[Tandem] MCP session closed: ${sessionId} — ${registry.size} live`);
      // Last session gone ⇒ Claude is definitively absent. Clear its presence now
      // rather than letting the TTL run out — session end is positive knowledge,
      // and `tandem_status` writes `active: true` with no writer able to unset it.
      if (registry.size === 0) clearAllClaudePresence();
    },
  });

  await server.connect(transport);
  try {
    await handshake(transport);
  } finally {
    if (transport.sessionId === undefined) {
      await server.close().catch(() => {});
    }
  }
}

/**
 * Close every active MCP session and stop the idle reaper (graceful shutdown).
 * Named singular for backwards compatibility with its callers in `index.ts`.
 */
export async function closeMcpSession(): Promise<void> {
  if (idleReaper) {
    clearInterval(idleReaper);
    idleReaper = null;
  }
  await sessions?.closeAll();
}

/** Live MCP session count. Exported for `/health`'s loopback-only `hasSession`. */
export function getMcpSessionCount(): number {
  return sessions?.size ?? 0;
}

/**
 * Run one idle-reap pass, returning how many sessions it closed.
 *
 * The 5-minute interval calls this rather than `registry.reapIdle()` directly,
 * so a test that forces a reap drives the exact same path production does. That
 * matters more than it looks: the invariant under test is "an attached session
 * survives a reap", and a test that instead builds its own registry is
 * asserting something weaker about a path the route never touches.
 *
 * `idleTtlMsOverride` lets such a test treat a seconds-old session as stale;
 * production omits it and gets the configured 30-minute TTL.
 */
export async function reapIdleMcpSessions(idleTtlMsOverride?: number): Promise<number> {
  return (await sessions?.reapIdle(idleTtlMsOverride)) ?? 0;
}

/**
 * How many live sessions are currently pinned by an open SSE stream. Exported
 * for tests to assert the counter balances — a leak here would show up only as
 * sessions that stop being reapable, which is silent until the cap is hit.
 */
export function getPinnedMcpSessionCount(): number {
  return (sessions?.list() ?? []).filter((entry) => entry.openStreams > 0).length;
}

/** Start the MCP server on stdio (legacy, used as fallback via TANDEM_TRANSPORT=stdio). */
export async function startMcpServerStdio(): Promise<void> {
  const server = createMcpServer({ version: APP_VERSION, transport: "stdio" });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Snapshot the number of registered MCP tools from a server instance.
 *
 * Uses `_registeredTools`, a private field of McpServer (SDK 1.30.0, plain object keyed
 * by tool name). Returns null if the field is absent or not a plain object — callers
 * should log and surface null rather than silently returning 0.
 *
 * NOTE: This relies on a private SDK field. If the SDK renames it, this returns null
 * (not 0), which is surfaced to the client so maintainers can detect shape drift.
 */
function snapshotToolCount(server: McpServer): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools;
  if (tools === null || tools === undefined || typeof tools !== "object" || Array.isArray(tools)) {
    console.error("[Tandem] /api/info: _registeredTools shape drift — cannot snapshot tool count");
    return null;
  }
  return Object.keys(tools).length;
}

/** Start the MCP server on HTTP using Streamable HTTP transport. Returns the http.Server for lifecycle management. */
export interface LauncherWiring {
  /** Late-bound: the supervisor is created in `src/server/index.ts` *after*
   * this function returns. Routes call this getter on each request. */
  getSupervisor: () => import("../launcher/supervisor.js").Supervisor | null;
  /** Why the supervisor is null. Surfaced in `GET /api/launcher/status`. */
  unavailableReason: () => import("../../shared/launcher/contract.js").LauncherUnavailableReason;
  /** Create + start the supervisor from null. Only reachable via
   * `POST /api/launcher/start` in the `deferred-autostart` state (#1236). */
  startSupervisor: () => Promise<void>;
}

export async function startMcpServerHttp(
  port: number,
  host = DEFAULT_BIND_HOST,
  token?: string,
  /**
   * Resolved LAN IP for the Host-header allowlist.
   * Passed when TANDEM_BIND_HOST is non-loopback so that browsers on the LAN
   * (which send e.g. `Host: 192.168.1.50:3479`) pass the DNS-rebinding check.
   * undefined for loopback binds — only localhost/127.0.0.1/tauri.localhost allowed.
   */
  resolvedLanIP?: string,
  /** Launcher route wiring. Omitted in tests; routes simply not registered. */
  launcher?: LauncherWiring,
  /**
   * Hocuspocus' live (TANDEM_PORT-resolved) port — threaded into the
   * /api/diagnostics self-probe so an overridden instance doesn't report
   * itself "not running". index.ts resolves it once; tests can omit it.
   */
  wsPort: number = DEFAULT_WS_PORT,
  /**
   * Graceful-shutdown wiring for POST /api/shutdown (#1088). Provided by the
   * entry point in HTTP mode; omitted in tests → route not registered.
   */
  shutdownWiring?: import("./routes/shutdown.js").ShutdownRouteDeps,
): Promise<Server> {
  // Typed as the stricter of the two consumers' shapes (the handler requires
  // `version`; the tool deps make it optional), so one literal can feed both
  // the per-session MCP servers and the /api/diagnostics route.
  const diagnosticsDeps: DiagnosticsHandlerDeps = {
    version: APP_VERSION,
    transport: "http",
    wsPort,
    mcpPort: port,
  };
  const buildServer = () => createMcpServer(diagnosticsDeps);
  const registry = createMcpSessionRegistry<McpServer, StreamableHTTPServerTransport>();
  sessions = registry;

  // Snapshot the tool count from a throwaway instance. There is no longer a
  // boot-time singleton server to read it from (each client session owns its
  // own), but registrations are unconditional in createMcpServer(), so any
  // instance yields the same count for the process lifetime. The instance is
  // never connected, so it holds no transport, timer, or listener to clean up.
  const toolCount = snapshotToolCount(buildServer());

  // Idle reaper (#438 §6.4). Required, not optional: without it the map grows
  // for every client that vanishes without a DELETE (crash, SIGKILL, closed
  // laptop). unref() so it never holds the process open; closeMcpSession()
  // clears it so a repeated start/stop (tests) doesn't accumulate intervals.
  if (idleReaper) clearInterval(idleReaper);
  idleReaper = setInterval(
    () => {
      void reapIdleMcpSessions();
    },
    5 * 60 * 1000,
  );
  idleReaper.unref();

  // We need two different body parser limits: 100kb for MCP (SDK default)
  // and 70MB for file upload API. createMcpExpressApp applies express.json()
  // globally with 100kb limit. Solution: create our own outer app, register
  // /api routes with a larger body parser, then mount the SDK app for /mcp.
  const { default: express } = await import("express");
  const app = express();

  // Auth middleware: validates Bearer token for all non-loopback requests.
  // Runs before per-route apiMiddleware; loopback bypass preserves DNS-rebinding
  // for loopback callers. Rate-limit and token checks apply to non-loopback
  // requests only.
  // Loopback (127.0.0.1, ::1, ::ffff:127.0.0.1) is always exempt —
  // Claude Code zero-config is preserved.
  //
  // Mutable ref: `POST /api/rotate-token` swaps the token without a server restart.
  const tokenRef = { current: token ?? null };
  const authMiddleware = createAuthMiddleware(() => tokenRef.current);

  // DNS-rebinding middleware: extend the Host-header allowlist with the resolved
  // LAN IP when binding non-loopback. For loopback binds resolvedLanIP is
  // undefined and this falls back to the standard localhost-only middleware.
  const lanAwareApiMiddleware = resolvedLanIP
    ? createApiMiddleware([resolvedLanIP])
    : apiMiddleware;

  // Large body parser for file-open and upload routes only (up to 70MB).
  // NOT mounted globally — other routes (MCP, /health) use the SDK's own parser.
  const largeBody = express.json({ limit: "70mb" });

  // SDK app provides express.json() (100kb limit) + DNS rebinding protection.
  // When binding non-loopback, pass allowedHosts so the SDK's hostHeaderValidation
  // activates for /mcp (port-agnostic hostname matching). This closes the
  // DNS-rebinding gap that would otherwise exist because authMiddleware's loopback
  // bypass runs before the SDK's host-header check on the inner mcpApp.
  // The SDK strips the port via URL.hostname, so we supply bare hostnames only.
  const allowedHosts = resolvedLanIP
    ? ["127.0.0.1", "localhost", "[::1]", resolvedLanIP, TAURI_HOSTNAME]
    : undefined;
  const mcpApp = createMcpExpressApp({ host, ...(allowedHosts ? { allowedHosts } : {}) });

  /**
   * Route a non-initialize request to its existing session.
   *
   * Every `handleRequest` on this server runs inside `runWithMcpContext` — one
   * uniform rule rather than "only where a tool call can be dispatched today",
   * so a future SDK that dispatches over another verb can't silently lose the
   * caller's identity. Returns the entry so callers that need post-dispatch
   * work (DELETE) can act on it; returns undefined when it already answered 404.
   *
   * `onEntry` runs after the resolve+touch and **before** `handleRequest`, and
   * deliberately outside `runWithMcpContext` — the invariant that the
   * AsyncLocalStorage run wraps the *entire awaited* `handleRequest` must not
   * move. Before-the-await is the only placement that works for the GET route:
   * a standalone SSE stream's `handleRequest` does not resolve until the stream
   * closes, so anything after the await would mark the stream open exactly once
   * it had already ended. "Simplify this to after the dispatch" is silently
   * wrong; leave it here.
   */
  async function dispatchToSession(
    req: import("express").Request,
    res: import("express").Response,
    body: unknown,
    errorId: unknown = null,
    onEntry?: (entry: McpSessionEntry<McpServer, StreamableHTTPServerTransport>) => void,
  ) {
    const entry = registry.get(readMcpSessionHeader(req));
    if (!entry) {
      // 404, not 503: the old single-transport code answered "No active
      // session" for a *stale* id, which reads as "server is down" when the
      // truth is "that session is gone, re-initialize".
      sendJsonRpcError(res, 404, -32001, "Session not found", errorId);
      return undefined;
    }
    registry.touch(entry.sessionId);
    onEntry?.(entry);
    await runWithMcpContext(
      { claudeSessionId: entry.claudeSessionId, mcpSessionId: entry.sessionId },
      () => entry.transport.handleRequest(req, res, body),
    );
    return entry;
  }

  mcpApp.post("/mcp", async (req: import("express").Request, res: import("express").Response) => {
    const body = req.body as unknown;
    const isInit =
      isInitializeRequest(body) || (Array.isArray(body) && body.some(isInitializeRequest));

    if (isInit) {
      const claudeSessionId = readClaudeSessionHeader(req);
      try {
        // handleRequest is what mints the session id and fires
        // onsessioninitialized, so the registry entry appears during this call.
        await openSession(registry, buildServer, claudeSessionId, (transport) =>
          runWithMcpContext({ claudeSessionId }, () => transport.handleRequest(req, res, body)),
        );
      } catch (err) {
        console.error("[Tandem] Failed to create new MCP session:", err);
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal error", jsonrpcId(body));
        }
      }
      return;
    }

    await dispatchToSession(req, res, body, jsonrpcId(body));
  });

  // GET opens the standalone server→client SSE stream. While it is open the
  // client is demonstrably attached, so the session is pinned against the idle
  // reaper (see transport-registry.ts). The increment and the matching `close`
  // listener must stay **adjacent and synchronous with nothing fallible between
  // them**: anything that throws in the gap pins the session permanently, and
  // only LRU eviction would ever reclaim it.
  //
  // Registering before `handleRequest` is also what balances the SDK's
  // rejection paths (409 "one stream per session", 405, 400) — `res` is still
  // open at that point, so `close` is guaranteed to fire and undo the pin.
  mcpApp.get("/mcp", async (req: import("express").Request, res: import("express").Response) => {
    await dispatchToSession(req, res, req.body, null, (entry) => {
      registry.noteStreamOpened(entry.sessionId);
      // `once`, not `on`. A duplicate `close` would decrement a count that can
      // legitimately be 2 mid-stream-reconnect, and `noteStreamClosed`'s floor
      // at 0 does not catch that — it only stops the count going negative, so a
      // double decrement from 2 would unpin a live client.
      res.once("close", () => registry.noteStreamClosed(entry.sessionId));
    });
  });

  // DELETE — on success the SDK tears the session down and fires
  // onsessionclosed, which is what removes the registry entry (see
  // openSession). On a *rejected* delete (unknown session, stale
  // Mcp-Protocol-Version) the SDK's webStandardStreamableHttp responds 4xx
  // without calling onsessionclosed and leaves the session exactly as it
  // was -- confirmed against the installed SDK's handleDeleteRequest, which
  // this Node transport reaches via @hono/node-server's request adapter, so
  // `res.statusCode` reflects the real outcome by the time handleRequest
  // resolves.
  mcpApp.delete("/mcp", async (req: import("express").Request, res: import("express").Response) => {
    const entry = await dispatchToSession(req, res, req.body);
    // Belt-and-braces: onsessionclosed normally does this, so this is a no-op
    // in the success path. Gated on the delete having actually succeeded (200)
    // -- otherwise a rejected delete would force-close a session the SDK
    // deliberately chose to keep alive, stranding a client that still holds a
    // valid session id.
    if (entry && res.statusCode === 200) await registry.close(entry.sessionId);
  });

  // NOTE: there is deliberately NO license-webhook route here. License issuance
  // lives entirely in `infra/license-issuance-worker/` — a Cloudflare Worker that
  // Polar can actually reach. The old `/webhooks/license` handler was mounted
  // ahead of authMiddleware with no Host check (an unauthenticated,
  // DNS-rebinding-reachable POST usable as a Tandem-presence oracle) and signed
  // with an invented `t=,v1=` scheme Polar never sends. Removed in #1116
  // follow-up; do not re-add a payment-processor endpoint to a server that binds
  // to loopback.

  // Auth middleware for /mcp and /api/* — mounted BEFORE the per-route DNS-rebinding
  // check and, for /api, BEFORE enforceLoopbackMutation too. Express dispatches
  // middleware in registration order and every one of those checks is attached later in
  // this same function, so a request that fails auth AND a Host check is answered 401 by
  // auth, never 403 by the Host check.
  //
  // There are TWO Host checks in front of /api/*, not one. `app.use(mcpApp)` below mounts
  // the SDK sub-app at the ROOT with no path prefix, and createMcpExpressApp installs its
  // hostHeaderValidation as a bare app.use INSIDE that sub-app — so every request that
  // reaches that line, /api/* included, passes through the SDK's Host check, and it is
  // registered before registerApiRoutes attaches lanAwareApiMiddleware per route. The
  // real /api chain is therefore:
  //     authMiddleware -> enforceLoopbackMutation -> mcpApp's express.json +
  //     hostHeaderValidation -> the route's lanAwareApiMiddleware -> handler
  // The SDK check fires first and answers with a JSON-RPC body ("Invalid Host: evil.com");
  // lanAwareApiMiddleware narrows it further per route, rejecting hosts the SDK's list
  // admits (e.g. "localhost:PORT" and "[::1]:PORT") with {"error":"FORBIDDEN"}. Reading a
  // 403 on /api without checking the body will attribute it to the wrong middleware.
  //
  // Loopback is always exempt from auth (Claude Code zero-config), so this ordering has no
  // security effect either way — both Host checks still run unconditionally for a
  // loopback-bypassing caller, just after auth instead of before.
  // /health and /.well-known/* never reach authMiddleware at all: they're registered
  // directly on `app`, outside both the /api and /mcp prefixes this middleware is mounted
  // on. They are also registered ABOVE `app.use(mcpApp)`, so they never reach the SDK Host
  // check either — /health carries its own lanAwareApiMiddleware, the metadata routes are
  // deliberately unguarded (they must be reachable before auth is established).
  // Note: all channel routes use /api/channel-* paths (covered by /api below).
  app.use("/mcp", authMiddleware);
  app.use("/api", authMiddleware);

  // #1320: /api is loopback-only for every method except GET/HEAD/OPTIONS, with
  // the channel/Cowork transport carved out by name. Mounted AFTER auth so an
  // unauthenticated LAN peer gets 401 rather than a map of which routes exist,
  // and BEFORE every registrar below so a route added later inherits it without
  // its author having to know this rule.
  app.use("/api", enforceLoopbackMutation);

  // Health endpoint — lanAwareApiMiddleware protects against DNS rebinding.
  // Auth-exempt: health is public diagnostic info.
  // Invariant 7: omit hasSession when request is non-loopback (session presence leaks).
  app.get(
    API_HEALTH,
    lanAwareApiMiddleware,
    makeHealthHandler({
      version: APP_VERSION,
      hasSession: () => getMcpSessionCount() > 0,
      getSubscriberCount,
      getPushLiveness: getPushConsumerLiveness,
      getDeliveryState: (externalConsumerCount) =>
        getDeliveryState(Date.now(), externalConsumerCount),
    }),
  );

  // RFC 9728 Protected Resource Metadata — declares Bearer auth via header.
  // Newer Claude Code versions probe this before connecting to MCP.
  // resource uses literal "127.0.0.1" (invariant 6 — never req.host or a detected LAN IP).
  // Auth-exempt: these endpoints must be reachable before auth is established.
  app.get(
    "/.well-known/oauth-protected-resource/mcp",
    (_req: import("express").Request, res: import("express").Response) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.json({
        resource: `http://127.0.0.1:${port}/mcp`,
        bearer_methods_supported: ["header"],
        authorization_servers: [`http://127.0.0.1:${port}`],
      });
    },
  );
  app.get(
    "/.well-known/oauth-protected-resource",
    (_req: import("express").Request, res: import("express").Response) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.json({
        resource: `http://127.0.0.1:${port}/mcp`,
        bearer_methods_supported: ["header"],
        authorization_servers: [`http://127.0.0.1:${port}`],
      });
    },
  );

  // Mount SDK app (handles /mcp with 100kb body parser + DNS rebinding)
  app.use(mcpApp);

  // --- REST API for browser-initiated file opening ---
  registerApiRoutes(
    app,
    largeBody,
    token,
    lanAwareApiMiddleware,
    (newToken) => {
      tokenRef.current = newToken;
    },
    () => tokenRef.current,
    {
      version: APP_VERSION,
      toolCount,
      mcpSdkVersion: MCP_SDK_VERSION,
      storagePath: SESSION_DIR,
      getTokenFilePath,
      changelogPath: CHANGELOG_PATH,
      workflowsPath: WORKFLOWS_PATH,
      welcomePath: WELCOME_PATH,
      transport: "http",
      bindHost: host,
      bindPort: port,
      getGenerationId,
    },
    diagnosticsDeps,
    shutdownWiring,
  );

  // --- Channel support endpoints ---
  registerChannelRoutes(app, lanAwareApiMiddleware);

  // --- Integration wizard endpoints (#477 PR 3c-i) ---
  // Wizard reads existing entries (PR 3a), reads/writes the integrations file
  // (PR 1), and stores per-integration secrets in the OS keychain (PR 3b).
  // Behind a feature flag at the client level — endpoints are always mounted
  // so future programmatic clients (CLI TTY mode, plugins) can use them too.
  registerIntegrationsRoutes(app, largeBody, lanAwareApiMiddleware, {
    store: createIntegrationsStore(resolveAppDataDir()),
    keychain: createKeychain(),
    readExisting: readExistingTandemEntries,
    serverVersion: APP_VERSION,
  });

  // --- Auto-launcher endpoints (#477 PR 4b) ---
  // Status, single-use nonce, relaunch, start-fresh, and a narrow
  // working-directory POST that bypasses the integrations apply-nonce
  // rotation. `launcher` is optional — if omitted (tests, future stdio
  // hardening), the routes are not registered and clients get 404.
  if (launcher) {
    const [{ registerLauncherRoutes }, { getSkillRefreshError }] = await Promise.all([
      import("../launcher/api-routes.js"),
      import("../integrations/apply.js"),
    ]);
    registerLauncherRoutes(app, lanAwareApiMiddleware, {
      getSupervisor: launcher.getSupervisor,
      unavailableReason: launcher.unavailableReason,
      startSupervisor: launcher.startSupervisor,
      store: createIntegrationsStore(resolveAppDataDir()),
      getSkillRefreshError,
      // Tandem's own auto-opened documents. `welcome.md` opens on first run and
      // `CHANGELOG.md` after every upgrade, both from inside the app bundle —
      // which on Windows sits under `%LOCALAPPDATA%`, i.e. INSIDE the user's
      // home directory, and therefore passes every validity check the drift
      // preview applies. Without this list the two states every desktop user
      // passes through would each open with a suggestion to move Claude into
      // Tandem's install directory.
      bundledDocDirs: resolveBundledDocDirs(),
    });
  }

  // --- Models registry secrets endpoints (#659) ---
  // Outbound third-party API keys (Anthropic, OpenAI, Gemini, etc.) live in
  // the OS keychain under a separate `tandem-models` service so they can't
  // accidentally collide with inbound MCP-client auth tokens. Same security
  // gates as the integration secret routes (origin allowlist +
  // loopback-for-mutation, 503 on keychain unavailability).
  registerModelsRoutes(app, largeBody, lanAwareApiMiddleware, {
    keychain: createKeychain({ service: KEYCHAIN_SERVICE_MODELS }),
  });

  // Serve built client assets when present (populated by `vite build`).
  // express.static falls through for paths it doesn't find, so /mcp, /api/*,
  // /health, and channel routes registered above continue to work normally.
  // Static routes and SPA fallback intentionally omit apiMiddleware — they only serve
  // static assets, no sensitive data.
  if (existsSync(CLIENT_DIST)) {
    // Express 5 types omit express.static and res.sendFile — they exist at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use((express as any).static(CLIENT_DIST, { index: "index.html" }));
    // SPA fallback: serve index.html for client-side routes not matched above
    const indexPath = join(CLIENT_DIST, "index.html");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.get("/{*path}", (_req: import("express").Request, res: any) => {
      res.sendFile(indexPath);
    });
    console.error(`[Tandem] Serving client from ${CLIENT_DIST}`);
  } else {
    console.error(`[Tandem] No client dist at ${CLIENT_DIST} — run 'npm run build' first`);
  }

  return new Promise<Server>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      httpServer.on("error", (err: Error) => console.error("[Tandem] HTTP server error:", err));
      // The self-arm wake transport (ADR-049). Attached to the http.Server
      // rather than the Express app because it is a protocol upgrade — it
      // carries its own guard, and `resolvedLanIP` is passed only so the Host
      // allowlist matches the rest of the surface. The loopback check inside
      // rejects a LAN peer regardless.
      attachWakeSocket(httpServer, resolvedLanIP ? [resolvedLanIP] : []);
      console.error(`[Tandem] MCP HTTP server on http://${host}:${port}/mcp`);
      resolve(httpServer);
    });
    httpServer.on("error", reject);
  });
}
