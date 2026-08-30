import type * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import { type OnLossy, sanitizeAnnotation } from "../../../shared/sanitize.js";
import type { Annotation } from "../../../shared/types.js";
import { relaySanitizationEvent } from "../../annotations/migration-log.js";
import {
  acceptedPayload,
  createdPayload,
  describeRefusal,
  dismissedPayload,
  editedPayload,
  isNoteworthyRefusal,
  narrowForChannel,
} from "../../annotations/projection.js";
import type { TandemEvent } from "../types.js";
import { generateEventId } from "../types.js";
import { makePerKeyChangeObserver } from "./factory.js";

/**
 * The previous value's type as sanitize would see it, or `undefined` if it
 * cannot be read.
 *
 * `undefined` is the safe answer: it means "not a promotion", which routes to
 * the edit branch, which needs `editedAt` to have advanced. That fails toward
 * emitting nothing.
 */
function sanitizeOldType(
  oldRaw: Annotation | undefined,
  onLossy: OnLossy,
): Annotation["type"] | undefined {
  if (!oldRaw) return undefined;
  try {
    // Relayed, not discarded. If the old value was a legacy `flag`, this
    // promotion is the only moment its legacy-ness is observable on the
    // server -- the new value is an ordinary comment -- so swallowing the
    // event here loses the record entirely.
    return sanitizeAnnotation(oldRaw, onLossy).type;
  } catch (err) {
    // Safe for privacy, unsafe for availability, so it does not get to be
    // silent: `undefined` means "not a promotion", which routes to the edit
    // branch, which needs `editedAt` to have advanced -- and promotion does
    // not touch `editedAt`. The outcome is no event at all, which is verbatim
    // the bug this function was added to fix.
    console.warn(
      `[EventQueue] could not read previous annotation type: ${err instanceof Error ? err.name : typeof err}`,
    );
    return undefined;
  }
}

export function makeAnnotationsObserver(deps: {
  docName: string;
  doc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
}): () => void {
  const { docName, doc, pushEvent } = deps;
  const annotationsMap = doc.getMap(Y_MAP_ANNOTATIONS);

  return makePerKeyChangeObserver<Annotation>({
    map: annotationsMap,
    pushEvent,
    derive: ({ key, action, value: raw, oldValue: oldRaw }): TandemEvent | undefined => {
      // **Before the narrow, because a delete has nothing to narrow.**
      // `makePerKeyChangeObserver` passes `value: undefined` for a delete, which
      // `narrowForChannel` refuses with `reason: "missing"` — noteworthy by
      // `isNoteworthyRefusal`, which excludes only `"note"` — so without this
      // line every removal prints `refused to project … no such annotation`. It
      // does not today only because `withMcp` is in `CHANNEL_SKIP` and the
      // observer returns before reaching here; Unit 8e moved the browser's
      // Archive onto `withBrowser`, which is deliberately NOT in that set, and
      // that would have made the most ordinary user action in the product emit
      // a corruption-shaped log line.
      //
      // Nothing is lost by returning early: there is no `annotation:removed`
      // member of the event union at all (`shared/events/types.ts`), so a delete
      // has never been projectable and every branch below re-tests `add` or
      // `update` anyway.
      //
      // **An allowlist, not `action === "delete"`**, matching
      // `observers/replies.ts`'s `action !== "add"`. A denylist covers the one
      // kind that exists today and lets a future one fall straight through to
      // `narrowForChannel(undefined)` — reproducing the exact refusal line this
      // check exists to prevent, in a change that never mentions it.
      if (action !== "add" && action !== "update") return undefined;

      // ADR-035: the single narrow. Sanitizes, then requires
      // `audience === "outbound" && type !== "note"`. Everything below builds
      // its payload from `ann`, and the builders take `ChannelEligible` — so a
      // branch that forgets to narrow is a compile error, not a silent leak.
      const ann = narrowForChannel(raw, {
        onLossy: (event) => relaySanitizationEvent(docName, event),
        onRefused: (refusal, refused) => {
          // `isNoteworthyRefusal`, not a hand-written reason check. The first
          // version of this filter logged ONLY `unsanitizable` -- the one
          // reason that essentially cannot fire -- and silently discarded
          // `unknown-type` and `private`, which are the corruption this module
          // exists to detect. Naming the policy in `projection.ts` is what
          // stops that being re-derived wrongly at each call site.
          if (!isNoteworthyRefusal(refusal)) return;
          console.warn(
            `[EventQueue] refused to project key=${key}: ${describeRefusal(refusal, refused?.id)}`,
          );
        },
      });
      if (!ann) return undefined;

      // The narrow says whether this annotation MAY be projected. It cannot say
      // which transition happened — only the action/author/status cascade below
      // can tell an add from an edit from an accept, so each keeps its own gate.
      if (action === "add" && ann.author === "user") {
        // Comments only on the add path. Kept alongside the narrow rather than
        // folded into it: this is a product rule about which of the user's own
        // annotations start a conversation, not the privacy rule.
        if (ann.type !== "comment") return undefined;
        return {
          id: generateEventId(),
          type: "annotation:created",
          timestamp: Date.now(),
          documentId: docName,
          payload: createdPayload(ann),
        };
      }

      if (action === "update" && ann.author === "user" && ann.type === "comment") {
        // Sanitized, not raw. The client's promoter sanitizes before deciding
        // something is a note (`panels/annotation-actions.ts`), and sanitize
        // maps a legacy `flag` to `note` — so a stored `flag` IS promotable and
        // the user can promote one. Comparing the RAW old type against the
        // literal "note" missed that: the promotion fell through to the edit
        // branch, `editedAt` had not moved (promotion does not touch it), and
        // the user got no channel event at all from a "Send to Claude" click.
        // Not narrowed: `narrowForChannel` refuses notes, which is precisely
        // the value this branch is looking for.
        if (sanitizeOldType(oldRaw, (event) => relaySanitizationEvent(docName, event)) === "note") {
          // Note promoted to comment via "Send to Claude" — surface it to the channel
          // so real-time subscribers see it as a new comment event.
          return {
            id: generateEventId(),
            type: "annotation:created",
            timestamp: Date.now(),
            documentId: docName,
            payload: createdPayload(ann),
          };
        }
        // Comment edited by user — surface edit to channel if editedAt advanced.
        const newEditedAt = ann.editedAt ?? 0;
        const oldEditedAt = oldRaw?.editedAt ?? 0;
        if (newEditedAt <= oldEditedAt) return undefined;
        return {
          id: generateEventId(),
          type: "annotation:edited",
          timestamp: Date.now(),
          documentId: docName,
          payload: editedPayload(ann, newEditedAt),
        };
      }

      if (action === "update" && ann.author === "claude") {
        // No `type` check here any more: the narrow already refused notes, and
        // it refused them against the SANITIZED value rather than the raw one,
        // which is strictly stronger than the guard this replaces.
        if (ann.status === "accepted") {
          return {
            id: generateEventId(),
            type: "annotation:accepted",
            timestamp: Date.now(),
            documentId: docName,
            payload: acceptedPayload(ann),
          };
        }
        if (ann.status === "dismissed") {
          return {
            id: generateEventId(),
            type: "annotation:dismissed",
            timestamp: Date.now(),
            documentId: docName,
            payload: dismissedPayload(ann),
          };
        }
      }

      return undefined;
    },
  });
}
