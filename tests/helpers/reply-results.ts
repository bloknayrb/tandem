import type { ClaudeReplyResult, ReplyResult } from "../../src/server/annotations/lifecycle.js";

/**
 * Narrow a reply result to its `ok` arm, failing loudly otherwise.
 *
 * A plain `if (result.kind !== "ok") throw` at every call site reads as
 * ceremony and gets copied wrong; the recurring pre-8f version was
 * `if (!result.ok) expect(...)`, which asserts NOTHING when the call succeeds.
 * An assertion signature keeps `result.replyId` reachable afterwards without
 * a cast, so no spec needs to widen the type to read the id it just wrote.
 *
 * Deliberately does not accept an arbitrary object: it takes the two exported
 * unions, so a call handed some other result type fails to compile rather than
 * silently vacuously passing.
 */
export function assertReplyOk(
  result: ReplyResult | ClaudeReplyResult,
): asserts result is { kind: "ok"; replyId: string } {
  if (result.kind !== "ok") {
    throw new Error(`expected an ok reply, got ${JSON.stringify(result)}`);
  }
}
