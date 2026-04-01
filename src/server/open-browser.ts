import { execFile } from "node:child_process";

/**
 * Open a URL in the default browser.
 * Best-effort — errors are logged to stderr, never thrown.
 */
export function openBrowser(url: string): void {
  let command: string;
  let args: string[];

  if (process.platform === "win32") {
    // `start` requires the empty title arg ("") to handle URLs with & correctly
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  execFile(command, args, (err) => {
    if (err) {
      console.error("[Tandem] Could not open browser automatically.");
      console.error(`[Tandem] Open this URL manually: ${url}`);
    }
  });
}
