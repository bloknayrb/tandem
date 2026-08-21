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
 * ## Why not `src/shared/redact-user-paths.ts`
 *
 * That module solves the adjacent problem — collapsing user-identifying
 * prefixes out of diagnostics text before it is published — and `/api/diagnostics`
 * uses it. It is deliberately not reused here, for three reasons, and its
 * `escapeRegExp` IS reused so the two do not drift on the one thing they share:
 *
 *  1. **Different output.** It rewrites to `~` and `[user]`, which read as
 *     redaction markers in a bug report and as breakage in a screenshot of a
 *     file picker. A shot of the setup wizard has to still look like a path.
 *  2. **Different execution site.** The replacement here runs inside a
 *     `page.evaluate` callback, which Playwright serializes to source and which
 *     therefore cannot import anything. What crosses that boundary has to be a
 *     serializable `{pattern, flags, replacement}`, not a function.
 *  3. **No paired leak scan.** `findAccountPathLeaks` below is the half that
 *     makes narrowing the match safe, and it has no counterpart there because
 *     diagnostics text has no shutter to stop.
 *
 * Its generic second pass (`/home/X` → `/home/[user]` regardless of who X is)
 * is genuinely stronger in one respect: it also covers *other* accounts' names.
 * That is out of scope here — slot 13 renders this machine's own paths — but it
 * is the thing to reach for if a future shot ever renders someone else's.
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
 * A home directory with no non-empty parent segment therefore cannot be
 * anchored at all, and `planAccountRedaction` refuses rather than approximating.
 * `/root` is the case that matters — it is this repo's own sandbox `$HOME` —
 * and the approximation is not close: with an empty parent the pattern
 * degenerates to `([\\/]+)root`, i.e. *any* separator, which rewrites
 * `/etc/skel/root/profile` to `/etc/skel/you/profile`. That is precisely the
 * over-replacement #1528 is about, so it is refused and the scan takes over.
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

import { escapeRegExp } from "../../src/shared/redact-user-paths";

/** A serializable redaction, applied identically in Node and inside `page.evaluate`. */
export interface AccountRedaction {
  /** `RegExp` source. Group 1 is the parent prefix as rendered. */
  pattern: string;
  flags: string;
  /** Always `"$1you"` — group 1 echoes the rendered prefix back unchanged. */
  replacement: string;
  /** The account segment being redacted, for `findAccountPathLeaks`. */
  account: string;
  /**
   * `RegExp` source for the parent prefix ALONE, no capture group.
   *
   * Built from the same segments as `pattern`, so the two cannot disagree.
   * `findAccountPathLeaks` needs it: the prefix survives redaction by design,
   * and on a machine whose account collides with one of its segments (`home`,
   * `users`) a scan that did not know about it would report a byte-perfect
   * redaction as a leak. See that function.
   */
  parentPattern: string;
}

/**
 * What to do about this machine's account name — the three outcomes are NOT
 * interchangeable, and collapsing them into `AccountRedaction | null` is what
 * made the first version of this module wrong in both directions at once.
 *
 *  - `redact` — anchorable. Rewrite, then scan with the prefix masked.
 *  - `scan-only` — the name exists but cannot be anchored (`bryan` with no
 *    parent, `/root` with an empty one). Rewriting would over-replace, so
 *    nothing is rewritten and the scan alone decides: if the name is on screen
 *    the capture goes red, which is the correct side to err on.
 *  - `none` — nothing to do. An empty home directory, or an account already
 *    named `you`. The scan must NOT run for `you`: it is the placeholder, so
 *    every correctly redacted path on the page would report as a leak.
 */
export type AccountRedactionPlan =
  | { kind: "redact"; redaction: AccountRedaction }
  | { kind: "scan-only"; account: string }
  | { kind: "none" };

/** Path separator, either style, one or more. */
const SEP = "[\\\\/]+";

/** What the account segment is rewritten to. */
const PLACEHOLDER = "you";

/**
 * A segment boundary AFTER the account name.
 *
 * `.` is deliberately NOT treated as a name character: a config path's account
 * segment is followed by a separator in every real case, and the one ambiguous
 * form — a home directory at the end of a sentence, `/home/root.` — must redact.
 * The cost is that a hypothetical sibling directory named `root.bak` would also
 * redact; the benefit is that sentence punctuation cannot hide a leak. `-` and
 * `_` ARE name characters, which is what keeps `claude.com/claude-code` intact
 * on a machine whose account is `claude`, and `/home/bryan_old` intact on a
 * machine whose account is `bryan`.
 */
const SEGMENT_END = "(?![A-Za-z0-9_-])";

/**
 * Decide what can be done about the account name in `homeDir`.
 *
 * See `AccountRedactionPlan` for why there are three answers rather than two.
 */
export function planAccountRedaction(homeDir: string): AccountRedactionPlan {
  const segments = homeDir.trim().split(/[\\/]+/);
  while (segments.length > 0 && segments[segments.length - 1] === "") segments.pop();

  const account = segments[segments.length - 1] ?? "";
  if (!account || account.toLowerCase() === PLACEHOLDER) return { kind: "none" };

  const parent = segments.slice(0, -1);
  // `split` collapses separator runs, so only the LEADING segment of an
  // absolute path can be empty — `[]` (a bare `bryan`) and `[""]` (`/root`)
  // are the two ways to have no prefix to anchor against, and they fail the
  // same way. See the module docstring.
  if (parent.every((segment) => segment === "")) return { kind: "scan-only", account };

  // `["", "home"]` -> `[\\/]+home`; `["C:", "Users"]` -> `C:[\\/]+Users`; the
  // leading empty segment of an absolute path contributes nothing but leaves
  // the required separator in front of the account.
  const parentPattern = parent.map(escapeRegExp).join(SEP);
  return {
    kind: "redact",
    redaction: {
      pattern: `(${parentPattern}${SEP})${escapeRegExp(account)}${SEGMENT_END}`,
      flags: "gi",
      replacement: `$1${PLACEHOLDER}`,
      account,
      parentPattern,
    },
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
 * Every path-shaped token in `text` in which the account survives as a BOUNDED
 * run — preceded and followed by a non-name character (or the token edge).
 *
 * This is the capture's fail-closed check, and it is what makes narrowing the
 * replacement safe: it does not care how the leak got there. Prose that merely
 * uses the word (`"the user clicked"`) is not path-shaped and is ignored, which
 * is the whole point — the old assertion could not tell the two apart, so it
 * accepted the corrupted copy as proof of redaction.
 *
 * ## Two things it has to know about, or it fails a correctly redacted page
 *
 * **The boundary.** A plain `includes` is wrong in a way that only bites on the
 * exact account names #1528 is about. Measured:
 *
 *   - account `user`, Windows: the redaction correctly produces
 *     `C:\Users\you\.claude.json`, and `includes("user")` then matches inside
 *     `Users` and fails the capture on a fully redacted page.
 *   - account `us` (reachable now the length guard is gone): same, inside `Users`.
 *   - account `claude`: `includes` matches `/claude-code`, which the redaction
 *     deliberately leaves intact — this module's own docstring promises it does.
 *
 * **The parent prefix.** The prefix is echoed back verbatim by design, so on a
 * machine whose account IS one of its segments, a bounded scan reports the
 * redaction's own output. Measured, before this was fixed:
 * `findAccountPathLeaks("/home/you/.claude.json", "home")` returned that whole
 * token — on `$HOME=/home/home` the page is byte-perfect and slot 13 fails
 * forever. `home` and `users` are both in this class, and both are among the
 * default accounts this module exists for. So the plan's `parentPattern` is
 * masked out of each token — specifically the prefix followed by the
 * PLACEHOLDER, which is exactly what a successful redaction leaves behind and
 * therefore provably not a leak — before the bounded run is looked for. The
 * token reported is the original, not the masked one.
 *
 * Real leaks all still report: a sibling directory (`/home/you/.bryan/...`), a
 * path outside the home dir (`C:\Backups\bryan\...`), an unredacted path
 * (`/home/home/...` — no placeholder, so nothing masks), and a differently-cased
 * repeat.
 *
 * ## What is deliberately left failing
 *
 * Masking the prefix cannot help with an account name that collides with a
 * segment BELOW the home directory, because nothing distinguishes that from a
 * real second occurrence. On a machine whose account is `claude`, `json`,
 * `appdata`, `roaming` or `config`, slot 13's own paths
 * (`C:\Users\you\AppData\Roaming\Claude\claude_desktop_config.json`,
 * `/home/you/.claude.json`) contain a bounded run of the account name and
 * report. Nothing here can tell those from a leak, and stopping the capture is
 * the correct side to err on — but it IS a class, not a single case, and a
 * capture run under one of those accounts will need a human decision rather
 * than a code change.
 */
export function findAccountPathLeaks(text: string, plan: AccountRedactionPlan): string[] {
  if (plan.kind === "none") return [];

  const account = plan.kind === "redact" ? plan.redaction.account : plan.account;
  // Only reachable through a hand-built plan — `planAccountRedaction` returns
  // `none` for an empty account. Without it the bounded pattern degenerates to
  // a pair of lookarounds that match at every boundary, reporting every token.
  if (!account) return [];

  // `scan-only` has no anchor and therefore no prefix to mask; that is the
  // whole reason it cannot redact.
  const mask =
    plan.kind === "redact"
      ? new RegExp(`${plan.redaction.parentPattern}${SEP}${PLACEHOLDER}${SEGMENT_END}`, "gi")
      : null;

  const bounded = new RegExp(`(?<!${NAME_CHAR})${escapeRegExp(account)}(?!${NAME_CHAR})`, "i");
  return (text.match(PATH_TOKEN) ?? []).filter((token) =>
    bounded.test(mask ? token.replace(mask, "/") : token),
  );
}
