/**
 * The client half of notification-text cleaning (#2168): a code-point mirror
 * of `clean()` in `src-tauri/src/notifications.rs`.
 *
 * The desktop backend posts through Rust, which cleans again — a no-op on text
 * already cleaned here. The browser backend posts straight to the Web
 * Notifications API, and this is the only cleaning it gets: without it a file
 * name carrying U+202E would read backwards in the OS notification, and an
 * oversized title or body would reach the notification server unbounded.
 *
 * `tests/docs/chat-notification-parity-claims.test.ts` pins the caps, the
 * invisible ranges, the line-breaking set and the test text against the Rust
 * source. Change both sides together, or that test fails.
 *
 * No imports, on purpose: the parity test and the Rust side are the only
 * things this needs to agree with.
 */

/** Caps, in code points. Mirror `MAX_TITLE_CHARS` / `MAX_BODY_CHARS`. */
export const NOTIFICATION_TITLE_MAX_CHARS = 120;
export const NOTIFICATION_BODY_MAX_CHARS = 300;

/**
 * Bidi controls and zero-width characters, as inclusive code-point ranges:
 * invisible, and able to reorder or disguise the visible text. Mirrors Rust's
 * `is_invisible_format` arm for arm. U+061C is ARABIC LETTER MARK, a bidi
 * control outside the U+200x blocks.
 */
export const INVISIBLE_FORMAT_RANGES: readonly (readonly [number, number])[] = [
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

/**
 * The fixed text of Settings → "Send a test notification". Mirrors Rust's
 * `TEST_TITLE` / `TEST_BODY`, so the browser and desktop tests read the same.
 */
export const TEST_NOTIFICATION_TEXT = {
  title: "Claude replied",
  body: "This is a test notification from Tandem.",
} as const;

/**
 * The title of the notification for Tandem's one-time hello (#2227), in place
 * of "Claude replied …": the hello answers nothing the user sent. Fixed text;
 * it never names a document. Chosen by `buildNotificationText` from the
 * server's `greeting` marker, never from the reply's text.
 */
export const GREETING_NOTIFICATION_TITLE = "Tandem's Claude is ready";

function isInvisibleFormat(cp: number): boolean {
  return INVISIBLE_FORMAT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/**
 * Category Cc (what Rust's `char::is_control` tests) plus LINE SEPARATOR and
 * PARAGRAPH SEPARATOR. Mirrors Rust's `is_line_breaking`.
 */
function isLineBreaking(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
}

/**
 * Drop invisible format characters, turn line-breaking characters into
 * spaces, trim, and cap at `max` code points with an ellipsis. Code-point
 * based, so a cap never splits a surrogate pair.
 */
export function cleanNotificationText(text: string, max: number): string {
  let flattened = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisibleFormat(cp)) continue;
    flattened += isLineBreaking(cp) ? " " : ch;
  }
  const trimmed = flattened.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= max) return trimmed;
  return `${chars
    .slice(0, Math.max(0, max - 1))
    .join("")
    .trimEnd()}…`;
}

/**
 * The first `n` UTF-16 code units of `text`, minus a high surrogate the cut
 * would leave dangling. Cheap (no code-point walk), for bounding input before
 * work that is superlinear in its length.
 */
export function sliceCodeUnitsSafe(text: string, n: number): string {
  if (text.length <= n) return text;
  const head = text.slice(0, Math.max(0, n));
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}
