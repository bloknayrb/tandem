/**
 * Shared annotation fixture constants and factory functions for durable store
 * and sync tests.
 *
 * NOTE: This file exports `makeAnnotationDoc` (not `makeDoc`) to avoid
 * collision with `tests/helpers/ydoc-factory.ts::makeDoc` which returns a
 * Y.Doc. `makeAnnotationDoc` returns an `AnnotationDocV1` envelope.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  type AnnotationDocV1,
  type AnnotationRecordV1,
  type AnnotationReplyRecordV1,
  migrateToV1,
} from "../../src/server/annotations/schema.js";

// ---------------------------------------------------------------------------
// Shared hash + path constants
// ---------------------------------------------------------------------------

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const FILE_A = "/virtual/doc-a.md";
export const FILE_B = "/virtual/doc-b.md";

// ---------------------------------------------------------------------------
// Single-record factories
// ---------------------------------------------------------------------------

/**
 * Returns an `AnnotationRecordV1` with sensible defaults.
 *
 * Shape matches the `annRecord` helper in sync.test.ts (rev defaults to 0,
 * all required fields present).
 */
export function annRecord(overrides: Partial<AnnotationRecordV1> = {}): AnnotationRecordV1 {
  return {
    id: "ann_1",
    author: "claude",
    type: "comment",
    range: { from: 0, to: 5 },
    content: "hello",
    status: "pending",
    timestamp: 1_700_000_000_000,
    rev: 0,
    ...overrides,
  };
}

/**
 * Returns an `AnnotationReplyRecordV1` with sensible defaults.
 *
 * Shape matches the `replyRecord` helper in sync.test.ts.
 */
export function replyRecord(
  overrides: Partial<AnnotationReplyRecordV1> = {},
): AnnotationReplyRecordV1 {
  return {
    id: "rep_1",
    annotationId: "ann_1",
    author: "user",
    text: "ack",
    timestamp: 1_700_000_000_000,
    rev: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Envelope factory
// ---------------------------------------------------------------------------

/**
 * Returns an `AnnotationDocV1` envelope using `migrateToV1({})` as the base.
 *
 * Shape matches the local `makeDoc` / `makeFile` helpers in store.test.ts and
 * sync.test.ts:
 *   - `docHash` set from the first argument
 *   - `meta.filePath` set from the second argument
 *   - `meta.lastUpdated` set to `Date.now()`
 *   - Optional `overrides` merged on top
 *
 * Named `makeAnnotationDoc` (not `makeDoc`) to avoid collision with
 * `tests/helpers/ydoc-factory.ts::makeDoc` which returns a `Y.Doc`.
 */
export function makeAnnotationDoc(
  docHash: string,
  filePath: string,
  overrides: Partial<AnnotationDocV1> = {},
): AnnotationDocV1 {
  const { doc } = migrateToV1({});
  doc.docHash = docHash;
  doc.meta = { filePath, lastUpdated: Date.now() };
  return { ...doc, ...overrides };
}

// ---------------------------------------------------------------------------
// Disk write helper
// ---------------------------------------------------------------------------

/**
 * Writes an `AnnotationDocV1` envelope to the annotations directory under
 * `process.env.TANDEM_APP_DATA_DIR`.
 *
 * Creates the directory if it does not exist. Resolves the dir from the env
 * var rather than accepting a path parameter so it stays in sync with whatever
 * `getAnnotationsDir()` returns in production.
 */
export async function writeEnvelopeToDisk(envelope: AnnotationDocV1): Promise<void> {
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (!appDataDir) throw new Error("TANDEM_APP_DATA_DIR is not set");
  const annotationsDir = path.join(appDataDir, "annotations");
  await fs.mkdir(annotationsDir, { recursive: true });
  await fs.writeFile(
    path.join(annotationsDir, `${envelope.docHash}.json`),
    JSON.stringify(envelope),
    "utf-8",
  );
}
