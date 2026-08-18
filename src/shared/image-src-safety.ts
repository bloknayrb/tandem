// Image-`src` allowlist shared between markdown-PASTE sanitization
// (`src/client/editor/utils/url-safety.ts`) and file-IMPORT sanitization
// (`src/server/file-io/mdast-ydoc.ts`, `src/server/file-io/docx-html.ts`).
//
// A hostile `src` reaches the exact same DOM sink whether it arrived by paste
// or by opening a `.md`/`.docx`/`.html` file: an `<img>` fetches on render,
// with no click, cross-host if the string names one. File-open is Tandem's
// dominant "documents are untrusted content" surface (#1420) — a copy of
// this allowlist living only in the client would leave that surface covered
// solely by the `img-src` CSP in `index.html`, rather than by the two
// independent layers the paste path gets. One definition, used by both.
//
// Design: ALLOWLIST, not blocklist — see `url-safety.ts`'s file header for
// the full rationale (a new attacker-friendly scheme is rejected by default;
// blocklists are the recurring source of url-sanitization CVEs).

/**
 * Characters that make a `src` unsafe to reason about as a plain string,
 * checked ANYWHERE in the string, not just as a prefix. Mirrors the set
 * `url-safety.ts` uses for hrefs — DOMPurify's URL-whitespace set plus a
 * bare backslash, since browsers map `\\` to `/` inside a URL, so
 * `/\\evil.com/x.png` and `\\\\evil.com\\x.png` resolve cross-host exactly
 * like `//evil.com/x.png` does.
 */
export const URL_HOSTILE_CHARS = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000\\]/;

const SCHEME_STOP_CHARS = /[/#?]/;

/**
 * True when `trimmed` has a URI scheme prefix — a `:` appearing before any of
 * `/`, `#`, or `?` (a colon appearing only after one of those, e.g. inside a
 * filename or query string, is path-like, not a scheme).
 */
export function hasSchemePrefix(trimmed: string): boolean {
  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) return false;
  const firstPathSep = trimmed.search(SCHEME_STOP_CHARS);
  return firstPathSep === -1 || firstPathSep > firstColon;
}

/**
 * Image-src prefixes safe to use directly. `//` (protocol-relative) is
 * deliberately excluded — it's an external fetch, not a path, and no
 * legitimate document (pasted or imported) hand-writes one.
 */
export const SAFE_IMAGE_PREFIXES = ["http://", "https://", "ftp://"] as const;

/**
 * `data:` image subtypes allowed: boundable raster formats commonly emitted
 * by `.docx` image embeds and web copy/paste. `svg+xml` is deliberately
 * excluded — inline SVG can carry a `<script>` tag or an event-handler
 * attribute (`onload=`, etc.) that executes in the editor's DOM, unlike the
 * raster formats below, which are inert pixel data.
 */
const SAFE_IMAGE_DATA_URI = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i;

/**
 * Max length of a `data:` image URI (base64 text, not decoded bytes). ~5MB
 * of decoded image data, base64's ~4/3 expansion. Defense-in-depth against a
 * single paste/import bloating the shared Y.Doc for every collaborator on
 * next sync.
 */
const MAX_DATA_URI_LENGTH = 7_000_000;

/**
 * Sanitize an image `src` before it is written into the Y.Doc, whether that
 * write comes from a markdown paste or from parsing an opened `.md`/`.docx`/
 * `.html` file. Returns the trimmed src when safe, or `null` when it should
 * be dropped (callers downgrade to plain alt text rather than rendering it).
 *
 * Safe inputs (returns trimmed src):
 *   - any {@link SAFE_IMAGE_PREFIXES} match (case-insensitive)
 *   - in-page fragments: `#section`
 *   - relative / root-relative paths: `./img.png`, `../img.png`, `/img.png`
 *   - `data:image/(png|jpeg|jpg|gif|webp);base64,...` up to {@link MAX_DATA_URI_LENGTH}
 *
 * Unsafe inputs (returns null):
 *   - any string containing a {@link URL_HOSTILE_CHARS} character (control
 *     chars, exotic whitespace, or a backslash anywhere) — catches
 *     scheme-less/backslash cross-host spellings that carry no `:` and would
 *     otherwise fall through the final scheme-less pass-through as "safe"
 *   - a leading `//` (protocol-relative)
 *   - `data:image/svg+xml...` and any other `data:` subtype
 *   - a `data:image/...;base64,` URI longer than {@link MAX_DATA_URI_LENGTH}
 *   - any other unknown scheme: `javascript:`, `vbscript:`, `file:`, etc.
 */
export function sanitizeImageSrc(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (URL_HOSTILE_CHARS.test(trimmed)) return null;
  if (trimmed.startsWith("//")) return null;

  if (SAFE_IMAGE_DATA_URI.test(trimmed)) {
    return trimmed.length <= MAX_DATA_URI_LENGTH ? trimmed : null;
  }
  // Any other `data:` URI (including `data:image/svg+xml`) falls through to
  // the "unknown scheme" branch below and is rejected.

  const lower = trimmed.toLowerCase();
  if (SAFE_IMAGE_PREFIXES.some((p) => lower.startsWith(p))) return trimmed;

  if (trimmed.startsWith("#")) return trimmed;

  if (!hasSchemePrefix(trimmed)) return trimmed;

  // Has a scheme prefix that isn't allowlisted (or is `data:` with a
  // non-allowlisted subtype) -> drop.
  return null;
}
