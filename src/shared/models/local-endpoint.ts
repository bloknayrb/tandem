/**
 * The local-model endpoint rule (#1123, ADR-039): loopback-only, by string
 * match against an explicit host set. Moved unchanged from
 * `src/server/local-model/config.ts` (whose header tells the SSRF and
 * `localhost` substitution story, and which re-exports this rule) so the
 * add-model window can call the same function. Pure: the global `URL` only.
 */

export type EndpointValidation =
  | { ok: true; url: URL }
  | { ok: false; code: EndpointRejectCode; message: string };

export type EndpointRejectCode =
  | "MALFORMED_URL"
  | "NON_HTTP"
  | "HAS_CREDENTIALS"
  | "NON_LOOPBACK_HOST";

/**
 * The loopback hosts we accept, post-normalization. The WHATWG URL parser
 * returns IPv6 hostnames **bracketed and lowercased** (`new URL("http://[::1]")`
 * → hostname `"[::1]"`), and IPv4 alternate encodings (`127.1`, `2130706433`,
 * `0177.0.0.1`) all normalize to `127.0.0.1`, so a literal compare against this
 * set after bracket-strip + lowercase covers the real cases. `0.0.0.0`
 * (all-interfaces) and any IPv4-mapped form (`[::ffff:7f00:1]`) are deliberately
 * NOT here — they're rejected, matching the strict `LoopbackUrl` posture.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);

const REJECT_MESSAGE =
  "Local-model endpoint must be a loopback http URL (http://127.0.0.1:PORT, http://localhost:PORT, or http://[::1]:PORT). Remote endpoints are not supported in this version.";

/**
 * Validate a user-supplied local-model endpoint to the loopback-only posture.
 * Pure + synchronous. The server relies only on its own calls, at resolve and
 * again at fetch. The add-model window also calls it, to decide whether its own
 * Save is live; the server never trusts that.
 */
export function validateEndpoint(endpoint: string): EndpointValidation {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, code: "MALFORMED_URL", message: REJECT_MESSAGE };
  }
  if (url.protocol !== "http:") {
    return { ok: false, code: "NON_HTTP", message: REJECT_MESSAGE };
  }
  // Userinfo bypass guard (http://evil.com@127.0.0.1/).
  if (url.username !== "" || url.password !== "") {
    return { ok: false, code: "HAS_CREDENTIALS", message: REJECT_MESSAGE };
  }
  // Strip the IPv6 brackets the parser adds, lowercase, then compare to the
  // explicit set. `[0:0:0:0:0:0:0:1]` normalizes to `[::1]` → `::1` (accepted);
  // `[::ffff:127.0.0.1]` normalizes to `[::ffff:7f00:1]` → not in set (rejected).
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    return { ok: false, code: "NON_LOOPBACK_HOST", message: REJECT_MESSAGE };
  }
  return { ok: true, url };
}
