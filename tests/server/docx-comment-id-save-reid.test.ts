/**
 * #1693, the production half: does the REAL `.docx` save path reconcile a
 * re-minted `w:id` onto the stored record?
 *
 * `docx-comment-id-roundtrip.test.ts` pins `reconcileImportCommentIds` itself,
 * and every row there calls it by hand in the order the save path runs it. That
 * is a spec of the function, not of its caller: delete the one line in
 * `saveDocumentToDisk`'s binary branch and every row stays green while the
 * shipped product ghosts exactly as it did before. So this file drives
 * `saveDocumentToDisk` against a real file on disk and never mentions the
 * reconcile by name.
 *
 * The re-open is spelled the way the reload path spells it — re-extract the
 * comments from the bytes that were actually written and re-inject them into the
 * SAME doc, which is what `loadAndMerge` → re-inject does with the annotation
 * envelope preserved. A second `openFromDisk` would instead depend on the
 * durable store's debounced write having landed, which is a different mechanism
 * and a flaky one to race.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted before module-level code; compute paths inline.
// The dir name must start with `tandem-` — `platform.test.ts` asserts the shape.
vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-comment-reid-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return {
    ...original,
    SESSION_DIR: pathMod.join(appDataDir, "sessions"),
  };
});

vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  suppressNextChange: vi.fn(),
}));

/**
 * A hook that makes the ONE binary write fail, so the "below the write" half of
 * the placement can be asserted rather than described. Undefined unless a test
 * sets it, so every other row goes through the real `atomicWriteBuffer`.
 */
const { hooks } = vi.hoisted(() => ({ hooks: { failWrite: false } }));
vi.mock("../../src/server/file-io/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/file-io/index.js")>();
  return {
    ...actual,
    atomicWriteBuffer: vi.fn(async (...args: Parameters<typeof actual.atomicWriteBuffer>) => {
      if (hooks.failWrite) throw new Error("disk full");
      return actual.atomicWriteBuffer(...args);
    }),
  };
});

import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { prepareExportComments } from "../../src/server/file-io/docx-comment-export.js";
import {
  extractDocxComments,
  injectCommentsAsAnnotations,
} from "../../src/server/file-io/docx-comments.js";
import { getOpenDocs, saveDocumentToDisk } from "../../src/server/mcp/document-service.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import type { Annotation } from "../../src/shared/types.js";
import { buildDocxWithCommentIds } from "../helpers/docx-fixtures.js";

let tmpDir: string;

/**
 * ONE directory for the whole file, torn down only at the end, and a distinct
 * file name per row — NOT the usual per-test `mkdtemp` + `afterEach` rm.
 *
 * Deleting a row's directory makes its annotation envelope an ORPHAN, and every
 * row here opens a document with byte-identical body text (the fixture writes
 * `Word1` whatever the `w:id` is). `recoverRenamedEnvelope` is built for exactly
 * that shape — no envelope at the new path-hash, a unique content match against
 * an orphan whose old path is gone — so it correctly re-keys the PREVIOUS row's
 * envelope onto this row's document and injects its promoted record. The rows
 * then start with two annotations and fail on an assertion that says nothing
 * about #1693. Keeping the old files on disk is what stops the recovery, and it
 * is the honest fix: those documents were never renamed.
 */
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-comment-reid-"));
});

beforeEach(() => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  hooks.failWrite = false;
  vi.clearAllMocks();
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
});

/**
 * Promote the single imported note to the EXACT shape `promotedAnnotation`
 * (`src/client/panels/annotation-actions.ts`) produces. A record left
 * `type: "note"` loses the `isImportRoundtrip` bypass in
 * `docx-comment-export.ts`, so nothing is exported and every assertion below
 * passes vacuously — on unfixed code too.
 */
function promoteTheImport(documentId: string): { key: string } {
  const map = getOrCreateDocument(documentId).getMap(Y_MAP_ANNOTATIONS);
  const key = Array.from(map.keys())[0];
  expect(key, "the .docx import produced exactly one annotation").toBeDefined();
  expect(map.size).toBe(1);
  const ann = map.get(key) as Annotation & { color?: unknown; suggestedText?: unknown };
  const { color: _color, suggestedText: _suggestedText, ...rest } = ann;
  withInternal(getOrCreateDocument(documentId), () => {
    map.set(key, {
      ...rest,
      type: "comment" as const,
      author: "user" as const,
      audience: "outbound" as const,
      promotedFrom: "note" as const,
      status: "pending" as const,
      rev: (ann.rev ?? 0) + 1,
    });
  });
  return { key };
}

describe("the .docx save path keeps a promoted Word comment findable (#1693)", () => {
  // `c-9182` is the id the issue reproduces with and the one reuse can never
  // rescue: `ST_DecimalNumber` has no representation for a non-numeric id, so
  // export MUST mint a fresh one. Which makes it the row that distinguishes
  // "the save reconciled the stored id" from "the id happened not to change".
  for (const commentId of ["c-9182", "0123"]) {
    it(`survives a save that re-mints w:id ${JSON.stringify(commentId)}`, async () => {
      const filePath = path.join(tmpDir, `reviewed-${commentId.replace(/\W/g, "_")}.docx`);
      await fs.writeFile(filePath, await buildDocxWithCommentIds([commentId]));

      const opened = await openFromDisk(filePath);
      const doc = getOrCreateDocument(opened.documentId);
      const map = doc.getMap(Y_MAP_ANNOTATIONS);
      const { key } = promoteTheImport(opened.documentId);
      expect((map.get(key) as Annotation).importSource?.commentId).toBe(commentId);

      // GUARD FIRST: without it the row cannot tell "the id was re-minted and
      // then reconciled" from "nothing was exported at all".
      const prepared = prepareExportComments(doc);
      expect(prepared).toHaveLength(1);
      const mintedId = prepared[0].id;
      expect(String(mintedId)).not.toBe(commentId);

      const result = await saveDocumentToDisk(opened.documentId, "manual");
      expect(result.status).toBe("saved");

      // The save wrote a different `w:id` into the user's file...
      const saved = await fs.readFile(filePath);
      const comments = await extractDocxComments(saved);
      expect(comments).toHaveLength(1);
      expect(comments[0].commentId).toBe(String(mintedId));

      // ...and the stored record now names it, which is the whole repair.
      expect((map.get(key) as Annotation).importSource?.commentId).toBe(String(mintedId));

      // So the next open finds the promotion instead of injecting a ghost note
      // beside it — the ghost whose own next save would write TWO Word comments
      // for one original (#1448).
      expect(injectCommentsAsAnnotations(doc, comments, path.basename(filePath))).toBe(0);
      expect(map.size).toBe(1);
      const after = map.get(key) as Annotation;
      expect(after.author).toBe("user");
      expect(after.type).toBe("comment");
      expect(after.promotedFrom).toBe("note");

      // And the file that results still carries exactly one Word comment.
      expect(prepareExportComments(doc)).toHaveLength(1);
    });
  }

  it("leaves a canonical w:id alone — the control", async () => {
    // `7` is reused verbatim, so there is nothing to reconcile and the stored id
    // must not move. A repair that rewrote unconditionally would take a durable
    // write on every save of every imported document.
    const filePath = path.join(tmpDir, "canonical.docx");
    await fs.writeFile(filePath, await buildDocxWithCommentIds(["7"]));

    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const { key } = promoteTheImport(opened.documentId);
    const revBefore = (map.get(key) as Annotation).rev;

    expect((await saveDocumentToDisk(opened.documentId, "manual")).status).toBe("saved");

    const comments = await extractDocxComments(await fs.readFile(filePath));
    expect(comments[0].commentId).toBe("7");
    const after = map.get(key) as Annotation;
    expect(after.importSource?.commentId).toBe("7");
    expect(after.rev).toBe(revBefore);
    expect(injectCommentsAsAnnotations(doc, comments, "canonical.docx")).toBe(0);
    expect(map.size).toBe(1);
  });

  it("does not move the stored id when the write fails", async () => {
    // The other half of the placement, and the failure it prevents: run the
    // reconcile ABOVE the write and a save that never landed still repoints
    // every stored id at a `w:id` the file on disk does not contain — the same
    // ghost with the two sides swapped, and this time reached by a refusal the
    // user was told about. `atomicWriteBuffer` throwing stands in for every
    // refusal in that window (a `blocked` verify verdict is the other).
    const filePath = path.join(tmpDir, "unwritable.docx");
    await fs.writeFile(filePath, await buildDocxWithCommentIds(["c-9182"]));

    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const map = doc.getMap(Y_MAP_ANNOTATIONS);
    const { key } = promoteTheImport(opened.documentId);
    // Guard: the id WOULD have been re-minted, so a green row is not "there was
    // nothing to reconcile".
    expect(String(prepareExportComments(doc)[0].id)).not.toBe("c-9182");

    hooks.failWrite = true;
    // `saveDocumentToDisk` reports rather than rejects; either way the reconcile
    // below the write is not reached.
    expect((await saveDocumentToDisk(opened.documentId, "manual")).status).toBe("error");

    const after = map.get(key) as Annotation;
    expect(after.importSource?.commentId).toBe("c-9182");
    // The file still holds the original `w:id`, so the stored record and the
    // bytes on disk still agree — which is the property, not the string.
    const comments = await extractDocxComments(await fs.readFile(filePath));
    expect(comments[0].commentId).toBe("c-9182");
  });
});
