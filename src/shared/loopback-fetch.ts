/**
 * A `fetch` that never uses an environment proxy for a request to this
 * computer (#2422).
 *
 * Node 22.21+ can route its global `fetch` through `HTTP_PROXY` when
 * `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`) is set, and it does not exempt
 * loopback: a request for `http://127.0.0.1:<port>` leaves as a plain-HTTP
 * `CONNECT` tunnel through the proxy, where `Authorization` and every other
 * header can be read. The choice is fixed when the process starts, so nothing
 * Tandem does afterwards can switch it off on the global `fetch`.
 *
 * So a request whose host is `127.0.0.1` or `[::1]` is made through undici's
 * own `fetch` and a plain `Agent`, which reads no proxy variable at all. Any
 * other host goes to the global `fetch` exactly as before: with
 * `LAN_BIND_ENABLED` on, `tokenMayGoTo` admits any URL, and a real proxy may
 * then be what the user needs. `localhost` is deliberately not matched; Tandem
 * only ever writes the two IP literals (`resolveTandemUrl`).
 *
 * Used by the three programs that carry the auth token to the local server:
 * the stdio bridge's MCP transport and preflight, and `authFetch` (the channel
 * shim, the monitor and the SSE consumer). The SSE body streams as before.
 * Redirects are not touched: the caller's `redirect` mode passes through.
 *
 * Imports nothing from `src/server`, and reads no build flag, so any bundle
 * may take it.
 */

import { Agent, fetch as undiciFetch } from "undici";

/** The loopback hosts Tandem writes. `URL.hostname` keeps the IPv6 brackets. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]"]);

type FetchInput = string | URL | Request;

/** The URL a `fetch` input names, or undefined when it does not parse. */
function targetUrl(input: FetchInput): URL | undefined {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return undefined;
  }
}

/** Whether `input` names a host on this computer by the literal Tandem uses. */
export function isLoopbackTarget(input: FetchInput): boolean {
  const url = targetUrl(input);
  return url !== undefined && LOOPBACK_HOSTS.has(url.hostname);
}

// Lazy: nothing is allocated in a program that never makes the request.
let agent: Agent | undefined;
function proxyFreeAgent(): Agent {
  agent ??= new Agent();
  return agent;
}

/**
 * Drop-in `fetch`. Loopback targets use undici with a proxy-free agent; every
 * other target uses the global `fetch`, looked up at call time.
 *
 * undici's `fetch` is a different implementation from the global one, and its
 * `Request` is a different class, so a global `Request` handed to it would
 * throw. A loopback `Request` is therefore unpacked into its URL and the init
 * it carries (an explicit `init` still wins, as it does in `fetch`).
 */
export const loopbackFetch: typeof fetch = async (input, init) => {
  if (!isLoopbackTarget(input)) return globalThis.fetch(input, init);
  let target: string | URL = input as string | URL;
  let merged = init;
  if (typeof Request !== "undefined" && input instanceof Request) {
    target = input.url;
    merged = {
      method: input.method,
      headers: input.headers,
      body: input.body === null ? undefined : await input.arrayBuffer(),
      redirect: input.redirect,
      signal: input.signal,
      ...init,
    };
  }
  // undici's `fetch` takes its own dispatcher option, which the DOM
  // `RequestInit` type does not declare, and returns undici's own `Response`
  // (same shape, different declaration). Both casts stop here.
  return undiciFetch(target as Parameters<typeof undiciFetch>[0], {
    ...(merged as Parameters<typeof undiciFetch>[1]),
    // The point of the module. undici's `fetch` with no dispatcher shares
    // Node's global one, and so follows an environment proxy.
    dispatcher: proxyFreeAgent(),
  }) as unknown as Promise<Response>;
};
