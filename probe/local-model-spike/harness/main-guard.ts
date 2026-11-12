/**
 * Is this module the script Node was started with?
 *
 * Every entry script in this directory runs its `main()` only behind this, so
 * importing one (a test, the typecheck program, another script) starts nothing.
 *
 * Two spellings of one file must compare equal, or a script run directly would
 * do nothing and exit 0 — which a checklist reads as a pass. So: the same real
 * path (compared case-insensitively on Windows, where a drive letter's case
 * varies), or the same file by device and inode.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Pure comparison of two already-resolved paths. */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return a === b;
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino !== 0 && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

export function isMain(
  importMetaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  let self: string;
  let entry: string;
  try {
    // The same realpath flavour on both sides (the two disagree on Windows).
    self = fs.realpathSync(fileURLToPath(importMetaUrl));
    entry = fs.realpathSync(argv1);
  } catch {
    return false;
  }
  return samePath(self, entry, process.platform) || sameFile(self, entry);
}
