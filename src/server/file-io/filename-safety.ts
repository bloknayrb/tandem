/**
 * Cross-platform filename validation for user-supplied rename targets (#1017).
 *
 * A rename takes a free-form basename (from the F2/double-click inline editor or
 * the `tandem_rename` MCP tool), unlike Save-As whose path comes from a native
 * dialog that pre-sanitizes. So the basename must be validated here. The rules
 * are applied on EVERY platform — a Windows client can drive a Linux/macOS
 * server, so a name that is invalid on Windows must be rejected regardless of
 * where the server runs (and vice-versa for separators).
 *
 * The load-bearing rule is the invalid-char set: `:` enables NTFS alternate data
 * streams (`file:stream.md` writes a hidden `stream.md` stream on base file
 * `file`), which slips past basename-equality, extension-equality, and the
 * UNC/`\\?\` prefix checks. `< > " | ? *` are likewise Windows-illegal but pass
 * those same checks. See the #1017 security review.
 */

import path from "path";

/** Windows reserved device names (case-insensitive). `CON.md` / `con.tar.md` all map here.
 *  Exported for `doc-backup.ts`'s sanitize-don't-reject variant of the same rules. */
export const WIN_RESERVED_NAMES = new Set<string>([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Windows-illegal filename characters. `:` is the NTFS alternate-data-stream vector. */
const INVALID_FILENAME_CHARS = /[<>:"|?*]/;

export interface FilenameValidationError {
  ok: false;
  /** Human-readable reason (surfaced to the user / Claude). */
  reason: string;
  /** Stable error code for HTTP/MCP mapping. */
  code: "INVALID_NAME";
}

/** True if the string contains any C0 control character (charCode < 0x20). */
function hasControlChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/**
 * Validate a bare filename intended as a rename target. Returns `{ ok: true }`
 * or a structured error. Does NOT check the extension — the caller enforces
 * extension-equality against the original (no format change).
 */
export function validateRenameFilename(name: string): { ok: true } | FilenameValidationError {
  const fail = (reason: string): FilenameValidationError => ({
    ok: false,
    reason,
    code: "INVALID_NAME",
  });

  if (typeof name !== "string" || name.length === 0 || name.trim().length === 0) {
    return fail("File name must not be empty.");
  }
  // Reject both separators explicitly: path.basename on POSIX does not treat
  // `\` as a separator, so a Windows-style `a\b.md` would otherwise pass.
  if (/[/\\]/.test(name)) {
    return fail("File name must not contain path separators.");
  }
  // Defense-in-depth: even after the separator check, require basename identity
  // so a crafted name can never resolve to a parent/child path component.
  if (path.basename(name) !== name) {
    return fail("File name must be a single path component.");
  }
  if (name === "." || name === "..") {
    return fail("File name must not be '.' or '..'.");
  }
  if (INVALID_FILENAME_CHARS.test(name) || hasControlChar(name)) {
    return fail(
      'File name contains an invalid character (one of < > : " | ? * or a control character).',
    );
  }
  // Windows strips trailing dots/spaces, so a name ending in one would land on
  // disk under a different name than the user typed (and the tab label).
  if (/[ .]$/.test(name)) {
    return fail("File name must not end with a space or a dot.");
  }
  // Reserved device name: the stem before the FIRST dot, lowercased. Using the
  // first dot (not path.extname's last dot) is essential — `con.tar.md` reserves
  // on `con`, which `basename(name, extname(name))` would miss (it yields
  // `con.tar`). Trailing spaces/dots are stripped from the stem before the
  // lookup: Windows trims them from a name component, so `con .md` (stem `con `)
  // would otherwise slip past and resolve to the CON device on disk. (The
  // whole-name trailing-space/dot check above only guards the final char.)
  const firstStem = name
    .split(".")[0]
    .toLowerCase()
    .replace(/[ .]+$/, "");
  if (WIN_RESERVED_NAMES.has(firstStem)) {
    return fail(`"${name}" uses a Windows reserved device name.`);
  }
  return { ok: true };
}
