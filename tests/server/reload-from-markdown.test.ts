/**
 * Tests for `reloadDocumentFromMarkdown` — the server side of the raw-markdown
 * source view/edit feature (#1021).
 *
 * Verifies the round-trip (markdown string → Y.Doc body → disk), annotation
 * clearing, the per-document guards (NO_DOCUMENT / UNSUPPORTED_FORMAT /
 * READ_ONLY), and that the doc is left dirty-then-persisted (not silently
 * marked clean against the new content).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("../../src/server/platform", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const cryptoMod = await import("node:crypto");
  const appDataDir = pathMod.join(osMod.tmpdir(), `tandem-test-mdreload-${cryptoMod.randomUUID()}`);
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return {
    ...original,
    SESSION_DIR: pathMod.join(appDataDir, "sessions"),
  };
});

const watcherMocks = vi.hoisted(() => ({ watchFile: vi.fn() }));
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: watcherMocks.watchFile,
}));

vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/notifications.js")>();
  return { ...actual, pushNotification: vi.fn() };
});

import { openFromDisk, openScratchpad } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  acquireReloadGuard,
  isReloadInProgress,
  releaseReloadGuard,
} from "../../src/server/documents/watcher.js";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { reloadDocumentFromMarkdown } from "../../src/server/mcp/file-opener.js";
import { anchoredRange } from "../../src/server/positions.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { MCP_ORIGIN } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation } from "../../src/shared/types.js";

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-mdreload-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
});

async function openMdFile(initial: string): Promise<{ filePath: string; id: string; doc: Y.Doc }> {
  const filePath = path.join(tmpDir, "doc.md");
  await fs.writeFile(filePath, initial, "utf-8");
  await openFromDisk(filePath);
  const id = docIdFromPath(filePath);
  return { filePath, id, doc: getOrCreateDocument(id) };
}

function seedAnnotation(doc: Y.Doc, snapshot: string): string {
  const text = extractText(doc);
  const idx = text.indexOf(snapshot);
  if (idx < 0) throw new Error(`snapshot "${snapshot}" not found`);
  const result = anchoredRange(
    doc,
    toFlatOffset(idx),
    toFlatOffset(idx + snapshot.length),
    snapshot,
  );
  if (!result.ok) throw new Error("anchoredRange failed");
  const id = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ann: Annotation = {
    id,
    author: "user",
    type: "comment",
    range: result.range,
    ...(result.fullyAnchored ? { relRange: result.relRange } : {}),
    content: "seeded",
    status: "pending",
    timestamp: Date.now(),
    textSnapshot: snapshot,
    rev: 1,
  };
  doc.transact(() => doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, ann), MCP_ORIGIN);
  return id;
}

describe("reloadDocumentFromMarkdown — round-trip + disk persistence", () => {
  it("replaces the Y.Doc body from the supplied markdown", async () => {
    const { id, doc } = await openMdFile("# Title\n\nOriginal paragraph.\n");
    expect(extractText(doc)).toContain("Original paragraph");

    await reloadDocumentFromMarkdown(id, "# Changed\n\nBrand new body text.\n");

    const text = extractText(doc);
    expect(text).toContain("Brand new body text");
    expect(text).not.toContain("Original paragraph");
  });

  it("writes the new markdown to disk", async () => {
    const { id, filePath } = await openMdFile("# Title\n\nOriginal.\n");

    await reloadDocumentFromMarkdown(id, "# Title\n\nEdited on disk.\n");

    const onDisk = await fs.readFile(filePath, "utf-8");
    expect(onDisk).toContain("Edited on disk.");
    expect(onDisk).not.toContain("Original.");
  });

  it("clears all annotations on reload", async () => {
    const { id, doc } = await openMdFile("# Title\n\nThe quick brown fox.\n");
    seedAnnotation(doc, "brown");
    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);

    await reloadDocumentFromMarkdown(id, "# Title\n\nA different sentence.\n");

    expect(doc.getMap(Y_MAP_ANNOTATIONS).size).toBe(0);
  });
});

describe("reloadDocumentFromMarkdown — guards", () => {
  it("rejects an unopened document with NO_DOCUMENT", async () => {
    await expect(reloadDocumentFromMarkdown("not-open", "# x")).rejects.toMatchObject({
      code: "NO_DOCUMENT",
    });
  });

  it("rejects a non-.md document with UNSUPPORTED_FORMAT", async () => {
    const filePath = path.join(tmpDir, "notes.txt");
    await fs.writeFile(filePath, "plain text\n", "utf-8");
    await openFromDisk(filePath);
    const id = docIdFromPath(filePath);

    await expect(reloadDocumentFromMarkdown(id, "# x")).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("rejects a read-only .md document with READ_ONLY", async () => {
    const filePath = path.join(tmpDir, "ro.md");
    await fs.writeFile(filePath, "# Read only\n", "utf-8");
    await openFromDisk(filePath, { readOnly: true });
    const id = docIdFromPath(filePath);

    await expect(reloadDocumentFromMarkdown(id, "# hacked")).rejects.toMatchObject({
      code: "READ_ONLY",
    });
  });
});

describe("reloadDocumentFromMarkdown — scratchpad (editable upload source)", () => {
  it("reloads an editable upload://-backed .md scratchpad without touching disk", async () => {
    const opened = await openScratchpad("# Scratch\n\nfirst\n");
    const id = opened.documentId;
    const doc = getOrCreateDocument(id);

    await reloadDocumentFromMarkdown(id, "# Scratch\n\nsecond\n");

    expect(extractText(doc)).toContain("second");
    expect(extractText(doc)).not.toContain("first");
  });
});

/**
 * The concurrent-reload guard spans two modules (#ADR-034 Unit 7a):
 * `reloadFromDisk` owns the Set in `documents/watcher.ts`, and
 * `reloadDocumentFromMarkdown` takes the SAME guard from `mcp/file-opener.ts`
 * so two clear+repopulate transactions never interleave on one Y.Doc.
 *
 * Before the split that was structural — one module-private Set — and so
 * nothing tested it. It is now a contract between modules, and the way it
 * breaks is silent: a second module declaring its own Set leaves both halves
 * green, every existing spec passing, and the serialization simply gone. Both
 * directions are asserted because a duplicate on either side is invisible from
 * the other.
 */
describe("reloadDocumentFromMarkdown — shares the watcher's reload guard", () => {
  it("refuses while the watcher's guard is held", async () => {
    const filePath = path.join(tmpDir, "guarded.md");
    await fs.writeFile(filePath, "# Doc\n\nbody\n", "utf-8");
    await openFromDisk(filePath);
    const id = docIdFromPath(filePath);

    // Taken through the watcher's own contract — the point is that this is the
    // guard file-opener consults, not a same-named one it declares itself.
    expect(acquireReloadGuard(id), "control: the guard was free to take").toBe(true);
    try {
      await expect(reloadDocumentFromMarkdown(id, "# hacked")).rejects.toMatchObject({
        code: "RELOAD_IN_PROGRESS",
      });
    } finally {
      releaseReloadGuard(id);
    }

    // Control: with the guard released the same call succeeds, so the rejection
    // above is the guard and not some other precondition of this fixture.
    await reloadDocumentFromMarkdown(id, "# after\n\nreleased\n");
    expect(extractText(getOrCreateDocument(id))).toContain("released");
  });

  it("is visible to the watcher while it holds the guard", async () => {
    const filePath = path.join(tmpDir, "observed.md");
    await fs.writeFile(filePath, "# Doc\n\nbody\n", "utf-8");
    await openFromDisk(filePath);
    const id = docIdFromPath(filePath);

    expect(isReloadInProgress(id), "control: not held before the call").toBe(false);

    let heldDuringReload: boolean | undefined;
    const populate = await import("../../src/server/documents/populate.js");
    const realClearAndReload = populate.clearAndReload;
    const spy = vi.spyOn(populate, "clearAndReload").mockImplementation(async (...args) => {
      // Read through the watcher's own probe: a duplicated Set in file-opener
      // would leave this false while the reload is genuinely in flight.
      heldDuringReload = isReloadInProgress(id);
      return await realClearAndReload(...args);
    });
    try {
      await reloadDocumentFromMarkdown(id, "# mid\n\nflight\n");
    } finally {
      spy.mockRestore();
    }

    expect(heldDuringReload, "the reload body ran at all").toBe(true);
    expect(isReloadInProgress(id), "released once the reload finished").toBe(false);
  });
});
