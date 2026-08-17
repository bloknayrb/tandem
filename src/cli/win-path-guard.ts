/**
 * Windows workspace path guard — mirrors the Rust §3 invariant for TypeScript
 * callers. The twin is `check_path_safe` / `is_unc_path` in
 * `src-tauri/src/cowork_workspace_scan.rs`; the two are kept in step by hand, so
 * each names the other deliberately.
 *
 * Five steps (in order):
 *   a0. Reject UNC on the RAW candidate string, before any syscall.
 *   a.  lstat each ancestor shallowest-first; reject any chain containing a symlink.
 *   b.  fs.realpath() to canonicalize (safe: symlinks already rejected in (a)).
 *   c.  Reject UNC on the canonical path too (\\server\share or \\?\UNC\...;
 *       allow \\?\C:\... — see {@link isUncPath}).
 *   d.  Component-wise containment check under realpath'd %LOCALAPPDATA%
 *       (case-insensitive on Windows).
 *
 * **(a0) is the #1417 fix.** The UNC check used to exist only at (c), testing
 * `real` — the *output* of `realpath` — so `lstat` and `realpath` both touched
 * the raw candidate before any UNC verdict existed. Why that is dangerous is
 * stated once for the codebase in `src/shared/windows-path-safety.ts`; the part
 * specific to this file is that the original comment ordered the *junction*
 * threat correctly (the lstat walk must precede `realpath`, or a planted
 * junction is followed before it can be rejected) and the *UNC* threat
 * backwards, because for UNC the danger is the syscall rather than what it
 * resolves to. Both orderings are satisfiable: a string test costs nothing and
 * goes first, and (c) stays because a junction can still resolve *to* a UNC path.
 *
 * Extracted into its own module so it can be unit-tested via vi.mock("node:fs", ...).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

type Logger = { warn: (msg: string) => void };

/**
 * Validate that `candidate` is a safe workspace path contained within `realLocalAppData`.
 *
 * @returns the realpath'd canonical path string on success, or null if rejected.
 * Callers are responsible for supplying a realpath'd `realLocalAppData`.
 */
export async function assertSafeWorkspacePath(
  candidate: string,
  realLocalAppData: string,
  logger?: Logger,
): Promise<string | null> {
  const warn = (msg: string) => logger?.warn(`[path-guard] ${msg}`);

  // (a0) Reject UNC on the RAW string, before any syscall touches it (#1417).
  // Deliberately reuses this file's own `isUncPath` and NOT the shared
  // `rejectUnsafeWindowsPrefix`: that one also rejects `\\?\C:\…`, which this
  // guard allows on purpose — Tauri's path APIs hand back extended-length local
  // paths, and containment under %LOCALAPPDATA% is what confines them. Sharing
  // the stricter predicate here would reject legitimate local paths, which is
  // the mirror-image of the drift #1417 is about.
  if (isUncPath(candidate)) {
    warn(`UNC path rejected before any filesystem call: ${candidate}`);
    return null;
  }

  // (a) lstat-walk: reject any component that is a symlink.
  if (await hasSymlinkInChain(candidate, warn)) {
    warn(`symlink/reparse point in chain: ${candidate}`);
    return null;
  }

  // (b) Canonicalize via realpath (safe now — symlinks already rejected).
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (err) {
    warn(`realpath failed for ${candidate}: ${(err as Error).message}`);
    return null;
  }

  // (c) Reject UNC paths.
  if (isUncPath(real)) {
    warn(`UNC path rejected: ${real}`);
    return null;
  }

  // (d) Component-wise containment under realLocalAppData (case-insensitive).
  if (!isComponentWiseChild(real, realLocalAppData)) {
    warn(`path outside %LOCALAPPDATA%: ${real}`);
    return null;
  }

  return real;
}

/**
 * Returns true if any ancestor (inclusive) of `p` is a symbolic link.
 *
 * **Walks shallowest-first — root down to the candidate (#1417).** Ascending
 * inspected the deepest component first, so a symlinked *parent* was only
 * noticed after its children had already been `lstat`ed; descending rejects it
 * before that.
 *
 * **This ordering does nothing for UNC, and step (a0) is the only thing that
 * does.** On win32 the `dirname` chain bottoms out at `\\server\share`, so the
 * shallowest entry reached for a UNC candidate is the share root — and
 * `lstat` on that performs the SMB handshake the guard exists to prevent.
 * (On posix the chain runs to `/` instead, but only Windows performs the
 * handshake, so the conclusion is unchanged; this module is not `cfg`-gated the
 * way its Rust twin is, hence the qualifier.) (a0) is load-bearing, not defence
 * in depth; do not delete it on the strength of this walk.
 */
async function hasSymlinkInChain(p: string, warn: (m: string) => void): Promise<boolean> {
  // Collect ancestors by walking up, then check them in reverse (root first).
  const chain: string[] = [];
  let current = path.resolve(p);
  while (true) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }
  chain.reverse();

  for (const entry of chain) {
    try {
      const stat = await fs.lstat(entry);
      if (stat.isSymbolicLink()) {
        return true;
      }
    } catch (err) {
      // lstat failed — fail closed for safety.
      warn(`lstat failed for ${entry}: ${(err as Error).message}`);
      return true;
    }
  }

  return false;
}

/**
 * Returns true if the path is UNC or otherwise unsafe to hand to a syscall.
 *
 * **Allowlist, not blacklist.** Every `\\`-rooted path is unsafe except one
 * shape: the extended-length LOCAL drive path `\\?\C:\…` that Tauri's path
 * APIs hand back on Windows, which this guard permits on purpose and then
 * confines by realpath'd containment under %LOCALAPPDATA%.
 *
 * The previous version enumerated the bad forms, and its defect was that it
 * treated the whole `\\?\` namespace as allowed once a literal-cased `UNC\`
 * did not follow. Two things walked through: `\\?\unc\server\share` (Windows
 * prefixes are case-insensitive; the comparison was not) and
 * `\\?\GLOBALROOT\Device\Mup\server\share`, which reaches SMB by another
 * route. Both are covered here for free, because the allowlist has to *match*
 * `\\?\<drive>:\` rather than fail to match a bypass — a distinction with no
 * tail of undiscovered forms.
 */
function isUncPath(p: string): boolean {
  // Separators normalised before the test, never enumerated — see
  // `rejectUnsafeWindowsPrefix`. `/\host\share` is UNC to Windows just as much
  // as `\\host\share`, and testing the homogeneous pairs alone let both mixed
  // spellings through. 7 characters is the longest prefix that matters
  // (`\\?\C:\`).
  const head = p.slice(0, 7).replace(/\//g, "\\");
  if (!head.startsWith("\\\\")) return false;
  return !/^\\\\\?\\[a-z]:\\/i.test(head);
}

/**
 * Returns true if `child` is strictly within `root` on a component-wise basis
 * (case-insensitive on Windows).
 */
function isComponentWiseChild(child: string, root: string): boolean {
  // Normalize separators and split on path.sep.
  const normalize = (p: string) => p.replace(/[\\/]+/g, path.sep).replace(/[/\\]$/, "");

  const rootNorm = normalize(root);
  const childNorm = normalize(child);

  const rootParts = rootNorm.split(path.sep);
  const childParts = childNorm.split(path.sep);

  if (childParts.length <= rootParts.length) return false;

  for (let i = 0; i < rootParts.length; i++) {
    // Case-insensitive on Windows.
    if (rootParts[i].toLowerCase() !== childParts[i].toLowerCase()) return false;
  }
  return true;
}
