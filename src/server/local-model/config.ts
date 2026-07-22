/**
 * Local-model connection config + endpoint validation (#1123 M1, ADR-039).
 *
 * The endpoint is USER-SUPPLIED (a local Ollama / LM Studio / llama.cpp URL),
 * so it's the outbound-SSRF surface the v1.0 RC security gate covers. ADR-039
 * resolves this to **loopback-only** for v1.0 (LAN-with-opt-in is a separate
 * gated decision). This mirrors the hardened `LoopbackUrl` precedent in
 * `integrations/schema.ts`, extended (D2, Bryan 2026-06-19) to also accept
 * `localhost` and `[::1]` for Ollama/LM-Studio UX — by STRING match against an
 * explicit set, never DNS resolution. Not resolving is the anti-rebinding
 * property: a poisoned `localhost`→public-IP can't widen the allowlist because
 * we compare the literal hostname the URL parser produced, not a resolved IP.
 */

import type { AgentIdentity } from "../../shared/types.js";

export type LocalModelTransport = "v1" | "native";

export interface LocalModelConfig {
  /** Loopback http URL of the model server, e.g. http://127.0.0.1:11434 */
  endpoint: string;
  /** Provider model id, e.g. "qwen2.5:14b-instruct" */
  modelId: string;
  /** Wire transport — OpenAI-compatible `/v1` or Ollama-native `/api/chat`. */
  transport: LocalModelTransport;
  /**
   * The authoring agent's identity (#1123 M3) — the registry entry's provider +
   * display name, built ONCE by the resolver (which previously read and
   * discarded these). Threaded whole to the two write paths that stamp the
   * byline: the tool dispatch (annotations/replies, via loop.ts) and the chat
   * streaming sink (via collaborator.ts). A prebuilt snapshot, so it freezes who
   * authored at the time and never re-bundles the same fields downstream.
   */
  agentIdentity: AgentIdentity;
}

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
 * Pure + synchronous; reused at config-write time AND re-run at fetch time
 * (validate-at-use) so a config relocated server-side (M1a) can't drift the
 * value past this check (TOCTOU defense, mirroring the integrations `apply`
 * safeParse re-check).
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
