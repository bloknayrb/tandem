/**
 * Tandem Doctor — diagnose common setup issues.
 *
 * This module is the importable core behind both `tandem doctor` (the bundled
 * CLI subcommand) and `npm run doctor` (the standalone `scripts/doctor.mjs`
 * shim). It is split into a PURE collector (`runDoctor`) and a thin printer +
 * exit-code wrapper (`runDoctorCli`):
 *
 * - `runDoctor()` reads NOTHING from `process.argv` and calls `process.exit`
 *   NEVER. It returns a structured {@link DoctorReport} so callers and tests
 *   can inspect results without side effects.
 * - `runDoctorCli({ json })` formats the report (human-readable TTY lines or a
 *   single JSON document on stdout) and applies the shared exit code.
 *
 * BUNDLING RATIONALE (do not "simplify" this into a spawn): the diagnostics
 * logic MUST live in this TS module so tsup bundles it into `dist/cli`. The
 * `scripts/` directory is NOT shipped in the npm package (see package.json
 * `files`), so a dispatcher that spawned `scripts/doctor.mjs` would have
 * nothing to run inside a global install. Keeping the logic here is the only
 * correct path for `tandem doctor` to work after `npm install -g`.
 *
 * Pure Node.js built-ins only (no external dependencies) so the module bundles
 * cleanly and the standalone shim can mirror it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { DEFAULT_MCP_PORT, DEFAULT_WS_PORT } from "../shared/constants.js";

const WS_PORT = DEFAULT_WS_PORT;
const MCP_PORT = DEFAULT_MCP_PORT;

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorResult {
  check: string;
  status: DoctorStatus;
  message: string;
  fix?: string;
  data?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  crashed: boolean;
  failures: number;
  warnings: number;
  summary: string;
  error: string | null;
  results: DoctorResult[];
}

/**
 * Internal recorder shared by every check. Mirrors the recorder in the legacy
 * `scripts/doctor.mjs`: each check groups one or more results under a `name`.
 * No TTY output happens here — that's the wrapper's job, so the pure collector
 * stays side-effect-free.
 */
class Recorder {
  failures = 0;
  warnings = 0;
  readonly results: DoctorResult[] = [];
  private currentCheck = "";

  async check<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.currentCheck;
    this.currentCheck = name;
    try {
      return await fn();
    } finally {
      this.currentCheck = prev;
    }
  }

  private record(
    status: DoctorStatus,
    msg: string,
    fix?: string,
    fields?: Record<string, unknown>,
  ): void {
    const entry: DoctorResult = { check: this.currentCheck, status, message: msg };
    if (fix) entry.fix = fix;
    if (fields) entry.data = fields;
    this.results.push(entry);
  }

  pass(msg: string, fix?: string, fields?: Record<string, unknown>): void {
    this.record("pass", msg, fix, fields);
  }

  warn(msg: string, fix?: string, fields?: Record<string, unknown>): void {
    this.warnings++;
    this.record("warn", msg, fix, fields);
  }

  fail(msg: string, fix?: string, fields?: Record<string, unknown>): void {
    this.failures++;
    this.record("fail", msg, fix, fields);
  }
}

// ── Check: Node.js version ──────────────────────────────────────────

function checkNodeVersion(r: Recorder): void {
  const version = process.version;
  const major = Number.parseInt(version.slice(1), 10);
  if (major >= 22) {
    r.pass(`Node.js ${version} (>= 22 required)`);
  } else {
    r.fail(
      `Node.js ${version} — version 22+ required`,
      "Install Node.js 22+ from https://nodejs.org",
    );
  }
}

// ── Check: node_modules exists ──────────────────────────────────────

function checkNodeModules(r: Recorder): void {
  if (existsSync(join(process.cwd(), "node_modules"))) {
    r.pass("node_modules/ exists");
  } else {
    r.fail("node_modules/ not found", "npm install");
  }
}

// ── Check: .mcp.json ────────────────────────────────────────────────

function checkMcpJson(r: Recorder): void {
  const mcpPath = join(process.cwd(), ".mcp.json");
  if (!existsSync(mcpPath)) {
    r.fail(".mcp.json not found", "Restore it from git: git checkout .mcp.json");
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(mcpPath, "utf-8");
  } catch (err) {
    r.fail(`.mcp.json could not be read: ${errMsg(err)}`);
    return;
  }

  let config: {
    mcpServers?: Record<
      string,
      {
        type?: string;
        url?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      }
    >;
  };
  try {
    config = JSON.parse(raw);
  } catch (err) {
    r.fail(`.mcp.json is not valid JSON: ${errMsg(err)}`);
    return;
  }

  const servers = config.mcpServers;
  if (!servers) {
    r.fail('.mcp.json missing "mcpServers" key');
    return;
  }

  // Check tandem (HTTP MCP) entry
  const tandem = servers.tandem;
  if (!tandem) {
    r.fail('.mcp.json missing "tandem" server entry');
  } else if (tandem.type !== "http" || !tandem.url?.includes("/mcp")) {
    r.warn(`.mcp.json tandem: unexpected config — type=${tandem.type}, url=${tandem.url}`);
  } else {
    r.pass(`.mcp.json tandem → ${tandem.url}`);
  }

  // Check tandem-channel entry
  const channel = servers["tandem-channel"];
  if (!channel) {
    r.warn(
      ".mcp.json missing tandem-channel — Claude will use polling instead of push notifications",
    );
  } else {
    const cmd = channel.command;
    const args = (channel.args || []).join(" ");

    if (cmd === "cmd" && args.includes("/c")) {
      r.warn(
        `.mcp.json tandem-channel uses Windows-only "cmd /c" — won't work on macOS/Linux`,
        'Change to: "command": "npx", "args": ["tsx", "src/channel/index.ts"]',
      );
    } else {
      r.pass(`.mcp.json tandem-channel → ${cmd} ${args}`);
    }

    if (!channel.env?.TANDEM_URL) {
      r.warn(
        "tandem-channel missing TANDEM_URL env var",
        'Add "env": {"TANDEM_URL": "http://127.0.0.1:3479"}',
      );
    }
  }
}

// ── Check: user-level MCP config (global install path) ─────────────

function checkUserMcpConfig(r: Recorder): void {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  // Claude Code reads global MCP servers from ~/.claude.json (under
  // `mcpServers`), which is exactly where `tandem setup` writes them. The
  // legacy ~/.claude/mcp_settings.json is not the file Claude Code consults,
  // so checking it produced false warnings even on a correct install (#985).
  const claudeCodePath = join(home, ".claude.json");

  if (!existsSync(claudeCodePath)) {
    r.warn(
      "~/.claude.json not found",
      "Run: tandem setup  (or ignore if using project-local .mcp.json)",
    );
    return;
  }

  let config: { mcpServers?: Record<string, unknown> };
  try {
    config = JSON.parse(readFileSync(claudeCodePath, "utf-8"));
  } catch (err) {
    r.warn(`~/.claude.json is malformed JSON: ${errMsg(err)}`, "Run: tandem setup to rewrite it");
    return;
  }

  const servers = config?.mcpServers ?? {};
  if (!servers.tandem) {
    r.warn("tandem not registered in ~/.claude.json", "Run: tandem setup");
  } else {
    r.pass("tandem registered in ~/.claude.json");
  }
  if (!servers["tandem-channel"]) {
    r.warn(
      "tandem-channel not registered in ~/.claude.json — Claude Code will poll instead of receiving real-time push",
      "Run: tandem setup",
    );
  } else {
    r.pass("tandem-channel registered in ~/.claude.json");
  }
}

// ── Check: port status ──────────────────────────────────────────────

function probePort(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function checkPorts(r: Recorder): Promise<{ ws: boolean; mcp: boolean }> {
  const [ws, mcp] = await Promise.all([probePort(WS_PORT), probePort(MCP_PORT)]);

  if (ws && mcp) {
    r.pass(`Ports ${WS_PORT} (WebSocket) + ${MCP_PORT} (MCP HTTP) in use`, undefined, { ws, mcp });
  } else if (!ws && !mcp) {
    r.fail(
      `Ports ${WS_PORT} + ${MCP_PORT} not listening — server not running`,
      "npm run dev:standalone",
      { ws, mcp },
    );
  } else {
    r.warn(
      `Partial: port ${WS_PORT} ${ws ? "up" : "down"}, port ${MCP_PORT} ${mcp ? "up" : "down"}`,
      "Server may be starting up or partially crashed",
      { ws, mcp },
    );
  }

  return { ws, mcp };
}

// ── Check: /health endpoint ─────────────────────────────────────────

interface HttpGetResult {
  status?: number;
  data?: { version?: string; transport?: string; hasSession?: boolean } | null;
  error?: string;
}

function httpGet(url: string, timeoutMs = 3000): Promise<HttpGetResult | null> {
  return new Promise((resolve) => {
    const req = request(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on("error", (err: Error) => resolve({ error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

async function checkHealth(r: Recorder): Promise<boolean> {
  const result = await httpGet(`http://127.0.0.1:${MCP_PORT}/health`);

  if (!result) {
    r.fail(`Server not responding on 127.0.0.1:${MCP_PORT}`, "npm run dev:standalone");
    return false;
  }

  if (result.error) {
    r.fail(
      `Server not responding on 127.0.0.1:${MCP_PORT} (${result.error})`,
      "npm run dev:standalone",
    );
    return false;
  }

  if (result.status !== 200) {
    r.fail(`/health returned status ${result.status}`);
    return false;
  }

  const d = result.data;
  if (d) {
    const session = d.hasSession ? "session active" : "no MCP session";
    r.pass(`Server healthy (v${d.version}, ${d.transport}, ${session})`, undefined, {
      version: d.version,
      transport: d.transport,
      hasSession: !!d.hasSession,
    });
    if (!d.hasSession) {
      r.warn("No active MCP session — Claude Code hasn't connected yet");
    }
  } else {
    r.pass("Server responded on /health (could not parse body)");
  }
  return true;
}

// ── Check: SSE event stream ─────────────────────────────────────────

function checkSseEndpoint(r: Recorder): Promise<void> {
  return new Promise((resolve) => {
    const req = request(`http://127.0.0.1:${MCP_PORT}/api/events`, { timeout: 2000 }, (res) => {
      // SSE endpoint responds with 200 and text/event-stream
      req.destroy(); // don't hold the connection open
      const ct = res.headers["content-type"] || "";
      if (res.statusCode === 200 && ct.includes("text/event-stream")) {
        r.pass("SSE event stream reachable (/api/events)");
      } else {
        r.warn(`/api/events responded with status ${res.statusCode}, content-type: ${ct}`);
      }
      resolve();
    });
    req.on("error", (err: Error) => {
      r.warn(`/api/events not reachable: ${err.message}`);
      resolve();
    });
    req.on("timeout", () => {
      req.destroy();
      r.warn("/api/events timed out");
      resolve();
    });
    req.end();
  });
}

// ── Check: annotation store health ──────────────────────────────────

/** Mirror of `env-paths("tandem").data` for the current OS. */
function resolveAppDataDir(): string {
  const override = process.env.TANDEM_APP_DATA_DIR;
  if (override && override.length > 0) return override;

  const home = homedir();
  switch (platform()) {
    case "win32":
      return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "tandem", "Data");
    case "darwin":
      return join(home, "Library", "Application Support", "tandem");
    default:
      return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "tandem");
  }
}

/** Cross-platform test that a PID currently points at a live process. */
function isPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function checkAnnotationStore(r: Recorder): void {
  const dir = join(resolveAppDataDir(), "annotations");
  if (!existsSync(dir)) {
    r.pass(`Annotation store dir not yet created (${dir}) — first open will create it`, undefined, {
      dir,
      docCount: 0,
      totalBytes: 0,
      corruptCount: 0,
      exists: false,
    });
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    r.fail(`Annotation store dir unreadable: ${errMsg(err)}`, `Check permissions on ${dir}`);
    return;
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json") && !f.endsWith(".corrupt.json"));
  const corruptFiles = entries.filter((f) => f.includes(".corrupt."));

  let totalBytes = 0;
  let newest: { name: string | null; mtime: number } = { name: null, mtime: 0 };
  let sampleSchemaVersion: number | null = null;

  for (const f of jsonFiles) {
    try {
      const s = statSync(join(dir, f));
      totalBytes += s.size;
      if (s.mtimeMs > newest.mtime) {
        newest = { name: f, mtime: s.mtimeMs };
      }
      if (sampleSchemaVersion === null) {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, f), "utf-8"));
          if (typeof parsed?.schemaVersion === "number") {
            sampleSchemaVersion = parsed.schemaVersion;
          }
        } catch {
          // malformed individual file — counted under corruptFiles check below
        }
      }
    } catch {
      // file vanished between readdir and stat — ignore
    }
  }

  r.pass(
    `Annotation store: ${jsonFiles.length} doc(s), ${formatBytes(totalBytes)} total`,
    undefined,
    {
      dir,
      docCount: jsonFiles.length,
      totalBytes,
      corruptCount: corruptFiles.length,
    },
  );

  if (newest.name) {
    const ageMs = Date.now() - newest.mtime;
    const ageStr =
      ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`;
    r.pass(`Most recent annotation write: ${newest.name} (${ageStr} ago)`, undefined, {
      name: newest.name,
      mtimeMs: newest.mtime,
      ageMs,
    });
  }

  if (sampleSchemaVersion !== null) {
    r.pass(`Annotation schema version: ${sampleSchemaVersion}`, undefined, {
      schemaVersion: sampleSchemaVersion,
    });
  }

  if (corruptFiles.length > 0) {
    r.warn(
      `${corruptFiles.length} quarantined annotation file(s) in ${dir}`,
      "Safe to delete after inspection; kept 7d by design.",
      {
        corruptCount: corruptFiles.length,
        dir,
      },
    );
  }

  // Lock status
  const lockPath = join(dir, "store.lock");
  if (!existsSync(lockPath)) {
    r.pass("Annotation store lock: not held (no running writer)", undefined, { lockHeld: false });
    return;
  }

  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid)) {
      r.warn(
        `Annotation store lock at ${lockPath} has unparseable content: "${raw}"`,
        "Restart Tandem or delete the lock file if no server is running.",
        { lockHeld: true, lockPath, lockContent: raw },
      );
      return;
    }
    if (isPidLive(pid)) {
      r.pass(`Annotation store lock held by live PID ${pid}`, undefined, {
        lockHeld: true,
        pid,
        pidLive: true,
      });
    } else {
      r.warn(
        `Annotation store lock at ${lockPath} points to dead PID ${pid}`,
        "The next server start will reclaim the stale lock automatically.",
        { lockHeld: true, pid, pidLive: false },
      );
    }
  } catch (err) {
    r.warn(`Could not read annotation store lock: ${errMsg(err)}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Pure collector ──────────────────────────────────────────────────

/**
 * Run every diagnostic check and return a structured report. Performs NO
 * `process.argv` reads and NEVER calls `process.exit`. Safe to call from tests
 * and from both CLI entry points.
 */
export async function runDoctor(): Promise<DoctorReport> {
  const r = new Recorder();

  await r.check("node-version", () => checkNodeVersion(r));
  await r.check("node-modules", () => checkNodeModules(r));
  await r.check("mcp-json", () => checkMcpJson(r));
  await r.check("user-mcp-config", () => checkUserMcpConfig(r));
  await r.check("annotation-store", () => checkAnnotationStore(r));

  const { mcp } = await r.check("ports", () => checkPorts(r));

  if (mcp) {
    const healthy = await r.check("health", () => checkHealth(r));
    if (healthy) {
      await r.check("sse", () => checkSseEndpoint(r));
    }
  }

  const summary =
    r.failures > 0
      ? `${r.failures} issue(s) found.`
      : r.warnings > 0
        ? `${r.warnings} warning(s) — Tandem should work, but check the items above.`
        : "All checks passed. Tandem is ready.";

  return {
    ok: r.failures === 0,
    crashed: false,
    failures: r.failures,
    warnings: r.warnings,
    summary,
    error: null,
    results: r.results,
  };
}

// ── Printer + exit-code wrapper ─────────────────────────────────────

export interface RunDoctorCliOptions {
  json?: boolean;
}

/** ANSI-colored status tag for the human-readable TTY printer. */
function colorTag(status: DoctorStatus): string {
  switch (status) {
    case "pass":
      return "\x1b[32m[PASS]\x1b[0m";
    case "warn":
      return "\x1b[33m[WARN]\x1b[0m";
    case "fail":
      return "\x1b[31m[FAIL]\x1b[0m";
  }
}

/**
 * Format the report and apply the shared exit code (0 pass, 1 failures,
 * 2 crash). In `--json` mode stdout is a SINGLE pure JSON document — human
 * lines are suppressed so the stream is machine-parseable. Both `tandem
 * doctor` and `npm run doctor` route through here.
 *
 * Note: writing JSON to stdout is correct for the CLI. Critical Rule #3
 * ("stdout is reserved") applies to the MCP stdio server, not this command —
 * `src/cli/index.ts` deliberately uses stdout for `--version`/`--help`.
 */
export async function runDoctorCli(opts: RunDoctorCliOptions = {}): Promise<number> {
  const json = opts.json ?? false;

  let report: DoctorReport;
  try {
    report = await runDoctor();
  } catch (err) {
    const message = errMsg(err);
    if (json) {
      const crashed: DoctorReport = {
        ok: false,
        crashed: true,
        failures: 0,
        warnings: 0,
        summary: `Tandem Doctor crashed unexpectedly: ${message}`,
        error: message,
        results: [],
      };
      process.stdout.write(`${JSON.stringify(crashed, null, 2)}\n`);
    } else {
      process.stderr.write(`\n  Tandem Doctor crashed unexpectedly: ${message}\n`);
      process.stderr.write(
        "  Please report this at https://github.com/bloknayrb/tandem/issues\n\n",
      );
    }
    return 2;
  }

  const exitCode = report.failures > 0 ? 1 : 0;

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return exitCode;
  }

  // Human-readable TTY output.
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out("");
  out("  Tandem Doctor");
  out("  =============");
  out("");

  for (const res of report.results) {
    out(`  ${colorTag(res.status)} ${res.message}`);
    if (res.status !== "pass" && res.fix) {
      out(`         Fix: ${res.fix}`);
    }
  }

  out("");
  if (report.failures > 0) {
    out(`  ${report.failures} issue(s) found. Fix the items above and re-run: tandem doctor`);
  } else if (report.warnings > 0) {
    out(`  ${report.warnings} warning(s) — Tandem should work, but check the items above.`);
  } else {
    out("  All checks passed. Tandem is ready.");
  }
  out("");

  return exitCode;
}
