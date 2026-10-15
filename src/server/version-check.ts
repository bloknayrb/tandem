import fs from "fs/promises";
import path from "path";

export type VersionCheckResult = "first-install" | "upgraded" | "current";

/**
 * `1.0.0` or later, release only — the one definition of "v1.0" that both the
 * v1.0 greeting re-arm (#2197) and the v1.0 setup walkthrough (#2198) key on.
 * A prerelease (`1.0.0-rc.1`) is NOT v1.0: a tester on a release candidate
 * must not spend either before v1.0 ships. Anything unparseable (a dev
 * fallback version) is not either. Not a semver comparator — see below.
 */
export function isV1Release(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return m !== null && Number(m[1]) >= 1;
}

export interface CheckVersionChangeOptions {
  /**
   * Work to do BEFORE the new version is stamped, on the `"upgraded"`
   * transition only. The stamp is written only if this resolves.
   *
   * #1792: the stamp used to be written unconditionally inside this function
   * while the caller opened `CHANGELOG.md` afterwards — so a failed open meant
   * that release's notes never opened at all, because the next start read
   * `current`. Read and write stay in ONE function deliberately: split into
   * `checkVersionChange` + a separate `stampVersion`, a dropped stamp call
   * fails silently and re-opens CHANGELOG read-only on every launch forever.
   */
  onUpgrade?: () => Promise<void>;
}

/**
 * Compare the running version against the stored last-seen version.
 * Returns the transition type so the caller can decide what to do.
 *
 * Writes the current version on first-install, and on upgrade once
 * `opts.onUpgrade` (if given) has resolved. A rejecting hook is logged and
 * leaves the file unwritten, so the next start still reports `"upgraded"`.
 *
 * "Upgraded" is version-change-neutral: a DOWNGRADE takes this arm too, and
 * correctly — the running build's own CHANGELOG is what the user wants to see.
 * There is deliberately no semver comparator here.
 */
export async function checkVersionChange(
  currentVersion: string,
  versionFilePath: string,
  opts?: CheckVersionChangeOptions,
): Promise<VersionCheckResult> {
  let storedVersion: string | null = null;
  try {
    storedVersion = (await fs.readFile(versionFilePath, "utf-8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[Tandem] Failed to read last-seen-version:", err);
    }
  }

  const result: VersionCheckResult =
    storedVersion === null
      ? "first-install"
      : storedVersion === currentVersion
        ? "current"
        : "upgraded";

  if (result !== "current") {
    if (result === "upgraded" && opts?.onUpgrade) {
      try {
        await opts.onUpgrade();
      } catch (err) {
        console.error("[Tandem] Version-change hook failed; not stamping the new version:", err);
        return result;
      }
    }
    await fs.mkdir(path.dirname(versionFilePath), { recursive: true });
    await fs.writeFile(versionFilePath, currentVersion, "utf-8");
  }

  return result;
}
