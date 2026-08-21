/**
 * Reserved backend/client ports for the repo's test harnesses (#1492).
 *
 * One home on purpose: the Playwright configs, the e2e guard, the specs that
 * hit `/api` directly, the perf build wrapper and the wiring test all need the
 * same numbers, and a drifted copy is exactly the desynchronization
 * `tests/scripts/e2e-guard-wiring.test.ts` exists to fail.
 *
 * Every number here is chosen, not arbitrary — the harness's own server boot
 * calls `freePort()` (SIGKILL) on whatever holds its pair, and Playwright
 * never probes the WS port at all, so a collision is not an error message, it
 * is a killed process. The constraints:
 *
 * - **Never the product pair (3478/3479) or dev Vite (5173).** Removing that
 *   collision is the whole point of #1492/#1483.
 * - **Never 4478/4479.** `docs/troubleshooting.md` ("Port already in use")
 *   tells users to move their REAL Tandem to exactly that pair — a harness
 *   there would SIGKILL the relocated desktop app of anyone who followed the
 *   product's own advice. The wiring test pins troubleshooting.md against
 *   every constant in this file so the collision cannot silently return.
 * - **Never 5174** — Vite's auto-increment parks a second `npm run dev` there.
 * - **E2E and perf get separate pairs**, so a stale server left by one harness
 *   can never answer the other's identity probe.
 * - No other in-repo port usage and no user-facing doc names these numbers
 *   (verified by grep at introduction; the wiring test keeps the doc half true).
 *
 * The perf *preview* (client) port, 4318, predates this file and stays defined
 * in `tests/perf/playwright.config.ts` (`PREVIEW_PORT`).
 */

/** Vite dev server for the E2E suite. Deliberately not 5173/5174 — a developer's `npm run dev` must never be adopted, nor its auto-increment neighbour. */
export const E2E_VITE_PORT = 4573;

/** Hocuspocus (ws) port for the E2E backend. x8/x9 pairing mirrors the product's 3478/3479. */
export const E2E_WS_PORT = 4728;

/** MCP HTTP port for the E2E backend — the port `scripts/e2e-guard.ts` probes. */
export const E2E_MCP_PORT = 4729;

/** Hocuspocus (ws) port for the perf-gate backend. */
export const PERF_WS_PORT = 4378;

/** MCP HTTP port for the perf-gate backend. */
export const PERF_MCP_PORT = 4379;
