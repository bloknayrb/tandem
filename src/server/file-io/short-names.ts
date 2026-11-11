/**
 * Windows 8.3 short-name expansion (#2400).
 *
 * Node's JS `fs.realpathSync` keeps an 8.3 alias (`C:\AFOLDE~1\x.md`) where the
 * native flavour expands it, so one file opened under both spellings used to
 * become two documents. The native flavour cannot simply replace the JS one: for
 * a mapped drive it returns a UNC string (which the post-canonical screen
 * refuses) and for a `subst` drive it returns the physical path (which would
 * re-key every such document). So this module changes ONE thing: a component
 * that is an 8.3 alias is replaced by the long name of the same directory
 * entry. Every other byte of the input is copied through — root, separators,
 * case, every other component — so a drive prefix can never change.
 *
 * **Screen first.** The first statement refuses a UNC or device-namespace
 * string before any filesystem call, independently of the caller's own
 * ordering (`documents/open.ts`'s "ORDER IS THE POINT").
 *
 * **The native result is never used as a path.** Only its last component is
 * read, as a candidate name, and that candidate is accepted only when `lstat`
 * says `parent\candidate` and `parent\alias` are the same directory entry.
 *
 * **All-or-nothing.** Any failure returns the input unchanged with `failed`
 * set, so a caller either gets the fully expanded string or exactly the string
 * it had before. The one exception is `allowMissingTail` (save-as): a prefix
 * that does not exist yet stops the walk and the rest is kept as typed.
 *
 * `win32` only. On every other platform this returns its input and makes no
 * call.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";

interface ShortNameDeps {
  platform: NodeJS.Platform;
  /** The NATIVE realpath (`fs.promises.realpath`), which expands 8.3 names. */
  realpathNative: (p: string) => Promise<string>;
  lstat: (p: string) => Promise<{ dev: bigint; ino: bigint }>;
}

let depsOverride: ShortNameDeps | null = null;

/**
 * Test seam: lets the ordering and expansion tests run the `win32` branch on
 * any host, with the filesystem calls observable. `null` restores production.
 */
export function _setShortNameDepsForTests(deps: ShortNameDeps | null): void {
  depsOverride = deps;
}

function currentDeps(): ShortNameDeps {
  return (
    depsOverride ?? {
      platform: process.platform,
      // Looked up at call time, so a spy on `fs.promises` sees every call.
      realpathNative: (p) => fsp.realpath(p),
      lstat: (p) => fsp.lstat(p, { bigint: true }),
    }
  );
}

/**
 * Could this path component be an 8.3 alias? Pure. The shape NTFS generates:
 * a base of at most eight characters ending in `~<digits>`, an optional
 * extension of one to three characters, no space, one dot at most. A real long
 * name can have this shape too (`notes~1.md`); the filesystem decides that, not
 * this test.
 */
export function looksLikeShortName(component: string): boolean {
  return /^(?=[^.]{1,8}(?:\.|$))[^\s.\\/]*~[0-9]+(?:\.[^\s.\\/]{1,3})?$/.test(component);
}

export interface ShortNameExpansion {
  /** The expanded path, or the input unchanged. */
  path: string;
  /** Set when expansion was attempted and abandoned; `path` is then the input. */
  failed?: unknown;
}

/**
 * Replace every 8.3 alias component of `p` with its long name.
 *
 * `p` must already be absolute and canonical in the caller's sense (the JS
 * realpath result on the open path); it is not resolved here.
 */
export async function expandShortNames(
  p: string,
  opts: { allowMissingTail?: boolean } = {},
): Promise<ShortNameExpansion> {
  if (rejectUnsafeWindowsPrefix(p) !== null) return { path: p };
  const deps = currentDeps();
  if (deps.platform !== "win32") return { path: p };

  // `path.win32` always, never the host's `path`: this code only runs for
  // win32, and an injected-platform test on another host must walk the same way.
  const root = path.win32.parse(p).root;
  const parts = p.slice(root.length).split(/([\\/]+)/);
  if (!parts.some((part, i) => i % 2 === 0 && looksLikeShortName(part))) return { path: p };

  let out = root;
  try {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // Odd indices are the separator runs the split kept.
      if (i % 2 === 1 || !looksLikeShortName(part)) {
        out += part;
        continue;
      }
      const parent = out;
      const prefix = parent + part;
      let native: string;
      try {
        native = await deps.realpathNative(prefix);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (opts.allowMissingTail && (code === "ENOENT" || code === "ENOTDIR")) {
          // Not there yet: nothing below it exists either. Keep the rest as typed.
          return { path: out + parts.slice(i).join("") };
        }
        throw err;
      }
      const candidate = path.win32.basename(native);
      if (candidate.toLowerCase() === part.toLowerCase()) {
        // The component is the entry's real name. Keep the caller's bytes.
        out = prefix;
        continue;
      }
      if (candidate === "" || candidate === "." || candidate === ".." || /[\\/]/.test(candidate)) {
        throw new Error(`short-name expansion: unusable long name for ${part}`);
      }
      const [alias, long] = await Promise.all([deps.lstat(prefix), deps.lstat(parent + candidate)]);
      // A zero inode is a filesystem that reports none: equality proves nothing.
      if (alias.ino === 0n || alias.ino !== long.ino || alias.dev !== long.dev) {
        throw new Error(`short-name expansion: ${candidate} is not the same entry as ${part}`);
      }
      out = parent + candidate;
    }
  } catch (err) {
    return { path: p, failed: err };
  }
  return { path: out };
}
