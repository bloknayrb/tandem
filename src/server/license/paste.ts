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

export function normalizePastedLicense(raw: string): string {
  return raw.replace(QP_SOFT_BREAK, "").trim();
}
