import { execFileSync, execSync } from "child_process";
import envPaths from "env-paths";
import net from "net";
import path from "path";

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
