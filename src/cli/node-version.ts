const MIN_NODE_MAJOR = 22;

/**
 * Returns a user-facing error message when the running Node.js is below the
 * supported floor, or null when it's acceptable. Unparseable versions fail
 * open — the guard exists to turn a cryptic downstream crash into a clear
 * message, not to gate runtimes it can't identify.
 */
export function nodeVersionError(version: string): string | null {
  const major = Number.parseInt(version.replace(/^v/, ""), 10);
  if (Number.isNaN(major) || major >= MIN_NODE_MAJOR) {
    return null;
  }
  return [
    `[tandem] Node.js ${MIN_NODE_MAJOR}+ is required — you are running ${version}.`,
    "[tandem] Install the current LTS from https://nodejs.org, then run tandem again.",
  ].join("\n");
}
