/**
 * #2422 — `loopbackFetch` delegates to the global `fetch` in every test file.
 *
 * Production sends a request to `127.0.0.1` / `[::1]` through undici's own
 * `fetch` so that Node's environment proxy cannot carry it
 * (`src/shared/loopback-fetch.ts`). A suite that stands in for the server with
 * `vi.stubGlobal("fetch", …)` would then bypass its stub and reach the real
 * network, so the suites that predate #2422 would all need rewriting. This
 * mock keeps them as they were: with it, the two stubs agree.
 *
 * What it costs: no spec in this run exercises the real routing. That is
 * covered by `tests/shared/loopback-fetch.test.ts` (which calls
 * `vi.unmock`) and by `tests/cli/loopback-no-proxy.test.ts` (real programs in
 * their own processes, which this mock cannot reach).
 *
 * Setup files must not import modules from `src/` (see acl-win-mock.ts): the
 * path is only named, never imported, here.
 */
import { vi } from "vitest";

vi.mock(import("../../src/shared/loopback-fetch.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  loopbackFetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch,
}));
