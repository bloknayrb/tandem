/**
 * Zod schema for the server-side Models registry file (`models.json`, #1123 M1a).
 *
 * Runtime source of truth for the shape declared in
 * `src/shared/models/contract.ts`. Every record is `.strict()` — a body
 * carrying an unexpected key (most importantly a plaintext `apiKey` or the
 * client-transient `_legacyApiKey`) is REJECTED, not silently stripped. That
 * loud rejection is the enforcement point for "no new plaintext-secret surface":
 * only `apiKeyRef` (an opaque keychain handle) is ever persisted.
 */

import { z } from "zod";
import {
  MODELS_ENTRY_MAX,
  MODELS_SCHEMA_VERSION,
  type ModelProvider,
  type ModelsFile,
  VALID_MODEL_PROVIDERS,
} from "../../shared/models/contract.js";

// Cast preserves the literal `ModelProvider` union (a bare `[string, ...]` cast
// would widen `provider` to `string` and break assignability to `ModelsFile`).
const ProviderSchema = z.enum(
  VALID_MODEL_PROVIDERS as unknown as [ModelProvider, ...ModelProvider[]],
);

/** Opaque keychain ref: base64url, ≤64. Matches the client + secrets-route shape. */
const ApiKeyRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Param values are primitives only (the client persists numbers/strings/bools).
 * Kept permissive on value type; `.strict()` on the entry blocks unknown keys.
 */
const ParamsSchema = z.record(z.union([z.number(), z.string(), z.boolean()]));

export const ModelsEntrySchema = z
  .object({
    id: z.string().min(1),
    provider: ProviderSchema,
    displayName: z.string(),
    modelId: z.string(),
    apiKeyRef: ApiKeyRef.optional(),
    // Endpoint is stored verbatim; loopback enforcement happens at resolve +
    // fetch time (`validateEndpoint`), so a non-loopback value here just makes
    // the entry inert rather than rejecting the whole file.
    endpoint: z.string().optional(),
    enabled: z.boolean(),
    params: ParamsSchema.optional(),
  })
  .strict();

export const ModelsFileSchema = z
  .object({
    schemaVersion: z.literal(MODELS_SCHEMA_VERSION),
    models: z.array(ModelsEntrySchema).max(MODELS_ENTRY_MAX),
    defaultModelId: z.string().min(1).nullable(),
  })
  .strict();

export function emptyModelsFile(): ModelsFile {
  return { schemaVersion: MODELS_SCHEMA_VERSION, models: [], defaultModelId: null };
}
