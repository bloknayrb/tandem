/**
 * NEW-BEHAVIOUR tests for the key-identity reconciler (`key-identity.ts`).
 *
 * A record stored under key K with a stale `id: X` is repaired to `id: K`, and
 * before that every user reply filed under X is stamped `private`: an older
 * client posted X from K's card, so a note-thread reply may sit under the
 * comment at X, and once K is repaired nothing would mark it ambiguous again.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  attachKeyIdentityObserver,
  copyAliasLedger,
  dropAliasLedger,
  getAliasLedger,
  type ReconciledDoc,
  reconcileAnnotationKeys,
  reconciledRepliesMap,
} from "../../../src/server/annotations/key-identity.js";
import { channelVisibleReplies } from "../../../src/server/mcp/annotations.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../../src/shared/origins.js";
import type { Annotation, AnnotationReply } from "../../../src/shared/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet(): void {
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

const COMMENT_X = {
  id: "X",
  author: "claude",
  type: "comment",
  audience: "outbound",
  range: { from: 0, to: 5 },
  content: "the real comment at X",
  status: "pending",
  timestamp: 1_700_000_000_000,
  rev: 1,
};

/** A private note stored under key K whose stored id is X (an alias). */
const NOTE_K_AS_X = {
  id: "X",
  author: "user",
  type: "note",
  audience: "private",
  range: { from: 6, to: 11 },
  textSnapshot: "world",
  content: "a private note",
  status: "pending",
  timestamp: 1_700_000_500_000,
  rev: 3,
};

function reply(id: string, annotationId: string, extra: Partial<AnnotationReply> = {}) {
  return { id, annotationId, author: "user", text: `text of ${id}`, timestamp: 1, ...extra };
}

/**
 * A doc whose note K was stored as X beside the real comment X, and whose
 * older client filed the user's note-thread reply under X (non-private).
 */
function aliasedDoc(): Y.Doc {
  const doc = new Y.Doc();
  withInternal(doc, () => {
    doc.getMap(Y_MAP_ANNOTATIONS).set("X", { ...COMMENT_X });
    doc.getMap(Y_MAP_ANNOTATIONS).set("K", { ...NOTE_K_AS_X });
    const replies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    replies.set("r-note", reply("r-note", "X"));
    replies.set("r-claude", { ...reply("r-claude", "X"), author: "claude" });
    replies.set("r-on-k", reply("r-on-k", "K"));
  });
  return doc;
}

describe("reconcileAnnotationKeys", () => {
  it("quarantines user replies under the stale id, then repairs the record, in one transaction", () => {
    quiet();
    const doc = aliasedDoc();
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);

    reconcileAnnotationKeys(doc);

    expect(transactions).toBe(1);
    const replies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    expect(replies.get("r-note")).toMatchObject({ private: true, rev: 1 });
    // Claude's own reply and a reply filed under K's own key are untouched.
    expect((replies.get("r-claude") as { private?: boolean }).private).toBeUndefined();
    expect((replies.get("r-on-k") as { private?: boolean }).private).toBeUndefined();
    const k = doc.getMap(Y_MAP_ANNOTATIONS).get("K") as Record<string, unknown>;
    expect(k).toMatchObject({ id: "K", type: "note", content: "a private note", rev: 4 });
    // The record really stored at X is the same object as before.
    expect(doc.getMap(Y_MAP_ANNOTATIONS).get("X")).toMatchObject(COMMENT_X);
  });

  it("is idempotent: a reconciled document writes nothing", () => {
    quiet();
    const doc = aliasedDoc();
    reconcileAnnotationKeys(doc);
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);

    reconcileAnnotationKeys(doc);

    expect(transactions).toBe(0);
  });

  it("records the repair-time values in the alias ledger, copied (not moved) on a swap, dropped on close", () => {
    quiet();
    const doc = aliasedDoc();
    reconcileAnnotationKeys(doc);

    expect(getAliasLedger(doc)).toEqual([
      {
        key: "K",
        storedId: "X",
        timestamp: NOTE_K_AS_X.timestamp,
        textSnapshot: "world",
        commentId: undefined,
        type: "note",
      },
    ]);

    const next = new Y.Doc();
    copyAliasLedger(doc, next);
    expect(getAliasLedger(next)).toHaveLength(1);
    expect(getAliasLedger(doc)).toHaveLength(1);

    dropAliasLedger(doc);
    expect(getAliasLedger(doc)).toEqual([]);
    expect(getAliasLedger(next)).toHaveLength(1);
  });

  it("refuses to run inside a browser-origin transaction (its write would take that origin)", () => {
    const doc = aliasedDoc();
    expect(() => withBrowser(doc, () => reconcileAnnotationKeys(doc))).toThrow(
      /client transaction/,
    );
  });
});

describe("the reply gate only reads a reconciled document", () => {
  it("withholds the note-thread reply once reconciled, and never shows it on comment X", () => {
    quiet();
    const doc = aliasedDoc();
    const token = reconcileAnnotationKeys(doc);
    const comment = doc.getMap(Y_MAP_ANNOTATIONS).get("X") as Annotation;

    const visible = channelVisibleReplies(token, comment).map((r) => r.id);

    expect(visible).toEqual(["r-claude"]);
  });

  it("a token reads its own document's replies; a forged one is refused", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    withInternal(b, () => b.getMap(Y_MAP_ANNOTATION_REPLIES).set("rb", reply("rb", "X")));

    expect(reconciledRepliesMap(reconcileAnnotationKeys(a)).size).toBe(0);
    expect(reconciledRepliesMap(reconcileAnnotationKeys(b)).size).toBe(1);
    expect(() => reconciledRepliesMap({} as ReconciledDoc)).toThrow(/not a ReconciledDoc/);
  });
});

describe("attachKeyIdentityObserver", () => {
  it("repairs an alias the moment a browser write lands, and quarantines its replies", () => {
    quiet();
    const doc = new Y.Doc();
    withInternal(doc, () => {
      doc.getMap(Y_MAP_ANNOTATIONS).set("X", { ...COMMENT_X });
      doc.getMap(Y_MAP_ANNOTATION_REPLIES).set("r-note", reply("r-note", "X"));
    });
    const detach = attachKeyIdentityObserver(doc);

    withBrowser(doc, () => doc.getMap(Y_MAP_ANNOTATIONS).set("K", { ...NOTE_K_AS_X }));

    expect((doc.getMap(Y_MAP_ANNOTATIONS).get("K") as { id: string }).id).toBe("K");
    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).get("r-note")).toMatchObject({ private: true });
    detach();
  });

  it("scans existing state at attach time (a session restore that arrived first)", () => {
    quiet();
    const doc = aliasedDoc();
    const detach = attachKeyIdentityObserver(doc);
    expect((doc.getMap(Y_MAP_ANNOTATIONS).get("K") as { id: string }).id).toBe("K");
    detach();
  });

  it("ignores its own internal-origin repair, so it never loops", () => {
    quiet();
    const doc = new Y.Doc();
    const detach = attachKeyIdentityObserver(doc);
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);

    withBrowser(doc, () => doc.getMap(Y_MAP_ANNOTATIONS).set("K", { ...NOTE_K_AS_X }));

    // The browser write, then one repair. No further transaction.
    expect(transactions).toBe(2);
    detach();
  });
});
