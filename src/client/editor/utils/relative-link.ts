import { SUPPORTED_EXTENSIONS } from "../../../shared/constants.js";

/**
 * File extensions that open as new Tandem tabs when clicked as relative links.
 * `.docx` excluded — not navigable as a link target.
 */
const INTERNAL_LINK_EXTS = new Set([...SUPPORTED_EXTENSIONS].filter((e) => e !== ".docx"));

/**
 * Resolve a relative href against an absolute file path.
 * Works on both POSIX and Windows paths by detecting the separator.
 * Returns null when the href is not a link we are willing to open — a
 * non-navigable extension, a pure fragment, or a traversal that escapes the
 * current file's root.
 *
 * **This is NOT a URL parser, and `new URL()` semantics do not transfer to it.**
 * That distinction is load-bearing: `url-safety.ts`'s `isSchemelessPathHref`
 * only warrants that a widened href is relative *as far as the WHATWG parser is
 * concerned*, and it points here precisely because this segment walk answers a
 * different question.
 *
 * **Why the fail-closed guards exist (the bug is invisible from the body).**
 * With `currentFilePath = C:\Users\blokn\docs\note.md`, the href
 * `a/../../../../..///evil.com/share/x.md` walks `resultParts` down to empty;
 * the two empty segments produced by `///` then become two LEADING empties, and
 * `join("\\")` yields `\\evil.com\share\x.md` — a UNC path, which `openHref`
 * POSTs to `/api/open`. That is Tandem's named NTLM-hash-leak vector. The
 * variant WITHOUT the leading `a/` is allowed by Tiptap's default URL guard
 * today, so these guards close a pre-existing hole as well as one that
 * widening the guard (#1377) would otherwise open.
 *
 * Measured non-regressions (all still resolve):
 *   - `../docs/spec.md` from `C:\Users\b\docs\note.md` → `C:\Users\b\docs\spec.md`
 *   - `docs/spec.md` → `C:\Users\b\docs\docs\spec.md`
 *   - `/\evil.com/x.md` → `C:\Users\b\docs\\\evil.com\x.md`, which
 *     `path.resolve` collapses to a same-machine path.
 */
export function resolveRelativeLink(href: string, currentFilePath: string): string | null {
  // Detect Windows vs POSIX
  const sep = currentFilePath.includes("\\") ? "\\" : "/";

  // Strip hash fragment for resolution; we don't support in-page anchors cross-file
  const hashIdx = href.indexOf("#");
  const hrefPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  if (!hrefPath) return null; // pure fragment (#section) — not a file link

  // A protocol-relative (`//host/x`) or UNC-shaped (`\\host\x`) href is an
  // EXTERNAL navigation, never a path relative to the current file. `openHref`
  // routes `//` to `isSafeExternalHref` before reaching us, so this changes no
  // observable behaviour — it keeps the function correct standalone, which the
  // containment check below cannot do on its own (both forms otherwise append
  // empty segments to the current directory and pass containment).
  if (hrefPath.startsWith("//") || hrefPath.startsWith("\\\\")) return null;

  // Check extension
  const extMatch = hrefPath.match(/\.[^./\\]+$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : "";
  if (!INTERNAL_LINK_EXTS.has(ext)) return null;

  // Get directory of current file (convert forward slashes in href to platform sep)
  const dirParts = currentFilePath.split(sep);
  dirParts.pop(); // remove filename
  // No directory to resolve against (a `currentFilePath` with no separator).
  if (dirParts.length === 0) return null;

  // Normalize the href to use the platform separator
  const hrefNormalized = hrefPath.replace(/\//g, sep);
  const hrefParts = hrefNormalized.split(sep);

  // Merge directory + relative parts, resolving . and ..
  const resultParts = [...dirParts];
  for (const part of hrefParts) {
    if (part === "..") {
      if (resultParts.length > 0) resultParts.pop();
    } else if (part !== ".") {
      resultParts.push(part);
    }
  }

  // CONTAINMENT: `..` must not escape the current file's root. On Windows
  // `dirParts[0]` is the drive (`C:`); on POSIX it is the empty string left by
  // the leading `/`, so the same comparison catches `../../../../etc/passwd`
  // escaping above `/`.
  if (resultParts.length === 0 || resultParts[0] !== dirParts[0]) return null;

  // Belt-and-braces UNC reject, independent of the containment check above.
  const joined = resultParts.join(sep);
  if (joined.startsWith("\\\\") || joined.startsWith("//")) return null;

  return joined;
}
