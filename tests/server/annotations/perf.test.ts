/**
 * Baseline perf measurements for `loadAndMerge` at 500 / 1000 / 5000
 * annotations. These tests DO NOT enforce a tight upper bound — they exist
 * so CI logs record a timing number and assert only a ridiculous ceiling
 * (the test still passes through 10× slowdown). See issue #335.
 *
 * Why not `bench()`? We want the baseline visible in every CI run, not
 * isolated behind `vitest bench`. The pattern is `it()` + `performance.now()`.
 *
 * What's measured: `loadAndMerge` with a pre-written on-disk envelope.
 * Fixture construction (building the Y.Doc, writing the file) happens
 * BEFORE the `performance.now()` window so only the merge cost is timed.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

let tmpRoot: string;
let prevAppDataDir: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-perf-test-"));
  prevAppDataDir = process.env.TANDEM_APP_DATA_DIR;
  process.env.TANDEM_APP_DATA_DIR = tmpRoot;
  resetStoreForTesting();
  resetSyncForTesting();
});

afterEach(async () => {
  resetStoreForTesting();
  resetSyncForTesting();
  if (prevAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = prevAppDataDir;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeEnvelope(envelope: AnnotationDocV1): Promise<void> {
  const annotationsDir = path.join(tmpRoot, "annotations");
  await fs.mkdir(annotationsDir, { recursive: true });
  await fs.writeFile(
    path.join(annotationsDir, `${envelope.docHash}.json`),
    JSON.stringify(envelope),
    "utf-8",
  );
}

async function measureLoadAndMerge(count: number): Promise<number> {
  const envelope = makeEnvelope(count);
  await writeEnvelope(envelope);

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

describe("loadAndMerge perf baseline (#335)", () => {
  // 60s is a ridiculous ceiling even for a Windows CI runner. The goal is
  // a recorded number, not a gate; see issue #335.
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
});
