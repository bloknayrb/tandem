/**
 * Tandem `IntegrationConfig` schema.
 *
 * Tandem's integration contract is MCP. Claude (Claude Code + Claude Desktop)
 * is the default integration. See
 * [ADR-038](../../../docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)
 * for the four-term glossary and the canonical policy statement.
 *
 * **Versions:**
 * - v1 (#477 PR 1): `claude-code` + `claude-desktop` kinds, no `tokenSecretRef`.
 * - v2 (#477 PR 3b): adds optional `tokenSecretRef` on every variant; adds
 *   `other-mcp` kind for generic MCP-capable clients (Cursor, Continue.dev,
 *   LM Studio, Ollama, etc.).
 * - v3 (#477 PR 3c-ii-b): adds optional `apply: "create" | "update" | "skip"`
 *   on every variant (constrained to `"skip"` on `other-mcp`). The apply
 *   endpoint (`POST /api/integrations/apply`) iterates entries whose
 *   `apply !== "skip"` and writes them to Claude's config — separates intent
 *   (persist) from side-effect (apply) per ADR-038 §2b adversarial review.
 *
 * `tokenSecretRef` is an opaque pointer into the OS keychain — never a
 * secret value. The keychain backend lives in `./keychain.ts`. Future
 * versions bump `INTEGRATIONS_SCHEMA_VERSION` and add a migration in
 * `./migrations.ts`.
 */

import path from "node:path";
import { z } from "zod";

import { INTEGRATIONS_SCHEMA_VERSION as SHARED_SCHEMA_VERSION } from "../../shared/integrations/contract.js";

export { INTEGRATIONS_SCHEMA_VERSION } from "../../shared/integrations/contract.js";

const AbsolutePath = z.string().min(1).refine(path.isAbsolute, {
  message: "configPath must be an absolute path",
});

/**
 * Tandem's MCP HTTP endpoint is always loopback by design — the server
 * binds to `127.0.0.1` by default, and LAN binding (`TANDEM_BIND_HOST`)
 * still leaves Claude / other MCP clients connecting to a loopback URL
 * because they share the host. There is no legitimate Tandem integration
 * whose `url` field points to a remote host. Constraining `url` to
 * loopback prevents a maliciously planted `~/.claude.json` entry
 * (`url: "http://evil.example/mcp"`) from being preserved into Tandem's
 * `integrations.json` via the wizard's "already configured" path.
 *
 * Accepts `http://127.0.0.1[:port][/path]` or `http://localhost[:port][/path]`.
 * Rejects: non-`http` schemes, any other hostname, IP-literal forms other
 * than `127.0.0.1` (which would also be loopback but are not used by Tandem
 * and add attack surface — `127.0.0.2` etc. are valid loopback addresses
 * but reaching them implies someone configured an alternate bind).
 */
export const LoopbackUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      if (parsed.protocol !== "http:") return false;
      // Reject URLs with embedded credentials (userinfo bypass: http://evil.com@127.0.0.1/)
      if (parsed.username !== "" || parsed.password !== "") return false;
      return parsed.hostname === "127.0.0.1";
    },
    {
      message:
        "url must be an http loopback URL (http://127.0.0.1) — Tandem's MCP endpoint is always loopback",
    },
  );

/**
 * v3 `apply` intent. Constrained to `"skip"` on `other-mcp` (apply endpoint
 * cannot write arbitrary third-party MCP configs); free `"create" | "update"
 * | "skip"` on `claude-code` / `claude-desktop`.
 *
 * `"update"` is reserved for a planned diff-confirmation UX (wizard previews
 * the merged config before commit). Today the apply handler treats `"update"`
 * identically to `"create"`. Don't remove it as apparently-dead — the schema
 * would have to bump to add it back when the UX ships.
 */
const ApplyIntent = z.enum(["create", "update", "skip"]);

/**
 * Shared base fields lifted into a Zod object so each variant `.merge`s
 * them in. Pre-v3 the schema duplicated these — v3's `apply` addition was
 * the right moment to factor them out per architectural review.
 */
const BaseIntegrationFields = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  tokenSecretRef: z.string().min(1).optional(),
});

const ClaudeCodeIntegration = BaseIntegrationFields.extend({
  kind: z.literal("claude-code"),
  configPath: AbsolutePath,
  transport: z.literal("http"),
  url: LoopbackUrl,
  apply: ApplyIntent.optional(),
});

const ClaudeDesktopIntegration = BaseIntegrationFields.extend({
  kind: z.literal("claude-desktop"),
  configPath: AbsolutePath,
  transport: z.literal("stdio"),
  nodeBinary: z.string().min(1).optional(),
  apply: ApplyIntent.optional(),
});

/**
 * Generic MCP-capable client (Cursor, Continue.dev, LM Studio, Ollama, etc.).
 * Tandem doesn't auto-configure these — the user wires their client to
 * Tandem's MCP HTTP endpoint or stdio channel shim manually. The record
 * exists so the wizard can surface them in the integrations list and
 * associate an auth token with the client.
 *
 * `url` is the Tandem endpoint the client will connect to; defaults to
 * `http://127.0.0.1:3479` when omitted. `configPath` is optional because
 * many MCP clients have no canonical config file location Tandem can
 * detect.
 *
 * `apply` is constrained to `"skip"` — the apply endpoint refuses to
 * touch third-party MCP configs (we'd have to know each client's config
 * format). The schema-level restriction means a hand-edited
 * `integrations.json` setting `apply: "create"` on an `other-mcp` entry
 * is rejected at parse time, not silently no-op'd at runtime.
 */
const OtherMcpIntegration = BaseIntegrationFields.extend({
  kind: z.literal("other-mcp"),
  transport: z.union([z.literal("http"), z.literal("stdio")]),
  url: LoopbackUrl.optional(),
  configPath: AbsolutePath.optional(),
  apply: z.literal("skip").optional(),
});

/**
 * `discriminatedUnion` members must be plain `ZodObject`s, so the
 * cross-field invariant ("`transport: http` requires `url`") is applied
 * via `superRefine` on the union itself. The wizard (PR 3c) could in
 * principle default `url` to `http://127.0.0.1:3479` for `other-mcp`,
 * but enforcing at the schema boundary prevents every downstream
 * consumer from having to defend against a missing `url` on an
 * http-transport integration.
 */
export const IntegrationConfigSchema = z
  .discriminatedUnion("kind", [
    ClaudeCodeIntegration,
    ClaudeDesktopIntegration,
    OtherMcpIntegration,
  ])
  .superRefine((val, ctx) => {
    if (val.kind === "other-mcp" && val.transport === "http") {
      if (val.url === undefined || val.url.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "url is required when transport is http",
        });
      }
    }
  });

export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;

export const IntegrationsFileSchema = z.object({
  schemaVersion: z.literal(SHARED_SCHEMA_VERSION),
  integrations: z.array(IntegrationConfigSchema),
  defaultIntegrationId: z.string().min(1).optional(),
});

export type IntegrationsFile = z.infer<typeof IntegrationsFileSchema>;

export function emptyIntegrationsFile(): IntegrationsFile {
  return {
    schemaVersion: SHARED_SCHEMA_VERSION,
    integrations: [],
  };
}

/**
 * v1 input shape for the v1→v2 migration. Exported solely so `migrations.ts`
 * can validate untrusted on-disk v1 input. v1 differs from v2 only in:
 * - `INTEGRATIONS_SCHEMA_VERSION === 1`
 * - No `tokenSecretRef` on any kind
 * - No `other-mcp` variant in the union
 *
 * **`.strict()` on every record:** a hand-edited v1 file containing a
 * field that does not exist in v1's union (most notably `tokenSecretRef`,
 * which only exists in v2) is rejected outright rather than silently
 * stripped. This keeps the migration's "v1 records are valid v2 records"
 * invariant honest — if extra v2-only data appears on a v1 record, the
 * file is corrupt and should fail loudly rather than propagate truncated
 * records into v2.
 */
const ClaudeCodeIntegrationV1 = z
  .object({
    kind: z.literal("claude-code"),
    id: z.string().min(1),
    label: z.string().min(1),
    configPath: AbsolutePath,
    transport: z.literal("http"),
    url: LoopbackUrl,
  })
  .strict();

const ClaudeDesktopIntegrationV1 = z
  .object({
    kind: z.literal("claude-desktop"),
    id: z.string().min(1),
    label: z.string().min(1),
    configPath: AbsolutePath,
    transport: z.literal("stdio"),
    nodeBinary: z.string().min(1).optional(),
  })
  .strict();

export const IntegrationsFileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    integrations: z.array(
      z.discriminatedUnion("kind", [ClaudeCodeIntegrationV1, ClaudeDesktopIntegrationV1]),
    ),
    defaultIntegrationId: z.string().min(1).optional(),
  })
  .strict();

/**
 * v2 input shape for the v2→v3 migration. v2 differs from v3 in: no `apply`
 * field on any variant. `.strict()` mirrors the v1 schema's invariant — a v2
 * file containing v3-only fields is rejected (forces an explicit migration
 * rather than silent merge).
 */
const ClaudeCodeIntegrationV2 = z
  .object({
    kind: z.literal("claude-code"),
    id: z.string().min(1),
    label: z.string().min(1),
    configPath: AbsolutePath,
    transport: z.literal("http"),
    url: LoopbackUrl,
    tokenSecretRef: z.string().min(1).optional(),
  })
  .strict();

const ClaudeDesktopIntegrationV2 = z
  .object({
    kind: z.literal("claude-desktop"),
    id: z.string().min(1),
    label: z.string().min(1),
    configPath: AbsolutePath,
    transport: z.literal("stdio"),
    nodeBinary: z.string().min(1).optional(),
    tokenSecretRef: z.string().min(1).optional(),
  })
  .strict();

const OtherMcpIntegrationV2 = z
  .object({
    kind: z.literal("other-mcp"),
    id: z.string().min(1),
    label: z.string().min(1),
    transport: z.union([z.literal("http"), z.literal("stdio")]),
    url: LoopbackUrl.optional(),
    configPath: AbsolutePath.optional(),
    tokenSecretRef: z.string().min(1).optional(),
  })
  .strict();

export const IntegrationsFileV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    integrations: z.array(
      z.discriminatedUnion("kind", [
        ClaudeCodeIntegrationV2,
        ClaudeDesktopIntegrationV2,
        OtherMcpIntegrationV2,
      ]),
    ),
    defaultIntegrationId: z.string().min(1).optional(),
  })
  .strict();
