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
 * True when `trimmed` has a URI scheme prefix — a `:` appearing before any of
 * `/`, `#`, or `?` (a colon appearing only after one of those, e.g. inside a
 * filename or query string, is path-like, not a scheme). Shared detection
 * mechanic for `sanitizeHrefForPaste`, `sanitizeImageSrcForPaste` and
 * {@link isSchemelessPathHref}.
 *
 * The first two pair this helper with their own separate allowlist
 * (`SAFE_EXTERNAL_PREFIXES` / `SAFE_IMAGE_PREFIXES`), so for THEM a change here
 * can only ever affect what counts as "has a scheme", never which schemes are
 * safe. That warranty does NOT extend to the third consumer:
 * {@link isSchemelessPathHref} is `!hasSchemePrefix(...)` and nothing else,
 * with no allowlist of its own, so a change here now also moves the
 * RENDER-TIME boundary — which hrefs the editor will emit as an `href`
 * attribute at all.
 *
 * Consequence: separator-set changes belong in the CALLER, never here. Adding
 * `\` to the separator list below to make backslash forms path-like would
 * silently move `sanitizeHrefForPaste` and `sanitizeImageSrcForPaste` too —
 * exactly the drift this file's header warns about. {@link isSchemelessPathHref}
 * handles backslash itself, by rejecting it outright.
 */
const SCHEME_STOP_CHARS = /[/#?]/;

function hasSchemePrefix(trimmed: string): boolean {
  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) return false;
  const firstPathSep = trimmed.search(SCHEME_STOP_CHARS);
  return firstPathSep === -1 || firstPathSep > firstColon;
}

/**
 * Characters that make an href unsafe to reason about as a plain string.
 *
 * The leading run mirrors DOMPurify's URL-whitespace set, copied verbatim from
 * `@tiptap/extension-link/dist/index.js:7` — that module strips these before
 * matching its scheme regex, and browsers strip a subset of them before
 * parsing. The trailing `\\` is ours: a backslash is not whitespace, but
 * browsers map it to `/` inside a URL, so it reinterprets structure just as
 * badly.
 *
 * Applied by {@link isSchemelessPathHref} and, since #1420, by
 * {@link sanitizeImageSrcForPaste}. Still deliberately NOT applied to
 * {@link sanitizeHrefForPaste}, and NOT because that one is already covered:
 * it ends in a bare `if (!hasSchemePrefix(trimmed)) return trimmed`, and its
 * allowlist gates only SCHEME-BEARING strings, so for exactly the class this
 * set exists to catch it is a pass-through. Measured: it returns
 * `<NUL>//evil.com/x.png` unchanged.
 *
 * That remains acceptable for links **only because of a downstream gate that
 * has no image equivalent** — `openHref` re-runs every href through
 * `isSafeExternalHref` or `resolveRelativeLink`'s fail-closed segment walk
 * before anything is opened. An image has no such second chance: its `src`
 * reaches the DOM as written and the browser fetches it on render, with no
 * click. That asymmetry is why this set now applies to the image sanitizer and
 * still does not apply to the href one.
 *
 * The image `src` sink has a second, independent control since #1420: the
 * `img-src 'self' data: blob:` CSP in `index.html`, mirroring the one
 * `src-tauri/tauri.conf.json` already shipped. The CSP is the control that
 * stops the fetch; this set stops a hostile string being stored as though it
 * had been vetted. Neither makes the other redundant — the CSP does not apply
 * to what gets written into the document, and an allowlist does not stop a
 * plain `https://` tracking pixel.
 */
const URL_HOSTILE_CHARS = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000\\]/;

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
 * Detection rule for "has a scheme": see {@link hasSchemePrefix}. A leading
 * `:` (degenerate) is also unsafe. Whitespace is trimmed before evaluation so
 * `   javascript:alert(1)` is recognized.
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
 * Image-src prefixes safe to paste directly. Mirrors {@link SAFE_EXTERNAL_PREFIXES}
 * minus `mailto:` — a valid link target, but never a valid image source.
 */
// `//` was removed in #1420: protocol-relative is an external fetch with no
// authoring use in a local document, and allowlisting it made the one hostile
// spelling a *permitted* one. Its removal is necessary and not sufficient —
// the colon-free backslash forms never reached this list at all. See the
// guards at the top of `sanitizeImageSrcForPaste`.
export const SAFE_IMAGE_PREFIXES = ["http://", "https://", "ftp://"] as const;

/**
 * `data:` image subtypes allowed as pasted image sources: boundable raster
 * formats commonly emitted by `.docx` image embeds and web copy/paste.
 * `svg+xml` is deliberately excluded — inline SVG can carry a `<script>` tag
 * or an event-handler attribute (`onload=`, etc.) that executes in the
 * editor's DOM, unlike the raster formats below, which are inert pixel data.
 */
const SAFE_IMAGE_DATA_URI = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i;

/**
 * Max length of a pasted `data:` image URI (base64 text, not decoded bytes).
 * ~5MB of decoded image data, base64's ~4/3 expansion. Defense-in-depth
 * against a single paste bloating the shared Y.Doc for every collaborator on
 * next sync — mirrors the size-cap convention used elsewhere for paste-time
 * inputs (see `word-diff.ts`'s `MAX_COMBINED_LENGTH`, `fuzzy-match.ts`'s
 * `MAX_TARGET_LENGTH`).
 */
const MAX_DATA_URI_LENGTH = 7_000_000;

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
 *   - `data:image/(png|jpeg|jpg|gif|webp);base64,...` up to {@link MAX_DATA_URI_LENGTH}
 *
 * Unsafe inputs (returns null):
 *   - `data:image/svg+xml...` and any other `data:` subtype
 *   - a `data:image/...;base64,` URI longer than {@link MAX_DATA_URI_LENGTH}
 *   - any other unknown scheme: `javascript:`, `vbscript:`, `file:`, etc.
 *
 * Scheme detection shares {@link hasSchemePrefix} with `sanitizeHrefForPaste`;
 * the link and image ALLOWLISTS stay fully separate policy, so a scheme
 * newly accepted (or rejected) for links never silently changes what's
 * accepted for images, or vice versa.
 */
export function sanitizeImageSrcForPaste(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // **The final `return trimmed` below is a scheme-less pass-through, and on its
  // own it was the hole (#1420).** `hasSchemePrefix` is a colon test, so every
  // cross-host spelling that carries no colon walked straight out of it as
  // "safe": `/\evil.com/x.png`, `\\evil.com\x.png`, `\/evil.com/x.png` and a
  // control-character-prefixed `//evil.com/x.png`. Browsers map `\` to `/`
  // inside a URL, so all of them resolve cross-host.
  //
  // Removing `//` from SAFE_IMAGE_PREFIXES alone does NOT close that class — it
  // only closes the one spelling that was explicitly allowlisted. These two
  // guards are what closes it, and they are deliberately the same pair
  // `isSchemelessPathHref` applies, in the same order, so the render-time href
  // boundary and the paste-time image boundary cannot drift apart. The file
  // header's warning about `URL_HOSTILE_CHARS` NOT being applied here described
  // exactly this gap; it is applied now, and the header says so.
  if (URL_HOSTILE_CHARS.test(trimmed)) return null;
  // Protocol-relative is an EXTERNAL fetch, not a path — same reasoning as
  // hrefs, and nobody hand-writes `//host/x.png` in a local document.
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
  // non-allowlisted subtype) → drop.
  return null;
}
