import { execSync } from "child_process";
import net from "net";
import path from "path";
import envPaths from "env-paths";

const paths = envPaths("tandem", { suffix: "" });

/** Platform-appropriate session storage directory. */
export const SESSION_DIR = path.join(paths.data, "sessions");

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
  } catch {
    // Nothing listening or kill failed — proceed anyway
  }
}

/**
 * Poll until a TCP port is available for binding.
 * Replaces the fixed 300ms sleep after freePort() — the OS may need
 * longer to release a killed process's socket (especially on Windows).
 */
export async function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await tryBind(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(
    `[Tandem] Warning: port ${port} still not available after ${timeoutMs}ms, proceeding anyway`,
  );
}

/** Attempt to bind a port and immediately release it. Returns true if available. */
function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => {
      srv.close();
      resolve(false);
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

function freePortWindows(port: number): void {
  const out = execSync(`netstat -ano | findstr ":${port}.*LISTENING"`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pid = out.trim().split(/\s+/).at(-1);
  if (pid && /^\d+$/.test(pid)) {
    execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
    console.error(`[Tandem] Killed stale PID ${pid} holding port ${port}`);
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
