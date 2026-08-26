/**
 * Proves the ADR-035 `ChannelEligible` brand is load-bearing rather than
 * decorative.
 *
 * **These `@ts-expect-error` assertions only mean anything because `tests/` is
 * typechecked** (`npm run typecheck:tests`, three configs, wired into CI by
 * #1616). Before that landed, nothing read the test tree, so a `@ts-expect-error`
 * in here passed whether or not the error it claimed actually occurred — and
 * two `expectTypeOf` "contract tests" in this repo asserted nothing for months
 * on exactly that basis. If the typecheck step is ever dropped, this file
 * silently stops testing anything.
 *
 * The complement is the runtime half below: a brand is a compile-time
 * construct, so it says nothing about a value that arrives as `any` from
 * `JSON.parse`, a session restore, or a request body. The predicate has to hold
 * at runtime too, and that is what `narrowForChannel` re-asserts.
 */

import { describe, expect, it } from "vitest";
import {
  acceptedPayload,
  createdPayload,
  narrowForChannel,
  narrowReplyForChannel,
  replyPayload,
} from "../../../src/server/annotations/projection.js";
import { toFlatOffset } from "../../../src/shared/positions/types.js";
import type { Annotation, AnnotationReply } from "../../../src/shared/types.js";

function plain(seed: Partial<Annotation> & Pick<Annotation, "author" | "type">): Annotation {
  return {
    id: "a1",
    range: { from: toFlatOffset(0), to: toFlatOffset(5) },
    content: "body",
    status: "pending",
    timestamp: 1_000,
    textSnapshot: "snap",
    ...seed,
  } as Annotation;
}

describe("the brand is enforced at compile time", () => {
  it("a plain Annotation cannot be projected without narrowing", () => {
    const ann = plain({ author: "user", type: "comment", audience: "outbound" });

    // @ts-expect-error - a plain Annotation is not ChannelEligible; go through
    // narrowForChannel. Removing the narrow anywhere in the observers produces
    // exactly this error rather than a silent note leak.
    createdPayload(ann);

    // @ts-expect-error - same for every other builder; the brand is on the
    // parameter type, so all of them are closed, not just the one a future
    // change happens to touch.
    acceptedPayload(ann);

    // The runtime call still works — the brand is a phantom type, so this is a
    // type error only. Asserting it runs proves the @ts-expect-error above is
    // about the TYPE and not about a broken call.
    expect(createdPayload(narrowForChannel(ann) ?? ({} as never))).toMatchObject({
      annotationId: "a1",
    });
  });

  it("a reply cannot be projected on the strength of its parent alone", () => {
    const parent = narrowForChannel(plain({ author: "user", type: "comment" }));
    if (!parent) throw new Error("fixture should narrow");
    const reply: AnnotationReply = {
      id: "r1",
      annotationId: "a1",
      author: "user",
      text: "t",
      timestamp: 1,
    };

    // @ts-expect-error - the parent being eligible says nothing about the
    // reply's own `private` flag. Branding only the parent is what would make
    // `replies.ts` LOOK fully guarded while the reply stayed unchecked.
    replyPayload(reply, parent, "r1");

    const eligible = narrowReplyForChannel(reply, parent);
    expect(eligible).not.toBeNull();
  });
});

describe("the brand does not survive contact with the runtime", () => {
  it("re-asserts the predicate rather than trusting that a caller checked", () => {
    // A brand cannot stop `any` — TypeScript lets `any` flow into a branded
    // parameter with no cast and no complaint, which is precisely how a value
    // rehydrated from JSON would arrive. So the narrow checks again.
    const fromJson: unknown = JSON.parse(
      JSON.stringify(plain({ author: "user", type: "note", audience: "outbound" })),
    );
    expect(narrowForChannel(fromJson)).toBeNull();
  });

  it("refuses a note even when the stored audience claims outbound", () => {
    // `sanitizeAnnotation` demotes a user-authored note, so this is belt and
    // braces — but the narrow must not DEPEND on sanitize having done it, since
    // an author other than "user" skips that demotion.
    expect(
      narrowForChannel(plain({ author: "user", type: "note", audience: "outbound" })),
    ).toBeNull();
  });

  it("refuses a comment whose audience is private", () => {
    expect(
      narrowForChannel(plain({ author: "user", type: "comment", audience: "private" })),
    ).toBeNull();
  });

  it("admits a comment whose audience is unset, because sanitize derives it", () => {
    // The important direction: `undefined === "outbound"` is false, so a legacy
    // comment predating the audience field would be dropped FOREVER if the
    // narrow ran on raw input. It sanitizes first, which derives "outbound".
    const ann = plain({ author: "user", type: "comment" });
    delete (ann as { audience?: unknown }).audience;
    expect(narrowForChannel(ann)).not.toBeNull();
  });

  it("refuses rather than throwing on input it cannot make sense of", () => {
    // `makePerKeyChangeObserver` has no per-key try/catch, so a throw here
    // would abort projection of unrelated keys in the same Y.Map transaction.
    const refusals: string[] = [];
    expect(() =>
      narrowForChannel({ nonsense: true }, { onRefused: (r) => refusals.push(r.reason) }),
    ).not.toThrow();
    expect(narrowForChannel({ nonsense: true })).toBeNull();
    // NOT "unsanitizable": `sanitizeAnnotation` does not throw on this. It
    // returns `{type: "comment", audience: "outbound"}` with every other field
    // undefined — a projectable record built out of nothing.
    expect(refusals).toEqual(["unknown-type"]);
  });

  it("refuses a note whose type field did not survive", () => {
    // The reason the clause above is a privacy control and not hygiene. This
    // is a note by every other measure; drop the one field sanitize keys on
    // and the coercion hands back an outbound comment carrying its content.
    // A `type !== "note"` denylist admits it, which is why the check is on
    // sanitize's own unknown-type signal instead.
    const note = plain({ author: "user", type: "note", content: "PRIVATE" });
    (note as { type?: unknown }).type = "nOtE";
    expect(narrowForChannel(note)).toBeNull();
  });

  it("still projects the legacy types sanitize deliberately migrates", () => {
    // The clause must not be "refuse anything sanitize touched".
    // `question` and `suggestion` are recognized legacy types that migrate to
    // `comment` on purpose and have always projected; widening the refusal to
    // every lossy event would silently stop carrying them.
    for (const legacy of ["question", "suggestion"]) {
      const ann = plain({ author: "user", type: "comment", content: "{}" });
      (ann as { type?: unknown }).type = legacy;
      expect(narrowForChannel(ann), `${legacy} should still project`).not.toBeNull();
    }
  });

  it("relays the migration event even when it refuses on it", () => {
    // The refusal is ours; the migration record is the caller's. Swallowing it
    // would hide the corruption from the log that exists to catch it.
    const kinds: string[] = [];
    narrowForChannel({ nonsense: true }, { onLossy: (e) => kinds.push(e.kind) });
    expect(kinds).toEqual(["unknown-type"]);
  });

  it.each([null, undefined, 0, ""])("refuses the falsy value %p", (value) => {
    expect(narrowForChannel(value)).toBeNull();
  });

  it("never puts annotation text in a refusal report", () => {
    // The refusal path is a new logging surface. A message explaining why
    // private text was withheld must not print the private text to do it —
    // console.* is redirected to stderr process-wide and can reach log
    // aggregation.
    const SECRET = "SECRET NOTE BODY";
    let seen = "";
    narrowForChannel(
      plain({ author: "user", type: "note", content: SECRET, textSnapshot: SECRET }),
      {
        onRefused: (refusal, ann) => {
          seen = JSON.stringify({ refusal, id: ann?.id });
        },
      },
    );
    expect(seen).not.toContain(SECRET);
    expect(seen).toContain("note");
  });
});
