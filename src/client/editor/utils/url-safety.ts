// URL-safety helpers shared between the editor's click-time anchor intercept
// and the markdown-paste link sanitizer. Both surfaces must agree on which
// hrefs are safe; drifting copies would silently widen the XSS trust surface.
//
// Design: ALLOWLIST, not blocklist. A new attacker-friendly scheme appearing
// in the wild (e.g. `filesystem:`, `view-source:`) is rejected by default.
// Blocklists are the recurring source of url-sanitization CVEs.
//
// Image-`src` sanitization (`SAFE_IMAGE_PREFIXES`, `sanitizeImageSrcForPaste`,
// and the `hasSchemePrefix`/`URL_HOSTILE_CHARS` primitives this file and that
// one both need) lives in `src/shared/image-src-safety.ts` and is imported
// below rather than redefined here. File-IMPORT (`mdast-ydoc.ts`,
// `docx-html.ts`) needs the identical allowlist server-side — a copy living
// only in this client-only file would leave that surface covered solely by
// the `img-src` CSP in `index.html`, instead of by both layers the way paste
// is (#1420).

import {
  hasSchemePrefix,
  SAFE_IMAGE_PREFIXES,
  sanitizeImageSrc,
  URL_HOSTILE_CHARS,
} from "../../../shared/image-src-safety";

export { SAFE_IMAGE_PREFIXES };

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
 * True when `raw` is a scheme-less path reference — something the editor may
 * safely emit as an `href` attribute even though it names no protocol.
 *
 * This answers the RENDER-TIME question ("may this href be emitted at all"),
 * which is a different question from {@link isSafeExternalHref}'s ("may we
 * hand this to `window.open`") and from {@link sanitizeHrefForPaste}'s ("may
 * this survive a markdown paste"). It exists so `@tiptap/extension-link`'s
 * default URL guard can be WIDENED rather than replaced — see the
 * `isAllowedUri` union in `editor-extensions.ts` (#1377).
 *
 * **Fail-closed by design.** Any character a browser strips or reinterprets is
 * a rejection, never a normalization. That asymmetry IS the safety argument:
 * rejecting can only ever return `false`, so this predicate can never widen the
 * union past Tiptap's `defaultValidate`, whereas a normalizer would have to be
 * *provably identical* to the browser's own stripping to be safe. Worked
 * counterexamples, all measured:
 *   - `java<TAB>script:alert(1)` — browsers strip TAB, so this IS `javascript:`.
 *   - `<NUL>//evil.com` — resolves to `http://evil.com/`, and JS `trim()` does
 *     NOT strip U+0000. That is precisely why there is no `trim()` here.
 *
 * **A caution about reading those rows as protections.** The consumer is
 * `defaultValidate(url) || isSchemelessPathHref(url)`, so a rejection here only
 * matters when `defaultValidate` also rejects. It does not for `/\evil.com/x.md`
 * (leading `/` hits its `[^a-z]` alternative), so that href renders regardless
 * of what this predicate says — the rejection is real but INERT at the union.
 * `\\evil.com\share\x.md` is the same story. Both resolve cross-host under
 * `new URL()`; neither is newly reachable because of this file, and neither is
 * closed by it.
 *
 * **The `//` exclusion is separate and non-obvious.** `hasSchemePrefix("//x")`
 * is false (no colon before the first `/`), so protocol-relative hrefs would
 * otherwise be misclassified as paths — they are EXTERNAL navigations.
 *
 * **Why this is safe as an allowlist widener:** with hostile characters already
 * rejected, a `/`, `#` or `?` before the first `:` means WHATWG scheme parsing
 * (`ALPHA *(ALPHA / DIGIT / "+" / "-" / ".") ":"`) cannot succeed, so the href
 * is relative *as far as the URL parser is concerned*. That is NOT the same as
 * "safe for Tandem's own consumer": clicking such a link runs
 * `resolveRelativeLink` (`./relative-link.ts`), which is a segment walk rather
 * than a URL parser. The traversal question is answered there, not here.
 */
export function isSchemelessPathHref(raw: string | null | undefined): boolean {
  if (!raw) return false;
  // Fail closed: no trimming, no normalizing — see the doc comment above.
  if (URL_HOSTILE_CHARS.test(raw)) return false;
  // Protocol-relative is an EXTERNAL navigation, not a path.
  if (raw.startsWith("//")) return false;
  return !hasSchemePrefix(raw);
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
 * Detection rule for "has a scheme": see {@link hasSchemePrefix} (in
 * `src/shared/image-src-safety.ts`). A leading `:` (degenerate) is also
 * unsafe. Whitespace is trimmed before evaluation so `   javascript:alert(1)`
 * is recognized.
 *
 * Deliberately does NOT apply {@link URL_HOSTILE_CHARS} — this function ends
 * in a bare `if (!hasSchemePrefix(trimmed)) return trimmed`, so for a
 * scheme-less hostile spelling it's a pass-through regardless. That remains
 * acceptable for links only because of a downstream gate images don't have:
 * `openHref` re-runs every href through `isSafeExternalHref` or
 * `resolveRelativeLink`'s fail-closed segment walk before anything is opened.
 * See {@link sanitizeImageSrcForPaste}'s doc comment for why images can't
 * rely on that same second chance.
 */
export function sanitizeHrefForPaste(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Allowlisted external schemes.
  if (isSafeExternalHref(trimmed)) return trimmed;

  // Fragment-only link.
  if (trimmed.startsWith("#")) return trimmed;

  // Relative or root-absolute path: no scheme prefix ahead of the first
  // path/query/fragment separator.
  if (!hasSchemePrefix(trimmed)) return trimmed;

  // Has a scheme prefix that isn't allowlisted → drop.
  return null;
}

/**
 * Sanitize an image `src` encountered at MARKDOWN PASTE time. Returns the
 * trimmed src when safe, or `null` when it should be dropped (caller
 * downgrades the image to plain alt text rather than rendering it — see
 * markdown-paste.ts's `normalizeImagesForPaste`).
 *
 * Re-exported from `src/shared/image-src-safety.ts`'s `sanitizeImageSrc` —
 * see that file for the full safe/unsafe input contract and the `#1420`
 * rationale for applying {@link URL_HOSTILE_CHARS} here (an image `src` has
 * no click-time second chance the way a link href does via `openHref`, so
 * this function can't rely on a downstream gate the way
 * {@link sanitizeHrefForPaste} does). Aliased rather than redefined so
 * paste-time and file-import-time sanitization can never drift apart.
 */
export const sanitizeImageSrcForPaste = sanitizeImageSrc;
