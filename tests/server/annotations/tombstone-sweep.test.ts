/**
 * Tests for `cleanupStaleTombstones` (#318): compact tombstones from CLOSED
 * docs only, gated on the SESSION_MAX_AGE retention horizon, with an open-doc
 * guard so an open document's in-memory ledger is never contradicted by a disk
 * rewrite.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, pushNotification: vi.fn() };
});

import { docHash } from "../../../src/server/annotations/doc-hash.js";
import { type AnnotationDocV1, SCHEMA_VERSION } from "../../../src/server/annotations/schema.js";
import { resetForTesting as resetStoreForTesting } from "../../../src/server/annotations/store.js";
import { cleanupStaleTombstones } from "../../../src/server/session/manager.js";
import { SESSION_MAX_AGE } from "../../../src/shared/constants.js";
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
