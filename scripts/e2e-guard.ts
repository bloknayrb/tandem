import path from "node:path";
import { API_INFO } from "../src/shared/api-paths";
import { E2E_APP_DATA_DIR } from "./e2e-paths";
import { E2E_MCP_PORT, E2E_VITE_PORT, E2E_WS_PORT } from "./test-ports";

/**
 * How long to wait for `/api/info`. Generous on purpose: under the fail-closed
 * rule below, a timeout is a *refusal*, so a tight bound turns a merely loaded
 * machine into a failed run. Five seconds against a server Playwright has
 * already health-checked is slack, not patience.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * The served-module probe needs its own, larger budget. Playwright's health
 * check only proves Vite is answering; this probe asks it to TRANSFORM a module
 * for the first time, which on a cold `node_modules/.vite` is a different order
 * of work. Measured on a loaded dev machine: 4627ms against the 5000ms shared
 * bound — close enough that the guard refused three runs in a row while the
 * thing it guards was perfectly healthy.
 *
 * Because a timeout here is a REFUSAL rather than a warning, a bound that tight
 * converts machine load into a failed suite. The fast health probes keep the
 * 5s bound; only the transform gets the slack.
 */
const TRANSFORM_PROBE_TIMEOUT_MS = 30_000;

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
    "The E2E backend runs on a reserved port pair (scripts/test-ports.ts), so",
    "this is usually a Tandem started with TANDEM_MCP_PORT pointed at the",
    "reserved pair, or an unrelated process. Running anyway would aim",
    "tandem_open, tandem_close, DELETE /api/chat and every typing and",
    "annotation test at that server's real documents and app-data, with no",
    "per-run wipe.",
    "",
    "Quit Tandem (or whatever holds the port) and run the suite again.",
  ].join("\n");
}

/**
 * The port `globalSetup` probes, exported so the wiring test can pin that the
 * guard and the backend webServer entry cannot silently desynchronize: a
 * hand-revert of either side back to `DEFAULT_MCP_PORT` fails
 * `tests/scripts/e2e-guard-wiring.test.ts` before it can turn the guard into a
 * vacuous probe of an empty product port.
 */
export const GUARD_PROBE_PORT = E2E_MCP_PORT;

/**
 * The dev-server path of the one module every client→backend URL flows
 * through. `assertServedClientTargetsHarness` reads its *served* form.
 */
export const BACKEND_PORTS_MODULE_PATH = "/src/client/utils/backend-ports.ts";

/**
 * Probe `port` and throw the refusal unless it is clear or provably ours.
 * Split out of `globalSetup` so a test can exercise the refusal against a stub
 * server on an ephemeral port (`tests/scripts/e2e-guard.test.ts`).
 */
export async function runGuard(port: number = GUARD_PROBE_PORT): Promise<void> {
  const foreign = await probeForeignServer(port);
  if (foreign !== null) {
    throw new Error(foreignServerMessage(foreign, port));
  }
}

/**
 * Does the client the Vite dev server is actually serving target the harness
 * backend? (#1492's own hazard, #1483 one layer up: a served client still
 * baked to :3479 would drive the destructive suite into the user's REAL
 * backend through the UI — `LOCALHOST_ORIGIN_RE` admits any 127.0.0.1 origin
 * and the calls are loopback, so they would *succeed*.)
 *
 * Mechanism, verified against Vite 8: in dev, `import.meta.env.VITE_*` is NOT
 * statically replaced — Vite prepends an env-object assignment to the served
 * module (`import.meta.env = {..., "VITE_TANDEM_MCP_PORT": "4729", ...}`).
 * Either that injection or a future static replacement leaves the port as a
 * QUOTED string in the served text; a Vite launched without the harness env
 * contains no quoted harness port anywhere (the module's original source
 * carries no port digits, so the inline sourcemap cannot false-positive —
 * base64 has no quote characters). So: fetch the served module, require the
 * quoted ports plus the env-var name as a right-module sanity check.
 *
 * This runs in `globalSetup` — after Playwright has started/health-checked the
 * webServers, before any spec — which is the one choke point covering all ~50
 * specs; no spec-level fixture exists (every spec imports `test` raw from
 * `@playwright/test`), so a per-spec assertion would protect only the specs
 * that sort after it under `workers: 1`.
 */
export function assertServedClientTargetsHarness(
  servedSource: string,
  vitePort: number = E2E_VITE_PORT,
  wsPort: number = E2E_WS_PORT,
  mcpPort: number = E2E_MCP_PORT,
): void {
  const problems: string[] = [];
  if (!servedSource.includes("VITE_TANDEM_MCP_PORT")) {
    problems.push(`the served module does not mention VITE_TANDEM_MCP_PORT at all`);
  }
  if (!servedSource.includes(`"${mcpPort}"`)) {
    problems.push(`no "${mcpPort}" (MCP) in the served module`);
  }
  if (!servedSource.includes(`"${wsPort}"`)) {
    problems.push(`no "${wsPort}" (ws) in the served module`);
  }
  if (problems.length === 0) return;
  throw new Error(
    [
      "Refusing to run this Playwright suite: the Vite dev server on",
      `127.0.0.1:${vitePort} is serving a client that does NOT target the`,
      `harness backend (ws ${wsPort} / mcp ${mcpPort}):`,
      "",
      ...problems.map((p) => `  - ${p}`),
      "",
      "That client would aim every UI-driven fetch at the PRODUCT ports and",
      "drive the destructive suite into a real Tandem. This Vite was launched",
      "without VITE_TANDEM_WS_PORT/VITE_TANDEM_MCP_PORT — usually a hand-started",
      `\`vite --port ${vitePort}\` or a stale server from before #1492. Stop it and`,
      "let Playwright start its own.",
    ].join("\n"),
  );
}

/** Fetch the served form of the backend-ports module. Fail-closed: Playwright already health-checked this Vite, so any failure here is a refusal, not a clear. */
export async function fetchServedBackendPortsModule(
  vitePort: number = E2E_VITE_PORT,
  timeoutMs: number = TRANSFORM_PROBE_TIMEOUT_MS,
): Promise<string> {
  const url = `http://127.0.0.1:${vitePort}${BACKEND_PORTS_MODULE_PATH}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(
      `Refusing to run this Playwright suite: could not read ${url} from the ` +
        `Vite dev server the suite is about to use (${describeError(err)}), so ` +
        "the served client's backend ports cannot be verified.",
    );
  }
  if (!res.ok) {
    throw new Error(
      `Refusing to run this Playwright suite: ${url} answered HTTP ${res.status}, ` +
        "so the served client's backend ports cannot be verified.",
    );
  }
  return await res.text();
}

/**
 * Playwright `globalSetup` (#1483, retargeted by #1492).
 *
 * **This is a post-flight, not a preflight, and that is a Playwright fact
 * rather than a choice.** `createGlobalSetupTasks`
 * (`node_modules/playwright/lib/runner/tasks.js`) pushes
 * `createPluginSetupTasks` — start and health-check every `webServer` — ahead
 * of `config.globalSetups`. The destructive half is test *execution*, and
 * throwing here aborts before the first spec.
 *
 * **What #1492 changed.** The backend runs on a reserved pair
 * (`scripts/test-ports.ts`) with `reuseExistingServer: false`, so the
 * default-configuration collision with the desktop app is gone by
 * construction, and the old gap 2 (adopting a stale E2E server and skipping
 * the per-run wipe) is closed outright. Two checks remain, and what each is
 * for:
 *
 *  1. `runGuard` — defense-in-depth on the backend port. It fires only if
 *     reuse is ever re-enabled, or something wins a race onto the port between
 *     Playwright's availability check and the run. Deliberate narrowing, not
 *     vacuity: the wiring test pins `GUARD_PROBE_PORT` to the webServer entry
 *     so neither side can quietly drift back to `DEFAULT_MCP_PORT`.
 *  2. The served-client check — the load-bearing half now. The Vite entry
 *     still allows local reuse, and a served client baked to the product
 *     ports would drive the suite into a real Tandem through the UI with the
 *     backend isolation working perfectly.
 *
 * **The true residual, stated plainly (do not oversell the refusal):**
 * Playwright throws its terse "already used" error only when something
 * answers 200–403 on the reserved MCP port. A wedged process there, any
 * non-HTTP process, and **anything at all on the reserved WS port — which no
 * Playwright check ever probes** — is silently SIGKILLed by the E2E server's
 * own boot (`freePort`, src/server/platform.ts). For stale E2E servers that
 * is desirable self-healing; for anything else it is why the reserved pair
 * must never collide with a pair any doc tells users to occupy
 * (`scripts/test-ports.ts` holds that inventory, and the wiring test pins
 * `docs/troubleshooting.md` against it).
 */
export default async function globalSetup(): Promise<void> {
  await runGuard(GUARD_PROBE_PORT);
  assertServedClientTargetsHarness(await fetchServedBackendPortsModule(E2E_VITE_PORT));
}
