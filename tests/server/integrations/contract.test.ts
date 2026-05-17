import { describe, expectTypeOf, it } from "vitest";
import type { ExistingMcpInstall } from "../../../src/server/integrations/existing-config.js";
import type {
  IntegrationConfig,
  IntegrationsFile,
} from "../../../src/server/integrations/schema.js";
import type {
  ExistingMcpInstall as SharedExistingMcpInstall,
  IntegrationConfig as SharedIntegrationConfig,
  IntegrationsFile as SharedIntegrationsFile,
} from "../../../src/shared/integrations/contract.js";

/**
 * Compile-time guard that the server's Zod-derived types remain assignable
 * to the shared wire-contract types (`src/shared/integrations/contract.ts`).
 *
 * The shared types are imported by the client (which can't import the Zod
 * schema because it transitively pulls in Node's `path` module via the
 * `AbsolutePath` refine). If either side drifts — server adds a field, or
 * shared contract adds a field the server doesn't produce — this test
 * fails at typecheck time.
 *
 * Note: `expectTypeOf<A>().toEqualTypeOf<B>()` is stricter than necessary
 * for one-way wire-compat. We use `toMatchTypeOf` (server → shared, since
 * the server is the wire producer) so server-only fields (e.g. branded
 * Zod internals like `_input`/`_output`) don't trip the check.
 */
describe("integrations contract conformance", () => {
  it("server IntegrationConfig matches shared IntegrationConfig", () => {
    expectTypeOf<IntegrationConfig>().toMatchTypeOf<SharedIntegrationConfig>();
  });

  it("server IntegrationsFile matches shared IntegrationsFile", () => {
    expectTypeOf<IntegrationsFile>().toMatchTypeOf<SharedIntegrationsFile>();
  });

  it("server ExistingMcpInstall matches shared ExistingMcpInstall", () => {
    expectTypeOf<ExistingMcpInstall>().toMatchTypeOf<SharedExistingMcpInstall>();
  });
});
