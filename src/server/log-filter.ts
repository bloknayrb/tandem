/**
 * The production (Tauri sidecar) console filter, as a pure module (#1823 item 1).
 *
 * Lives here rather than in `src/server/index.ts` because importing that file
 * *runs the server*: `main()` is invoked at the bottom of it and calls
 * `freePort()`, which kills whatever holds :3478/:3479. `launcher/initial-reason.ts`
 * is the same extraction for the same reason. Pure function, pure module, no
 * side effects on import.
 *
 * ## Why the two inputs stay separate
 *
 * The suppression test runs against `args.map(String).join(" ")` — the exact
 * shape the filter has always tested — and `util.format` is applied only once
 * nothing matched. Formatting *before* testing would silently WIDEN
 * suppression: `/Invalid access/i` is unanchored and `format(err)` emits the
 * whole stack, so an unrelated fatal whose stack frames happen to contain that
 * text would vanish from the sidecar log entirely. The narrow probe is the
 * contract, not an implementation detail.
 *
 * The bug this fixes: the filter used to WRITE `args.map(String).join(" ")`,
 * which stringifies each argument and joins them, so
 * `console.error("failed for %s:", id, err)` reached the log as
 * `failed for %s: <id> Error: ...` — the placeholder printed literally — and
 * `String(err)` is `name: message`, so the Error's stack was dropped. This is
 * production-only: the non-sidecar branch aliases `console.log/warn/info` to
 * `console.error`, which formats normally.
 */

import { format } from "node:util";

/** Known noisy warnings from dependencies (mammoth, Y.js), dropped in the sidecar build. */
export const SUPPRESSED_PATTERNS = [/^\[mammoth\]/, /Invalid access/i, /^\s*add yjs type/i];

/**
 * Render one console call for the sidecar log, or `null` when it is suppressed.
 *
 * @param args the console call's arguments, verbatim.
 * @returns the line to write (no trailing newline), or `null` to drop it.
 */
export function formatLogLine(args: unknown[]): string | null {
  // Deliberately NOT the formatted string — see the docblock above.
  const probe = args.map(String).join(" ");
  if (SUPPRESSED_PATTERNS.some((p) => p.test(probe))) return null;
  return format(...args);
}
