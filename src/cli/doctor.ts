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

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parseLockfile } from "../server/annotations/lockfile.js";
import { DEFAULT_MCP_PORT, DEFAULT_WS_PORT } from "../shared/constants.js";
import type { ClaudeCliPresence } from "../shared/integrations/contract.js";
import { detectClaudeCli } from "../shared/integrations/detect-claude-cli.js";

// Injected by tsup into dist/cli. Absent in tsx dev / vitest (typeof-guarded at
// use). This is the version the `npx` bridge entries are pinned to.
declare const __TANDEM_VERSION__: string;

export type DoctorStatus = "pass" | "warn" | "fail";

/**
 * Outcome of a pure decision step, before it reaches the wire.
 *
 * `"skip"` is deliberately NOT a {@link DoctorStatus} member: the status enum
 * is an MCP wire contract (`z.enum(["pass","warn","fail"])` in
 * `output-schemas.ts`) and the client's `STATUS_TAG` is a
 * `Record<DoctorStatus, string>`, so adding a member is a breaking change.
 *
 * Instead a skip is recorded as a `pass` whose MESSAGE says it skipped and
 * why, plus `data.skipped = true` for machine consumers. That is the point of
 * the whole exercise: a check that could not compare anything must SAY so
 * rather than report a green it never earned — but a skip is not a warning
 * either (a fresh clone before `npm install` would warn-storm every run).
 */
type EvalOutcome = {
  status: "pass" | "warn" | "skip";
  message: string;
  fix?: string;
  data?: Record<string, unknown>;
};

/**
 * Error identity WITHOUT the message. Follows the redaction precedent in
 * {@link checkMcpJson}: doctor output gets pasted into public issues and an
 * arbitrary error message can embed absolute paths or a V8 source snippet
 * (which, for `.mcp.json`, carries auth-token headers).
 */
function errorClass(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}

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

  /**
   * Run one check under `name`. A throwing check is contained here and
   * recorded as a `fail` rather than taking the whole report down.
   *
   * Returns `T | undefined` — NOT `T`. The `undefined` is load-bearing and
   * must not be cast away: a crashed check produced no value, and the two
   * callers that consume one (`ports` destructures `{ws, mcp}`; `health`
   * gates the `sse` check) have to say what they want instead. Returning
   * `undefined as T` would satisfy the compiler and then throw a TypeError
   * on the destructure — converting a clear crash into a confusing one on
   * the exact path this containment exists to protect.
   */
  async check<T>(name: string, fn: () => T | Promise<T>): Promise<T | undefined> {
    const prev = this.currentCheck;
    this.currentCheck = name;
    try {
      return await fn();
    } catch (err) {
      // `record` reads this.currentCheck, which the `finally` has not yet
      // restored — so this fail is attributed to the crashed check.
      this.fail(
        `${name} check crashed (${errorClass(err)}) — the rest of the report is still valid`,
        "Please report this at https://github.com/bloknayrb/tandem/issues",
      );
      return undefined;
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

// ── Dev-repo gate ───────────────────────────────────────────────────
//
// The npm-staleness and orphaned-Vite checks below diagnose the DEV checkout
// only. `tandem doctor` ships globally and runs in arbitrary end-user cwds,
// where `package.json` belongs to someone else's project — so both checks
// gate on the cwd actually being the tandem-editor repo and skip SILENTLY
// otherwise (not warn: the absence of a dev checkout is not a finding).

/**
 * Record an {@link EvalOutcome} on the recorder, mapping `"skip"` onto the
 * `pass` wire status with a message that says it skipped. Single boundary so
 * every check spells a skip the same way.
 */
function recordEvaluation(r: Recorder, result: EvalOutcome | null): void {
  if (!result) return;
  if (result.status === "warn") {
    r.warn(result.message, result.fix, result.data);
    return;
  }
  if (result.status === "skip") {
    r.pass(`skipped — ${result.message}`, result.fix, { ...result.data, skipped: true });
    return;
  }
  r.pass(result.message, result.fix, result.data);
}

/**
 * Whether `dir` is the tandem-editor dev checkout.
 *
 * Tri-state on purpose. A single boolean made "this is not the repo" and "the
 * repo's package.json is corrupt" the same silent answer — and the corrupt
 * case is the one worth reporting, since it also silently disables the two
 * dev-repo checks below.
 */
export type RepoProbe = "yes" | "no" | "unreadable";

/** Classify `dir/package.json`: the tandem-editor repo, not it, or broken. */
export function probeTandemEditorRepo(dir: string): RepoProbe {
  const read = readJson(join(dir, "package.json"));
  // Absent package.json is the overwhelmingly common end-user case (an
  // arbitrary cwd) — emphatically not a finding.
  if (read.kind === "absent") return "no";
  if (read.kind === "unreadable") return "unreadable";
  const parsed = read.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "unreadable";
  }
  return (parsed as { name?: unknown }).name === "tandem-editor" ? "yes" : "no";
}

/** True when `dir/package.json` parses and names the `tandem-editor` package. */
export function isTandemEditorRepo(dir: string): boolean {
  return probeTandemEditorRepo(dir) === "yes";
}

// ── Check: npm install staleness (dev repo only) ────────────────────
//
// Compares `package.json`/`package-lock.json` against the hidden lockfile npm
// writes at install time (`node_modules/.package-lock.json`). Deliberately
// NOT `npm ls` (this module is pure built-ins by design, and `npm ls` exits
// non-zero on unrelated issues under `overrides`) and NOT mtimes (git churns
// them on checkout, which would turn every branch switch into a false warn).

interface LockfileEntry {
  version?: string;
  optional?: boolean;
}

interface LockfileJson {
  version?: string;
  packages?: Record<string, LockfileEntry>;
}

/**
 * Outcome of reading a JSON file. The three cases are deliberately distinct:
 * collapsing them into `null` made "the file isn't there" (routine — a fresh
 * clone before `npm install`) indistinguishable from "the file is there and
 * broken", and the broken cases are the two highest-value findings this check
 * has: a merge-conflicted `package-lock.json`, and a truncated
 * `.package-lock.json` from an interrupted install.
 */
type JsonRead =
  | { kind: "ok"; value: unknown }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

/** Read + parse a JSON file, distinguishing absent from broken. */
function readJson(path: string): JsonRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    // EACCES, EISDIR, ELOOP… — the error CODE only, never the message: it
    // embeds an absolute path.
    return { kind: "unreadable", reason: code ?? errorClass(err) };
  }
  try {
    return { kind: "ok", value: JSON.parse(raw) };
  } catch {
    // Deliberately no parse detail — same reasoning as checkMcpJson's
    // redaction: V8 SyntaxErrors embed a snippet of the source text and
    // doctor output gets pasted into public issues.
    return { kind: "unreadable", reason: "not valid JSON" };
  }
}

/** Narrow one `packages` entry, rejecting the `null` npm never writes but that a truncated/hand-edited file can carry. */
function parseLockfileEntry(value: unknown): LockfileEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (entry.version !== undefined && typeof entry.version !== "string") return null;
  if (entry.optional !== undefined && typeof entry.optional !== "boolean") return null;
  return {
    version: entry.version as string | undefined,
    optional: entry.optional as boolean | undefined,
  };
}

/**
 * Narrow an arbitrary parsed value to a {@link LockfileJson}, or null when the
 * shape is wrong. Replaces the `as LockfileJson` casts this check used to
 * carry: a cast is a promise the input never made, and
 * `packages: { "node_modules/x": null }` cashed it as
 * `TypeError: Cannot read properties of null (reading 'optional')` — which
 * took down the ENTIRE report, not just this check.
 *
 * One malformed entry rejects the whole file: a lockfile that is structurally
 * not a lockfile cannot be partially trusted to say what SHOULD be installed.
 */
function parseLockfileJson(value: unknown): LockfileJson | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.version !== undefined && typeof obj.version !== "string") return null;
  const version = obj.version as string | undefined;

  // A lockfileVersion 1 lockfile has no `packages` key at all — a valid file
  // this check simply cannot compare (handled as a skip downstream).
  if (obj.packages === undefined) return { version };
  if (typeof obj.packages !== "object" || obj.packages === null || Array.isArray(obj.packages)) {
    return null;
  }

  const packages: Record<string, LockfileEntry> = {};
  for (const [path, raw] of Object.entries(obj.packages)) {
    const entry = parseLockfileEntry(raw);
    if (!entry) return null;
    packages[path] = entry;
  }
  return { version, packages };
}

/**
 * Pure decision step for the npm-staleness check (same split as
 * {@link evaluateStaleGlobal} — directly unit-testable without touching the
 * filesystem). Any null input means "can't compare here" and skips: a missing
 * node_modules is already the node-modules check's finding, and a tree
 * installed by something other than npm has no hidden lockfile to read.
 */
export function evaluateNpmStaleness(
  pkgInput: unknown,
  lockInput: unknown,
  hiddenLockInput: unknown,
): EvalOutcome | null {
  if (!pkgInput || !lockInput || !hiddenLockInput) return null;

  // Validate shape HERE rather than trusting a cast at the read site: this is
  // the boundary between "bytes someone else wrote" and this function's
  // assumptions, and it is a public export that tests and probes call
  // directly with hand-built input.
  const lock = parseLockfileJson(lockInput);
  if (!lock) {
    return {
      status: "skip",
      message: "cannot compare (package-lock.json has an unexpected structure)",
      fix: "Restore it from git: git checkout package-lock.json",
      data: { reason: "malformed-lock" },
    };
  }
  const hiddenLock = parseLockfileJson(hiddenLockInput);
  if (!hiddenLock) {
    return {
      status: "skip",
      message: "cannot compare (node_modules/.package-lock.json has an unexpected structure)",
      fix: "npm install",
      data: { reason: "malformed-hidden-lock" },
    };
  }
  const pkg =
    typeof pkgInput === "object" && !Array.isArray(pkgInput)
      ? (pkgInput as { version?: unknown })
      : {};
  const pkgVersion = typeof pkg.version === "string" ? pkg.version : undefined;

  // package.json bumped without regenerating the lockfile (release-cut slip).
  if (pkgVersion && lock.version && pkgVersion !== lock.version) {
    return {
      status: "warn",
      message:
        `package-lock.json (v${lock.version}) is out of date with ` +
        `package.json (v${pkgVersion})`,
      fix: "npm install",
      data: { packageVersion: pkgVersion, lockVersion: lock.version },
    };
  }

  // node_modules installed from a lockfile at a different root version.
  if (lock.version && hiddenLock.version && lock.version !== hiddenLock.version) {
    return {
      status: "warn",
      message:
        "node_modules was installed from a different lockfile " +
        `(v${hiddenLock.version} installed, v${lock.version} expected)`,
      fix: "npm install",
      data: { lockVersion: lock.version, installedVersion: hiddenLock.version },
    };
  }

  // Content identity: the hidden lockfile records the tree npm actually
  // installed. It is a SUBSET of package-lock's `packages` — it omits the
  // root "" entry and optional deps whose os/cpu don't match this machine
  // (platform binaries like @biomejs/cli-darwin-*) — so only a missing
  // NON-optional entry, a version mismatch, or an extraneous installed
  // package counts as drift. Never mtimes: content only.
  const wanted = lock.packages ?? {};
  const installed = hiddenLock.packages ?? {};

  // Only PASS after a comparison that actually compared something.
  //
  // package-lock.json is the source of truth for what SHOULD be installed, so
  // an empty `wanted` leaves nothing to compare against and BOTH loops below
  // degenerate: the drift loop inspects zero entries, and the extraneous loop
  // would report every installed package as unexpected.
  //
  // Count NON-ROOT entries, not merely a non-empty object: the drift loop
  // `continue`s on the root "" entry, so `{"": {...}}` is non-empty and still
  // compares nothing. npm never emits `packages: {}` in v2/v3 and v1 has no
  // `packages` key at all, so in practice this fires on a v1 lockfile or a
  // hand-built/garbage one — both of which used to report a confident green.
  const wantedCount = Object.keys(wanted).filter((path) => path !== "").length;
  if (wantedCount === 0) {
    return {
      status: "skip",
      message:
        "cannot compare (package-lock.json lists no packages — a lockfileVersion 1 " +
        "file, or one written by something other than npm)",
      fix: "npm install",
      // No inferred `lockfileVersion` here: we did not read that field, and
      // guessing it from the presence of `packages` would put a fabricated
      // value under a real npm field name.
      data: { reason: "no-comparable-packages" },
    };
  }

  const drifted: string[] = [];
  for (const [path, entry] of Object.entries(wanted)) {
    if (path === "") continue;
    const got = installed[path];
    if (!got) {
      if (!entry.optional) drifted.push(path);
    } else if (entry.version !== got.version) {
      drifted.push(path);
    }
  }
  for (const path of Object.keys(installed)) {
    if (path !== "" && !(path in wanted)) drifted.push(path);
  }

  if (drifted.length > 0) {
    return {
      status: "warn",
      message:
        `node_modules is stale — ${drifted.length} package(s) differ from ` +
        "package-lock.json (e.g. after a pull or branch switch)",
      fix: "npm install",
      data: { driftCount: drifted.length, sample: drifted.slice(0, 5) },
    };
  }

  // The packages dimension compared clean. Before calling that a PASS, apply
  // the same "compared something" rule to the VERSION dimension — the two
  // version guards above are each `&&`-gated on their operands existing, so a
  // missing version silently disables them and falls through to this green.
  // A package.json with no `version` field is exactly the state in which the
  // release-cut-slip guard matters most, and it was the state in which the
  // guard was off.
  const missingVersions: string[] = [];
  if (!pkgVersion) missingVersions.push("package.json");
  if (!lock.version) missingVersions.push("package-lock.json");
  if (!hiddenLock.version) missingVersions.push("node_modules/.package-lock.json");
  if (missingVersions.length > 0) {
    return {
      status: "skip",
      message:
        `node_modules matches package-lock.json, but the version check could not run — ` +
        `no "version" field in ${missingVersions.join(", ")}`,
      data: { reason: "no-comparable-version", missingVersions },
    };
  }

  return {
    status: "pass",
    message: "node_modules matches package-lock.json",
    data: { packageCount: Object.keys(installed).length },
  };
}

/**
 * Read one lockfile and report the read itself.
 *
 * Absent → skip: a fresh clone before `npm install` has no hidden lockfile,
 * and the missing node_modules is already the node-modules check's finding.
 * Anything else → warn NAMING THE PATH: that is a merge-conflicted or
 * truncated lockfile, which is the whole reason to look.
 *
 * Returns a discriminated result rather than `unknown | null`: a null sentinel
 * cannot be told apart from a file whose entire content is the valid JSON
 * literal `null`, and the caller would then bail having recorded nothing —
 * a silent skip, the exact thing this check is being fixed to stop doing.
 */
type LockfileRead = { ok: true; value: object } | { ok: false };

function readLockfileOrReport(r: Recorder, path: string, label: string): LockfileRead {
  const read = readJson(path);
  if (read.kind === "absent") {
    r.pass(`skipped — cannot compare (${label} not found)`, undefined, {
      skipped: true,
      reason: "absent",
      path: label,
    });
    return { ok: false };
  }
  if (read.kind === "ok") {
    // Parseable but not an object (`null`, `0`, `"…"`, `[…]`) is a broken
    // lockfile, not a comparable one — same class as unparseable.
    if (typeof read.value === "object" && read.value !== null && !Array.isArray(read.value)) {
      return { ok: true, value: read.value };
    }
    r.warn(
      `${label} is not a JSON object — npm install staleness cannot be checked`,
      "Check for a truncated or hand-edited file, then: npm install",
      { reason: "not-an-object", path: label },
    );
    return { ok: false };
  }
  r.warn(
    `${label} could not be read (${read.reason}) — npm install staleness cannot be checked`,
    "Check for merge-conflict markers or a truncated file, then: npm install",
    { reason: read.reason, path: label },
  );
  return { ok: false };
}

function checkNpmStaleness(r: Recorder, repoDir: string): void {
  // package.json needs no read-error branch: checkNpmStaleness only runs once
  // probeTandemEditorRepo has already parsed this exact file and returned
  // "yes", so an unreadable one cannot reach here.
  const pkgRead = readJson(join(repoDir, "package.json"));
  const pkg = pkgRead.kind === "ok" ? pkgRead.value : null;

  const lock = readLockfileOrReport(r, join(repoDir, "package-lock.json"), "package-lock.json");
  if (!lock.ok) return;
  const hiddenLock = readLockfileOrReport(
    r,
    join(repoDir, "node_modules", ".package-lock.json"),
    "node_modules/.package-lock.json",
  );
  if (!hiddenLock.ok) return;

  recordEvaluation(r, evaluateNpmStaleness(pkg, lock.value, hiddenLock.value));
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
  } catch {
    // Deliberately no parse detail: V8 SyntaxErrors embed a snippet of the
    // source text, and this file carries auth-token headers. Doctor output
    // gets pasted into public issues.
    r.fail(".mcp.json is not valid JSON", "Restore it from git: git checkout .mcp.json");
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
      "Run: tandem setup --apply  (or ignore if using project-local .mcp.json)",
    );
    return;
  }

  let config: { mcpServers?: Record<string, unknown> };
  try {
    config = JSON.parse(readFileSync(claudeCodePath, "utf-8"));
  } catch {
    // Deliberately no parse detail: V8 SyntaxErrors embed a snippet of the
    // source text, and ~/.claude.json carries bearer tokens / API keys. This
    // check survives the /api/diagnostics filter, so its message reaches the
    // Copy Diagnostics clipboard — destined for public issues.
    r.warn("~/.claude.json is malformed JSON", "Run: tandem setup --apply to rewrite it");
    return;
  }

  const servers = config?.mcpServers ?? {};
  if (!servers.tandem) {
    r.warn("tandem not registered in ~/.claude.json", "Run: tandem setup --apply");
  } else {
    r.pass("tandem registered in ~/.claude.json");
  }
  if (!servers["tandem-channel"]) {
    r.warn(
      "tandem-channel not registered in ~/.claude.json — Claude Code will poll instead of receiving real-time push",
      "Run: tandem setup --apply",
    );
  } else {
    r.pass("tandem-channel registered in ~/.claude.json");
  }
}

// ── Check: Claude CLI presence ──────────────────────────────────────
//
// A config-presence check (checkUserMcpConfig / checkMcpJson) can pass on a
// machine where the `claude` binary was never installed — Tandem's AI features
// then silently do nothing with no clue why. This binary probe names that gap.
// Pure filesystem probe (no spawn); shares the wizard's detector via a leaf.

/**
 * Pure decision step, split out of {@link checkClaudeCli} so the
 * presence→status mapping is directly unit-testable without probing the real
 * filesystem — see tests/cli/doctor.test.ts.
 */
export function evaluateClaudeCli(presence: ClaudeCliPresence): {
  status: "pass" | "warn";
  message: string;
  fix?: string;
} {
  if (presence === "INSTALLED_ON_PATH") {
    return { status: "pass", message: "Claude Code CLI found on PATH" };
  }
  if (presence === "INSTALLED_NOT_ON_PATH") {
    return {
      status: "warn",
      message: "Claude Code CLI installed but not on PATH (found in ~/.local/bin)",
      fix: "Open a new terminal, or add ~/.local/bin to your PATH, then run `claude` once",
    };
  }
  return {
    status: "warn",
    message: "Claude Code CLI not found — Tandem's AI collaboration needs an MCP client",
    fix: "Install Claude Code from https://claude.com/claude-code (or connect another MCP client)",
  };
}

function checkClaudeCli(r: Recorder): void {
  const result = evaluateClaudeCli(detectClaudeCli());
  if (result.status === "pass") {
    r.pass(result.message);
  } else {
    r.warn(result.message, result.fix);
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

async function checkPorts(
  r: Recorder,
  wsPort: number,
  mcpPort: number,
  startHint: string,
): Promise<{ ws: boolean; mcp: boolean }> {
  const [ws, mcp] = await Promise.all([probePort(wsPort), probePort(mcpPort)]);

  if (ws && mcp) {
    r.pass(`Ports ${wsPort} (WebSocket) + ${mcpPort} (MCP HTTP) in use`, undefined, { ws, mcp });
  } else if (!ws && !mcp) {
    r.fail(`Ports ${wsPort} + ${mcpPort} not listening — server not running`, startHint, {
      ws,
      mcp,
    });
  } else {
    r.warn(
      `Partial: port ${wsPort} ${ws ? "up" : "down"}, port ${mcpPort} ${mcp ? "up" : "down"}`,
      "Server may be starting up or partially crashed",
      { ws, mcp },
    );
  }

  return { ws, mcp };
}

// ── Check: orphaned Vite dev server (dev repo only) ─────────────────
//
// A crashed/half-killed `dev:standalone` can leave the Vite client process
// serving :5173 while the backend (:3478/:3479) is gone — the editor loads
// but nothing works, a confusing state worth naming. Gated behind
// isTandemEditorRepo like npm-staleness: end users legitimately run other
// things on :5173.

/** Vite dev-server port (`server.port` in vite.config.ts). */
const VITE_DEV_PORT = 5173;

export interface OrphanedViteInput {
  viteUp: boolean;
  /**
   * Whether `/@vite/client` on :5173 answered 200 — i.e. the listener is
   * really a Vite dev server and not merely something on Vite's port.
   */
  viteConfirmed: boolean;
  wsUp: boolean;
  mcpUp: boolean;
  wsPort: number;
  mcpPort: number;
  /** The port probed — {@link VITE_DEV_PORT} in production. */
  vitePort: number;
}

/**
 * Pure decision step for the orphaned-Vite check. Null when nothing is
 * listening on the Vite port — nothing to diagnose either way, and not a skip worth
 * announcing.
 */
export function evaluateOrphanedVite(input: OrphanedViteInput): EvalOutcome | null {
  const { viteUp, viteConfirmed, wsUp, mcpUp, wsPort, mcpPort, vitePort } = input;
  if (!viteUp) return null;

  // A TCP connect proves only that SOMETHING holds the port. Every branch
  // below names the process ("Vite dev server") and one of them escalates to
  // "kill it" — claims a TCP probe cannot support. :5173 is Vite's default,
  // not Vite's property.
  if (!viteConfirmed) {
    return {
      status: "skip",
      message:
        `cannot identify the process on :${vitePort} — it is listening but did not ` +
        "answer /@vite/client, so it is probably not a Vite dev server",
      data: { vite: false, ws: wsUp, mcp: mcpUp, reason: "unconfirmed-vite" },
    };
  }

  if (!wsUp && !mcpUp) {
    return {
      status: "warn",
      message:
        `Vite dev server on :${vitePort} is running but the backend ` +
        `(:${wsPort} + :${mcpPort}) is down — likely orphaned by a crashed dev session`,
      fix:
        `If you meant to run the client alone (npm run dev:client), this is expected. ` +
        `Otherwise kill the process on :${vitePort} and restart: npm run dev:standalone`,
      data: { vite: true, ws: wsUp, mcp: mcpUp },
    };
  }

  // Half a backend is not "running alongside the backend". This used to
  // report a confident green while :3478 or :3479 was down — the ports check
  // warns about that, and this check must not contradict it with a pass.
  if (wsUp !== mcpUp) {
    return {
      status: "skip",
      message:
        `cannot tell whether the Vite dev server on :${vitePort} is orphaned — ` +
        `the backend is only partially up (:${wsPort} ${wsUp ? "up" : "down"}, ` +
        `:${mcpPort} ${mcpUp ? "up" : "down"}); see the ports check`,
      data: { vite: true, ws: wsUp, mcp: mcpUp, reason: "partial-backend" },
    };
  }

  return {
    status: "pass",
    message: `Vite dev server (:${vitePort}) running alongside the backend`,
    data: { vite: true, ws: wsUp, mcp: mcpUp },
  };
}

async function checkOrphanedVite(
  r: Recorder,
  wsUp: boolean,
  mcpUp: boolean,
  wsPort: number,
  mcpPort: number,
  vitePort: number,
): Promise<void> {
  const viteUp = await probePort(vitePort);
  // Only ask WHO is on the port once we know someone is.
  const viteConfirmed = viteUp ? await isViteDevServer(vitePort) : false;
  recordEvaluation(
    r,
    evaluateOrphanedVite({ viteUp, viteConfirmed, wsUp, mcpUp, wsPort, mcpPort, vitePort }),
  );
}

// ── Check: /health endpoint ─────────────────────────────────────────

interface HttpGetResult {
  status?: number;
  data?: { version?: string; transport?: string; hasSession?: boolean } | null;
  error?: string;
}

/**
 * Response bodies are capped at 256 KB.
 *
 * This reader was written when `/health` on Tandem's own loopback server was
 * its only target — a small, known, trusted JSON document. The orphaned-Vite
 * check points it at whatever arbitrary process happens to hold :5173, so the
 * body is now untrusted input and an unbounded `body += chunk` is a
 * memory-exhaustion footgun in a diagnostic that is supposed to be the safe
 * thing you run when something is already wrong. (Compare the existing
 * `maxBuffer: 8MB` on the `npm ls` exec.) Every legitimate target is orders of
 * magnitude under the cap; over it, we stop reading and report the status.
 */
const HTTP_MAX_BYTES = 256 * 1024;

function httpGet(url: string, timeoutMs = 3000): Promise<HttpGetResult | null> {
  return new Promise((resolve) => {
    const req = request(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      let bytes = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer | string) => {
        if (truncated) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > HTTP_MAX_BYTES) {
          truncated = true;
          // Stop reading; the status line is all any caller needs at this size.
          res.destroy();
          resolve({ status: res.statusCode, data: null });
          return;
        }
        body += chunk;
      });
      res.on("end", () => {
        if (truncated) return;
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

/**
 * Confirm the listener on `port` is actually a Vite dev server.
 *
 * Keys on the STATUS, not the body. `HttpGetResult.data` is typed for
 * `/health`'s JSON and `httpGet` JSON-parses — but `/@vite/client` serves
 * JavaScript, so `data` is unconditionally null here and testing it would
 * reject every real Vite server. A 200 on Vite's own client-runtime module is
 * the signal; anything else (404 from an unrelated server, a connection error,
 * a timeout) is a no.
 *
 * `/@vite/client` is served under every config we ship: no `base` is set, and
 * both `dev` and `dev:client` are bare `vite`. (`preview` is :4173 — out of
 * scope.) A short timeout because this runs inside the synchronous
 * Copy-Diagnostics path.
 */
async function isViteDevServer(port: number): Promise<boolean> {
  const result = await httpGet(`http://127.0.0.1:${port}/@vite/client`, 2000);
  return result?.status === 200;
}

async function checkHealth(r: Recorder, mcpPort: number, startHint: string): Promise<boolean> {
  const result = await httpGet(`http://127.0.0.1:${mcpPort}/health`);

  if (!result) {
    r.fail(`Server not responding on 127.0.0.1:${mcpPort}`, startHint);
    return false;
  }

  if (result.error) {
    r.fail(`Server not responding on 127.0.0.1:${mcpPort} (${result.error})`, startHint);
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

function checkSseEndpoint(r: Recorder, mcpPort: number): Promise<void> {
  return new Promise((resolve) => {
    const req = request(`http://127.0.0.1:${mcpPort}/api/events`, { timeout: 2000 }, (res) => {
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
    // Current locks are v2 JSON (`{pid, startedAtMs, app}`, #1077); older ones
    // are a bare PID. parseLockfile reads both and returns null for true garbage.
    const lock = parseLockfile(raw);
    if (lock === null) {
      r.warn(
        `Annotation store lock at ${lockPath} has unparseable content: "${raw}"`,
        "Restart Tandem or delete the lock file if no server is running.",
        { lockHeld: true, lockPath, lockContent: raw },
      );
      return;
    }
    const { pid } = lock;
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
 * Three-tier summary line shared by `runDoctor` and the `/api/diagnostics`
 * route's filtered recomputation — keep wording in one place.
 */
export function summarizeDoctorResults(failures: number, warnings: number): string {
  if (failures > 0) return `${failures} issue(s) found.`;
  if (warnings > 0)
    return `${warnings} warning(s) — Tandem should work, but check the items above.`;
  return "All checks passed. Tandem is ready.";
}

// ── Check: stale global tandem-editor ───────────────────────────────
//
// The `tandem` MCP bridge is launched via `npx -y tandem-editor@<v> mcp-stdio`.
// A globally-installed `tandem-editor` whose version predates the `mcp-stdio`
// subcommand USED to be silently reused by `npx` (the exact "Server disconnected"
// failure). The version pin now bypasses it, but a stale/foreign global can still
// bite a hand-typed `npx tandem-editor` — so surface it. Runs inside the
// synchronous Copy-Diagnostics path, so it MUST be time-bounded and non-fatal:
// npm being absent (bundled-node Tauri sidecar), unreachable, or slow is a SKIP,
// never a fail.

/** Resolve a global `tandem-editor` version, or null when it can't be determined. */
export function globalTandemEditorVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    // shell:true so Windows resolves the `npm.cmd` shim (bare execFile("npm")
    // ENOENTs there). Args are all static — no injection surface.
    execFile(
      "npm",
      ["ls", "-g", "--depth=0", "--json", "tandem-editor"],
      { shell: true, windowsHide: true, timeout: 4000, maxBuffer: 8 * 1024 * 1024 },
      (_err, stdout) => {
        // `npm ls` exits non-zero on unrelated global peer issues but still
        // prints JSON to stdout, so parse stdout regardless of the exit code.
        if (!stdout || stdout.trim().length === 0) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            dependencies?: Record<string, { version?: string }>;
          };
          resolve(parsed.dependencies?.["tandem-editor"]?.version ?? null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Pure decision step, split out of {@link checkStaleGlobal} so the
 * match/mismatch/nothing-to-report logic is directly unit-testable without
 * needing to fake the tsup-injected `__TANDEM_VERSION__` global or mock
 * `child_process` — see tests/cli/doctor.test.ts.
 */
export function evaluateStaleGlobal(
  bundled: string,
  globalVersion: string | null,
): {
  status: "pass" | "warn";
  message: string;
  fix?: string;
  data?: Record<string, unknown>;
} | null {
  if (globalVersion === null) {
    // No global install (the common, healthy case) or npm unavailable. Either
    // way there's nothing that can shadow the pinned npx spec.
    return null;
  }

  if (globalVersion === bundled) {
    return { status: "pass", message: `Global tandem-editor@${globalVersion} matches this build` };
  }

  return {
    status: "warn",
    message:
      `Global tandem-editor@${globalVersion} differs from this build (${bundled}) — ` +
      "a stale global can break `npx tandem-editor` (e.g. Claude Desktop's MCP bridge).",
    fix: "npm uninstall -g tandem-editor   (or: npm install -g tandem-editor@latest)",
    data: { globalVersion, bundledVersion: bundled },
  };
}

async function checkStaleGlobal(r: Recorder): Promise<void> {
  const bundled = typeof __TANDEM_VERSION__ !== "undefined" ? __TANDEM_VERSION__ : null;
  // Without a known bundled version (tsx dev / vitest) there's nothing to
  // compare against — skip silently rather than guess.
  if (!bundled) return;

  let globalVersion: string | null;
  try {
    globalVersion = await globalTandemEditorVersion();
  } catch {
    // npm absent / spawn failure / timeout — skip, never fail.
    return;
  }

  const result = evaluateStaleGlobal(bundled, globalVersion);
  if (!result) return;

  if (result.status === "pass") {
    r.pass(result.message);
  } else {
    r.warn(result.message, result.fix, result.data);
  }
}

export interface RunDoctorOptions {
  /** WebSocket (Hocuspocus) port to probe. Defaults to {@link DEFAULT_WS_PORT}. */
  wsPort?: number;
  /** MCP HTTP port to probe. Defaults to {@link DEFAULT_MCP_PORT}. */
  mcpPort?: number;
  /**
   * Vite dev-server port to probe. Defaults to {@link VITE_DEV_PORT}. Same
   * seam as wsPort/mcpPort: lets tests stand up a fake Vite on an ephemeral
   * port instead of contending for the real :5173 (which a running
   * `dev:client` would occupy).
   */
  vitePort?: number;
}

/**
 * Run every diagnostic check and return a structured report. Performs NO
 * `process.argv` reads and NEVER calls `process.exit`. Safe to call from tests
 * and from both CLI entry points. Embedders that know their live ports (the
 * `/api/diagnostics` route on a `TANDEM_PORT`-overridden server) pass them via
 * `opts` so the self-probe doesn't report "server not running".
 */
export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorReport> {
  const wsPort = opts.wsPort ?? DEFAULT_WS_PORT;
  const mcpPort = opts.mcpPort ?? DEFAULT_MCP_PORT;
  const vitePort = opts.vitePort ?? VITE_DEV_PORT;
  const r = new Recorder();
  // Resolve the dev-repo gate once — both gated checks share the answer.
  const cwd = process.cwd();
  const repo = probeTandemEditorRepo(cwd);
  const devRepo = repo === "yes";
  // "Server not running" fixes differ by install kind: a source checkout starts
  // the server with `npm run dev:standalone`; a global/desktop install has no
  // such script — the user launches the app (or `tandem`). Pointing global-install
  // users at `npm run dev:standalone` is a dead end (#new-user-friction audit).
  const startHint = devRepo
    ? "npm run dev:standalone"
    : "Launch the Tandem desktop app, or run `tandem` in a terminal";

  await r.check("node-version", () => checkNodeVersion(r));
  await r.check("node-modules", () => checkNodeModules(r));
  if (repo === "unreadable") {
    // A package.json we cannot read also silently disables both dev-repo
    // checks below — so say so instead of skipping as if this were simply
    // someone else's directory. This check is in DEV_REPO_CHECKS: it is
    // cwd-dependent, so /api/diagnostics strips it from field reports.
    await r.check("dev-repo", () =>
      r.warn(
        "package.json in the current directory could not be read — if this is the " +
          "tandem-editor checkout, the npm-staleness and orphaned-Vite checks are being skipped",
        "Check for merge-conflict markers or a truncated file: git checkout package.json",
      ),
    );
  }
  if (devRepo) {
    await r.check("npm-staleness", () => checkNpmStaleness(r, cwd));
  }
  await r.check("mcp-json", () => checkMcpJson(r));
  await r.check("user-mcp-config", () => checkUserMcpConfig(r));
  await r.check("claude-cli", () => checkClaudeCli(r));
  await r.check("annotation-store", () => checkAnnotationStore(r));
  await r.check("stale-global", () => checkStaleGlobal(r));

  // `check` returns undefined when the check crashed (it records its own
  // fail). Treating both ports as down is the honest reading: we did not
  // observe them up. Do NOT cast this away — see Recorder.check.
  const ports = await r.check("ports", () => checkPorts(r, wsPort, mcpPort, startHint));
  const ws = ports?.ws ?? false;
  const mcp = ports?.mcp ?? false;

  if (devRepo) {
    // Reuses the ws/mcp probe results from the ports check just above —
    // only :5173 gets a fresh probe.
    await r.check("orphaned-vite", () => checkOrphanedVite(r, ws, mcp, wsPort, mcpPort, vitePort));
  }

  if (mcp) {
    // A crashed health check means we never established health — don't run
    // the SSE check on an unverified server.
    const healthy = (await r.check("health", () => checkHealth(r, mcpPort, startHint))) ?? false;
    if (healthy) {
      await r.check("sse", () => checkSseEndpoint(r, mcpPort));
    }
  }

  return {
    ok: r.failures === 0,
    crashed: false,
    failures: r.failures,
    warnings: r.warnings,
    summary: summarizeDoctorResults(r.failures, r.warnings),
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
