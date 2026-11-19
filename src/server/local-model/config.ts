/**
 * Local-model connection config + endpoint validation (#1123 M1, ADR-039).
 *
 * The endpoint is USER-SUPPLIED (a local Ollama / LM Studio / llama.cpp URL),
 * so it's the outbound-SSRF surface the v1.0 RC security gate covers. ADR-039
 * resolves this to **loopback-only** for v1.0 (LAN-with-opt-in is a separate
 * gated decision). This mirrors the hardened `LoopbackUrl` precedent in
 * `integrations/schema.ts`, extended (D2, Bryan 2026-06-19) to also accept
 * `localhost` and `[::1]` for Ollama/LM-Studio UX — by STRING match against an
 * explicit set, never DNS resolution.
 *
 * What actually protects the two IP literals is that there is nothing to
 * resolve. Declining to resolve is NOT itself the anti-rebinding property
 * (#1295 L4): comparing a literal name and then letting `fetch` resolve that
 * same name is validate-by-name-then-connect-by-name, which is the shape that
 * rebinds. `localhost` was the one entry exposed to it. The client closes that
 * gap by substituting `127.0.0.1` for a validated `localhost` before issuing
 * the request (see `baseUrl` in `ollama-client.ts`), so the checked value and
 * the connected value are the same address.
 *
 * The rule itself (`validateEndpoint`) lives in
 * `src/shared/models/local-endpoint.ts`, so the add-model window can call the
 * same function; this module re-exports it.
 */

import type { AgentIdentity } from "../../shared/types.js";

export {
  type EndpointRejectCode,
  type EndpointValidation,
  validateEndpoint,
} from "../../shared/models/local-endpoint.js";

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
