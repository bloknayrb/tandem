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
 * `assertNoBroadAce` has two production callers outside acl-win:
 * install-claude-cli, tested with injected deps, and the launcher's run files
 * (`realRunFileAcl.verifyNoBroadAce` in `src/server/launcher/run-files.ts`,
 * the per-file check), which the spawn specs replace with an injected
 * `runFileAcl` or reach for real only on Windows. Under this mock
 * `realRunFileAcl.lockDir` is a no-op, so on Windows the folder's check
 * (whose only ACL read is inside `setRestrictiveAcl`, #2440) passes
 * unverified here; the folder's verification is proved by the real-ACL
 * `run-files-acl-win.test.ts`.
 *
 * Opting out: a spec that needs real ACLs is listed in
 * `scripts/ci/windows-acl-proof.mjs` with `realAcl: true`, calls
 * `vi.unmock(import(".../acl-win.js"))`, and has a test titled
 * `uses the real acl-win module` that compares the import with
 * `vi.importActual`. For a spec marked `realAcl: true`,
 * `tests/scripts/windows-acl-proof-wiring.test.ts` enforces all three and the
 * `windows-acl-proof` CI job requires that test to pass; whether a spec is
 * marked at all is reviewed by hand via its `realAclReason`. A file's own
 * `vi.mock` of acl-win overrides this one (measured on vitest 5.0.5 and 5.1.0).
 *
 * Setup files must not import modules from `src/`: one evaluated here would
 * bind the mocked acl-win before a spec's `vi.unmock` runs, and the spec's
 * identity test, which checks only its own import, would still pass.
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
