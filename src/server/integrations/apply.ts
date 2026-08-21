/**
 * Library helpers for applying Tandem's MCP entries to a Claude (or other
 * MCP-capable) client's config file. Shared by the wizard's apply route,
 * `tandem setup`, and `tandem rotate-token`.
 *
 * Hardening invariants enforced here (callers MUST NOT bypass):
 * - `assertPathSafe()` rejects symlinks and any path whose realpath falls
 *   outside `[homedir(), tmpdir()]`. Prevents a compromised account from
 *   replacing `~/.claude.json` with a symlink to `/etc/shadow` or a
 *   Windows junction redirecting `~/.claude` into a protected dir.
 * - MSIX detection is anchored to `/^Claude_[A-Za-z0-9]+$/` and the
 *   `%LOCALAPPDATA%` realpath must resolve under home (defeats an
 *   attacker who controls env).
 * - Malformed JSON backups land in `${appDataDir}/.broken-backups/` at
 *   `0o600` rather than next to `~/.claude.json` (which may inherit
 *   world-readable perms and would leak co-tenant API keys).
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_CONTENT } from "../../cli/skill-content.js";
import { DEFAULT_MCP_PORT } from "../../shared/constants.js";
import { isAppTranslocatedPath } from "../../shared/integrations/app-translocation.js";
import {
  claudeCodeConfigPath,
  claudeDesktopConfigPath,
} from "../../shared/integrations/client-config-paths.js";
import { targetPushSupport } from "../../shared/integrations/contract.js";
import { isValidNodeBinary } from "../../shared/integrations/node-binary-name.js";
import {
  buildNpxStdioArgs,
  isCanonicalNpxStdioArgs,
} from "../../shared/integrations/npx-entry-spec.js";
import { isFile } from "../../shared/integrations/path-lookup.js";
import type { SkillRefreshError } from "../../shared/launcher/contract.js";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";
import { resolveAppDataDir } from "../platform.js";
import { setRestrictiveAcl } from "./acl-win.js";
import { backupDir, pruneOldBackups, shouldBackup, writeBackup } from "./backup.js";
import { BARE_NODE, isRecordedPathGone, resolveNodeBinary } from "./node-binary.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Paths are anchored to the package root. The CLI bundle (`dist/cli/`) and
// the server bundle (`dist/server/`) both sit one level below `dist/`, so
// `../..` resolves to the package root in either bundle. In tsx dev,
// `__dirname` is `src/server/integrations/`, so we need `../../..`.
const PACKAGE_ROOT = (() => {
  const fromBundle = resolve(__dirname, "../..");
  if (existsSync(join(fromBundle, "package.json"))) return fromBundle;
  return resolve(__dirname, "../../..");
})();
/**
 * Resolve the bundled channel-shim entry registered as Claude Code's push
 * transport.
 *
 * On a Tauri **desktop bundle** the `PACKAGE_ROOT` derivation above points at
 * the sidecar's own location, NOT the app's resource dir where `dist/channel/`
 * is bundled — so the computed path doesn't exist and `shouldRegisterChannelShim`
 * skips registration. The Tauri shell injects `TANDEM_CHANNEL_DIST` with the
 * resource-dir-resolved path on sidecar spawn (`src-tauri/src/lib.rs`); prefer
 * it when it points at an existing file. A bogus/missing injected path is
 * ignored so a broken injection degrades to the computed path rather than
 * registering an unresolvable MCP command. In npm-global / tsx-dev there is no
 * env var and the `PACKAGE_ROOT` derivation is correct.
 *
 * This replaces the old `/api/setup` startup round-trip, which used to be the
 * only path carrying the Tauri-resolved channel path (#477 PR 3c-ii-c).
 *
 * No UNC/traversal validation is applied to the injected path because the sole
 * setter is `resolve_channel_dist()` in `src-tauri/src/lib.rs` — trusted
 * same-user Rust code that emits `resource_dir/dist/channel/index.js` or
 * `cwd/dist/channel/index.js`. The path cannot arrive via any HTTP route.
 *
 * Exported (with `exists` injectable) so the env-precedence can be unit-tested
 * without re-importing the module to re-run the const initializer.
 */
function resolveBundledDist(
  envVar: "TANDEM_CHANNEL_DIST" | "TANDEM_STDIO_BRIDGE_DIST",
  relPath: string,
  consequence: string,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): string {
  const bundled = resolve(PACKAGE_ROOT, relPath);
  const injected = env[envVar];
  if (injected) {
    // macOS App Translocation: a quarantined `.app` on first launch runs from
    // `/private/var/folders/…/AppTranslocation/<uuid>/d/Tandem.app/…`, a
    // randomized read-only mount that is GONE on the next launch. Recording a
    // path from there produces config that works exactly once, and unlike an
    // absent path there is no later probe that can tell it was doomed. Refuse
    // it for BOTH bundles: translocation moves the whole `.app`, so the channel
    // shim has the identical problem — the only asymmetry is severity, which
    // belongs to the callers, not here.
    //
    // Matched on the path segment, not a prefix: the mount is under
    // `/private/var/folders/…` on some releases and `/var/folders/…` on others,
    // and only the literal directory name is stable. Separator-agnostic so a
    // Windows-shaped fixture read on Linux in CI cannot accidentally match.
    if (isAppTranslocatedPath(injected)) {
      console.error(
        `[Tandem] ${envVar} is under macOS App Translocation ("${injected}") — ` +
          `that path disappears on the next launch, so it will not be recorded. ` +
          `${consequence} Move Tandem.app to /Applications and reopen it.`,
      );
      return bundled;
    }
    if (exists(injected)) return injected;
    // Set-but-missing: a broken desktop injection would otherwise degrade with
    // no trace. Behaviour is unchanged (we still fall back); this only leaves a
    // diagnostic breadcrumb on stderr (Critical Rule #3-safe).
    console.error(
      `[Tandem] ${envVar} set to "${injected}" but no file there — ` +
        `falling back to bundled path. ${consequence}`,
    );
  }
  return bundled;
}

export function resolveChannelDist(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  return resolveBundledDist(
    "TANDEM_CHANNEL_DIST",
    "dist/channel/index.js",
    "Real-time push may be unavailable.",
    env,
    exists,
  );
}

const CHANNEL_DIST = resolveChannelDist();

/**
 * Resolve the bundled stdio-bridge entry embedded in the generated `tandem`
 * stdio entry (Claude Desktop and friends).
 *
 * Same contract as {@link resolveChannelDist}; see `src/stdio-bridge/index.ts`
 * for why this is a separate bundle from `dist/cli`.
 */
export function resolveStdioBridgeDist(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  return resolveBundledDist(
    "TANDEM_STDIO_BRIDGE_DIST",
    "dist/stdio-bridge/index.js",
    "The MCP entry will have to use npx, which the client must resolve on PATH.",
    env,
    exists,
  );
}

const STDIO_BRIDGE_DIST = resolveStdioBridgeDist();

const MCP_URL = `http://127.0.0.1:${DEFAULT_MCP_PORT}`;

// Injected by tsup at build time. apply.ts is bundled into BOTH `dist/cli`
// (carries `__TANDEM_VERSION__`) and `dist/server` (carries `__APP_VERSION__`),
// and neither define exists in both bundles. esbuild leaves a *bare* reference
// to an absent define as a free global → runtime ReferenceError (no build
// error), so each MUST be `typeof`-guarded — mirroring `APP_VERSION` in
// `src/server/mcp/server.ts`. The disk fallback only runs in tsx dev / vitest,
// where `__dirname` (src/server/integrations) resolves the repo-root
// package.json via the same two candidates server.ts uses.
declare const __TANDEM_VERSION__: string;
declare const __APP_VERSION__: string;
export function resolveCliVersion(): string {
  if (typeof __TANDEM_VERSION__ !== "undefined") return __TANDEM_VERSION__;
  if (typeof __APP_VERSION__ !== "undefined") return __APP_VERSION__;
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, rel), "utf8")) as { version: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next candidate
    }
  }
  console.error("[Tandem] Could not resolve CLI version for npx pin; using unpinned fallback");
  return "0.0.0-unknown";
}

// Pinning the npx spec to an exact version forces `npm exec` to fetch/run the
// correct published `tandem-editor` instead of reusing whatever (possibly
// stale, pre-`mcp-stdio`) global copy is installed — the root cause of the
// "Server disconnected"/"Could not attach" failure. See the plan/ADR notes.
const CLI_VERSION = resolveCliVersion();

/**
 * Refuse to read a config larger than 5 MiB. The realistic `.claude.json` is
 * single-digit kilobytes; anything beyond that is either accidental corruption
 * (log files dropped in) or a deliberate DoS aimed at making the wizard's
 * read-parse-rewrite path exhaust memory. The cap is generous enough that no
 * legitimate user hits it.
 */
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

export interface McpEntry {
  type?: "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpEntries {
  tandem: McpEntry;
  "tandem-channel"?: McpEntry;
}

/** MCP entry keys Tandem owns and may remove from an existing config. */
export type RemovableEntry = "tandem" | "tandem-channel";

/**
 * Explicit apply intent. Callers state both `create` and `remove` so
 * absence of a key never implies removal — that distinction matters when
 * the wizard's user-confirmed diff differs from CLI's stale-cleanup
 * default. `applyOpsForCli` builds the CLI-shaped value.
 */
export interface ApplyOps {
  /** Entries to create or update in `mcpServers`. */
  create: McpEntries;
  /** Entries to remove if present in `mcpServers`. */
  remove: RemovableEntry[];
  /**
   * Optional callback invoked with the backup path when `applyConfig`
   * preserves a non-default existing `mcpServers.tandem` entry before
   * overwriting it. CLI callers pass a `console.error` printer; the
   * wizard pushes the path onto its structured apply response so the
   * user sees a recovery hint. Callback is NOT invoked on fresh-install
   * or pure token-rotation runs (those don't trigger a backup).
   */
  onBackup?: (backupPath: string) => void;
}

/**
 * Construct `ApplyOps` with the legacy "remove tandem-channel unless using
 * the shim" semantics. CLI callers (`tandem setup`, `tandem rotate-token`)
 * use this to preserve back-compat without re-implementing the diff. The
 * wizard never calls this — it builds `ApplyOps` from the user's diff
 * confirmation.
 *
 * Options object intentional: the boolean-flag `withChannelShim` is the
 * only state, but exposing it as a named field at every call site avoids
 * the boolean-trap antipattern (the previous positional signature read as
 * `applyOpsForCli(entries, true)` with no clue what the boolean meant).
 */
export function applyOpsForCli(create: McpEntries, opts: { withChannelShim: boolean }): ApplyOps {
  return {
    create,
    remove: opts.withChannelShim ? [] : ["tandem-channel"],
  };
}

/** Error thrown when a target path fails realpath/symlink validation. */
export class PathRejectedError extends Error {
  override readonly name = "PathRejectedError";
  constructor(
    public readonly path: string,
    public readonly reason: "symlink" | "outside-home" | "unreadable" | "unc",
    message: string,
  ) {
    super(message);
  }
}

/**
 * A short, loggable reason for a path rejection.
 *
 * Lives beside {@link PathRejectedError} because it narrows it: every
 * `assertPathSafe` call site wants the same one-liner, and there were five
 * hand-written copies of it before this existed (three, plus two the same
 * change added). The reason is the whole point of
 * logging these at all — a rejected path and an absent one produce the same
 * "not detected" outcome, so without it the log cannot tell them apart.
 */
export function pathRejectionReason(err: unknown): string {
  if (err instanceof PathRejectedError) return err.reason;
  // Not `(err as Error).message`: every caller interpolates this straight into
  // a log line, and a non-Error throw (a bare string, a rejected promise) made
  // that line read `path rejected (undefined)` — which is worse than no line,
  // because it looks like the reason was computed and came back empty.
  return err instanceof Error ? err.message : String(err);
}

export interface BuildMcpEntriesOptions {
  /** Include the stdio channel shim. Defaults to false, and since Track E
   *  (2026-08-07) `shouldRegisterChannelShim` no longer turns it on by default
   *  either — the CLI's `--with-channel-shim` is its ONLY opt-in. There is no wizard
   *  checkbox and never was one: the wizard's apply route calls that function with
   *  no override, and it returns `override ?? false`. This docblock claimed a
   *  checkbox until #1432 — the same false claim swept out of three docs on
   *  2026-08-09, surviving in the docblock of the function that disproves it, which
   *  is why `tests/docs/channel-shim-optin-claims.test.ts` now guards the shape.
   *  See that function for why a default-on inert consumer was worse than no
   *  consumer. */
  withChannelShim?: boolean;
  /** Override the Node binary the channel shim is spawned with. Omit in
   *  production: the default resolves `process.execPath`, which is the Node
   *  already running Tandem (the bundled sidecar in the desktop app). A bare
   *  `"node"` was the old default and left the shim silently unstartable
   *  wherever the client could not resolve it — see `node-binary.ts`. */
  nodeBinary?: string;
  /** Auth token to embed in HTTP entry headers and stdio shim env.
   *  When omitted (first-run before token provisioned), headers/env are omitted
   *  and backward compatibility is preserved. */
  token?: string;
  /** Override the stdio-bridge script the `tandem` stdio entry points at.
   *  Omit in production: the default is `STDIO_BRIDGE_DIST`. Test seam only,
   *  mirroring `nodeBinary` — pass a path that does not exist to exercise the
   *  npx fallback tiers. */
  stdioBridgePath?: string;
  /** Target kind controls entry shape. Claude Code uses HTTP (direct);
   *  Claude Desktop uses stdio because Cowork sessions can only surface stdio
   *  MCP servers. See {@link buildStdioTandemEntry} for which of the three
   *  stdio shapes it gets. */
  targetKind?: TargetKind;
}

/**
 * Has the "could not embed an absolute command" warning already been printed?
 *
 * Module-scoped on purpose. `buildMcpEntries` runs once per detected target,
 * and `writeTargets` / `applyConfigWithToken` each loop over every target — so
 * a per-call warning prints the same four lines two or three times for one
 * cause. `resolveNodeBinary`'s own memo documents the same rule: one cause
 * deserves one warning.
 */
let warnedStdioFallback = false;

/** Test seam: let a suite assert the warning fires again for a fresh cause. */
export function _resetStdioFallbackWarningForTests(): void {
  warnedStdioFallback = false;
}

function warnStdioFallback(detail: string): void {
  if (warnedStdioFallback) return;
  warnedStdioFallback = true;
  console.error(
    `[Tandem] ${detail} The 'tandem' MCP entry will use the bare command "npx", ` +
      "which the MCP client must resolve on its own PATH at spawn time. A " +
      "GUI-launched client does not inherit a login shell's PATH — on macOS it " +
      "gets roughly /usr/bin:/bin:/usr/sbin:/sbin, which contains no Node. If " +
      'the client reports "Failed to spawn process: No such file or directory", ' +
      "this is why. Run 'tandem doctor' for the full check.",
  );
}

/**
 * The `tandem` entry for a stdio target: an absolute pair when we can build
 * one, the historical `npx` tuple when we cannot.
 *
 * **Absolute Node + absolute bridge** needs nothing on the user's PATH, no npm
 * registry round-trip and no `node_modules` — and in the desktop app the Node
 * is our bundled sidecar, so it works on a machine with no Node installed at
 * all. That last property is the whole point: a bare command word is resolved
 * through the MCP client's PATH at spawn time, and a GUI-launched client's PATH
 * routinely has no Node in it.
 *
 * **There is deliberately no middle tier that embeds an absolute `npx`.** It
 * looks like it should help and does not: on POSIX `npx` is a symlink to
 * `npm/bin/npx-cli.js`, whose shebang is `#!/usr/bin/env node`. Naming it by
 * absolute path still performs a PATH lookup for `node` *in the client's
 * environment* — measured directly:
 *
 *     $ env -i PATH=/usr/bin:/bin /opt/node22/bin/npx --version
 *     /usr/bin/env: 'node': No such file or directory
 *
 * So on the exact machine this change exists for, an absolute `npx` fails the
 * same way the bare one does. Its only band would be "npx off the client's PATH
 * but node on it", and in the `BARE_NODE` case that band is empty — that is a
 * validator rejection (a Debian-lineage `nodejs` basename), not a PATH miss, so
 * node is on PATH and the bare tuple already worked.
 *
 * Never emit `{command: "node"}`: a bare `node` has exactly the PATH problem
 * being fixed here and, unlike `npx`, is not even a shape clients have been
 * tolerating. Never emit an absolute path to a file that is not there: that
 * fails at every spawn, where `npx` at least might work.
 */
function buildStdioTandemEntry(
  env: Record<string, string>,
  opts: BuildMcpEntriesOptions,
): McpEntry {
  const nodeBinary = opts.nodeBinary ?? resolveNodeBinary();
  const bridge = opts.stdioBridgePath ?? STDIO_BRIDGE_DIST;
  if (nodeBinary !== BARE_NODE && existsSync(bridge)) {
    // ONE arg, not `[bridge, "mcp-stdio"]`. It mirrors the `tandem-channel`
    // shape and so lands in `validateTandemEntry`'s existing Node-shaped
    // branch, which needs no loosening — and the wizard re-reads its own
    // freshly written entry through that validator, where an `invalid-args`
    // verdict becomes `apply: "skip"`. It is also only *safe* because the
    // bridge bundle has no subcommand dispatch: the same 1-arg shape aimed at
    // `dist/cli/index.js` would fall through to `runStart()` and spawn a whole
    // Tandem server onto the MCP wire.
    return { command: nodeBinary, args: [bridge], env };
  }

  warnStdioFallback(
    nodeBinary === BARE_NODE
      ? "Could not resolve an absolute Node binary for the 'tandem' MCP entry."
      : `The bundled stdio bridge is missing (looked at "${bridge}").`,
  );
  return { command: "npx", args: buildNpxStdioArgs(`tandem-editor@${CLI_VERSION}`), env };
}

/**
 * The env keys the desktop stdio `tandem` entry carries — the complete set.
 *
 * One declaration with two consumers that must not drift: `buildMcpEntries`
 * below WRITES exactly these, and the boot sweep's convergence gate REFUSES an
 * entry carrying anything else (an unrecognised key means Tandem did not write
 * it). Restating the set at the gate would drift in the dangerous direction
 * silently: add a third key here and the gate would start declining to converge
 * entries Tandem itself had just written, forever, with no log line.
 *
 * `tests/shared/npx-entry-spec.test.ts` pins the writer's output against it,
 * because sharing a constant only prevents TEXTUAL drift.
 */
export const STDIO_ENTRY_ENV_KEYS = { url: "TANDEM_URL", token: "TANDEM_AUTH_TOKEN" } as const;

/** The same set as a lookup, for the convergence gate. */
const STDIO_ENTRY_ENV_KEY_SET: ReadonlySet<string> = new Set(Object.values(STDIO_ENTRY_ENV_KEYS));

export function buildMcpEntries(
  channelPath: string,
  opts: BuildMcpEntriesOptions = {},
): McpEntries {
  const isDesktop = opts.targetKind === "claude-desktop";

  let tandemEntry: McpEntry;
  if (isDesktop) {
    const env: Record<string, string> = { [STDIO_ENTRY_ENV_KEYS.url]: MCP_URL };
    if (opts.token) {
      env[STDIO_ENTRY_ENV_KEYS.token] = opts.token;
    }
    // Resolution stays INSIDE this branch. Hoisting it above the `if` would
    // start emitting a `command` for Claude Code too, breaking the direct-HTTP
    // path — which has no subprocess at all (ADR-045).
    tandemEntry = buildStdioTandemEntry(env, opts);
  } else {
    tandemEntry = { type: "http", url: `${MCP_URL}/mcp` };
    if (opts.token) {
      tandemEntry.headers = { Authorization: `Bearer ${opts.token}` };
    }
  }
  const entries: McpEntries = { tandem: tandemEntry };

  if (opts.withChannelShim) {
    const shimEnv: Record<string, string> = { TANDEM_URL: MCP_URL };
    if (opts.token) {
      shimEnv.TANDEM_AUTH_TOKEN = opts.token;
    }
    entries["tandem-channel"] = {
      command: opts.nodeBinary ?? resolveNodeBinary(),
      args: [channelPath],
      env: shimEnv,
    };
  }
  return entries;
}

export type TargetKind = "claude-code" | "claude-desktop";

export interface DetectedTarget {
  label: string;
  configPath: string;
  kind: TargetKind;
}

// Realpath of OS roots changes only across process restart (and tmpdir is
// stable for test fixtures). Memoize so per-integration apply loops and
// MSIX detection don't re-syscall for every call.
//
// Lifetime: process. Tandem doesn't drop privileges and never mutates HOME
// mid-process; if a future caller does either, the cache is stale and must
// be invalidated.
const DEFAULT_ROOTS_CACHE = new Map<string, string>();
function realpathCached(p: string): string {
  const cached = DEFAULT_ROOTS_CACHE.get(p);
  if (cached !== undefined) return cached;
  try {
    const r = realpathSync(p);
    DEFAULT_ROOTS_CACHE.set(p, r);
    return r;
  } catch {
    return p;
  }
}

/**
 * Verify the target directory (a) is not a symlink/junction and (b) its
 * realpath resolves under one of the allowed roots. Throws
 * `PathRejectedError` otherwise.
 *
 * Threat model: prior compromised account replaces `~/.claude.json` with a
 * symlink to `/etc/shadow`; on Windows, a junction at `~/.claude`
 * redirecting to `C:\Windows\System32\config\` could let `mkdir(...
 * recursive)` walk into a protected dir. We reject both cases before any
 * read or write. The ancestor check is the closed-set boundary — any path
 * outside the allowed roots is refused even if it's not a symlink.
 *
 * **UNC is screened first, before any syscall (#1417).** This is an exported,
 * total guard — and the very first thing it did was `existsSync(targetPath)`
 * on the raw string, which on Windows performs the SMB handshake that leaks an
 * NTLM hash. Every attacker-facing caller happened to prefix-check first, so
 * it was not exploitable through today's callers; it is exported, and "not
 * currently reachable" is not a property a guard should rely on. The check is
 * a pure string test and runs before every syscall in here.
 *
 * It uses the STRICT shared predicate, so `\\?\C:\…` is refused too — unlike
 * `src/cli/win-path-guard.ts`, which permits that prefix because containment
 * under %LOCALAPPDATA% confines it. Deliberate: this function's allowed-roots
 * test compares against `realpath`'d roots, and an extended-length spelling
 * would not match them, so admitting the prefix would produce a confusing
 * "outside-home" rejection one step later rather than a clear one here. The
 * visible consequence is in `detectTargets`, which passes `%LOCALAPPDATA%`
 * through this guard: an extended-length value there disables MSIX detection,
 * which is why that call site logs rather than returning empty in silence.
 *
 * **Known trade-off: enterprise folder redirection.** A machine whose
 * `%APPDATA%` / `%USERPROFILE%` is redirected to a UNC share now has its
 * Claude Desktop config refused here, where before it was written. That is
 * deliberate — Tandem already refuses to *open a document* from a UNC path
 * (`validate_open_candidate` in `src-tauri/src/lib.rs`, before any filesystem
 * call), so a profile whose documents live on the share already cannot use the
 * primary surface, and config writes were the inconsistent hold-out.
 *
 * **That argument covers `%USERPROFILE%` redirection and NOT roaming-`%APPDATA%`-
 * only redirection**, which is the more common enterprise shape: it leaves
 * documents on a local drive, so such a profile loses Claude Desktop config
 * writes and nothing else. There the cost is real rather than already-paid.
 * `detectionRefusal` exists so callers can at least say *why* instead of
 * reporting it as "no Claude installed".
 *
 * Residual TOCTOU: the lstat-then-write window admits a same-uid attacker
 * who swaps a regular file for a symlink between check and write. Node's
 * `fs` doesn't expose `O_NOFOLLOW` / `openat`-style per-component
 * traversal, so the window is unavoidable without native bindings. The
 * realpath check shrinks the practical attack but doesn't close it.
 *
 * Defaults to `[homedir(), tmpdir()]`. Callers may nominate alternate
 * roots (e.g., test fixtures that operate inside a specific tmpdir).
 */
export function assertPathSafe(targetPath: string, opts: { allowedRoots?: string[] } = {}): void {
  const unsafePrefix = rejectUnsafeWindowsPrefix(targetPath);
  if (unsafePrefix !== null) {
    throw new PathRejectedError(targetPath, "unc", unsafePrefix);
  }
  const allowedRoots = (opts.allowedRoots ?? [homedir(), tmpdir()]).map(realpathCached);

  // `lstat` a path that may not exist yet (e.g., apply will create the
  // parent dir). Walk up until we find an existing ancestor and validate
  // there — if any walked-through component is a symlink, fail.
  let cursor = targetPath;
  let existing: string | null = null;
  while (true) {
    if (existsSync(cursor)) {
      const st = lstatSync(cursor);
      if (st.isSymbolicLink()) {
        throw new PathRejectedError(
          targetPath,
          "symlink",
          `Refusing to operate on symlinked path: ${cursor}`,
        );
      }
      existing = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break; // reached filesystem root
    cursor = parent;
  }

  const resolved = existing ? realpathSync(existing) : targetPath;
  const ok = allowedRoots.some((root) => {
    if (resolved === root) return true;
    const normRoot = root.endsWith(sep) ? root : `${root}${sep}`;
    return resolved.startsWith(normRoot);
  });
  if (!ok) {
    throw new PathRejectedError(
      targetPath,
      "outside-home",
      `Refusing path outside allowed roots: realpath=${resolved}`,
    );
  }
}

/** MSIX package families that match Claude's installer. Anchored on both ends. */
export const MSIX_PACKAGE_PATTERN = /^Claude_[A-Za-z0-9]+$/;

export interface DetectOptions {
  /**
   * Redirect every detected path under this root. **Total**: on win32 it also
   * overrides `%APPDATA%` for the Claude Desktop target — see the note in
   * `detectTargets`. Anything less is a foot-gun, because the guard downstream
   * (`assertPathSafe`) validates against the process's real home and therefore
   * waves through the very path the override was meant to avoid.
   */
  homeOverride?: string;
  /** Explicit `%APPDATA%` root; wins over both `homeOverride` and the env var. */
  appDataOverride?: string;
  localAppDataOverride?: string;
  /**
   * Override `process.platform` for the platform-branching parts of detection:
   * the Claude Desktop config path and the Windows-only MSIX walk.
   *
   * **This is what makes the Windows path guards testable on Linux CI, and
   * without it two of them are pinned by tests that cannot fail (#1417).**
   * `claudeDesktopConfigPath` ignores `appDataOverride` off win32 by design, so
   * on a Linux runner a UNC `appDataOverride` silently derives
   * `~/.config/claude/…` — a clean local path. The screen never runs, the
   * "no claude-desktop target" assertion passes because the posix file merely
   * does not exist, and `not.toHaveBeenCalledWith(…"attacker")` is vacuous.
   * Deleting the screen it pins left the suite green.
   *
   * Production callers must not pass this. It exists so the guard is exercised
   * on every runner rather than only on a maintainer's Windows box.
   */
  platformOverride?: NodeJS.Platform;
  force?: boolean;
}

/**
 * Is `p` a reparse point (junction / symlink)? Fail-closed: an unreadable path
 * counts as one, because "I could not tell" must not license a descent.
 *
 * `lstatSync` deliberately, never `statSync` — `stat` follows, which is the
 * whole bug (#1417). The async twin of this rule is `readdirNoFollow` in
 * `src/cli/uninstall-scrub.ts`; the two cannot share an implementation because
 * `detectTargets` is synchronous, but they must not diverge in behaviour.
 */
function isReparsePoint(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return true;
  }
}

/**
 * Walk `root` down through `segments`, refusing at the first reparse point.
 *
 * The sync twin of `descendNoFollow` in `src/cli/uninstall-scrub.ts`, and it
 * exists for the same reason: `lstat` declines to follow only the *last*
 * component, so screening the leaf of a multi-segment `join` checks one level
 * and silently traverses the rest (#1417). Returns the assembled path, or null
 * if any level refused.
 *
 * The two cannot share an implementation across the sync/async boundary. They
 * are deliberately NOT claimed to be behaviourally identical — this one is used
 * for detection and returns null where the async one also reports a reason to
 * an uninstall log — but the reparse rule itself must stay the same.
 */
function descendNoFollowSync(root: string, segments: readonly string[]): string | null {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (isReparsePoint(current)) return null;
  }
  return current;
}

/**
 * Why detection will refuse to look at all, or `null` if it will proceed.
 *
 * **Exported so callers can distinguish "refused" from "nothing installed",
 * which `detectTargets` alone cannot express (#1417).** Both produce an empty
 * target list, and the two want opposite advice: `tandem setup --apply`'s
 * standard hint is to retry with `--force`, which cannot possibly help here
 * because the refusal happens before any `force` branch is reached. Callers
 * that print remedies MUST ask this first, or they send the user in a circle.
 *
 * The screen itself is on the ROOTS rather than on a derived path. Every
 * `existsSync` / `readdirSync` in `detectTargets` hangs off `home` or
 * `%LOCALAPPDATA%`, and on Windows those calls perform the SMB handshake that
 * leaks an NTLM hash — so screening one derived path would leave its siblings
 * open, and would leave the function reading as "that line was reviewed"
 * rather than "this function is safe". Both roots are redirectable to a share
 * by enterprise folder redirection: the compatibility trade-off recorded on
 * {@link assertPathSafe}.
 */
export function detectionRefusal(opts: DetectOptions = {}): string | null {
  return rejectUnsafeWindowsPrefix(opts.homeOverride ?? homedir());
}

export function detectTargets(opts: DetectOptions = {}): DetectedTarget[] {
  const home = opts.homeOverride ?? homedir();
  const targets: DetectedTarget[] = [];

  const homeRejection = detectionRefusal(opts);
  if (homeRejection !== null) {
    console.error(`[Tandem] home directory rejected (${homeRejection}); detecting nothing`);
    return targets;
  }

  // Claude Code — cross-platform.
  // MCP servers are configured in ~/.claude.json under the "mcpServers" key.
  // Detect if the file exists OR if ~/.claude directory exists (Claude Code is installed).
  // With --force, always include regardless.
  const claudeCodeConfig = claudeCodeConfigPath({ homeOverride: opts.homeOverride });
  const claudeCodeDir = join(home, ".claude");
  if (opts.force || existsSync(claudeCodeConfig) || existsSync(claudeCodeDir)) {
    targets.push({ label: "Claude Code", configPath: claudeCodeConfig, kind: "claude-code" });
  }

  // Claude Desktop — platform-specific.
  // Only detect if the config file already exists (user has launched Desktop at least once).
  // With --force, always include.
  // The platform switch (including the `homeOverride`-beats-%APPDATA%
  // containment rule) lives in the shared leaf so `tandem doctor` inspects the
  // exact file this writes. Do not reinline it — a second copy is how the
  // diagnosis drifts from the write target.
  const desktopConfig: string = claudeDesktopConfigPath({
    homeOverride: opts.homeOverride,
    appDataOverride: opts.appDataOverride,
    platformOverride: opts.platformOverride,
  });

  // The second root: `%APPDATA%` is its own env var, so the `home` screen above
  // does not cover this branch. Screened on the derived path rather than the raw
  // variable because the platform switch lives behind `claudeDesktopConfigPath`
  // and only some platforms consult `%APPDATA%` at all.
  const desktopPrefixRejection = rejectUnsafeWindowsPrefix(desktopConfig);
  if (desktopPrefixRejection !== null) {
    console.error(`[Tandem] Claude Desktop config path rejected: ${desktopPrefixRejection}`);
  } else if (opts.force || existsSync(desktopConfig)) {
    targets.push({ label: "Claude Desktop", configPath: desktopConfig, kind: "claude-desktop" });
  }

  // Claude Desktop (MSIX) — Windows only.
  // MSIX-packaged installs (Microsoft Store) redirect %APPDATA% to a per-package
  // LocalCache dir. The config lives under %LOCALAPPDATA%\Packages\Claude_*\
  // LocalCache\Roaming\Claude\. Multiple package families may exist.
  // Package name is constrained to `Claude_[A-Za-z0-9]+` so an attacker can't
  // smuggle a write target through a hand-crafted package directory like
  // `Claude_../../Windows/System32` (the path constructor would reject such
  // a name on most platforms but we belt-and-suspender).
  if ((opts.platformOverride ?? process.platform) === "win32") {
    const localAppData =
      opts.localAppDataOverride ?? process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    // Verify LOCALAPPDATA resolves under home. An attacker who controls env
    // could otherwise redirect us to write under any directory.
    try {
      assertPathSafe(localAppData, { allowedRoots: [home] });
    } catch (err) {
      // Never silent. Since #1417 this guard's first statement is a strict UNC
      // and extended-length screen, so a value that used to reach the readdir
      // now stops here — and the symptom is "MSIX Claude Desktop was not
      // detected", which is indistinguishable from "not installed" unless the
      // reason is written down.
      const reason = pathRejectionReason(err);
      console.error(`[Tandem] %LOCALAPPDATA% rejected (${reason}); skipping MSIX detection`);
      return targets;
    }
    const packagesDir = join(localAppData, "Packages");
    try {
      // (#1417) `readdirSync` and `existsSync` FOLLOW reparse points, and this
      // walks the same `%LOCALAPPDATA%\Packages\Claude_*` tree that
      // `findCoworkWorkspaces` walks — the tree the reachable instance of #1417
      // was found in. A junction planted at either level by any process running
      // as the user redirects the call to a share. `lstatSync` does not follow,
      // so screening each level before reading it is what closes the window;
      // the env-var screen above cannot, because the hostile part of the path is
      // on disk rather than in the variable.
      // Logged and returned rather than thrown — the catch below means "no MSIX
      // install", and routing a security refusal into it would report the
      // attack this function exists to stop as an ordinary absence. It is also
      // what keeps this in step with the async twin, which logs.
      if (isReparsePoint(packagesDir)) {
        console.error(
          `[Tandem] Refusing to enumerate ${packagesDir}: reparse point or unreadable. ` +
            "MSIX Claude Desktop will not be detected.",
        );
        return targets;
      }
      const entries = readdirSync(packagesDir);
      const matching = entries.filter((n) => MSIX_PACKAGE_PATTERN.test(n));
      for (const pkg of matching) {
        if (isReparsePoint(join(packagesDir, pkg))) {
          // Named, because with two packages installed one silently vanishing
          // from the wizard while the other does not is the most confusing
          // possible presentation.
          console.error(`[Tandem] Skipping ${pkg}: reparse point or unreadable.`);
          continue;
        }
        // Every component, not the join: `existsSync` on the assembled path
        // would traverse — and follow — `LocalCache`, `Roaming` and `Claude`,
        // all user-writable. `lstatSync` declines to follow only the FINAL
        // component, so screening the leaf alone checks one level of four.
        const configDir = descendNoFollowSync(join(packagesDir, pkg), [
          "LocalCache",
          "Roaming",
          "Claude",
        ]);
        if (configDir === null) {
          console.error(`[Tandem] Skipping ${pkg}: reparse point below the package root.`);
          continue;
        }
        const msixConfig = join(configDir, "claude_desktop_config.json");
        if (opts.force || existsSync(msixConfig)) {
          const suffix = matching.length > 1 ? ` (${pkg.slice(0, 12)}…)` : "";
          targets.push({
            label: `Claude Desktop MSIX${suffix}`,
            configPath: msixConfig,
            kind: "claude-desktop",
          });
        }
      }
    } catch {
      // %LOCALAPPDATA%\Packages doesn't exist or isn't readable — not an MSIX install
    }
  }

  return targets;
}

// The `claude` binary probe moved to a shared built-ins-only leaf so
// `tandem doctor` can reuse it without importing apply.ts's server-coupled
// deps. Re-exported here so existing importers (install-claude-cli, api-routes,
// tests) keep their `./apply.js` import path.
export {
  type DetectClaudeCliOptions,
  detectClaudeCli,
  isBareNameLaunchable,
} from "../../shared/integrations/detect-claude-cli.js";

/**
 * Atomic write: write to a temp file in the SAME directory as the destination,
 * tighten its mode/DACL, then rename. Same-directory tempfile avoids EXDEV
 * errors when `%TEMP%` and `%APPDATA%` are on different drives.
 *
 * Sequence (security-load-bearing):
 * 1. Write tempfile. On Windows the tempfile inherits its parent dir's
 *    DACL (`homedir()` is OS-restricted by default to user + SYSTEM +
 *    Administrators); on POSIX it lands at `0o666 & ~umask` (typically
 *    `0o644` — world-readable, hence step 2's chmod).
 * 2. Tighten on the tempfile:
 *    - Windows: `setRestrictiveAcl` breaks inheritance and grants Full
 *      Control to the current user's SID only, then self-verifies via
 *      SDDL read. The verify is load-bearing — icacls exits 0 even when
 *      "Failed processing N files".
 *    - POSIX: `chmod(tmp, 0o600)` — user-only read/write.
 * 3. Rename tempfile to dest. The kernel preserves mode (POSIX) and DACL
 *    (Windows `MoveFileEx`) across the rename, so the tightened
 *    permissions survive into the destination.
 * 4. On cleanup failure after a write/ACL/rename error, the original
 *    failure propagates with the cleanup error attached via `cause` so
 *    operators can diagnose a leaked tempfile or dest from a single log
 *    line rather than chasing a stray `console.error`.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}

async function atomicWrite(
  content: string,
  dest: string,
  opts: {
    signal?: AbortSignal;
    /** Refresh-only guard: do not recreate a destination removed mid-operation. */
    requireExistingDest?: boolean;
    /** Test-only seam immediately before the refresh commit guard. */
    beforeCommitForTests?: () => Promise<void>;
  } = {},
): Promise<void> {
  const { signal } = opts;
  throwIfAborted(signal);
  const tmp = join(dirname(dest), `.tandem-setup-${randomUUID()}.tmp`);
  // mode at create, not chmod-after: on POSIX a plain writeFile lands at
  // 0o666 & ~umask, leaving sibling vendors' tokens world-readable until the
  // tighten below. Windows ignores mode (the ACL step is the protection).
  try {
    await writeFile(tmp, content, { encoding: "utf-8", mode: 0o600, signal });
  } catch (writeErr) {
    await unlinkOrLeak(tmp, writeErr);
    throw writeErr;
  }

  try {
    if (process.platform === "win32") {
      await setRestrictiveAcl(tmp, { signal });
    } else {
      throwIfAborted(signal);
      await chmod(tmp, 0o600);
    }
    // The deadline may have fired while the ACL/chmod was in flight. Never
    // cross the commit boundary after cancellation: the stale destination is
    // safer than a late replacement racing server readiness.
    throwIfAborted(signal);
  } catch (tightenErr) {
    await unlinkOrLeak(tmp, tightenErr);
    throw tightenErr;
  }

  try {
    if (process.env.VITEST === "true") await opts.beforeCommitForTests?.();
    throwIfAborted(signal);
    if (opts.requireExistingDest) await stat(dest);
    throwIfAborted(signal);
  } catch (commitGuardErr) {
    await unlinkOrLeak(tmp, commitGuardErr);
    throw commitGuardErr;
  }

  try {
    await rename(tmp, dest);
  } catch (err) {
    // EXDEV: cross-device link — fall back to copy + delete. The copy
    // preserves the source mode on POSIX (file is created via copyFile's
    // default which honors the source's mode bits); on Windows the
    // destination DACL is recomputed from the dest dir, so we re-run
    // setRestrictiveAcl on the dest after the cross-device copy.
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(tmp, dest);
      await unlinkOrLeak(tmp, err);
      if (process.platform === "win32") await setRestrictiveAcl(dest);
      else await chmod(dest, 0o600);
    } else {
      await unlinkOrLeak(tmp, err);
      throw err;
    }
  }
}

/**
 * Attempt to delete `path` after a write/ACL/rename failure. On cleanup
 * success we just return; on cleanup failure we attach the cleanup error
 * as `cause` to the original failure (mutating `originalErr`) so operators
 * see a single composite log line rather than a free-floating
 * `console.error`. Bearer-token-bearing files that fail cleanup MUST be
 * surfaced, not silently logged.
 */
async function unlinkOrLeak(path: string, originalErr: unknown): Promise<void> {
  try {
    await unlink(path);
  } catch (cleanupErr) {
    if ((cleanupErr as NodeJS.ErrnoException).code === "ENOENT") return;
    if (originalErr instanceof Error && originalErr.cause === undefined) {
      (originalErr as { cause?: unknown }).cause = cleanupErr;
    }
    console.error(
      `  Warning: could not remove ${path} after a previous failure: ${
        (cleanupErr as Error).message
      }`,
    );
  }
}

/**
 * Apply explicit create/remove operations to a Claude config file.
 *
 * **Security gates (run before any read or write):**
 * - `assertPathSafe(configPath)` — symlink / outside-home rejection.
 * - Malformed JSON is backed up under Tandem's data dir with mode `0o600`
 *   (avoids leaking other vendors' API keys via a world-readable
 *   `~/.claude.json.broken-<ts>` sibling).
 *
 * `applyConfig` writes both `ops.create` entries (merging into the existing
 * `mcpServers` object) and removes any key listed in `ops.remove`. Removal
 * is silent if the key was already absent. Callers state both intents
 * explicitly — no implicit "absent key implies remove".
 */
export async function applyConfig(configPath: string, ops: ApplyOps): Promise<void> {
  // Security gate: refuse symlinks, refuse paths outside home/tmpdir.
  assertPathSafe(configPath);

  // Size guard runs before any read — fail closed on oversized files. ENOENT
  // falls through so fresh-install (no .claude.json yet) stays the common path.
  try {
    const { size } = statSync(configPath);
    if (size > MAX_CONFIG_BYTES) {
      throw new Error(
        `${configPath} is ${size} bytes; refusing to read (cap: ${MAX_CONFIG_BYTES}).`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Read existing config or start fresh — no existsSync guard needed.
  // ENOENT and malformed JSON start fresh; other errors (permissions, disk) propagate.
  let existing: { mcpServers?: Record<string, McpEntry> } = {};
  try {
    // Strip a leading UTF-8 BOM (`﻿`) before JSON.parse. Some editors
    // (legacy Windows tooling, certain VS Code configs) write `.claude.json`
    // with a BOM; without this strip, `JSON.parse` throws `SyntaxError`
    // and the file would be pushed into `.broken-backups/` as if it were
    // malformed. The BOM is encoded as the literal three bytes
    // `EF BB BF` which Node's "utf-8" decoder surfaces as a leading
    // U+FEFF code point.
    let raw = readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed: unknown = JSON.parse(raw);

    // Shape gate: the rewrite path spreads `existing.mcpServers` and
    // `existing` itself into the new config. If either is the wrong
    // shape, the spread produces a corrupted output (string-spread
    // yields `{0:'a',1:'b',...}`, array-spread yields numeric keys,
    // null-spread throws). Reject up-front so a legitimate-looking
    // config-shape mismatch never silently corrupts the user's file.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${configPath} root is not a JSON object — refusing to rewrite`);
    }
    const maybeServers = (parsed as Record<string, unknown>).mcpServers;
    if (
      maybeServers !== undefined &&
      (maybeServers === null || typeof maybeServers !== "object" || Array.isArray(maybeServers))
    ) {
      throw new Error(`${configPath} mcpServers is not an object — refusing to rewrite`);
    }
    existing = parsed as { mcpServers?: Record<string, McpEntry> };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // File doesn't exist yet — start fresh
    } else if (err instanceof SyntaxError) {
      // Don't silently wipe the user's other mcpServers. Copy the malformed
      // file under Tandem's data dir (NOT next to ~/.claude.json — that
      // location may inherit world-readable perms and leak co-tenant API
      // keys via the backup). Mode 0o600 hardens against the same.
      const brokenBackupDir = join(resolveAppDataDir(), ".broken-backups");
      // Validate against default roots [homedir(), tmpdir()] rather than
      // scoping to resolveAppDataDir() — the latter is tautological, and
      // an XDG_DATA_HOME-poisoning attacker can otherwise redirect the
      // backup target outside the home tree.
      assertPathSafe(brokenBackupDir);
      // mode: 0o700 on dir creation — the file mode is 0o600, but a
      // world-readable parent dir lists sibling filenames (older backups
      // carry other vendors' keys). Mode applies only when the dir is
      // newly created; existing dirs retain their mode.
      mkdirSync(brokenBackupDir, { recursive: true, mode: 0o700 });
      // randomUUID() in the path defeats path prediction by an attacker
      // who might pre-create a file at the predicted location and have
      // our mode-at-open inherit world-readable bits. `wx` (exclusive
      // create) below is the second layer.
      const backupPath = join(
        brokenBackupDir,
        `${basename(configPath)}.broken-${Date.now()}-${randomUUID()}`,
      );
      try {
        if (process.platform === "win32") {
          // Windows ignores the POSIX `mode` arg on mkdir, so harden the
          // dir with an explicit DACL BEFORE writing the backup file.
          // Mirrors the ordering invariant in
          // `storage.ts#backupBrokenFile`: dir-level ACL closes the
          // TOCTOU window that a per-file ACL would otherwise open
          // between copyFile and the ACL set. Fail loud — orphaning a
          // half-hardened dir is worse than aborting the backup
          // outright. The inner `catch (copyErr)` below surfaces a
          // named error and refuses to overwrite the malformed config.
          try {
            await setRestrictiveAcl(brokenBackupDir);
          } catch (aclErr) {
            throw new Error(
              `failed to apply restrictive ACL to broken-backups dir ${brokenBackupDir}: ${
                aclErr instanceof Error ? aclErr.message : String(aclErr)
              }`,
              { cause: aclErr },
            );
          }
          // Windows doesn't honor POSIX modes — fall back to plain copy.
          // The randomUUID-suffixed path makes collisions effectively
          // impossible. COPYFILE_EXCL refuses to overwrite an existing
          // target, defeating any predictable-path symlink/pre-create
          // attack the UUID suffix might still leave reachable. NOTE:
          // `setRestrictiveAcl` (acl-win.ts) calls `icacls /grant:r
          // *<SID>:F` without (OI)(CI) inheritance flags, so the new
          // file does NOT inherit the parent dir's SID-only ACE.
          // Instead it receives the DACL synthesized from the process
          // token's default (typically user + SYSTEM + Administrators),
          // which is narrow enough to prevent cross-tenant leak in
          // standard contexts. If broader access is observed, the dir
          // ACE should be made inheritable in acl-win.ts (this would
          // also benefit storage.ts which uses the same helper).
          await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
        } else {
          // Open with mode 0o600 + `wx` so the file is created exclusively
          // at the right mode (no copyFile + chmodSync race window where
          // the backup was briefly 0o644 with another vendor's API keys
          // inside).
          const data = await readFile(configPath);
          const fd = await open(backupPath, "wx", 0o600);
          try {
            await fd.write(data);
          } finally {
            await fd.close();
          }
        }
        console.error(
          `  Warning: ${configPath} contains malformed JSON — backed up to ${backupPath}, replacing with fresh config`,
        );
      } catch (copyErr) {
        console.error(
          `  Warning: ${configPath} contains malformed JSON and backup failed (${
            copyErr instanceof Error ? copyErr.message : copyErr
          }) — refusing to overwrite. Fix the JSON manually and rerun 'tandem setup'.`,
        );
        throw copyErr;
      }
    } else {
      throw err; // Permission errors, disk errors, etc. should not be silently swallowed
    }
  }

  // Backup the existing config IFF the existing `mcpServers.tandem` entry
  // is non-default (user-customised URL or extra keys). Token rotation and
  // fresh-install runs would otherwise generate backup churn that buries
  // the one backup the user actually needs. The write happens BEFORE the
  // rewrite — atomicity invariant: if backup throws, the original is
  // untouched.
  const backupPath = await maybeBackupExistingConfig(configPath, existing, ops);
  if (backupPath && ops.onBackup) {
    // The onBackup callback is observational — a wizard push, a CLI
    // print, a telemetry hop. If the consumer throws, log it but DO
    // NOT abort the rewrite: doing so would orphan the just-written
    // backup file and leave the user's config un-applied, with no
    // user-visible explanation.
    try {
      ops.onBackup(backupPath);
    } catch (cbErr) {
      console.error(
        `  Warning: onBackup callback threw — continuing with rewrite: ${
          cbErr instanceof Error ? cbErr.message : cbErr
        }`,
      );
    }
  }

  const merged: Record<string, McpEntry> = {
    ...(existing.mcpServers ?? {}),
    ...ops.create,
  };
  // Explicit removals — silent if the key was already absent.
  for (const key of ops.remove) {
    // "create wins": never remove a key we're also creating this run. The
    // wizard builds `ApplyOps` directly from a user-confirmed diff and can
    // legitimately list the same key in both `create` and `remove`; without
    // this guard the channel shim we just registered would be deleted again.
    // Structural invariant for every flow — see #985.
    if (key in ops.create) continue;
    if (merged[key]) {
      console.error(`  Note: removed mcpServers.${key} from ${configPath}`);
    }
    delete merged[key];
  }
  const updated = { ...existing, mcpServers: merged };

  await mkdir(dirname(configPath), { recursive: true });
  await atomicWrite(JSON.stringify(updated, null, 2) + "\n", configPath);
}

export type RemoveEntriesResult =
  | ConfigReadRefusal
  | { status: "removed"; removed: RemovableEntry[] }
  | { status: "no-op" };

/** Why a config could not be opened for a non-destructive mutation. Shared so
 *  every such caller reports the same fixed reason strings. */
export type ConfigReadRefusal =
  | { status: "missing" }
  | { status: "skipped"; reason: "malformed-json" | "not-an-object" | "oversize" };

export type ConfigReadResult =
  | ConfigReadRefusal
  /** Opened fine, but there is no `mcpServers` object to act on — absent, or
   *  present as a non-object. Both mean "nothing to do" for every mutation
   *  path, so this is an arm rather than a nullable field: it keeps callers to
   *  a single `status !== "ok"` pass-through and makes "ok but no servers"
   *  unrepresentable. */
  | { status: "no-op" }
  | { status: "ok"; root: Record<string, unknown>; servers: Record<string, unknown> };

/**
 * Open a client config for a NON-DESTRUCTIVE mutation.
 *
 * The single owner of the read-side rules that every such caller must obey,
 * because this file holds other vendors' entries and bearer tokens:
 *
 * - **Never create it.** ENOENT is `missing`, not "start fresh" — that
 *   distinction is what separates a repair from an overwrite. (`applyConfig`
 *   deliberately DOES create, which is why it does not use this.)
 * - **Never replace malformed JSON.** Refuse and leave it exactly as found.
 * - **Cap the read** at `MAX_CONFIG_BYTES` before touching the contents.
 * - **Strip a BOM**, which `JSON.parse` will not tolerate.
 * - **Leak no parse detail.** V8 `SyntaxError` messages embed a snippet of the
 *   source, so reasons are fixed strings and never carry the error.
 *
 * Extracted because this preamble had been hand-copied and had already begun to
 * diverge; a hardening change applied to one copy and not the other fails
 * silently on someone's `~/.claude.json`. Two callers use it today
 * (`removeConfigEntries`, `refreshMcpEntryBinary`); `applyConfig` keeps its
 * own variant deliberately because it CREATES the file, and
 * `existing-config.ts` has a third, looser read this did not absorb. Async I/O so callers on the startup
 * path do not block the event loop on a multi-megabyte config.
 *
 * `servers` is `null` when `mcpServers` is absent or not an object — callers
 * treat that as "nothing to do", not as an error.
 */
export async function readConfigForMutation(configPath: string): Promise<ConfigReadResult> {
  assertPathSafe(configPath);

  let raw: string;
  try {
    const { size } = await stat(configPath);
    if (size > MAX_CONFIG_BYTES) return { status: "skipped", reason: "oversize" };
    raw = await readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw err;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "skipped", reason: "malformed-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "skipped", reason: "not-an-object" };
  }

  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    return { status: "no-op" };
  }
  // NOTE: `servers` is an interior pointer INTO `root`, not a copy. Callers
  // mutate through it and then serialize `root` — do not introduce a defensive
  // clone or a normalizing pass here without updating them, or every caller
  // will silently write back an unmodified config while still reporting
  // success.
  return { status: "ok", root, servers: servers as Record<string, unknown> };
}

/**
 * Remove Tandem's `mcpServers` keys from a client config — the uninstall
 * counterpart of `applyConfig`, sharing the same gates (`assertPathSafe`,
 * size cap, BOM strip) and the same `atomicWrite` 0o600/ACL hardening, but
 * with scrub semantics `applyConfig` deliberately does NOT have:
 * - never creates the file (`applyConfig` starts fresh on ENOENT);
 * - never replaces malformed JSON (`applyConfig` backs it up and rewrites —
 *   on an uninstall path that would wipe the user's whole config);
 * - never rewrites when nothing matched (no churn of a file other vendors'
 *   tokens live in).
 *
 * `skipped` reasons are fixed strings — parse-error detail must never reach
 * the caller's log (V8 SyntaxError messages embed source snippets, and this
 * file holds bearer tokens).
 */
export async function removeConfigEntries(
  configPath: string,
  keys: RemovableEntry[],
): Promise<RemoveEntriesResult> {
  const opened = await readConfigForMutation(configPath);
  if (opened.status !== "ok") return opened;

  const map = opened.servers;
  const removed = keys.filter((key) => key in map);
  if (removed.length === 0) return { status: "no-op" };
  for (const key of removed) {
    delete map[key];
  }

  await atomicWrite(JSON.stringify(opened.root, null, 2) + "\n", configPath);
  return { status: "removed", removed };
}

/**
 * What {@link repairEntryInPlace} alone can return.
 *
 * Declared as the PRIMARY type, with the wide one composed from it below —
 * rather than the reverse, subtracting {@link ConfigReadRefusal} with `Exclude`.
 * Subtraction would work only by accident: `{status:"skipped"}` appears on both
 * sides with different `reason` literals, so the arm survives purely because the
 * literals do not overlap, and adding `"oversize"` to the refresh side would
 * silently delete it from the narrowed type — taking the exhaustiveness check
 * below with it, without a single error.
 *
 * The narrowing exists so that check can compile at all: the sweep's log block
 * used to end at `else if (status === "skipped")` with no `else`, so a status
 * nobody had handled would have rewritten the user's `~/.claude.json` in
 * complete silence.
 */
type EntryRepairResult =
  | { status: "no-op" }
  /** The recorded binary is gone and we have no better value to put there —
   *  see the `BARE_NODE` refusal in `refreshMcpEntryBinary`. */
  | { status: "skipped"; reason: "no-valid-replacement" }
  /** A bare-`npx` entry converged onto the absolute pair.
   *
   *  Its own status rather than a field on `"rewritten"`. It carries no
   *  `from`/`to`, because the thing it replaced was a bare name and not a path
   *  that moved, and a "repair kind" field would have had four values of which
   *  exactly one was ever read. */
  | { status: "converged" }
  /** `from`/`to` are null when only the SCRIPT path needed repair — the two are
   *  checked independently, so either can move without the other. */
  | { status: "rewritten"; from: string | null; to: string | null; scriptRefreshed: boolean };

export type RefreshNodeBinaryResult = ConfigReadRefusal | EntryRepairResult;

/**
 * Which entry key a refresh pass is operating on. Both carry an absolute Node
 * path plus an absolute script, and both can go stale the same ways.
 */
export type RefreshableEntryKey = "tandem" | "tandem-channel";

/**
 * Is this recorded `args[0]` one of OUR script paths, and therefore ours to
 * repair?
 *
 * Only consulted for the `tandem` key, and it is the difference between a
 * repair and a clobber. `validateTandemEntry` accepts a Node-shaped command
 * with a single `.js` arg, which covers the bundled stdio bridge — but ALSO a
 * legacy sidecar invocation written by an older Tauri build, and any absolute
 * `.js` a user hand-pointed the entry at. Those are arity-identical to the
 * shape we emit, so "has a string command and a stale `args[0]`" is not enough
 * to justify overwriting: it would silently redirect a working hand-edited
 * entry at Tandem's bridge the moment the user's own script moved.
 *
 * Matching on the trailing path segments rather than equality with
 * `STDIO_BRIDGE_DIST` is the point — the recorded path we are being asked
 * about is, by construction, a *different* location from the current one (an
 * old install prefix, a pre-update `.app`). Separator-agnostic because a
 * Windows-shaped config is read on Linux in CI.
 *
 * `tandem-channel` needs no equivalent: nothing but Tandem has ever written
 * that key, so its pre-existing "any stale absolute `args[0]`" rule stays.
 */
function isOwnStdioBridgeScript(recorded: string): boolean {
  return /[/\\]dist[/\\]stdio-bridge[/\\]index\.js$/.test(recorded);
}

/** What a refreshable key needs to know about itself. */
interface RefreshDescriptor {
  /** The script this key's entry should point at. A thunk, not a value: both
   *  bundles are module-level consts, and taking them eagerly here would freeze
   *  the table before the test seams can vary them. */
  script: () => string;
  /**
   * What is this entry, from an ownership standpoint?
   *
   * Replaces the old boolean `isOurs`. A boolean could only answer "ours to
   * repair?", so the npx-convergence case had nowhere to live in the table and
   * would have had to sit *above* the ownership gate — a second ownership rule
   * jumping over the one place ownership is supposed to be decided, defeating
   * the property this table's docblock claims for itself.
   *
   * REQUIRED, and a union rather than an optional flag: a third key cannot be
   * added without answering all three arms, which is the same reason `script`
   * and this column are not `??`-defaulted.
   */
  classify: (command: string, args: unknown) => "ours-node" | "npx-convergible" | "foreign";
}

/**
 * The two refreshable keys and everything that differs between them.
 *
 * A table rather than `if (entryKey === "tandem")` branches, because the pairing
 * of key→script is the one genuinely dangerous mistake available in this file:
 * pointing the `tandem` entry at `CHANNEL_DIST` would spawn the channel shim in
 * the bridge's place — a process starts, no tools appear, and every health check
 * reads green. Expressed as a table, that mispairing is unrepresentable in
 * production code instead of being warned about in a comment.
 *
 * It also forces the ownership question to be *answered* for each key rather
 * than inherited from whichever default a `??` happened to fall through to —
 * and a third key (`dist/monitor`, say) cannot be added without answering both
 * columns.
 */
const REFRESHABLE: Record<RefreshableEntryKey, RefreshDescriptor> = {
  tandem: {
    script: () => STDIO_BRIDGE_DIST,
    classify: (command, args) => {
      if (
        isValidNodeBinary(command) &&
        Array.isArray(args) &&
        typeof args[0] === "string" &&
        isOwnStdioBridgeScript(args[0])
      ) {
        return "ours-node";
      }
      if (command === "npx" && isCanonicalNpxStdioArgs(args)) return "npx-convergible";
      return "foreign";
    },
  },
  "tandem-channel": {
    // Tandem is the sole writer of this key, so any stale absolute path in it is
    // ours — the pre-existing rule, now stated rather than assumed.
    //
    // Never `"npx-convergible"`: convergence is a `tandem`-key rule, and only
    // that key's `classify` can return the arm that reaches it. An npx entry
    // under this key — `.claude-plugin/plugin.json` emits one — stays inert the
    // way it always has, because `isRecordedPathGone` exempts bare names for
    // both the command and the script half.
    script: () => CHANNEL_DIST,
    classify: () => "ours-node",
  },
};

/** Entry keys the boot sweep repairs, in the order it visits them. */
const REFRESHABLE_ENTRY_KEYS = Object.keys(REFRESHABLE) as RefreshableEntryKey[];

/**
 * Repair a `tandem` or `tandem-channel` entry whose recorded Node path has gone
 * stale.
 *
 * Writing an absolute Node path (see `node-binary.ts`) fixes a command that
 * could not be resolved — but it trades that for a path that can later stop
 * existing: a deleted nvm/fnm version, a Tauri update that relocates the
 * sidecar, macOS App Translocation, an AppImage's per-run mount, an
 * `npm uninstall -g`. Write-time validation cannot see any of those; only a
 * check at start can. Without this, the absolute-path change would swap one
 * silent failure for a worse one, since a dead absolute path can never recover
 * while a bare name might still resolve.
 *
 * Three shapes are deliberately left alone, and each would be a regression to
 * touch:
 *   - **HTTP entries** (Claude Code's `tandem`) have no `command` → `no-op`.
 *   - **A bare-`npx` fallback OUTSIDE the convergence rule's scope.** For the
 *     `tandem-channel` key, and for any `tandem` entry that fails one of
 *     {@link convergeNpxEntry}'s gates, the entry is left exactly as found.
 *     Note the mechanism, because it is easy to state wrongly: for
 *     `tandem-channel` it is `isRecordedPathGone` reporting `false` for a bare
 *     name; for `tandem` the entry never reaches that probe at all, because
 *     `classify` routes it away first. An *absolute* npx is a third case — it
 *     is probed, and if it is gone the entry is left visibly dead rather than
 *     silently downgraded, since substituting a Node binary would leave
 *     `<node> -y tandem-editor@x mcp-stdio`, which spawns nothing.
 *   - **A `tandem` entry that is not ours** — see {@link isOwnStdioBridgeScript}.
 *
 * Read-side rules (never create, never replace malformed JSON, no parse detail
 * in a log) are `readConfigForMutation`'s; this function owns only the decision
 * and the write. `deps` is a test seam; production wants the defaults.
 */
export async function refreshMcpEntryBinary(
  configPath: string,
  deps: RefreshDeps = {},
): Promise<RefreshNodeBinaryResult> {
  const opened = await readConfigForMutation(configPath);
  if (opened.status !== "ok") return opened;

  const { changed, result } = repairEntryInPlace(opened.servers, deps);
  if (changed) await atomicWrite(JSON.stringify(opened.root, null, 2) + "\n", configPath);
  return result;
}

interface RefreshDeps {
  probe?: (p: string) => boolean | null;
  resolveBinary?: () => string;
  /** Which entry to repair. Defaults to `tandem-channel` so the pre-existing
   *  call shape (and its suite) is unchanged. */
  entryKey?: RefreshableEntryKey;
  /** Override the script the entry should point at. Test seam only — production
   *  takes it from {@link REFRESHABLE}, where the key→script pairing cannot be
   *  got wrong. */
  script?: string;
  /** Which client config this entry lives in. Convergence is scoped to
   *  `claude-desktop` — see {@link convergeNpxEntry}. Undefined means "unknown
   *  target", which declines: only the sweep knows the kind, and only it should
   *  be able to unlock the branch. */
  targetKind?: TargetKind;
  /** Test seam for the durability gate. Production leaves it undefined and
   *  {@link isDurableScriptPath} decides.
   *
   *  Required as a seam, not a convenience: under vitest the real signal is
   *  computed from a checkout, so every positive-path case would be unwritable
   *  and the suite would silently test only refusals. */
  durable?: boolean;
}

/**
 * Is `script` in a layout durable enough to record in a file that outlives this
 * process?
 *
 * **Fails CLOSED**, and the cost matrix is why: declining leaves the user exactly
 * as they are today (a bare-`npx` entry, which `tandem doctor` now explains),
 * while converging onto an ephemeral path writes the *unrecoverable* failure mode
 * that `41a893a4` deliberately avoided. A gate whose unknown case takes the risky
 * branch is not a gate.
 *
 * Keyed on the path being WRITTEN, not on `PACKAGE_ROOT`. In the Tauri sidecar
 * `STDIO_BRIDGE_DIST` comes from the injected `TANDEM_STDIO_BRIDGE_DIST`,
 * resolved from the app's resource dir and unrelated to `PACKAGE_ROOT` — so
 * testing the latter would check the durability of a root we do not commit.
 *
 * **A positive allowlist of path shapes is not enough on its own, and an earlier
 * draft of this function proved it.** Matching `/node_modules/` admits
 * `~/.npm/_npx/<hash>/node_modules/tandem-editor/…`, which npm prunes — the exact
 * disposable layout the allowlist was chosen to exclude. Matching
 * `.app/Contents/` covers the macOS bundle and silently excludes the Windows and
 * Linux desktop installs, whose `resource_dir` is the Program Files directory or
 * `/usr/lib/<app>`, so the feature would have been dead on two of three
 * platforms with nothing saying so. Hence: disposable caches are excluded
 * FIRST, and the desktop case is recognised by provenance rather than by shape.
 *
 * The provenance test is `TANDEM_TAURI_SIDECAR` minus a dev checkout. The env var
 * alone is not sufficient — it is set on every sidecar spawn including
 * `cargo tauri dev`, where the bridge resolves inside the checkout — so the
 * `.git` ancestor walk is what separates an installed bundle from a developer
 * run, on every platform and without naming any install directory.
 *
 * The deeper fix, if this ever needs to be more precise: `resolve_stdio_bridge_dist`
 * in `src-tauri/src/lib.rs` already *knows* whether it returned the `resource_dir`
 * path or the `current_dir()` fallback, and throws that away. Injecting a
 * durability flag beside the path would replace this inference with the fact.
 */
export function isDurableInstallLayout(
  script: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): boolean {
  // Translocation is THE durability failure this codebase has already been bitten
  // by, and it has a shared predicate. A quarantined `.app` runs from a randomized
  // read-only mount that is gone next launch, so a path recorded there works
  // exactly once.
  if (isAppTranslocatedPath(script)) return false;
  // Disposable one-shot caches, checked BEFORE the `node_modules` branch because
  // they live underneath one. This is the only blocklist here, and it is scoped
  // to a question the allowlist below cannot answer.
  if (/[/\\](_npx|dlx|\.bun)[/\\]/.test(script)) return false;
  if (/[/\\]node_modules[/\\]/.test(script)) return true;
  if (env.TANDEM_TAURI_SIDECAR === "1") return !hasGitAncestor(dirname(script), exists);
  return false;
}

/**
 * Does `dir` or any ancestor contain a `.git`?
 *
 * `exists`, not `isDirectory`: in a git worktree or submodule `.git` is a FILE
 * holding a `gitdir:` pointer, and this repo uses worktrees — an `isDirectory`
 * test would wave a worktree through as an installed bundle.
 */
function hasGitAncestor(from: string, exists: (p: string) => boolean): boolean {
  let dir = from;
  for (;;) {
    if (exists(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Converge a bare-`npx` `tandem` entry onto the absolute Node + bridge pair.
 *
 * The entry this repairs never spawns on the machines it exists for: an MCP
 * `command` with no path separator is resolved through the CLIENT's PATH, and a
 * GUI-launched macOS client gets roughly `/usr/bin:/bin:/usr/sbin:/sbin` — no
 * Node. The transport dies before `initialize` with nothing in Tandem's logs.
 *
 * **This reverses a deliberate decision (`41a893a4`), so the reasoning matters.**
 * That commit kept the bare-npx floor "so a degraded resolve never emits
 * something worse than what shipped", and its real argument — stated three times
 * across this file and `node-binary.ts` — is that **bare-npx is the *recoverable*
 * failure mode and an absolute path is the *unrecoverable* one**. That argument
 * is still correct, and it is why this function is gated the way it is rather
 * than being a simple shape swap. What makes the reversal safe is NOT
 * "the sweep owns the entry afterwards and will re-repair it": the entry is
 * expected to outlive Tandem entirely (macOS and Linux have no uninstaller to
 * invoke the scrub, and `npm uninstall -g` never runs it), and a dead absolute
 * path has no process left to fix it. What makes it safe is SCOPE — see the
 * target-kind gate below.
 *
 * `args` becomes exactly ONE element. Two would leave `validateTandemEntry`'s
 * Node branch and read back as `invalid-args`, so the wizard would pre-select
 * `apply: "skip"` on our own write; and the same 1-arg shape aimed at
 * `dist/cli/index.js` would fall through to `runStart()` and spawn a whole
 * Tandem server onto the MCP wire.
 *
 * Not a migration, so it carries no sunset date: `buildStdioTandemEntry` still
 * emits this exact tuple as its fallback floor today, which makes this a
 * permanent convergence rule ("if the absolute pair has since become buildable,
 * converge on it"), symmetric to the staleness repair beside it. That premise
 * lives in code and `tests/shared/npx-entry-spec.test.ts` fails if it stops
 * holding — the tracked criterion, in place of a date.
 */
function convergeNpxEntry(
  record: Record<string, unknown>,
  ctx: {
    resolveBinary: () => string;
    script: string;
    targetKind: TargetKind | undefined;
    durable: boolean | undefined;
  },
): { changed: boolean; result: EntryRepairResult } {
  const noOp = { changed: false, result: { status: "no-op" } as const };

  // GATE 1 — scope, and it is the one doing the real work.
  //
  // `buildMcpEntries` emits the stdio pair ONLY for `claude-desktop`; Claude
  // Code always gets `{type:"http", url}` with no command at all. So Tandem has
  // never written a bare-npx `tandem` entry into `~/.claude.json`, and every one
  // there is foreign by construction — a hand-copy of `.claude-plugin/plugin.json`,
  // a `claude mcp add`, or a pre-HTTP Tandem. Converting those would make Tandem
  // permanently adopt an entry it did not write (they satisfy
  // `isOwnStdioBridgeScript` ever after), and in `~/.claude.json` the bare name
  // usually WORKS, because a terminal-launched client has a full PATH.
  //
  // Version pinning cannot substitute for this. The plugin manifest pins
  // `tandem-editor@<CLI_VERSION>` and a test keeps it there, while an entry an
  // older Tandem wrote is pinned to the version current when it was written — so
  // a "pin must equal CLI_VERSION" rule admits exactly the shape that must never
  // be adopted and refuses exactly the population this exists for. Scope is the
  // discriminator; the pin is noise.
  if (ctx.targetKind !== "claude-desktop") return noOp;

  const env = record.env;
  if (env === null || typeof env !== "object" || Array.isArray(env)) return noOp;
  const envRecord = env as Record<string, unknown>;

  // GATE 2 — env allowlist. Refuse, never strip.
  //
  // The rewrite turns an entry that NEVER SPAWNS into one that does, so every
  // field in this block moves from inert to executed. Two consequences, both
  // verified rather than assumed:
  //
  //   1. `resolveTandemUrlCandidate` reads `CLAUDE_PLUGIN_OPTION_SERVER_URL`
  //      BEFORE `TANDEM_URL` (and the token resolver does the same), so a gate
  //      that validated `TANDEM_URL` alone would be inspecting the loser of a
  //      precedence chain.
  //   2. The MCP SDK spawns with `{...getDefaultEnvironment(), ...entry.env}` —
  //      the config env spread last, unfiltered, over a default allowlist that
  //      excludes `NODE_OPTIONS`. So any key here reaches the spawned Node.
  //
  // This is not a privilege escalation — anyone who can write this `env` can
  // write their own `{command:"node", args:["evil.js"]}` entry and get the same
  // execution without Tandem. The objection is narrower and still sufficient:
  // Tandem must not take a provably-inert entry and ARM it while carrying env it
  // never wrote and never inspected.
  //
  // Refusing rather than stripping is deliberate. Stripping silently mutates a
  // user's config; refusing leaves the inert entry inert, which is the same
  // direction as "bare-npx is the recoverable failure mode".
  for (const key of Object.keys(envRecord)) {
    if (!STDIO_ENTRY_ENV_KEY_SET.has(key)) return noOp;
  }

  // GATE 3 — the URL must be the one we write.
  //
  // Exact equality with `MCP_URL`, NOT `LoopbackUrl`. That schema accepts any
  // port (`http://127.0.0.1:9999` passes), so it would let the bearer token
  // reach any local listener; it also rejects `localhost` despite its own
  // docblock claiming otherwise. Exact equality is stricter, needs no `zod` in
  // the `dist/cli` bundle, and keeps this decision readable.
  //
  // A missing `TANDEM_URL` declines. Not because loopback is unprovable — the
  // runtime defaults to loopback when it is absent — but because we only
  // converge entries whose env Tandem itself wrote, and the desktop branch
  // always sets it.
  if (envRecord.TANDEM_URL !== MCP_URL) return noOp;

  // GATE 4 — a replacement binary must exist.
  //
  // Ahead of the durability gate because it is pure (the resolver memoizes) and
  // durability ends in a syscall: a host whose `execPath` fails the basename
  // allowlist — the Debian-lineage `nodejs` case `node-binary.ts` documents —
  // declines here without touching the disk. No `isValidNodeBinary` re-check
  // follows: `resolveNodeBinary` returns either an allowlist-clean absolute path
  // or `BARE_NODE`, and the staleness path beside this one trusts that same
  // postcondition. Re-validating in one of the two writers and not the other
  // would be a difference someone later has to explain.
  const nodeBinary = ctx.resolveBinary();
  // Never "repair" into the bare name: it is the shape that failed in the field,
  // and `isRecordedPathGone` exempts bare names, so doctor would go permanently
  // quiet about a still-broken entry.
  if (nodeBinary === BARE_NODE) return noOp;

  // GATE 5 — durability, fail-closed. See `isDurableInstallLayout`.
  //
  // The existence check is deliberately NOT folded into that predicate: the
  // `durable` seam would then disable it too, and no test would cover "the
  // bridge is missing" on this path. `isFile`, not `existsSync` — a directory
  // named `index.js` is not something to record as a script, and `isFile` is
  // also total against EACCES and disconnected shares.
  if (!isFile(ctx.script)) return noOp;
  if (!(ctx.durable ?? isDurableInstallLayout(ctx.script))) return noOp;

  record.command = nodeBinary;
  record.args = [ctx.script];
  return { changed: true, result: { status: "converged" } };
}

/**
 * Decide and apply one key's repair, mutating `servers` in place.
 *
 * Split out of the read/write wrapper so the boot sweep can repair every key
 * against a SINGLE parse of the file and commit them with a single write. Doing
 * it per key meant two reads (and up to two writes) of the same `~/.claude.json`
 * per config — a file that is routinely multi-megabyte because it stores
 * per-project history, on a path that is awaited during startup.
 */
function repairEntryInPlace(
  servers: Record<string, unknown>,
  deps: RefreshDeps,
): { changed: boolean; result: EntryRepairResult } {
  const noOp = { changed: false, result: { status: "no-op" } as const };

  const resolveBinary = deps.resolveBinary ?? resolveNodeBinary;
  const entryKey = deps.entryKey ?? "tandem-channel";
  const descriptor = REFRESHABLE[entryKey];
  const script = deps.script ?? descriptor.script();

  const entry = servers[entryKey];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return noOp;
  const record = entry as Record<string, unknown>;
  const command = record.command;
  if (typeof command !== "string") return noOp;

  // Ownership gate. The `tandem` key is shared ground: it also holds legacy
  // sidecar invocations from older Tauri builds, npx fallbacks, and whatever a
  // user hand-edited — and the legacy shape is arity-identical to ours. Leaving
  // anything else exactly as found is the whole point for a hand-edit.
  const ownership = descriptor.classify(command, record.args);
  if (ownership === "foreign") return noOp;

  // Convergence sits INSIDE the ownership gate, as its own arm — not above it.
  // Placing it above would make it a second ownership rule bypassing the table
  // that exists to hold exactly one.
  //
  // It MUST return rather than fall through, and the failure mode is silent: a
  // fall-through would be re-classified `ours-node`, then find `args[0] ===
  // script` (no script refresh) and `isRecordedPathGone(process.execPath) ===
  // false` (no binary rewrite), and exit below as `{changed: false, "no-op"}` —
  // so the mutation just made to `record` would never be written and the sweep
  // would report having done nothing.
  if (ownership === "npx-convergible") {
    return convergeNpxEntry(record, {
      resolveBinary,
      script,
      targetKind: deps.targetKind,
      durable: deps.durable,
    });
  }

  // The script path is checked INDEPENDENTLY of the binary, and first.
  //
  // This block used to sit after an early `return` on a healthy `command`, so
  // it could only ever run when the binary was ALSO stale. The docblock
  // justified that by asserting the two go stale in lockstep — but nothing
  // enforces it and their roots are different: `command` is `process.execPath`,
  // `args[0]` is `CHANNEL_DIST`, derived from `PACKAGE_ROOT`/`__dirname`. A
  // global npm reinstall to a new prefix, or a rebuilt `dist/` under a
  // relocated package root, moves the script while Node stays exactly where it
  // was. The entry then spawns a working Node that dies on `Cannot find
  // module`, and `tandem doctor` — which inspects `command` alone — calls it
  // healthy. (Tauri updates and App Translocation really do move both; that
  // case was never the problem.)
  let scriptRefreshed = false;
  const args = record.args;
  if (Array.isArray(args) && typeof args[0] === "string" && args[0] !== script) {
    if (isRecordedPathGone(args[0], deps.probe) && existsSync(script)) {
      args[0] = script;
      scriptRefreshed = true;
    }
  }

  let commandRewrite: { from: string; to: string } | null = null;
  let noValidReplacement = false;
  if (isRecordedPathGone(command, deps.probe)) {
    const next = resolveBinary();
    // Refuse to "repair" a dead absolute path into the bare name. That is not a
    // fix — `node-binary.ts` documents the bare name as the thing that failed in
    // the field — and it is actively worse for diagnosis: `isRecordedPathGone`
    // exempts bare names, so `tandem doctor` would go permanently quiet about an
    // entry that is still broken. Leaving the dead path in place keeps it visible.
    if (next === BARE_NODE) noValidReplacement = true;
    else if (next !== command) commandRewrite = { from: command, to: next };
  }

  if (commandRewrite === null && !scriptRefreshed) {
    return noValidReplacement
      ? { changed: false, result: { status: "skipped", reason: "no-valid-replacement" } }
      : noOp;
  }

  if (commandRewrite !== null) record.command = commandRewrite.to;
  return {
    changed: true,
    result: {
      status: "rewritten",
      from: commandRewrite?.from ?? null,
      to: commandRewrite?.to ?? null,
      scriptRefreshed,
    },
  };
}

/**
 * Boot-time sweep over every detected client config, for every entry key that
 * can carry an absolute path.
 *
 * Deliberately NOT filtered to a target kind. `shouldRegisterChannelShim` only
 * ever writes a shim for Claude Code and the stdio `tandem` entry only goes to
 * Claude Desktop, so filtering would be correct today — but it would be a
 * second, independently-maintained copy of those rules, and the function is
 * already total: a missing key, an HTTP entry, a bare-`npx` fallback and a
 * `tandem` entry Tandem did not write all fall out as `no-op`. Leaving it
 * unfiltered also repairs an entry left behind by an older Tandem.
 *
 * The npx-convergence branch is the ONE thing here that is scoped by target
 * kind, and it is scoped for a reason that does not generalize to the rest of
 * this function. Repair is total — every foreign shape falls out as `no-op` —
 * so leaving it unfiltered costs nothing. Convergence is not a repair: it
 * replaces `args` wholesale, and in `~/.claude.json` it would be replacing an
 * entry Tandem never wrote (that file only ever gets the HTTP shape) which
 * usually WORKS there, because a terminal-launched client has a full PATH. So
 * `target.kind` is threaded in and {@link convergeNpxEntry} declines unless it
 * is `claude-desktop`.
 */
export async function refreshAllMcpEntryBinaries(
  opts: { homeOverride?: string } = {},
): Promise<void> {
  // Yield before any filesystem work. `void` alone would NOT defer this:
  // it only defers what follows the first `await`, and `detectTargets` is
  // synchronous (on Windows it readdirs %LOCALAPPDATA%\Packages), so the whole
  // sweep would otherwise run inline on the caller's startup stack.
  await Promise.resolve();

  // `detectTargets` is inside the try: it stats and realpaths OS roots and can
  // throw (an unresolvable home, an EPERM on a redirected profile). Leaving it
  // outside would break this function's own best-effort contract and hand a
  // rejection to the caller.
  let targets: DetectedTarget[];
  try {
    targets = detectTargets({ homeOverride: opts.homeOverride });
  } catch (err) {
    console.error(
      `[Tandem] Could not enumerate client configs for channel-entry refresh (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  for (const target of targets) {
    try {
      // ONE read and at most ONE write per config, however many keys we repair.
      // `~/.claude.json` is routinely multi-megabyte (it stores per-project
      // history) and this is awaited on the startup path ahead of the launcher
      // spawn, so a read per key would put the whole file through `stat` +
      // `readFile` + `JSON.parse` twice to answer a question that is `no-op` for
      // one of the keys in almost every real config.
      const opened = await readConfigForMutation(target.configPath);
      if (opened.status !== "ok") {
        if (opened.status === "skipped") {
          // Every refusal was previously silent. `malformed-json` in particular
          // deserves to be loud: `~/.claude.json` is the whole MCP registry, so
          // if it does not parse then EVERY server the user has is broken — and
          // Tandem is the only process that just found out. The reasons are
          // fixed enum strings precisely so they are safe to log (parse-error
          // text would embed a source snippet from a file holding bearer tokens).
          console.error(
            `[Tandem] Left ${target.label} untouched (${opened.reason}). ` +
              "Run 'tandem doctor' for the full check.",
          );
        }
        continue;
      }

      let dirty = false;
      for (const entryKey of REFRESHABLE_ENTRY_KEYS) {
        // `targetKind` is threaded because convergence is scoped to Claude
        // Desktop and ONLY the sweep knows which config it is looking at. A
        // default here would unlock the branch for every direct caller.
        const { changed, result } = repairEntryInPlace(opened.servers, {
          entryKey,
          targetKind: target.kind,
        });
        dirty ||= changed;
        if (result.status === "converged") {
          // A DISTINCT sentence, not the staleness one. Nothing was stale here —
          // a bare name cannot go stale — and `args` was replaced wholesale
          // rather than refreshed. This string is what a user pastes into a bug
          // report, so it has to describe what actually happened, including the
          // restart they have not been prompted for by anything else.
          console.error(
            `[Tandem] Converged the ${entryKey} entry in ${target.label} from 'npx' onto a ` +
              "bundled Node path — restart the client for it to take effect.",
          );
        } else if (result.status === "rewritten") {
          // Name what actually moved. The binary and the script are repaired
          // independently, so `from`/`to` are null on a script-only fix —
          // logging them unconditionally would print "null → null" for a real
          // repair.
          const what =
            result.from === null
              ? "script path refreshed"
              : `${result.from} → ${result.to}` +
                (result.scriptRefreshed ? ", script path also refreshed" : "");
          console.error(`[Tandem] Repaired stale ${entryKey} entry in ${target.label} (${what}).`);
        } else if (result.status === "skipped") {
          console.error(
            `[Tandem] Left the ${entryKey} entry in ${target.label} untouched (${result.reason}). ` +
              "Run 'tandem doctor' for the full check.",
          );
        } else {
          // Exhaustiveness. This block used to end at the `skipped` branch with
          // no `else`, so a status nobody had handled would have rewritten the
          // user's `~/.claude.json` and said NOTHING — the loudest possible
          // action with the quietest possible output. `EntryRepairResult` is
          // narrowed to what `repairEntryInPlace` can actually produce so this
          // can compile at all.
          result.status satisfies "no-op";
        }
      }
      if (dirty) {
        // `requireExistingDest` because this is a REPAIR: the file was read
        // moments ago and must still be there. Without it a config deleted
        // mid-sweep would be recreated from our in-memory snapshot, resurrecting
        // every other vendor's entries the user just removed. That window
        // matters more now than it did — before convergence this write
        // essentially never fired.
        await atomicWrite(JSON.stringify(opened.root, null, 2) + "\n", target.configPath, {
          requireExistingDest: true,
        });
      }
    } catch (err) {
      // Include the target — a Windows box can have Claude Code plus several
      // Desktop/MSIX configs, and an anonymous one-liner does not say which
      // failed. This is also where `assertPathSafe`'s rejection lands, i.e.
      // "someone symlinked this config", which is worth naming.
      console.error(
        `[Tandem] MCP entry refresh failed for ${target.label} (${target.configPath}, non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/**
 * Conditionally back up `configPath` before `applyConfig` overwrites a
 * user-customised tandem entry. Returns the backup path on write, or
 * `undefined` when no backup was needed (fresh install, token rotation,
 * non-tandem-key changes only).
 *
 * Atomicity contract: if this throws, the caller MUST abort before
 * touching the destination. The original config and any prior backup
 * remain intact.
 */
async function maybeBackupExistingConfig(
  configPath: string,
  existing: { mcpServers?: Record<string, McpEntry> },
  ops: ApplyOps,
): Promise<string | undefined> {
  const existingTandem = existing.mcpServers?.tandem;
  if (!shouldBackup(existingTandem, ops.create.tandem)) return undefined;

  const dir = backupDir(resolveAppDataDir());
  // assertPathSafe defeats XDG_DATA_HOME poisoning — same hardening as
  // the broken-JSON backup path above.
  assertPathSafe(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // mkdirSync's `mode` only applies on creation. If the dir already
  // existed at a more permissive mode (older umask, manual creation,
  // user fiddling), tighten it now. POSIX-only; on Windows the file's
  // own ACL — set by setRestrictiveAcl inside writeBackup — is the
  // protection. Filenames in a broader dir leak timestamps, not
  // bytes; failing closed here would block legit setups for that.
  if (process.platform !== "win32") {
    try {
      const dirStat = statSync(dir);
      if ((dirStat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    } catch {
      // stat/chmod failure is non-fatal — proceeds with the wider
      // protection on the file itself.
    }
  }

  const content = readFileSync(configPath);
  const backupPath = await writeBackup(dir, content);
  // Prune AFTER successful write so we never delete the previous backup
  // before its replacement is on disk.
  await pruneOldBackups(dir);
  return backupPath;
}

/**
 * Install the Tandem skill to ~/.claude/skills/tandem/SKILL.md.
 * Claude Code auto-discovers skills in this directory and uses the description
 * field to trigger them when tandem_* tools are present.
 *
 * `homeOverride` is supported for tests only — the apply HTTP handler
 * MUST NOT thread this from the request body. Same symlink/realpath
 * hardening as `applyConfig`.
 */
export async function installSkill(opts: { homeOverride?: string } = {}): Promise<void> {
  const home = opts.homeOverride ?? homedir();
  const skillPath = join(home, ".claude", "skills", "tandem", "SKILL.md");
  assertPathSafe(skillPath, { allowedRoots: opts.homeOverride ? [opts.homeOverride] : undefined });
  await mkdir(dirname(skillPath), { recursive: true });
  await atomicWrite(SKILL_CONTENT, skillPath);
}

/** Parse the integer `version:` from a skill front-matter block. Returns 0
 * if the file doesn't exist, has no version, or fails to parse — older
 * bundled skills predate the version stamp, so 0 means "definitely upgrade". */
function readSkillVersion(skillContent: string): number {
  const match = skillContent.match(/^version:\s*(\d+)\s*$/m);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : 0;
}

const BUNDLED_SKILL_VERSION = readSkillVersion(SKILL_CONTENT);
const SKILL_REFRESH_TIMEOUT_MS = 5_000;

/** Module-scoped last-failure record. Cleared on successful refresh; set on
 * path, read, write, or deadline failure. Surfaced via
 * `GET /api/launcher/status` (loopback only) so the palette/settings UI can
 * warn the user that the bundled skill is out of date. `null` when last
 * refresh succeeded or was a no-op. */
let lastSkillRefreshError: SkillRefreshError | null = null;
export function getSkillRefreshError(): SkillRefreshError | null {
  return lastSkillRefreshError;
}
/** Test-only — reset module state between tests. */
export function _resetSkillRefreshErrorForTests(): void {
  if (process.env.VITEST !== "true") return;
  lastSkillRefreshError = null;
}

/**
 * Idempotently refresh an existing setup-managed skill.
 *
 * Compares the bundled `version:` against the on-disk file. Writes only
 * if bundled > on-disk. A missing file is an intentional no-op: generic
 * server startup must not install a standalone copy for plugin-only users.
 * Failures are recorded for the loopback launcher-status route but never
 * thrown. A cancellation deadline reaches signal-aware file writes and
 * Windows ACL subprocesses, and an abort check immediately before rename
 * prevents those phases from committing after cancellation. Node does not
 * make every filesystem primitive cancellable, so this is not an absolute
 * wall-clock bound. The wizard-driven `installSkill()` remains the
 * authoritative, consent-bearing installer.
 */
export async function refreshExistingSkillIfStale(
  opts: {
    homeOverride?: string;
    /** Cancellation deadline for signal-aware phases. Production defaults to five seconds. */
    timeoutMs?: number;
    /** Filesystem-boundary test seam; ignored outside Vitest. */
    _writeSkillForTests?: (content: string, dest: string, signal: AbortSignal) => Promise<void>;
    /** Test-only seam immediately before the existing-file commit guard. */
    _beforeSkillCommitForTests?: () => Promise<void>;
  } = {},
): Promise<void> {
  if (BUNDLED_SKILL_VERSION === 0) return; // Bundled skill has no version stamp — nothing to compare.
  const home = opts.homeOverride ?? homedir();
  const skillPath = join(home, ".claude", "skills", "tandem", "SKILL.md");
  try {
    assertPathSafe(skillPath, {
      allowedRoots: opts.homeOverride ? [opts.homeOverride] : undefined,
    });
  } catch (err) {
    lastSkillRefreshError = {
      code: "path-rejected",
      message: err instanceof Error ? err.message : String(err),
    };
    console.error(
      `[Tandem] Skill refresh rejected unsafe path (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  const timeoutMs = opts.timeoutMs ?? SKILL_REFRESH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException(`Skill refresh timed out after ${timeoutMs}ms`, "TimeoutError"),
    );
  }, timeoutMs);
  timeout.unref?.();
  const { signal } = controller;
  let stage: "read" | "write" = "read";
  try {
    const current = await readFile(skillPath, { encoding: "utf8", signal });
    const onDiskVersion = readSkillVersion(current);
    if (onDiskVersion >= BUNDLED_SKILL_VERSION) {
      lastSkillRefreshError = null;
      return;
    }

    stage = "write";
    await mkdir(dirname(skillPath), { recursive: true });
    throwIfAborted(signal);
    const writeSkill =
      process.env.VITEST === "true" && opts._writeSkillForTests
        ? opts._writeSkillForTests
        : (content: string, dest: string, writeSignal: AbortSignal) =>
            atomicWrite(content, dest, {
              signal: writeSignal,
              requireExistingDest: true,
              beforeCommitForTests: opts._beforeSkillCommitForTests,
            });
    await writeSkill(SKILL_CONTENT, skillPath, signal);
    lastSkillRefreshError = null;
    console.error(
      `[Tandem] Refreshed bundled skill at ${skillPath} (v${onDiskVersion} → v${BUNDLED_SKILL_VERSION}).`,
    );
  } catch (err) {
    // Generic server startup must never cross the standalone-skill install
    // boundary. Only the wizard / `tandem setup` may create this file.
    if (stage === "read" && (err as NodeJS.ErrnoException).code === "ENOENT") {
      lastSkillRefreshError = null;
      return;
    }
    const timedOut = signal.aborted;
    const message = timedOut
      ? `Skill refresh timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    lastSkillRefreshError = {
      code: timedOut ? "timed-out" : stage === "read" ? "read-failed" : "write-failed",
      message,
    };
    console.error(`[Tandem] Skill refresh failed (non-fatal): ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns true if the channel-shim build artifact exists at the given path.
 * Exported so the prereq check can be tested without spawning runSetup.
 */
export function validateChannelShimPrereq(channelPath: string): boolean {
  return existsSync(channelPath);
}

/**
 * Single source of truth for "should this target get the stdio channel shim?".
 *
 * **The shim is opt-in (Track E, 2026-08-07). It used to be default-on for the
 * Claude Code target, and that default was doing active harm.**
 *
 * `runChannel` calls `startEventBridge` unconditionally, without asking whether
 * the host negotiated `claude/channel` — and the SDK has no case for
 * `notifications/claude/channel` in `assertNotificationCapability`, so delivery
 * never throws, the stream never tears down, and a shim whose host ignores the
 * notification holds its subscriber slot forever. For every user who had run
 * setup, something was therefore **attached and inert**.
 *
 * That is not merely wasteful. `subscribers === 0` is the only SOUND negative
 * Tandem has — a positive count never proves delivery, but a zero does prove
 * its absence — so a permanently-attached inert consumer suppressed every
 * signal keyed on the count, including the "nothing is notifying Claude"
 * notice built to warn exactly the users it was silently failing. Restoring a
 * reachable zero is the point of this change; the shim itself was never the
 * thing delivering for the mainstream.
 *
 * The two paths that DO deliver are unaffected: launcher-spawned sessions are
 * woken by the supervisor writing to the child's stdin (#1266, measured), and
 * hand-launched sessions can arm their own watch (ADR-047).
 *
 * - `targetPushSupport(kind) === "none"` (today: `claude-desktop`, the Cowork
 *   stdio path — the node-process shim does not apply there) → always false,
 *   ahead of the override, because no flag can conjure a transport that does
 *   not exist. That predicate lives in `shared/integrations/contract.ts` rather
 *   than as a bare `=== "claude-desktop"` here so the WIZARD can read the same
 *   fact and say it out loud. It could not before, which is how a Claude
 *   Desktop user came to be told "AI connected" and then ignored (#1299).
 * - `override` (explicit `--with-channel-shim`) wins when provided. Opting in
 *   is still fully supported. NOTE there is no wizard checkbox: the wizard's
 *   apply route calls this with no override, so the CLI flag is the only way
 *   to turn it on.
 * - Otherwise → **false**. Absent an explicit request, no shim is written.
 *
 * The old default also consulted `validateChannelShimPrereq`, and that call is
 * gone along with the default it guarded — but the function is deliberately
 * still exported and still used by the CLI: an explicit opt-in whose build
 * artifact is missing should be reported to the user, not silently honoured
 * into an unstartable entry.
 */
export function shouldRegisterChannelShim(
  targetKind: TargetKind,
  _channelPath: string,
  override?: boolean,
): boolean {
  if (targetPushSupport(targetKind) === "none") return false;
  return override ?? false;
}

/** Re-exported for `tandem setup` orchestration in `src/cli/setup.ts`. */
export { CHANNEL_DIST, PACKAGE_ROOT };

/**
 * Does this config already carry a `tandem-channel` entry?
 *
 * Answers "what is registered", which is a different question from
 * `shouldRegisterChannelShim`'s "what should a fresh setup register" — see the
 * note on `applyConfigWithToken`. Unreadable, absent, oversized and malformed
 * configs all answer `false`: there is nothing to preserve in any of them, and
 * `applyConfig` will start that file fresh anyway.
 */
async function targetHasChannelEntry(configPath: string): Promise<boolean> {
  const read = await readConfigForMutation(configPath);
  return read.status === "ok" && "tandem-channel" in read.servers;
}

/**
 * Should this target carry a `tandem-channel` entry after this write?
 *
 * The single resolver for a question two loops used to answer separately, and
 * drifted on: `applyConfigWithToken` and `tandem setup`'s `writeTargets`. Both
 * pass `undefined` when the user gave no flag, and `applyOpsForCli` turns a
 * `false` into an explicit REMOVE — so "no opinion" silently meant "delete it".
 *
 * Three-way, in priority order:
 *
 *  1. **No push transport for this kind** (today `claude-desktop`, the Cowork
 *     stdio path) → `false`, ahead of everything, because no flag conjures a
 *     transport that does not exist (#1299). Entries there were written by
 *     Tandem during the default-on era and provably cannot deliver, so removing
 *     them is the intended cleanup rather than a surprise.
 *  2. **An explicit override** → honoured. `false` is a request to remove.
 *  3. **Otherwise, preserve what is registered.** A read failure THROWS rather
 *     than answering `false`: "I could not tell" and "there is nothing there"
 *     must not collapse, or a transient `EBUSY` from an antivirus scanner
 *     becomes a deletion. Both callers run this inside their per-target `try`,
 *     so a throw records an error and skips that target — which is the honest
 *     outcome for a config you could not read.
 */
export async function resolveChannelShimIntent(
  targetKind: TargetKind,
  configPath: string,
  override: boolean | undefined,
): Promise<boolean> {
  if (targetPushSupport(targetKind) === "none") return false;
  if (override !== undefined) return override;
  return await targetHasChannelEntry(configPath);
}

/**
 * Write the given token into all detected Claude MCP config files.
 * Returns the number of configs successfully updated and any per-target errors.
 *
 * CLI-shaped semantics: when `withChannelShim` is false, any existing
 * `tandem-channel` entry is removed (legacy install artifact). The
 * wizard's apply endpoint uses an explicit-confirmation code path
 * instead; this helper is for `tandem rotate-token` / `tandem setup`
 * where the flag already captures user intent.
 *
 * **When `withChannelShim` is ABSENT, the existing REGISTRATION is preserved.**
 * The entry BODY is still re-derived from `resolveNodeBinary()` and
 * `CHANNEL_DIST` — this heals a stale Node path the way `refreshMcpEntryBinary`
 * does, and a hand-customised `command`/`args` will be overwritten. What is
 * preserved is whether the entry exists at all. These are different questions and conflating them is a
 * data-loss bug. `shouldRegisterChannelShim` answers "what should a fresh
 * setup write?", which since Track E is `false` — and `applyOpsForCli` turns a
 * `false` into an explicit REMOVE. So calling it here made `tandem
 * rotate-token`, whose whole job is to change the token and nothing else,
 * silently delete a shim the user had deliberately opted into. `tandem setup`
 * always passes the flag explicitly and is unaffected; rotation is the caller
 * that omits it.
 */
export async function applyConfigWithToken(
  token: string | null,
  opts: { force?: boolean; withChannelShim?: boolean; homeOverride?: string } = {},
): Promise<{ updated: number; errors: string[] }> {
  // `homeOverride` exists for tests only, and it earns its keep: the
  // preserve-vs-re-derive distinction below is a property of the WIRING, not of
  // either helper, so nothing short of driving the real function against a real
  // config file can catch a regression in it.
  const targets = detectTargets({ force: opts.force, homeOverride: opts.homeOverride });

  let updated = 0;
  const errors: string[] = [];
  for (const t of targets) {
    try {
      const withChannelShim = await resolveChannelShimIntent(
        t.kind,
        t.configPath,
        opts.withChannelShim,
      );
      const entries = buildMcpEntries(CHANNEL_DIST, {
        withChannelShim,
        token: token ?? undefined,
        targetKind: t.kind,
      });
      await applyConfig(t.configPath, applyOpsForCli(entries, { withChannelShim }));
      updated++;
    } catch (err) {
      errors.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { updated, errors };
}
