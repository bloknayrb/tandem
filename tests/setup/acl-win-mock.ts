/**
 * #2390 — `setRestrictiveAcl` is mocked for every test file, in both vitest
 * projects.
 *
 * Why: `ensurePrivateStoreDir` (src/server/file-io/private-dir.ts) starts
 * `applyPrivateDirAcl` without awaiting it, and on Windows that spawns
 * `icacls`. Under full-suite load the spawn can still hold a fresh store
 * directory when the test's teardown deletes it, so `rmdir` fails `EBUSY`.
 * Each failing test passes alone. ~57 files use the stores and their
 * teardowns differ, so one mock here replaces per-file fixes that never
 * converged. On POSIX the real function is already a no-op.
 *
 * Only `setRestrictiveAcl` is replaced; the rest of the module is real.
 * `assertNoBroadAce`'s one production caller outside acl-win
 * (install-claude-cli) is tested with injected deps.
 *
 * Opting out: a spec that needs real ACLs is listed in
 * `scripts/ci/windows-acl-proof.mjs` with `realAcl: true`, calls
 * `vi.unmock(import(".../acl-win.js"))`, and has a test titled
 * `uses the real acl-win module` that compares the import with
 * `vi.importActual`. `tests/scripts/windows-acl-proof-wiring.test.ts` enforces
 * all three, and the `windows-acl-proof` CI job requires that test to pass.
 * A file's own `vi.mock` of acl-win overrides this one (measured on vitest
 * 5.0.5, 2026-11-08).
 *
 * Not covered: child processes a test starts (a real server, the stdio
 * bridge, the monitor CLI) load the real module and run real icacls in their
 * own app-data dir. Those tests keep deleting with `fs.rm(..., { maxRetries })`.
 *
 * This relies on vitest's default per-file isolation; the wiring test fails if
 * `isolate: false` appears in vitest.config.ts or a package.json script.
 */
import { vi } from "vitest";

vi.mock(import("../../src/server/integrations/acl-win.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));
