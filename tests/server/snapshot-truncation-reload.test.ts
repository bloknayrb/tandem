/**
 * The reload relocation pass must not chase a TRUNCATED `textSnapshot` (#1486).
 *
 * `captureSnapshot` caps snapshots at 200 characters. The relocation pass in
 * `reloadFromDisk` finds the snapshot with `indexOf` and re-anchors the
 * annotation to `match + snapshot.length` — correct for a whole snapshot, and
 * for a PREFIX it silently moves the annotation's end to the cap. A 900-word
 * annotation becomes a 200-character one, on every reload, with no error and no
 * notification. Accept then replaces the wrong span, and the `.docx` apply
 * guard — which compares the same slice — starts PASSING on the shrunken range
 * instead of rejecting it.
 *
 * This hazard was DORMANT before #1486 and opened by its first draft. The old
 * code marked the cut with a trailing `"..."`, which occurs nowhere in the
 * document, so `indexOf` missed, `validateRange` returned RANGE_GONE, and the
 * pass left the annotation alone by accident. Removing the marker to fix the
 * UNDO path made the prefix findable and turned that accident into corruption.
 * The negative control below is the point of this file: it drives the same
 * reload with the guard's input removed and shows the shrink actually happens,
 * so a future deletion of the guard cannot pass as a no-op.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

vi.mock("../../src/server/platform", async (importOriginal) => {
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
vi.mock("../../src/server/file-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: watcherMocks.watchFile,
}));

vi.mock("../../src/server/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/notifications.js")>();
  return { ...actual, pushNotification: vi.fn() };
});

import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { docIdFromPath, extractText } from "../../src/server/mcp/document-model.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { anchoredRange } from "../../src/server/positions.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { withMcp } from "../../src/shared/origins.js";
import { toFlatOffset } from "../../src/shared/positions/types.js";
import { SNAPSHOT_CAP } from "../../src/shared/snapshot.js";
import type { Annotation } from "../../src/shared/types.js";

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
  const appDataDir = process.env.TANDEM_APP_DATA_DIR;
  if (appDataDir) await fs.rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.TANDEM_APP_DATA_DIR;
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

/** Where `LONG_BODY` actually starts in the CURRENT document text. */
function expectedStart(doc: Y.Doc): number {
  const idx = extractText(doc).indexOf(LONG_BODY);
  if (idx < 0) throw new Error("LONG_BODY not in the reloaded document");
  return idx;
}

describe("#1486: reload relocation skips truncated snapshots", () => {
  /**
   * Open with the paragraph at offset 0, then rewrite the file with a heading
   * in front of it. The paragraph's content is unchanged but its flat offsets
   * all shift, so the stored range no longer validates and the relocation pass
   * is the code under test.
   */
  async function reloadWithShiftedOffsets(extras: Partial<Annotation> = {}) {
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${LONG_BODY}\n`);
    const id = seedLongAnnotation(doc, extras);
    expect(spanOf(doc, id), "seeded at full length").toBe(LONG_BODY.length);

    await fs.writeFile(filePath, `# A heading that did not used to be here\n\n${LONG_BODY}\n`);
    await triggerReload();
    return { doc, id };
  }

  it("relocates a flagged annotation to the moved text at its FULL span", async () => {
    const { doc, id } = await reloadWithShiftedOffsets({ textSnapshotTruncated: true });
    expect(spanOf(doc, id), "not shrunk to the cap").toBe(LONG_BODY.length);
    // The half an earlier draft of this test could not see. Asserting the span
    // alone passes with the annotation anchored at completely the wrong offset
    // — which is what a bare `continue` here produced: correct length, stale
    // start, and a freshly minted `relRange` cementing it.
    expect(annOf(doc, id).range.from, "starts where the text now starts").toBe(expectedStart(doc));
  });

  it("relocates a LEGACY truncated annotation too, by trimming the old marker", async () => {
    // Records written before the flag existed carry no `textSnapshotTruncated`
    // — only the old trailing ellipsis. Those three characters are not in the
    // document, so searching for the snapshot as stored finds nothing and the
    // annotation falls to RANGE_GONE: it survives, but stranded at stale
    // offsets. `snapshotSearchPrefix` trims them, which turns the accidental
    // miss into a real relocation.
    const { doc, id } = await reloadWithShiftedOffsets({
      textSnapshot: `${LONG_BODY.slice(0, SNAPSHOT_CAP - 3)}...`,
      textSnapshotTruncated: undefined,
    });
    expect(spanOf(doc, id)).toBe(LONG_BODY.length);
    expect(annOf(doc, id).range.from).toBe(expectedStart(doc));
  });

  it("NEGATIVE CONTROL: unmarked, the same 200-char snapshot shrinks the span to the cap", async () => {
    // Not an assertion about desired behaviour — an assertion that the marker
    // is load-bearing. This annotation is byte-identical to the first test's
    // except that nothing says its snapshot is a prefix, so the pass believes
    // the 200 characters ARE the annotated text and re-anchors the end to the
    // match's end. Remove the `truncated` branch in `file-opener.ts` and the
    // two tests above collapse onto this result.
    //
    // It also pins the shape a legitimately-200-character annotation must keep:
    // for that one, shrinking to 200 is CORRECT, because 200 is its true span.
    const { doc, id } = await reloadWithShiftedOffsets();
    expect(spanOf(doc, id)).toBe(SNAPSHOT_CAP);
    expect(annOf(doc, id).range.from).toBe(expectedStart(doc));
  });
});

/**
 * #1752: the relocation call below the fixed one must survive the new rules.
 *
 * `resolvedTo = resolvedFrom + span` carries the ORIGINAL span, so if the
 * external edit deleted text INSIDE the annotated region the computed end now
 * exceeds the new document length. Before this change `resolveToElement`'s
 * clamp made `anchoredRange` succeed anyway; after it, an unclamped call
 * returns INVALID_RANGE — and `if (relocated.ok)` has no `else`, while
 * `refreshAllRanges` has already minted a fresh `relRange` from the STALE flat
 * offsets. That is the durable mispin the #1486 comment describes as the first
 * draft's bug, re-opened by a bounds check.
 *
 * Every fixture here is TRUNCATED on purpose. On the non-truncated branch
 * `resolvedTo = best + snapshot.length` can never exceed the length (the
 * snapshot was just found in the text) and can never be empty, so a
 * non-truncated fixture passes vacuously.
 */
describe("#1752: the relocation call keeps working under the new bounds", () => {
  it("clamps a relocated end past the new document length instead of mispinning", async () => {
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${LONG_BODY}\n`);
    const id = seedLongAnnotation(doc, { textSnapshotTruncated: true });

    // Shift the start AND delete text from inside the annotated region, so the
    // carried span overshoots the end of the shorter document.
    const shortened = LONG_BODY.slice(0, SNAPSHOT_CAP + 20);
    await fs.writeFile(filePath, `# Heading\n\n${shortened}\n`);
    await triggerReload();

    const ann = annOf(doc, id);
    const len = extractText(doc).length;
    expect(ann.range.from, "relocated to where the prefix now is").toBe(
      extractText(doc).indexOf(shortened.slice(0, SNAPSHOT_CAP)),
    );
    expect(ann.range.to, "clamped to the document end, not left past it").toBeLessThanOrEqual(len);
    expect(ann.range.to).toBeGreaterThan(ann.range.from);
  });

  it("relocates a COLLAPSED annotation (span 0) rather than dropping it into the no-else hole", async () => {
    // `refreshRange` can resolve a relRange to newFrom === newTo (#1764's
    // acknowledged zero-length output) while the annotation keeps its older
    // non-empty snapshot: it passes the `!ann.textSnapshot` guard and the
    // `probe.length === 0` guard, reaches this call with span 0, and the new
    // `empty` rule would reject it. Hence `allowEmpty: true` here.
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${LONG_BODY}\n`);
    const text = extractText(doc);
    const idx = text.indexOf(LONG_BODY);
    const id = "ann_collapsed";
    withMcp(doc, () =>
      doc.getMap<Annotation>(Y_MAP_ANNOTATIONS).set(id, {
        id,
        author: "claude",
        type: "comment",
        // Collapsed range, non-empty truncated snapshot.
        range: { from: toFlatOffset(idx), to: toFlatOffset(idx) },
        content: "collapsed",
        status: "pending",
        timestamp: 0,
        textSnapshot: LONG_BODY.slice(0, SNAPSHOT_CAP),
        textSnapshotTruncated: true,
        rev: 1,
      } as Annotation),
    );

    await fs.writeFile(filePath, `# Heading\n\n${LONG_BODY}\n`);
    await triggerReload();

    const ann = annOf(doc, id);
    expect(ann.range.from, "relocated, not left at the stale offset").toBe(expectedStart(doc));
    expect(ann.range.to).toBe(ann.range.from);
  });

  it("relocates when the capped probe starts mid-emoji instead of mispinning", async () => {
    // `resolvedFrom` is `fullText.indexOf(probe)` and the probe is a
    // character-count-capped PREFIX (#1486), so it can be cut between the
    // halves of a pair. These are derived offsets and nothing here is
    // serialized to a file, so the relocation call takes surrogates: "ignore".
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
    expect(ann.range.from, "relocated to the shifted mid-pair start").toBe(
      now.indexOf(body.slice(1, 1 + SNAPSHOT_CAP)),
    );
    expect(ann.range.to).toBeGreaterThan(ann.range.from);
  });
});

/**
 * #1752 round 2: the relocation PROBE's own options, and the arm that reports a
 * relocation it could not do.
 *
 * These two are a pair. The probe decides whether an annotation is healthy; the
 * `else` arm below `RANGE_MOVED` is what SAYS SO when it is not. Get the probe's
 * options wrong and that arm fires on a healthy annotation forever; delete the
 * arm and a genuinely mispinned one goes back to being silent. Neither had a
 * spec, and both were silent for months.
 */
describe("#1752: the relocation probe and its failure report", () => {
  /** Every `[watcher]` line printed while `fn` runs. */
  async function watcherLogs(fn: () => Promise<void>): Promise<string[]> {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await fn();
      return spy.mock.calls
        .map((args) => args.map((a) => String(a)).join(" "))
        .filter((line) => line.includes("[watcher]"));
    } finally {
      spy.mockRestore();
    }
  }

  it("says NOTHING when a capped probe ends mid-pair and the document did not change", async () => {
    // The probe range ends at `from + probe.length`, and `captureSnapshot` caps
    // a snapshot at SNAPSHOT_CAP code units — so a body with an emoji straddling
    // that boundary puts `probeTo` between the halves of a pair. On a reload
    // that does NOT move the annotation, staleness passes and the surrogate
    // check is the next thing to run: without `surrogates: "ignore"` on the
    // PROBE it answers INVALID_RANGE, which is not RANGE_MOVED, so a perfectly
    // healthy annotation takes the failure arm and is reported as durably
    // mispinned — on every reload, forever.
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
    const logs = await watcherLogs(async () => {
      await fs.writeFile(filePath, `${body}\n`);
      await triggerReload();
    });

    expect(logs, "a healthy annotation must not be reported as mispinned").toEqual([]);
    const ann = annOf(doc, id);
    expect(ann.range.from).toBe(idx);
    expect(ann.range.to).toBe(idx + body.length);
  });

  it("REPORTS an annotation whose text is gone rather than leaving it silently mispinned", async () => {
    // This arm was silent while its RANGE_MOVED twin logged, and the outcome is
    // identical: `refreshAllRanges` has already re-anchored a fresh relRange
    // onto the stale flat offsets, so the record is durably pinned to
    // coordinates describing different text and nothing revisits it.
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${LONG_BODY}\n`);
    const id = seedLongAnnotation(doc, { textSnapshotTruncated: true });

    const logs = await watcherLogs(async () => {
      // The annotated paragraph is gone entirely, so the staleness search finds
      // the probe nowhere and answers RANGE_GONE.
      await fs.writeFile(filePath, "# Something else entirely\n\nNothing of the original.\n");
      await triggerReload();
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(id);
    expect(logs[0]).toContain("RANGE_GONE");
    expect(logs[0]).toMatch(/stale coordinates/i);
  });

  it("REPORTS a RANGE_MOVED relocation the bounds check refuses, and leaves the record where it was", async () => {
    // The twin of the arm above, on the RANGE_MOVED side: the text was FOUND,
    // the relocation was computed, and `anchoredRange` still said no.
    //
    // What can still make it say no, after #1752's clamp: the clamp bounds
    // `resolvedTo` from ABOVE (`Math.min(..., text.length)`) and nothing bounds
    // it from below, so a stored range whose `to` precedes its `from` carries a
    // NEGATIVE span and `resolvedFrom + span` lands before `resolvedFrom` —
    // `inverted`, which `allowEmpty` does not excuse. That state is reachable
    // rather than hypothetical: `refreshRange` has an explicit arm for an
    // inverted CRDT resolution (it logs and returns `failed`, KEEPING the
    // record's offsets), and the annotations Y.Map is writable by any connected
    // client. The probe itself is unbothered — staleness runs before the shape
    // and bound checks, so `fullText.slice(from, to)` on an inverted range is
    // `""`, never the probe, and the answer is RANGE_MOVED.
    const prefix = "Intro line.\n\n";
    const { doc, filePath, triggerReload } = await setupOpenedFile(`${prefix}${LONG_BODY}\n`);
    const staleFrom = extractText(doc).indexOf(LONG_BODY);
    expect(staleFrom).toBeGreaterThan(5);
    const staleTo = staleFrom - 5;
    const id = "ann_inverted_relocation";
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

    const logs = await watcherLogs(async () => {
      // Same paragraph, shifted: the probe is found at a new offset, so the
      // pass reaches the relocation call rather than RANGE_GONE.
      await fs.writeFile(
        filePath,
        `# A heading that did not used to be here\n\n${prefix}${LONG_BODY}\n`,
      );
      await triggerReload();
    });

    const movedTo = expectedStart(doc);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`Relocation rejected for annotation ${id}`);
    // The pair it refused, spelled out — this is what pins the clamp's
    // arithmetic rather than merely the fact that something was logged.
    expect(logs[0]).toContain(`[${movedTo}, ${movedTo - 5}]`);
    expect(logs[0]).toMatch(/stale coordinates/i);

    // The consequence the message claims, asserted rather than trusted: the
    // record still carries its pre-reload offsets, they no longer describe the
    // annotated text, and `refreshAllRanges` has already minted a relRange from
    // them — so nothing will revisit it.
    const ann = annOf(doc, id);
    expect(ann.range.from, "not relocated").toBe(staleFrom);
    expect(ann.range.to).toBe(staleTo);
    expect(ann.relRange, "durably pinned, not merely left alone").toBeDefined();
    expect(extractText(doc).slice(staleFrom, staleFrom + SNAPSHOT_CAP)).not.toBe(
      LONG_BODY.slice(0, SNAPSHOT_CAP),
    );
  });
});
