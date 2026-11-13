/**
 * The log sink's owner-handle redaction (#2358 PR 3a, R5.2/R5.3, Rulings D6
 * and L).
 *
 * The owner handle (`src/shared/owner-handle.ts`) is a per-spawn bearer secret.
 * Nothing in Tandem logs it on purpose; this is the net under every line that
 * reaches the server's stderr, installed by `src/server/index.ts` on both of
 * its console shapes. A pure module, because `index.ts` cannot be imported by
 * a test (importing it runs `main()`).
 *
 * **Unconditional** (Ruling D6): a secret filter should not switch off with a
 * flag. A dark server mints no handle, so a dark line changes only when it
 * already contains `th_` followed by a long `[A-Za-z0-9_-]` run (a path
 * segment, a snake_case identifier); that rare over-redaction is accepted.
 *
 * **No guard on either side** (Ruling L). `sanitizeForLog` deletes control
 * characters, so `th_<32>\nNext` reaches the sink as `th_<32>Next`; a guard
 * after the match ("not followed by another base64url character") would let
 * exactly that through. So a longer run that starts like a handle loses its
 * first 35 characters, and that is accepted.
 *
 * **Clamped fields.** `sanitizeForLog` cuts a field at `LOG_FIELD_MAX` and
 * appends U+2026. A handle cut there is shorter than 32 characters, so at a
 * field end (the `…`) any `th_` followed by 16 or more base64url characters is
 * redacted too. Accepted, in writing: a clamp that leaves 1 to 15 characters
 * after `th_` is not redacted.
 *
 * Not covered, accepted in writing: a dependency's own `process.stderr.write`
 * and `process.emitWarning`. The direct `process.stderr.write` calls in
 * `src/server/index.ts` print bind configuration only and cannot carry a
 * handle.
 */

import { formatWithOptions } from "node:util";

/** What a redacted handle reads as in the log. */
export const REDACTED_OWNER_HANDLE = "th_[redacted]";

const FULL_HANDLE = /th_[A-Za-z0-9_-]{32}/g;
const CLAMPED_HANDLE = /th_[A-Za-z0-9_-]{16,31}(?=…)/g;

/** Redact every owner handle (and every clamped partial one) in `line`. A line
 * with no `th_` is returned unchanged, byte for byte. */
export function redactOwnerHandles(line: string): string {
  if (!line.includes("th_")) return line;
  return line
    .replace(FULL_HANDLE, REDACTED_OWNER_HANDLE)
    .replace(CLAMPED_HANDLE, REDACTED_OWNER_HANDLE);
}

/**
 * The plain shape's renderer: what Node's own `console.error` prints for the
 * same arguments, colours included only where Node would use them (a TTY that
 * has colours), so a dark line with no `th_` is unchanged.
 */
export function plainConsoleFormat(args: unknown[]): string {
  const stderr = process.stderr as NodeJS.WriteStream;
  const colors =
    stderr.isTTY === true && typeof stderr.hasColors === "function" && stderr.hasColors();
  return formatWithOptions({ colors }, ...args);
}

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace" | "dir";

/** The console methods the installer replaces. `trace` prints a stack and `dir`
 * an inspected object, both of which can carry a string the caller passed. */
export const REDACTED_CONSOLE_METHODS: readonly ConsoleMethod[] = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "dir",
];

/**
 * Replace `target`'s console methods with ones that format the call exactly as
 * Node's console would (`util.format`, colours off), redact the whole formatted
 * line, and hand it to `write` (no trailing newline). Formatting first is the
 * point: a handle inside an `Error`'s message or stack, or deep inside an
 * inspected object, is caught because the redaction runs on the rendered text,
 * not on each argument.
 *
 * `format` lets the production shape keep its own renderer
 * (`formatLogLine`, which also returns `null` for a suppressed line).
 */
export function installLogRedaction(
  target: Pick<Console, ConsoleMethod>,
  write: (line: string) => void,
  format: (args: unknown[]) => string | null = plainConsoleFormat,
): void {
  const emit = (args: unknown[]) => {
    const line = format(args);
    if (line === null) return;
    write(redactOwnerHandles(line));
  };
  target.log = (...args: unknown[]) => emit(args);
  target.info = (...args: unknown[]) => emit(args);
  target.warn = (...args: unknown[]) => emit(args);
  target.error = (...args: unknown[]) => emit(args);
  target.debug = (...args: unknown[]) => emit(args);
  target.trace = (...args: unknown[]) => {
    const err = new Error(formatWithOptions({}, ...args));
    err.name = "Trace";
    emit([err.stack ?? err.message]);
  };
  target.dir = (obj: unknown, options?: object) =>
    emit([formatWithOptions({ ...(options ?? {}), colors: false }, "%O", obj)]);
}
