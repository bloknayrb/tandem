/**
 * #2269: every content-replacing reload carries annotations onto the new
 * content — the file-watcher reload, `tandem_open force:true`, the source-view
 * commit (file and scratchpad) and restore-from-backup.
 *
 * Seeds both record shapes the issue names: the MCP shape (snapshot + relRange)
 * and the BROWSER shape (`withBrowser`, no snapshot, no relRange — what
 * `Toolbar.svelte`'s `createAnnotation` writes), because the snapshot-less one
 * is the shape the pre-#2269 watcher relocation skipped and the lazy-attach arm
 * then minted onto stale offsets. Every check is on the TEXT a record's stored
 * range covers, never a size.
 *
 * Isolation: `useTmpAnnotationsEnvWithFlag` gives each spec its own app-data
 * dir with the durable store ON (an "off" store would make every envelope
 * assertion vacuous).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

vi.mock(import("../../src/server/notifications.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/notifications.js")>();
  return { ...actual, pushNotification: vi.fn() };
});

const watcherMocks = vi.hoisted(() => ({ watchFile: vi.fn() }));
vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: watcherMocks.watchFile,
}));

// Observation point for the await-gap spec; the real function runs otherwise.
vi.mock(import("../../src/server/session/manager.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/session/manager.js")>();
  return { ...actual, deleteSession: vi.fn(actual.deleteSession) };
});

import { docHash } from "../../src/server/annotations/doc-hash.js";
import {
  acquireStoreLock,
  envelopePath,
  getAnnotationsDir,
  resetForTesting,
} from "../../src/server/annotations/store.js";
import { contentGeneration } from "../../src/server/documents/content-generation.js";
import { openFromDisk, openScratchpad } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  reloadDocumentFromMarkdown,
  restoreDocumentFromBackup,
} from "../../src/server/documents/reload-family.js";
import {
  _resetDocBackupGateForTests,
  listDocBackups,
  snapshotBeforeFirstWrite,
} from "../../src/server/file-io/doc-backup.js";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { resolveAppDataDir } from "../../src/server/platform.js";
import { anchoredRange, refreshRange, relPosToFlatOffset } from "../../src/server/positions.js";
import { deleteSession, stopAutoSave } from "../../src/server/session/manager.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withBrowser, withMcp } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import type { Annotation, AnnotationReply } from "../../src/shared/types.js";
import { useTmpAnnotationsEnvWithFlag } from "../helpers/annotation-store-env.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { buildDocxWithComments } from "../helpers/docx-fixtures.js";

useTmpAnnotationsEnvWithFlag("tandem-reanchor-2269-");

let tmpDir: string;

beforeEach(async () => {
  resetForTesting();
  _resetDocBackupGateForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-reanchor-doc-"));
});

afterEach(async () => {
  stopAutoSave();
  setCtrlMode(null);
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

const OLD = "# Title\n\nFirst paragraph goes away.\n\nThe target sentence stays put.\n\nTail.\n";
const NEW = "# Title\n\nThe target sentence stays put.\n\nTail, edited.\n";

function annMap(doc: Y.Doc): Y.Map<Annotation> {
  return doc.getMap<Annotation>(Y_MAP_ANNOTATIONS);
}

/** The MCP shape: snapshot + relRange, written under `withMcp`. */
function seedMcp(doc: Y.Doc, id: string, text: string, extra: Partial<Annotation> = {}): void {
  const flat = extractText(doc);
  const idx = flat.indexOf(text);
  if (idx < 0) throw new Error(`"${text}" not in ${JSON.stringify(flat)}`);
  const result = anchoredRange(doc, toFlatOffset(idx), toFlatOffset(idx + text.length), text);
  if (!result.ok || !result.fullyAnchored) throw new Error("anchoredRange failed");
  const ann = {
    id,
    author: "claude",
    type: "comment",
    audience: "outbound",
    range: result.range,
    relRange: result.relRange,
    content: `on ${text}`,
    status: "pending",
    timestamp: 1,
    textSnapshot: text,
    rev: 1,
    ...extra,
  } as Annotation;
  withMcp(doc, () => annMap(doc).set(id, ann));
}

/** The browser shape: flat offsets only, written under `withBrowser`. */
function seedBrowser(doc: Y.Doc, id: string, text: string, extra: Partial<Annotation> = {}) {
  const flat = extractText(doc);
  const idx = flat.indexOf(text);
  if (idx < 0) throw new Error(`"${text}" not in ${JSON.stringify(flat)}`);
  const ann = {
    id,
    author: "user",
    type: "note",
    audience: "private",
    range: { from: toFlatOffset(idx), to: toFlatOffset(idx + text.length) },
    content: `note on ${text}`,
    status: "pending",
    timestamp: 1,
    ...extra,
  } as Annotation;
  withBrowser(doc, () => annMap(doc).set(id, ann));
}

/** The text the record's STORED range covers — what the client and docx export read. */
function textOf(doc: Y.Doc, id: string): string {
  const ann = annMap(doc).get(id);
  if (!ann) throw new Error(`${id} vanished`);
  return extractText(doc).slice(ann.range.from, ann.range.to);
}

function kindOf(doc: Y.Doc, id: string): string {
  const ann = annMap(doc).get(id);
  if (!ann) throw new Error(`${id} vanished`);
  return refreshRange(ann, doc).kind;
}

/** Let the durable store's debounce fire. */
async function settleEnvelope(filePath: string): Promise<void> {
  const target = envelopePath(docHash(filePath));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (
      await fs
        .stat(target)
        .then(() => true)
        .catch(() => false)
    ) {
      return;
    }
  }
  throw new Error(`envelope never written at ${target}`);
}

interface Opened {
  id: string;
  doc: Y.Doc;
  /** Replace the document's content with `markdown` through this reload path. */
  reload: (markdown: string) => Promise<void>;
  filePath?: string;
}

async function openFile(content: string): Promise<{ filePath: string; id: string; doc: Y.Doc }> {
  const filePath = path.join(tmpDir, "doc.md");
  await fs.writeFile(filePath, content, "utf-8");
  await openFromDisk(filePath);
  const id = docIdFromPath(filePath);
  return { filePath, id, doc: getOrCreateDocument(id) };
}

const PATHS: Record<string, (content: string) => Promise<Opened>> = {
  "file-watcher reload": async (content) => {
    const { filePath, id, doc } = await openFile(content);
    const onChanged = watcherMocks.watchFile.mock.calls.at(-1)?.[1] as (p: string) => Promise<void>;
    return {
      id,
      doc,
      filePath,
      reload: async (md) => {
        await fs.writeFile(filePath, md, "utf-8");
        await onChanged(filePath);
      },
    };
  },
  "force-open": async (content) => {
    const { filePath, id, doc } = await openFile(content);
    return {
      id,
      doc,
      filePath,
      reload: async (md) => {
        await fs.writeFile(filePath, md, "utf-8");
        await openFromDisk(filePath, { force: true });
      },
    };
  },
  "source-view commit (file)": async (content) => {
    const { filePath, id, doc } = await openFile(content);
    return { id, doc, filePath, reload: (md) => reloadDocumentFromMarkdown(id, md) };
  },
  "source-view commit (scratchpad)": async (content) => {
    const opened = await openScratchpad(content);
    const id = opened.documentId;
    return {
      id,
      doc: getOrCreateDocument(id),
      reload: (md) => reloadDocumentFromMarkdown(id, md),
    };
  },
  "restore from backup": async (content) => {
    const { filePath, id, doc } = await openFile(content);
    return {
      id,
      doc,
      filePath,
      reload: async (md) => {
        // Back up the TARGET bytes, then put the open content back on disk,
        // so the restore is a real content change.
        await fs.writeFile(filePath, md, "utf-8");
        _resetDocBackupGateForTests();
        expect(await snapshotBeforeFirstWrite(filePath, { appDataDir: resolveAppDataDir() })).toBe(
          "written",
        );
        const [snapshot] = await listDocBackups(filePath, resolveAppDataDir());
        await fs.writeFile(filePath, content, "utf-8");
        _resetDocBackupGateForTests();
        await restoreDocumentFromBackup(id, snapshot.name);
      },
    };
  },
};

describe.each(Object.keys(PATHS))("%s carries annotations onto the new content", (name) => {
  const open = PATHS[name];

  it("a record whose paragraph moved follows its text — both shapes", async () => {
    const { doc, reload } = await open(OLD);
    seedMcp(doc, "mcp", "target sentence");
    seedBrowser(doc, "browser", "stays put");

    await reload(NEW);

    expect(extractText(doc)).not.toContain("goes away");
    expect(textOf(doc, "mcp")).toBe("target sentence");
    expect(textOf(doc, "browser")).toBe("stays put");
    expect(kindOf(doc, "mcp")).toBe("ok");
    expect(kindOf(doc, "browser")).toBe("ok");
  });

  it("a record whose text was deleted collapses and reads degraded — both shapes", async () => {
    const { doc, reload } = await open(OLD);
    seedMcp(doc, "mcp", "First paragraph");
    seedBrowser(doc, "browser", "goes away");

    await reload(NEW);

    for (const id of ["mcp", "browser"]) {
      const ann = annMap(doc).get(id);
      expect(ann, `${id} kept`).toBeDefined();
      expect(ann?.range.from, `${id} is a point`).toBe(ann?.range.to);
      expect(ann?.relRange, `${id} has no anchor`).toBeUndefined();
      expect(kindOf(doc, id), `${id} is degraded`).toBe("degraded");
    }
    // The browser record had no snapshot; the collapse gave it one, from the
    // OLD text, which is what keeps it degraded instead of re-attached.
    expect(annMap(doc).get("browser")?.textSnapshot).toBe("goes away");
  });

  it("an unrelated edit leaves records on their text, and replies and fields survive", async () => {
    const { doc, reload } = await open(OLD);
    seedMcp(doc, "mcp", "target sentence", { heldInSolo: true, editedAt: 7, rev: 4 });
    const reply: AnnotationReply = {
      id: "rep_1",
      annotationId: "mcp",
      author: "user",
      text: "a reply",
      timestamp: 2,
    };
    withMcp(doc, () => doc.getMap<AnnotationReply>(Y_MAP_ANNOTATION_REPLIES).set("rep_1", reply));
    const before = annMap(doc).get("mcp") as Annotation;

    await reload(OLD.replace("Tail.", "Tail, but longer now."));

    expect(textOf(doc, "mcp")).toBe("target sentence");
    expect(doc.getMap<AnnotationReply>(Y_MAP_ANNOTATION_REPLIES).get("rep_1")).toEqual(reply);
    const { range: _a, relRange: _b, ...restAfter } = annMap(doc).get("mcp") as Annotation;
    const { range: _c, relRange: _d, ...restBefore } = before;
    expect(restAfter, "identical apart from range and relRange").toEqual(restBefore);
  });

  it("bumps the content generation exactly once, in the transaction that swaps the content (#2070)", async () => {
    const { doc, reload } = await open(OLD);
    const before = contentGeneration(doc);
    const fragment = doc.getXmlFragment("default");
    const atSwap: number[] = [];
    const onTxn = (txn: Y.Transaction) => {
      if (txn.changed.has(fragment)) atSwap.push(contentGeneration(doc));
    };
    doc.on("afterTransaction", onTxn);
    try {
      await reload(NEW);
    } finally {
      doc.off("afterTransaction", onTxn);
    }
    expect(contentGeneration(doc)).toBe(before + 1);
    // Every transaction that touched the content already saw the new number:
    // there is no window in which the content is new and the generation old.
    expect(atSwap.length).toBeGreaterThan(0);
    expect(atSwap.every((g) => g === before + 1)).toBe(true);
  });

  it("a record whose text was deleted does not jump to another copy outside the edit", async () => {
    const doc0 = "Repeat me here.\n\nRepeat me there.\n";
    const { doc, reload } = await open(doc0);
    const flat = extractText(doc);
    const second = flat.lastIndexOf("Repeat me");
    const ann = {
      id: "dup",
      author: "user",
      type: "note",
      audience: "private",
      range: { from: toFlatOffset(second), to: toFlatOffset(second + 9) },
      content: "on the second copy",
      status: "pending",
      timestamp: 1,
    } as Annotation;
    withBrowser(doc, () => annMap(doc).set("dup", ann));

    await reload("Repeat me here.\n\nSomething else there.\n");

    const after = annMap(doc).get("dup");
    expect(after?.range.from, "collapsed, not moved onto the first copy").toBe(after?.range.to);
    expect(kindOf(doc, "dup")).toBe("degraded");
  });
});

describe("the remap lands with the content — no window, no loss", () => {
  it("a read inside the session-delete await already resolves to the new text (force-open)", async () => {
    const { filePath, doc } = await openFile(OLD);
    seedMcp(doc, "mcp", "target sentence");
    seedBrowser(doc, "browser", "stays put");

    const seen: Record<string, string> = {};
    vi.mocked(deleteSession).mockImplementationOnce(async () => {
      const flat = extractText(doc);
      for (const id of ["mcp", "browser"]) {
        const rel = annMap(doc).get(id)?.relRange;
        if (!rel) {
          seen[id] = "(no relRange)";
          continue;
        }
        const from = relPosToFlatOffset(doc, rel.fromRel);
        const to = relPosToFlatOffset(doc, rel.toRel);
        seen[id] = from === null || to === null ? "(dead)" : flat.slice(from, to);
      }
    });

    await fs.writeFile(filePath, NEW, "utf-8");
    await openFromDisk(filePath, { force: true });

    expect(vi.mocked(deleteSession)).toHaveBeenCalled();
    expect(seen).toEqual({ mcp: "target sentence", browser: "stays put" });
  });

  it("a file document whose store is read-only (another instance holds the lock) keeps every record", async () => {
    await fs.mkdir(getAnnotationsDir(), { recursive: true });
    const lockPath = path.join(getAnnotationsDir(), "store.lock");
    await fs.writeFile(lockPath, String(process.pid));
    expect(await acquireStoreLock()).toBe("readonly");
    try {
      const { filePath, doc } = await openFile(OLD);
      seedMcp(doc, "mcp", "target sentence");
      seedBrowser(doc, "browser", "stays put");

      await fs.writeFile(filePath, NEW, "utf-8");
      await openFromDisk(filePath, { force: true });

      expect(textOf(doc, "mcp")).toBe("target sentence");
      expect(textOf(doc, "browser")).toBe("stays put");
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  });

  it("the remapped ranges reach the durable envelope (force-open)", async () => {
    const { filePath, doc } = await openFile(OLD);
    seedBrowser(doc, "browser", "stays put");
    await settleEnvelope(filePath);

    await fs.writeFile(filePath, NEW, "utf-8");
    await openFromDisk(filePath, { force: true });
    const expected = annMap(doc).get("browser")?.range;

    // The merge queued the write; wait for the debounce, then read it back.
    let onDisk: { range: unknown } | undefined;
    for (let i = 0; i < 40 && !onDisk; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const env = JSON.parse(await fs.readFile(envelopePath(docHash(filePath)), "utf-8")) as {
        annotations: Array<{ id: string; range: unknown }>;
      };
      const rec = env.annotations.find((a) => a.id === "browser");
      if (JSON.stringify(rec?.range) === JSON.stringify(expected)) onDisk = rec;
    }
    expect(onDisk?.range).toEqual(expected);
  });

  it("an envelope copy that wins the merge is remapped too (force-open)", async () => {
    const { filePath, doc } = await openFile(OLD);
    seedMcp(doc, "mcp", "target sentence");
    await settleEnvelope(filePath);
    // Another writer bumped the durable copy past the map's (same old
    // coordinates, newer rev), so the post-reload merge takes the FILE copy.
    const envPath = envelopePath(docHash(filePath));
    const env = JSON.parse(await fs.readFile(envPath, "utf-8")) as {
      annotations: Array<Record<string, unknown>>;
    };
    const rec = env.annotations.find((a) => a.id === "mcp");
    if (!rec) throw new Error("mcp not in the envelope");
    rec.rev = 99;
    rec.content = "edited on disk";
    await fs.writeFile(envPath, JSON.stringify(env), "utf-8");
    // Drop the store's in-memory pending state so the reload's flush has
    // nothing queued that would overwrite the edit above.
    resetForTesting();

    await fs.writeFile(filePath, NEW, "utf-8");
    await openFromDisk(filePath, { force: true });

    const after = annMap(doc).get("mcp");
    expect(after?.content).toBe("edited on disk");
    expect(textOf(doc, "mcp")).toBe("target sentence");
  });
});

describe("Solo: the reload's own writes stamp nothing", () => {
  it("an unstamped user comment stays unstamped across a reload; a browser edit is the positive control", async () => {
    setCtrlMode("solo");
    const { filePath, doc } = await openFile(OLD);
    const flat = extractText(doc);
    const at = flat.indexOf("target sentence");
    // Seeded under MCP (channel-skipped), so the stamp observer leaves it be.
    const ann = {
      id: "user-comment",
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: toFlatOffset(at), to: toFlatOffset(at + 15) },
      content: "for Claude, later",
      status: "pending",
      timestamp: 1,
      rev: 1,
    } as Annotation;
    withMcp(doc, () => annMap(doc).set(ann.id, ann));
    expect(annMap(doc).get(ann.id)?.heldInSolo).toBeUndefined();

    await fs.writeFile(filePath, NEW, "utf-8");
    await openFromDisk(filePath, { force: true });
    expect(textOf(doc, ann.id)).toBe("target sentence");
    expect(annMap(doc).get(ann.id)?.heldInSolo, "the remap is not a user edit").toBeUndefined();

    // Positive control: the stamp observer IS attached and live — a browser
    // edit of the same record in Solo is stamped.
    withBrowser(doc, () =>
      annMap(doc).set(ann.id, { ...(annMap(doc).get(ann.id) as Annotation), content: "edited" }),
    );
    expect(annMap(doc).get(ann.id)?.heldInSolo).toBe(true);
  });
});

describe(".docx force-open re-imports into the kept map without duplicating", () => {
  it("each Word comment appears once after a force-open of the same file", async () => {
    const filePath = path.join(tmpDir, "doc.docx");
    await fs.writeFile(filePath, await buildDocxWithComments(3));
    const opened = await openFromDisk(filePath);
    const doc = getOrCreateDocument(opened.documentId);
    const imported = () =>
      [...annMap(doc).values()].filter((a) => a.author === "import").map((a) => a.content);
    const before = imported().sort();
    expect(before).toHaveLength(3);

    await openFromDisk(filePath, { force: true });

    expect(imported().sort()).toEqual(before);
    for (const ann of annMap(doc).values()) {
      const text = extractText(doc).slice(ann.range.from, ann.range.to);
      expect(text, `${ann.id} still covers its Word run`).toMatch(/^Word\d$/);
    }
  });
});
