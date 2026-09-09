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
 * Copy the legacy npm app-data tree into the desktop's own directory, once.
 *
 * Copy-only and filtered: the legacy directory is left intact, and
 * `force: false` means an existing target file wins, so a retry can never
 * clobber state the desktop has since written. The app-data root holds only
 * Tandem's own state — user documents live wherever the user put them and are
 * referenced by path.
 *
 * Runs only for `flavor: "desktop"`, only when {@link MIGRATION_MARKER_FILE} is
 * absent, and only when the resolved directory actually differs from the legacy
 * one. **The gate is the marker, not the stamp** — see the marker's docblock:
 * the desktop refusal message tells the user to delete the stamp, and a
 * stamp-gated migration therefore re-imports the whole legacy tree on the next
 * launch.
 *
 * The marker is written only after `fs.cp` resolves, so an interrupted copy
 * retries rather than recording a migration that did not finish.
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
  await fs.promises.cp(legacy, appDataDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: shouldMigrate,
  });
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

  try {
    if (!existing && flavor === "desktop" && !(await migrationAlreadyRan(appDataDir))) {
      await migrateLegacyTree(appDataDir);
    }
    // `atomicWrite`, not `fs.promises.writeFile`: `readStamp` reports a
    // truncated stamp as "unowned", so a crash or power loss mid-write would
    // hand this directory to the other flavor without a word.
    await atomicWrite(stampPath(appDataDir), `${JSON.stringify({ version, flavor }, null, 2)}\n`);
  } catch (err) {
    // No stamp written: the next launch re-attempts the migration rather than
    // recording a copy that did not happen.
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
  return `${head} Quit the npm \`tandem\` and relaunch, or remove ${path.join(
    appDataDir,
    OWNER_STAMP_FILE,
  )} if you are certain no npm install uses this directory.`;
}
