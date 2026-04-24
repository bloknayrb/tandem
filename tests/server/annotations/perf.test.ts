/**
 * Baseline perf measurements for `loadAndMerge` at 500 / 1000 / 5000
 * annotations. See issue #335.
 *
 * What's measured: end-to-end `loadAndMerge` wall clock — file read, Zod
 * parse, and the merge transaction. The Y.Doc and on-disk envelope are
 * constructed BEFORE the `performance.now()` window so fixture setup isn't
 * part of the number, but the store's load + parse ARE.
 *
 * Scope: records a number, not a gate. Each test asserts only a hang
 * detector (< 10s) and logs the measurement so CI output carries the
 * baseline. Vitest timeout is 60s to catch catastrophic hangs without
 * failing a slow runner.
 *
 * Why not `bench()`? We want the number visible in every CI run, not
 * gated behind `vitest bench`.
 */

import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type AnnotationDocV1,
  type AnnotationRecordV1,
  SCHEMA_VERSION,
} from "../../../src/server/annotations/schema.js";
import {
  createStore,
  resetForTesting as resetStoreForTesting,
} from "../../../src/server/annotations/store.js";
import {
  loadAndMerge,
  resetForTesting as resetSyncForTesting,
} from "../../../src/server/annotations/sync.js";
import { Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";
import { writeEnvelopeToDisk } from "../../helpers/annotation-fixtures.js";
import { useTmpAnnotationsEnv } from "../../helpers/annotation-store-env.js";

const HASH = "b".repeat(64);
const FILE_PATH = "/virtual/perf-doc.md";

function makeAnnotation(i: number): AnnotationRecordV1 {
  return {
    id: `ann_${i}`,
    author: i % 2 === 0 ? "claude" : "user",
    type: i % 3 === 0 ? "highlight" : "comment",
    range: { from: i, to: i + 5 },
    content: `annotation ${i}`,
    status: "pending",
    timestamp: 1_700_000_000_000 + i,
    rev: 1,
  };
}

function makeEnvelope(count: number): AnnotationDocV1 {
  const annotations: AnnotationRecordV1[] = Array.from({ length: count }, (_, i) =>
    makeAnnotation(i),
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    docHash: HASH,
    meta: { filePath: FILE_PATH, lastUpdated: Date.now() },
    annotations,
    tombstones: [],
    replies: [],
  };
}

useTmpAnnotationsEnv("tandem-perf-test-");

beforeEach(() => {
  resetStoreForTesting();
  resetSyncForTesting();
});

afterEach(() => {
  resetStoreForTesting();
  resetSyncForTesting();
});

async function measureLoadAndMerge(count: number): Promise<number> {
  const envelope = makeEnvelope(count);
  await writeEnvelopeToDisk(envelope);

  const ydoc = new Y.Doc();
  const store = createStore(HASH, { filePath: FILE_PATH });

  // Measure only the merge — fixture I/O already complete.
  const start = performance.now();
  const cleanup = await loadAndMerge({
    ydoc,
    store,
    docHash: HASH,
    meta: { filePath: FILE_PATH },
  });
  const elapsedMs = performance.now() - start;
  cleanup();

  return elapsedMs;
}

async function measureLoadAndMergeWithConflicts(count: number): Promise<number> {
  const envelope = makeEnvelope(count);
  await writeEnvelopeToDisk(envelope);

  const ydoc = new Y.Doc();
  const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);
  // Pre-populate half the ids at rev 0 — file's rev 1 wins, forcing
  // pickWinner + ymap.set for every conflicting annotation.
  ydoc.transact(() => {
    for (let i = 0; i < Math.floor(count / 2); i++) {
      annMap.set(`ann_${i}`, { ...makeAnnotation(i), rev: 0 });
    }
  });
  const store = createStore(HASH, { filePath: FILE_PATH });

  const start = performance.now();
  const cleanup = await loadAndMerge({ ydoc, store, docHash: HASH, meta: { filePath: FILE_PATH } });
  const elapsedMs = performance.now() - start;
  cleanup();
  return elapsedMs;
}

describe("loadAndMerge perf baseline (#335)", () => {
  // 60s is a hang detector; < 10s is the ridiculous-ceiling assertion.
  // The goal is a recorded number in CI output, not an enforced budget.
  it("500 annotations completes under 10s", { timeout: 60_000 }, async () => {
    const elapsedMs = await measureLoadAndMerge(500);
    console.log(`[perf] loadAndMerge(500) = ${elapsedMs.toFixed(1)}ms`);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it("1000 annotations completes under 10s", { timeout: 60_000 }, async () => {
    const elapsedMs = await measureLoadAndMerge(1000);
    console.log(`[perf] loadAndMerge(1000) = ${elapsedMs.toFixed(1)}ms`);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it("5000 annotations completes under 10s", { timeout: 60_000 }, async () => {
    const elapsedMs = await measureLoadAndMerge(5000);
    console.log(`[perf] loadAndMerge(5000) = ${elapsedMs.toFixed(1)}ms`);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it("1000 annotations w/ 500 conflicting ids completes under 10s", {
    timeout: 60_000,
  }, async () => {
    const elapsedMs = await measureLoadAndMergeWithConflicts(1000);
    console.log(`[perf] loadAndMerge(1000, 500 conflicts) = ${elapsedMs.toFixed(1)}ms`);
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
