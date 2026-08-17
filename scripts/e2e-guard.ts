import path from "node:path";
import { API_INFO } from "../src/shared/api-paths";
import { DEFAULT_MCP_PORT } from "../src/shared/constants";
import { E2E_APP_DATA_DIR } from "./e2e-paths";

/**
 * How long to wait for `/api/info`. Generous on purpose: under the fail-closed
 * rule below, a timeout is a *refusal*, so a tight bound turns a merely loaded
 * machine into a failed run. Five seconds against a server Playwright has
 * already health-checked is slack, not patience.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Is `candidate` `root` itself, or inside it?
 *
 * `pathImpl` is a test-only seam, and it exists because the two platform
 * flavours disagree in a way that decides this function:
 * `path.win32.relative` across **drives** returns an absolute path (`D:\x`),
 * which `startsWith("..")` does not catch — so `!isAbsolute(rel)` is the only
 * clause standing between the guard and accepting `D:\anything`. On posix that
 * clause is unreachable (`relative` there is always relative). Without the seam
 * the load-bearing half is untested on whichever platform you happen to run,
 * and it is the posix half CI runs.
 *
 * `root` itself passes as the `rel === ""` case: the empty string neither
 * starts with `..` nor is absolute. `relative` resolves both arguments itself,
 * so there is no `resolve` call here to add.
 */
export function isContainedIn(
  root: string,
  candidate: string,
  pathImpl: Pick<typeof path, "relative" | "isAbsolute"> = path,
): boolean {
  const rel = pathImpl.relative(root, candidate);
  return !rel.startsWith("..") && !pathImpl.isAbsolute(rel);
}

/**
 * Does `storagePath` sit inside {@link E2E_APP_DATA_DIR}?
 *
 * Containment, not equality: `/api/info` reports `SESSION_DIR`, which is
 * `path.join(APP_DATA_DIR, "sessions")` (`src/server/platform.ts:31`) — a
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
  return isContainedIn(E2E_APP_DATA_DIR, storagePath);
}

/**
 * Is this the one failure that genuinely means *nothing is listening*?
 *
 * Deliberately narrow, because it is the sole exit from fail-closed. Node's
 * fetch reports socket errors as `TypeError: fetch failed` with the errno on
 * `.cause`; `AggregateError` appears when several addresses are tried. Every
 * other failure — a timeout, a reset, a TLS mismatch — means something DID
 * accept the connection and we then failed to read it, which is exactly the
 * case that must refuse. An unrecognised error therefore refuses too.
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isConnectionRefused(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown } | null)?.cause].flatMap((e) =>
    e instanceof AggregateError ? e.errors : [e],
  );
  return candidates.some((e) => (e as { code?: unknown } | null)?.code === "ECONNREFUSED");
}

/**
 * Ask whatever holds `port` whether it is an E2E server. Returns a description
 * of the offending server when it is not, or `null` when the port is clear.
 *
 * **Fail-closed, and the split try/catch is what implements that.** Only a
 * refused connection returns clear, because it is the only answer meaning
 * nothing was there to protect. A 200 we cannot parse, a body that arrives too
 * late, a reset mid-stream — all of those were *accepted by something*, and a
 * single `catch` around the whole exchange would have quietly filed them with
 * "nothing answered". That inversion is how a guard reports green while the
 * suite eats your documents (#1483), so the two phases stay apart.
 *
 * A false "foreign" costs a developer one error message; a false "clear" costs
 * them their documents.
 */
export async function probeForeignServer(
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${API_INFO}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isConnectionRefused(err)) return null;
    return `(bound, but unreachable: ${describeError(err)})`;
  }

  // A non-2xx from *something* still means something holds the port, and we
  // have no evidence it is ours.
  if (!res.ok) return `(HTTP ${res.status})`;

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    // Both a non-JSON body and a body that never finishes arriving land here —
    // an abort mid-stream throws from the read, not from `fetch`. Report the
    // cause so "Unexpected token '<'" and "aborted due to timeout" stay
    // distinguishable; the verdict is the same refusal either way.
    return `(bound, but /api/info body unreadable: ${describeError(err)})`;
  }

  const reported = (body as { storagePath?: unknown } | null)?.storagePath;
  if (isE2EStoragePath(reported)) return null;
  return typeof reported === "string" ? reported : "(no storagePath in /api/info)";
}

/** The refusal text. Separate so a test can assert on it without a live port. */
export function foreignServerMessage(reported: string, port: number): string {
  return [
    "Refusing to run this Playwright suite against a server it did not start.",
    "",
    `Something is already listening on 127.0.0.1:${port}, and this suite could`,
    "not identify it as its own isolated E2E server:",
    "",
    `  reported:  ${reported}`,
    `  expected:  a storage path inside ${E2E_APP_DATA_DIR}`,
    "",
    'That is almost always the Tandem desktop app, or a "npm run dev:server".',
    "Playwright's reuseExistingServer ADOPTS it rather than failing, and the",
    "suite would then run tandem_open, tandem_close, DELETE /api/chat and every",
    "typing and annotation test against your real documents and real app-data —",
    "with no per-run wipe, because scripts/e2e-server.mjs never runs on that",
    "branch.",
    "",
    "Quit Tandem (or stop the dev server) and run the suite again.",
  ].join("\n");
}

/**
 * Playwright `globalSetup` (#1483).
 *
 * **This is a post-flight, not a preflight, and that is a Playwright fact
 * rather than a choice.** `createGlobalSetupTasks`
 * (`node_modules/playwright/lib/runner/tasks.js`) pushes
 * `createPluginSetupTasks` — start and health-check every `webServer` — ahead
 * of `config.globalSetups`. The same ordering is documented from the other side
 * in `tests/perf/global-setup.ts:9-19`, where a wipe that believed it ran
 * first never did. (Playwright internals are cited by function name, never
 * line number — `tests/perf` set that style for this exact citation, and it is
 * the durable form: a line number into `node_modules` rots on every
 * `npm update` with nothing to notice.)
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
 * iterating skips a rebuild (`tests/perf/playwright.config.ts:112-115` records
 * that habit as real). `globalSetup` travels with the config and cannot be
 * skipped. Un-bypassability is worth more here than tidy ordering.
 *
 * **Why reuse stays enabled** on the backend entry — and the reason is the
 * message, not the mechanism. `reuseExistingServer: false` would *also* stop
 * the run, genuinely pre-flight: `WebServerPlugin._startProcess` checks
 * availability first and throws before `launchProcess`, so with the desktop app
 * answering `/health` the command never runs. But all it throws is
 * `"http://127.0.0.1:3479/health is already used, make sure that nothing is
 * running on the port/url"` — which cannot tell the desktop app from a stale
 * E2E server, names no remedy, and says nothing about what the suite would have
 * done to your documents. It would also forbid reusing a backend you started
 * yourself. The guard buys a diagnosable refusal for the cost of running one
 * step later, and pre-execution is the boundary that matters.
 *
 * **Two things this does NOT cover — do not over-trust it.**
 *
 *  1. *Single-port protection over a two-port hazard.* This probes
 *     `DEFAULT_MCP_PORT` only, while `freePort` frees the ws port too. A
 *     half-dead desktop Tandem — Hocuspocus alive on :3478, MCP HTTP dead —
 *     fails Playwright's `/health` check, so Playwright starts its own server,
 *     whose boot then kills the surviving half. The guard reports clear
 *     throughout, because on its port nothing was listening.
 *  2. *An adopted **stale E2E** server passes.* Its storage path is the E2E one,
 *     so this clears it — but `scripts/e2e-server.mjs` never ran, so the
 *     per-run wipe never happened, and the leftover annotation envelopes that
 *     file's header describes cascade through the suite. Identifying the
 *     server by storage dir cannot distinguish "ours" from "ours, from a run
 *     that crashed an hour ago".
 *
 * **The deeper fix both of those want** is giving the E2E backend its own port
 * so a collision is impossible by construction — the shape `tests/perf` already
 * chose for Vite (`tests/perf/playwright.config.ts:70`). Own port means
 * Playwright always starts the server, which makes the wipe unconditional and
 * the two-port race unreachable. It stops at the backend for a real reason: the
 * browser client bakes `DEFAULT_MCP_PORT`/`DEFAULT_WS_PORT` in at build time
 * across 15 interpolation sites in 9 files, so the client's origin has to
 * become runtime-configurable first. Tracked in #1492 — note that #1492 moving
 * the port would silently desynchronize this guard, which reads
 * `DEFAULT_MCP_PORT` directly rather than deriving it from the `webServer` url
 * Playwright actually adopted. `tests/scripts/e2e-guard-wiring.test.ts` pins
 * the two together so the drift fails a test rather than a suite.
 */
export default async function globalSetup(): Promise<void> {
  const foreign = await probeForeignServer(DEFAULT_MCP_PORT);
  if (foreign !== null) {
    throw new Error(foreignServerMessage(foreign, DEFAULT_MCP_PORT));
  }
}
