/**
 * Windows workspace path guard — mirrors the Rust §3 invariant for TypeScript callers.
 *
 * Four steps (in order):
 *   a. lstat each ancestor; reject any path whose chain contains a symlink.
 *   b. fs.realpath() to canonicalize (safe: symlinks already rejected in (a)).
 *   c. Reject UNC paths (\\server\share or \\?\UNC\...; allow \\?\C:\...).
 *   d. Component-wise containment check under realpath'd %LOCALAPPDATA%
 *      (case-insensitive on Windows).
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

/** Returns true if any ancestor (inclusive) of `p` is a symbolic link. */
async function hasSymlinkInChain(p: string, warn: (m: string) => void): Promise<boolean> {
  // Walk from candidate up through all ancestors.
  let current = path.resolve(p);
  const visited = new Set<string>();

  while (true) {
    if (visited.has(current)) break;
    visited.add(current);

    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        return true;
      }
    } catch (err) {
      // lstat failed — fail closed for safety.
      warn(`lstat failed for ${current}: ${(err as Error).message}`);
      return true;
    }

    const parent = path.dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }

  return false;
}

/** Returns true if the path is a UNC path (\\server\share or \\?\UNC\...). */
function isUncPath(p: string): boolean {
  // Allow extended-length local paths (\\?\C:\...) but reject:
  //   \\?\UNC\server\share — extended UNC
  //   \\server\share       — classic UNC
  if (p.startsWith("\\\\?\\UNC\\") || p.startsWith("//?/UNC/")) return true;
  if (
    (p.startsWith("\\\\") && !p.startsWith("\\\\?\\")) ||
    (p.startsWith("//") && !p.startsWith("//?/"))
  )
    return true;
  return false;
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
