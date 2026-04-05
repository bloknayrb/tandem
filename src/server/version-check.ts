import fs from "fs/promises";
import path from "path";

export type VersionCheckResult = "first-install" | "upgraded" | "current";

/**
 * Compare the running version against the stored last-seen version.
 * Returns the transition type so the caller can decide what to do.
 * Always writes the current version on first-install or upgrade.
 */
export async function checkVersionChange(
  currentVersion: string,
  versionFilePath: string,
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
    await fs.mkdir(path.dirname(versionFilePath), { recursive: true });
    await fs.writeFile(versionFilePath, currentVersion, "utf-8");
  }

  return result;
}
