/**
 * Which document formats route to the plaintext adapter, and what that costs
 * them (#1460).
 *
 * `populateYDoc` splits plaintext content on every `\n` — one block per line —
 * and `extractText` joins top-level blocks with `\n`. Those are exact inverses
 * for a flat sequence of blocks, and ONLY while no textblock contains a newline
 * of its own. A textblock that does holds a structure the file cannot spell: the
 * bytes say "two lines", the model says "one block", and the next open believes
 * the bytes. So the paragraph the user saved comes back as two.
 *
 * There is no fix on the load side. `.txt` has no marker distinguishing "one
 * wrapped paragraph" from "two lines" — that is the whole nature of the format —
 * so the invariant has to be held at the write points instead:
 *
 *   **A textblock in a plaintext document may not contain a newline**, neither a
 *   `hardBreak` element nor a literal `\n`.
 *
 * Deliberately NOT narrowed to `.txt`. `detectFormat` sends `.html`, `.htm` and
 * every unknown extension (`.log`, `.csv`, …) down the same loader, so a rule
 * scoped to `.txt` would leave the identical bug live everywhere else while
 * looking fixed. Markdown is exempt because it CAN spell the difference — a
 * trailing `\` is a hard break and a bare wrap is a soft one, which is what
 * `whitespace: "pre"` (#1448) exists to preserve. `.docx` is exempt because it
 * carries real run-level breaks.
 *
 * Phrased over the two formats that are exempt rather than the ones that are
 * not, on purpose: the plaintext set is open-ended (it is the `??` fallback in
 * `getAdapter`), so an allowlist would silently exclude the next extension
 * someone adds and disarm the guard for it. A denylist of the two formats with
 * their own break representation cannot drift that way.
 */

/** Formats with a native way to spell a line break inside a block. */
const BREAK_CAPABLE_FORMATS = new Set(["md", "docx"]);

/**
 * True when a document's format routes to the plaintext adapter, and therefore
 * cannot represent a newline inside a textblock.
 *
 * `undefined` reads as **false** — not plaintext. A missing format means we do
 * not know what this document is, and the conservative answer is to leave the
 * user's content alone rather than to restructure it on a guess. Every guard
 * built on this fails OPEN for that reason: an un-split hardBreak is a
 * structural difference the user sees at next open, while a wrong split is an
 * edit to a document nobody asked for.
 */
export function isPlaintextFormat(format: string | undefined | null): boolean {
  if (format === undefined || format === null || format === "") return false;
  return !BREAK_CAPABLE_FORMATS.has(format);
}
