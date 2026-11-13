/**
 * The owner handle (#2358 PR 3a, ADR-054; ownership design §3.3 route L).
 *
 * A per-spawn bearer secret the launcher mints for Tandem's own Claude's child:
 * `th_` followed by exactly 32 base64url characters. The launcher writes it,
 * with this server's base URL, into the `env` of the one `tandem` entry it
 * passes the child as `--mcp-config`; the child's stdio bridge reads it and
 * sends it as `X-Tandem-Owner-Handle`; the server records which transports
 * bound to the current spawn (`src/server/sessions/owner-handle-bind.ts`).
 *
 * Lives in `src/shared` because the stdio bridge is a define-less bundle: it
 * may import nothing that reads a build flag, and this module reads none.
 *
 * Never log a handle, never echo one in an error, never print one to the
 * bridge's stderr (Claude Code captures that into its own logs). The server's
 * log sink redacts the shape unconditionally (`src/server/log-redact.ts`).
 */

/** The variable the child's bridge reads the handle from. */
export const OWNER_HANDLE_ENV = "TANDEM_OWNER_HANDLE";

/**
 * The base URL of the server that minted the handle (scheme, host and port,
 * no path), set only by the launcher's own `--mcp-config` entry. The bridge
 * presents the handle only when the URL it actually resolved equals this one
 * (R2.2), so the handle's destination never depends on Claude Code's
 * unmeasured order for merging an entry's `env` with its own environment.
 * Not a secret; stripped from the launched child's environment
 * (`TANDEM_SECRET_ENV_KEYS`) so that only the launcher's entry can supply it.
 */
export const OWNER_HANDLE_URL_ENV = "TANDEM_OWNER_HANDLE_URL";

/** The request header the bridge presents the handle in. Read by the server
 * at `initialize` only, and only while ownership is on. */
export const OWNER_HANDLE_HEADER = "X-Tandem-Owner-Handle";

/** The handle's exact shape. Checked before any comparison, on both ends. */
export const OWNER_HANDLE_RE = /^th_[A-Za-z0-9_-]{32}$/;

/** Whether `value` is exactly a well-formed handle. Total. */
export function isOwnerHandleShape(value: unknown): value is string {
  return typeof value === "string" && OWNER_HANDLE_RE.test(value);
}

/** The normalization `resolveTandemUrl` applies: trim, strip trailing slashes. */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Whether `baseUrl` names a Tandem MCP server on this computer in the one
 * shape the launcher writes: `http:`, `127.0.0.1` or `[::1]`, an explicit
 * port, and nothing else (no path, credentials, query or fragment).
 *
 * Deliberately NOT `tokenMayGoTo`: that one allows the default port after
 * Tandem has moved off it, and returns true for any URL while
 * `LAN_BIND_ENABLED` is on. The handle's destination does not widen with the
 * bind (ADR-056 re-enable checklist).
 */
export function isLoopbackHandleDestination(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return false;
  if (url.port === "") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
  return true;
}

/**
 * Whether Node's own environment proxy could carry a request from this
 * process (#2358 PR 3a review rounds 1 and 2). With the environment proxy on
 * and an `HTTP_PROXY`, Node sends a request for `http://127.0.0.1:<port>`
 * through the proxy as a plain-HTTP `CONNECT` tunnel, where every header is
 * readable.
 *
 * **A plain rule, deliberately not a model of Node's `NO_PROXY` handling**
 * (Bryan's ruling, review round 2): a copy of undici's parsing drifted from it
 * at once (`[::1]` with `NO_PROXY=::1`, lower- against upper-case precedence,
 * `*` inside a list, a quoted flag). So `NO_PROXY` is ignored, and the handle is
 * withheld whenever the proxy COULD be on and any HTTP proxy variable is set:
 *  - could be on: `NODE_USE_ENV_PROXY` is set to anything non-empty, or the text
 *    `use-env-proxy` appears anywhere in `NODE_OPTIONS` or the process's flags;
 *  - any HTTP proxy variable: `HTTP_PROXY` or `http_proxy` with a non-blank value.
 * That errs toward "not bound" for a user with a proxy and the flag set. When
 * #2422 lands (the bridge's own fetch never uses an environment proxy for
 * loopback), this guard can go.
 */
export function envProxyMayCarry(
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[] = [],
): boolean {
  const flagOn =
    (env.NODE_USE_ENV_PROXY ?? "") !== "" ||
    (env.NODE_OPTIONS ?? "").includes("use-env-proxy") ||
    execArgv.some((a) => a.includes("use-env-proxy"));
  if (!flagOn) return false;
  const nonBlank = (v: string | undefined) => v !== undefined && v.trim() !== "";
  return nonBlank(env.HTTP_PROXY) || nonBlank(env.http_proxy);
}

/**
 * The handle the bridge presents upstream, or `undefined` (R2.1, R2.2).
 *
 * `resolvedBaseUrl` is what the bridge actually connects to
 * (`resolveTandemUrl()`, where `CLAUDE_PLUGIN_OPTION_SERVER_URL` comes before
 * `TANDEM_URL`). The handle is presented only when all hold:
 *  - `TANDEM_OWNER_HANDLE` is exactly a handle (a malformed value is ignored
 *    silently: no header, no echo, no log line, no exit);
 *  - the launcher's own URL variable is set;
 *  - it equals the resolved URL, both normalized as `resolveTandemUrl` does;
 *  - that URL is a loopback handle destination;
 *  - Node's environment proxy cannot carry the request ({@link envProxyMayCarry}).
 * Otherwise the bridge sends no handle and carries on as before. Total and
 * silent: the caller prints nothing about the outcome.
 */
export function ownerHandleForUpstream(
  resolvedBaseUrl: string,
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[] = [],
): string | undefined {
  const handle = env[OWNER_HANDLE_ENV];
  if (!isOwnerHandleShape(handle)) return undefined;
  const named = env[OWNER_HANDLE_URL_ENV];
  if (typeof named !== "string" || named.trim() === "") return undefined;
  const target = normalizeBaseUrl(resolvedBaseUrl);
  if (normalizeBaseUrl(named) !== target) return undefined;
  if (!isLoopbackHandleDestination(target)) return undefined;
  // Node's environment proxy would carry the header to the proxy (review
  // item 3): withhold it rather than send it anywhere but the named server.
  if (envProxyMayCarry(env, execArgv)) return undefined;
  return handle;
}
