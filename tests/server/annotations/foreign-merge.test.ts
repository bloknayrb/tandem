/**
 * The two merges #2400 added to `annotations/sync.ts`, as units:
 * `mergeForeignEnvelope` (an envelope stored under another key) and
 * `mergeSessionRecords` (the records of a saved session that is being retired),
 * with `readSessionRecords`. Pure Y.Doc + in-memory ledger; no filesystem.
 *
 * `mergeForeignEnvelope` must give the outcome `loadAndMerge` gives its own
 * file. `mergeSessionRecords` is deliberately stricter against tombstones.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getTombstones,
  mergeForeignEnvelope,
  mergeSessionRecords,
  readSessionRecords,
  resetForTesting,
} from "../../../src/server/annotations/sync.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";
import { FILE_SYNC_ORIGIN, withInternal } from "../../../src/shared/origins.js";
import { annRecord, HASH_A, replyRecord } from "../../helpers/annotation-fixtures.js";

let doc: Y.Doc;
const anns = () => doc.getMap(Y_MAP_ANNOTATIONS);
const reps = () => doc.getMap(Y_MAP_ANNOTATION_REPLIES);
const stone = (id: string, rev: number, deletedAt = 1_000) => ({ id, rev, deletedAt });

function seed(records: ReturnType<typeof annRecord>[]): void {
  withInternal(doc, () => {
    for (const r of records) anns().set(r.id, r);
  });
}

beforeEach(() => {
  resetForTesting();
  doc = new Y.Doc();
});

afterEach(() => {
  doc.destroy();
  resetForTesting();
});

describe("mergeForeignEnvelope", () => {
  it("inserts absent records, lets the higher rev win, and reports what it wrote", () => {
    seed([
      annRecord({ id: "live_higher", rev: 5, content: "live" }),
      annRecord({ id: "file_higher", rev: 1, content: "live" }),
    ]);
    const result = mergeForeignEnvelope(
      doc,
      {
        annotations: [
          annRecord({ id: "live_higher", rev: 2, content: "file" }),
          annRecord({ id: "file_higher", rev: 4, content: "file" }),
          annRecord({ id: "absent", rev: 0, content: "file" }),
        ],
        replies: [replyRecord({ id: "rep_new", annotationId: "absent" })],
        tombstones: [],
      },
      HASH_A,
    );
    expect((anns().get("live_higher") as { content: string }).content).toBe("live");
    expect((anns().get("file_higher") as { content: string }).content).toBe("file");
    expect(anns().has("absent")).toBe(true);
    expect(reps().has("rep_new")).toBe(true);
    expect([...result.annotationIds].sort()).toEqual(["absent", "file_higher"]);
    expect([...result.replyIds]).toEqual(["rep_new"]);
  });

  it("a file tombstone deletes a live record it outranks, and leaves a resurrection alone", () => {
    seed([annRecord({ id: "killed", rev: 1 }), annRecord({ id: "resurrected", rev: 7 })]);
    mergeForeignEnvelope(
      doc,
      { annotations: [], replies: [], tombstones: [stone("killed", 3), stone("resurrected", 3)] },
      HASH_A,
    );
    expect(anns().has("killed")).toBe(false);
    expect(anns().has("resurrected")).toBe(true);
    expect(
      getTombstones(HASH_A)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["killed", "resurrected"]);
  });

  it("does not insert a file record that a tombstone outranks, from the file or from the ledger", () => {
    // A tombstone already in the ledger for this document (the new side's).
    mergeForeignEnvelope(
      doc,
      { annotations: [], replies: [], tombstones: [stone("ledgered", 4)] },
      HASH_A,
    );
    const result = mergeForeignEnvelope(
      doc,
      {
        annotations: [
          annRecord({ id: "ledgered", rev: 2 }),
          annRecord({ id: "own_stone", rev: 1 }),
          annRecord({ id: "outranks_stone", rev: 9 }),
        ],
        replies: [],
        tombstones: [stone("own_stone", 2), stone("outranks_stone", 3)],
      },
      HASH_A,
    );
    expect(anns().has("ledgered")).toBe(false);
    expect(anns().has("own_stone")).toBe(false);
    expect(anns().has("outranks_stone")).toBe(true);
    expect([...result.annotationIds]).toEqual(["outranks_stone"]);
  });

  it("unions tombstones by rev, and on a rev tie keeps the later deletedAt", () => {
    mergeForeignEnvelope(
      doc,
      {
        annotations: [],
        replies: [],
        tombstones: [stone("tie", 2, 100), stone("lower_first", 1, 500)],
      },
      HASH_A,
    );
    mergeForeignEnvelope(
      doc,
      {
        annotations: [],
        replies: [],
        tombstones: [stone("tie", 2, 900), stone("lower_first", 3, 50), stone("tie_older", 5, 10)],
      },
      HASH_A,
    );
    mergeForeignEnvelope(
      doc,
      {
        annotations: [],
        replies: [],
        tombstones: [stone("tie_older", 5, 5), stone("tie", 1, 9999)],
      },
      HASH_A,
    );
    const ledger = new Map(getTombstones(HASH_A).map((t) => [t.id, t]));
    expect(ledger.get("tie")).toMatchObject({ rev: 2, deletedAt: 900 });
    expect(ledger.get("lower_first")).toMatchObject({ rev: 3, deletedAt: 50 });
    expect(ledger.get("tie_older")).toMatchObject({ rev: 5, deletedAt: 10 });
  });

  it("writes under the file-sync origin only: no other origin is seen by an observer", () => {
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr) => origins.push(tr.origin));
    mergeForeignEnvelope(
      doc,
      { annotations: [annRecord({ id: "a", rev: 1 })], replies: [], tombstones: [] },
      HASH_A,
    );
    expect(origins).toEqual([FILE_SYNC_ORIGIN]);
  });
});

describe("readSessionRecords", () => {
  it("normalises records, reads a missing rev as 0, and drops what cannot be a record", () => {
    const scratch = new Y.Doc();
    withInternal(scratch, () => {
      const a = scratch.getMap(Y_MAP_ANNOTATIONS);
      a.set("good", annRecord({ id: "good", rev: 2 }));
      const { rev: _rev, ...noRev } = annRecord({ id: "no_rev" });
      a.set("no_rev", noRev);
      a.set("junk", "not an object");
      a.set("no_id", { type: "comment", rev: 1 });
      const r = scratch.getMap(Y_MAP_ANNOTATION_REPLIES);
      r.set("rep_ok", replyRecord({ id: "rep_ok", annotationId: "good" }));
      r.set("rep_bad", { id: "rep_bad" });
      r.set("rep_junk", 42);
    });
    const records = readSessionRecords(scratch, HASH_A);
    expect(records.annotations.map((a) => [a.id, a.rev]).sort()).toEqual([
      ["good", 2],
      ["no_rev", 0],
    ]);
    expect(records.replies.map((r) => r.id)).toEqual(["rep_ok"]);
    scratch.destroy();
  });
});

describe("mergeSessionRecords", () => {
  it("inserts what is absent, replaces only on a strictly higher rev, and never beats a tombstone at or above it", () => {
    seed([
      annRecord({ id: "live_same", rev: 2, content: "live" }),
      annRecord({ id: "live_lower", rev: 1, content: "live" }),
    ]);
    // One tombstone in the ledger, one passed explicitly (the old envelope's,
    // for a document that is not wired).
    mergeForeignEnvelope(
      doc,
      { annotations: [], replies: [], tombstones: [stone("ledger_tie", 3)] },
      HASH_A,
    );
    const result = mergeSessionRecords(
      doc,
      {
        annotations: [
          annRecord({ id: "live_same", rev: 2, content: "session" }),
          annRecord({ id: "live_lower", rev: 6, content: "session" }),
          annRecord({ id: "fresh", rev: 0, content: "session" }),
          // A stale session copy never beats a tombstone, even at the same rev
          // (the envelope merge would let a rev tie through).
          annRecord({ id: "ledger_tie", rev: 3, content: "session" }),
          annRecord({ id: "extra_stone", rev: 1, content: "session" }),
          annRecord({ id: "above_stone", rev: 5, content: "session" }),
        ],
        replies: [
          replyRecord({ id: "rep_on_fresh", annotationId: "fresh" }),
          replyRecord({ id: "rep_orphan", annotationId: "extra_stone" }),
        ],
      },
      HASH_A,
      [stone("extra_stone", 4), stone("above_stone", 2), stone("above_stone", 1)],
    );
    expect((anns().get("live_same") as { content: string }).content).toBe("live");
    expect((anns().get("live_lower") as { content: string }).content).toBe("session");
    expect(anns().has("fresh")).toBe(true);
    expect(anns().has("ledger_tie")).toBe(false);
    expect(anns().has("extra_stone")).toBe(false);
    expect(anns().has("above_stone")).toBe(true);
    expect([...result.annotationIds].sort()).toEqual(["above_stone", "fresh", "live_lower"]);
    // A reply is inserted only when its parent is live afterwards.
    expect(reps().has("rep_on_fresh")).toBe(true);
    expect(reps().has("rep_orphan")).toBe(false);
    expect([...result.replyIds]).toEqual(["rep_on_fresh"]);
  });

  it("leaves an existing reply alone and replaces a live record it cannot read", () => {
    withInternal(doc, () => {
      anns().set("parent", annRecord({ id: "parent", rev: 1 }));
      anns().set("unreadable", "garbage");
      reps().set("rep_1", replyRecord({ id: "rep_1", annotationId: "parent", text: "live" }));
    });
    const result = mergeSessionRecords(
      doc,
      {
        annotations: [annRecord({ id: "unreadable", rev: 0 })],
        replies: [replyRecord({ id: "rep_1", annotationId: "parent", text: "session" })],
      },
      HASH_A,
    );
    expect((reps().get("rep_1") as { text: string }).text).toBe("live");
    expect((anns().get("unreadable") as { id: string }).id).toBe("unreadable");
    expect([...result.annotationIds]).toEqual(["unreadable"]);
    expect(result.replyIds.size).toBe(0);
  });
});
