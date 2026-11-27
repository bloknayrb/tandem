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
 *   (Ruling D3), and every `tandem@…` key Claude Code's own `plugin list
 *   --json` reports (smoke S1 on Windows: an account-synced `tandem@synced` is
 *   in no settings file), set to `false`, so the plugin's own bridge does not
 *   load beside the launcher's (probe 10). It holds nothing else, and no
 *   secret.
 *
 * Written fail-closed (R1.6): the directory is refused if it is a link or not
 * the current user's own; each file is created exclusively at a random final
 * name, `0600`, after an `lstat` that refuses anything present. Any failure
 * means the spawn launches with neither flag (R1.5), which is master's
 * behaviour. Deleted at the spawn's first bind (the MCP config, probe 11),
 * at its teardown, and by the boot sweep (R4.2, R1.9).
 *
 * Read back before the spawn (`runFileReadsBack`, called by `spawnOnce`): a
 * file that is missing or does not hold what was written refuses that spawn,
 * which then takes the crash-restart path (smoke S1: Claude Code silently
 * ignores a `--settings` file it cannot parse).
 *
 * This module imports no flag; the supervisor calls it only while ownership
 * is on (Ruling I).
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, lstatSync, readFileSync } from "node:fs";
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

/**
 * The ACL steps, injectable so a spawn test on Windows does not shell out to
 * PowerShell on every spawn. The real ones are covered by the run-files spec
 * in the `windows-acl-proof` job. Every one is a no-op off Windows.
 *
 * The contract (#2440):
 * - `assertOwned` refuses a directory the current user's SID does not own.
 * - `lockDir` locks the directory AND re-reads its ACL, and throws when an
 *   entry the check refuses (Everyone, Authenticated Users, `BUILTIN\Users`)
 *   remains after the lock. That re-read is the folder's ONLY ACL read:
 *   `ensureLauncherDir` does no folder read of its own.
 * - `verifyNoBroadAce` is the per-file check, run by `writeRunFile` on each
 *   new run file while it is still empty.
 *
 * A test double for a lock that passes may be a no-op; a test whose subject
 * is the folder's verification must call the real `lockDir` with the real
 * acl-win module. #2440's later, faster reader replaces how these read, not
 * what they refuse: it must keep the proof spec's case "an explicit Everyone
 * entry on launcher/ is refused by the lock's own read" passing unchanged.
 */
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
        // Pinned to Node and the bridge script, with no flags. This bridge is
        // only ever given a loopback URL (`loopbackBaseUrl`: `127.0.0.1` or
        // `[::1]`), and since #2422 its requests there go through
        // `loopbackFetch`'s proxy-free agent, which no proxy setting reaches
        // (`src/shared/loopback-fetch.ts`); the bridge reads no proxy
        // variable. The settings that turn Node's environment proxy on without
        // a variable the environment shows are `--use-env-proxy` given as an
        // argument, which these pinned arguments never pass; a Node config
        // file (`--experimental-config-file` or
        // `--experimental-default-config-file`, which Node refuses in
        // `NODE_OPTIONS`, so again only these arguments could pass one); and
        // proxy variables deleted from `process.env` after start-up (Node
        // fixes its dispatcher at start; nothing in the bridge deletes them).
        // None of them reaches the bridge's loopback requests.
        command: opts.nodePath,
        args: [opts.bridgeScript],
        env: {
          [OWNER_HANDLE_ENV]: opts.handle,
          [OWNER_HANDLE_URL_ENV]: opts.baseUrl,
          TANDEM_URL: opts.baseUrl,
          // `resolveTandemUrl` reads this before `TANDEM_URL` and skips a blank
          // value: an inherited one (even another spelling of this address)
          // would leave the launcher's own child connected but never bound.
          CLAUDE_PLUGIN_OPTION_SERVER_URL: "",
          // An inherited `--report-on-*` or `--inspect` would expose the
          // bridge's environment. An entry's `env` wins over the environment
          // Claude Code passes, key by key: measured on Linux (smoke S4,
          // 2026-11-26, the bridge's `/proc` environment) and on Windows (the
          // same day, by behaviour: a project `NODE_OPTIONS` naming a missing
          // preload killed the other Tandem servers in that run while this
          // bridge bound), Claude Code 2.1.332 on both. Not measured on macOS.
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

/** How long the installed-plugin lookup may take before the spawn goes on
 * without it (smoke S1 on Windows; Bryan, 2026-11-26). Measured at about 0.6 s
 * on Linux (Claude Code 2.1.332, 18 plugins). */
export const PLUGIN_LIST_DEADLINE_MS = 5_000;
/** The lookup's stdout cap; past it the answer is unparseable (fail safe). */
export const PLUGIN_LIST_MAX_BYTES = 1024 * 1024;
/** A plugin key the lookup may put in the run settings file: `tandem@` and a
 * marketplace name of plain characters. Anything else is ignored. */
const TANDEM_PLUGIN_KEY_RE = /^tandem@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Why the installed-plugin lookup gave no answer: a closed set, logged as is. */
export type PluginListFailure = "timeout" | "exit" | "spawn" | "unparseable";
export type PluginListLookup =
  | { ok: true; keys: string[] }
  | { ok: false; reason: PluginListFailure };

/**
 * The `tandem@…` ids in `claude plugin list --json`'s output, or `null` when
 * it is not the array of `{ id }` objects Claude Code prints. Every Tandem id
 * it reports, enabled or not: a `false` for a disabled one changes nothing.
 */
export function tandemKeysFromPluginList(stdout: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const keys = new Set<string>();
  for (const entry of parsed) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && TANDEM_PLUGIN_KEY_RE.test(id)) keys.add(id);
  }
  if (keys.size > SETTINGS_READ_MAX_KEYS) return null;
  return [...keys].sort();
}

/** The `execFile` shape the lookup uses, injectable for tests. */
export type PluginListExec = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    killSignal: NodeJS.Signals;
    encoding: "utf8";
  },
  callback: (
    err: (Error & { killed?: boolean; code?: unknown; signal?: unknown }) | null,
    stdout: string,
  ) => void,
) => unknown;

/**
 * Ask Claude Code itself which Tandem plugins it has (smoke S1 on Windows;
 * Bryan, 2026-11-26, "Ask Claude Code (Recommended)"): `claude plugin list
 * --json`, run with the child's own binary, environment and working
 * directory, so it reports what that child would load. Settings files alone
 * miss a plugin enabled by account sync (`tandem@synced`), which no
 * `settings.json` names. Claude Code's installed-plugins registry file was
 * not used: it does not list a synced plugin (measured on Linux, Claude Code
 * 2.1.332: `installed_plugins.json` empty while `plugin list` reported
 * `tandem@synced`).
 *
 * Never rejects and never logs a key. A failure answers its reason, and the
 * caller writes the keys it found without it (fail safe).
 */
export function listInstalledTandemPluginKeys(opts: {
  claudeBin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  deadlineMs?: number;
  exec?: PluginListExec;
}): Promise<PluginListLookup> {
  const exec: PluginListExec = opts.exec ?? (execFile as unknown as PluginListExec);
  return new Promise<PluginListLookup>((resolve) => {
    try {
      exec(
        opts.claudeBin,
        ["plugin", "list", "--json"],
        {
          cwd: opts.cwd,
          env: opts.env,
          timeout: opts.deadlineMs ?? PLUGIN_LIST_DEADLINE_MS,
          maxBuffer: PLUGIN_LIST_MAX_BYTES,
          windowsHide: true,
          killSignal: "SIGKILL",
          encoding: "utf8",
        },
        (err, stdout) => {
          if (err) {
            // First: execFile kills a child past `maxBuffer` too, so this
            // error also arrives with `killed` set.
            if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              resolve({ ok: false, reason: "unparseable" });
            } else if (err.killed) resolve({ ok: false, reason: "timeout" });
            // A non-zero exit, or a signal from outside (a crash, another
            // process's kill): the child ran, so neither is a spawn failure.
            else if (typeof err.code === "number" || typeof err.signal === "string") {
              resolve({ ok: false, reason: "exit" });
            } else resolve({ ok: false, reason: "spawn" });
            return;
          }
          const keys = tandemKeysFromPluginList(String(stdout));
          resolve(keys === null ? { ok: false, reason: "unparseable" } : { ok: true, keys });
        },
      );
    } catch {
      resolve({ ok: false, reason: "spawn" });
    }
  });
}

/**
 * Every key Ruling D3 names: each `tandem@…` key set to `true` in the user
 * settings file, and in the project and local settings files of the child's
 * working directory, plus {@link ALWAYS_DISABLED_PLUGIN_KEY} and every key in
 * `installed` (the installed-plugin lookup's answer, when it gave one).
 * Deduplicated, sorted. Never fails and never logs a key.
 */
export async function collectTandemPluginKeys(opts: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home?: string;
  deadlineMs?: number;
  installed?: readonly string[];
}): Promise<string[]> {
  const deadline = opts.deadlineMs ?? SETTINGS_READ_DEADLINE_MS;
  const keys = new Set<string>([ALWAYS_DISABLED_PLUGIN_KEY, ...(opts.installed ?? [])]);
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

/**
 * Windows only: directories whose owner check, lock and re-read already passed
 * in this process, keyed by path, valued by the identity they had then
 * (#2358 PR 3a review, item 4: about five PowerShell starts per spawn, before
 * the child starts). Re-run whenever the identity changes (a directory removed
 * and recreated, or swapped). This weakens nothing against another user
 * unless `launcher/`'s ACL has already been weakened by someone holding
 * WRITE_DAC on it (the user as its owner, an administrator, SYSTEM): once
 * locked, only they can change it, and the user can read the run files
 * anyway. The residual: an EXPLICIT, NON-INHERITABLE broad ACE added to
 * `launcher/` after the first check is not seen again in this process (no new
 * file inherits it, so each file's re-read passes; an inheritable one reaches
 * the new file and its re-read fails closed). If that ACE grants list rights,
 * other users could list the run files' names, not read the files; if it also
 * grants delete-child and add-file (a Full Control grant does; the names are
 * random, so listing is needed too), they could delete a run file and put
 * their own at its name before Claude Code reads it, so that Claude Code runs
 * their MCP config's `command` (or their settings' hooks) as the user. Bryan
 * accepted this residual on 2026-11-17 (#2439; batching the permission checks
 * is #2440). Each file's own ACL is still re-read per spawn. The `lstat` link
 * check above it runs every time.
 */
const verifiedWindowsDirs = new Map<string, string>();

/** Test-only: forget the per-process Windows directory verifications. */
export function resetVerifiedLauncherDirsForTests(): void {
  verifiedWindowsDirs.clear();
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
    const identity = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
    if (verifiedWindowsDirs.get(dir) !== identity) {
      verifiedWindowsDirs.delete(dir);
      try {
        await acl.assertOwned(dir);
      } catch {
        throw new RunFileError("launcher-dir-not-owned");
      }
      try {
        // `lockDir` carries the folder's only ACL read (see `RunFileAcl`).
        await acl.lockDir(dir);
      } catch {
        throw new RunFileError("launcher-dir-acl");
      }
      verifiedWindowsDirs.set(dir, identity);
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
 *
 * **Already atomic for its one reader** (checked 2026-11-26 for Bryan's "write
 * both run files atomically"): the name is random and reaches Claude Code only
 * in the spawn's argv, after this call has written the whole text and closed
 * the handle; a failed write unlinks the file and throws, so no spawn is given
 * it, and a crash mid-write leaves a name nobody was given, for the boot sweep.
 * A temp-and-rename (`atomicWrite`, `atomicWriteConfigFile`) adds nothing for
 * that reader and would lose what R1.6 needs: those helpers neither refuse a
 * name already present nor re-read a new file's ACL while it is still empty,
 * `atomicWriteConfigFile`'s cross-device fallback writes in place, and a temp
 * name is one the strict sweep pattern does not match.
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
    if (process.platform === "win32") {
      try {
        await acl.verifyNoBroadAce(file);
      } catch {
        // A broad ACE reached the directory after it was verified (review round
        // 2, item 2): forget the verification so the next spawn checks and
        // locks the directory again. That heals a broad ACE `launcher/`
        // itself inherits only where `lockDir`'s `/inheritance:r` removes it. On Windows builds
        // where `:r` acts as `:d` (acl-win.ts, `setRestrictiveAcl`; GitHub's
        // Server 2025 image is one) it is copied as an explicit ACE, which the
        // re-read after the lock refuses, and from then on it is the explicit
        // case. An EXPLICIT broad ACE stays (`/grant:r` replaces only the
        // current user's own explicit ACE), so every later spawn refuses at
        // `launcher-dir-acl` and starts Claude without the run files ("Not
        // passing the run files"): fail closed, which is correct. Either ACE
        // can reach a locked `launcher/` only through someone holding
        // WRITE_DAC on it: the user or an administrator.
        verifiedWindowsDirs.delete(dir);
        throw new RunFileError(`${kind}-acl`);
      }
    }
    await handle.writeFile(runFileText(value), "utf8");
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

/** A run file's whole text: what `writeRunFile` writes, and so what
 * {@link runFileReadsBack} expects to find. */
export function runFileText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The pre-spawn read-back (#2358, smoke S1 on Linux, Claude Code 2.1.332;
 * Bryan's pick of 2026-11-26, "Guard it before the flip (Recommended)"). `ok`
 * only when `file` is a regular file, not a link, whose whole content is
 * exactly `expected`. A missing, emptied or truncated file fails (a truncated
 * one does not parse), and so does any other content than what was written.
 * Never throws, never logs, never returns what it read: a refusal carries only
 * a {@link RunFileReadBackReason}, a closed set with no path in it.
 *
 * **One retry, for a file another process holds open** (Bryan, 2026-11-26,
 * "Retry once, log the reason (Recommended)"): an antivirus scanner or a sync
 * client on Windows can hold a just-written file, and the read then fails with
 * EBUSY, EPERM or EACCES. On exactly those three codes, from the `lstat` or
 * the read, it waits {@link RUN_FILE_READ_BACK_RETRY_MS} once and reads again;
 * a second failure refuses with whatever that attempt found. Only those three,
 * Bryan's set: `TRANSIENT_READ_CODES` (supervisor.ts, the crash restart's
 * `integrations.json` read) adds EAGAIN, EMFILE and ENFILE, but that read
 * retries through the crash loop's backoff, and here a non-blocking read of a
 * FIFO answers EAGAIN, which must refuse at once rather than retry.
 *
 * Why it exists: Claude Code IGNORES a `--settings` file it cannot parse, with
 * no error, so the plugin's Tandem toolset loads beside the launcher's and a
 * second owner registers under the same Claude session: fail-open. A bad MCP
 * config already fails closed ("MCP config is not a valid JSON").
 *
 * **Synchronous on purpose**, so its caller (`spawnOnce`) adds no `await`
 * between the post-write re-checks (R1.8) and `spawn()`. That is also why the
 * retry's wait is a synchronous sleep (`Atomics.wait`) rather than a timer: it
 * blocks the server's event loop for at most 100 ms per file, and only when a
 * read already failed with one of the three codes, which on POSIX is almost
 * never. The other way to keep the invariant, an async read-back before the
 * re-checks, would widen the gap below and need a second copy at each of
 * `spawnOnce`'s two callers.
 *
 * **What it cannot close (TOCTOU).** Claude Code reads the files after it
 * starts, not when this runs: S1's strace saw the reads within about 0.5 s of
 * start, and the settings file stays on disk until the spawn's teardown. A
 * file changed in that gap is not seen here. So this catches a file already
 * missing or damaged before the spawn (a failing disk, a cleanup tool, an
 * antivirus quarantine), not a writer racing Claude Code's read; such a writer
 * needs write access to `launcher/`, which is the user's own processes, or on
 * Windows #2439's and #2441's cases (docs/security.md).
 *
 * The open is non-blocking: a FIFO swapped in between the `lstat` and the
 * read would otherwise block this synchronous read, and with it the server's
 * event loop, until a writer came (`O_NOFOLLOW` refuses a link, not a FIFO).
 * Non-blocking, such a read returns nothing or `EAGAIN`, and either fails the
 * comparison. Both flags are absent on Windows, where the `lstat` alone
 * refuses a link.
 */
export function runFileReadsBack(
  file: string,
  expected: string,
  /** Test-only: the file system calls and the retry's sleep. */
  io: RunFileReadBackIo = realReadBackIo,
): RunFileReadBack {
  const first = readBackOnce(file, expected, io);
  if (first.ok || !READ_BACK_RETRY_CODES.has(first.reason)) return first;
  io.sleep(RUN_FILE_READ_BACK_RETRY_MS);
  return readBackOnce(file, expected, io);
}

/** The read-back's one wait before its retry. */
export const RUN_FILE_READ_BACK_RETRY_MS = 100;

/** Errno codes kept as themselves in a reason; any other reads `"unreadable"`.
 * The first three are the ones retried (`READ_BACK_RETRY_CODES`). */
const READ_BACK_ERRNO_REASONS = [
  "EBUSY",
  "EPERM",
  "EACCES",
  "EAGAIN",
  "ELOOP",
  "EISDIR",
  "EMFILE",
  "ENFILE",
  "EIO",
] as const;
const READ_BACK_RETRY_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES"]);

/**
 * Why a run file did not read back. A closed set, so the refusal's log line
 * can carry it: `missing` (no file at the name), `not-regular` (a link, a
 * directory, anything but a regular file), `size` (not the length written, as a
 * truncated file is), `content` (the right length, other bytes), one of a fixed
 * list of errno codes, or `unreadable` for any other errno.
 */
export const RUN_FILE_READ_BACK_REASONS = [
  "missing",
  "not-regular",
  "size",
  "content",
  ...READ_BACK_ERRNO_REASONS,
  "unreadable",
] as const;
export type RunFileReadBackReason = (typeof RUN_FILE_READ_BACK_REASONS)[number];

export type RunFileReadBack = { ok: true } | { ok: false; reason: RunFileReadBackReason };

/** The calls the read-back makes, injectable so a test can fail one. */
export interface RunFileReadBackIo {
  lstat(file: string): { isFile(): boolean; size: number };
  read(file: string, flag: number): string;
  sleep(ms: number): void;
}

const realReadBackIo: RunFileReadBackIo = {
  lstat: (file) => lstatSync(file),
  read: (file, flag) => readFileSync(file, { encoding: "utf8", flag }),
  sleep: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

function errnoReason(err: unknown): RunFileReadBackReason {
  const code = errCode(err);
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  return (READ_BACK_ERRNO_REASONS as readonly string[]).includes(code ?? "")
    ? (code as RunFileReadBackReason)
    : "unreadable";
}

function readBackOnce(file: string, expected: string, io: RunFileReadBackIo): RunFileReadBack {
  try {
    const st = io.lstat(file);
    if (!st.isFile()) return { ok: false, reason: "not-regular" };
    if (st.size !== Buffer.byteLength(expected, "utf8")) return { ok: false, reason: "size" };
    const flag =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    return io.read(file, flag) === expected ? { ok: true } : { ok: false, reason: "content" };
  } catch (err) {
    return { ok: false, reason: errnoReason(err) };
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
