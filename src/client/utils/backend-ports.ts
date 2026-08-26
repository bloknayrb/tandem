/// <reference types="vite/client" />
// ^ This file reads `import.meta.env`, so it declares the types for it rather
// than inheriting them from whichever sibling happens to share its program.
// Until the test tree gained tsconfigs, the only programs containing this file
// were the root one and `tsconfig.client.json` (which `svelte-check` runs), and
// both also contain `hooks/useTauriTheme.svelte.ts` and its identical
// reference -- so this file typechecked on a neighbour's declaration. Those two
// are the only such references in `src/`.
// Any narrower program (a test config that pulls it in transitively) got
// `Property 'env' does not exist on type 'ImportMeta'` instead.

import { DEFAULT_MCP_PORT, DEFAULT_WS_PORT } from "../../shared/constants";

/**
 * The client's backend ports, resolved once at module load (#1492).
 *
 * The server has honoured `TANDEM_PORT`/`TANDEM_MCP_PORT` forever, but the
 * browser client baked `DEFAULT_*` into literal URLs at build time, so no test
 * harness could move its backend without stranding the client it serves — and
 * every harness therefore ran on the product ports, colliding with the user's
 * real Tandem (#1483). This module is the client half of the fix: every
 * client→backend URL derives from here, and here alone.
 *
 * `VITE_TANDEM_MCP_PORT` / `VITE_TANDEM_WS_PORT` are read via
 * `import.meta.env`, which Vite substitutes statically — at transform time in
 * dev, at build time for `vite build`. **Production is byte-identical in
 * effect:** with the vars unset (every non-harness build and every dev serve),
 * the substitution yields `undefined`, `resolvePort` falls back to
 * `DEFAULT_*`, and the URLs come out exactly as the old literals did. Only the
 * Playwright harnesses set these vars (`playwright.config.ts`,
 * `scripts/perf-build.ts`), sourced from `scripts/test-ports.ts`.
 *
 * Access the full dotted form only (`import.meta.env.VITE_X`) — optional
 * chaining or destructuring would defeat Vite's static replacement.
 */
function resolvePort(raw: unknown, fallback: number): number {
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw)) return fallback;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : fallback;
}

export const MCP_PORT = resolvePort(import.meta.env.VITE_TANDEM_MCP_PORT, DEFAULT_MCP_PORT);
export const WS_PORT = resolvePort(import.meta.env.VITE_TANDEM_WS_PORT, DEFAULT_WS_PORT);

/** Base origin for every `/api`, `/mcp` and SSE fetch. */
export const MCP_BASE_URL = `http://127.0.0.1:${MCP_PORT}`;

/** Hocuspocus WebSocket endpoint. */
export const WS_URL = `ws://127.0.0.1:${WS_PORT}`;

declare global {
  interface Window {
    /** Which backend this served client actually targets. Read by the perf harness before any destructive step — a stale build baked to the wrong pair must fail loudly, not drive a real Tandem through the UI. */
    __TANDEM_PORTS__?: { ws: number; mcp: number };
  }
}

// `typeof window` guard: node-environment vitest imports this module too.
if (typeof window !== "undefined") {
  window.__TANDEM_PORTS__ = { ws: WS_PORT, mcp: MCP_PORT };
}
