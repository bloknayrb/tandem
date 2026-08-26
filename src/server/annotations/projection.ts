/**
 * ADR-035 channel projection: the single place an annotation becomes something
 * the channel can carry.
 *
 * **The privacy rule, in one predicate.** An annotation may be projected only
 * when `audience === "outbound" && type !== "note"`. Both halves are
 * load-bearing and neither implies the other:
 *
 * - `type !== "note"` is ADR-027 stated directly. A note is user-private and
 *   never reaches Claude, by any route.
 * - `audience === "outbound"` is the half nothing checked before. Nothing
 *   prevents a `{type: "comment", audience: "private"}` record existing — the
 *   durable schema is `.passthrough()` and is documented as not cross-validated
 *   against `type` (`schema.ts`), `sanitizeAnnotation` demotes only
 *   user-authored note/highlight/flag and never demotes a comment, and stale-tab
 *   CRDT merges and legacy envelopes both produce records nobody sanitized on
 *   the way in. Before this module, such a record reached Claude over the
 *   channel. `file-io/docx-comment-export.ts` already treated type and
 *   audience as two separately-required gates; the channel path now agrees.
 *
 *   **This closes the push half only, and the pull half is the authoritative
 *   one.** Every MCP read still gates on `type` and never on `audience` —
 *   `tandem_getAnnotations`, `tandem_exportAnnotations`, `tandem_checkInbox`,
 *   and `channelVisibleReplies`. CLAUDE.md makes `tandem_checkInbox`
 *   authoritative over all four push paths, so such a record still reaches
 *   Claude one poll later. Do not read this module as having closed the
 *   audience hole; it closed it on one surface. Tracked in #1619.
 *
 * **Why `type !== "note"` and not ADR-035's literal `type === "comment"`.**
 * The type half exists to state ADR-027, and ADR-027 is about notes. Bounding
 * it to exactly that keeps the two halves doing separable jobs: type carries
 * the note rule, audience carries privacy. `type === "comment"` would fold a
 * second, unrelated policy — "only comments are conversational" — into the
 * privacy predicate, where nobody would find it.
 *
 * **An earlier version of this comment defended the choice on the grounds that
 * it keeps Claude-authored highlights emitting. That argument does not
 * survive: the audience half drops them anyway.** Every highlight without a
 * stored `audience` derives `private` (`sanitize.ts:79-87`), the tutorial seed
 * is one, and no product path creates a Claude highlight WITH a stored
 * audience — `tandem_highlight` is a deprecated stub and nothing else passes
 * `"highlight"` to a creator. So the two predicates are observably identical
 * today and the choice rests on where each rule belongs, not on behaviour.
 * `tests/server/events/channel-projection-characterization.test.ts` pins both
 * branches so that stays true by measurement rather than by this paragraph.
 * Decided 2026-08-26; ADR-035 is amended to match rather than this module
 * diverging silently from it.
 *
 * **What this module does NOT do.** It does not decide *which event* an
 * annotation produces — add, edit, promotion, accept and dismiss are distinct
 * transitions that only the observers can tell apart, and each keeps its own
 * `action`/`author`/`status` cascade. `narrowForChannel` is an additional
 * requirement layered onto those, never a replacement for them.
 */

import type {
  AnnotationAcceptedPayload,
  AnnotationCreatedPayload,
  AnnotationDismissedPayload,
  AnnotationEditedPayload,
  AnnotationReplyPayload,
} from "../../shared/events/types.js";
import { sanitizeAnnotation } from "../../shared/sanitize.js";
import type { Annotation, AnnotationReply } from "../../shared/types.js";

/**
 * Module-private brand. A `unique symbol` rather than an ordinary field on
 * purpose: a `__channelEligible: true` property is satisfied by any object
 * literal that happens to carry it, which makes the brand structurally
 * forgeable and therefore decorative. This symbol is never exported, so
 * `narrowForChannel` is the only expression in the program that can produce the
 * type.
 */
declare const CHANNEL_ELIGIBLE: unique symbol;

/**
 * A sanitized annotation that has passed the projection predicate.
 *
 * The brand exists at the type level only — it is a phantom property, never
 * present at runtime and never serialized. Do not test for it; test the
 * predicate.
 */
export type ChannelEligible = Annotation & { readonly [CHANNEL_ELIGIBLE]: true };

/** What `narrowForChannel` refused, for the caller's log line. */
export type ProjectionRefusal =
  | { reason: "unsanitizable" }
  | { reason: "unknown-type"; rawType: unknown }
  | { reason: "note" }
  | { reason: "private"; audience: string | undefined };

/**
 * Narrow a raw Y.Map value to something the channel may carry, or `null`.
 *
 * Sanitizes internally rather than trusting the caller. That is not
 * belt-and-braces: `observers/replies.ts` reads its parent with a bare
 * `as Annotation | undefined` and never sanitized it, so routing that read
 * through here is what gives both observers the same guarantees. It also means
 * a legacy record whose `audience` predates the field gets a derived one rather
 * than `undefined` — which matters, because `undefined === "outbound"` is
 * `false` and an unsanitized legacy comment would otherwise be dropped forever.
 *
 * **Fails toward dropping, never toward emitting.** Anything that cannot be
 * sanitized, cannot be read, carries a type sanitize does not recognize, or
 * does not clearly satisfy both halves of the predicate returns `null`.
 * Silence is the safe direction for a privacy control, and it matches how
 * `shouldForwardExternally` treats an indeterminate mode.
 *
 * The unrecognized-type clause is not hypothetical tidiness: without it this
 * function did the opposite of what that paragraph claims, because
 * `sanitizeAnnotation` coerces an unknown type to `comment` and the coerced
 * comment then derives `audience: "outbound"`. See the comment at the sanitize
 * call below.
 *
 * **Never throws.** `makePerKeyChangeObserver` loops over every changed key in
 * one Y.Map transaction with no per-key try/catch, so a throw here would abort
 * projection of unrelated keys in the same transaction — an availability
 * regression with no privacy benefit.
 */
export function narrowForChannel(
  raw: unknown,
  opts: {
    onLossy?: Parameters<typeof sanitizeAnnotation>[1];
    onRefused?: (refusal: ProjectionRefusal, ann: Annotation | undefined) => void;
  } = {},
): ChannelEligible | null {
  if (!raw) return null;

  // `sanitizeAnnotation` does NOT reject a record whose type it fails to
  // recognize — `sanitize.ts:213` coerces one to `type: "comment"` and, since
  // `derivedAudience` keys off the type it no longer has, that comment derives
  // `audience: "outbound"`. So `sanitizeAnnotation({})` returns a projectable
  // comment with every other field `undefined`, and a note whose `type` was
  // dropped or corrupted — by a stale-tab CRDT merge or a legacy envelope,
  // the two cases this module exists for — would project its content.
  //
  // Refusing on a type *denylist* is what let that through: `!== "note"`
  // bounds one name, and the coercion composes what survives it. Sanitize
  // announces the case as a `unknown-type` lossy event, so that signal is the
  // check. It is deliberately narrower than "anything sanitize migrated":
  // `suggestion`/`question` → `comment` are recognized legacy types with their
  // own events and must keep projecting.
  let sawUnknownType: { rawType: unknown } | undefined;

  let ann: Annotation;
  try {
    // `raw` is unknown by design: this is the boundary where unvalidated Y.Map
    // content is checked, and validating it is exactly `sanitizeAnnotation`'s
    // job. The cast hands it the input and it does the work.
    ann = sanitizeAnnotation(raw as Parameters<typeof sanitizeAnnotation>[0], (event) => {
      if (event.kind === "unknown-type") sawUnknownType = { rawType: event.rawType };
      // Relay regardless: the refusal is ours, but the migration record is the
      // caller's and swallowing it would hide the corruption from the log that
      // exists to catch it. `onLossy` is required by sanitize but optional
      // here: both observers relay today, and a future caller with no relay
      // sink must still be able to narrow. Dropping the event there is
      // correct — it is a migration record, not a privacy decision, and the
      // refusal above does not depend on the caller having listened.
      opts.onLossy?.(event);
    });
  } catch {
    // The error object can embed the annotation's own content; never widen this
    // to log it. The caller gets the key, which is enough to find the record.
    opts.onRefused?.({ reason: "unsanitizable" }, undefined);
    return null;
  }

  if (sawUnknownType) {
    // Report the coerced record, not `undefined`: its `id` usually survived and
    // is the only way to find the row. `describeRefusal` still prints no text.
    opts.onRefused?.({ reason: "unknown-type", rawType: sawUnknownType.rawType }, ann);
    return null;
  }

  // Re-assert both halves against the sanitized value. Against a caller that
  // already checked, this is cheap duplication; against `replies.ts`'s raw
  // parent read it is the only check standing between unsanitized Y.Map content
  // and the wire.
  if (ann.type === "note") {
    opts.onRefused?.({ reason: "note" }, ann);
    return null;
  }
  if (ann.audience !== "outbound") {
    opts.onRefused?.({ reason: "private", audience: ann.audience }, ann);
    return null;
  }

  return ann as ChannelEligible;
}

/**
 * Reply-side narrow. The parent being `ChannelEligible` says nothing about the
 * reply: `AnnotationReply.private` is stamped at creation from the parent's type
 * *at that instant* and is permanent, so a reply written while the parent was a
 * note stays private after the parent is promoted. `replies.ts` never read that
 * field — it was safe only because its `parent.type` check happened to give the
 * same answer, two independent encodings of one invariant. This reads the field.
 */
export function narrowReplyForChannel(
  reply: AnnotationReply | undefined,
  parent: ChannelEligible,
): (AnnotationReply & { readonly [CHANNEL_ELIGIBLE]: true }) | null {
  if (!reply || reply.author !== "user") return null;

  // Fails closed on anything that is not literally `false`.
  //
  // `private === true` would be the natural spelling and it fails OPEN: a
  // `private` stored as the string "true", or as 1, is not `=== true`, so the
  // reply would project and carry its text. The reply is the one value on this
  // path that nothing sanitizes — there is no `sanitizeReply`, and
  // `makePerKeyChangeObserver` hands it over as a bare `map.get(key) as T`.
  // Every writer stamps a real boolean today (`mcp/annotations.ts`,
  // `file-io/docx-comments.ts`, and the zod-gated durable restore), so this is
  // defence against the same stale-tab-merge and legacy-envelope cases the
  // parent narrow exists for. Leaving the reply outside that model while
  // sanitizing the parent was an asymmetry, not a decision.
  if (reply.private !== false && reply.private !== undefined) return null;

  // The parent being eligible must be a statement about THIS reply's parent.
  // Nothing in `replies.ts` can violate this — it fetches the parent by
  // `reply.annotationId` — but the signature otherwise invites a future caller
  // to pass any eligible parent and launder an ineligible reply past the gate.
  if (reply.annotationId !== parent.id) return null;

  return reply as AnnotationReply & { readonly [CHANNEL_ELIGIBLE]: true };
}

// --- Payload builders: the only producers of annotation-bearing payloads -----
//
// Taking `ChannelEligible` rather than `Annotation` is what makes the brand do
// work. A future channel path that reaches for an annotation and builds a
// payload from it gets a compile error here rather than a silent leak, and the
// only way to satisfy it is to go through `narrowForChannel`.

export function createdPayload(ann: ChannelEligible): AnnotationCreatedPayload {
  return {
    annotationId: ann.id,
    annotationType: ann.type,
    content: ann.content,
    textSnippet: ann.textSnapshot ?? "",
    ...(ann.suggestedText !== undefined ? { hasSuggestedText: true } : {}),
  };
}

export function editedPayload(ann: ChannelEligible, editedAt: number): AnnotationEditedPayload {
  return {
    annotationId: ann.id,
    content: ann.content,
    textSnippet: ann.textSnapshot ?? "",
    editedAt,
  };
}

export function acceptedPayload(ann: ChannelEligible): AnnotationAcceptedPayload {
  return { annotationId: ann.id, textSnippet: ann.textSnapshot ?? "" };
}

export function dismissedPayload(ann: ChannelEligible): AnnotationDismissedPayload {
  return { annotationId: ann.id, textSnippet: ann.textSnapshot ?? "" };
}

export function replyPayload(
  reply: AnnotationReply & { readonly [CHANNEL_ELIGIBLE]: true },
  parent: ChannelEligible,
  replyId: string,
): AnnotationReplyPayload {
  return {
    annotationId: reply.annotationId,
    replyId,
    replyText: reply.text,
    replyAuthor: reply.author,
    textSnippet: parent.textSnapshot ?? "",
  };
}

/**
 * Format a refusal for a log line. **Never includes `content` or
 * `textSnapshot`** — a message explaining why a private annotation was withheld
 * must not print the private text to do it, and `console.*` is redirected to
 * stderr process-wide, which can reach log aggregation.
 */
export function describeRefusal(refusal: ProjectionRefusal, id: string | undefined): string {
  const who = id ?? "<unknown>";
  switch (refusal.reason) {
    case "unsanitizable":
      return `${who}: could not be sanitized`;
    case "unknown-type":
      // Only a string `rawType` is printed. A corrupted record can carry
      // anything in that slot, including an object holding annotation text,
      // and this string reaches stderr.
      return `${who}: unrecognized type=${
        typeof refusal.rawType === "string" ? refusal.rawType : `<${typeof refusal.rawType}>`
      }`;
    case "note":
      return `${who}: type=note (ADR-027)`;
    case "private":
      return `${who}: audience=${refusal.audience ?? "<unset>"}`;
  }
}
