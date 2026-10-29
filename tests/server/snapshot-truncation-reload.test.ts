/**
 * Truncated snapshots, bounds and reporting across a content-replacing reload.
 *
 * `captureSnapshot` caps snapshots at 200 characters (#1486), so a long
 * annotation's `textSnapshot` is a PREFIX of its text. Before #2269 the
 * file-watcher's relocation pass searched the whole document for a snapshot
 * and re-anchored to `match + snapshot.length`, which silently shrank an
 * unmarked long annotation to the cap; the flag was what stopped that. Since
 * #2269 every content-replacing reload runs the remap in
 * `documents/reload-remap.ts` instead: a record is carried by exact arithmetic
 * when its text is outside every changed region, probed for only inside the
 * changed region it touches, and detached (`degraded`) when its text is gone.
 * The flag still decides how a record is READ — whether its stored range is
 * seen to hold its snapshot at all — and the negative control below shows that
 * an unmarked prefix makes the record untrusted, never re-anchored.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

vi.mock(import("../../src/server/platform"), async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const cryptoMod = await import("node:crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-test-snaptrunc-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});

// Capturing the watcher callback is what lets the test drive `reloadFromDisk`
// synchronously instead of racing real `fs.watch` delivery.
const watcherMocks = vi.hoisted(() => ({ watchFile: vi.fn() }));
vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: watcherMocks.watchFile,
}));

vi.mock(import("../../src/server/notifications.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/notifications.js")>();
  return { ...actual, pushNotification: vi.fn() };
});

import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { anchoredRange, refreshRange } from "../../src/server/positions.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withMcp } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import { SNAPSHOT_CAP } from "../../src/shared/snapshot.js";
import type { Annotation } from "../../src/shared/types.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";

/**
 * A paragraph comfortably longer than the cap, with no repeated 200-character
 * run — so `indexOf` of its prefix has exactly one hit and the relocation the
 * guard prevents is unambiguous rather than a coincidence of repetition.
 */
const LONG_BODY = Array.from(
  { length: 40 },
  (_, i) => `sentence ${i} carries its own distinct wording so no prefix repeats.`,
).join(" ");

let tmpDir: string;

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-snaptrunc-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  await teardownFileAppDataDir();
});

async function setupOpenedFile(initialText: string): Promise<{
  filePath: string;
  doc: Y.Doc;
  triggerReload: () => Promise<void>;
}> {
  const filePath = path.join(tmpDir, "doc.md");
  await fs.writeFile(filePath, initialText, "utf-8");
  await openFromDisk(filePath);

  const doc = getOrCreateDocument(docIdFromPath(filePath));
  const lastCall = watcherMocks.watchFile.mock.calls.at(-1);
  if (!lastCall) throw new Error("watchFile was not called by openFromDisk");
  const onChanged = lastCall[1] as (p: string) => Promise<void>;
  return { filePath, doc, triggerReload: () => onChanged(filePath) };
}

/**
 * Seed an annotation spanning the whole of `LONG_BODY`, whose stored snapshot
 * is only its first {@link SNAPSHOT_CAP} characters. `extras` supplies the
 * truncation marker — omitted entirely for the negative control, which is the
 * only difference between it and the guarded case.
 */
function seedLongAnnotation(doc: Y.Doc, extras: Partial<Annotation> = {}): string {
  const text = extractText(doc);
  const idx = text.indexOf(LONG_BODY);
  if (idx < 0) throw new Error("LONG_BODY not found in doc text");

  const result = anchoredRange(
    doc,
    toFlatOffset(idx),
    toFlatOffset(idx + LONG_BODY.length),
    LONG_BODY,
  );
  if (!result.ok) throw new Error("anchoredRange failed for LONG_BODY");

  const id = "ann_snaptrunc";
  const ann: Annotation = {
    id,
    author: "claude",
    type: "comment",
    range: result.range,
    content: "comment on the whole paragraph",
    status: "pending",
    timestamp: 0,
    // The prefix, exactly as `captureSnapshot` would store it. No relRange:
    // relocation is the fallback for annotations whose CRDT anchor is gone,
    // which is precisely the state this pass exists to handle.
    textSnapshot: LONG_BODY.slice(0, SNAPSHOT_CAP),
    rev: 1,
    ...extras,
  } as Annotation;
  withMcp(doc, () => doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, ann));
  return id;
}

function annOf(doc: Y.Doc, id: string): Annotation {
  const ann = doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).get(id);
  if (!ann) throw new Error(`annotation ${id} vanished`);
  return ann;
}

function spanOf(doc: Y.Doc, id: string): number {
  const { range } = annOf(doc, id);
  return range.to - range.from;
}

/**
 * Every `[reload-remap]` line printed while `fn` runs.
 *
 * Module-scoped rather than nested in one describe: #1767's spec asks the same
 * question — "did this reload say anything?" — and a second copy of the filter
 * is how two specs start disagreeing about what counts as silence.
 */
async function remapLogs(fn: () => Promise<void>): Promise<string[]> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await fn();
    return spy.mock.calls
      .map((args) => args.map((a) => String(a)).join(" "))
      .filter((line) => line.includes("[reload-remap]"));
  } finally {
    spy.mockRestore();
  }
}

/** Where `LONG_BODY` actually starts in the CURRENT document text. */
function expectedStart(doc: Y.Doc): number {
  const idx = extractText(doc).indexOf(LONG_BODY);
  if (idx < 0) throw new Error("LONG_BODY not in the reloaded document");
  return idx;
}

describe("#1486: a truncated snapshot is a prefix, never the whole text", () => {
  /**
   * Open with the paragraph at offset 0, then rewrite the file with a heading
   * in front of it. The paragraph's content is unchanged but its flat offsets
   * all shift, so the record is carried by the remap's exact shift.
   */
  async function reloadWithShiftedOffsets(extras: Partial<Annotation> = {}) {
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${LONG_BODY}\n`);
    const id = seedLongAnnotation(doc, extras);
    expect(spanOf(doc, id), "seeded at full length").toBe(LONG_BODY.length);

    await fs.writeFile(filePath, `# A heading that did not used to be here\n\n${LONG_BODY}\n`);
    await triggerReload();
    return { doc, id };
  }

  it("carries a flagged annotation to the moved text at its FULL span, anchored", async () => {
    const { doc, id } = await reloadWithShiftedOffsets({ textSnapshotTruncated: true });
    expect(spanOf(doc, id), "not shrunk to the cap").toBe(LONG_BODY.length);
    // Span alone passes with the annotation at completely the wrong offset;
    // the start is the other half.
    expect(annOf(doc, id).range.from, "starts where the text now starts").toBe(expectedStart(doc));
    expect(refreshRange(annOf(doc, id), doc).kind).toBe("ok");
  });

  it("carries a LEGACY truncated annotation too, by trimming the old marker", async () => {
    // Records written before the flag existed carry no `textSnapshotTruncated`
    // — only the old trailing ellipsis, three characters that are not in the
    // document. `snapshotSearchPrefix` trims them, so the stored range is seen
    // to still hold its snapshot and the record is carried and re-anchored.
    const { doc, id } = await reloadWithShiftedOffsets({
      textSnapshot: `${LONG_BODY.slice(0, SNAPSHOT_CAP - 3)}...`,
      textSnapshotTruncated: undefined,
    });
    expect(spanOf(doc, id)).toBe(LONG_BODY.length);
    expect(annOf(doc, id).range.from).toBe(expectedStart(doc));
    expect(refreshRange(annOf(doc, id), doc).kind).toBe("ok");
  });

  it("NEGATIVE CONTROL: unmarked, the same 200-char snapshot contradicts the range and is never re-anchored", async () => {
    // Not an assertion about desired behaviour so much as that the marker is
    // load-bearing. This record is byte-identical to the first test's except
    // that nothing says its snapshot is a prefix — so the 200 characters claim
    // to BE the annotated text, the full stored span contradicts them, and the
    // remap treats the record as untrusted: shifted, never minted a relRange
    // (#1764), still `degraded`. The pre-#2269 watcher's global relocation
    // shrank exactly this record to the cap instead.
    const { doc, id } = await reloadWithShiftedOffsets();
    expect(spanOf(doc, id), "neither shrunk nor extended").toBe(LONG_BODY.length);
    expect(annOf(doc, id).range.from).toBe(expectedStart(doc));
    expect(annOf(doc, id).relRange, "no anchor minted over unverified offsets").toBeUndefined();
    expect(refreshRange(annOf(doc, id), doc).kind).toBe("degraded");
  });
});

/**
 * #1752's bounds, under the remap (#2269). A carried span may never end past
 * the document, and a point record must still go through `anchoredRange`
 * (`allowEmpty`).
 */
describe("#1752: the remap keeps working under the bounds", () => {
  it("shrinks a record whose tail was deleted to the text that survived", async () => {
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${LONG_BODY}\n`);
    const id = seedLongAnnotation(doc, { textSnapshotTruncated: true });

    // Delete text from inside the annotated region, through its end: the
    // record's end anchor would resolve to the deletion point in the editor,
    // and the remap maps it there too.
    const shortened = LONG_BODY.slice(0, SNAPSHOT_CAP + 20);
    await fs.writeFile(filePath, `${shortened}\n`);
    await triggerReload();

    const ann = annOf(doc, id);
    expect(ann.range.from).toBe(0);
    expect(ann.range.to, "ends where the surviving text ends").toBe(extractText(doc).length);
    expect(extractText(doc).slice(ann.range.from, ann.range.to)).toBe(shortened);
    expect(ann.relRange, "re-anchored").toBeDefined();
  });

  it("detaches, rather than guesses, when that truncation is merged with another edit", async () => {
    // Inserting a heading on the line above makes the line diff report ONE
    // changed region covering both lines, so the record's end is inside a
    // replaced region and its old text is probed — and is not there, because
    // it was cut. Collapsed and `degraded`, never left on unrelated text.
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${LONG_BODY}\n`);
    const id = seedLongAnnotation(doc, { textSnapshotTruncated: true });

    await fs.writeFile(filePath, `# Heading\n\n${LONG_BODY.slice(0, SNAPSHOT_CAP + 20)}\n`);
    await triggerReload();

    const ann = annOf(doc, id);
    expect(ann.range.from).toBe(ann.range.to);
    expect(ann.range.to).toBeLessThanOrEqual(extractText(doc).length);
    expect(refreshRange(ann, doc).kind).toBe("degraded");
  });

  it("carries a POINT record and re-anchors it (allowEmpty)", async () => {
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${LONG_BODY}\n`);
    const idx = extractText(doc).indexOf(LONG_BODY);
    const id = "ann_point";
    withMcp(doc, () =>
      doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, {
        id,
        author: "claude",
        type: "comment",
        range: { from: toFlatOffset(idx), to: toFlatOffset(idx) },
        content: "an insertion point",
        status: "pending",
        timestamp: 0,
        rev: 1,
      } as Annotation),
    );

    await fs.writeFile(filePath, `# Heading\n\n${LONG_BODY}\n`);
    await triggerReload();

    const ann = annOf(doc, id);
    // A point sticks to the text after it, so the heading inserted above does
    // not capture it.
    expect(ann.range.from, "carried with its text").toBe(expectedStart(doc));
    expect(ann.range.to).toBe(ann.range.from);
    expect(ann.relRange, "minted for a point").toBeDefined();
  });

  it("carries a record that starts mid-emoji instead of refusing it", async () => {
    // A stored range can start between the halves of a pair (a CRDT edit
    // inside an emoji). These are derived offsets and nothing here is written
    // to a file, so the remap takes surrogates: "ignore".
    const body = `\u{1F600}${LONG_BODY}`;
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${body}\n`);
    const text = extractText(doc);
    const idx = text.indexOf(body);
    const id = "ann_midpair";
    withMcp(doc, () =>
      doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, {
        id,
        author: "claude",
        type: "comment",
        // Starts on the LOW half of the leading pair.
        range: { from: toFlatOffset(idx + 1), to: toFlatOffset(idx + 1 + SNAPSHOT_CAP) },
        content: "starts mid-pair",
        status: "pending",
        timestamp: 0,
        textSnapshot: body.slice(1, 1 + SNAPSHOT_CAP),
        textSnapshotTruncated: true,
        rev: 1,
      } as Annotation),
    );

    await fs.writeFile(filePath, `# Heading\n\n${body}\n`);
    await triggerReload();

    const ann = annOf(doc, id);
    const now = extractText(doc);
    expect(ann.range.from, "carried to the shifted mid-pair start").toBe(
      now.indexOf(body.slice(1, 1 + SNAPSHOT_CAP)),
    );
    expect(ann.range.to - ann.range.from).toBe(SNAPSHOT_CAP);
  });
});

/**
 * What the remap SAYS. A healthy record must reload in silence, and a record it
 * detaches must be named — the pre-#2269 watcher's RANGE_GONE arm was silent
 * for months while its twin logged.
 */
describe("#1752 / #2269: the remap's report", () => {
  it("says NOTHING when a capped snapshot ends mid-pair and the document did not change", async () => {
    // `captureSnapshot` caps at SNAPSHOT_CAP code units, so a body with an emoji
    // straddling that boundary makes the snapshot prefix end between the halves
    // of a pair. The record must still be seen as matching and carried.
    const body = `${"x".repeat(SNAPSHOT_CAP - 1)}\u{1F600} and then some trailing words.`;
    // Assert the fixture actually straddles the cap rather than trusting it:
    // high surrogate at CAP-1, low at CAP.
    expect(body.charCodeAt(SNAPSHOT_CAP - 1)).toBeGreaterThanOrEqual(0xd800);
    expect(body.charCodeAt(SNAPSHOT_CAP - 1)).toBeLessThanOrEqual(0xdbff);
    expect(body.charCodeAt(SNAPSHOT_CAP)).toBeGreaterThanOrEqual(0xdc00);

    const { doc, filePath, triggerReload } = await setupOpenedFile(`${body}\n`);
    const idx = extractText(doc).indexOf(body);
    const id = "ann_probe_midpair";
    withMcp(doc, () =>
      doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, {
        id,
        author: "claude",
        type: "comment",
        range: { from: toFlatOffset(idx), to: toFlatOffset(idx + body.length) },
        content: "spans the whole body",
        status: "pending",
        timestamp: 0,
        textSnapshot: body.slice(0, SNAPSHOT_CAP),
        textSnapshotTruncated: true,
        rev: 1,
      } as Annotation),
    );

    // The same bytes back: nothing moved, nothing is stale.
    const logs = await remapLogs(async () => {
      await fs.writeFile(filePath, `${body}\n`);
      await triggerReload();
    });

    expect(logs, "a healthy annotation must not be reported").toEqual([]);
    const ann = annOf(doc, id);
    expect(ann.range.from).toBe(idx);
    expect(ann.range.to).toBe(idx + body.length);
  });

  it("REPORTS an annotation whose text is gone, and leaves it degraded", async () => {
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${LONG_BODY}\n`);
    const id = seedLongAnnotation(doc, { textSnapshotTruncated: true });

    const logs = await remapLogs(async () => {
      await fs.writeFile(filePath, "# Something else entirely\n\nNothing of the original.\n");
      await triggerReload();
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(id);
    expect(logs[0]).toMatch(/detached/i);
    expect(refreshRange(annOf(doc, id), doc).kind).toBe("degraded");
  });

  it("never mints an anchor for an INVERTED stored range, and leaves it degraded", async () => {
    // `refreshRange` has an explicit arm for an inverted CRDT resolution (it
    // logs and returns `failed`, KEEPING the record's offsets), and the
    // annotations Y.Map is writable by any connected client, so an inverted
    // stored range is reachable. The pre-#2269 watcher relocated it by its
    // snapshot and then refused the inverted carried span; the remap shifts
    // each endpoint, sees an untrusted record (an inverted range slices to "",
    // which contradicts the snapshot) and mints nothing.
    const prefix = "Intro line.\n\n";
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${prefix}${LONG_BODY}\n`);
    const staleFrom = extractText(doc).indexOf(LONG_BODY);
    expect(staleFrom).toBeGreaterThan(5);
    const staleTo = staleFrom - 5;
    const id = "ann_inverted";
    withMcp(doc, () =>
      doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, {
        id,
        author: "claude",
        type: "comment",
        range: { from: toFlatOffset(staleFrom), to: toFlatOffset(staleTo) },
        content: "stored inverted",
        status: "pending",
        timestamp: 0,
        textSnapshot: LONG_BODY.slice(0, SNAPSHOT_CAP),
        textSnapshotTruncated: true,
        rev: 1,
      } as Annotation),
    );

    const heading = "# A heading that did not used to be here\n\n";
    await fs.writeFile(filePath, `${heading}${prefix}${LONG_BODY}\n`);
    await triggerReload();

    const ann = annOf(doc, id);
    const shift = extractText(doc).indexOf(LONG_BODY) - staleFrom;
    expect(shift).toBeGreaterThan(0);
    expect(ann.range).toEqual({ from: staleFrom + shift, to: staleTo + shift });
    expect(ann.relRange, "not durably pinned (#1764)").toBeUndefined();
    expect(refreshRange(ann, doc).kind).toBe("degraded");
  });
});

/**
 * #1767: a snapshot a pre-fix cap left mid-surrogate-pair must still relocate.
 *
 * `captureSnapshot` used to cut at 200 UTF-16 units unconditionally, so a
 * record written over text with an emoji straddling the cap stored a LONE HIGH
 * SURROGATE. That matched in process and matched out of the lossless JSON
 * envelope, but the first Yjs `encodeStateAsUpdate` — session persist, doc
 * swap, any client sync — re-encoded it as U+FFFD, after which the snapshot
 * occurs NOWHERE in the document. Before #2269 the watcher's probe then
 * answered RANGE_GONE forever; under the remap the same miss would read the
 * stored range as contradicting its snapshot, and the record would be carried
 * unanchored and `degraded` instead of re-anchored.
 *
 * These records are already on disk, so the writer-side back-off cannot reach
 * them; `snapshotSearchPrefix` trims the dead tail instead. This is the same
 * shape as the legacy-ellipsis case above, and it is asserted here rather than
 * only at the predicate because the placement of that trim decides whether the
 * flag-bearing population (i.e. all of it) is reached at all.
 */
describe("#1767: a split-pair snapshot tail relocates instead of going RANGE_GONE", () => {
  /** Emoji straddling the cap: high half at CAP-1, low half at CAP. */
  const STRADDLING = `${"x".repeat(SNAPSHOT_CAP - 1)}\u{1F600} ${LONG_BODY}`;

  async function reloadWithCorruptedSnapshot(storedSnapshot: string) {
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${STRADDLING}\n`);
    const text = extractText(doc);
    const idx = text.indexOf(STRADDLING);
    const id = "ann_split_tail";
    withMcp(doc, () =>
      doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, {
        id,
        author: "claude",
        type: "comment",
        range: { from: toFlatOffset(idx), to: toFlatOffset(idx + STRADDLING.length) },
        content: "spans the straddling body",
        status: "pending",
        timestamp: 0,
        textSnapshot: storedSnapshot,
        textSnapshotTruncated: true,
        rev: 1,
      } as Annotation),
    );

    const logs = await remapLogs(async () => {
      // Same paragraph, pushed down by a heading: the stored offsets are stale,
      // so relocation is the only thing that can save the annotation.
      await fs.writeFile(filePath, `# A heading that did not used to be here\n\n${STRADDLING}\n`);
      await triggerReload();
    });
    return { doc, id, logs };
  }

  /** Where `STRADDLING` starts in the CURRENT document text. */
  function straddlingStart(doc: Y.Doc): number {
    const idx = extractText(doc).indexOf(STRADDLING);
    if (idx < 0) throw new Error("STRADDLING not in the reloaded document");
    return idx;
  }

  it("FIXTURE: the emoji really does straddle the cap", () => {
    // Asserted rather than trusted. A fixture that stopped straddling would
    // make both relocation tests below pass on any implementation.
    expect(STRADDLING.charCodeAt(SNAPSHOT_CAP - 1)).toBeGreaterThanOrEqual(0xd800);
    expect(STRADDLING.charCodeAt(SNAPSHOT_CAP - 1)).toBeLessThanOrEqual(0xdbff);
    expect(STRADDLING.charCodeAt(SNAPSHOT_CAP)).toBeGreaterThanOrEqual(0xdc00);
  });

  it("relocates a record whose stored tail is U+FFFD, and says nothing", async () => {
    const corrupted = `${STRADDLING.slice(0, SNAPSHOT_CAP - 1)}\uFFFD`;
    const { doc, id, logs } = await reloadWithCorruptedSnapshot(corrupted);

    expect(logs, "no RANGE_GONE for a record the trim can still find").toEqual([]);
    const ann = annOf(doc, id);
    expect(ann.range.from, "relocated to where the text now starts").toBe(straddlingStart(doc));
    expect(ann.range.to - ann.range.from, "carried at its full span").toBe(STRADDLING.length);
    // The discriminating half under the remap: without the trim the stored
    // range would read as contradicting its snapshot and be carried
    // UNANCHORED (`degraded`). Re-anchored is what proves the trim ran.
    expect(refreshRange(ann, doc).kind, "re-anchored, not degraded").toBe("ok");
  });

  it("CONTROL: the pre-round-trip spelling of the same record was never broken here", async () => {
    // Deliberately NOT a discriminator, and labelled so no one reads it as one:
    // it is green before this fix as well. A lone HIGH surrogate is still a
    // UTF-16 prefix of the well-formed pair in the document, so `indexOf`
    // finds it and relocation was always fine — which is exactly why the bug
    // hides until a restart. The U+FFFD twin above is what discriminates, and
    // the disk spelling is pinned at the predicate in
    // `tests/shared/snapshot-contradicts.test.ts`, where a heal that handled
    // only U+FFFD does go red.
    //
    // What it does buy: a heal that over-trimmed, or one that trimmed on the
    // wrong branch, must still leave this record relocatable at its full span.
    const corrupted = STRADDLING.slice(0, SNAPSHOT_CAP);
    expect(corrupted).toHaveLength(SNAPSHOT_CAP);
    const { doc, id, logs } = await reloadWithCorruptedSnapshot(corrupted);

    expect(logs).toEqual([]);
    const ann = annOf(doc, id);
    expect(ann.range.from).toBe(straddlingStart(doc));
    expect(ann.range.to - ann.range.from).toBe(STRADDLING.length);
  });
});
