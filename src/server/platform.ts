import { execFileSync, execSync } from "child_process";
import envPaths from "env-paths";
import net, { isIP } from "net";
import path from "path";
import { DEFAULT_BIND_HOST } from "../shared/constants.js";

/**
 * Resolve the Tandem app-data root directory. `TANDEM_APP_DATA_DIR` overrides
 * the `env-paths` default. Not memoised so tests can swap tempdirs mid-run.
 */
export function resolveAppDataDir(): string {
  const envOverride = process.env.TANDEM_APP_DATA_DIR;
  if (envOverride && envOverride.length > 0) return envOverride;
  return envPaths("tandem", { suffix: "" }).data;
}

/**
 * Would an npm-installed `tandem activate <file>` write where THIS server reads?
 *
 * The discriminant behind the Settings → License CLI hint (#1789, review round
 * 1). `isTauriRuntime()` in the client answers "am I in the Tauri WebView",
 * which is NOT the same question: a desktop install also serves the full client
 * over `http://127.0.0.1:3479` (`bundle.resources` ships `dist/client/`), and a
 * desktop user who opens that URL in a browser reads `isTauriRuntime() ===
 * false`. Offering them the command there is the exact failure the hint was
 * withdrawn for — `src/cli/license.ts` never sets `TANDEM_APP_DATA_DIR`, so an
 * npm CLI writes `license.json` under the npm env-paths root while the desktop
 * sidecar was launched pointing at the Tauri app-data dir (`sidecar.rs` sets
 * both `TANDEM_DATA_DIR` and `TANDEM_APP_DATA_DIR`). Activation prints
 * "✓ License activated" and the desktop never sees it.
 *
 * Only the server can answer it, because only the server knows which root it
 * resolved. `true` means this process reads the same directory a fresh npm
 * `tandem` would write; any override (the desktop sidecar, or a test tempdir)
 * makes it `false`, which is the fail-closed direction — the hint disappears
 * rather than naming a command that silently does nothing.
 */
export function npmCliSharesAppDataRoot(): boolean {
  return (
    path.resolve(resolveAppDataDir()) === path.resolve(envPaths("tandem", { suffix: "" }).data)
  );
}

/**
 * Resolve a Windows system binary by absolute path under `%SystemRoot%`.
 * Bypasses `PATH` so a git-bash / MSYS / Cygwin shadow (e.g. their own
 * `whoami` that doesn't understand Windows flags) can't intercept us — and so
 * the loader never searches a writable directory ahead of the system one.
 * Lives here rather than in a feature module (e.g. `integrations/acl-win.ts`,
 * a former home) because this file is a leaf utility imported broadly across
 * `src/server` — a feature module importing a leaf is fine, the reverse isn't.
 *
 * **Known residual: the `SystemRoot` read.** The environment block belongs to
 * whoever launched the process, so this anchor is only as trustworthy as the
 * launcher. `src-tauri/src/system_paths.rs` avoids that by calling
 * `GetSystemDirectoryW`, which Node cannot reach without a native module. What
 * bounds it here: the Node server never runs elevated, so a launcher that could
 * poison `SystemRoot` already has everything this process has. Don't "simplify"
 * the fallback away either — a bare name would be strictly worse than a
 * possibly-wrong absolute path, since it reintroduces the search this exists to
 * skip.
 */
export function systemBin(name: string): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

const APP_DATA_DIR = resolveAppDataDir();

/** Platform-appropriate session storage directory. */
export const SESSION_DIR = path.join(APP_DATA_DIR, "sessions");

/** Path to the file tracking the last version the user ran. */
export const LAST_SEEN_VERSION_FILE = path.join(APP_DATA_DIR, "last-seen-version");

/** What a `/health` response tells us about the process already on the port. */
export interface TandemInstanceProbe {
  /**
   * The responder's process id, or `null` when the probe could not be made over
   * loopback — `/health` withholds `pid` from non-loopback callers on purpose
   * (it is an identity signal). Only the LAN arm of `probeHealthOnce` can
   * produce `null`.
   */
  pid: number | null;
  version: string;
  /** The host actually probed, so a refusal message can name it. */
  host: string;
}

/** Retry shape for {@link probeTandemInstance}. Tests only — see below. */
export interface ProbeSchedule {
  attempts: number;
  timeoutMs: number;
  delayMs: number;
}

/**
 * Three attempts, 1s each, 250ms apart.
 *
 * One 1s window is not enough evidence to authorise a SIGKILL: a healthy Tandem
 * whose event loop is briefly blocked (a `.docx` convert, a large
 * `extractText`) answers slowly, would probe as absent, and would then be
 * killed — the exact outcome this probe exists to prevent, reached through it.
 */
const DEFAULT_PROBE_SCHEDULE: ProbeSchedule = { attempts: 3, timeoutMs: 1_000, delayMs: 250 };

/**
 * Bind hosts whose listener also covers `127.0.0.1`: the two loopback literals,
 * the name that resolves to them, and the two wildcards.
 */
const BIND_HOSTS_COVERING_LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"]);

/**
 * The address {@link probeTandemInstance} should ask (#1758 review).
 *
 * **`freePort` kills by PORT NUMBER, irrespective of bind address** — the
 * refusal message in `index.ts` says exactly that about `wsPort`. So a probe
 * hardwired to `127.0.0.1` while `TANDEM_BIND_HOST` names a LAN address asks an
 * address nothing is listening on, gets ECONNREFUSED, `decideStartupAction`
 * answers `"proceed"`, and the live instance is SIGKILLed with its open
 * documents — the exact #1758 failure, left intact for the one supported
 * configuration where the probe could not see the server.
 *
 * A wildcard bind DOES cover loopback, so it resolves back to `127.0.0.1`,
 * which is the better target there: `/health` reveals `pid` only to a loopback
 * caller.
 */
export function resolveProbeHost(
  bindHost: string = process.env.TANDEM_BIND_HOST || DEFAULT_BIND_HOST,
): string {
  return BIND_HOSTS_COVERING_LOOPBACK.has(bindHost) ? "127.0.0.1" : bindHost;
}

/**
 * Ask whether a live Tandem is already serving `mcpPort` (#1758).
 *
 * `freePort` is the tool for a listener that fails THIS probe — a wedged
 * process, a crashed sidecar, an unrelated program. The probe deliberately
 * lives beside it rather than inside it: `freePort`'s other callers (the E2E
 * harness boot, `scripts/`) have different needs, and a probe hidden inside a
 * kill primitive is implicit control.
 *
 * Returns `null` for anything short of a positive identification: a throw, a
 * non-2xx, a non-JSON body, or a body missing `status: "ok"` or a string
 * `version`. A `status` of `"shutting-down"` is likewise `null` — a dying
 * instance must not refuse its own replacement (`shutdown-state.ts`).
 *
 * **The `pid` requirement is loopback-only, and the asymmetry is deliberate.**
 * Over loopback `pid` is required: it is what #1812 adds to `/health`, so a
 * Tandem older than that probes as `null` and is still `freePort`ed — today's
 * behaviour, and the right call for an upgrade replacing its own predecessor.
 * Over a LAN bind host `/health` withholds `pid` from non-loopback callers by
 * design, so requiring it there would make every LAN-mode probe negative and
 * hand the live instance straight back to `freePort`. That arm takes
 * `transport: "http"` beside `status`/`version` as the Tandem signature and
 * records `pid: null`. Refusing to start is recoverable (move the ports);
 * SIGKILLing a live instance is not.
 *
 * `schedule` exists so the absence tests run in ~150ms rather than ~3.5s;
 * `host` defaults to {@link resolveProbeHost}. No production call site passes
 * either.
 */
export async function probeTandemInstance(
  mcpPort: number,
  schedule: ProbeSchedule = DEFAULT_PROBE_SCHEDULE,
  host: string = resolveProbeHost(),
): Promise<TandemInstanceProbe | null> {
  for (let attempt = 0; attempt < schedule.attempts; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, schedule.delayMs));
    }
    const hit = await probeHealthOnce(host, mcpPort, schedule.timeoutMs);
    if (hit) return hit;
  }
  return null;
}

async function probeHealthOnce(
  host: string,
  mcpPort: number,
  timeoutMs: number,
): Promise<TandemInstanceProbe | null> {
  // A bare IPv6 literal is not a valid URL authority.
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  try {
    const res = await fetch(`http://${authority}:${mcpPort}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const record = body as Record<string, unknown>;
    if (record.status !== "ok") return null;
    const { pid, version } = record;
    if (typeof version !== "string" || version.length === 0) return null;
    const identified = typeof pid === "number" && Number.isInteger(pid) ? pid : null;
    if (host === "127.0.0.1" || host === "::1") {
      if (identified === null) return null;
      return { pid: identified, version, host };
    }
    // LAN arm: `pid` is withheld from us by design, so `transport` carries the
    // "this is Tandem, not some other health endpoint" half of the signature.
    if (record.transport !== "http") return null;
    return { pid: identified, version, host };
  } catch {
    return null;
  }
}

/**
 * The argv flag the Tauri shell passes its sidecar, beside the server entry
 * point (`src-tauri/src/sidecar.rs`).
 */
export const TAURI_SIDECAR_ARGV_FLAG = "--tauri-sidecar";

/**
 * Whether THIS process is the Tauri shell's own sidecar.
 *
 * **Derived from argv, never from `TANDEM_TAURI_SIDECAR`.** That variable is
 * inherited by every descendant of the sidecar — `tauri-plugin-shell`'s
 * `Command::new` never calls `env_clear()`, and `supervisor.ts` spawns the
 * auto-launched Claude Code with `env: process.env` — so keying the carve-out
 * on it means an npm `tandem` run from an auto-launched session's own shell
 * reads `"1"`, takes the sidecar's carve-out and SIGKILLs the desktop's server:
 * #1758's own bug, surviving on the path the product's auto-launch creates.
 * The repo already treats the variable as too weak for provenance
 * (`integrations/apply.ts`, `cli/doctor.ts`). Argv is not inherited by
 * grandchildren, which is what makes it the discriminant. The env var is
 * unchanged for its existing consumers.
 */
export function isTauriSidecar(argv: readonly string[] = process.argv): boolean {
  return argv.includes(TAURI_SIDECAR_ARGV_FLAG);
}

export type StartupAction = "refuse" | "proceed" | "skip-freeport";

/**
 * What to do about a port that is already answering (#1758).
 *
 * - Tauri sidecar → `"proceed"` whatever the probe says. The shell delegates
 *   port reclamation TO the sidecar it spawns (`sidecar.rs`: "The sidecar's own
 *   `freePort()` step on start handles port conflicts cleanly"), and it has no
 *   other self-heal. On macOS/Linux there is no job object, so a force-quit
 *   shell leaves a live sidecar; refusing there would strand the app behind its
 *   own orphan until `MAX_RESTARTS` ran out into the "Retry Server Start"
 *   dialog with nothing left to clear it.
 * - A live Tandem, http → `"refuse"`. The issue's case: an npm `tandem` must
 *   not displace the desktop's server under the user's open documents.
 * - A live Tandem, stdio → `"skip-freeport"`. Do NOT exit: an MCP client's init
 *   would fail. Skipping the kill converts "silently killed the desktop" into
 *   "MCP works, Hocuspocus did not bind", which the branch already tolerates.
 * - No probe → `"proceed"`, i.e. today's behaviour with `freePort` intact.
 */
export function decideStartupAction(input: {
  probe: TandemInstanceProbe | null;
  mode: "http" | "stdio";
  isSidecar: boolean;
}): StartupAction {
  if (input.isSidecar) return "proceed";
  if (input.probe === null) return "proceed";
  return input.mode === "http" ? "refuse" : "skip-freeport";
}

/**
 * Kill any process currently listening on the given TCP port.
 * Best-effort — swallows all errors so startup always proceeds.
 */
export function freePort(port: number): void {
  try {
    if (process.platform === "win32") {
      freePortWindows(port);
    } else {
      freePortUnix(port);
    }
  } catch (err) {
    console.error(`[Tandem] freePort(${port}): ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Poll until a TCP port is available for binding.
 * Replaces the fixed 300ms sleep after freePort() — the OS may need
 * longer to release a killed process's socket (especially on Windows).
 *
 * The 15s default is a Windows post-update figure, not a guess. Windows can
 * hold a killed listener's port in TIME_WAIT for several seconds, and the
 * moment that is most likely is immediately after an auto-update restart —
 * fresh files on disk, antivirus scanning them, the installer still settling.
 * The previous 5s ceiling was reported failing there: the sidecar gave up
 * waiting, bound anyway (callers log and proceed), took EADDRINUSE, and died,
 * which the Tauri shell surfaces as "Server failed to start after 3 restart
 * attempts".
 *
 * Widening costs nothing on a healthy machine — this polls and returns as soon
 * as the port is free. But it IS coupled to HEALTH_TIMEOUT in
 * `src-tauri/src/lib.rs`, which times this wait from outside the process:
 * that constant must stay comfortably above this one or the shell kills a
 * sidecar that was legitimately waiting.
 */
export async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await tryBind(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Port ${port} still not available after ${timeoutMs}ms`);
}

/** Attempt to bind a port and immediately release it. Returns true if available. */
function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      srv.close(() => {
        if (err.code === "EADDRINUSE") {
          resolve(false);
        } else {
          reject(err); // EACCES, etc. — don't mask as "port in use"
        }
      });
    });
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Parse PIDs from lsof output (one PID per line). */
export function parseLsofPids(output: string): number[] {
  return output
    .trim()
    .split("\n")
    .map((line) => parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

/** Parse a PID from ss output (e.g. `pid=1234`). */
export function parseSsPid(output: string): number | null {
  const match = output.match(/pid=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse `netstat -ano` output for the PIDs of processes LISTENING on `port` in
 * a way that would contend with our own `127.0.0.1` bind.
 *
 * This replaced `netstat -ano | findstr ":${port}.*LISTENING"`, which was wrong
 * in three ways that all end in killing the wrong process:
 *
 * 1. `findstr` takes a REGEX matched anywhere in the line, so `:3479.*LISTENING`
 *    also matched `127.0.0.1:34790  …  LISTENING` — a different service.
 * 2. The result was `.split(/\s+/).at(-1)` over the whole multi-line blob, so
 *    with several matching rows only the LAST row's PID was taken, which need
 *    not be the row that matched the port.
 * 3. A listener bound to a specific non-loopback interface (WSL/Hyper-V vEthernet,
 *    Docker, a VPN adapter) does not block a `127.0.0.1` bind, but matched anyway.
 *
 * The column-aware parse fixes all three, and deliberately mirrors
 * `parse_netstat_listening_pid` in `src-tauri/src/lib.rs` — the Tauri shell
 * NAMES the holder in its error dialog and this function KILLS it, so the two
 * must agree on which row is the holder or the dialog blames one process while
 * the retry terminates another.
 *
 * Locale note: the State column is localized by Windows, so a row also counts as
 * listening when its Foreign Address port is 0 (`0.0.0.0:0` / `[::]:0`) — the
 * structural signature of a listening socket, which no connected state produces.
 */
export function parseNetstatListeningPids(output: string, port: number): number[] {
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const cols = line.trim().split(/\s+/);
    // Proto | Local Address | Foreign Address | State | PID
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;

    const localPort = cols[1].slice(cols[1].lastIndexOf(":") + 1);
    if (localPort !== String(port)) continue;

    // Only addresses that actually contend with a 127.0.0.1 bind.
    const localAddr = cols[1].slice(0, cols[1].lastIndexOf(":"));
    if (!["127.0.0.1", "0.0.0.0", "[::]", "[::1]"].includes(localAddr)) continue;

    const foreignPort = cols[2].slice(cols[2].lastIndexOf(":") + 1);
    const listening = cols[3].toUpperCase() === "LISTENING" || foreignPort === "0";
    if (!listening) continue;

    // Integer parse is the injection guard (the old `/^\d+$/` in typed form):
    // only a value that round-trips as a non-negative integer is passed to
    // taskkill, and it is passed as a discrete argv element, never a shell string.
    const pid = Number(cols[4]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

function freePortWindows(port: number): void {
  const out = execFileSync(systemBin("netstat.exe"), ["-ano"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  for (const pid of parseNetstatListeningPids(out, port)) {
    try {
      const killOut = execFileSync(systemBin("taskkill.exe"), ["/PID", String(pid), "/F"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Some taskkill paths exit 0 with empty stdout — avoid a dangling
      // ": " in the log when there's no message to append.
      const trimmed = killOut.trim();
      console.error(
        `[Tandem] Killed stale PID ${pid} holding port ${port}${trimmed ? `: ${trimmed}` : ""}`,
      );
    } catch (err) {
      // Surface taskkill failure (permission denied, cross-session, race) so a
      // subsequent port-bind EADDRINUSE is diagnosable. The prior `stdio: "ignore"`
      // masked these and left the user with a silent "Disconnected" state.
      const stderr =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr: unknown }).stderr ?? "")
          : "";
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[Tandem] taskkill failed for PID ${pid} on port ${port}: ${message}${
          stderr ? ` — stderr: ${stderr.trim()}` : ""
        }`,
      );
    }
  }
}

function freePortUnix(port: number): void {
  let pids: number[] = [];

  try {
    const out = execSync(`lsof -ti TCP:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    pids = parseLsofPids(out);
  } catch {
    // lsof not available — try ss (Linux)
    try {
      const out = execSync(`ss -tlnp sport = :${port}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      const pid = parseSsPid(out);
      if (pid) pids = [pid];
    } catch {
      // ss also unavailable — give up
    }
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      console.error(`[Tandem] Killed stale PID ${pid} holding port ${port}`);
    } catch {
      // Process already gone
    }
  }
}
