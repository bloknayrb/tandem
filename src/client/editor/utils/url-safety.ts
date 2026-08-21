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
import { rejectUnsafeWindowsPrefix } from "../../../shared/windows-path-safety";

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
 * C0 control characters and DEL, checked ANYWHERE in an href.
 *
 * **Deliberately narrower than {@link URL_HOSTILE_CHARS}, which must not be
 * reused here.** That set includes U+0020 and the exotic-whitespace range, and
 * {@link isRenderableLinkHref} vetoes *every* href including allowlisted
 * external ones — so reusing it would blank `https://example.com/a b.md`, which
 * both `[x](<a b.md>)` and `.docx` hyperlink import legitimately produce
 * (measured). A space is hostile only as a PREFIX, never in the middle, and the
 * prefix case is handled by the `trimStart` comparison rather than by this set.
 */
const URL_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * The URL-spec "special" schemes Tandem treats as external. These are parsed
 * AUTHORITY-LENIENTLY: everything after the colon up to the first non-slash is
 * slash-insensitive, so `http:/\evil.com/x` and even `https:/evil.com/x`
 * resolve to a cross-host authority. `ftp:` is here because it is in
 * {@link SAFE_EXTERNAL_PREFIXES}; `file:` is special too but is refused by
 * Tiptap's scheme allowlist and never reaches this predicate.
 */
const SPECIAL_EXTERNAL_SCHEME = /^(?:https?|ftp):/i;

/**
 * RENDER-TIME VETO: may this href be emitted as a live `href` attribute at all?
 *
 * This is the one NARROWING term of the `isAllowedUri` union in
 * `editor-extensions.ts` (#1420). Everything else in that expression widens;
 * without a term that can subtract, Tiptap's `defaultValidate` accepting a
 * leading `/` without looking at what follows means every cross-host spelling
 * below inherits acceptance and renders as a live link.
 *
 * Refuses, in order:
 *
 *  1. **Any leading whitespace.** The WHATWG URL parser strips leading C0-and-
 *     space before resolving, and {@link isSafeExternalHref} does NOT trim — so
 *     `" //evil.com/x"` is an EXTERNAL navigation to the browser and a
 *     document-relative path to the click gate. This refuses the disagreement
 *     rather than picking a side. It is also what makes step 3 sound at all:
 *     `rejectUnsafeWindowsPrefix` is anchored at index 0, so a single leading
 *     space would otherwise walk straight past it while `defaultValidate` still
 *     returned true (measured: `" /\evil.com/x.md"` resolves to
 *     `http://evil.com/x.md`). That spelling is reachable from FILE IMPORT, not
 *     just paste — remark preserves the space inside a pointy-bracket
 *     destination (`[x](< /\evil.com/x.md>)`) and `mdast-ydoc.ts` writes
 *     `href: node.url` verbatim.
 *  2. **C0 controls / DEL anywhere** — see {@link URL_CONTROL_CHARS}. JS
 *     `trim()` does not strip U+0000 but the URL parser does, so `<NUL>//evil.com`
 *     resolves cross-host.
 *  3. **A special-scheme href in any spelling `isSafeExternalHref` does not
 *     recognise.** A scheme moves the authority PAST index 0, and
 *     `rejectUnsafeWindowsPrefix` is anchored there — it slices `[0,8)` and sees
 *     `"http:\\e"`, which passes. So `http:/\evil.com/x` and `https:/evil.com/x`
 *     both resolved cross-host while rendering live. The narrow rule is
 *     RENDER/CLICK AGREEMENT: `isSafeExternalHref` is a literal `"http://"`
 *     prefix test, so for these spellings it says *false*, which means
 *     `LinkWithHoverTitle` strips `target="_blank"` and the click gate treats
 *     the href as a document-relative path. A live anchor the two halves
 *     disagree about is exactly the #1343 shape: with no `_blank`, a
 *     middle-click that escapes `preventDefault` navigates the EDITOR FRAME to
 *     the attacker host rather than opening a second tab.
 *  4. **Backslash-bearing authority prefixes** — `/\host`, `\/host`, `\\host`,
 *     `\\?\…`. Delegated to `rejectUnsafeWindowsPrefix`, the canonical copy of
 *     that rule, rather than re-spelled here (see
 *     `tests/shared/unc-check-duplication.test.ts`).
 *
 * **`//` is deliberately ACCEPTED**, in its exact untrimmed spelling only. It is
 * a fourth cross-host form, and carving it out is what makes the sentence "this
 * veto blanks exactly the prefixes `resolveRelativeLink` refuses" true — say
 * that out loud when auditing. It stays live because it is in
 * {@link SAFE_EXTERNAL_PREFIXES}: `openHref` hands it to `window.open` exactly
 * like an `https://` URL, so it is a *declared* external link rather than a
 * relative-looking disguise.
 *
 * **What this does NOT do.** It is a prefix-class veto, not a render/click
 * unification — that is impossible here because `resolveRelativeLink` needs
 * `currentFilePath`, which the mark renderer does not have. An href like
 * `../../../../..///evil.com/share/x.md` still renders live and is still refused
 * at click time. **It does not judge SCHEMES beyond the special-external family
 * in clause 3**, and that is a real, tracked gap rather than a tidy division of
 * labour: Tiptap's `defaultValidate` fallback alternative matches a hyphen, so
 * `ms-msdt:`, `search-ms:`, `ms-appinstaller:`, `itms-services:` and friends
 * satisfy the `||` and render live with the href verbatim. That gap is closed
 * by {@link isRenderableLinkScheme} (#1537), which is ANDed alongside this
 * predicate at the `isAllowedUri` site rather than folded into it — the two
 * refuse different things and neither covers the other. In particular a single
 * leading space makes the scheme predicate see a schemeless href (its WHATWG
 * test is anchored), so `" ms-msdt:/id"` is refused HERE, by clause 1, and not
 * there; while bare `ms-msdt:/id` carries no special scheme and no Windows
 * prefix, so it passes this predicate and is refused only there.
 * It also does not cover bidi overrides (U+202A–U+202E), which
 * can make the hover `title` read as a different host than the anchor resolves
 * to; navigation is unaffected (those resolve same-origin, percent-encoded), so
 * that is tooltip spoofing and is tracked as residue, not fixed here.
 *
 * **Behaviour delta worth knowing:** a Word hyperlink to
 * `\\fileserver\docs\spec.docx` used to render live and produce an explicit
 * "Blocked a link pointing outside this document's folder" notification on
 * click. It now renders as plain text with no href, so the refusal is silent.
 * The security outcome is strictly better; the explanation is what is lost.
 */
export function isRenderableLinkHref(raw: string | null | undefined): boolean {
  if (!raw) return false;
  if (raw !== raw.trimStart()) return false;
  if (URL_CONTROL_CHARS.test(raw)) return false;
  if (raw.startsWith("//")) return true;
  if (SPECIAL_EXTERNAL_SCHEME.test(raw)) return isSafeExternalHref(raw);
  return rejectUnsafeWindowsPrefix(raw) === null;
}

/**
 * A WHATWG-URL scheme prefix: `ALPHA *(ALPHA / DIGIT / "+" / "-" / ".") ":"`,
 * anchored at the start. This is the *parser's* grammar, transcribed — not an
 * approximation of it (#1537).
 *
 * **Why not {@link hasSchemePrefix}.** That helper answers a deliberately
 * looser question ("is there a `:` before the first `/`, `#` or `?`"), which is
 * right for the image-src allowlist it lives beside but wrong here: it calls
 * `2024:plan.md`, `.hidden:note.md`, `12:30 notes.md` and `user@host:x` scheme-
 * bearing, and none of them is. A browser cannot parse any of those as a scheme
 * (a leading digit or `.` fails the scheme-start state; `_`, `@` and a space
 * fail the scheme state), so it resolves each as an ordinary RELATIVE path —
 * and Tandem opened them: `openHref` -> `resolveRelativeLink` -> `{ok:true}` ->
 * `openServerPath`. A 300k-case differential found 397 distinct spellings in
 * that class. Refusing to render them would violate the very rule this change
 * enforces ("only render as a link if it works as a link"), in the other
 * direction. So the scheme test has to BE the scheme grammar.
 *
 * Written as a regex LITERAL, with the `-` in final position so it is literal
 * without an escape. That is not stylistic: the bug this file exists to fix is
 * a `\-` inside a TEMPLATE literal collapsing to a bare `-` and turning the
 * neighbouring characters into a range. Never move this into a `new RegExp`
 * string or a template literal.
 */
const WHATWG_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/**
 * RENDER-TIME SCHEME ALLOWLIST: does this href name a scheme we are willing to
 * emit as a live `href` attribute at all? (#1537)
 *
 * This is the NARROWING term of the `isAllowedUri` union in
 * `editor-extensions.ts`. Everything else in that expression widens, and the
 * widest operand is Tiptap's `defaultValidate` — which accepts **any scheme
 * whose body contains a character outside `[a-z+./0-9:]`**, hyphen included.
 * Measured against the real dependency, not re-derived: `ms-msdt:/id`,
 * `ms-appinstaller:?source=…`, `search-ms:crumb=location:\\evil.com\share`,
 * `ms-officecmd:x`, `view-source:http://evil` and `itms-services://?url=…` all
 * satisfy it, so the `||` short-circuited and each rendered as a live anchor
 * with the href verbatim. `search-ms:` is an NTLM/WebDAV-share spelling
 * reaching the OS from a right-click "Open link in new tab" — the class
 * `rejectUnsafeWindowsPrefix` exists to prevent.
 *
 * **The mechanism is not "hyphenated schemes".** `[a-z0-9+.-]+` is followed by
 * a negated class that a template-literal escape collapse turned into a RANGE
 * (`[^a-z+.-:]`, where `.-:` is U+002E–U+003A), so the hyphen fell out of the
 * negated set. Note what else that range swallows: `/` and the digits are
 * inside it too, which is why `example.com/path` and `ms2:x` are rejected by
 * `defaultValidate` — the `/` exclusion is the behaviour #1377 rests on. Any
 * terminator outside `[a-z+./0-9:]` works: `ms_msdt:x` and `user@host:x` are
 * accepted by `defaultValidate` as well, while `coap+tcp:x`, `a.b:c`, `x+y:z`
 * and `ms2:x` are rejected by it. Only `-` is a legal URL scheme character, so
 * hyphens are the exploitable subset — but do not write the rule down as being
 * about hyphens.
 *
 * **The bar, and it is a product decision, not a security heuristic: only
 * render as a link if it WORKS as a link.** Every surviving prefix in
 * {@link SAFE_EXTERNAL_PREFIXES} is traced to a real action in `openHref`
 * (`Editor.svelte`) — `isSafeExternalHref` returns true for it, so it takes
 * the `window.open` branch. That includes `mailto:`, which is in the
 * allowlist and therefore never reaches `resolveRelativeLink`. The schemes
 * Tiptap allowlists but Tandem does not — `tel:`, `sms:`, `callto:`, `cid:`,
 * `xmpp:`, `ftps:` — take the other branch and die in `resolveRelativeLink`
 * with `unsupported-ext`, which `notifyLinkProblem` surfaces as a visible
 * warning. They were **already broken on click, with a visible refusal**;
 * dropping the render closes a link that never worked. That is the whole
 * behaviour change, and it is not a security fix for those six. The AUTHORING
 * half is not silent either: `applyLink` (`toolbar/handlers.ts`) now reports
 * the refusal through the same notification channel, because `setLink` returns
 * `false` for a href this predicate rejects.
 *
 * **The rule cuts both ways, and clause 2 is sized for that.** See
 * {@link WHATWG_SCHEME_PREFIX}: a href that no URL parser reads as
 * scheme-bearing is a relative path that DID open, so refusing to render it
 * would break the same rule from the other side.
 *
 * Three clauses:
 *
 *  1. **`//` is accepted.** Behaviourally REDUNDANT with the scheme branch —
 *     `//x` cannot match {@link WHATWG_SCHEME_PREFIX} (it starts with `/`), so
 *     the fall-through would return `true` anyway, and removing this line
 *     changes no row in the measured corpus. Kept so the `//` case is decided
 *     explicitly rather than by accident of clause ordering. It is in
 *     {@link SAFE_EXTERNAL_PREFIXES} and `openHref` hands it to `window.open`
 *     like any `https://` URL. **Kept under "reaches `window.open`", not under
 *     "demonstrably works":** a protocol-relative href expands against the PAGE
 *     scheme, and on Linux the Tauri WebView origin is `tauri://localhost`, so
 *     `//example.com/x` becomes `tauri://example.com/x` there. Flagged for a
 *     product decision rather than dropped here — see the PR body.
 *  2. **A scheme-bearing href must be in {@link SAFE_EXTERNAL_PREFIXES}**,
 *     where "scheme-bearing" means {@link WHATWG_SCHEME_PREFIX} matches — the
 *     URL parser's own grammar, so this function and the browser agree on what
 *     "schemeless" means. This is the allowlist posture this file's header
 *     already claimed to follow. It also subsumes what the `http:/\evil.com/x`
 *     family needed: a lenient-authority spelling of a special scheme is not a
 *     literal `"http://"` prefix, so it is refused here. `ftp://` survives it
 *     and is likewise kept under "reaches `window.open`" — Chromium removed FTP
 *     support in v88, so the host does nothing with it. Also flagged, not
 *     dropped.
 *  3. **Schemeless falls through as `true`.** This predicate answers the SCHEME
 *     question only. Whether a schemeless href is safe is answered by the
 *     other operands of the union (`isSchemelessPathHref`) and, at click time,
 *     by `resolveRelativeLink`'s segment walk. Note `isSchemelessPathHref` uses
 *     the looser {@link hasSchemePrefix}, so the two disagree about e.g.
 *     `2024:plan.md` — deliberately: this clause returns `true` and hands the
 *     row to `defaultValidate`, which is what kept it rendering before #1537
 *     and what keeps it rendering now.
 *
 * **The one thing clause 2 still subtracts that used to open.** A filename that
 * happens to spell a syntactically valid scheme — `my-file:v2.md`,
 * `notes:draft.md` — matches {@link WHATWG_SCHEME_PREFIX} and is refused. That
 * is correct rather than regrettable: a browser reads `my-file:v2.md` as an
 * opaque non-special URL with scheme `my-file:`, NOT as a relative path, so the
 * anchor never resolved against the document the way Tandem's segment walk
 * pretended it did. Colons are legal in POSIX/macOS filenames and illegal on
 * Windows, so the shape is rare; it is named here so nobody has to rediscover
 * it from a bug report.
 *
 * **What this predicate does NOT close, and what closes it instead.**
 * `/\evil.com/x.md`, `\/evil.com/x.md`, `\\evil.com\share\x.md` and
 * `" /\evil.com/x.md"` carry no scheme, so clause 3 returns `true` and this
 * predicate does not subtract them. They are nonetheless BLANKED, because
 * {@link isRenderableLinkHref} (#1420) is ANDed alongside this term at the
 * `isAllowedUri` site and refuses them via its leading-whitespace and
 * `rejectUnsafeWindowsPrefix` clauses.
 *
 * An earlier revision of this comment, written while #1420 was still an open
 * branch, said they "still render" and prescribed collapsing this function
 * into `isRenderableLinkHref` as a replacement for ITS clause 3 once that
 * branch landed. #1420 has landed and the collapse was deliberately NOT
 * performed: the two terms are kept separate and ANDed. The collapse is
 * behaviourally equivalent, but separate terms keep each refusal readable at
 * its own call site and keep the two test corpora aimed at one predicate
 * each. What must never be done is folding this in as the FINAL clause of
 * `isRenderableLinkHref`, which would delete the `rejectUnsafeWindowsPrefix`
 * check and turn all four backslash spellings back on — see the PR body for
 * the measured table.
 *
 * **Not holes, verified rather than assumed:** `ms-msdt%3a/id` and the
 * full-width-colon spelling `ms-msdt：/id` both stay live, and correctly so —
 * `new URL()` decodes neither into a scheme, so both resolve as ordinary
 * relative paths under the document origin. The same is true of `:alert(1)`,
 * `ms_msdt:x` and `user@host:x` after clause 2 was sized to the real grammar.
 */
export function isRenderableLinkScheme(raw: string | null | undefined): boolean {
  if (!raw) return false;
  // Protocol-relative: external, allowlisted, and decided here explicitly.
  if (raw.startsWith("//")) return true;
  // Scheme-bearing by the URL parser's own grammar: allowlist or nothing.
  if (WHATWG_SCHEME_PREFIX.test(raw)) return isSafeExternalHref(raw);
  // Schemeless: not this predicate's question.
  return true;
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
