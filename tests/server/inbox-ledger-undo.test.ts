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

function poll(surfaced: Map<string, number>) {
  const all = [...map().values()] as Annotation[];
  return processInboxAnnotations(
    all,
    TEXT,
    surfaced,
    (a) => a,
    DOC_ID,
    "tandem",
    () => false,
  );
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
