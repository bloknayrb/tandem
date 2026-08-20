/**
 * Account-name redaction for the screenshot capture (`capture.spec.ts`, slot 13).
 *
 * The setup wizard prints the real resolved config path for every AI client it
 * finds on the capture machine, and those paths are rooted at `os.homedir()`,
 * so they carry the account name as a path segment. The images ship in a public
 * repo, so the capture redacts by construction rather than asking a human to
 * remember to look.
 *
 * ## Why this is a module and not four lines inside the spec
 *
 * The first implementation replaced the bare account name in EVERY text node
 * under `document.body` (#1528). Its own comment justified a `length < 3` guard
 * on the grounds that a two-letter name "appears as a substring of ordinary
 * words and would corrupt the surrounding copy" — but that reasoning does not
 * stop at two characters. `root`, `user`, `home` and `admin` all clear a length
 * guard, are common default accounts (this repo's own agent sandboxes run with
 * `$HOME=/root`), and are ordinary English words that appear in the app's own
 * UI copy. A capture run under such an account silently rewrote unrelated
 * prose, and every assertion still passed: they checked that the account string
 * was *gone* and that `you` appeared *somewhere*, not that only the intended
 * occurrences moved.
 *
 * The failure direction matters. The real account name still did not survive
 * into the image; the bug was the opposite, over-replacement. The fix must not
 * trade that away, so it does NOT narrow the walk to a selector set: on
 * loopback — which is exactly how a capture runs — `scrubExistingInstalls` in
 * `src/server/integrations/api-routes.ts` does not scrub, so `install.errorMessage`
 * reaches `.itc-status` as a raw `readFile` failure with the path Node embeds in
 * it, and `wizard.errorMessage` reaches `.iw-tech-text` the same way. Scoping to
 * `.itc-path` (the element the old `:948` assertion happens to target) would
 * have left both uncovered. The walk stays body-wide; what changed is the match.
 *
 * ## The match
 *
 * The account name is replaced only where it is the home directory's own path
 * segment: the full parent prefix of `os.homedir()` must precede it, and the
 * segment must end at a boundary. `/home/root/.claude.json` redacts;
 * "Ready to connect", "your home directory" and `claude.com/claude-code` do not.
 * Separators are matched interchangeably (`[\\/]`) and matching is
 * case-insensitive, because a rendered path is not guaranteed to use the same
 * separator style or case as `os.homedir()` on Windows.
 *
 * Redaction, not fabrication: only the account segment changes, and it changes
 * to a placeholder that reads as one. The parent prefix is echoed back from the
 * match itself (`$1`), so the drive, the separators and the case the UI actually
 * rendered all survive verbatim.
 *
 * No length guard. It existed to stop substring corruption, and segment
 * anchoring stops that at every length, so a two-letter account is now redacted
 * instead of shipped.
 *
 * `findAccountPathLeaks` is the other half, and it is why the narrowed match is
 * safe: the capture asserts that no path-shaped run of text anywhere on the page
 * still contains the account name. A leak the redaction did not anticipate — a
 * path outside the home directory, or a repeat of the name deeper in one — turns
 * the capture red instead of shipping the shot. An unredactable name is a reason
 * to stop, not to publish.
 */

/** A serializable redaction, applied identically in Node and inside `page.evaluate`. */
export interface AccountRedaction {
  /** `RegExp` source. Group 1 is the parent prefix as rendered. */
  pattern: string;
  flags: string;
  /** Always `"$1you"` — group 1 echoes the rendered prefix back unchanged. */
  replacement: string;
  /** The account segment being redacted, for `findAccountPathLeaks`. */
  account: string;
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (s: string): string => s.replace(REGEX_META, "\\$&");

/** Path separator, either style, one or more. */
const SEP = "[\\\\/]+";

/**
 * A segment boundary AFTER the account name.
 *
 * `.` is deliberately NOT treated as a name character: a config path's account
 * segment is followed by a separator in every real case, and the one ambiguous
 * form — a home directory at the end of a sentence, `/home/root.` — must redact.
 * The cost is that a hypothetical sibling directory named `root.bak` would also
 * redact; the benefit is that sentence punctuation cannot hide a leak. `-` and
 * `_` ARE name characters, which is what keeps `claude.com/claude-code` intact
 * on a machine whose account is `claude`.
 */
const SEGMENT_END = "(?![A-Za-z0-9_-])";

/**
 * Build the redaction for a home directory, or `null` when there is nothing
 * safe to do.
 *
 * Returns `null` for an empty path, for an account already named `you`, and for
 * a home directory with no parent segment to anchor against (`"bryan"` with no
 * separator). That last case refuses rather than guesses: an unanchored name is
 * exactly the substring match this module exists to stop, and the capture's leak
 * assertion will fail the run if the name is actually on screen.
 */
export function buildAccountRedaction(homeDir: string): AccountRedaction | null {
  const segments = homeDir.trim().split(/[\\/]+/);
  while (segments.length > 0 && segments[segments.length - 1] === "") segments.pop();

  const account = segments[segments.length - 1] ?? "";
  if (!account || account.toLowerCase() === "you") return null;

  const parent = segments.slice(0, -1);
  if (parent.length === 0) return null;

  // `["", "home"]` -> `[\\/]+home`; `["C:", "Users"]` -> `C:[\\/]+Users`; the
  // leading empty segment of an absolute path contributes nothing but leaves
  // the required separator in front of the account.
  const parentPattern = parent.map(escapeRe).join(SEP);
  return {
    pattern: `(${parentPattern}${SEP})${escapeRe(account)}${SEGMENT_END}`,
    flags: "gi",
    replacement: "$1you",
    account,
  };
}

/**
 * Apply a redaction to one run of text.
 *
 * `capture.spec.ts` inlines this same single `replace` inside its
 * `page.evaluate` — a Playwright evaluate callback cannot reach module scope, so
 * the browser half cannot import it. Keep the two identical; the spec-source
 * guard in `tests/scripts/screenshot-redaction.test.ts` pins that it still does.
 */
export function redactHomePaths(text: string, redaction: AccountRedaction): string {
  return text.replace(new RegExp(redaction.pattern, redaction.flags), redaction.replacement);
}

/**
 * Absolute-path-shaped runs of text: a drive letter or a leading separator,
 * then everything up to whitespace or a quote. Deliberately loose — it decides
 * only *where to look* for a surviving account name, and looking in too many
 * places costs nothing but a red capture on a genuinely ambiguous machine.
 */
const PATH_TOKEN = /(?:[A-Za-z]:[\\/]|[\\/])[^\s"'<>()]*/g;

/**
 * A name character, matching `SEGMENT_END` above. The two must agree: the scan
 * exists to catch what the redaction missed, so a shape the redaction
 * deliberately leaves alone must not be reported as a leak.
 */
const NAME_CHAR = "[A-Za-z0-9_-]";

/**
 * Every path-shaped token in `text` in which `account` survives as a BOUNDED
 * run — preceded and followed by a non-name character (or the token edge).
 *
 * This is the capture's fail-closed check, and it is what makes narrowing the
 * replacement safe: it does not care how the leak got there. Prose that merely
 * uses the word (`"the user clicked"`) is not path-shaped and is ignored, which
 * is the whole point — the old assertion could not tell the two apart, so it
 * accepted the corrupted copy as proof of redaction.
 *
 * The boundary is not optional, and a plain `includes` is wrong in a way that
 * only bites on the exact account names #1528 is about. Measured:
 *
 *   - account `user`, Windows: the redaction correctly produces
 *     `C:\Users\you\.claude.json`, and `includes("user")` then matches inside
 *     `Users` and fails the capture on a fully redacted page.
 *   - account `us` (reachable now the length guard is gone): same, inside `Users`.
 *   - account `claude`: `includes` matches `/claude-code`, which the redaction
 *     deliberately leaves intact — this module's own docstring promises it does.
 *
 * All three are false positives against a correctly redacted page. Bounding the
 * run removes them while keeping every real leak: a sibling directory
 * (`/home/you/.bryan/...`), a path outside the home dir
 * (`C:\Backups\bryan\...`), and a differently-cased repeat all still report.
 *
 * One ambiguity is deliberately left failing. On a machine whose account is
 * literally `claude`, `.claude.json` — Claude Code's own config filename, not
 * derived from the account — is a bounded run and reports. Nothing here can
 * tell those apart, and stopping the capture is the correct side to err on.
 */
export function findAccountPathLeaks(text: string, account: string): string[] {
  if (!account) return [];
  const bounded = new RegExp(`(?<!${NAME_CHAR})${escapeRe(account)}(?!${NAME_CHAR})`, "i");
  return (text.match(PATH_TOKEN) ?? []).filter((token) => bounded.test(token));
}
