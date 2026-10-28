/**
 * Log-line formatting for `tandem_checkInbox`'s dropped-record warnings.
 *
 * Its own module so the privacy contract below — a record id or zod path is
 * printed only when it is a plain token, and an issue only as `path code` — is
 * the whole of what it exports, and its test can drive it directly.
 */

import type { z } from "zod";

/**
 * What an id or a zod path segment must look like to be printed. Anything else
 * prints as a placeholder: a record id is client-written, and a log line is no
 * place for whatever a client chose to put in one.
 */
const PRINTABLE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export function printableId(id: unknown): string {
  return typeof id === "string" && PRINTABLE_ID.test(id) ? JSON.stringify(id) : "(unprintable)";
}

/**
 * Zod issues as `path code` pairs ONLY (PR #2225 review). Never `issue.message`,
 * `.format()` or the value: a message can quote the received value, and the
 * record can be a user's text. Its test feeds it a message that does quote one:
 * zod 4's own messages mostly do not, so a test driven through a real parse
 * could not tell whether the message is logged.
 */
export function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path
        .map((seg) =>
          typeof seg === "number" || (typeof seg === "string" && PRINTABLE_ID.test(seg))
            ? String(seg)
            : "?",
        )
        .join(".");
      return `${path || "(root)"} ${issue.code}`;
    })
    .join(", ");
}
