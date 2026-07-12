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

/**
 * Image-src prefixes safe to paste directly. Mirrors {@link SAFE_EXTERNAL_PREFIXES}
 * minus `mailto:` — a valid link target, but never a valid image source.
 */
export const SAFE_IMAGE_PREFIXES = ["http://", "https://", "ftp://", "//"] as const;

/**
 * `data:` image subtypes allowed as pasted image sources: boundable raster
 * formats commonly emitted by `.docx` image embeds and web copy/paste.
 * `svg+xml` is deliberately excluded — inline SVG can carry a `<script>` tag
 * or an event-handler attribute (`onload=`, etc.) that executes in the
 * editor's DOM, unlike the raster formats below, which are inert pixel data.
 */
const SAFE_IMAGE_DATA_URI = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i;

/**
 * Sanitize an image `src` encountered at MARKDOWN PASTE time. Returns the
 * trimmed src when safe, or `null` when it should be dropped (caller
 * downgrades the image to plain alt text rather than rendering it — see
 * markdown-paste.ts's `normalizeImagesForPaste`).
 *
 * Safe inputs (returns trimmed src):
 *   - any {@link SAFE_IMAGE_PREFIXES} match (case-insensitive)
 *   - in-page fragments: `#section`
 *   - relative / root-relative paths: `./img.png`, `../img.png`, `/img.png`
 *   - `data:image/(png|jpeg|jpg|gif|webp);base64,...`
 *
 * Unsafe inputs (returns null):
 *   - `data:image/svg+xml...` and any other `data:` subtype
 *   - any other unknown scheme: `javascript:`, `vbscript:`, `file:`, etc.
 *
 * Scheme detection mirrors {@link sanitizeHrefForPaste} (a `:` before any
 * `/`, `#`, or `?` means "has a scheme"), duplicated rather than shared so
 * the link and image allowlists can diverge independently — one edit here
 * can never silently change what links are considered safe, or vice versa.
 */
export function sanitizeImageSrcForPaste(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (SAFE_IMAGE_DATA_URI.test(trimmed)) return trimmed;
  // Any other `data:` URI (including `data:image/svg+xml`) falls through to
  // the "unknown scheme" branch below and is rejected.

  const lower = trimmed.toLowerCase();
  if (SAFE_IMAGE_PREFIXES.some((p) => lower.startsWith(p))) return trimmed;

  if (trimmed.startsWith("#")) return trimmed;

  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) return trimmed; // no colon → relative/root path
  const seps = ["/", "#", "?"].map((ch) => trimmed.indexOf(ch)).filter((idx) => idx !== -1);
  const firstPathSep = seps.length ? Math.min(...seps) : Number.POSITIVE_INFINITY;
  if (firstPathSep < firstColon) return trimmed; // colon after path sep → not a scheme

  // Has a scheme prefix that isn't allowlisted (or is `data:` with a
  // non-allowlisted subtype) → drop.
  return null;
}
