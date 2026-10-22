import { statSync } from "node:fs";

/**
 * A path's permission bits (`mode & 0o777`). Sync `statSync`, deliberately:
 * some specs mock `fs.promises.stat`, and a mode assertion must read the disk.
 */
export function modeOf(p: string): number {
  return statSync(p).mode & 0o777;
}
