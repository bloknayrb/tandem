import { SUPPORTED_EXTENSIONS } from "../../../shared/constants.js";
import { rejectUnsafeWindowsPrefix } from "../../../shared/windows-path-safety.js";

/**
 * File extensions that open as new Tandem tabs when clicked as relative links.
 * `.docx` excluded — not navigable as a link target.
 */
const INTERNAL_LINK_EXTS = new Set([...SUPPORTED_EXTENSIONS].filter((e) => e !== ".docx"));

/**
 * The same set as prose, for error copy. Derived rather than written out so a
 * change to {@link INTERNAL_LINK_EXTS} cannot leave the user-facing message
 * naming formats Tandem no longer opens.
 */
export const LINKABLE_EXTS_LABEL = [...INTERNAL_LINK_EXTS]
  .join(", ")
  .replace(/, ([^,]*)$/, " and $1");

/** Trailing `.ext`, where the extension itself contains no separator. */
const TRAILING_EXT_RE = /\.[^./\\]+$/;

/**
 * Path separator, either flavour. Both are split on regardless of platform: a
 * `\` inside an href is the fail-OPEN direction if treated as an ordinary
 * character, because `a\..\..\..\x.md` would then be one opaque segment that
 * sails through the `..` walk and the containment check below.
 */
const PATH_SEP_RE = /[/\\]/;

/**
 * Why a href was refused.
 *
 * These are NOT interchangeable, which is the whole reason this is a union
 * rather than `null`. `escapes-root` and `joined-unc` are things a hostile or
 * model-authored document put in front of the user — and MCP tools write
 * markdown into the user's documents, so a crafted link is in-model for this
 * app. `unsupported-ext` is a typo. A caller that treats them alike leaves a
 * blocked traversal with the same trace as a mistyped `.pdf`.
 */
export type LinkRejectReason =
  /** Pure `#anchor` (or `?query`) with no path — not a file link. */
  | "fragment"
  /** The href itself is UNC- or device-namespace-shaped. */
  | "unsafe-prefix"
  /** Not a format Tandem opens in a tab. */
  | "unsupported-ext"
  /** `currentFilePath` has no separator, so there is no directory to resolve against. */
  | "no-directory"
  /** `..` walked above the current file's root. */
  | "escapes-root"
  /** The resolved path is UNC-shaped even though containment passed. */
  | "joined-unc";

/** Reject reasons that indicate a hostile href rather than a mistake. */
export const SECURITY_REJECT_REASONS: ReadonlySet<LinkRejectReason> = new Set([
  "unsafe-prefix",
  "escapes-root",
  "joined-unc",
] satisfies LinkRejectReason[]);

export type LinkResolution = { ok: true; path: string } | { ok: false; reason: LinkRejectReason };

/**
 * Resolve a relative href against an absolute file path.
 * Works on both POSIX and Windows paths by detecting the separator.
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
 * example is depth-sensitive on purpose: it carries one more `..` than the path
 * has directories, so re-running it against a shallower or deeper
 * `currentFilePath` gives a different answer. The variant WITHOUT the leading
 * `a/` is allowed by Tiptap's default URL guard today (pinned in
 * `tests/client/link-target-internal.test.ts`), so these guards close a
 * pre-existing hole as well as one that widening the guard (#1377) would open.
 *
 * **The two UNC guards are not redundant, and they fail on different platforms.**
 * For that same href: on Windows containment catches it (`resultParts[0]` is
 * `""`, not `"C:"`), and on POSIX containment *passes* (both are `""`) so only
 * the post-join check catches it. Deleting either one leaves a live hole on one
 * platform; the test suite pins each independently.
 *
 * Measured non-regressions (all still resolve), from `C:\Users\blokn\docs\note.md`:
 *   - `../docs/spec.md` → `C:\Users\blokn\docs\spec.md`
 *   - `docs/spec.md` → `C:\Users\blokn\docs\docs\spec.md`
 *   - `/\evil.com/x.md` → `C:\Users\blokn\docs\\\evil.com\x.md`, which
 *     `path.resolve` collapses to a same-machine path.
 */
export function resolveRelativeLink(href: string, currentFilePath: string): LinkResolution {
  // Detect Windows vs POSIX for the JOIN. The splits below accept either
  // flavour regardless; only the output separator is platform-shaped.
  const sep = currentFilePath.includes("\\") ? "\\" : "/";

  // Strip both `#fragment` and `?query` — a browser treats each as structural,
  // and stripping only `#` made the render and click boundaries disagree:
  // `isSchemelessPathHref` renders `docs/spec.md?x=1` (it stops at `?` when
  // looking for a scheme) while `TRAILING_EXT_RE` then saw `.md?x=1`, matched
  // nothing, and refused it. Cross-file in-page anchors are not supported.
  const stops = [href.indexOf("#"), href.indexOf("?")].filter((i) => i >= 0);
  const hrefPath = stops.length ? href.slice(0, Math.min(...stops)) : href;
  if (!hrefPath) return { ok: false, reason: "fragment" };

  // A protocol-relative (`//host/x`), UNC-shaped (`\\host\x`) or
  // device-namespace (`\\?\…`) href is an EXTERNAL navigation, never a path
  // relative to the current file.
  //
  // Only the `//` case is unobservable in production, because `openHref` routes
  // it to `isSafeExternalHref` first. The backslash forms DO reach us and this
  // guard does change their outcome — from a collapsed same-machine path to a
  // refusal — so it is not inert; don't delete it as dead code.
  if (rejectUnsafeWindowsPrefix(hrefPath) !== null) {
    return { ok: false, reason: "unsafe-prefix" };
  }

  const extMatch = hrefPath.match(TRAILING_EXT_RE);
  const ext = extMatch ? extMatch[0].toLowerCase() : "";
  if (!INTERNAL_LINK_EXTS.has(ext)) return { ok: false, reason: "unsupported-ext" };

  // Get directory of current file. Split on either separator so a mixed path
  // (`C:\Users\b\docs/note.md`) does not collapse `docs/note.md` into one
  // segment and silently resolve against the wrong directory.
  const dirParts = currentFilePath.split(PATH_SEP_RE);
  dirParts.pop(); // remove filename
  // No directory to resolve against (a `currentFilePath` with no separator).
  if (dirParts.length === 0) return { ok: false, reason: "no-directory" };

  const hrefParts = hrefPath.split(PATH_SEP_RE);

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
  //
  // `resultParts` cannot be empty here, and the reason is the EXTENSION GATE
  // above, not the `dirParts` guard: `TRAILING_EXT_RE` requires the final href
  // segment to contain a dot and no separator, so that segment is never `..`
  // or `.` and is therefore always pushed. If the gate is ever loosened, an
  // explicit `resultParts.length === 0` check has to come back — the comparison
  // below would still refuse (`undefined !== dirParts[0]`), but only by
  // accident.
  if (resultParts[0] !== dirParts[0]) return { ok: false, reason: "escapes-root" };

  // Belt-and-braces UNC reject — load-bearing on POSIX, see the header.
  const joined = resultParts.join(sep);
  if (rejectUnsafeWindowsPrefix(joined) !== null) return { ok: false, reason: "joined-unc" };

  return { ok: true, path: joined };
}
