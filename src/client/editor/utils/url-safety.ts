// URL-safety helpers shared between the editor's click-time anchor intercept
// and the markdown-paste link sanitizer. Both surfaces must agree on which
// hrefs are safe; drifting copies would silently widen the XSS trust surface.
//
// Design: ALLOWLIST, not blocklist. A new attacker-friendly scheme appearing
// in the wild (e.g. `filesystem:`, `view-source:`) is rejected by default.
// Blocklists are the recurring source of url-sanitization CVEs.

/**
 * External hrefs we'll hand off to the system browser via `window.open`.
 * Anything not matching one of these prefixes AND not a relative path/fragment
 * (see {@link isSafeHrefForPaste}) is considered unsafe.
 *
 *   - `http://` / `https://` — standard web URLs.
 *   - `mailto:` — email composer.
 *   - `ftp://` — legacy but harmless to navigate.
 *   - `//` — protocol-relative; browsers expand to the page's scheme.
 *     Safe in the Tauri/Vite app where the page scheme is always http(s)
 *     or tauri://.
 *
 * Explicitly NOT allowed: `javascript:`, `data:`, `vbscript:`, `file:`,
 * `blob:`, `filesystem:`, `view-source:`, any future XSS-relevant scheme.
 */
export const SAFE_EXTERNAL_PREFIXES = ["http://", "https://", "mailto:", "ftp://", "//"] as const;

/**
 * True if `href` is safe to hand to `window.open` from the editor's anchor
 * intercept. Case-insensitive scheme match (CommonMark allows `HTTPS://`).
 *
 * This is the click-time check — the user has clicked an anchor, and we have
 * to decide whether to navigate. It does NOT cover relative paths or
 * fragments; those are handled by the caller before reaching this check.
 */
export function isSafeExternalHref(href: string): boolean {
  const lower = href.toLowerCase();
  return SAFE_EXTERNAL_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Sanitize an href encountered at MARKDOWN PASTE time. Returns the trimmed
 * href when safe, or `null` when it should be dropped.
 *
 * Safe inputs (returns trimmed href):
 *   - any {@link SAFE_EXTERNAL_PREFIXES} match (case-insensitive)
 *   - in-page fragments: `#section`
 *   - relative paths: `./other.md`, `../other.md`, `subdir/file.md`
 *   - root-relative paths: `/abs/path.md`
 *
 * Unsafe inputs (returns null):
 *   - any unknown scheme: `javascript:`, `data:`, `vbscript:`, `file:`, etc.
 *
 * Detection rule for "has a scheme": there's a `:` BEFORE any `/`, `#`, or
 * `?`. A leading `:` (degenerate) is also unsafe. Whitespace is trimmed
 * before evaluation so `   javascript:alert(1)` is recognized.
 */
export function sanitizeHrefForPaste(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Allowlisted external schemes.
  if (isSafeExternalHref(trimmed)) return trimmed;

  // Fragment-only link.
  if (trimmed.startsWith("#")) return trimmed;

  // Relative or root-absolute path: no scheme delimiter ahead of the first
  // path/query/fragment separator. If `:` appears AFTER `/`/`#`/`?` (e.g.
  // a literal `:` inside a filename or query string), the prefix is path-like.
  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) return trimmed; // no colon → relative/root path
  const firstPathSep = Math.min(
    ...["/", "#", "?"].map((ch) => trimmed.indexOf(ch)).filter((idx) => idx !== -1),
  );
  if (Number.isFinite(firstPathSep) && firstPathSep < firstColon) return trimmed;

  // Has a scheme prefix that isn't allowlisted → drop.
  return null;
}
