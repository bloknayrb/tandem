/**
 * What every entry script needs BEFORE the product is loaded. Imports nothing
 * from `src/` and nothing that does.
 *
 * `src/server/platform.ts` fixes the session directory when it is first
 * imported, from `TANDEM_APP_DATA_DIR`. So an entry script points that variable
 * inside its own run directory first, and only then loads the product with a
 * dynamic `import()`. A static import of `src/` in an entry script would run
 * before this and leave the product pointed at the developer's real app data.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { SPIKE_DIR } from "./paths.js";

/** Point the product's app data inside `dir` (created). Returns the directory used. */
export function isolateAppData(dir: string): string {
  const appData = path.join(dir, "app-data");
  fs.mkdirSync(appData, { recursive: true });
  process.env.TANDEM_APP_DATA_DIR = appData;
  return appData;
}

/** The commit and whether the working tree is dirty; "unknown" when git cannot say. */
export function gitState(): { commit: string; dirty: boolean | "unknown" } {
  try {
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd: SPIKE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const commit = run(["rev-parse", "HEAD"]).trim();
    const dirty = run(["status", "--porcelain"]).trim().length > 0;
    return { commit: /^[0-9a-f]{7,64}$/.test(commit) ? commit : "unknown", dirty };
  } catch {
    return { commit: "unknown", dirty: "unknown" };
  }
}

/**
 * Send the product's `console.error` / `console.warn` to a file for the rest of
 * the process. Those lines can carry bytes written by the endpoint or by the
 * model (an error body, a parse error), so they do not go to the terminal raw:
 * each is stored as one JSON string per line.
 */
export function captureProductLogs(file: string): void {
  const write = (level: string, args: unknown[]) => {
    const text = args
      .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    try {
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), level, text })}\n`, "utf8");
    } catch {
      // A log line that cannot be written is dropped, never printed raw.
    }
  };
  console.error = (...args: unknown[]) => write("error", args);
  console.warn = (...args: unknown[]) => write("warn", args);
}

/** Printable text for the terminal: control and bidi characters removed, bounded. */
export function printable(text: string, max = 400): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .slice(0, max);
}

export function say(line: string): void {
  process.stdout.write(`${line}\n`);
}
