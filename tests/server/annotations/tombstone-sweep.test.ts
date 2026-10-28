/**
 * Tests for `cleanupStaleTombstones` (#318): compact tombstones from CLOSED
 * docs only, gated on the SESSION_MAX_AGE retention horizon, with an open-doc
 * guard so an open document's in-memory ledger is never contradicted by a disk
 * rewrite.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../../src/server/notifications.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, pushNotification: vi.fn() };
});

import { docHash } from "../../../src/server/annotations/doc-hash.js";
import { type AnnotationDocV1, SCHEMA_VERSION } from "../../../src/server/annotations/schema.js";
import { resetForTesting as resetStoreForTesting } from "../../../src/server/annotations/store.js";
import { importAnnotationId, importReplyId } from "../../../src/server/file-io/docx-comments.js";
import {
  cleanupOrphanedAnnotationFiles,
  cleanupStaleTombstones,
  isDeterministicAnnotationId,
} from "../../../src/server/session/manager.js";
import { SESSION_MAX_AGE } from "../../../src/shared/constants.js";
import { generateAnnotationId, generateReplyId } from "../../../src/shared/utils.js";
import { annRecord } from "../../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnvWithFlag } from "../../helpers/annotation-store-env.js";

const env = useTmpAnnotationsEnvWithFlag("tandem-tombstone-sweep-");

function annotationsDir(): string {
  return path.join(env.tmpRoot, "annotations");
}

async function writeEnvelope(envelope: AnnotationDocV1): Promise<void> {
  const dir = annotationsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${envelope.docHash}.json`), JSON.stringify(envelope), "utf-8");
}

async function readEnvelope(hash: string): Promise<AnnotationDocV1 | null> {
  try {
    const raw = await fs.readFile(path.join(annotationsDir(), `${hash}.json`), "utf-8");
    return JSON.parse(raw) as AnnotationDocV1;
  } catch {
    return null;
  }
}

const FILE = "/virtual/swept.md";
const HASH = docHash(FILE);
const NOW = Date.now();

function envelopeWithTombstones(
  hash: string,
  filePath: string,
  tombstones: AnnotationDocV1["tombstones"],
): AnnotationDocV1 {
  return {
    schemaVersion: SCHEMA_VERSION,
    docHash: hash,
    meta: { filePath, lastUpdated: NOW },
    annotations: [annRecord({ id: "ann_alive", rev: 1 })],
    tombstones,
    replies: [],
  };
}

beforeEach(() => {
  resetStoreForTesting();
});

afterEach(() => {
  resetStoreForTesting();
});

describe("cleanupStaleTombstones", () => {
  it("drops tombstones older than SESSION_MAX_AGE and keeps fresh ones", async () => {
    await writeEnvelope(
      envelopeWithTombstones(HASH, FILE, [
        { id: "stale", rev: 2, deletedAt: NOW - SESSION_MAX_AGE - 60_000 },
        { id: "fresh", rev: 2, deletedAt: NOW - 1_000 },
      ]),
    );

    const compacted = await cleanupStaleTombstones(new Set());
    expect(compacted).toBe(1);

    const envelope = await readEnvelope(HASH);
    expect(envelope?.tombstones.map((t) => t.id)).toEqual(["fresh"]);
    expect(envelope?.annotations).toHaveLength(1); // annotations untouched
  });

  it("respects the open-doc guard (never mutates an open doc's envelope)", async () => {
    await writeEnvelope(
      envelopeWithTombstones(HASH, FILE, [
        { id: "stale", rev: 2, deletedAt: NOW - SESSION_MAX_AGE - 60_000 },
      ]),
    );

    // Mark this doc's hash as open → sweep must skip it.
    const compacted = await cleanupStaleTombstones(new Set([HASH]));
    expect(compacted).toBe(0);

    const envelope = await readEnvelope(HASH);
    expect(envelope?.tombstones.map((t) => t.id)).toEqual(["stale"]);
  });

  it("leaves envelopes with only fresh tombstones untouched (no rewrite)", async () => {
    await writeEnvelope(
      envelopeWithTombstones(HASH, FILE, [{ id: "fresh", rev: 2, deletedAt: NOW - 1_000 }]),
    );

    const compacted = await cleanupStaleTombstones(new Set());
    expect(compacted).toBe(0);

    const envelope = await readEnvelope(HASH);
    expect(envelope?.tombstones.map((t) => t.id)).toEqual(["fresh"]);
  });

  it("is a no-op when there are no annotation files", async () => {
    const compacted = await cleanupStaleTombstones(new Set());
    expect(compacted).toBe(0);
  });
});

describe("cleanupStaleTombstones — partially-readable envelope (#1791)", () => {
  it("leaves a partially-tolerated envelope byte-for-byte untouched", async () => {
    // Since #1791(a) an envelope with one unreadable row parses `ok` with a
    // PARTIAL doc. `cleanupStaleTombstones` rebuilds and flushes the whole
    // envelope, so rewriting one would durably delete the unreadable row.
    const dir = annotationsDir();
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${HASH}.json`);
    const envelope = {
      ...envelopeWithTombstones(HASH, FILE, [
        { id: "stale", rev: 2, deletedAt: NOW - SESSION_MAX_AGE - 60_000 },
      ]),
      annotations: [
        annRecord({ id: "ann_alive", rev: 1 }),
        { ...annRecord({ id: "ann_future", rev: 1 }), type: "suggestion" },
      ],
    };
    const bytes = JSON.stringify(envelope);
    await fs.writeFile(target, bytes, "utf-8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const compacted = await cleanupStaleTombstones(new Set());
    errorSpy.mockRestore();

    expect(compacted).toBe(0);
    expect(await fs.readFile(target, "utf-8")).toBe(bytes);
  });
});

describe("cleanupStaleTombstones — deterministic ids survive compaction (#2009)", () => {
  const STALE = NOW - SESSION_MAX_AGE - 60_000;
  const IMPORT_ID = importAnnotationId("1", 0, 5, "body");
  const IMPORT_REPLY_ID = importReplyId("1", "2", "reply body");

  it("keeps stale tutorial-/import- tombstones and still drops a stale random id", async () => {
    await writeEnvelope(
      envelopeWithTombstones(HASH, FILE, [
        { id: "tutorial-comment-1", rev: 3, deletedAt: STALE },
        { id: IMPORT_ID, rev: 4, deletedAt: STALE - 1 },
        { id: IMPORT_REPLY_ID, rev: 5, deletedAt: STALE - 2 },
        { id: "ann_x", rev: 2, deletedAt: STALE },
      ]),
    );

    const compacted = await cleanupStaleTombstones(new Set());
    expect(compacted).toBe(1);

    const envelope = await readEnvelope(HASH);
    expect(envelope?.tombstones).toEqual([
      { id: "tutorial-comment-1", rev: 3, deletedAt: STALE },
      { id: IMPORT_ID, rev: 4, deletedAt: STALE - 1 },
      { id: IMPORT_REPLY_ID, rev: 5, deletedAt: STALE - 2 },
    ]);
  });

  it("does not rewrite an envelope whose only stale tombstones are exempt", async () => {
    await writeEnvelope(
      envelopeWithTombstones(HASH, FILE, [
        { id: "tutorial-highlight-1", rev: 2, deletedAt: STALE },
        { id: IMPORT_ID, rev: 2, deletedAt: STALE },
      ]),
    );
    const target = path.join(annotationsDir(), `${HASH}.json`);
    const before = await fs.readFile(target, "utf-8");

    expect(await cleanupStaleTombstones(new Set())).toBe(0);
    expect(await fs.readFile(target, "utf-8")).toBe(before);
  });

  it("anchors on the prefix: an id merely containing one is still compacted", async () => {
    await writeEnvelope(
      envelopeWithTombstones(HASH, FILE, [
        { id: "ann_tutorial-1", rev: 2, deletedAt: STALE },
        { id: "xtutorial-1", rev: 2, deletedAt: STALE },
        { id: "rpl_import-1", rev: 2, deletedAt: STALE },
      ]),
    );

    expect(await cleanupStaleTombstones(new Set())).toBe(1);
    expect((await readEnvelope(HASH))?.tombstones).toEqual([]);
  });

  it("matches the real deterministic generators and never a random one", () => {
    // Pinned against the producers, so a prefix rename on either side fails
    // here rather than silently making those tombstones compactable again —
    // or making every random tombstone immortal.
    expect(isDeterministicAnnotationId(IMPORT_ID)).toBe(true);
    expect(isDeterministicAnnotationId(IMPORT_REPLY_ID)).toBe(true);
    expect(isDeterministicAnnotationId("tutorial-note-1")).toBe(true);
    expect(isDeterministicAnnotationId(generateAnnotationId())).toBe(false);
    expect(isDeterministicAnnotationId(generateReplyId())).toBe(false);
  });

  it("CHARACTERIZATION (#2009 open half): the orphan sweep still unlinks a whole stale envelope, exempt tombstones included", async () => {
    // The exemption above only holds while the envelope survives. An envelope
    // nobody wrote for SESSION_MAX_AGE — the usual case for a welcome.md whose
    // seeds were deleted once — is unlinked whole by the orphan sweep, which
    // runs before compaction, and the tutorial seeds re-inject on the next
    // open. Closing that needs a retention decision (#2009); flip this spec
    // when it lands.
    await writeEnvelope(
      envelopeWithTombstones(HASH, FILE, [{ id: "tutorial-comment-1", rev: 2, deletedAt: STALE }]),
    );
    const target = path.join(annotationsDir(), `${HASH}.json`);
    const old = new Date(STALE);
    await fs.utimes(target, old, old);

    const result = await cleanupOrphanedAnnotationFiles();
    expect(result.cleaned).toBe(1);
    expect(await readEnvelope(HASH)).toBeNull();
  });
});
