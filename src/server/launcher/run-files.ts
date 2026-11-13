/**
 * The launcher's run files (#2358 PR 3a, Requirement 1; ownership design §3.3
 * route L).
 *
 * Per spawn of Tandem's own Claude, with ownership on, the launcher writes two
 * files into `<app-data>/launcher/` and passes both to the child:
 *
 * - the **run MCP config** (`--mcp-config`): one server, `tandem`, running the
 *   stdio bridge with this server's own Node, its `env` carrying the spawn's
 *   owner handle and this server's base URL. Probe 9 and probe 13 measured that
 *   an `--mcp-config` entry named `tandem` replaces the user's own entry of
 *   that name. It holds no auth token: a loopback caller needs none.
 * - the **run settings file** (`--settings`): every enabled Tandem plugin key
 *   (Ruling D3) set to `false`, so the plugin's own bridge does not load beside
 *   the launcher's (probe 10). It holds nothing else, and no secret.
 *
 * Written fail-closed (R1.6): the directory is refused if it is a link or not
 * the current user's own; each file is created exclusively at a random final
 * name, `0600`, after an `lstat` that refuses anything present. Any failure
 * means the spawn launches with neither flag (R1.5), which is master's
 * behaviour. Deleted at the spawn's first bind (the MCP config, probe 11),
 * at its teardown, and by the boot sweep (R4.2, R1.9).
 *
 * This module imports no flag; the supervisor calls it only while ownership
 * is on (Ruling I).
 */

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readClaudeConfig } from "../../shared/claude-config-read.js";
import { OWNER_HANDLE_ENV, OWNER_HANDLE_URL_ENV } from "../../shared/owner-handle.js";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";
import {
  assertNoBroadAce,
  assertOwnedByCurrentUser,
  setRestrictiveAcl,
} from "../integrations/acl-win.js";

/** The directory under the app-data root that holds the run files. */
export const LAUNCHER_DIR_NAME = "launcher";

/** The two kinds of run file and their strict name patterns (32 hex chars). */
export const RUN_FILE_PREFIX = {
  mcp: "tandem-run-mcp-",
  settings: "tandem-run-settings-",
} as const;
export type RunFileKind = keyof typeof RUN_FILE_PREFIX;
export const RUN_FILE_NAME_RE = /^tandem-run-(?:mcp|settings)-[0-9a-f]{32}\.json$/;

/** The boot sweep's age gate (Ruling D13): the orphaned-temp reaper's hour. */
export const RUN_FILE_SWEEP_AGE_MS = 60 * 60 * 1000;

/** This repository's own marketplace key, disabled always (Ruling D3). */
export const ALWAYS_DISABLED_PLUGIN_KEY = "tandem@tandem-editor";

/** R1.4's caps on a settings file the launcher reads. */
export const SETTINGS_READ_MAX_BYTES = 64 * 1024;
export const SETTINGS_READ_MAX_KEYS = 256;
export const SETTINGS_READ_DEADLINE_MS = 2_000;

/** A fail-closed step that refused, named for the one log line R1.5 allows.
 * Its message never quotes a file's contents. */
export class RunFileError extends Error {
  readonly step: string;
  constructor(step: string, detail?: string) {
    super(detail ? `${step}: ${detail}` : step);
    this.name = "RunFileError";
    this.step = step;
  }
}

/** The ACL steps, injectable so a spawn test on Windows does not shell out to
 * PowerShell on every spawn. The real ones are covered by the run-files spec
 * in the `windows-acl-proof` job. Every one is a no-op off Windows. */
export interface RunFileAcl {
  assertOwned: (p: string) => Promise<void>;
  lockDir: (p: string) => Promise<void>;
  verifyNoBroadAce: (p: string) => Promise<void>;
}

const ACL_TIMEOUT_MS = 60_000;

export const realRunFileAcl: RunFileAcl = {
  assertOwned: (p) => assertOwnedByCurrentUser(p, { signal: AbortSignal.timeout(ACL_TIMEOUT_MS) }),
  lockDir: (p) =>
    setRestrictiveAcl(p, { inheritable: true, signal: AbortSignal.timeout(ACL_TIMEOUT_MS) }),
  verifyNoBroadAce: (p) => assertNoBroadAce(p, { signal: AbortSignal.timeout(ACL_TIMEOUT_MS) }),
};

export function launcherDirFor(appData: string): string {
  return path.join(appData, LAUNCHER_DIR_NAME);
}

/**
 * This server's base URL for the run MCP config (Ruling D14): scheme, host and
 * port, no path (`createUpstream` appends `/mcp`), from the address the server
 * actually bound — `127.0.0.1` or `::1` only, IPv6 in brackets. `null` for any
 * other address, which means no flags (R1.5).
 */
export function loopbackBaseUrl(
  bound: { address: string; port: number } | null | undefined,
): string | null {
  if (!bound || !Number.isInteger(bound.port) || bound.port <= 0 || bound.port > 65535) {
    return null;
  }
  if (bound.address === "127.0.0.1") return `http://127.0.0.1:${bound.port}`;
  if (bound.address === "::1") return `http://[::1]:${bound.port}`;
  return null;
}

/** The run MCP config's content (R1.2). */
export function buildRunMcpConfig(opts: {
  nodePath: string;
  bridgeScript: string;
  baseUrl: string;
  handle: string;
}): { mcpServers: { tandem: { command: string; args: string[]; env: Record<string, string> } } } {
  return {
    mcpServers: {
      tandem: {
        command: opts.nodePath,
        args: [opts.bridgeScript],
        env: {
          [OWNER_HANDLE_ENV]: opts.handle,
          [OWNER_HANDLE_URL_ENV]: opts.baseUrl,
          TANDEM_URL: opts.baseUrl,
          // An inherited `--report-on-*` or `--inspect` would expose the
          // bridge's environment. Whether an entry's `env` wins over the
          // environment Claude Code passes is unmeasured; if it does not, this
          // clears nothing (a residual, docs/security.md).
          NODE_OPTIONS: "",
          // `NODE_DEBUG=http,fetch,…` would print request headers, the handle's
          // among them, to the bridge's stderr, which Claude Code captures.
          NODE_DEBUG: "",
        },
      },
    },
  };
}

/** The run settings file's content (R1.3): each key set to `false`, nothing else. */
export function buildRunSettings(keys: readonly string[]): {
  enabledPlugins: Record<string, false>;
} {
  const enabledPlugins: Record<string, false> = {};
  for (const key of keys) enabledPlugins[key] = false;
  return { enabledPlugins };
}

/** The enabled `tandem@…` keys of one parsed settings object, or `null` when it
 * has more `enabledPlugins` entries than R1.4's cap (that file is dropped). */
function enabledTandemKeys(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null) return [];
  const plugins = (value as { enabledPlugins?: unknown }).enabledPlugins;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return [];
  const entries = Object.entries(plugins as Record<string, unknown>);
  if (entries.length > SETTINGS_READ_MAX_KEYS) return null;
  return entries.filter(([k, v]) => k.startsWith("tandem@") && v === true).map(([k]) => k);
}

/**
 * Read one settings file that may sit in a document's folder and be hostile
 * (R1.4): a UNC path is refused before any I/O; only a regular file, judged by
 * `lstat`, is read, never through a link (the `.claude` folder is checked too,
 * and POSIX opens with `O_NOFOLLOW`); size and key count are capped. Any
 * failure returns `[]` — that file's keys are dropped, the spawn goes on.
 */
export async function readHostileSettingsKeys(file: string): Promise<string[]> {
  if (rejectUnsafeWindowsPrefix(file) !== null) return [];
  let handle: fsp.FileHandle | undefined;
  try {
    const dirStat = await fsp.lstat(path.dirname(file));
    if (!dirStat.isDirectory()) return [];
    const before = await fsp.lstat(file);
    if (!before.isFile() || before.size > SETTINGS_READ_MAX_BYTES) return [];
    const flags =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    handle = await fsp.open(file, flags);
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.size > SETTINGS_READ_MAX_BYTES ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      return [];
    }
    const buf = Buffer.alloc(SETTINGS_READ_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > SETTINGS_READ_MAX_BYTES) return [];
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return enabledTandemKeys(JSON.parse(text)) ?? [];
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The user-level settings file (Ruling D3): `settings.json` in the child's
 * `CLAUDE_CONFIG_DIR` when set, otherwise the home default, read through the
 * UNC-screened loader `tandem doctor` uses. A link is followed here: this is
 * the user's own file, not a document folder's. */
function userSettingsKeys(env: NodeJS.ProcessEnv, home: string): string[] {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const base = configDir ? configDir : home ? path.join(home, ".claude") : "";
  if (!base || rejectUnsafeWindowsPrefix(base) !== null) return [];
  const read = readClaudeConfig(path.join(base, "settings.json"));
  if (read.kind !== "ok") return [];
  return enabledTandemKeys(read.value) ?? [];
}

/** Resolve within `ms`, or to `fallback` (the work may still be running; its
 * result is ignored). */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Every key Ruling D3 names: each `tandem@…` key set to `true` in the user
 * settings file, and in the project and local settings files of the child's
 * working directory, plus {@link ALWAYS_DISABLED_PLUGIN_KEY}. Deduplicated,
 * sorted. Never fails and never logs a key.
 */
export async function collectTandemPluginKeys(opts: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home?: string;
  deadlineMs?: number;
}): Promise<string[]> {
  const deadline = opts.deadlineMs ?? SETTINGS_READ_DEADLINE_MS;
  const keys = new Set<string>([ALWAYS_DISABLED_PLUGIN_KEY]);
  let user: string[] = [];
  try {
    user = userSettingsKeys(opts.env, opts.home ?? os.homedir());
  } catch {
    user = [];
  }
  for (const k of user) keys.add(k);
  const claudeDir = path.join(opts.cwd, ".claude");
  for (const name of ["settings.json", "settings.local.json"]) {
    const found = await withDeadline(
      readHostileSettingsKeys(path.join(claudeDir, name)),
      deadline,
      [],
    );
    for (const k of found) keys.add(k);
  }
  return [...keys].sort();
}

function errCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** POSIX: is this the current user's own? Windows answers through the ACL. */
function ownedByMe(st: { uid: number }): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  return st.uid === process.getuid();
}

/**
 * Refuse `launcher/` unless it is a real directory (not a link or reparse
 * point) owned by the current user (R1.6). `create` makes it (`0700`) when
 * absent; the boot sweep passes `false`. Returns false only when it is absent
 * and `create` is false. On Windows the ACL is locked and then re-read.
 */
export async function ensureLauncherDir(
  dir: string,
  opts: { create: boolean; acl?: RunFileAcl } = { create: true },
): Promise<boolean> {
  const acl = opts.acl ?? realRunFileAcl;
  if (rejectUnsafeWindowsPrefix(dir) !== null) throw new RunFileError("launcher-dir-unsafe-path");
  if (opts.create) {
    try {
      await fsp.mkdir(dir, { mode: 0o700 });
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw new RunFileError("launcher-dir-create", errCode(err));
    }
  }
  let st: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    st = await fsp.lstat(dir);
  } catch (err) {
    if (errCode(err) === "ENOENT" && !opts.create) return false;
    throw new RunFileError("launcher-dir-stat", errCode(err));
  }
  if (st.isSymbolicLink()) throw new RunFileError("launcher-dir-is-a-link");
  if (!st.isDirectory()) throw new RunFileError("launcher-dir-not-a-directory");
  if (!ownedByMe(st)) throw new RunFileError("launcher-dir-not-owned");
  if (process.platform === "win32") {
    try {
      await acl.assertOwned(dir);
    } catch {
      throw new RunFileError("launcher-dir-not-owned");
    }
    try {
      await acl.lockDir(dir);
      await acl.verifyNoBroadAce(dir);
    } catch {
      throw new RunFileError("launcher-dir-acl");
    }
  } else if ((Number(st.mode) & 0o077) !== 0) {
    try {
      await fsp.chmod(dir, 0o700);
    } catch (err) {
      throw new RunFileError("launcher-dir-chmod", errCode(err));
    }
  }
  return true;
}

/**
 * Create one run file exclusively at a random final name, `0600`, with no temp
 * file and rename (R1.6). Immediately before the create, `lstat` the name and
 * refuse anything present (a file, a link, a dangling link). On Windows Node's
 * exclusive create follows a dangling link and there is no `O_NOFOLLOW`, so the
 * window between the `lstat` and the create remains (a residual). Returns the
 * file's path; on failure, deletes what this call created and throws.
 */
export async function writeRunFile(
  dir: string,
  kind: RunFileKind,
  value: unknown,
  acl: RunFileAcl = realRunFileAcl,
  /** Test-only: the 32-hex suffix, so a test can plant something at the name. */
  suffix: string = randomBytes(16).toString("hex"),
): Promise<string> {
  const file = path.join(dir, `${RUN_FILE_PREFIX[kind]}${suffix}.json`);
  try {
    await fsp.lstat(file);
    throw new RunFileError(`${kind}-name-present`);
  } catch (err) {
    if (err instanceof RunFileError) throw err;
    if (errCode(err) !== "ENOENT") throw new RunFileError(`${kind}-name-stat`, errCode(err));
  }
  let created = false;
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file, "wx", 0o600);
    created = true;
    // Windows: re-read the new file's ACL while it is still EMPTY, so a broad
    // inherited grant refuses the step before the handle is ever in it.
    if (process.platform === "win32") await acl.verifyNoBroadAce(file);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    return file;
  } catch (err) {
    await handle?.close().catch(() => {});
    if (created) await fsp.unlink(file).catch(() => {});
    if (err instanceof RunFileError) throw err;
    throw new RunFileError(`${kind}-write`, errCode(err));
  }
}

/** Delete one run file, tolerating its absence. Never throws. */
export async function deleteRunFile(file: string): Promise<void> {
  try {
    await fsp.unlink(file);
  } catch (err) {
    if (errCode(err) !== "ENOENT") {
      console.error(`[Launcher] Could not delete run file ${file}: ${errCode(err) ?? "error"}`);
    }
  }
}

/**
 * The boot sweep (R1.9): delete leftover run files older than an hour. The
 * caller runs it only while this process holds the store lock. `launcher/`
 * itself is refused first (a link, not a directory, not the current user's);
 * then only names matching the strict pattern, directly in it, never through
 * a link, never recursively. The age gate, not the lock, is what makes this
 * safe against an instance starting at the same moment (CLAUDE.md, reaper
 * rule). Returns how many it deleted; never throws.
 */
export async function sweepRunFiles(
  dir: string,
  opts: { now?: number; acl?: RunFileAcl } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  try {
    if (!(await ensureLauncherDir(dir, { create: false, acl: opts.acl }))) return 0;
  } catch (err) {
    const step = err instanceof RunFileError ? err.step : "launcher-dir";
    console.error(`[Launcher] Run-file sweep skipped: ${step}`);
    return 0;
  }
  let removed = 0;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!RUN_FILE_NAME_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = await fsp.lstat(file);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs <= RUN_FILE_SWEEP_AGE_MS) continue;
      await fsp.unlink(file);
      removed++;
    } catch {
      // Gone already, or not ours to judge: leave it.
    }
  }
  if (removed > 0) console.error(`[Launcher] Swept ${removed} leftover run file(s)`);
  return removed;
}
