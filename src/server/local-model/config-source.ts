/**
 * Local-model config resolution (#1123 M1.2, ADR-039).
 *
 * D-C (Bryan, 2026-06-19): M1.2 deliberately does NOT ship an env-var config
 * path. The real config store is M1a's job (relocate the model registry so the
 * server resolves {endpoint, modelId, transport} without a browser session).
 * Until M1a lands, this is a STUB returning `null` → the collaborator is inert
 * in production (no endpoint → no loop → no `createAnnotation`/review-pending).
 *
 * The collaborator takes this resolver as an injectable seam (defaulting to this
 * function), so tests + the dogfood inject a real `LocalModelConfig`, and M1a
 * swaps ONLY this file's body — no collaborator change. The engine's fetch-time
 * `validateEndpoint` (validate-at-use) backstops any injected value.
 */
import type { LocalModelConfig } from "./config.js";

export function resolveLocalModelConfig(): LocalModelConfig | null {
  // TODO(M1a): read the server-side model registry and return the configured
  // local-model {endpoint, modelId, transport}. No env-var stopgap (see D-C) —
  // returning null keeps the feature inert until the real source exists.
  return null;
}
