/**
 * Normalize a license blob that arrived by copy/paste out of an email client.
 *
 * This is deliberately, almost aggressively minimal. Base64 survives far more
 * than it looks like it should, and every "helpful" repair we might add here is
 * a chance to reject a blob that would have activated fine:
 *
 *  - `Buffer.from(s, "base64")` already **ignores whitespace**, so hard-wrapped
 *    lines, stray indentation and trailing newlines decode correctly.
 *  - It also accepts the **base64url alphabet** (`-`/`_`) as equivalent to
 *    `+`/`/`, so a URL-safe mangling still decodes byte-identically.
 *  - Zero-width characters, non-breaking spaces and smart quotes around the blob
 *    were all verified to decode fine too.
 *
 * The ONE mail-transport mutation that actually corrupts a license is a
 * **quoted-printable soft line break**: an `=` inserted at the end of a wrapped
 * line. Base64 reads that interior `=` as padding and silently truncates the
 * payload, so the buyer gets "that doesn't look like a license key" for a key
 * that left our Worker intact. An unbroken 484-character line is exactly what
 * makes an MTA choose quoted-printable in the first place — which is why the
 * issuance email now hard-wraps the inline copy and attaches a `.license` file.
 *
 * Everything else stays untouched on purpose.
 */

/** `=` immediately before a line break — a quoted-printable soft break. */
const QP_SOFT_BREAK = /=\r?\n/g;

/**
 * Longest input worth normalizing. Callers MUST bound before calling — this
 * function allocates a copy per pass, so handing it an unbounded body turns a
 * paste into transient memory pressure. Comfortably above the verifier's
 * post-normalize 10k ceiling: soft breaks only ever ADD bytes, so anything that
 * could legitimately normalize down to 10k starts well under this.
 */
export const MAX_NORMALIZE_INPUT = 20_000;

/**
 * Repair QP soft breaks and trim.
 *
 * Applied repeatedly to a fixed point, because a single left-to-right pass is
 * NOT idempotent — it can create a soft break out of neighbours that didn't
 * match: `"X=\r=\r\n\nY"` → `"X=\r\nY"`, which still contains one. Callers
 * (notably `activateLicense`, which PERSISTS the result) are entitled to assume
 * the output contains no soft break at all, so converge rather than pass once.
 *
 * Termination is guaranteed: each pass strictly shortens the string or changes
 * nothing, and the loop stops on the first no-op.
 */
export function normalizePastedLicense(raw: string): string {
  let out = raw;
  for (;;) {
    const next = out.replace(QP_SOFT_BREAK, "");
    if (next === out) return out.trim();
    out = next;
  }
}
