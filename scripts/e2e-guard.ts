import path from "node:path";
import { API_INFO } from "../src/shared/api-paths";
import { DEFAULT_MCP_PORT } from "../src/shared/constants";
import { E2E_APP_DATA_DIR } from "./e2e-paths";

/**
 * Does `storagePath` sit inside {@link E2E_APP_DATA_DIR}?
 *
 * Containment, not equality: `/api/info` reports `SESSION_DIR`, which is
 * `path.join(APP_DATA_DIR, "sessions")` (`src/server/platform.ts:30`) — a
 * subdirectory of the dir the config sets, so an equality check would call our
 * own server foreign and fail every run.
 *
 * Containment also survives `SESSION_DIR` moving deeper (say to
 * `<app-data>/state/sessions`). What it does not survive is the field being
 * renamed, removed, or scrubbed out of the loopback block — and in each of
 * those cases every run, including a clean one, refuses with a message naming
 * the path it got. Loud and total beats silent and partial for a guard.
 */
export function isE2EStoragePath(storagePath: unknown): boolean {
  if (typeof storagePath !== "string" || storagePath.length === 0) return false;
  const rel = path.relative(path.resolve(E2E_APP_DATA_DIR), path.resolve(storagePath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Ask whatever holds `port` whether it is an E2E server. Returns the offending
 * storage path when it is not, or `null` when the port is clear.
 *
 * **Fail-closed on purpose.** Any answer we cannot positively identify as ours
 * — non-2xx, unparseable body, absent `storagePath` — counts as foreign. A
 * false "foreign" costs a developer one error message; a false "clear" costs
 * them their documents, which is the whole reason this exists (#1483).
 */
async function probeForeignServer(port: number): Promise<string | null> {
  let body: unknown;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${API_INFO}`, {
      signal: AbortSignal.timeout(2_000),
    });
    // A non-2xx from *something* still means something holds the port, and we
    // have no evidence it is ours.
    if (!res.ok) return `(HTTP ${res.status})`;
    body = await res.json();
  } catch {
    // Nothing answered. On the ordering described below this is nearly
    // unreachable — by the time we run, Playwright has already started (or
    // adopted) a server and health-checked it, so a dead port means that server
    // died in the gap, and Playwright's own health check will have failed
    // first. Treated as clear because there is nothing here to protect.
    return null;
  }

  const reported = (body as { storagePath?: unknown }).storagePath;
  if (isE2EStoragePath(reported)) return null;
  return typeof reported === "string" ? reported : "(not reported)";
}

/** The refusal text. Separate so a test can assert on it without a live port. */
export function foreignServerMessage(storagePath: string, port: number): string {
  return [
    "Refusing to run E2E against a server this suite did not start.",
    "",
    `Something is already listening on 127.0.0.1:${port}, and its storage`,
    "directory is not the isolated E2E one:",
    "",
    `  reported:  ${storagePath}`,
    `  expected:  inside ${E2E_APP_DATA_DIR}`,
    "",
    'That is almost always the Tandem desktop app, or a "npm run dev:server".',
    "Playwright's reuseExistingServer ADOPTS it rather than failing, and the",
    "suite would then run tandem_open, tandem_close, DELETE /api/chat and every",
    "typing and annotation test against your real documents and real app-data —",
    "with no per-run wipe, because scripts/e2e-server.mjs never runs on that",
    "branch.",
    "",
    "Quit Tandem (or stop the dev server) and run E2E again.",
  ].join("\n");
}

/**
 * Playwright `globalSetup` (#1483).
 *
 * **This is a post-flight, not a preflight, and that is a Playwright fact
 * rather than a choice.** `createGlobalSetupTasks`
 * (`node_modules/playwright/lib/runner/tasks.js:100-107`) pushes
 * `createPluginSetupTasks` — start and health-check every `webServer` — ahead
 * of `config.globalSetups`. The same ordering is documented from the other side
 * in `tests/perf/global-setup.ts:10-19`, where a wipe that believed it ran
 * first never did.
 *
 * So by the time this runs, `reuseExistingServer: !CI` has **already** adopted
 * whatever answered the port. The safety property is narrower than "prevent
 * adoption" and is still sufficient: the destructive half is test *execution*,
 * and throwing here aborts before the first spec. Nothing has touched a
 * document yet.
 *
 * **Why `globalSetup` rather than an npm-script preflight.** A wrapper on
 * `test:e2e` would run genuinely first and make the reasoning simpler — but it
 * is bypassed by `playwright test` directly, which is exactly how someone
 * iterating skips a rebuild (`tests/perf/playwright.config.ts:111-115` records
 * that habit as real). `globalSetup` travels with the config and cannot be
 * skipped. Un-bypassability is worth more here than tidy ordering.
 *
 * **Why reuse stays enabled** on the backend entry: flipping it to `false`
 * makes Playwright start its own server, whose boot calls `freePort`
 * (`src/server/index.ts:588-589`) — which would terminate the user's desktop
 * Tandem, silently, since it is best-effort and swallows its errors. That
 * trades "runs against your documents" for "kills your app", which is a lateral
 * move rather than a fix.
 *
 * **The deeper fix this defers** is giving the E2E backend its own port so a
 * collision is impossible by construction — the shape `tests/perf` already
 * chose for Vite (`playwright.config.ts:70`). It stops at the backend for a
 * real reason: the browser client bakes `DEFAULT_MCP_PORT`/`DEFAULT_WS_PORT` in
 * at build time across ~8 call sites, so the client's origin has to become
 * runtime-configurable first. Tracked in #1492, which would retire this guard,
 * the perf harness's freePort-kills-your-Tandem cost, and the screenshot
 * pipeline's unenforceable port precondition together.
 */
export default async function globalSetup(): Promise<void> {
  const foreign = await probeForeignServer(DEFAULT_MCP_PORT);
  if (foreign !== null) {
    throw new Error(foreignServerMessage(foreign, DEFAULT_MCP_PORT));
  }
}
