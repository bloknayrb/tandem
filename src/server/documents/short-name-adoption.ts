/**
 * Records stored under a Windows 8.3 short spelling of a file (#2400).
 *
 * Before #2400 a file opened by a short spelling (`C:\AFOLDE~1\x.md`) had its
 * session and its annotation envelope stored under a key computed from that
 * spelling (the "old key"). The same open now computes the key of the long
 * spelling (the "new key"). This module carries the old-key records over.
 *
 * **How old records are found.** Only by the key of `legacyPath`: the string
 * master's canonicalisation produced for the caller's own spelling, after it
 * passed the UNC screens in `resolveAndValidatePath`. Never by reading a stored
 * `filePath` or `meta` string, and nothing here lists, scans or stats stored
 * paths. A file opened only by its long spelling never looks at the old key.
 *
 * **One rule governs every removal.** A file under the old key is removed only
 * after everything it held is durable somewhere else, and each step runs only
 * if every earlier one completed. A step that cannot complete ENDS the
 * sequence: it is logged, the open itself succeeds, and whatever was not yet
 * removed stays and is retried the next time the file is opened by that
 * spelling (startup restore replays a kept session).
 *
 * **Nothing here can fail an open.** Every exported entry catches.
 *
 * ## Anchors: the witness
 *
 * A record's stored range is evidence only against the text it was made on.
 * When two documents for one file have diverged, a record arriving from the
 * other key would be minted at its old offsets over unrelated text by
 * `refreshRange`'s lazy arms, because a browser-made record carries no
 * `textSnapshot` and `storedRangeStillMatches` passes without one. So a record
 * from the FOREIGN side (the key whose text is not the surviving document's)
 * that has no snapshot is stamped, before it can be read, with the text its
 * range covers in that side's witness document: its session's decoded document
 * when there is one, else the file on disk. The lazy gate then mints it only
 * where that text is still there and reports `degraded` otherwise. Nothing is
 * stamped when the witness text equals the surviving text.
 *
 * A stamp must be in the new envelope before its witness can be destroyed
 * (`persistAndVerify`).
 */

import fs from "node:fs/promises";
import path from "node:path";
import * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { withFileSync, withInternal } from "../../shared/origins.js";
import type { DocumentRange, SessionData } from "../../shared/types.js";
import { contentHash, docHash } from "../annotations/doc-hash.js";
import {
  type AnnotationDocV1,
  type AnnotationRecordV1,
  isPartialParse,
  parseAnnotationDoc,
  type TombstoneRecordV1,
} from "../annotations/schema.js";
import {
  createStore,
  envelopePath,
  isStoreFeatureDisabled,
  isStoreReadOnly,
  preservePartialEnvelope,
} from "../annotations/store.js";
import {
  mergeForeignEnvelope,
  mergeSessionRecords,
  persistSnapshot,
  readSessionRecords,
} from "../annotations/sync.js";
import { getFileSyncContext } from "../events/queue.js";
import { writeDocBackupContent } from "../file-io/doc-backup.js";
import { getAdapter } from "../file-io/index.js";
import { extractTextWithBreaks } from "../mcp/document-model.js";
import { resolveAppDataDir } from "../platform.js";
import {
  captureSnapshotFromText,
  clampToFlatLength,
  relPosToFlatOffset,
  validateFlatRange,
} from "../positions.js";
import {
  decodeSessionToScratchDoc,
  deleteSession,
  type LoadedSession,
  loadSessionWithPath,
  quarantineSession,
  saveSession,
  sessionModelIsStale,
  sourceFileChanged,
} from "../session/manager.js";
import { readPendingConflict } from "./conflict.js";
import { isDirty } from "./dirty.js";
import { getOpenDocs, hasDoc } from "./registry.js";

const TAG = "[Tandem] Short-name records";

/** A saved session with its `ydocState` decoded once. */
interface Decoded {
  loaded: LoadedSession;
  scratch: Y.Doc;
}

/** What `planLegacyOpen` decided, carried through one open. */
export interface LegacyPlan {
  legacyPath: string;
  /**
   * The session `maybeRestoreSession` must use. `undefined` = load by the new
   * key exactly as an open without a legacy path does.
   */
  session?: LoadedSession | null;
  /** True when `session` came from the old key. */
  sessionIsOld: boolean;
  /** False = leave every old-key record alone on this open. */
  run: boolean;
  /** A session file exists under the old key and is not quarantined. */
  oldSessionExists: boolean;
  /** The session that will NOT be the document; its text is already backed up. */
  loser?: { side: "old" | "new"; scratch: Y.Doc };
  /** Decoded old-key session (witness for the old side), when there is one. */
  oldScratch?: Y.Doc;
  /** Set by `adoptBeforePublish` when the sequence ended early. */
  stopped?: boolean;
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** Old-key records belong to a live document when one is registered under that string. */
function legacyPathIsOpen(legacyPath: string): boolean {
  for (const d of getOpenDocs().values()) {
    if (d.source === "file" && samePath(d.filePath, legacyPath)) return true;
  }
  return false;
}

function tryDecode(loaded: LoadedSession): Y.Doc | null {
  try {
    return decodeSessionToScratchDoc(loaded.session);
  } catch {
    return null;
  }
}

function destroyQuietly(doc: Y.Doc | undefined | null): void {
  try {
    doc?.destroy();
  } catch {
    // A scratch document; nothing depends on its teardown.
  }
}

/** A stored `lastAccessed` worth carrying: a finite number not in the future. */
function carriedLastAccessed(session: SessionData | undefined): number | undefined {
  const value = session?.lastAccessed;
  return typeof value === "number" && Number.isFinite(value) && value <= Date.now()
    ? value
    : undefined;
}

/** Would today's open path restore this session? (The gates in `maybeRestoreSession`.) */
async function isUsable(d: Decoded): Promise<boolean> {
  if (d.scratch.getXmlFragment("default").length === 0) return false;
  if (sessionModelIsStale(d.loaded.session)) return false;
  if (d.loaded.session.dirty === true) return true;
  return !(await sourceFileChanged(d.loaded.session));
}

/** The document text of a decoded session, in the file's own format. Throws when it cannot. */
function serialise(scratch: Y.Doc, format: string): string {
  const adapter = getAdapter(format);
  if (!adapter.save) throw new Error(`no serialiser for format ${format}`);
  return adapter.save(scratch);
}

/**
 * Can the annotation store make a write durable for this document right now?
 * `id` undefined = before the open, when "wired" is not yet knowable.
 */
function storeCanPersist(newHash: string, openPath: string, id?: string): boolean {
  if (isStoreFeatureDisabled() || isStoreReadOnly()) return false;
  if (createStore(newHash, { filePath: openPath }).isDisabled(newHash)) return false;
  if (id === undefined) return true;
  return getFileSyncContext(id)?.docHash === newHash;
}

/**
 * Decide, before a normal open restores anything, which saved session becomes
 * the document. Returns `null` when old-key records must be left alone because
 * a live document is registered under the legacy string. Never throws.
 */
export async function planLegacyOpen(
  legacyPath: string,
  resolved: string,
  format: string,
): Promise<LegacyPlan | null> {
  const untouched: LegacyPlan = {
    legacyPath,
    sessionIsOld: false,
    run: false,
    oldSessionExists: false,
  };
  try {
    if (legacyPathIsOpen(legacyPath)) return null;
    const oldLoaded = await loadSessionWithPath(legacyPath);
    if (oldLoaded === null) return { ...untouched, run: true };

    const newLoaded = await loadSessionWithPath(resolved);
    let old: Decoded | null = null;
    const oldScratch = tryDecode(oldLoaded);
    if (oldScratch) old = { loaded: oldLoaded, scratch: oldScratch };

    if (newLoaded === null) {
      // R2.1: the old session is the only one. An undecodable one is left to
      // `maybeRestoreSession`'s own recovery (quarantine, #1750 fallback).
      return {
        legacyPath,
        session: oldLoaded,
        sessionIsOld: true,
        run: true,
        oldSessionExists: true,
        ...(old ? { oldScratch: old.scratch } : {}),
      };
    }

    const newScratch = tryDecode(newLoaded);
    if (newScratch === null) {
      await quarantineSession(newLoaded.path);
      return {
        legacyPath,
        session: oldLoaded,
        sessionIsOld: true,
        run: true,
        oldSessionExists: true,
        ...(old ? { oldScratch: old.scratch } : {}),
      };
    }
    const fresh: Decoded = { loaded: newLoaded, scratch: newScratch };
    if (old === null) {
      await quarantineSession(oldLoaded.path);
      destroyQuietly(newScratch);
      return { ...untouched, session: newLoaded, run: true };
    }

    // Two sessions for one file. A stamp from the loser must reach the new
    // envelope before the loser is destroyed, so when the store cannot persist
    // this open does nothing with the old key except keep the loser's text
    // safe. (With the feature off there is no envelope: the session carries
    // the stamps.)
    const newHash = docHash(resolved);
    if (!isStoreFeatureDisabled() && !storeCanPersist(newHash, resolved)) {
      await backUp(resolved, old.scratch, format, { acceptAnyIdentical: true });
      destroyQuietly(old.scratch);
      destroyQuietly(newScratch);
      console.error(
        `${TAG}: the annotation store cannot be written, so the session saved under the short path for ${path.basename(resolved)} was left in place.`,
      );
      return { ...untouched, session: newLoaded };
    }

    const oldAccessed = old.loaded.session.lastAccessed;
    const newAccessed = fresh.loaded.session.lastAccessed;
    const oldWins =
      (await isUsable(old)) &&
      Number.isFinite(oldAccessed) &&
      Number.isFinite(newAccessed) &&
      typeof oldAccessed === "number" &&
      typeof newAccessed === "number" &&
      oldAccessed > newAccessed;
    const loser = oldWins ? fresh : old;
    if ((await backUp(resolved, loser.scratch, format)) !== "written") {
      // R2.2's fallback: the one arrangement that cannot lose anything. The
      // new-key file is overwritten by the next autosave, so it must be the
      // document; the old-key file is left exactly as it is.
      destroyQuietly(old.scratch);
      destroyQuietly(newScratch);
      console.error(
        `${TAG}: could not store a backup of the second saved session for ${path.basename(resolved)}; it was left in place and will be retried.`,
      );
      return { ...untouched, session: newLoaded };
    }
    return {
      legacyPath,
      session: oldWins ? oldLoaded : newLoaded,
      sessionIsOld: oldWins,
      run: true,
      oldSessionExists: true,
      loser: { side: oldWins ? "new" : "old", scratch: loser.scratch },
      oldScratch: old.scratch,
    };
  } catch (err) {
    console.error(`${TAG}: planning failed for %s; old records left in place:`, resolved, err);
    return untouched;
  }
}

/**
 * Put a session's document text in the file's backups list. `"written"` also
 * when there is no text to keep. Never throws.
 */
async function backUp(
  filePath: string,
  scratch: Y.Doc,
  format: string,
  opts: { acceptAnyIdentical?: boolean } = {},
): Promise<"written" | "failed"> {
  let text: string;
  try {
    if (scratch.getXmlFragment("default").length === 0) return "written";
    text = serialise(scratch, format);
  } catch (err) {
    console.error(`${TAG}: could not serialise a saved session for %s:`, filePath, err);
    return "failed";
  }
  if (text.length === 0) return "written";
  return writeDocBackupContent(filePath, text, { appDataDir: resolveAppDataDir(), ...opts });
}

// ---------------------------------------------------------------------------
// Witness
// ---------------------------------------------------------------------------

interface Witness {
  doc: Y.Doc;
  text: string;
  breaks: ReturnType<typeof extractTextWithBreaks>["breaks"];
}

function witnessOf(doc: Y.Doc): Witness {
  const { text, breaks } = extractTextWithBreaks(doc);
  return { doc, text, breaks };
}

/** Parse the file on disk into a throwaway document. `null` when it cannot be read or parsed. */
async function diskWitness(filePath: string, format: string): Promise<Witness | null> {
  try {
    const content =
      format === "docx" ? await fs.readFile(filePath) : await fs.readFile(filePath, "utf-8");
    const adapter = getAdapter(format);
    const prepared = await adapter.parse(content);
    const scratch = new Y.Doc();
    withInternal(scratch, () => adapter.apply(scratch, prepared));
    return witnessOf(scratch);
  } catch (err) {
    console.error(`${TAG}: could not read %s as an anchor witness:`, filePath, err);
    return null;
  }
}

/** The stamp a witness gives one record: its range there, and the text that range covers. */
type Stamp = { range: DocumentRange; textSnapshot: string };

/**
 * Stamp a record that has no `textSnapshot` with the text its range covers in
 * the witness document, and drop its `relRange` (another lineage). Returns the
 * record unchanged when it already has a snapshot.
 */
function stampRecord<T extends AnnotationRecordV1>(rec: T, w: Witness): T {
  const raw = rec as unknown as {
    range?: DocumentRange;
    relRange?: { fromRel: unknown; toRel: unknown };
    textSnapshot?: unknown;
  };
  if (raw.textSnapshot !== undefined || !raw.range) return rec;
  let range: DocumentRange | null = null;
  if (raw.relRange) {
    try {
      const from = relPosToFlatOffset(w.doc, raw.relRange.fromRel as never);
      const to = relPosToFlatOffset(w.doc, raw.relRange.toRel as never);
      if (from !== null && to !== null && from <= to) range = { from, to };
    } catch {
      range = null;
    }
  }
  if (range === null) {
    const stored = raw.range;
    const valid =
      typeof stored.from === "number" &&
      typeof stored.to === "number" &&
      validateFlatRange(w.text, stored.from, stored.to, { allowEmpty: true }).ok;
    range = valid
      ? stored
      : clampToFlatLength(
          {
            from: (Number.isFinite(stored.from) ? stored.from : 0) as DocumentRange["from"],
            to: (Number.isFinite(stored.to) ? stored.to : 0) as DocumentRange["to"],
          },
          w.text.length,
        );
    if (range.from > range.to) range = { from: range.to, to: range.to };
  }
  const snap = captureSnapshotFromText(w.text, w.breaks, range.from, range.to);
  const { relRange: _relRange, ...rest } = rec as T & { relRange?: unknown };
  const stamped: Record<string, unknown> = { ...rest, range, textSnapshot: snap.text };
  delete stamped.textSnapshotTruncated;
  delete stamped.textSnapshotBreaks;
  if (snap.truncated) stamped.textSnapshotTruncated = true;
  if (snap.breaks.length > 0) stamped.textSnapshotBreaks = snap.breaks;
  return stamped as unknown as T;
}

/** Stamps applied during one adoption: id → what the envelope must hold for it. */
type Stamps = Map<string, Stamp>;

function stampAll(
  records: readonly AnnotationRecordV1[],
  w: Witness | null,
  stamps: Stamps,
): AnnotationRecordV1[] {
  if (w === null) return [...records];
  return records.map((rec) => {
    const out = stampRecord(rec, w);
    if (out !== rec) {
      const s = out as unknown as Stamp;
      stamps.set(rec.id, { range: s.range, textSnapshot: s.textSnapshot });
    }
    return out;
  });
}

function hasSnapshotless(records: readonly AnnotationRecordV1[]): boolean {
  return records.some((r) => (r as { textSnapshot?: unknown }).textSnapshot === undefined);
}

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

interface AdoptContext {
  id: string;
  doc: Y.Doc;
  /** The open document's registry path (the long spelling). */
  openPath: string;
  legacyPath: string;
  format: string;
  /** Where the surviving document's content came from. */
  survivor: "old" | "new" | "disk";
  /** Decoded old-key session, when one exists. */
  oldScratch?: Y.Doc;
  loser?: { side: "old" | "new"; scratch: Y.Doc };
}

async function readRaw(file: string): Promise<{ raw: string } | { missing: true }> {
  try {
    return { raw: await fs.readFile(file, "utf-8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    throw err;
  }
}

/**
 * Write the new envelope and prove the write landed: each id in `wrote` that
 * was stamped must be in the file with that `textSnapshot`. A resolved flush is
 * not proof (a read-only or disabled store drops the write silently). Returns
 * the parsed file, or `null` when the proof fails.
 */
async function persistAndVerify(
  ctx: AdoptContext,
  newHash: string,
  stamps: Stamps,
  wrote: ReadonlySet<string>,
): Promise<AnnotationDocV1 | null> {
  const store = getFileSyncContext(ctx.id)?.store;
  if (!store) return null;
  await persistSnapshot(store, ctx.doc, newHash, ctx.openPath);
  const back = await readRaw(envelopePath(newHash));
  if ("missing" in back) return null;
  const parsed = parseAnnotationDoc(back.raw);
  if (!parsed.ok) return null;
  const byId = new Map(parsed.doc.annotations.map((a) => [a.id, a]));
  for (const id of wrote) {
    const stamp = stamps.get(id);
    if (stamp === undefined) continue;
    const rec = byId.get(id) as { textSnapshot?: unknown } | undefined;
    // A later verified mint may have refreshed `range` and added a live
    // `relRange`; the snapshot is what proves the stamp reached the file.
    if (rec === undefined || rec.textSnapshot !== stamp.textSnapshot) {
      console.error(`${TAG}: the anchor snapshot for ${id} did not reach the annotation file.`);
      return null;
    }
  }
  return parsed.doc;
}

/** Does `now` hold everything `old` held, by the merge's own comparisons? */
function covers(now: AnnotationDocV1, old: AnnotationDocV1): boolean {
  const alive = new Map(now.annotations.map((a) => [a.id, a.rev]));
  const stones = new Map(now.tombstones.map((t) => [t.id, t.rev]));
  const replies = new Set(now.replies.map((r) => r.id));
  const missing: string[] = [];
  for (const a of old.annotations) {
    const liveRev = alive.get(a.id);
    const stoneRev = stones.get(a.id);
    if (liveRev !== undefined && liveRev >= a.rev) continue;
    if (stoneRev !== undefined && stoneRev > a.rev) continue;
    missing.push(a.id);
  }
  for (const r of old.replies) if (!replies.has(r.id)) missing.push(r.id);
  for (const t of old.tombstones) if (!stones.has(t.id)) missing.push(t.id);
  if (missing.length > 0) {
    console.error(`${TAG}: the new annotation file is missing ${missing.join(", ")}.`);
  }
  return missing.length === 0;
}

/**
 * Steps 1 and 2: the old envelope, then a losing session's own records. Runs
 * before the document is published (normal open) so no read can mint an
 * unstamped record first. Returns `false` when the sequence must end.
 */
async function adoptRecords(ctx: AdoptContext): Promise<boolean> {
  const featureOff = isStoreFeatureDisabled();
  const newHash = docHash(ctx.openPath);
  const oldHash = docHash(ctx.legacyPath);
  if (oldHash === newHash) return true;
  const canPersist = storeCanPersist(newHash, ctx.openPath, ctx.id);
  const wired = getFileSyncContext(ctx.id)?.docHash === newHash;
  const live = extractTextWithBreaks(ctx.doc).text;
  const stamps: Stamps = new Map();
  const wrote = new Set<string>();

  // The foreign side is the key whose text is not the surviving document's.
  const foreign: "old" | "new" = ctx.survivor === "old" ? "new" : "old";
  let witness: Witness | null | undefined;
  /**
   * `envelopeHash` is the foreign envelope's stored `meta.contentHash`. A
   * SESSION witness is the foreign text by construction. The file on disk is
   * the foreign text only if nothing has saved over it since, and the one
   * proof of that is the hash the envelope recorded at its last write: without
   * a match the disk file is not used, and the records keep the lazy treatment
   * they have on master (a stamp must never certify text a record was not on).
   */
  const foreignWitness = async (envelopeHash: string | undefined): Promise<Witness | null> => {
    if (witness !== undefined) return witness;
    const session =
      foreign === "old" ? ctx.oldScratch : ctx.loser?.side === "new" ? ctx.loser.scratch : null;
    let w: Witness | null;
    if (session) {
      w = witnessOf(session);
    } else {
      w = envelopeHash === undefined ? null : await diskWitness(ctx.openPath, ctx.format);
      if (w !== null && contentHash(w.text) !== envelopeHash) w = null;
    }
    // Equal text: stored ranges are as valid as they were. Nothing to stamp.
    witness = w !== null && w.text !== live ? w : null;
    return witness;
  };
  /** Is this id live in the document with an anchor that resolves there? */
  const liveAndAnchored = (id: string): boolean => {
    const rec = ctx.doc.getMap(Y_MAP_ANNOTATIONS).get(id) as
      | { relRange?: { fromRel: unknown; toRel: unknown } }
      | undefined;
    if (!rec?.relRange) return false;
    return (
      relPosToFlatOffset(ctx.doc, rec.relRange.fromRel as never) !== null &&
      relPosToFlatOffset(ctx.doc, rec.relRange.toRel as never) !== null
    );
  };

  // The new side is foreign: its envelope was merged by `wireAnnotationStore`.
  // Overlay the witness's anchor onto each record that came from it.
  // Only when the store can keep the stamp: one that lives in memory alone
  // would be lost with the session and leave the envelope's copy unstamped.
  if (foreign === "new" && canPersist) {
    const map = ctx.doc.getMap(Y_MAP_ANNOTATIONS);
    const mine = ctx.oldScratch?.getMap(Y_MAP_ANNOTATIONS);
    const candidates: AnnotationRecordV1[] = [];
    for (const [id, value] of map.entries()) {
      const rec = value as AnnotationRecordV1 & {
        textSnapshot?: unknown;
        relRange?: { fromRel: unknown; toRel: unknown };
      };
      if (!rec || typeof rec !== "object" || rec.textSnapshot !== undefined) continue;
      if (mine?.has(id)) continue;
      if (rec.relRange) {
        const from = relPosToFlatOffset(ctx.doc, rec.relRange.fromRel as never);
        const to = relPosToFlatOffset(ctx.doc, rec.relRange.toRel as never);
        if (from !== null && to !== null) continue;
      }
      candidates.push(rec);
    }
    if (candidates.length > 0) {
      let newEnvelopeHash: string | undefined;
      if (ctx.loser?.side !== "new") {
        const own = await readRaw(envelopePath(newHash));
        const parsedOwn = "missing" in own ? null : parseAnnotationDoc(own.raw);
        if (parsedOwn?.ok) newEnvelopeHash = parsedOwn.doc.meta.contentHash;
      }
      const w = await foreignWitness(newEnvelopeHash);
      if (w !== null) {
        const stamped = stampAll(candidates, w, stamps);
        withFileSync(ctx.doc, () => {
          for (const rec of stamped) {
            if (!stamps.has(rec.id)) continue;
            map.set(rec.id, rec);
            wrote.add(rec.id);
          }
        });
      }
    }
  }

  // Step 1: the old envelope.
  let oldFile: AnnotationDocV1 | null = null;
  let oldComplete = false;
  let extraTombstones: TombstoneRecordV1[] = [];
  let merged = false;
  let discardedStamps = false;
  if (!featureOff) {
    const file = envelopePath(oldHash);
    const read = await readRaw(file); // a read error other than ENOENT throws: retried
    if (!("missing" in read)) {
      const parsed = parseAnnotationDoc(read.raw);
      if (!parsed.ok) {
        // Corrupt or future-schema: what master's open does with it.
        await createStore(oldHash, { filePath: ctx.legacyPath }).load();
      } else {
        oldComplete = !isPartialParse(parsed);
        if (!oldComplete) await preservePartialEnvelope(file, read.raw);
        oldFile = parsed.doc;
        extraTombstones = parsed.doc.tombstones;
        const w =
          foreign === "old" && hasSnapshotless(parsed.doc.annotations)
            ? await foreignWitness(parsed.doc.meta.contentHash)
            : null;
        const before = stamps.size;
        // A record that is already live here with an anchor that resolves
        // belongs to this document's own lineage (a carry-over that stopped
        // half way and is being retried): its anchor is better than any stamp.
        const annotations = parsed.doc.annotations.map((rec) =>
          liveAndAnchored(rec.id) ? rec : stampAll([rec], w, stamps)[0],
        );
        const stampedHere = stamps.size > before;
        // A stamped record must not enter a document whose store cannot keep
        // the stamp; an unwired document has no ledger to carry tombstones.
        if (wired && (canPersist || !stampedHere)) {
          const result = mergeForeignEnvelope(
            ctx.doc,
            { annotations, replies: parsed.doc.replies, tombstones: parsed.doc.tombstones },
            newHash,
          );
          for (const id of result.annotationIds) wrote.add(id);
          merged = true;
        } else if (stampedHere) {
          for (const a of parsed.doc.annotations) stamps.delete(a.id);
          discardedStamps = true;
        }
      }
    }
  }

  // Step 2: the losing session's own records.
  if (ctx.loser) {
    const loserWitness = witnessOf(ctx.loser.scratch);
    const records = readSessionRecords(ctx.loser.scratch, newHash);
    // Stamps go into a side table first: only a record the fold actually
    // wrote may be checked against its stamp (a copy that lost to the live one
    // must not replace the stamp the live one was written with).
    const foldStamps: Stamps = new Map();
    const annotations = stampAll(
      records.annotations,
      loserWitness.text !== live ? loserWitness : null,
      foldStamps,
    );
    const result = mergeSessionRecords(
      ctx.doc,
      { annotations, replies: records.replies },
      newHash,
      extraTombstones,
    );
    for (const id of result.annotationIds) {
      wrote.add(id);
      const stamp = foldStamps.get(id);
      if (stamp !== undefined) stamps.set(id, stamp);
      else stamps.delete(id);
    }
  }

  // Durability: every stamp written must be in the new envelope before a
  // witness can go; the old envelope is cleared only when the new one holds
  // everything it held.
  const stampedWrites = [...wrote].some((id) => stamps.has(id));
  if (featureOff) return true;
  // Old-envelope stamps were dropped because the store cannot keep them, and
  // the session they came from is not the document: removing that session now
  // would destroy the only witness.
  if (discardedStamps && ctx.oldScratch && ctx.survivor !== "old") return false;
  if (!canPersist) {
    if (stampedWrites && (ctx.loser || ctx.survivor !== "disk")) {
      console.error(
        `${TAG}: anchor snapshots for ${path.basename(ctx.openPath)} could not be saved; old records left in place.`,
      );
      return false;
    }
    return true;
  }
  if (wrote.size === 0 && !merged) return true;
  const now = await persistAndVerify(ctx, newHash, stamps, wrote);
  if (now === null) return false;
  if (merged && oldFile !== null && oldComplete) {
    if (!covers(now, oldFile)) return false;
    try {
      await createStore(oldHash, { filePath: ctx.legacyPath }).clear();
    } catch (err) {
      console.error(`${TAG}: could not remove the old annotation file:`, err);
    }
  }
  return true;
}

/** Old-key sessions whose unlink failed after their content was made safe: id → legacy path. */
const pendingRemoval = new Map<string, string>();

/**
 * Called by `closeDocumentById` after it has dealt with the document's own
 * session: retry an old-key session unlink that failed earlier, unless a live
 * document is registered under that string.
 */
export async function removePendingLegacySession(id: string): Promise<void> {
  const legacyPath = pendingRemoval.get(id);
  if (legacyPath === undefined) return;
  pendingRemoval.delete(id);
  if (legacyPathIsOpen(legacyPath)) return;
  await deleteSession(legacyPath);
}

/** Test-only. */
export function _resetShortNameAdoptionForTests(): void {
  pendingRemoval.clear();
}

/** Steps 3 and 4: make the document's session durable under the new key, then remove the old one. */
async function moveSession(
  id: string,
  doc: Y.Doc,
  openPath: string,
  legacyPath: string,
  format: string,
  lastAccessed: number | undefined,
): Promise<void> {
  // Closed while the sequence ran: nothing to save, and the old session stays.
  if (!hasDoc(id)) return;
  try {
    await saveSession(openPath, format, doc, {
      dirty: isDirty(id),
      conflict: readPendingConflict(doc),
      ...(lastAccessed !== undefined ? { lastAccessed } : {}),
    });
  } catch (err) {
    console.error(`${TAG}: could not save the session for %s under its long path:`, openPath, err);
    return;
  }
  if (!(await deleteSession(legacyPath))) {
    console.error(
      `${TAG}: the session saved under the short path for ${path.basename(openPath)} could not be removed; it will be retried when the document closes.`,
    );
    pendingRemoval.set(id, legacyPath);
  }
}

/**
 * Normal open, inside `finalizeDocOpen`'s prepare callback, after
 * `wireAnnotationStore`. Never throws; records the outcome on the plan.
 */
export async function adoptBeforePublish(
  plan: LegacyPlan,
  args: { id: string; doc: Y.Doc; openPath: string; format: string; restored: boolean },
): Promise<void> {
  if (!plan.run) return;
  try {
    const ok = await adoptRecords({
      id: args.id,
      doc: args.doc,
      openPath: args.openPath,
      legacyPath: plan.legacyPath,
      format: args.format,
      survivor: args.restored ? (plan.sessionIsOld ? "old" : "new") : "disk",
      ...(plan.oldScratch ? { oldScratch: plan.oldScratch } : {}),
      ...(plan.loser ? { loser: plan.loser } : {}),
    });
    if (!ok) plan.stopped = true;
  } catch (err) {
    plan.stopped = true;
    console.error(
      `${TAG}: carrying over annotations failed for %s; old records left in place:`,
      args.openPath,
      err,
    );
  }
}

/**
 * Normal open, after the dirty flag and any conflict are re-raised: move the
 * session to the new key. Never throws.
 */
export async function finishLegacyOpen(
  plan: LegacyPlan,
  args: { id: string; doc: Y.Doc; openPath: string; format: string; restored: boolean },
): Promise<void> {
  try {
    // A stop keeps the old session only where it is still needed as a witness
    // or as an unfolded loser. When the old session IS the document (it was
    // restored and there is no second session), nothing depends on its file
    // any more: leaving it would bring a closed document back, at the next
    // start, as it was before every edit made since (R2.5).
    const oldIsTheDocument = plan.sessionIsOld && args.restored && plan.loser === undefined;
    if (plan.run && plan.oldSessionExists && (!plan.stopped || oldIsTheDocument)) {
      await moveSession(
        args.id,
        args.doc,
        args.openPath,
        plan.legacyPath,
        args.format,
        args.restored ? carriedLastAccessed(plan.session?.session) : undefined,
      );
    }
  } catch (err) {
    console.error(`${TAG}: moving the session failed for %s:`, args.openPath, err);
  } finally {
    destroyQuietly(plan.oldScratch);
    destroyQuietly(plan.loser?.scratch);
  }
}

/**
 * A short-spelled open of a document that is ALREADY open (R2.3). The open
 * document wins and its content is never replaced; an old-key session is kept
 * as a backup and its records merged in. Never throws.
 */
export async function adoptIntoOpenDocument(args: {
  id: string;
  doc: Y.Doc;
  openPath: string;
  legacyPath: string;
  format: string;
}): Promise<void> {
  let scratch: Y.Doc | null = null;
  try {
    if (legacyPathIsOpen(args.legacyPath)) return;
    const newHash = docHash(args.openPath);
    const persistable =
      isStoreFeatureDisabled() || storeCanPersist(newHash, args.openPath, args.id);
    const loaded = await loadSessionWithPath(args.legacyPath);
    if (loaded !== null) {
      scratch = tryDecode(loaded);
      if (scratch === null) {
        await quarantineSession(loaded.path);
      } else if (!persistable) {
        // The store cannot keep a stamp: keep the text safe and leave the rest.
        await backUp(args.openPath, scratch, args.format, { acceptAnyIdentical: true });
        console.error(
          `${TAG}: the annotation store cannot be written, so the session saved under the short path for ${path.basename(args.openPath)} was left in place.`,
        );
        return;
      } else if ((await backUp(args.openPath, scratch, args.format)) !== "written") {
        console.error(
          `${TAG}: could not store a backup of the session saved under the short path for ${path.basename(args.openPath)}; it was left in place and will be retried.`,
        );
        return;
      }
    }
    const ok = await adoptRecords({
      id: args.id,
      doc: args.doc,
      openPath: args.openPath,
      legacyPath: args.legacyPath,
      format: args.format,
      survivor: "new",
      ...(scratch ? { oldScratch: scratch, loser: { side: "old" as const, scratch } } : {}),
    });
    if (ok && scratch !== null) {
      await moveSession(args.id, args.doc, args.openPath, args.legacyPath, args.format, undefined);
    }
  } catch (err) {
    console.error(
      `${TAG}: carrying over records failed for %s; old records left in place:`,
      args.openPath,
      err,
    );
  } finally {
    destroyQuietly(scratch);
  }
}
