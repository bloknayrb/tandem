/**
 * #1770 item 3 — a decision made after an Undo never reached Claude.
 *
 * The inbox ledger keyed on `editedAt` alone, and the client's Undo writes
 * `status: "pending"` without touching it (`useAnnotationReview.svelte.ts`). So
 * the sequence accept → poll → undo → dismiss → poll returned
 * `userResponses: []`: the id had already been surfaced at a
 * newer-or-equal `editedAt`, and the dismissal was silently dropped forever.
 *
 * `inboxLedgerKey` now appends the status for CLAUDE-authored records, so the
 * dismissed record is a fresh key. Not `rev` — neither the client's resolve nor
 * its undo write bumps it. User comments keep the bare-id key: their bucket is
 * `userActions`, whose whole re-surface rule is the `editedAt` comparison.
 *
 * Supersedes `docs/reviews/2026-09-02-v1-review/experiments/harness/g-inbox-ledger.test.ts`'s
 * first case; that file's second case is #1826's and stays there.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { processInboxAnnotations } from "../../src/server/mcp/awareness.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";
import type { Annotation } from "../../src/shared/types.js";

const DOC_ID = "inbox-ledger-doc";
const TEXT = "hello world";

let doc: Y.Doc;

function map(): Y.Map<unknown> {
  return doc.getMap(Y_MAP_ANNOTATIONS);
}

/**
 * A Claude-authored, OUTBOUND comment carrying no `resolvedBy` — the record the
 * user is deciding on. Both fixture rules matter: after #1619 a non-outbound
 * record would not surface on the first poll at all, and a `resolvedBy: "claude"`
 * one is excluded from `userResponses` by design.
 */
function seedClaudeComment(id: string, extra: Record<string, unknown> = {}): Annotation {
  const ann = {
    id,
    author: "claude",
    type: "comment",
    audience: "outbound",
    range: { from: 0, to: 5 },
    content: "consider this",
    status: "pending",
    timestamp: 1,
    rev: 1,
    ...extra,
  } as unknown as Annotation;
  withBrowser(doc, () => map().set(id, ann));
  return ann;
}

/**
 * The USER's decision, written in the BROWSER shape — `map.set(id, {...ann,
 * status})`, mirroring `useAnnotationReview.svelte.ts`. Never through
 * `store.acceptAnnotation` / `dismissAnnotation`, which since #1770 stamp
 * `resolvedBy: "claude"` and would be excluded from `userResponses` by design,
 * making this whole spec assert nothing.
 */
function userDecides(id: string, status: Annotation["status"]): void {
  withBrowser(doc, () => map().set(id, { ...(map().get(id) as Annotation), status }));
}

/**
 * `refreshAll` is the identity by default. Pass a spy to assert WHICH records
 * reach it — in production it is `YDocStore.refreshAnnotations`, a `withMcp`
 * transaction over `refreshAllRanges` that persists range repairs, so the
 * candidate set is a cost as well as a selection.
 */
function poll(
  surfaced: Map<string, number>,
  refreshAll: (anns: Annotation[]) => Annotation[] = (a) => a,
) {
  const all = [...map().values()] as Annotation[];
  return processInboxAnnotations(all, TEXT, surfaced, refreshAll, DOC_ID, "tandem", () => false);
}

beforeEach(() => {
  doc = new Y.Doc();
});

describe("the inbox ledger surfaces a decision made after Undo (#1770)", () => {
  it("accept → poll → undo → dismiss → poll returns the dismissal", () => {
    const surfaced = new Map<string, number>();
    seedClaudeComment("c1");

    userDecides("c1", "accepted");
    expect(poll(surfaced).userResponses.map((a) => a.status)).toEqual(["accepted"]);

    // Undo, then Dismiss. Neither write touches `editedAt` or `rev`.
    userDecides("c1", "pending");
    userDecides("c1", "dismissed");

    expect(poll(surfaced).userResponses.map((a) => a.status)).toEqual(["dismissed"]);
  });

  it("still dedups: a second poll with no status change returns nothing", () => {
    // **The row that discriminates a status-keyed ledger from NO ledger at all.**
    // An implementation that simply stopped writing the ledger for
    // Claude-authored records passes every other row here — and
    // `awareness-tools.test.ts`'s only dedup pin seeds `author: "user"`, which
    // keeps the base key — while re-surfacing the same decision to Claude on
    // every poll forever.
    const surfaced = new Map<string, number>();
    seedClaudeComment("c2");
    userDecides("c2", "accepted");

    const first = poll(surfaced);
    expect(first.userResponses.map((a) => a.id)).toEqual(["c2"]);
    expect([...surfaced.keys()], "the first poll WROTE a ledger entry, keyed by id#status").toEqual(
      [`${DOC_ID}:c2#accepted`],
    );

    expect(poll(surfaced).userResponses).toEqual([]);
  });

  it("a record Claude resolved never enters userResponses and writes no ledger entry", () => {
    const surfaced = new Map<string, number>();
    seedClaudeComment("c3", { status: "dismissed", resolvedBy: "claude" });

    expect(poll(surfaced).userResponses).toEqual([]);
    expect([...surfaced.keys()], "and the ledger is untouched").toEqual([]);
  });

  it("a user comment Claude dismissed is not re-surfaced as a userAction", () => {
    // Kills a status key applied to EVERY author: a user comment already
    // surfaced would come back as a fresh key the moment its status changed.
    const surfaced = new Map<string, number>();
    withBrowser(doc, () =>
      map().set("u1", {
        id: "u1",
        author: "user",
        type: "comment",
        audience: "outbound",
        range: { from: 0, to: 5 },
        content: "please fix",
        status: "pending",
        timestamp: 1,
        rev: 1,
      }),
    );

    expect(poll(surfaced).userActions.map((a) => a.id)).toEqual(["u1"]);

    withBrowser(doc, () =>
      map().set("u1", {
        ...(map().get("u1") as Annotation),
        status: "dismissed",
        resolvedBy: "claude",
      }),
    );

    expect(poll(surfaced).userActions).toEqual([]);
  });
});

/**
 * #1826 item 2 — the `userActions` bucket had no status gate.
 *
 * The user arm admitted `author === "user" && type === "comment" &&
 * isClaudeFacing(ann)` with no `status` test, while the Claude arm beside it
 * tested `status !== "pending"`. `surfacedIds` is a module-level Map, so every
 * server restart re-surfaced every RESOLVED user comment as a fresh user action.
 *
 * The gate is `status === "pending" || edited`, written positively. `|| edited`
 * holds within one server run only and is what stops the gate creating item 1's
 * own defect class on the edit path — the observer emits `annotation:edited` on
 * any `editedAt` advance with no status test.
 */
describe("#1826: the userActions bucket has a status gate", () => {
  /** A user comment in the browser shape, with an explicit status. */
  function seedUserComment(id: string, extra: Record<string, unknown> = {}): void {
    withBrowser(doc, () =>
      map().set(id, {
        id,
        author: "user",
        type: "comment",
        audience: "outbound",
        range: { from: 0, to: 5 },
        content: "please fix",
        status: "pending",
        timestamp: 1,
        rev: 1,
        ...extra,
      }),
    );
  }

  it.each([
    "dismissed",
    "accepted",
  ] as const)("a %s user comment never surfaced while pending yields no userAction", (status) => {
    // A fresh ledger IS the restart. Both rows are red on master.
    //
    // The `accepted` row is what separates the specified gate from a lazy
    // `status !== "dismissed"`: `transitionPending` refuses an accept only for
    // a claude author or a suggestion-bearing record, so an outbound user
    // comment really can end up `{accepted, resolvedBy: "claude"}` — which is
    // the fixture below.
    const surfaced = new Map<string, number>();
    seedUserComment("u-resolved", {
      status,
      ...(status === "accepted" ? { resolvedBy: "claude" } : {}),
    });

    expect(poll(surfaced).userActions).toEqual([]);
    expect([...surfaced.keys()], "and no ledger entry is written").toEqual([]);
  });

  it("the identical record at `pending` still yields one userAction (control)", () => {
    // Without this, a gate that empties the bucket outright passes every row.
    const surfaced = new Map<string, number>();
    seedUserComment("u-pending");

    expect(poll(surfaced).userActions.map((a) => a.id)).toEqual(["u-pending"]);
  });

  it("an edit after a dismiss still surfaces, having never been surfaced", () => {
    // **Review round 1.** The gate's escape hatch was `edited`, which requires
    // a prior ledger entry — and a record rejected by the gate takes no
    // `surfaced.set`, so a comment resolved before it was ever surfaced could
    // never acquire one. No restart involved: Claude learns of the comment from
    // `tandem_getAnnotations` or the channel, calls `tandem_resolveAnnotation`,
    // and never polls. The user's later edit then reached the channel as
    // `annotation:edited` and `tandem_checkInbox` — the documented authority —
    // returned nothing, for the life of the process.
    const surfaced = new Map<string, number>();
    seedUserComment("u-never-surfaced", { status: "dismissed", editedAt: 500 });

    const first = poll(surfaced).userActions;
    expect(first.map((a) => a.id)).toEqual(["u-never-surfaced"]);
    // ...and NOT flagged `edited`: that field claims "you were shown this and
    // it changed since", which is false here. A fix that widens the flag itself
    // instead of splitting gate from flag turns this row red.
    expect(first[0].edited).toBeUndefined();

    // The ledger entry the surfacing wrote is what stops it repeating.
    expect(poll(surfaced).userActions).toEqual([]);
  });

  it("an edit after a dismiss still surfaces, within the same server run", () => {
    // The 2a row: green on master and after the fix, RED against a bare
    // `status === "pending"` gate. Its job is to stop the gate being narrowed
    // later — the observer emits `annotation:edited` on any `editedAt` advance
    // with no status test, so dropping the edit term would push on the channel
    // while `tandem_checkInbox` returned nothing.
    const surfaced = new Map<string, number>();
    seedUserComment("u-edited");

    expect(poll(surfaced).userActions.map((a) => a.id)).toEqual(["u-edited"]);

    withBrowser(doc, () =>
      map().set("u-edited", {
        ...(map().get("u-edited") as Annotation),
        status: "dismissed",
        editedAt: 500,
      }),
    );

    const second = poll(surfaced).userActions;
    expect(second.map((a) => a.id)).toEqual(["u-edited"]);
    expect(second[0].edited).toBe(true);
  });

  it("a resolved user comment stops being handed to refreshAll", () => {
    // **Review round 1.** A record the status gate rejects takes no
    // `surfaced.set`, so nothing removes it from the candidate set: on master
    // it surfaced once, got a ledger entry and left, and with the gate alone it
    // would be re-selected and re-refreshed on every poll forever —
    // `store.refreshAnnotations` in production, a `withMcp` transaction over
    // `refreshAllRanges` that persists range repairs. The candidates filter
    // mirrors the gate to close that.
    const surfaced = new Map<string, number>();
    seedUserComment("u-settled", { status: "dismissed" });
    seedUserComment("u-live");

    const refreshed: string[][] = [];
    const spy = (anns: Annotation[]) => {
      refreshed.push(anns.map((a) => a.id));
      return anns;
    };

    expect(poll(surfaced, spy).userActions.map((a) => a.id)).toEqual(["u-live"]);
    // The dismissed comment never reaches the refresher, on this poll or any
    // later one; the pending one leaves via its ledger entry, as it always did.
    expect(refreshed).toEqual([["u-live"]]);

    poll(surfaced, spy);
    poll(surfaced, spy);
    expect(refreshed).toEqual([["u-live"], [], []]);
  });
});
