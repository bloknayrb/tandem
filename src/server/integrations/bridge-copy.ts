/**
 * The Linux AppImage's durable copy of the stdio bridge (#2358 PR 2b).
 *
 * Claude Code's `tandem` entry names an absolute bridge script that must
 * outlive this process. On a Linux AppImage the bundled script sits inside the
 * runtime's per-run squashfs mount (`/tmp/.mount_<name><rand>`, exported as
 * `APPDIR`), which is gone when Tandem quits: recording it would give every
 * terminal a dead entry and make every launch rewrite the config. Tauri puts
 * the resource dir there (`tauri-utils` 2.10.2, `platform.rs`
 * `resource_dir_from`: `exe_dir/../lib/<name>`, the exe being
 * `$APPDIR/usr/bin/<exe>`), so this was confirmed from the locked source and
 * is measured by the pre-flip smoke row P9.
 *
 * So the server copies the self-contained bundle into the app-data root as
 * `bin/<version>/dist/stdio-bridge/index.js` — a path `isOwnStdioBridgeScript`
 * recognises as Tandem's — once per version, checks the copy's hash against
 * the bundled file on every boot and recopies if it differs, and removes older
 * version directories once no Claude config names them. Design:
 * `docs/spikes/multi-session-ownership/README.md` §3.6, "Rule: which script".
 *
 * **Never a Claude config writer.** This writes only under Tandem's own
 * app-data root, so `tests/docs/config-writer-set-claims.test.ts` classifies
 * it out of #1599's scope. Every operation here is best-effort: a failure
 * returns null and the caller keeps the direct-HTTP entry.
 */

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { isOlderSemver } from "../../shared/semver-order.js";

/** `bin/<version>`: a semver-shaped single path component, never a separator or `..`. */
const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?$/;

/** The copy's path relative to its version directory. */
export const BRIDGE_COPY_REL = join("dist", "stdio-bridge", "index.js");

/** Where the copy for `version` lives under `appDataDir`. */
export function bridgeCopyPath(appDataDir: string, version: string): string {
  return join(appDataDir, "bin", version, BRIDGE_COPY_REL);
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** POSIX: is this directory entry owned by the current user? (Modes are tightened separately.) */
function ownedByUs(st: { uid: number; mode: number }): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  return st.uid === process.getuid();
}

/**
 * Walk from `appDataDir` down through `parts`, refusing a link or a
 * non-directory at ANY level (the root included), and on POSIX a directory
 * another user owns. Missing levels are created at `0o700`; existing ones are
 * tightened to `0o700` (mkdir's mode applies only at creation). A link planted
 * at any level would redirect an executable script — which every Claude Code
 * terminal then runs — somewhere else.
 */
async function ensureOwnDirs(appDataDir: string, parts: readonly string[]): Promise<string | null> {
  let current = appDataDir;
  const levels = [appDataDir, ...parts];
  for (let i = 0; i < levels.length; i++) {
    if (i > 0) current = join(current, levels[i] as string);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory() || !ownedByUs(st)) return null;
      if (i > 0 && process.platform !== "win32" && (st.mode & 0o777) !== 0o700) {
        await chmod(current, 0o700);
      }
    } catch (err) {
      if (i === 0 || (err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch {
        return null;
      }
    }
  }
  return current;
}

/** Orphaned copy temps older than this are removed (a SIGKILL mid-copy leaves one). */
const COPY_TMP_MAX_AGE_MS = 60 * 60 * 1000;
const COPY_TMP_NAME = /^\.(?:index|package)-[0-9a-f-]{36}\.tmp$/;

async function reapStaleTemps(dir: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (!COPY_TMP_NAME.test(name)) continue;
      const p = join(dir, name);
      const st = await lstat(p);
      if (st.isFile() && Date.now() - st.mtimeMs > COPY_TMP_MAX_AGE_MS) await unlink(p);
    }
  } catch {
    // Best-effort.
  }
}

/** Write `content` to `dest` through a fresh `wx` temp and a rename. */
async function replaceFile(dir: string, stem: string, dest: string, content: Buffer | string) {
  const tmp = join(dir, `.${stem}-${randomUUID()}.tmp`);
  try {
    // `wx`: never through a pre-planted file or link at the temp name.
    await writeFile(tmp, content, { flag: "wx", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, dest);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * The `{"type":"module"}` marker beside the copy. The bundle is ESM in a
 * `.js` file, which takes its module type from the nearest `package.json`;
 * the copy has none of its own, and an ancestor `~/package.json` saying
 * `commonjs` would otherwise break it.
 */
const MODULE_MARKER = '{ "type": "module" }\n';

async function ensureModuleMarker(versionDir: string): Promise<boolean> {
  const marker = join(versionDir, "package.json");
  try {
    const st = await lstat(marker);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    if ((await readFile(marker, "utf-8")) === MODULE_MARKER) return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    await replaceFile(versionDir, "package", marker, MODULE_MARKER);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure the copy for `version` exists and matches `source` byte for byte.
 * Returns the copy's path, or null (logged) when it cannot be made.
 */
export async function prepareBridgeCopy(opts: {
  source: string;
  appDataDir: string;
  version: string;
}): Promise<string | null> {
  const { source, appDataDir, version } = opts;
  if (!VERSION_DIR_RE.test(version)) {
    console.error(`[Tandem] Not copying the stdio bridge: unexpected version "${version}".`);
    return null;
  }
  // Read ONCE: compared against the copy, and written from the same bytes.
  const wanted = await readOrNull(source);
  if (wanted === null) {
    console.error("[Tandem] Not copying the stdio bridge: the bundled script is unreadable.");
    return null;
  }
  const dir = await ensureOwnDirs(appDataDir, ["bin", version, "dist", "stdio-bridge"]);
  if (dir === null) {
    console.error(
      "[Tandem] Not copying the stdio bridge: its app-data directory is a link or unwritable.",
    );
    return null;
  }
  const dest = join(dir, "index.js");
  await reapStaleTemps(dir);
  const versionDir = join(appDataDir, "bin", version);
  await reapStaleTemps(versionDir);
  if (!(await ensureModuleMarker(versionDir))) {
    console.error("[Tandem] Not copying the stdio bridge: could not write its package.json.");
    return null;
  }
  try {
    const st = await lstat(dest);
    if (st.isSymbolicLink() || !st.isFile()) {
      console.error("[Tandem] Not copying the stdio bridge: its destination is not a plain file.");
      return null;
    }
    if ((await readOrNull(dest))?.equals(wanted)) return dest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }

  try {
    await replaceFile(dir, "index", dest, wanted);
  } catch (err) {
    console.error(
      `[Tandem] Could not copy the stdio bridge (${(err as NodeJS.ErrnoException).code ?? "error"}).`,
    );
    return null;
  }
  return dest;
}

/**
 * Remove `bin/<v>/` for every `v` older than both `keepVersion` and the newest
 * older version, whose bridge copy is not named by any config (`referenced`, the `args[0]` values the sweep left on
 * disk). Never follows a link; anchored on the version-name shape. Best-effort.
 */
export async function pruneBridgeCopies(opts: {
  appDataDir: string;
  keepVersion: string;
  referenced: ReadonlySet<string>;
}): Promise<string[]> {
  const binDir = join(opts.appDataDir, "bin");
  const removed: string[] = [];
  let names: string[];
  try {
    const st = await lstat(binDir);
    if (st.isSymbolicLink() || !st.isDirectory()) return removed;
    names = await readdir(binDir);
  } catch {
    return removed;
  }
  const referenced = new Set([...opts.referenced].map(normalizeSeparators));
  // Never a NEWER version's copy: a newer AppImage used side by side owns it.
  const older = names.filter(
    (name) => VERSION_DIR_RE.test(name) && isOlderVersion(name, opts.keepVersion),
  );
  // And never the newest OLDER one: the boot that repoints the entry away from
  // it is when a terminal opened earlier may still write the old entry back
  // (or respawn its bridge from memory). It goes on a later upgrade.
  const previous = older.reduce<string | null>(
    (best, name) => (best === null || isOlderVersion(best, name) ? name : best),
    null,
  );
  for (const name of older) {
    if (name === previous) continue;
    const versionDir = join(binDir, name);
    if (referenced.has(normalizeSeparators(join(versionDir, BRIDGE_COPY_REL)))) continue;
    try {
      const st = await lstat(versionDir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      await rm(versionDir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Next boot gets it.
    }
  }
  return removed;
}

function normalizeSeparators(p: string): string {
  return sep === "\\" ? p.replace(/\//g, "\\") : p;
}

/** Is version directory `a` strictly older than `b`? (SemVer, shared with the doctor.) */
export function isOlderVersion(a: string, b: string): boolean {
  return isOlderSemver(a, b);
}

/**
 * The `<version>` of an app-data bridge copy path (`<appData>/bin/<version>/
 * dist/stdio-bridge/index.js`), or null when `p` is not one. Separator-agnostic.
 * The one parser of the layout {@link bridgeCopyPath} builds.
 */
export function bridgeCopyVersionOf(p: string, appDataDir: string): string | null {
  const norm = (q: string) => q.replace(/\\/g, "/");
  const root = `${norm(appDataDir).replace(/\/+$/, "")}/bin/`;
  const path = norm(p);
  if (!path.startsWith(root)) return null;
  const m = /^([^/]+)\/dist\/stdio-bridge\/index\.js$/.exec(path.slice(root.length));
  return m !== null && VERSION_DIR_RE.test(m[1] as string) ? (m[1] as string) : null;
}
