import { exec } from "node:child_process";

/**
 * Open a URL in the default browser.
 * Best-effort — errors are logged to stderr, never thrown.
 */
export function openBrowser(url: string): void {
  let cmd: string;
  if (process.platform === "win32") {
    // `start` requires the empty title arg ("") to handle URLs with & correctly
    cmd = `start "" "${url}"`;
  } else if (process.platform === "darwin") {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) console.error(`[Tandem] Could not open browser: ${err.message}`);
  });
}
