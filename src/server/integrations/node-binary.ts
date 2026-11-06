/**
 * Which Node binary the generated `tandem-channel` MCP entry should invoke.
 *
 * Historically the entry was written as a bare `"node"`, which the MCP client
 * resolves through PATH at spawn time. That fails in two ways, both silent —
 * note they have different evidential standing:
 *
 *   1. **Node is not on the client's PATH at all.** OBSERVED: a macOS user's
 *      channel shim never started because bare `node` did not resolve. Claude
 *      Code now installs as a native binary (no Node required), and a
 *      GUI-launched client does not inherit a login shell's PATH. The user has
 *      a configured channel that delivers nothing.
 *   2. **Node resolves somewhere the client refuses to run it.** INFERRED, not
 *      observed for this entry. Claude Code rejects a bare-name tool whose
 *      resolved path sits under the current working directory — an
 *      anti-PATH-hijack guard, read out of `claude.exe` v2.1.223 and seen in
 *      the field for `git` during `claude plugin install`, never for a
 *      `tandem-channel` spawn. Whether an `mcpServers[].command` goes through
 *      that same resolver is NOT established. A per-user Node install plus a
 *      session started from the home directory would trip it.
 *
 * An absolute path fixes (1) outright and (2) if it applies: it needs no PATH
 * lookup, and — per the same v2.1.223 dispatch — a command containing a path
 * separator returns before the guard runs. Both quotes and their bounds are in
 * `docs/spikes/plugin-delivery.md`; they describe one vendor build and can go
 * stale on any Claude Code release.
 *
 * `process.execPath` is the right source. It is the Node already running
 * Tandem, so it demonstrably exists and can run the shim — and in the desktop
 * app it is the bundled sidecar, which `isValidNodeBinary`'s
 * `node-sidecar-<triple>` alternative was written to accept. That validator is
 * the contract this module must satisfy: the wizard re-reads generated config
 * through it (`existing-config.ts`), so emitting a path it rejects would make
 * Tandem report its own correct entry as invalid.
 *
 * The trade is a resolution failure for a staleness failure — a recorded
 * absolute path can outlive the binary (a deleted nvm version, a Tauri update,
 * macOS App Translocation, an AppImage remount). Write-time validation cannot
 * see that; `refreshMcpEntryBinary` in `./apply.ts` is the boot-time
 * counterpart that can, gated by `isRecordedPathGone` below.
 */
import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix as posixPath, resolve, win32 as win32Path } from "node:path";
import { isAppTranslocatedPath } from "../../shared/integrations/app-translocation.js";
import { isValidNodeBinary } from "../../shared/integrations/node-binary-name.js";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";

/** The pre-existing behaviour, and the fallback whenever an absolute path
 *  cannot be produced or would not validate. Never emit something the
 *  validator rejects — that is strictly worse than the bare name. */
export const BARE_NODE = "node";

/**
 * Windows extended-length prefix, DRIVE form only (`\\?\C:\…`).
 *
 * Deliberately not `^\\\\\?\\` — `\\?\UNC\server\share\…` must keep its leading
 * `\\` so `isValidNodeBinary`'s UNC rejection still fires. Stripping the prefix
 * blindly would convert an NTLM-leaking UNC path into one that validates, which
 * is the opposite of what this normalization is for.
 */
const WIN_EXTENDED_DRIVE_RE = /^\\\\\?\\([A-Za-z]:)/;

/**
 * Resolve the Node binary to embed in a generated `tandem-channel` entry.
 *
 * Returns an absolute, validator-clean path, or `BARE_NODE` when one cannot be
 * produced. `candidate` is injectable for tests; production always wants the
 * default.
 */
export function resolveNodeBinary(candidate: string = process.execPath): string {
  // Memoized for the DEFAULT candidate only. `process.execPath` cannot change
  // mid-process (this module already relies on that), while the callers loop:
  // `buildMcpEntries` resolves once per entry, and `writeTargets` /
  // `applyConfigWithToken` / `refreshAllMcpEntryBinaries` each loop over
  // every detected target. Without this, a host whose execPath fails
  // validation — a Debian `nodejs` basename, a home directory containing `..` —
  // prints `fallBackToBareNode`'s four-line warning once per target per
  // operation, and again on every boot sweep. One cause deserves one warning.
  //
  // An explicit candidate always recomputes: it is the test seam, and tests
  // assert on that warning firing per call.
  const isDefault = candidate === process.execPath;
  if (isDefault && defaultResolution !== undefined) return defaultResolution;
  const resolved = resolveNodeBinaryUncached(candidate);
  if (isDefault) defaultResolution = resolved;
  return resolved;
}

let defaultResolution: string | undefined;

/** Test seam: drop the memoized default so a suite can vary `process.execPath`. */
export function _resetNodeBinaryCacheForTests(): void {
  defaultResolution = undefined;
}

function resolveNodeBinaryUncached(candidate: string): string {
  if (!candidate) return BARE_NODE;
  // Strip the extended-length DRIVE prefix first: `process.execPath` can
  // legitimately return `\\?\C:\…` on Windows, and the check below rejects
  // `\\?\` outright. The UNC form (`\\?\UNC\…`) is deliberately not stripped,
  // so it still reaches that check.
  const stripped = candidate.replace(WIN_EXTENDED_DRIVE_RE, "$1");

  // Check raw AND resolved — the idiom `document-service.ts`, `convert.ts` and
  // `annotations.ts` already use, and both halves are load-bearing:
  //
  //   raw      catches the POSIX mangling. `resolve` is platform-dependent
  //            where this guard is not: on Windows it preserves a leading
  //            `\\`, but on POSIX it treats `\\server\share\node.exe` as a
  //            RELATIVE name and prepends cwd, erasing the prefix and leaving
  //            a basename that validates.
  //   resolved catches a `..` traversal that lands on a UNC target.
  //
  // Checking only one trades one blind spot for the other.
  if (rejectUnsafeWindowsPrefix(stripped) !== null) return fallBackToBareNode(stripped);
  const absolute = resolve(stripped);
  if (rejectUnsafeWindowsPrefix(absolute) !== null) return fallBackToBareNode(absolute);
  if (isValidNodeBinary(absolute)) return absolute;
  return fallBackToBareNode(absolute);
}

function fallBackToBareNode(rejected: string): string {
  // Say so. Falling back silently would reintroduce the exact bug this module
  // exists to fix: the entry would carry the bare name that failed in the
  // field, the wizard's re-read would ACCEPT it (basename `node` validates),
  // and `tandem doctor` skips bare names — so the user would see a green
  // wizard, a passing doctor, and a channel that never starts, with nothing
  // anywhere explaining why. Reachable in practice: a UNC path, a Debian-
  // lineage `nodejs` basename, or a home directory containing `..`.
  console.error(
    `[Tandem] Cannot embed an absolute Node path in the channel entry: ` +
      `"${rejected}" is not an accepted Node binary name. Falling back to "node", ` +
      `which requires the MCP client to resolve it on PATH — if real-time push ` +
      `never arrives, this is why. Run 'tandem doctor' for the push-path check.`,
  );
  return BARE_NODE;
}

/**
 * Does this path name a file — or can we not tell?
 *
 * Three-state on purpose, and that is the whole point of not reusing
 * `detect-claude-cli.ts`'s `isFile`. That helper is deliberately TOTAL: it
 * answers `false` when it cannot tell, because there "I could not read it" is
 * not evidence of an install. Here the polarity is inverted — a `false` makes
 * the caller REWRITE the user's `~/.claude.json`, so collapsing EACCES, ELOOP
 * or a disconnected network share into `false` would clobber a working config
 * on the strength of a probe that never ran.
 *
 *   - `false` — definitely not a usable binary (absent, or a directory).
 *   - `null`  — could not determine; callers must leave the config alone.
 *
 * A UNC path is refused before the `stat` rather than after (#1417): `stat` on
 * `\\host\share\node.exe` performs the SMB handshake that leaks an NTLM hash,
 * and the value reaching here came out of a config file we do not own. The
 * screen sits at the sink, not at `isRecordedPathAbsolute`, so it covers
 * `tandem doctor`'s direct calls too. `null` is the honest answer — refusing
 * to look is not evidence of absence, and `false` would rewrite the config.
 */
export function probeNodeBinary(path: string): boolean | null {
  if (rejectUnsafeWindowsPrefix(path) !== null) return null;
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) return false; // ENOENT — definitely gone
    return stat.isFile();
  } catch {
    return null; // EACCES / ELOOP / unreachable share — not evidence of absence
  }
}

/**
 * Is a previously-recorded `tandem-channel` command still usable?
 *
 * `true` means the recorded value is an absolute path that definitely no longer
 * resolves to a file — the staleness case above — and should be rewritten.
 *
 * Three cases deliberately report NOT stale:
 *   - A bare name. Whether it resolves is the client's lookup to perform at
 *     spawn time, not ours to second-guess, and rewriting it would undo a
 *     deliberate fallback.
 *   - A RELATIVE path. It resolves against the spawning client's working
 *     directory, which is not ours — so probing it here answers a different
 *     question than the one that matters. This used to test only "contains a
 *     separator", which let `./node_modules/.bin/node` (idiomatic in a
 *     project-scoped `.mcp.json`) be `stat`ed against whatever cwd the caller
 *     happened to have: `tandem doctor` runs wherever it was invoked, and
 *     `/api/diagnostics` runs in the server's cwd. A valid entry would be
 *     reported gone and, on the server side, rewritten.
 *   - An unreadable path (`probe` → `null`). Never rewrite a user's config on
 *     the strength of a probe that could not run.
 *
 * Absoluteness is tested against BOTH path flavours, not the host's. The value
 * comes out of a config file, and CI reads Windows-shaped fixtures on Linux —
 * `path.isAbsolute` alone would call `C:\...\node.exe` relative there.
 */
export function isRecordedPathGone(
  command: string,
  probe: (p: string) => boolean | null = probeNodeBinary,
): boolean {
  if (!isRecordedPathAbsolute(command)) return false;
  return probe(command) === false;
}

/**
 * Is this recorded command a path we are entitled to probe?
 *
 * Exported so callers can answer the cheap half — "is a `stat` even meaningful
 * here" — WITHOUT performing one, and without restating the rule. `tandem
 * doctor` needs exactly that: it wants the probe's three-state result for its
 * own reporting, so it cannot just call `isRecordedPathGone` and re-derive.
 * Sharing this predicate is what keeps the diagnosis and the repair from
 * drifting apart.
 */
export function isRecordedPathAbsolute(command: string): boolean {
  if (!command) return false;
  return win32Path.isAbsolute(command) || posixPath.isAbsolute(command);
}

// ── A system Node for Claude Code's `tandem` entry (#2358 PR 2b) ───────────
//
// Claude Code's setup entry is the stdio bridge, run by an absolute Node. A
// Windows desktop update replaces the bundled sidecar, killing the Node under
// every terminal's bridge, so the writer prefers a Node the user installed
// (Bryan, 2026-11-05: "Prefer system Node") and falls back to the running one
// only where that is durable. Design: docs/spikes/multi-session-ownership/
// README.md §3.6, "Rule: which Node".
//
// This walk EXECUTES a binary found on an environment-supplied path (its
// `--version`), which widens #1609's accepted `runDoctor` path reads; the
// register entry in docs/security.md records it. The input is Tandem's own
// `PATH`, which no document, tool argument or browser request can steer.

/**
 * The oldest Node the bridge entry may name: `package.json`'s `engines.node`.
 * `tests/server/integrations/system-node.test.ts` pins it to that field and to
 * doctor's `MIN_NODE_VERSION`, so the three cannot drift apart.
 */
export const SYSTEM_NODE_MIN_VERSION = "22.12.0";

/** How long one `--version` run may take before the candidate is skipped. */
export const SYSTEM_NODE_VERSION_TIMEOUT_MS = 2000;

/**
 * At most this many candidates are version-probed in one walk. A normal PATH
 * has one Node, so this only bounds a pathological one (each probe can take
 * the full timeout).
 */
export const SYSTEM_NODE_MAX_PROBES = 4;

/** Bounds a link chain, as the kernel's own resolver does. */
const MAX_LINK_HOPS = 40;

/**
 * Version-manager shims and per-shell directories. A Node found through one of
 * these answers differently per shell or per working directory, so recording
 * it would let a later `nvm use` or a shell exit swap or remove the Node under
 * every terminal's entry. Matched on both the PATH entry and the resolved real
 * path, separator-agnostic so Windows-shaped fixtures are tested on Linux.
 */
const NON_DURABLE_NODE_DIR_PATTERNS: readonly RegExp[] = [
  /[/\\]\.volta[/\\]bin(?:[/\\]|$)/i, // Volta (POSIX)
  /[/\\]volta[/\\]bin(?:[/\\]|$)/i, // Volta (Windows, %LOCALAPPDATA%\Volta\bin)
  /[/\\]\.asdf[/\\]shims(?:[/\\]|$)/i, // asdf
  /[/\\](?:mise|rtx)[/\\]shims(?:[/\\]|$)/i, // mise (formerly rtx)
  /[/\\]\.nodenv[/\\]shims(?:[/\\]|$)/i, // nodenv
  /fnm_multishells/i, // fnm's per-shell links
  /[/\\](?:_npx|dlx|\.bun)[/\\]/i, // one-shot package-runner caches
  // A project's own dependencies: `npm run`, `npm exec` and direnv put
  // `<project>/node_modules/.bin` on PATH, and the `node` npm package ships a
  // real Node there. Recording it would make every terminal in every project
  // run one project's dependency.
  /[/\\]node_modules[/\\]/i,
];

/** Does this path sit in a version-manager shim or per-shell directory? */
export function isNonDurableNodeDir(p: string): boolean {
  return NON_DURABLE_NODE_DIR_PATTERNS.some((re) => re.test(p));
}

/**
 * Is this path inside a Linux AppImage's per-run mount?
 *
 * The AppImage runtime mounts its squashfs at a fresh `/tmp/.mount_<name><rand>`
 * on every launch and exports it as `APPDIR`; Tauri's resource dir, and with it
 * the bundled bridge and Node, live under it (`tauri-utils` 2.10.2,
 * `platform.rs` `resource_dir_from`). A path recorded there dies when Tandem
 * quits. Two tests, because `APPDIR` is inherited by every descendant and may
 * be unset in a hand-run: the variable when it is an absolute path, and the
 * runtime's own `.mount_` directory name as a backstop.
 */
export function isAppImageMountPath(p: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (/[/\\]\.mount_[^/\\]+[/\\]/.test(p)) return true;
  const appDir = env.APPDIR;
  if (!appDir || !posixPath.isAbsolute(appDir)) return false;
  const root = appDir.endsWith("/") ? appDir : `${appDir}/`;
  return p === appDir || p.startsWith(root);
}

/** The minimal `lstat` result the walk needs — injectable for tests. */
export interface LinkStat {
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

/** The minimal `stat` result the POSIX ownership check needs — injectable for tests. */
export interface OwnerStat {
  uid: number;
  mode: number;
}

export interface SystemNodeDeps {
  /** Tandem's own `PATH`. Defaults to `process.env.PATH`. */
  pathVar?: string;
  /** Path flavour and delimiter. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** `lstat` that never follows. Throws when the path cannot be inspected. */
  lstat?: (p: string) => LinkStat;
  /** `readlink`. Throws when the path is not a link or cannot be read. */
  readlink?: (p: string) => string;
  /** Run `<p> --version` (bounded) and return its stdout, or null on any failure. */
  runVersion?: (p: string) => string | null;
  /** Async twin of `runVersion`, used by the boot sweep. */
  runVersionAsync?: (p: string) => Promise<string | null>;
  /** Scratch roots a durable Node must not live under. Defaults to `os.tmpdir()`
   *  (and its real path) plus, on POSIX, `/tmp`, `/private/tmp`, `/var/tmp` and
   *  `/dev/shm`. Tests replace the whole list. */
  scratchRoots?: readonly string[];
  /** For `isAppImageMountPath`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** POSIX `lstat` for the ownership check. Defaults to `lstatSync`. */
  ownerStat?: (p: string) => OwnerStat;
  /** The current uid. Defaults to `process.getuid()`. */
  uid?: number;
}

/** Directories no recorded Node or bridge script may live under: per-boot or
 *  shared scratch space, and removable volumes. */
const SCRATCH_ROOTS_POSIX = [
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/dev/shm",
  // Removable and mounted volumes: a path there names whatever is mounted
  // under that name next, so a recorded executable becomes "anything the user
  // mounts later" (a disk image run without being copied to Applications).
  "/Volumes",
  "/media",
  "/run/media",
];

/**
 * Is `p` under `root`? Case-insensitive where the filesystem usually is
 * (Windows and macOS), so `C:\\Temp` and `c:\\temp` are the same place.
 */
function isUnderRoot(p: string, root: string, platform: NodeJS.Platform): boolean {
  if (!root) return false;
  const P = pathFlavour(platform);
  const fold = platform === "win32" || platform === "darwin";
  const a = fold ? p.toLowerCase() : p;
  const r = fold ? root.toLowerCase() : root;
  const normRoot = r.endsWith(P.sep) ? r : `${r}${P.sep}`;
  return a === r || a.startsWith(normRoot);
}

/**
 * POSIX only: may another user have put this file here, or replace it later?
 * The file and every ancestor directory must be owned by root or the current
 * user, and none may be world-writable — except a sticky directory
 * (`/tmp`'s shape is refused separately). Windows is not checked: its ACLs
 * are not visible through `stat`, and its Node installers write under
 * `Program Files` or the user's own profile.
 */
function ownedSafely(real: string, deps: SystemNodeDeps): boolean {
  const ownerStat =
    deps.ownerStat ??
    ((q: string) => {
      const st = lstatSync(q);
      return { uid: st.uid, mode: st.mode };
    });
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  let current = real;
  for (;;) {
    let st: OwnerStat;
    try {
      st = ownerStat(current);
    } catch {
      return false;
    }
    if (st.uid !== 0 && st.uid !== uid) return false;
    const sticky = (st.mode & 0o1000) !== 0;
    // World-writable only: a group-writable `/usr/local` is Homebrew's normal
    // shape on Intel macOS (group `admin`), and refusing it would refuse the
    // commonest system Node there.
    if ((st.mode & 0o002) !== 0 && !(current !== real && sticky)) return false;
    const parent = posixPath.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function pathFlavour(platform: NodeJS.Platform): typeof posixPath {
  return platform === "win32" ? win32Path : posixPath;
}

/**
 * Is this PATH entry one the walk may look in at all? Pure string tests, run
 * BEFORE any filesystem call: a UNC entry is refused first (a `stat` of
 * `\\host\share\node.exe` performs the SMB handshake that leaks an NTLM hash,
 * #1417), then anything not absolute (the current directory and relative
 * entries resolve against a cwd that is not the client's), then any `..`
 * segment, then version-manager shims.
 */
export function isWalkablePathEntry(entry: string, platform: NodeJS.Platform): boolean {
  if (entry.length === 0) return false;
  if (rejectUnsafeWindowsPrefix(entry) !== null) return false;
  if (platform === "win32") {
    // Drive-absolute only. `win32.isAbsolute("\\bin")` is true, but a
    // root-relative entry names a different drive depending on the cwd.
    if (!/^[A-Za-z]:[\\/]/.test(entry)) return false;
  } else if (!entry.startsWith("/")) {
    return false;
  }
  if (entry.split(/[/\\]/).includes("..")) return false;
  return !isNonDurableNodeDir(entry);
}

/** The Windows extended-length DRIVE prefix only — see `WIN_EXTENDED_DRIVE_RE`. */
function stripExtendedDrivePrefix(p: string): string {
  return p.replace(WIN_EXTENDED_DRIVE_RE, "$1");
}

/**
 * Resolve `p` to its real path WITHOUT following any link before its target
 * has been screened.
 *
 * `realpath` and `stat` follow every link in every component, so a junction
 * planted at ANY level of a PATH entry (not only the leaf) would take them to a
 * share before a guard could object. This walks component by component with
 * `lstat`, reads each link with `readlink`, screens the target with
 * `rejectUnsafeWindowsPrefix` before using it, and restarts the walk from the
 * target. Returns null on any refusal, any unreadable component, or more than
 * {@link MAX_LINK_HOPS} links.
 *
 * Exported for tests; production callers use {@link findSystemNode}.
 */
export function screenedRealPath(p: string, deps: SystemNodeDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const P = pathFlavour(platform);
  const lstat = deps.lstat ?? ((q: string) => lstatSync(q));
  const readlink = deps.readlink ?? ((q: string) => readlinkSync(q));
  const split = (q: string): { root: string; rest: string[] } => {
    const root = P.parse(q).root;
    return {
      root,
      rest: q
        .slice(root.length)
        .split(/[/\\]/)
        .filter((s) => s.length > 0),
    };
  };

  if (rejectUnsafeWindowsPrefix(p) !== null || !P.isAbsolute(p)) return null;
  let { root: current, rest: pending } = split(p);
  if (current.length === 0) return null;
  let hops = 0;
  while (pending.length > 0) {
    const segment = pending.shift() as string;
    if (segment === ".") continue;
    if (segment === "..") {
      current = P.dirname(current);
      continue;
    }
    const next = P.join(current, segment);
    let st: LinkStat;
    try {
      st = lstat(next);
    } catch {
      return null;
    }
    if (!st.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return null;
    let target: string;
    try {
      target = stripExtendedDrivePrefix(readlink(next));
    } catch {
      return null;
    }
    if (rejectUnsafeWindowsPrefix(target) !== null) return null;
    let absolute: string;
    if (platform === "win32" && /^[\\/](?![\\/])/.test(target)) {
      // Root-relative: on the drive of the link itself.
      absolute = P.join(P.parse(current).root, target);
    } else {
      absolute = P.isAbsolute(target) ? target : P.join(current, target);
    }
    if (rejectUnsafeWindowsPrefix(absolute) !== null) return null;
    const restarted = split(absolute);
    if (restarted.root.length === 0) return null;
    current = restarted.root;
    pending = [...restarted.rest, ...pending];
  }
  return current;
}

/** Parse `v22.12.0` (with any suffix) into a comparable triplet, or null. */
export function parseNodeVersionTriplet(out: string): [number, number, number] | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(out.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Is `out` (a `node --version` stdout) at least {@link SYSTEM_NODE_MIN_VERSION}? */
const SYSTEM_NODE_FLOOR = parseNodeVersionTriplet(`v${SYSTEM_NODE_MIN_VERSION}`) as [
  number,
  number,
  number,
];

export function meetsSystemNodeFloor(out: string): boolean {
  const have = parseNodeVersionTriplet(out);
  const floor = SYSTEM_NODE_FLOOR;
  if (have === null) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== floor[i]) return have[i] > floor[i];
  }
  return true;
}

/**
 * The environment a `--version` probe runs with: `PATH` (and `SystemRoot`,
 * without which Windows processes misbehave) and nothing else. No
 * `NODE_OPTIONS` (a `--require` there would load code into the probe), no
 * `NODE_V8_COVERAGE` / `NODE_COMPILE_CACHE` (writes), and none of the server's
 * own secrets such as `TANDEM_AUTH_TOKEN`.
 */
function probeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const path = process.env.PATH ?? process.env.Path;
  if (path !== undefined) env.PATH = path;
  if (process.platform === "win32" && process.env.SystemRoot) {
    env.SystemRoot = process.env.SystemRoot;
  }
  return env;
}

function runVersionSync(p: string): string | null {
  try {
    return execFileSync(p, ["--version"], {
      encoding: "utf8",
      timeout: SYSTEM_NODE_VERSION_TIMEOUT_MS,
      killSignal: "SIGKILL",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: probeEnv(),
    });
  } catch {
    return null;
  }
}

function runVersionAsyncDefault(p: string): Promise<string | null> {
  return new Promise((resolveOut) => {
    let settled = false;
    const done = (out: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolveOut(out);
    };
    // `execFile`'s own timeout only signals the child, and its callback waits
    // for 'close' — a candidate that ignores the signal, or a wrapper whose
    // grandchild holds stdout open, would never call back, and the boot sweep
    // awaits this before the launcher starts. So: SIGKILL, plus an outer
    // timer that gives up regardless.
    const guard = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      done(null);
    }, SYSTEM_NODE_VERSION_TIMEOUT_MS + 500);
    const child = execFile(
      p,
      ["--version"],
      {
        encoding: "utf8",
        timeout: SYSTEM_NODE_VERSION_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
        env: probeEnv(),
      },
      (err, stdout) => done(err ? null : stdout),
    );
  });
}

/**
 * Every candidate the walk would version-probe, in PATH order: screened,
 * absolute, real, a regular file with an accepted Node basename, outside any
 * shim, per-shell, temp, translocated or AppImage-mount directory.
 */
export function systemNodeCandidates(deps: SystemNodeDeps = {}): string[] {
  return [...iterateSystemNodeCandidates(deps)];
}

/**
 * {@link systemNodeCandidates}, lazily: the walk stops screening PATH entries
 * once the caller has found its Node, rather than `lstat`ing every component of
 * every remaining entry first.
 */
function* iterateSystemNodeCandidates(deps: SystemNodeDeps = {}): Generator<string> {
  const platform = deps.platform ?? process.platform;
  const P = pathFlavour(platform);
  const lstat = deps.lstat ?? ((q: string) => lstatSync(q));
  const env = deps.env ?? process.env;
  const pathVar = deps.pathVar ?? env.PATH ?? env.Path ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const name = platform === "win32" ? "node.exe" : "node";

  const seen = new Set<string>();
  for (const rawEntry of pathVar.split(delimiter)) {
    // Windows PATH entries are often quoted; nothing else unquotes them here.
    const entry = platform === "win32" ? rawEntry.replace(/^"(.*)"$/, "$1") : rawEntry;
    if (!isWalkablePathEntry(entry, platform)) continue;
    const candidate = P.join(entry, name);
    if (!isValidNodeBinary(candidate)) continue;
    const real = screenedRealPath(candidate, { ...deps, platform });
    if (real === null || seen.has(real)) continue;
    seen.add(real);
    if (!isDurableNodeRealPath(real, { ...deps, platform, env, lstat })) continue;
    yield real;
  }
}

/**
 * May this RESOLVED path (from {@link screenedRealPath}) be recorded as a
 * terminal's Node? An accepted Node basename (so a `node` link to another
 * program is refused), a regular file, outside any shim, per-shell,
 * `node_modules`, scratch, translocated or AppImage-mount directory, and on
 * POSIX owned safely. Shared by the PATH walk and the running-Node fallback,
 * so the two cannot accept different things.
 */
export function isDurableNodeRealPath(real: string, deps: SystemNodeDeps = {}): boolean {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const lstat = deps.lstat ?? ((q: string) => lstatSync(q));
  if (!isValidNodeBinary(real)) return false;
  if (isNonDurableNodeDir(real)) return false;
  if (isAppTranslocatedPath(real) || isAppImageMountPath(real, env)) return false;
  if (isScratchPath(real, { platform, scratchRoots: deps.scratchRoots })) return false;
  try {
    if (!lstat(real).isFile()) return false;
  } catch {
    return false;
  }
  return platform === "win32" || ownedSafely(real, deps);
}

/**
 * Is `p` under a scratch root (the temp dir, `/tmp`, `/var/tmp`, `/dev/shm`)?
 * A Node there is one-shot and may be gone at the next boot. (Not the working
 * directory: Tandem is routinely started from the home directory, which holds
 * nvm's Nodes. A project's own Node is refused by its `node_modules` segment.)
 */
export function isScratchPath(
  p: string,
  deps: Pick<SystemNodeDeps, "platform" | "scratchRoots"> = {},
): boolean {
  const platform = deps.platform ?? process.platform;
  const roots =
    deps.scratchRoots ??
    (platform === "win32" ? defaultTmpRoots() : [...defaultTmpRoots(), ...SCRATCH_ROOTS_POSIX]);
  return roots.some((root) => isUnderRoot(p, root, platform));
}

/** `os.tmpdir()` and its real path (macOS's is `/var/folders/…` → `/private/var/folders/…`). */
let tmpRootsMemo: string[] | undefined;

/** Fixed for the process; memoized because every candidate consults it. */
function defaultTmpRoots(): string[] {
  tmpRootsMemo ??= computeTmpRoots();
  return tmpRootsMemo;
}

function computeTmpRoots(): string[] {
  const roots = [tmpdir()];
  // `.native`: on Windows `os.tmpdir()` is often an 8.3 short path
  // (`C:\\Users\\BRYANK~1\\…`), which the JS `realpathSync` does not expand,
  // so a long-form candidate would never compare under it.
  try {
    roots.push(realpathSync.native(roots[0] as string));
  } catch {
    // keep what we have
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    roots.push(win32Path.join(process.env.LOCALAPPDATA, "Temp"));
  }
  return roots;
}

/** The memo, keyed by the inputs that decide it, so a changed PATH is never served stale. */
let systemNodeMemo: { key: string; value: string | null } | undefined;

function memoKey(): string {
  return `${process.platform}\u0000${process.env.PATH ?? process.env.Path ?? ""}`;
}

function readMemo(): string | null | undefined {
  return systemNodeMemo !== undefined && systemNodeMemo.key === memoKey()
    ? systemNodeMemo.value
    : undefined;
}

/** Test seam: forget the memoized system Node. */
export function _resetSystemNodeCacheForTests(): void {
  systemNodeMemo = undefined;
  inFlight = undefined;
}

/**
 * The first Node on Tandem's `PATH` that is durable and at least
 * {@link SYSTEM_NODE_MIN_VERSION}, by its real path; null if none qualifies.
 *
 * Memoized per process when called without `deps`: the boot sweep fills it
 * asynchronously ({@link findSystemNodeAsync}) before the wizard can apply, and
 * a one-shot CLI computes it once. A Node installed while Tandem runs is
 * picked up at the next start.
 */
export function findSystemNode(deps?: SystemNodeDeps): string | null {
  if (deps === undefined) {
    const cached = readMemo();
    if (cached !== undefined) return cached;
  }
  const run = deps?.runVersion ?? runVersionSync;
  let found: string | null = null;
  let probes = 0;
  for (const candidate of iterateSystemNodeCandidates(deps)) {
    if (probes++ >= SYSTEM_NODE_MAX_PROBES) break;
    const out = run(candidate);
    if (out !== null && meetsSystemNodeFloor(out)) {
      found = candidate;
      break;
    }
  }
  if (deps === undefined) systemNodeMemo = { key: memoKey(), value: found };
  return found;
}

let inFlight: { key: string; promise: Promise<string | null> } | undefined;

/**
 * {@link findSystemNode} without blocking the event loop on the probes.
 * Concurrent default-argument callers share one walk.
 */
export function findSystemNodeAsync(deps?: SystemNodeDeps): Promise<string | null> {
  if (deps !== undefined) return findSystemNodeAsyncUncached(deps);
  const cached = readMemo();
  if (cached !== undefined) return Promise.resolve(cached);
  const key = memoKey();
  if (inFlight?.key === key) return inFlight.promise;
  const promise = findSystemNodeAsyncUncached(undefined).finally(() => {
    if (inFlight?.promise === promise) inFlight = undefined;
  });
  inFlight = { key, promise };
  return promise;
}

async function findSystemNodeAsyncUncached(deps?: SystemNodeDeps): Promise<string | null> {
  // Yield first. With no candidate on PATH the loop below never awaits, so
  // without this the memo would be written before the caller had registered
  // the in-flight promise — and a concurrent caller would start a second walk.
  await Promise.resolve();
  const run = deps?.runVersionAsync ?? runVersionAsyncDefault;
  let found: string | null = null;
  let probes = 0;
  for (const candidate of iterateSystemNodeCandidates(deps)) {
    if (probes++ >= SYSTEM_NODE_MAX_PROBES) break;
    const out = await run(candidate);
    if (out !== null && meetsSystemNodeFloor(out)) {
      found = candidate;
      break;
    }
  }
  if (deps === undefined) systemNodeMemo = { key: memoKey(), value: found };
  return found;
}
