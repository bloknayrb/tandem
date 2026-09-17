import envPaths from "env-paths";
import fs from "fs";
import path from "path";
import { TOKEN_FILE_NAME } from "../shared/constants.js";
import { ATOMIC_TEMP_PREFIX, atomicWrite } from "./file-io/index.js";

/**
 * Ownership stamp for the app-data root (#1787, decision D).
 *
 * The desktop sidecar and an npm-installed `tandem` used to share one
 * directory: `sidecar.rs` set `TANDEM_DATA_DIR` while `resolveAppDataDir()`
 * reads `TANDEM_APP_DATA_DIR`, which nobody set. So `sessions/`,
 * `last-seen-version`, `integrations.json`, the annotation envelope dir, doc
 * backups and (once the gate is live) `trial.json` / `license.json` were shared
 * across two installs that ship on independent schedules.
 *
 * **Directory separation is the mechanism; this stamp is the guard that makes
 * any residual sharing loud rather than silent.** A stamp alone cannot do the
 * job: an already-released `tandem-editor` has no code to read one.
 */

/** The file this module owns, inside the app-data root. */
export const OWNER_STAMP_FILE = "owner.json";

/**
 * The one-time legacy migration's completion record (#1787 review).
 *
 * **Separate from the stamp on purpose.** The migration used to be gated on
 * "no stamp yet", and the desktop refusal message tells the user to delete
 * `owner.json` — so following the product's own advice silently re-ran
 * `fs.cp` over the whole legacy npm tree, resurrecting sessions, annotation
 * envelopes and doc backups the user had since deleted (`force: false` only
 * protects files that still EXIST). The same path was reachable with no user
 * action at all while the stamp was written non-atomically: a truncated stamp
 * reads as unowned. The stamp is now written through `atomicWrite`, and the
 * migration is gated on this file, which nothing ever tells anyone to delete.
 */
export const MIGRATION_MARKER_FILE = "npm-migration-complete";

/**
 * Which install wrote the stamp.
 *
 * Derived from the `--tauri-sidecar` argv flag (see `isTauriSidecar` in
 * `platform.ts`), never from `TANDEM_TAURI_SIDECAR` — that variable reaches
 * every descendant of the sidecar, so an npm `tandem` run from an auto-launched
 * Claude Code session's own shell would claim the desktop's directory as
 * `"desktop"` and bypass the very guard this module is.
 */
export type AppDataFlavor = "desktop" | "npm";

export interface OwnerStamp {
  version: string;
  flavor: AppDataFlavor;
}

export type ClaimResult = "claimed" | { refused: OwnerStamp };

function stampPath(appDataDir: string): string {
  return path.join(appDataDir, OWNER_STAMP_FILE);
}

async function readStamp(appDataDir: string): Promise<OwnerStamp | null> {
  try {
    const raw = await fs.promises.readFile(stampPath(appDataDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { version, flavor } = parsed as Record<string, unknown>;
    if (typeof version !== "string") return null;
    if (flavor !== "desktop" && flavor !== "npm") return null;
    return { version, flavor };
  } catch {
    // Missing, unreadable, truncated or malformed all read as "unowned". A
    // throw here would make a half-written stamp unrecoverable.
    return null;
  }
}

/**
 * The five things the one-time migration must NOT copy.
 *
 * 1. `owner.json` — **the stamp is the only file never copied, and that is what
 *    makes it the completion record.** `fs.cp` gives no ordering guarantee, so a
 *    legacy stamp copied before an interruption would leave a foreign-flavor
 *    stamp and make every subsequent desktop launch refuse: permanently
 *    unstartable, with the message pointing at an env var rather than at a file
 *    to delete.
 * 2. `annotations/store.lock` — a copied lock holding a live npm PID makes the
 *    migrated directory read-only for annotations, and never clears:
 *    `releaseStoreLock` unlinks under the *releasing* process's own dir.
 * 3. In-flight atomic-write temporaries. The marker is a PREFIX
 *    (`.tandem-tmp-`), imported rather than re-spelled so the filter and the
 *    writer cannot drift. A `*.tmp` glob would match none of them and quietly
 *    copy every real orphaned temp in permanently, under `force: false`.
 * 4. The auth-token file — `src/shared/auth/token-file.ts` derives its path from
 *    the `env-paths` root DIRECTLY and ignores `TANDEM_APP_DATA_DIR`,
 *    deliberately. A copy in the desktop directory has no reader, is never
 *    rotated by `/api/rotate-token`, and never gets `readTokenFromFile`'s 0600
 *    repair — it is only a second copy of a secret.
 * 5. `npm-migration-complete` — the completion record, for the same reason as
 *    the stamp. `fs.cp` gives no ordering guarantee, so a marker copied early
 *    and then an interrupted copy would leave a directory that reads as fully
 *    migrated while most of the tree never arrived. It cannot legitimately
 *    exist in an npm root anyway (only the desktop arm writes one).
 */
function shouldMigrate(source: string): boolean {
  const base = path.basename(source);
  if (base === OWNER_STAMP_FILE) return false;
  if (base === MIGRATION_MARKER_FILE) return false;
  if (base === "store.lock") return false;
  if (base.startsWith(ATOMIC_TEMP_PREFIX)) return false;
  if (base === TOKEN_FILE_NAME) return false;
  return true;
}

function legacyAppDataDir(): string {
  return envPaths("tandem", { suffix: "" }).data;
}

/**
 * Copy one file so that an interruption can never leave a TRUNCATED target
 * (review round 2).
 *
 * `fs.cp` writes each file in place. A kill or a full disk mid-copy therefore
 * leaves a half-written file at the destination — and the retry's "an existing
 * target wins" rule then skips it **forever**, because the check is existence,
 * not completeness. The user is left with a silently truncated session file or
 * annotation envelope and a directory that reports itself fully migrated.
 * Temp-then-rename makes the target appear only once it is whole, so the retry
 * either finds a complete file or finds nothing and copies it again.
 *
 * The temp sibling carries {@link ATOMIC_TEMP_PREFIX}, so `shouldMigrate`
 * already refuses to migrate one and the boot-time orphan reaper already knows
 * the shape.
 */
async function copyFileAtomically(from: string, to: string): Promise<void> {
  const tmp = path.join(path.dirname(to), `${ATOMIC_TEMP_PREFIX}${path.basename(to)}`);
  try {
    await fs.promises.copyFile(from, tmp);
    await fs.promises.rename(tmp, to);
  } catch (err) {
    // Never leave our own temp behind on a failed copy (#1850's class).
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Walk the legacy tree, copying entry by entry and COLLECTING failures rather
 * than aborting on the first one (review round 2).
 *
 * This replaces a single `fs.promises.cp(..., {recursive: true})`, which is
 * all-or-nothing: one unreadable entry anywhere in the tree — a permission-denied
 * file, a stale Windows lock, a dangling symlink — rejected the whole call. That
 * failure propagated to `claimAppDataDir`'s catch, which returns without writing
 * the stamp, so **the ownership guard #1787 exists to install never armed at
 * all**, on that launch or any later one: the retry hit the same bad entry and
 * failed the same way, every single time. A defect in one file silently disabled
 * the separation guard for the whole install.
 *
 * Existing targets are skipped rather than overwritten — the `force: false`
 * semantics of the call this replaces — so a retry can never clobber state the
 * desktop has since written.
 *
 * Symlinks and special files are deliberately not followed: the app-data root
 * holds Tandem's own state, and a symlink there points somewhere this migration
 * has no business writing.
 */
async function copyTreeCollectingFailures(
  from: string,
  to: string,
  failures: string[],
): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.promises.readdir(from, { withFileTypes: true });
  } catch (err) {
    failures.push(`${from}: ${err instanceof Error ? err.message : err}`);
    return;
  }

  for (const entry of entries) {
    const source = path.join(from, entry.name);
    if (!shouldMigrate(source)) continue;
    const target = path.join(to, entry.name);
    try {
      if (entry.isDirectory()) {
        await fs.promises.mkdir(target, { recursive: true });
        await copyTreeCollectingFailures(source, target, failures);
      } else if (entry.isFile()) {
        try {
          await fs.promises.access(target);
          continue; // an existing target wins
        } catch {
          // absent — copy it
        }
        await copyFileAtomically(source, target);
      }
    } catch (err) {
      failures.push(`${source}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Copy the legacy npm app-data tree into the desktop's own directory, once.
 *
 * Copy-only and filtered: the legacy directory is left intact, and an existing
 * target file wins, so a retry can never clobber state the desktop has since
 * written. The app-data root holds only Tandem's own state — user documents live
 * wherever the user put them and are referenced by path.
 *
 * Runs only for `flavor: "desktop"`, only when {@link MIGRATION_MARKER_FILE} is
 * absent, and only when the resolved directory actually differs from the legacy
 * one. **The gate is the marker, not the stamp** — see the marker's docblock:
 * the desktop refusal message tells the user to delete the stamp, and a
 * stamp-gated migration therefore re-imports the whole legacy tree on the next
 * launch.
 *
 * The marker is written only when EVERY entry arrived, so a partial copy retries
 * rather than recording a migration that did not finish. A partial copy is
 * reported and otherwise tolerated: see `copyTreeCollectingFailures` for why one
 * bad entry must not be allowed to abort the caller.
 */
async function migrateLegacyTree(appDataDir: string): Promise<void> {
  const legacy = legacyAppDataDir();
  if (path.resolve(legacy) === path.resolve(appDataDir)) return;
  try {
    const stat = await fs.promises.stat(legacy);
    if (!stat.isDirectory()) return;
  } catch {
    return;
  }

  const failures: string[] = [];
  await copyTreeCollectingFailures(legacy, appDataDir, failures);

  if (failures.length > 0) {
    console.error(
      `[Tandem] Warning: ${failures.length} item(s) could not be migrated from ${legacy} — ` +
        `retrying on the next launch. First: ${failures[0]}`,
    );
    return;
  }

  await atomicWrite(
    path.join(appDataDir, MIGRATION_MARKER_FILE),
    `${JSON.stringify({ from: legacy, at: new Date().toISOString() }, null, 2)}\n`,
  );
}

/** Whether the one-time legacy migration has already completed here. */
async function migrationAlreadyRan(appDataDir: string): Promise<boolean> {
  try {
    await fs.promises.access(path.join(appDataDir, MIGRATION_MARKER_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim `appDataDir` for this install, refusing a directory the other flavor
 * owns (#1787).
 *
 * **Failure contract, first: this must never throw.** It runs near the top of
 * `main()`, where `main().catch(...) => process.exit(1)` turns any escaping
 * error into a startup abort — for the desktop that is `wait_for_health`
 * failing through `MAX_RESTARTS` into the "Retry Server Start" dialog, an app
 * that never starts with no in-product recovery. Everything else at that
 * altitude (the backup sweep, the trial clock) is deliberately best-effort;
 * this is too. On any internal failure it logs and returns `"claimed"`
 * **without writing the stamp**, so the next launch retries rather than
 * recording a copy that did not happen. It may return `refused`; it may not
 * throw.
 *
 * **The refusal is on `flavor`, not on version ordering.** An older build
 * cannot read the stamp at all, so a version-ordered rule protects nothing
 * separation has not already made impossible, while a flavor rule catches
 * exactly the mixing decision D names — robust in both directions, and needing
 * no semver comparator (#1792, wave 8). `version` is recorded so the message
 * can name the owner; it is not itself a gate.
 */
export async function claimAppDataDir(
  appDataDir: string,
  version: string,
  flavor: AppDataFlavor,
): Promise<ClaimResult> {
  try {
    // Before ANY write: the first-ever desktop launch writes into a directory
    // `app_data_dir()` merely names.
    await fs.promises.mkdir(appDataDir, { recursive: true });
  } catch (err) {
    console.error(
      `[Tandem] Warning: could not create the app-data directory ${appDataDir}: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return "claimed";
  }

  // `readStamp` reports every failure as `null` (unowned) rather than throwing,
  // so there is nothing to catch here.
  const existing = await readStamp(appDataDir);

  if (existing && existing.flavor !== flavor) {
    return { refused: existing };
  }

  // The migration gets its OWN catch, so a failed copy cannot cost us the stamp
  // (review round 2). Directory separation is the mechanism decision D asks
  // for; importing the old tree is a convenience on top of it. Holding the
  // stamp hostage to the copy inverted that — one unreadable legacy file left
  // the directory unstamped on every launch, which is precisely the shared,
  // unguarded state #1787 exists to end. The marker is untouched here, so the
  // copy still retries next time.
  // Gated on the MARKER alone — deliberately not also on "no stamp yet". Once
  // the stamp stopped being withheld on failure (above), a `!existing` term
  // would let the migration run exactly once and never retry: the first
  // attempt stamps the directory, and every retry then sees a stamp and skips.
  // The marker is the completion record; it is the only correct gate, which is
  // what this module's docblocks have said since the round-1 fix.
  if (flavor === "desktop" && !(await migrationAlreadyRan(appDataDir))) {
    try {
      await migrateLegacyTree(appDataDir);
    } catch (err) {
      console.error(
        `[Tandem] Warning: legacy app-data migration failed (${
          err instanceof Error ? err.message : err
        }) — continuing; it retries on the next launch`,
      );
    }
  }

  try {
    // `atomicWrite`, not `fs.promises.writeFile`: `readStamp` reports a
    // truncated stamp as "unowned", so a crash or power loss mid-write would
    // hand this directory to the other flavor without a word.
    await atomicWrite(stampPath(appDataDir), `${JSON.stringify({ version, flavor }, null, 2)}\n`);
  } catch (err) {
    // No stamp written — the directory stays unowned and the next launch tries
    // again. Unlike the migration above, nothing here is retried-but-partial:
    // `atomicWrite` either published a whole stamp or none.
    console.error(
      `[Tandem] Warning: app-data claim incomplete (${
        err instanceof Error ? err.message : err
      }) — retrying on the next launch`,
    );
    return "claimed";
  }

  return "claimed";
}

/**
 * The stderr line `index.ts` prints before exiting 1 on a refusal.
 *
 * Flavor-aware: the `TANDEM_APP_DATA_DIR` remedy is inert on the desktop arm,
 * because the sidecar sets that variable explicitly on the child and an
 * explicit `.env()` overrides an inherited value.
 *
 * On the npm arm the remedy names a variable that may ALREADY be set — the
 * sidecar exports it and it is inherited by descendants (`supervisor.ts`'s
 * `childEnv` strips it for the auto-launched session, but a hand-exported one,
 * or any other descendant, still arrives). "Set TANDEM_APP_DATA_DIR" then reads
 * as a no-op, so the message states the current value when there is one, taken
 * from `env` rather than from `process.env` directly so a test can drive it.
 */
export function refusalMessage(
  appDataDir: string,
  owner: OwnerStamp,
  flavor: AppDataFlavor,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const head =
    `[Tandem] This app-data directory (${appDataDir}) belongs to the ${owner.flavor} ` +
    `install (last used by v${owner.version}). Refusing to share it.`;
  if (flavor === "npm") {
    const inherited = env.TANDEM_APP_DATA_DIR;
    const preamble = inherited
      ? ` TANDEM_APP_DATA_DIR is currently "${inherited}" — it may have been inherited from a parent process.`
      : "";
    return `${head}${preamble} Set TANDEM_APP_DATA_DIR to a different directory (or unset it to use this install's default).`;
  }
  // NOT "quit the npm `tandem` and relaunch" (review round 2). The stamp is a
  // durable file, not a lock: quitting the other install changes nothing, so
  // that remedy sent the user to do something that could not possibly work and
  // then hit the same refusal. A desktop reaching this arm was pointed at the
  // npm directory by an inherited `TANDEM_APP_DATA_DIR` — separation gives it
  // its own otherwise — so unsetting that is the remedy that acts.
  const inherited = env.TANDEM_APP_DATA_DIR;
  const pointedHere =
    inherited && path.resolve(inherited) === path.resolve(appDataDir)
      ? ` TANDEM_APP_DATA_DIR is set to "${inherited}" and is what pointed the desktop here; unset it to use the desktop's own directory.`
      : "";
  return `${head}${pointedHere} Remove ${path.join(
    appDataDir,
    OWNER_STAMP_FILE,
  )} if you are certain no npm install uses this directory.`;
}
