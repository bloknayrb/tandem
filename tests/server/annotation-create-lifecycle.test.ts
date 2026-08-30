/**
 * ADR-035 Unit 8b — the create family behind `AnnotationLifecycle`.
 *
 * **The parity assertions here are literal, not comparative, and that is the
 * whole point.** The obvious characterization test — "the lifecycle and
 * `createAnnotation` produce equal records" — is vacuous after this unit,
 * because `createAnnotation` *is* the lifecycle: one delegates to the other, so
 * the assertion compares the code under test against itself and passes whether
 * or not a single field survived the migration. Every expectation below is
 * therefore written out by hand from the pre-refactor implementation
 * (`origin/master:src/server/mcp/annotations.ts` `createAnnotation`), so it can
 * disagree with the new code.
 *
 * `toStrictEqual`, never `toEqual`: the create path *omits* `relRange` rather
 * than storing an explicit `undefined`, and `toEqual` treats `{relRange:
 * undefined}` and `{}` as equal. That difference reaches the durable envelope
 * and the Y.Map values browsers observe, and it is the single most likely
 * parity break in a rewrite of this function.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type AnnotationLifecycle,
  type AnnotationReplier,
  type CreateExtras,
  createAnnotationLifecycle,
  mintAnnotation,
} from "../../src/server/annotations/lifecycle.js";
import {
  narrowForChannel,
  type ProjectionRefusal,
} from "../../src/server/annotations/projection.js";
import { dispatch } from "../../src/server/local-model/tools.js";
import { createAnnotation } from "../../src/server/mcp/annotations.js";
import { injectTutorialAnnotations } from "../../src/server/mcp/tutorial-annotations.js";
import * as notifications from "../../src/server/notifications.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { INTERNAL_ORIGIN, MCP_ORIGIN } from "../../src/shared/origins.js";
import type { Annotation } from "../../src/shared/types.js";
import { unanchored } from "../helpers/positions.js";
import { getAnnotationsMap, makeDoc, noRelay, rangeOf } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;
let map: Y.Map<unknown>;

beforeEach(() => {
  doc = makeDoc("Hello world");
  map = getAnnotationsMap(doc);
  notifications.resetForTesting();
});

/** Strip the two fields that cannot be predicted, so the rest can be literal. */
function normalized(rec: Annotation): Record<string, unknown> {
  const { id: _id, timestamp: _ts, ...rest } = rec as Annotation & Record<string, unknown>;
  return rest;
}

describe("AnnotationLifecycle.create — record shape", () => {
  it("mints the pre-refactor record, field for field, from an unanchored range", () => {
    const lifecycle = createAnnotationLifecycle(doc);
    const result = lifecycle.create({ anchored: unanchored(0, 5), content: "needs work" });

    expect(result.kind).toBe("created");
    // Written from origin/master's `createAnnotation`, not read back off the
    // implementation. `relRange` is absent, not undefined (see file header).
    expect(normalized(result.annotation)).toStrictEqual({
      author: "claude",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: "needs work",
      status: "pending",
      rev: 1,
    });
  });

  it("omits the relRange KEY entirely when the range is not fully anchored", () => {
    const lifecycle = createAnnotationLifecycle(doc);
    const { annotation } = lifecycle.create({ anchored: unanchored(0, 5), content: "x" });
    const stored = map.get(annotation.id) as Record<string, unknown>;

    // `stored.relRange === undefined` would pass on a record that stores an
    // explicit `undefined`, which is a different Y.Map value.
    expect(Object.hasOwn(stored, "relRange")).toBe(false);
    expect(Object.hasOwn(annotation, "relRange")).toBe(false);
  });

  it("attaches relRange when the range IS fully anchored", () => {
    const lifecycle = createAnnotationLifecycle(doc);
    const anchored = rangeOf(0, 5, doc);
    expect(anchored.relRange).toBeDefined();

    const { annotation } = lifecycle.create({ anchored, content: "x" });
    expect(Object.hasOwn(annotation, "relRange")).toBe(true);
    expect(annotation.relRange).toStrictEqual(anchored.relRange);
  });

  it("writes the record into the annotations Y.Map under its own id", () => {
    const lifecycle = createAnnotationLifecycle(doc);
    const { annotation } = lifecycle.create({ anchored: unanchored(0, 5), content: "x" });
    expect(map.get(annotation.id)).toStrictEqual(annotation);
  });

  it("stamps rev 1 on a fresh create, so a tombstone at rev >= 2 still wins", () => {
    const lifecycle = createAnnotationLifecycle(doc);
    // `nextRev()` is called with NO argument on create. `nextRev(undefined)` is
    // also 1, so this alone cannot catch the wrong edit — the type-level test
    // below (extras may not carry `rev`) is what closes that.
    expect(lifecycle.create({ anchored: unanchored(0, 5), content: "x" }).annotation.rev).toBe(1);
  });

  it("lets extras override author and status, and carries snapshot fields through", () => {
    const lifecycle = createAnnotationLifecycle(doc);
    const extras: CreateExtras = {
      author: "user",
      status: "accepted",
      textSnapshot: "Hello",
      textSnapshotTruncated: true,
      textSnapshotBreaks: [{ at: 2, kind: "hard" }],
      suggestedText: "Goodbye",
    };
    const { annotation } = lifecycle.create({
      anchored: unanchored(0, 5),
      content: "c",
      extras,
    });

    expect(normalized(annotation)).toStrictEqual({
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: "c",
      status: "accepted",
      rev: 1,
      textSnapshot: "Hello",
      textSnapshotTruncated: true,
      textSnapshotBreaks: [{ at: 2, kind: "hard" }],
      suggestedText: "Goodbye",
    });
  });
});

describe("AnnotationLifecycle.create — ADR-031 origin", () => {
  it("writes under the MCP origin, and a bare map.set does not", () => {
    const origins: unknown[] = [];
    doc.on("afterTransaction", (txn: Y.Transaction) => origins.push(txn.origin));

    createAnnotationLifecycle(doc).create({ anchored: unanchored(0, 5), content: "x" });
    expect(origins).toStrictEqual([MCP_ORIGIN]);

    // Negative control: the assertion above can fail. An untagged write lands a
    // different origin, so "any write at all satisfies it" is not the case.
    origins.length = 0;
    map.set("untagged", { id: "untagged" });
    expect(origins).toHaveLength(1);
    expect(origins[0]).not.toBe(MCP_ORIGIN);
  });
});

describe("AnnotationLifecycle.create — ADR-027 / ADR-035 privacy", () => {
  it("stamps the two fields the channel predicate reads, so the record projects", () => {
    // `narrowForChannel` reads `type` and `audience` — NOT `author`, NOT
    // `status`. Asserting the pair it actually gates on is the point; the other
    // two are asserted for record shape above, not for projection.
    const { annotation } = createAnnotationLifecycle(doc).create({
      anchored: unanchored(0, 5),
      content: "x",
    });
    expect(annotation.type).toBe("comment");
    expect(annotation.audience).toBe("outbound");
    expect(narrowForChannel(map.get(annotation.id))).not.toBeNull();
  });

  it("refuses a Claude-authored note at the channel — the record the seam cannot mint", () => {
    // Built through the wide compatibility entry point, because the seam has no
    // way to express it. Stamped `audience: "outbound"` exactly as
    // `createAnnotation` always did, so the refusal is the TYPE half firing,
    // not the audience half.
    const note = mintAnnotation(doc, map, "note", unanchored(0, 5), "private thought");
    expect(note.audience).toBe("outbound");

    const refusals: ProjectionRefusal[] = [];
    expect(narrowForChannel(map.get(note.id), { onRefused: (r) => refusals.push(r) })).toBeNull();
    expect(refusals).toStrictEqual([{ reason: "note" }]);
  });

  it("strips the owned fields at RUNTIME, not only at the type level", () => {
    // The `Omit` in `CreateExtras` binds the compiler and nothing else. An
    // untyped caller, a cast, or a plain-JS consumer reaches the same function
    // with the same object — and `extras` is spread last, so without the
    // runtime strip every one of these would win. Unit 8a learned exactly this
    // about its `ChannelEligible` brand: a compile-time-only privacy guard is
    // defeated by whatever does not go through the compiler.
    const forged = {
      id: "forged-id",
      type: "note",
      audience: "private",
      rev: 99,
      range: { from: 99, to: 100 },
      relRange: { start: "nonsense", end: "nonsense" },
      content: "hijacked",
      textSnapshot: "kept",
    } as unknown as CreateExtras;

    const { annotation } = createAnnotationLifecycle(doc).create({
      anchored: unanchored(0, 5),
      content: "original",
      extras: forged,
    });

    expect(annotation.id).not.toBe("forged-id");
    expect(annotation.type).toBe("comment");
    expect(annotation.audience).toBe("outbound");
    expect(annotation.rev).toBe(1);
    expect(annotation.range).toStrictEqual({ from: 0, to: 5 });
    expect(Object.hasOwn(annotation, "relRange")).toBe(false);
    // `content` is owned too: `CreateInput.content` is a required parameter and
    // `extras` is spread last, so an unowned `content` would be a second
    // spelling of the same field where the optional one silently wins.
    expect(annotation.content).toBe("original");
    // Positive control: a field the seam does NOT own still comes through, so
    // this is a strip of the named list rather than of extras wholesale.
    expect(annotation.textSnapshot).toBe("kept");
    // The stripped record then projects normally — it is an ordinary outbound
    // comment, which is the whole point of stripping rather than rejecting.
    expect(narrowForChannel(map.get(annotation.id))).not.toBeNull();
  });

  it("the Omit does NOT catch a widened variable — only the runtime strip does", () => {
    // Excess-property checking is what rejects `extras: { audience: "private" }`
    // written as a fresh object literal, and it applies to literals only. The
    // assignment below compiles with no cast and no @ts-expect-error, which is
    // exactly why `stripOwnedFields` and not `CreateExtras` is the control. A
    // Unit 8c–8h author who writes only the `Omit` for their own family's
    // extras type ships a hole that every literal-based type test still passes.
    const widened: Partial<Annotation> = {
      type: "note",
      audience: "private",
      author: "user",
    };

    const { annotation } = createAnnotationLifecycle(doc).create({
      anchored: unanchored(0, 5),
      content: "body",
      // No cast and no @ts-expect-error on this line: that it compiles at all
      // IS the finding. The assertions below are what actually holds the line.
      extras: widened,
    });

    expect(annotation.type).toBe("comment");
    expect(annotation.audience).toBe("outbound");
    // Guard the guard: the unowned field from the same widened object survived,
    // so the assertions above are observing a strip and not an empty extras.
    expect(annotation.author).toBe("user");
  });

  it("type-level: the seam cannot mint a note, a highlight, or forge the privacy fields", () => {
    const lifecycle = createAnnotationLifecycle(doc);
    const anchored = unanchored(0, 5);

    // `create` has no `type` parameter at all — Claude authors comments only.
    // @ts-expect-error — `type` is not part of CreateInput
    lifecycle.create({ anchored, content: "x", type: "note" });

    // @ts-expect-error — `type` is excluded from CreateExtras
    lifecycle.create({ anchored, content: "x", extras: { type: "note" } });

    // @ts-expect-error — `audience` is excluded: the other half of the predicate
    lifecycle.create({ anchored, content: "x", extras: { audience: "private" } });

    // @ts-expect-error — `relRange` is excluded: it may only come from an
    // AnchoredRangeResult, which ties it to fullyAnchored
    lifecycle.create({ anchored, content: "x", extras: { relRange: undefined } });

    // @ts-expect-error — `rev` is excluded: a caller-supplied rev could push a
    // fresh record above 1 and survive a tombstone merge it should lose
    lifecycle.create({ anchored, content: "x", extras: { rev: 9 } });

    // @ts-expect-error — `id` is excluded: the lifecycle mints it
    lifecycle.create({ anchored, content: "x", extras: { id: "forged" } });

    // @ts-expect-error — `range` is excluded: it comes from `anchored`
    lifecycle.create({ anchored, content: "x", extras: { range: { from: 0, to: 1 } } });

    // @ts-expect-error — `content` is excluded: CreateInput already requires it,
    // and extras is spread last, so leaving it writable lets the optional
    // spelling of the field beat the required one
    lifecycle.create({ anchored, content: "x", extras: { content: "y" } });

    // @ts-expect-error — `color` belongs to the highlight arm; deriving
    // CreateExtras from `Extract<Annotation, {type:"comment"}>` keeps the
    // discriminant that a non-distributive Omit over the whole union discards
    lifecycle.create({ anchored, content: "x", extras: { color: "yellow" } });
  });

  it("type-level: AnnotationReplier is create+reply and nothing more", () => {
    // The narrowing handed to the local-model loop (#1123) is a deliberate
    // capability boundary: that subsystem has no accept/dismiss tool, and a
    // wider lifecycle would grant it resolution for the first time. Until this
    // spec existed, widening the `Pick` back to the full `AnnotationLifecycle`
    // passed the whole runtime suite AND typecheck — a stated boundary with
    // nothing enforcing it.
    //
    // **The first version of this spec was an ENUMERATION, and Unit 8c is the
    // evidence that enumerations rot.** It named `accept` and `dismiss` as the
    // methods that must be absent. 8c added `editPending` to
    // `AnnotationLifecycle` and did not extend that list — so widening the
    // `Pick` to `"create" | "editPending"` left both directives live, left
    // `create` reachable, and the spec stayed green. A guard keyed on a list of
    // names is defeated by whatever the list does not name. This form is keyed
    // on the SHAPE instead, so every future unit fails closed by default.
    //
    // **Unit 8f is the first time it actually fired, and it fired correctly.**
    // Adding `reply` to the `Pick` turned the line below red under
    // `typecheck:tests` with TS2322 — no runtime failure, because the
    // enforcement is the compiler and the `expect` exists only so a reader
    // scanning the suite can see the assertion. The list here was then widened
    // as a deliberate act, which is exactly the transaction the guard is meant
    // to force. See `AnnotationReplier`'s docblock for why `reply` belongs and
    // why granting it costs nothing the loop did not already have.
    type ExtraKeys = Exclude<keyof AnnotationReplier, "create" | "reply">;
    const noExtraKeys: ExtraKeys extends never ? true : never = true;
    expect(noExtraKeys, "AnnotationReplier grew a key beyond create/reply").toBe(true);

    const creator: AnnotationReplier = createAnnotationLifecycle(doc);

    // @ts-expect-error — the loop has no accept tool; the seam must not give it one
    creator.accept("id");

    // Guard the guard: both granted methods ARE reachable, so the error above
    // is the narrowing biting and not a broken binding that rejects everything.
    // `reply` is named here as well as in the `Exclude` — the `Exclude` alone
    // would stay green if `reply` were dropped from the `Pick` AND from the
    // interface, which is a capability regression that must not read as a pass.
    const created = creator.create({ anchored: unanchored(0, 5), content: "x" });
    creator.reply(created.annotation.id, "ack", noRelay);

    // Runtime caveat, stated because the docblock reads stronger than the code:
    // TypeScript is structural, so this annotation narrows the BINDING, not the
    // value. `createAnnotationLifecycle` returns the full object and `creator`
    // carries `accept`, `dismiss` and `editPending` at runtime. The boundary is
    // a compile-time convention; anything reaching through `as any` or dynamic
    // dispatch is not stopped by it.
    expect(
      typeof (creator as unknown as AnnotationLifecycle).editPending,
      "documents the runtime hole rather than pretending it is closed",
    ).toBe("function");
  });
});

describe("AnnotationLifecycle.create — review-pending notification", () => {
  it("raises one notification with the comment label and dedup key", () => {
    const seen: Array<{ message: string; dedupKey?: string }> = [];
    const unsub = notifications.subscribe((n) => seen.push(n));
    try {
      createAnnotationLifecycle(doc).create({
        anchored: unanchored(0, 5),
        content: "x",
        extras: { textSnapshot: "Hello" },
      });
    } finally {
      unsub();
    }

    expect(seen).toHaveLength(1);
    // Both halves asserted: "one notification fired" passes on a wrong key, and
    // the key is what the client dedups on.
    expect(seen[0].message).toBe('New Comment: "Hello"');
    expect(seen[0].dedupKey).toBe("review-pending:comment");
  });

  it("switches label and dedup key to replacement when suggestedText is present", () => {
    const seen: Array<{ message: string; dedupKey?: string }> = [];
    const unsub = notifications.subscribe((n) => seen.push(n));
    try {
      createAnnotationLifecycle(doc).create({
        anchored: unanchored(0, 5),
        content: "x",
        extras: { suggestedText: "y" },
      });
    } finally {
      unsub();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe("New Replacement");
    expect(seen[0].dedupKey).toBe("review-pending:replacement");
  });

  it("truncates the snippet at 60 characters and marks it with an ellipsis", () => {
    // The `slice(0, 60)` and the `…` branch are part of the field-for-field
    // parity claim against `origin/master`, and both notification specs above
    // use snapshots far shorter than the boundary — so narrowing the slice to 40
    // changed nothing observable. Asserting the exact 60-char prefix is what
    // makes the boundary a number the test knows rather than one it inherits.
    const snapshot = "A".repeat(61);
    const seen: Array<{ message: string }> = [];
    const unsub = notifications.subscribe((n) => seen.push(n));
    try {
      createAnnotationLifecycle(doc).create({
        anchored: unanchored(0, 5),
        content: "x",
        extras: { textSnapshot: snapshot },
      });
    } finally {
      unsub();
    }

    expect(seen[0].message).toBe(`New Comment: "${"A".repeat(60)}…"`);

    // Negative control on the same boundary: exactly 60 gets no ellipsis, so
    // the assertion above is reading the branch and not just the slice.
    const exact: Array<{ message: string }> = [];
    const unsub2 = notifications.subscribe((n) => exact.push(n));
    try {
      createAnnotationLifecycle(doc).create({
        anchored: unanchored(0, 5),
        content: "x",
        extras: { textSnapshot: "B".repeat(60) },
      });
    } finally {
      unsub2();
    }
    expect(exact[0].message).toBe(`New Comment: "${"B".repeat(60)}"`);
  });
});

describe("create-family write paths that stay OUTSIDE the lifecycle", () => {
  it("tutorial seeding still writes under the INTERNAL origin, not MCP", () => {
    // The exclusion is prose in the lifecycle module and in the PR body; this
    // is what makes it a gate. Routing tutorial seeding through the lifecycle
    // would silently retag it `mcp`, and ADR-031 says the helper choice IS the
    // contract.
    const tutorialDoc = makeDoc(
      "You can highlight text and your AI sees it, edit this document at the same time, " +
        "simplify onboarding, and accept or dismiss what it proposes.",
    );
    const origins: unknown[] = [];
    tutorialDoc.on("afterTransaction", (txn: Y.Transaction) => origins.push(txn.origin));

    injectTutorialAnnotations(tutorialDoc);

    // Guard the guard: if nothing was injected there is no transaction to
    // inspect and the origin assertion would be vacuous.
    expect(tutorialDoc.getMap(Y_MAP_ANNOTATIONS).size).toBeGreaterThan(0);
    expect(origins.length).toBeGreaterThan(0);
    expect(new Set(origins)).toStrictEqual(new Set([INTERNAL_ORIGIN]));
  });
});

describe("compatibility surface", () => {
  it("createAnnotation still returns the id string the MCP envelope reports", () => {
    // `tandem_comment` puts this straight into `mcpSuccess({ annotationId })`.
    const id = createAnnotation(map, doc, "comment", unanchored(0, 5), "x");
    expect(typeof id).toBe("string");
    expect(map.has(id)).toBe(true);
  });

  it("createAnnotation uses the map it is handed, not one it derives", () => {
    // The wide entry point keeps BOTH its `map` and `ydoc` parameters. A
    // delegator that dropped `map` and re-derived it from `ydoc` would agree
    // with every existing call site (all pass the doc's own annotations map)
    // and diverge silently the first time one did not.
    const other = new Y.Doc().getMap<unknown>("scratch");
    const id = createAnnotation(other, doc, "comment", unanchored(0, 5), "x");
    expect(other.has(id)).toBe(true);
    expect(map.has(id)).toBe(false);
  });
});

describe("local-model create path", () => {
  it("builds its creator per dispatch, so two documents never cross", () => {
    // The module header's lifetime rule, and the stated reason `DispatchCtx`
    // carries no lifecycle field: Hocuspocus replaces the Y.Doc in
    // `onLoadDocument`, so a creator cached across calls writes into a
    // destroyed doc. Caching it used to redden this file only incidentally —
    // the two specs below happen to use different docs and run in order, so the
    // second threw a TypeError rather than failing an assertion, and filtering
    // to one spec made the mutation pass. This asserts the isolation in both
    // directions inside a single test, which no ordering can rescue.
    const docA = makeDoc("The quick brown fox jumps over the lazy dog.");
    const docB = makeDoc("The quick brown fox jumps over the lazy dog.");
    const ctx = (ydoc: Y.Doc) => ({
      ydoc,
      isLicenseRestricted: () => false,
      agentIdentity: undefined,
    });

    const outA = dispatch("comment_on_quote", { quoted_text: "quick", comment: "a" }, ctx(docA));
    const outB = dispatch("comment_on_quote", { quoted_text: "brown", comment: "b" }, ctx(docB));
    const idA = (outA.result as { annotation_id: string }).annotation_id;
    const idB = (outB.result as { annotation_id: string }).annotation_id;

    // Guard the guard: both dispatches actually minted something, or the two
    // cross-document assertions below are satisfied by two empty maps.
    expect(getAnnotationsMap(docA).has(idA)).toBe(true);
    expect(getAnnotationsMap(docB).has(idB)).toBe(true);
    expect(getAnnotationsMap(docB).has(idA)).toBe(false);
    expect(getAnnotationsMap(docA).has(idB)).toBe(false);
  });

  it("routes comment_on_quote through the lifecycle and keeps its unique fields", () => {
    const modelDoc = makeDoc("The quick brown fox jumps over the lazy dog.");
    const modelMap = getAnnotationsMap(modelDoc);

    const outcome = dispatch(
      "comment_on_quote",
      { quoted_text: "quick brown fox", comment: "vivid" },
      {
        ydoc: modelDoc,
        isLicenseRestricted: () => false,
        agentIdentity: { provider: "local-ollama", displayName: "Test Model" },
      },
    );

    expect(outcome.effect).toMatchObject({ kind: "comment", ok: true });
    const id = (outcome.result as { annotation_id: string }).annotation_id;
    const rec = modelMap.get(id) as Annotation;

    // Asserted against literals, and specifically the fields ONLY this caller
    // supplies — a shared-helper regression drops them on both paths at once,
    // so comparing the two paths to each other could not see it.
    expect(rec.author).toBe("claude");
    expect(rec.type).toBe("comment");
    expect(rec.audience).toBe("outbound");
    expect(rec.status).toBe("pending");
    expect(rec.rev).toBe(1);
    expect(rec.content).toBe("vivid");
    expect(rec.textSnapshot).toBe("quick brown fox");
    expect(rec.agentIdentity).toStrictEqual({
      provider: "local-ollama",
      displayName: "Test Model",
    });
  });

  it("propose_replacement carries suggestedText through the seam", () => {
    const modelDoc = makeDoc("The quick brown fox jumps over the lazy dog.");
    const modelMap = getAnnotationsMap(modelDoc);

    const outcome = dispatch(
      "propose_replacement",
      { quoted_text: "lazy dog", suggested_text: "sleeping hound", rationale: "clearer" },
      { ydoc: modelDoc, isLicenseRestricted: () => false },
    );

    expect(outcome.effect).toMatchObject({ kind: "replacement", ok: true });
    const id = (outcome.result as { annotation_id: string }).annotation_id;
    const rec = modelMap.get(id) as Annotation;
    expect(rec.suggestedText).toBe("sleeping hound");
    expect(rec.content).toBe("clearer");
    expect(rec.type).toBe("comment");
  });

  it("the license gate still refuses a create before the lifecycle is reached", () => {
    // The gate is name-keyed and sits above the dispatch switch. The lifecycle
    // carries no gate of its own, so that ordering is what keeps Critical Rule
    // 9 true for the local-model half: moving the check below the switch, or
    // building the creator in a way that skipped it, would be invisible without
    // this.
    const modelDoc = makeDoc("The quick brown fox jumps over the lazy dog.");
    const outcome = dispatch(
      "comment_on_quote",
      { quoted_text: "quick brown fox", comment: "vivid" },
      { ydoc: modelDoc, isLicenseRestricted: () => true },
    );

    expect(outcome.effect).toStrictEqual({ kind: "blocked", tool: "comment_on_quote" });
    expect(getAnnotationsMap(modelDoc).size).toBe(0);
  });
});
