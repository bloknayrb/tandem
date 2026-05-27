import fs from "fs/promises";
import path from "path";
import { ATOMIC_TEMP_PREFIX } from "./index.js";

/**
 * Result of a reap sweep: how many orphaned temp files were unlinked and how
 * many matched but could not be removed (logged individually via stderr).
 */
export interface ReapResult {
  cleaned: number;
  failed: number;
}

/** Orphaned temp files older than this are eligible for deletion. */
const REAP_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Escape every regex metacharacter (including backslash) so a literal string
 * can be embedded safely in a `RegExp` source. `ATOMIC_TEMP_PREFIX` is a
 * constant holding only `.tandem-tmp-` today, but escaping the full
 * metacharacter set — not just `.` — keeps the deletion boundary correct if
 * the prefix ever gains another metachar, and closes the `js/incomplete-
 * sanitization` gap (escaping `.` alone leaves backslash unescaped).
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches EXACTLY an atomic-write temp sibling: the `.tandem-tmp-` prefix, a
 * millisecond timestamp, and the 12-lowercase-hex random suffix produced by
 * `crypto.randomBytes(6).toString("hex")`. The `^`/`$` anchors plus the fixed
 * `{12}` hex length are the load-bearing safety gate — they guarantee
 * `store.lock`, `<hash>.json`, `<hash>.json.corrupt.<ts>`, `<hash>.json.future`,
 * and session `.json` files can never match, so the reaper only ever deletes
 * the temp siblings written by `atomicWrite`/`atomicWriteBuffer`. Exported so a
 * test can pin that `tempSiblingPath`'s output shape stays reapable.
 */
export const ATOMIC_TEMP_RE = new RegExp(
  `^${escapeRegExp(ATOMIC_TEMP_PREFIX)}(\\d+)-([0-9a-f]{12})$`,
);

/**
 * Boot-time sweep for orphaned atomic-write temp files.
 *
 * `atomicWrite`/`atomicWriteBuffer` write a `.tandem-tmp-*` sibling then rename
 * it over the target. The error path unlinks the temp on terminal rename
 * failure, so failed writes never orphan. Orphans accumulate ONLY when the
 * process is killed (SIGKILL: dev restarts, force-quits, crashes) in the window
 * between `fs.writeFile` and `fs.rename`. In-process cleanup cannot catch these;
 * a startup sweep is the only fix.
 *
 * The 1-hour age gate — not the annotation store lock — is what makes this safe
 * against a concurrently-starting second instance: session-dir writes aren't
 * gated by the store lock, and a temp younger than an hour might still be an
 * in-flight write from a peer. Anything older than an hour is unambiguously dead.
 *
 * Error tolerance, modelled on `cleanupOrphanedAnnotationFiles`: a readdir
 * failure (missing or unreadable dir) contributes 0 and never escapes; a
 * per-file unlink failure is isolated and counted, never aborting the sweep.
 * This must never throw, since the caller fires it un-awaited and an escaping
 * rejection would hit the process-killing unhandledRejection handler.
 */
export async function reapOrphanedTemps(
  dirs: string[],
  nowMs: number = Date.now(),
): Promise<ReapResult> {
  let cleaned = 0;
  let failed = 0;

  for (const dir of dirs) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // ENOENT (dir doesn't exist yet) is the normal first-run state — stay
      // silent, mirroring cleanupOrphanedAnnotationFiles. Anything else
      // (e.g. EACCES) is worth surfacing, but must not escape the function.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[Tandem] reaper: failed to read directory ${dir}:`, err);
      }
      continue;
    }

    for (const entry of entries) {
      // Only regular files: skips dirs and symlinks. (Unlinking a symlink would
      // only remove the link, never its target, but we don't want to touch them.)
      if (!entry.isFile()) continue;

      const match = entry.name.match(ATOMIC_TEMP_RE);
      if (!match) continue;

      const fullPath = path.join(dir, entry.name);
      const ts = Number(match[1]);

      let tooOld: boolean;
      if (ts <= nowMs) {
        // Not future-dated: age decision straight off the filename timestamp.
        // Boundary is EXCLUSIVE — a file exactly REAP_AGE_MS old is preserved.
        tooOld = nowMs - ts > REAP_AGE_MS;
      } else {
        // Future-dated filename = clock skew. Fall back to mtime; if mtime is
        // also in the future, or stat throws, skip the file (leave it alone).
        try {
          const stat = await fs.stat(fullPath);
          tooOld = nowMs - stat.mtimeMs > REAP_AGE_MS;
        } catch (err) {
          // Preserve on any stat failure. ENOENT just means the file was raced
          // away between readdir and stat (benign); anything else (e.g. EACCES)
          // is surfaced so a systemic stat failure isn't silently invisible.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            console.error(
              `[Tandem] reaper: failed to stat ${fullPath} (${code ?? "unknown"}):`,
              err,
            );
          }
          tooOld = false;
        }
      }

      if (!tooOld) continue;

      try {
        await fs.unlink(fullPath);
        cleaned++;
      } catch (err) {
        // One bad file (EACCES/EPERM/EISDIR/raced ENOENT/...) must never abort
        // the sweep — count it, log it, move on.
        failed++;
        const code = (err as NodeJS.ErrnoException).code;
        console.error(`[Tandem] reaper: failed to delete ${fullPath} (${code ?? "unknown"}):`, err);
      }
    }
  }

  return { cleaned, failed };
}
