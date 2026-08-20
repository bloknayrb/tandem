/**
 * A small bounded ring buffer for client-side diagnostics (#1439).
 *
 * ## Why this exists
 *
 * The desktop app is the primary distribution and its release build ships no
 * `devtools` feature (`src-tauri/Cargo.toml`; the feature is mutually exclusive
 * with `tauri-plugin-log`), so there is no inspector to open. `tauri-plugin-log`
 * captures Rust `log::*`, not WebView `console.*`. A `console.warn` that
 * distinguishes three different bugs behind one generic user-facing string is
 * therefore written to a sink nobody can read, and the bug report says only
 * "the copy button didn't work".
 *
 * Entries recorded here are drained by `formatDiagnostics`, so they reach the
 * clipboard via Copy Diagnostics and the prefilled body via Report a bug.
 *
 * ## The API is the privacy control
 *
 * The diagnostics report is pasted into a **public GitHub issue**, and
 * `buildBugReportUrl` prefills it — which turns the user's review step into an
 * opt-out. So:
 *
 * 1. **Nothing is captured automatically.** No `console` monkey-patch: every
 *    entry comes from an explicit call someone wrote and reviewed.
 * 2. **There is no free-text parameter.** `scope` and `event` are static string
 *    literals — there is nothing to interpolate a document title into. That is
 *    enforced by `tests/client/client-log-callsites.test.ts`, not by types,
 *    because TypeScript cannot express "literal only".
 * 3. **The cause is classified, not traversed.** `describeCause` reads `name`
 *    and `message` and NOTHING else: no `.stack`, no `.cause`, no `String(err)`,
 *    no `JSON.stringify`, no recursion into fields. This is a rule, not an
 *    accident — the obvious "make detail more useful" follow-up is
 *    `err.cause?.message`, and a stack is almost entirely absolute file paths.
 * 4. **Scrubbed on the way in**, so the buffer never holds unscrubbed text for
 *    some other reader (a Sentry breadcrumb, a heap dump) to find, and capped,
 *    which bounds how much of anything that slipped through can travel.
 *
 * ## What this does NOT protect against
 *
 * `redactPaths` collapses the username segment only, so
 * `~/Documents/board-minutes.md` still names the document. A `string` cause is
 * captured verbatim (scrubbed and capped) — kept deliberately, because Tauri
 * `invoke` rejects with the Rust error's `Display` string rather than an
 * `Error`, and dropping that branch would blind the Cowork pre-flight call site
 * to every failure it has. In short: layers 1–3 constrain what we *ask* to be
 * logged; they cannot vouch for the content of a string handed to us.
 */

import { scrubText } from "../../shared/scrub-text";

/** Entries kept. Small on purpose — this is evidence, not a log file. */
const CAPACITY = 20;

/**
 * Ceiling on a single entry's `detail`.
 *
 * A privacy control as much as a size one: it bounds how much of any string
 * that slipped past the scrubbers — a paragraph of document text inside a
 * server error message, say — can ride along into a public issue.
 */
const MAX_DETAIL_CHARS = 160;

/**
 * Ceiling on the RAW cause, applied before any pass reads it.
 *
 * `MAX_DETAIL_CHARS` bounds what is *stored*, not what is *processed*:
 * `describeCause` deliberately scrubs the full cause and only then clamps, so
 * without this the cost of a `catch` is a function of the raw input, on the UI
 * thread. Two passes are super-linear in ways a regex change alone does not
 * remove — `collapseLines`' leading `\s*` backtracks across a whitespace run
 * (128k spaces: 18.2s), and the URL-credential rule's two `[^/\s@]+` runs
 * either side of a literal `:` have O(n²) ways to split a colon run
 * (`"https://" + "a:".repeat(50000)`: 33s, before AND after the `\w{1,16}` fix).
 * Capping the input is what actually bounds both: at 1024 they are 1.2ms and
 * 3.2ms.
 *
 * 1024 rather than `MAX_DETAIL_CHARS` because the pre-clamp string is also what
 * `fingerprint` keys on, and coalescing on 160 characters is precisely the bug
 * `fingerprint` exists to avoid. 6.4x the display cap keeps that discrimination
 * while making the excess unreachable by `detail`.
 */
const MAX_CAUSE_CHARS = 1024;

export interface ClientLogEntry {
  /** Seconds since the bundle loaded, one decimal. The LAST occurrence. */
  readonly at: number;
  /**
   * When this entry was FIRST recorded. Rendered alongside `count`, because
   * `at` alone cannot distinguish three failures 300ms apart from three spread
   * over a quarter of an hour, and those are different bugs.
   */
  readonly firstAt: number;
  readonly level: "warn" | "error";
  /** Static subsystem tag, e.g. `"wizard"`. */
  readonly scope: string;
  /** Static event description, e.g. `"clipboard write failed"`. */
  readonly event: string;
  /** Scrubbed, single-line, capped classification of the cause. `""` if none. */
  readonly detail: string;
  /** Occurrences collapsed into this entry. */
  readonly count: number;
}

/**
 * The coalescing key rides on the stored entry but never leaves this module —
 * `readClientLog` strips it. It is an implementation detail of deduplication,
 * not something the diagnostics report should render or a caller should read.
 */
interface StoredEntry extends ClientLogEntry {
  readonly key: string;
}

const buffer: StoredEntry[] = [];

const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();

function elapsedSeconds(): number {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return Math.round((now - startedAt) / 100) / 10;
}

/**
 * Bound the raw cause before any pass reads it. See `MAX_CAUSE_CHARS`.
 *
 * A plain slice: this runs BEFORE scrubbing, so it may leave a half-matched
 * credential at the cut — which is harmless because the cut sits far beyond
 * `MAX_DETAIL_CHARS`, so that tail reaches only `fingerprint`, which stores a
 * hash and no text. `clamp` is what guards the surrogate boundary on the string
 * that is actually kept.
 */
function cap(input: string): string {
  return input.length > MAX_CAUSE_CHARS ? input.slice(0, MAX_CAUSE_CHARS) : input;
}

/**
 * Collapse newlines before anything else measures or renders this string.
 *
 * `stripControlChars` in `diagnostics.ts` deliberately does NOT strip `\x0a`
 * (report text legitimately contains newlines — that is why `fenceFor` exists),
 * and multi-line `Error.message`s are routine for Tauri `invoke` failures and
 * JSON parse errors. Left alone, one entry would render as several lines: it
 * breaks the section's size accounting, and a message could inject a convincing
 * `[ok]   some-check — …` line into a public issue body.
 */
function collapseLines(input: string): string {
  return input.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/**
 * Drop unpaired surrogates, then truncate to `MAX_DETAIL_CHARS`.
 *
 * `encodeURIComponent` throws `URIError` on a lone surrogate, and
 * `buildBugReportUrl` answers a throw by returning the BARE issue URL — the
 * entire diagnostics prefill silently gone, on the exact surface #1439 exists
 * to fix. Two ways one arrives, and both have to be closed:
 *
 *  - **already in the input.** A `String.fromCharCode(0xd800)` inside a message
 *    reaches us intact: every scrub pattern is ASCII and every `[^…]+` run
 *    consumes whole pairs, so nothing upstream can remove — or manufacture —
 *    one. Hence the unconditional pass, not just a cut-site fix-up.
 *  - **created by the cut**, when the slice lands between a high and low
 *    surrogate. That is why the trailing-high-surrogate strip runs after the
 *    slice rather than before it.
 */
function clamp(input: string): string {
  // Ordered alternation rather than a lookahead/lookbehind pair: the first
  // branch consumes a well-formed pair whole, so a low surrogate that follows a
  // high one can never be reached by the second branch and only genuinely
  // unpaired ones are dropped. Written this way because a lookbehind would be
  // the FIRST one in the browser bundle — esbuild cannot downlevel it, so it
  // would raise the WKWebView floor from 15.4 to 16.4, and a lookbehind is an
  // early SyntaxError in JSC, which blanks the whole bundle rather than
  // degrading one function. Verified byte-identical to the lookbehind form over
  // 399,592 inputs (exhaustive over high/low/BMP symbols to length 6).
  const paired = input.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) =>
    m.length === 2 ? m : "",
  );
  if (paired.length <= MAX_DETAIL_CHARS) return paired;
  return `${paired.slice(0, MAX_DETAIL_CHARS).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

/**
 * A collision-resistant stand-in for the FULL scrubbed cause, used as the
 * coalescing key.
 *
 * Coalescing on the clamped `detail` would merge two genuinely different
 * failures that happen to agree on their first 160 characters and report them
 * as one that recurred — a `(x2)` asserting a repeat that never happened, which
 * is worse than two lines. Keying on the pre-clamp string fixes that; keying on
 * a FINGERPRINT of it fixes it without storing the extra text, which matters
 * because everything in this buffer is a candidate for a public issue body.
 * Length plus a 32-bit FNV-1a hash: no text, and a collision needs both to
 * agree.
 */
function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${input.length}:${(hash >>> 0).toString(36)}`;
}

function isErrorLike(value: object): value is { name: string; message: string } {
  const candidate = value as { name?: unknown; message?: unknown };
  return typeof candidate.name === "string" && typeof candidate.message === "string";
}

/**
 * Reduce an unknown thrown value to a short classification.
 *
 * `name` is the diagnostic payload, not a formality: `NotAllowedError` vs
 * `TypeError` vs `SecurityError` is precisely what separates a denied clipboard
 * permission from a WebView with no `navigator.clipboard` from a policy
 * rejection — the three bugs #1439 opens with.
 *
 * READS `name` AND `message` ONLY. Not `.stack`, not `.cause`, not fields, not
 * `String(value)`. See the privacy note at the top of this file before
 * "improving" this.
 *
 * Returns the scrubbed string UNCLAMPED — `record` clamps for display and
 * fingerprints the full string for coalescing, which are different jobs.
 * "Unclamped" means un-clamped to `MAX_DETAIL_CHARS`; the raw cause is still cut
 * to `MAX_CAUSE_CHARS` FIRST, so neither `collapseLines` nor `scrubText` ever
 * sees an unbounded string. The cut cannot reach `detail`: it sits 6.4x beyond
 * the display cap, and scrubbing only ever replaces a credential with a
 * placeholder, so nothing past it can be pulled into the visible window.
 */
function describeCause(cause: unknown): string {
  if (cause === undefined || cause === null) return "";
  if (typeof cause === "string") return scrubText(collapseLines(cap(cause)));
  if (typeof cause === "object") {
    if (isErrorLike(cause)) {
      return scrubText(collapseLines(cap(`${cause.name}: ${cause.message}`)));
    }
    // Deliberately the TYPE and nothing else: a rejected `{ path, body }`
    // contributes the word "Object", never its contents.
    const ctorName = (cause as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof ctorName === "string" && ctorName ? ctorName : "object";
  }
  return typeof cause;
}

function record(level: "warn" | "error", scope: string, event: string, cause: unknown): void {
  const described = describeCause(cause);
  const detail = clamp(described);
  const key = fingerprint(described);
  const at = elapsedSeconds();

  // Coalesce against ANY matching entry, not just the newest one. Two failures
  // alternating (A, B, A, B …) would otherwise consume all 20 slots with two
  // distinct facts and flush every other scope out — and alternation is the
  // expected shape here, since the Cowork pre-flight is retry-driven and its
  // catch covers several distinct causes. Matching anywhere makes CAPACITY a
  // count of distinct facts.
  const index = buffer.findIndex(
    (entry) =>
      entry.level === level && entry.scope === scope && entry.event === event && entry.key === key,
  );
  if (index !== -1) {
    const [existing] = buffer.splice(index, 1);
    // Replaced, never mutated in place: `readClientLog` hands entries to callers
    // that hold them across an await, and `at` moves to the newest occurrence so
    // newest-first rendering does not show a stale time at the top. `firstAt`
    // stays put — the pair is what makes a repeat count legible.
    buffer.push({ ...existing, at, count: existing.count + 1 });
    return;
  }

  buffer.push({ at, firstAt: at, level, scope, event, detail, count: 1, key });
  if (buffer.length > CAPACITY) buffer.shift();
}

/**
 * Never let telemetry throw into the app's error path — `src/client/sentry.ts`'s
 * own stated norm, and this module is the declared intake for the ~150 other
 * `console.warn` sites, so it will meet causes today's two never produce.
 *
 * `describeCause` reads `cause.name`, and a getter that throws would otherwise
 * abort the CALLER's `catch` block, so the user-facing recovery line after the
 * warn never runs. That is also why the console call is emitted first: the
 * console line is the one part of this that was there before the ring buffer
 * existed, and it must not become conditional on the buffer succeeding.
 */
function recordSafely(level: "warn" | "error", scope: string, event: string, cause: unknown): void {
  try {
    record(level, scope, event, cause);
  } catch {
    // Deliberately silent. A `console.warn` here would recurse straight back
    // into a mocked console in tests and add nothing a developer can act on.
  }
}

/**
 * Record a client-side warning and log it to the console exactly as before.
 *
 * `scope` and `event` must be **string literals**; `cause` is the thrown value.
 * The console call is byte-identical to a hand-written
 * ``console.warn(`[scope] event:`, err)`` and passes the RAW cause, so a
 * developer with an inspector open keeps the full object and its stack.
 *
 * It is also emitted FIRST and the buffer write is caught, so replacing a bare
 * `console.warn` with this call cannot change what the caller's `catch` block
 * does — see `recordSafely`.
 */
export function logClientWarning(scope: string, event: string, cause?: unknown): void {
  if (cause === undefined) console.warn(`[${scope}] ${event}`);
  else console.warn(`[${scope}] ${event}:`, cause);
  recordSafely("warn", scope, event, cause);
}

/** As `logClientWarning`, for failures that warrant `console.error`. */
export function logClientError(scope: string, event: string, cause?: unknown): void {
  if (cause === undefined) console.error(`[${scope}] ${event}`);
  else console.error(`[${scope}] ${event}:`, cause);
  recordSafely("error", scope, event, cause);
}

/**
 * Snapshot the buffer, oldest first. Non-destructive despite the "drain"
 * framing: Copy Diagnostics and Report-a-bug are two consumers of one buffer,
 * and clearing on either would empty it for the other.
 *
 * Entries are copied individually — coalescing replaces entries and callers
 * hold this array across an await, so a shallow copy could let the `(x3)` a
 * user sees drift from what was rendered.
 */
export function readClientLog(): readonly ClientLogEntry[] {
  // Destructured rather than spread-then-delete so the internal coalescing key
  // cannot reach a diagnostics report by omission.
  return buffer.map(({ key: _key, ...entry }) => entry);
}

/** Test seam — empties the buffer. (Precedent: `_resetDiagnosticsCache`.) */
export function _resetClientLog(): void {
  buffer.length = 0;
}
