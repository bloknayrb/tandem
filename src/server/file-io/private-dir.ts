/**
 * Owner-only directories for Tandem's own app-data stores (#2266).
 *
 * `sessions/` (each document's full `ydocState`), `annotations/` (envelopes
 * quoting `textSnapshot`s) and `doc-backups/` (verbatim document copies) all
 * hold document content. Their FILES are written at `0600` from now on (see
 * `AtomicWriteOptions.maxMode`), but a file that is never rewritten — a
 * `.partial.*` / `.corrupt.*` / `.future` quarantine, a quarantined session,
 * a `0644` file from an older build — keeps whatever mode it has, because
 * nothing here chmods a file by path. The `0700` directory is what covers
 * those, which is why the directory is tightened as well as created.
 *
 * Two entry points, deliberately separate:
 *
 * - {@link hardenPrivateDir} — create, then on POSIX remove group/other bits.
 * - {@link applyPrivateDirAcl} — the Windows equivalent, an inheritable
 *   owner-only DACL, memoised per directory. The doc-backup sweep calls this
 *   one alone, because it must not create a root that does not exist.
 *
 * {@link ensurePrivateStoreDir} composes them for the session and annotation
 * stores, firing the ACL WITHOUT awaiting it: the annotation store's
 * `ensureDirReady` runs before the stdio MCP handshake, and an icacls/whoami
 * spawn must not delay boot. The grant is inheritable, so files created before
 * it lands are covered once it does.
 */

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setRestrictiveAcl } from "../integrations/acl-win.js";

/**
 * What an ACL application did, from one caller's view. The doc-backup sweep
 * reports all four in its log line; see `logUnreadable` in `doc-backup.ts`.
 */
export type AclRepairOutcome =
  /** This call applied the ACL, and it succeeded. */
  | "repaired"
  /** An earlier call this run applied it successfully; this one only awaited. */
  | "already-repaired"
  /** The ACL application ran and FAILED (this call's or an earlier one's). */
  | "repair-failed"
  /** Not Windows — there is no ACL to apply and nothing was done. */
  | "unsupported";

/**
 * Per-directory ACL memo, keyed by `path.resolve(dir)`.
 *
 * Every stored promise is wrapped in its own try/catch and therefore NEVER
 * rejects. That is load-bearing: a stored rejection would reach every later
 * awaiter, and for doc-backup that awaiter is `snapshotBeforeFirstWrite`, whose
 * outer catch would turn ACL hygiene into a failed backup and a toast. The
 * un-awaited store callers rely on it too — a rejecting `void` promise is an
 * `unhandledRejection`.
 *
 * Latches on ATTEMPT, not success: a failing icacls retried on every call
 * would spawn subprocesses in a loop for no gain.
 */
const aclMemo = new Map<string, Promise<boolean>>();

/** Test-only: forget every memoised ACL application. */
export function _resetPrivateDirAclForTests(): void {
  aclMemo.clear();
}

/**
 * Create `dir` (`0700` on create) and, on POSIX, remove its group and other
 * permission bits if it already existed wider.
 *
 * - **mkdir errors propagate**, exactly as the bare `fs.mkdir` this replaces
 *   did, so each caller's failure contract is unchanged. `create: false` skips
 *   the mkdir (for a directory this caller does not own the existence of, such
 *   as the legacy npm copy the desktop migration leaves behind).
 * - **The tighten step never throws.** It opens the directory itself with
 *   `O_DIRECTORY | O_NOFOLLOW` and `fchmod`s the descriptor, so a symlink
 *   swapped in at the leaf is refused rather than followed, and the mode
 *   written is `mode & ~0o077` — it never ADDS a bit, so a `0500` directory
 *   stays `0500`. There is deliberately no root-containment check: the
 *   directory is wherever the user put their app data (`TANDEM_APP_DATA_DIR`,
 *   an `XDG_DATA_HOME` on another mount), and a narrow-only `fchmod` on a
 *   descriptor the caller had to be able to open cannot widen anything, so a
 *   home/tmp allowlist would only leave such a directory open. A symlinked
 *   ANCESTOR is followed, which is harmless for the same reason (and `fchmod`
 *   needs ownership). Any refusal or failure is a `console.warn` (stderr —
 *   stdout is the MCP wire) and the directory is left as it was.
 * - Windows: mkdir only. Mode bits carry no access control there; see
 *   {@link applyPrivateDirAcl}.
 */
export async function hardenPrivateDir(
  dir: string,
  opts: { create?: boolean } = {},
): Promise<void> {
  const create = opts.create !== false;
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    const handle = await fs.open(
      dir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      const st = await handle.stat();
      if ((st.mode & 0o077) !== 0) await handle.chmod(st.mode & 0o7700);
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (!create && (err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(
      `[Tandem] Could not restrict permissions on ${dir} (continuing): ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

/**
 * Apply an inheritable owner-only DACL to `dir`, at most once per directory per
 * run, and wait for it to settle. Windows only; does NOT create `dir`.
 *
 * `inheritable` is load-bearing: the grant lands on the directory while files
 * and subdirs are created inside it, and the default grant strips subdirs to an
 * EMPTY, deny-everyone DACL (#1299 — mechanism in `setRestrictiveAcl`'s
 * docblock). Re-running it also repairs subdirs that grant already poisoned.
 *
 * `logLabel` is the start of the failure line (`"<label> failed (continuing):"`);
 * the first caller for a directory owns it. Never rejects (see `aclMemo`).
 */
export async function applyPrivateDirAcl(
  dir: string,
  opts: { logLabel?: string } = {},
): Promise<AclRepairOutcome> {
  if (process.platform !== "win32") return "unsupported";
  const key = path.resolve(dir);
  let pending = aclMemo.get(key);
  const startedHere = pending === undefined;
  if (pending === undefined) {
    // Stored synchronously, before any await, so concurrent callers share one
    // application instead of racing two icacls runs.
    pending = (async () => {
      try {
        await setRestrictiveAcl(dir, { inheritable: true });
        return true;
      } catch (aclErr) {
        console.error(
          `${opts.logLabel ?? `[Tandem] Restrictive ACL on ${dir}`} failed (continuing):`,
          aclErr,
        );
        return false;
      }
    })();
    aclMemo.set(key, pending);
  }
  const applied = await pending;
  if (!applied) return "repair-failed";
  return startedHere ? "repaired" : "already-repaired";
}

/**
 * The session and annotation stores' directory setup: {@link hardenPrivateDir}
 * awaited (mkdir errors still propagate), then {@link applyPrivateDirAcl} fired
 * and NOT awaited — it never rejects, and an icacls spawn must not hold up the
 * stdio handshake or a save.
 */
export async function ensurePrivateStoreDir(dir: string): Promise<void> {
  await hardenPrivateDir(dir);
  void applyPrivateDirAcl(dir);
}
