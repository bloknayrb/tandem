import fs from "fs/promises";
import path from "path";
import * as Y from "yjs";
import {
  CTRL_ROOM,
  DOCUMENT_MODEL_REVISION,
  SESSION_MAX_AGE,
  Y_MAP_CHAT,
  Y_MAP_CHAT_DOCUMENT_NAMES,
  Y_MAP_CHAT_STREAM,
  Y_MAP_DOCUMENT_META,
  Y_MAP_READ_ONLY,
} from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import { isUploadPath } from "../../shared/paths.js";
import type { ExternalConflictState, SessionData } from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";
import { docHash, ENVELOPE_FILENAME_RE } from "../annotations/doc-hash.js";
import { parseAnnotationDoc } from "../annotations/schema.js";
import { createStore, getAnnotationsDir, isStoreReadOnly } from "../annotations/store.js";
import { reconcileStreamSidecars } from "../chat-stream-staleness.js";
import { atomicWrite } from "../file-io/index.js";
import { pushNotification } from "../notifications.js";
import { SESSION_DIR } from "../platform.js";

const AUTO_SAVE_INTERVAL = 60 * 1000; // 60 seconds
let sessionDirReady = false;

/**
 * Generate a session key (= the session FILENAME stem) from a file path.
 *
 * **Disk paths hash; upload paths keep the legacy encoding (#1750).**
 * `encodeURIComponent` turns every `/` into a 3-byte `%2F`, so a 90-character
 * path became a 200+-byte filename and ext4/NTFS refused it at 255 —
 * `saveSession` threw `ENAMETOOLONG` on paths that are not unusual, and
 * (before the per-document try/catch in the autosave loop) that one throw took
 * the whole 60 s flush down with it. `docHash` is a fixed 64 hex characters,
 * no separators, no encoding, and it CONVERGES this key with the two other
 * per-document keys that already use it: durable annotations and doc-backups.
 *
 * Uploads deliberately do NOT hash. `docHash` collapses every scratchpad to the
 * single key `upload_scratchpad` (they are all `upload://scratchpad/<uuid>/…`),
 * and sessions ARE written for scratchpads, so two open scratchpads would
 * clobber one file every 60 s. Upload paths are ~60 synthetic characters and
 * were never in #1750's scope.
 *
 * Two identity changes for disk paths, both intended: on win32 `docHash`
 * lowercases, so `C:\Docs\A.md` and `c:\docs\a.md` now share one session —
 * matching `docIdFromPath`, which already gives them one Hocuspocus room. On
 * POSIX they remain distinct (paths are case-sensitive), which is unchanged.
 *
 * The two namespaces cannot collide: an `encodeURIComponent` name of an
 * absolute path always contains `%2F`, so it can never look like 64 hex.
 */
export function sessionKey(filePath: string): string {
  if (isUploadPath(filePath)) return legacySessionKey(filePath);
  return docHash(filePath);
}

/**
 * The pre-#1750 key. Still the live key for `upload://` paths, and still read
 * for disk paths during the one-shot migration (`loadSession` looks for both
 * names; `saveSession` removes this one after the first successful write under
 * the new key; `deleteSession` unlinks both).
 */
export function legacySessionKey(filePath: string): string {
  return encodeURIComponent(filePath.replace(/\\/g, "/"));
}

/** The session file for `filePath` under the current (`sessionKey`) name. */
function sessionPathFor(filePath: string): string {
  return path.join(SESSION_DIR, `${sessionKey(filePath)}.json`);
}

/**
 * The old-name session path for a disk path, or null when there is no distinct
 * old name (uploads, whose key never changed, and the ctrl session, which has
 * its own literal name).
 *
 * "Distinct" is decided HERE, not at each of the three call sites: all of them
 * want the same question answered — is there a SECOND file to migrate, prefer
 * or unlink — and each used to re-derive it as
 * `legacyPath !== null && legacyPath !== sessionPath`. Folding it in also keeps
 * the equality next to its rationale: an `encodeURIComponent` name of an
 * absolute path always contains `%2F`, so it can never equal 64 hex characters,
 * which makes the check belt-and-braces rather than a live case.
 *
 * **TOTAL: an unspellable old name is null, not a throw.** `legacySessionKey`
 * is `encodeURIComponent`, which throws `URIError` on a lone surrogate — and
 * that is the right answer to give here, because a path whose legacy encoding
 * does not exist cannot have a legacy file on disk. Letting it throw instead
 * put a landmine in all three callers, one of which is genuinely severe:
 * `saveSession` derives this AFTER its `atomicWrite`, so the throw reported
 * failure for a session write that had fully succeeded. That is the #1750 class
 * this branch exists to close — a save that worked and said it didn't — and it
 * also falsified `saveDocumentToDisk`'s catch, which tells the user their
 * recovery state was not recorded while the current record sits on disk. The
 * other two: `loadSession` would reject on open, and `deleteSession` (which
 * derives both names outside its per-target `try`) would delete nothing.
 *
 * Narrowed to `URIError` on purpose. Anything else from `path.join` or
 * `sessionPathFor` is unexpected and should still surface.
 */
function legacySessionPath(filePath: string): string | null {
  if (isUploadPath(filePath)) return null;
  let legacyPath: string;
  try {
    legacyPath = path.join(SESSION_DIR, `${legacySessionKey(filePath)}.json`);
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
    return null;
  }
  return legacyPath === sessionPathFor(filePath) ? null : legacyPath;
}

/**
 * Save Y.Doc state + metadata as a session file.
 *
 * `opts.dirty` (#1069): pass true when the doc holds body edits not yet written
 * to disk (callers that know the docId pass `isDirty(docId)`). Consumed on
 * reopen by the restore-vs-reload prompt — a dirty session is the only copy of
 * those edits, so it restores even over a changed source file.
 * Omitted (falsy) → field absent, matching pre-#1069 sessions.
 *
 * `opts.conflict` (#1238): the pending external-conflict flag, if any, so an
 * unresolved keep-vs-reload choice survives a restart. Deliberately an EXPLICIT
 * option rather than a read off `doc` here: on the successful-save path the
 * caller writes the session BEFORE clearing the flag, so a self-read would
 * persist a conflict the save just resolved and re-raise a banner on a clean,
 * in-sync document.
 *
 * `readOnly` is the mirror-image decision: derived HERE off `doc`, never an
 * option — because it is a different KIND of flag from the two above. `dirty`
 * and `conflict` are point-in-time snapshots of a save race that only the
 * caller can take. `readOnly` is static document metadata that `writeDocMeta`
 * already mirrors into the Y.Map in lockstep with the open-docs registry on
 * every open path, so there is no moment at which caller and doc disagree.
 *
 * Given that, deriving once here is the safer half of the trade: `saveSession`
 * rewrites the whole record with no merge, and two call sites
 * (`document-service`'s save-all and the 60s autosave tick) are unconditional
 * loops over every open document — so a tenth call site that forgot to pass the
 * flag would not merely fail to set it, it would erase a correct value on a
 * timer.
 */
export async function saveSession(
  filePath: string,
  format: string,
  doc: Y.Doc,
  opts?: { dirty?: boolean; conflict?: ExternalConflictState },
): Promise<void> {
  let sourceFileMtime = 0;
  // Upload paths have no disk file — skip stat
  if (!isUploadPath(filePath)) {
    try {
      const stat = await fs.stat(filePath);
      sourceFileMtime = stat.mtimeMs;
    } catch {
      // File may not exist yet (new doc)
    }
  }

  const state = Y.encodeStateAsUpdate(doc);
  const ydocState = Buffer.from(state).toString("base64");

  const readOnly = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_READ_ONLY) === true;

  const data: SessionData = {
    filePath,
    format,
    ydocState,
    sourceFileMtime,
    lastAccessed: Date.now(),
    modelRevision: DOCUMENT_MODEL_REVISION,
    ...(opts?.dirty ? { dirty: true } : {}),
    ...(opts?.conflict ? { conflict: opts.conflict } : {}),
    // Conditional spread, not `readOnly`, so a writable document's record stays
    // byte-identical to the shape it had before this field existed.
    ...(readOnly ? { readOnly: true } : {}),
  };

  if (!sessionDirReady) {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    sessionDirReady = true;
  }
  await atomicWrite(sessionPathFor(filePath), JSON.stringify(data));

  // One-shot #1750 migration, ORDERED AFTER the successful write: a failed
  // new-key save must leave the old file intact, or an ENOSPC destroys the only
  // record. `loadSession` deliberately does not delete the loser at load time —
  // a "successful load" is only a successful `JSON.parse`, and a record whose
  // `ydocState` is corrupt parses fine and throws later in `restoreYDoc`.
  const legacyPath = legacySessionPath(filePath);
  if (legacyPath !== null) {
    await fs.unlink(legacyPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") {
        console.error("[Tandem] Failed to remove migrated session", legacyPath, err);
      }
    });
  }
}

/**
 * What `loadSessionWithPath` returns: the mtime-winning record alongside the
 * absolute path it was actually read from, plus the migration loser as a
 * fallback candidate when it also parsed. `null` when neither file exists.
 *
 * The path rides along because the quarantine must rename the file that was
 * actually parsed — post-#1750 arbitration picks between two names, and a
 * second resolver called later could pick a different winner if the mtimes
 * moved between the two reads. `{ session, path }`, not a standalone
 * resolver.
 */
export interface LoadedSession {
  session: SessionData;
  path: string;
  fallback?: { session: SessionData; path: string };
}

/**
 * Load a session file if it exists, reporting which file won.
 *
 * Reads BOTH the current (`docHash`) name and the pre-#1750
 * `encodeURIComponent` name; when both exist the newer file MTIME wins. The
 * loser is not deleted here — see `saveSession`, which removes the old name
 * only after a successful write under the new one. Until then every load pays
 * one extra `stat`, which is fine for a one-shot window.
 *
 * Each candidate's read+parse is INDEPENDENTLY guarded: a winner that parses
 * alongside a fallback that is `{` keeps the winner, and the unparseable
 * fallback is quarantined and simply absent from the result. One `try`
 * around both reads would lose a good winner.
 */
export async function loadSessionWithPath(filePath: string): Promise<LoadedSession | null> {
  const currentPath = sessionPathFor(filePath);
  const legacyPath = legacySessionPath(filePath);
  let sessionPath = currentPath;
  if (legacyPath !== null) {
    const [current, legacy] = await Promise.all([mtimeOf(currentPath), mtimeOf(legacyPath)]);
    if (legacy !== null && (current === null || legacy > current)) {
      sessionPath = legacyPath;
    }
  }
  const loserPath = sessionPath === currentPath ? legacyPath : currentPath;

  const winner = await readSessionFile(sessionPath, filePath);
  if (winner.ok) {
    if (loserPath === null) return { session: winner.session, path: sessionPath };
    const loser = await readSessionFile(loserPath, filePath);
    if (loser.ok) {
      return {
        session: winner.session,
        path: sessionPath,
        fallback: { session: loser.session, path: loserPath },
      };
    }
    if (loser.reason === "unparseable") {
      await quarantineSession(loserPath, { documentName: path.basename(filePath) });
    }
    return { session: winner.session, path: sessionPath };
  }

  // The winner did not read. Quarantine it when it is corrupt JSON (a rename,
  // not the old unlink — the evidence stays on disk for 30 days), then try
  // the loser's JSON once before giving up.
  //
  // An unparseable winner is quarantined, dropped, and the fallback is
  // PROMOTED into `session`/`path` with no `fallback` in the result: the
  // declared type has no representation for "winner absent, fallback
  // present", so promotion is the only consistent reading. The promoted
  // record returns through here as an ordinary winner and re-enters
  // `sessionModelIsStale` and the `sourceFileChanged`/`dirty` gates in the
  // caller — which is why the SyntaxError fallback IS gated.
  //
  // This supersedes the old one-directional fallback (legacy-unreadable tries
  // current, never the reverse): that asymmetry belonged to the unlink world,
  // where falling back to a surviving legacy record on every load would
  // resurrect a superseded record indefinitely. Here the corrupt winner is
  // renamed away first, so a promoted loser is the only candidate left, not
  // a resurrection. Never a third candidate.
  if (winner.reason === "unparseable") {
    await quarantineSession(sessionPath, { documentName: path.basename(filePath) });
  }
  if (loserPath === null) return null;
  const loser = await readSessionFile(loserPath, filePath);
  if (loser.ok) return { session: loser.session, path: loserPath };
  if (loser.reason === "unparseable") {
    await quarantineSession(loserPath, { documentName: path.basename(filePath) });
  }
  return null;
}

/**
 * Load a session file if it exists. Same shape as before — the ~22 call
 * sites (`session.test.ts`, `external-conflict.test.ts`,
 * `unc-guard-ordering.test.ts`, `open.ts`) are untouched; `loadSession`
 * wraps `loadSessionWithPath`.
 */
export async function loadSession(filePath: string): Promise<SessionData | null> {
  const loaded = await loadSessionWithPath(filePath);
  return loaded?.session ?? null;
}

/**
 * Read and parse one session file, or a discriminated failure. Never throws
 * and never quarantines: quarantining needs the per-caller notification opts
 * (`documentId`/`documentName`), so the CALLER decides after inspecting the
 * reason. ENOENT is "missing" (tolerated everywhere); any other non-syntax
 * failure is logged here and reported as "unreadable".
 */
async function readSessionFile(
  sessionPath: string,
  filePath: string,
): Promise<
  | { ok: true; session: SessionData }
  | { ok: false; reason: "missing" | "unparseable" | "unreadable" }
> {
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    const data = JSON.parse(content) as SessionData;
    // **The caller's path wins over the stored one (#1417).** This record was
    // found at `sessionKey(filePath)`, so `filePath` is the authoritative
    // identity of the document; `data.filePath` is an unvalidated string from a
    // bare `JSON.parse` that a tampered session file controls outright, and
    // `sourceFileChanged` used to `stat` it. Overwriting deletes that untrusted
    // value rather than screening one hostile shape of it — and the two spellings
    // are equivalent by construction, since `sessionKey` normalizes separators,
    // so this cannot change which document is restored. `narrowConflict` below
    // is the same don't-trust-loadSession-fields rule applied to `conflict`.
    // BOTH candidates are sanitized: an unsanitized fallback carrying
    // `filePath: "upload://…"` would short-circuit `sessionModelIsStale`
    // (uploads are exempt) and `sourceFileChanged` (false for uploads) and be
    // cloned over the user's newer disk content whatever its revision.
    data.filePath = filePath;
    return { ok: true, session: data };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    if (err instanceof SyntaxError) return { ok: false, reason: "unparseable" };
    console.error(`[Tandem] Failed to read session ${sessionPath}:`, err);
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Quarantine a corrupt session file: rename it to
 * `<name>.json.corrupt.<Date.now()>` and touch the quarantine's mtime to now.
 * Never rejects — a failing quarantine must not re-break the open it runs
 * inside of (the EPERM/EBUSY shape when a second instance or an AV scanner
 * holds the file is the ordinary Windows case, the #1599 race).
 *
 * The single producer of the `session-corrupt` notification (three callers:
 * the open-path recovery, `loadSessionWithPath`'s SyntaxError branch, and
 * `listSessionFilePaths`' parse catch). `open.ts` pushes nothing of its own.
 *
 * Per caller (post-#1750 the session basename is 64 hex and `documentId` is
 * a hash too, so nothing inside here can name the document without `opts`):
 *   - open-path recovery passes `{ documentId, documentName }`: doc-keyed
 *     `session-corrupt:<docId>`, message names the DOCUMENT basename.
 *   - `loadSessionWithPath`'s SyntaxError branch passes `{ documentName }`
 *     (the document basename — `id` is computed in `resolveAndValidatePath`
 *     and never passed down, and `sessionKey` is a different value):
 *     file-keyed `session-corrupt-file:<document basename>`, message names
 *     the document basename.
 *   - `listSessionFilePaths` passes no opts (it reads `data.filePath` out of
 *     the JSON it could not parse): file-keyed on the SESSION basename, and
 *     only there the message names the session file instead.
 *
 * `severity: "warning"` persists in the activity tray, which is a log — so
 * the past-tense wording ("was set aside") is a contract, not style. When
 * the rename itself fails the message carries the failure wording instead
 * ("could not be read; see the server log", never "was set aside").
 *
 * The name's suffix ORDER is the exclusion mechanism: `listSessionFilePaths`
 * filters on `file.endsWith(".json")` alone, so `<key>.json.corrupt.<ts>`
 * is invisible because it does not end in `.json` — while
 * `<key>.corrupt.<ts>.json` would be listed, parsed (it parses; only
 * `ydocState` is bad) and restored as a duplicate of the live path. Do not
 * "keep the extension".
 *
 * `utimes` takes Date objects, NOT `Date.now()`: numeric `utimes` arguments
 * are SECONDS, so a millisecond epoch either throws `EINVAL` (Windows — the
 * swallow below keeps the rename-preserved mtime and the next
 * `cleanupSessions` reaps the quarantine, the opposite failure) or stamps
 * year ~57000 (POSIX — the quarantine is immortal). `rename` preserves
 * mtime, and `cleanupSessions` filters on age only, so without the touch a
 * session last written 31 days ago is quarantined and unlinked by the very
 * next boot; with it the 30-day GC runs from the quarantine (intended).
 *
 * Proceeds regardless of `isStoreReadOnly()`: a rename is not a content
 * write, and a lock-losing second instance renaming a file that is corrupt
 * either way is benign.
 *
 * Delivery bound: `pushNotification` has no server-side dedup and the SSE
 * route has no backlog replay, and `restoreOpenDocuments` runs before the
 * HTTP binds — so for the boot-restore case the toast reaches nobody. The
 * user sees the tab come back with disk content; the record is the
 * `console.error` line plus the `.corrupt.<ts>` file plus the
 * troubleshooting entry. The toast IS delivered for the live paths (Recents,
 * `tandem_open`, a `.corrupt` produced mid-session). A client-visible
 * boot-time carrier is a client change and out of scope.
 *
 * `clearAllSessions` consequence: a file quarantined during its own listing
 * no longer ends in `.json`, so "Clear all" neither deletes nor counts it;
 * it is reclaimed by `cleanupSessions` 30 days from the refreshed mtime.
 * Acceptable (corrupt, invisible to every listing, eventually GC'd).
 *
 * `reportOnly` (open-path recovery when the eviction itself failed): the doc
 * may still hold partial state, so neither the fallback clone nor a rename
 * is safe — but the toast must still fire, and this function is the single
 * producer. Reports with the failure wording without touching the file.
 * (Deviates from the A11 spec's two-field `opts`: the spec's "Fix 1 pushes
 * nothing", "single producer", "file remains on evict failure" and
 * "failure-worded toast" are jointly unsatisfiable without it.)
 */
export async function quarantineSession(
  sessionPath: string,
  opts?: { documentId?: string; documentName?: string; reportOnly?: boolean },
): Promise<void> {
  const sessionBase = path.basename(sessionPath);
  const name = opts?.documentName ?? sessionBase;
  const dedupKey = opts?.documentId
    ? `session-corrupt:${opts.documentId}`
    : `session-corrupt-file:${name}`;
  const namesDocument = opts?.documentId !== undefined || opts?.documentName !== undefined;
  const successMessage = namesDocument
    ? `Recovered ${name} from disk; its unsaved session state could not be read and was set aside.`
    : `A saved session file could not be read and was set aside (${sessionBase}).`;
  const failureMessage = namesDocument
    ? `Recovered ${name} from disk; its unsaved session state could not be read; see the server log.`
    : `A saved session file could not be read (${sessionBase}); see the server log.`;
  const notify = (message: string): void => {
    pushNotification({
      id: generateNotificationId(),
      type: "general-error",
      severity: "warning",
      message,
      ...(opts?.documentId ? { documentId: opts.documentId } : {}),
      dedupKey,
      timestamp: Date.now(),
    });
  };

  if (opts?.reportOnly === true) {
    notify(failureMessage);
    return;
  }

  try {
    const quarantinePath = `${sessionPath}.corrupt.${Date.now()}`;
    await fs.rename(sessionPath, quarantinePath);
    await fs.utimes(quarantinePath, new Date(), new Date());
  } catch (err: unknown) {
    // ENOENT-tolerant: the file vanished mid-flight (a concurrent listing
    // already quarantined it) — nothing corrupt is lying around, so there is
    // nothing to report either.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    // Logged the way annotations/store.ts does, then swallowed: the open
    // this runs inside of must still resolve.
    console.error(`[Tandem] Failed to quarantine corrupt session ${sessionPath}:`, err);
    notify(failureMessage);
    return;
  }
  notify(successMessage);
}

/**
 * Narrow a session's carried `conflict` field to a trustworthy
 * `ExternalConflictState` (#1238). `loadSession` is a bare `JSON.parse` with no
 * schema validation, and the restored value is re-published into the Y.Doc and
 * rendered by the client banner, so it must not be taken on trust.
 *
 * `diskChanged` is coerced, not just checked, because it is the discriminator
 * `saveDocumentToDisk` keys its save block on — a missing or non-boolean value
 * would produce a banner that blocks nothing, failing open on exactly the field
 * that matters. An unrecognized `kind` is rejected outright; there is no safe
 * default for a prompt whose copy is chosen by it.
 */
export function narrowConflict(value: unknown): ExternalConflictState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ExternalConflictState>;
  if (candidate.kind !== "external-edit" && candidate.kind !== "unsaved-restore") return undefined;
  return {
    kind: candidate.kind,
    diskChanged: candidate.diskChanged === true || candidate.kind === "external-edit",
    detectedAt: typeof candidate.detectedAt === "number" ? candidate.detectedAt : Date.now(),
  };
}

/** Restore a Y.Doc from a session's base64-encoded state */
export function restoreYDoc(doc: Y.Doc, session: SessionData): void {
  const state = Buffer.from(session.ydocState, "base64");
  Y.applyUpdate(doc, new Uint8Array(state));
}

/**
 * Decode a session's `ydocState` into a throwaway scratch doc, for the
 * corrupt-winner fallback path (#1800). Throws on corrupt state exactly the
 * way `restoreYDoc` does — the caller catches and quarantines the fallback's
 * path too.
 *
 * Lives here (not in `documents/open.ts`) so `open.ts` keeps its type-only
 * yjs import and the `open.ts → session/manager.ts` boundary pin stays x1.
 * The caller wraps the clone in `try { … } finally { scratch.destroy(); }`
 * with the destroy in its OWN inner try/catch: a throw out of `finally`
 * would override the restore result and re-break the open.
 */
export function decodeSessionToScratchDoc(session: SessionData): Y.Doc {
  const scratch = new Y.Doc();
  const state = Buffer.from(session.ydocState, "base64");
  Y.applyUpdate(scratch, new Uint8Array(state));
  return scratch;
}

/** Check if the source file has changed since the session was saved
 *
 * **The screen below is belt-and-braces; the real fix is in `loadSession`
 * (#1417).** This `stat` was the first thing to touch `session.filePath`, which
 * a tampered session file controlled outright — so a record carrying
 * `\\attacker\share\x` performed an SMB handshake on every open-with-restore.
 * `loadSession` now overwrites that field with the caller's validated path, so
 * the value cannot be hostile by the time it arrives here. This function is
 * exported, though, and a hand-built `SessionData` bypasses that, so the screen
 * stays for the exported surface rather than being deleted as unreachable. */
export async function sourceFileChanged(session: SessionData): Promise<boolean> {
  // Uploaded files have no disk path — session is the only truth
  if (isUploadPath(session.filePath)) return false;
  // Treat an unsafe path as "changed": it is the conservative answer, and it
  // routes into the same re-parse-from-disk branch a missing file takes, which
  // re-reads the path the CALLER validated rather than this one.
  if (rejectUnsafeWindowsPrefix(session.filePath) !== null) return true;
  try {
    const stat = await fs.stat(session.filePath);
    return stat.mtimeMs !== session.sourceFileMtime;
  } catch {
    return true; // File doesn't exist — treat as changed
  }
}

/**
 * True when this session was written by a load path that has since been fixed,
 * and re-parsing the source file is strictly better than replaying it (#1448).
 *
 * `ydocState` is a bare `Y.encodeStateAsUpdate` of an ALREADY-parsed document,
 * so a parser fix cannot reach it. Without this check a user who upgrades keeps
 * every defect their pre-fix session baked in for up to `SESSION_MAX_AGE` — the
 * fix ships but never arrives.
 *
 * Two populations are deliberately exempt, because for them the session is the
 * only copy of the content and discarding it is the data loss this whole effort
 * is about:
 *   - `dirty` sessions hold unsaved edits that exist nowhere else.
 *   - `upload://` paths have no disk file to re-read.
 *   - a session carrying an UNRESOLVED conflict is the only record that the
 *     conflict happened. `maybeRestoreSession` carries `session.conflict`
 *     forward precisely because it cannot be re-derived — `saveSession` stats
 *     the file at save time, so `sourceFileMtime` IS the external write's mtime
 *     and `sourceFileChanged` reads false on reopen. Discarding the session
 *     here returns before that carry, which does not defer the conflict, it
 *     destroys it: the keep-vs-reload banner never appears and the next
 *     autosave tick overwrites the external edit. That is the same laundering
 *     the carry exists to prevent, and it costs a user their file, which is a
 *     strictly worse outcome than replaying a stale parse of it. Re-reading is
 *     an improvement, not an emergency; it can wait for the conflict to be
 *     resolved and the next save to re-stamp the revision.
 */
export function sessionModelIsStale(session: SessionData): boolean {
  if (session.dirty === true) return false;
  if (isUploadPath(session.filePath)) return false;
  if (narrowConflict(session.conflict) !== undefined) return false;
  return (session.modelRevision ?? 0) < DOCUMENT_MODEL_REVISION;
}

/** Modification time of a file in ms, or null when it cannot be stat'd. */
async function mtimeOf(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Delete a session file.
 *
 * Unlinks BOTH names unconditionally, ENOENT-tolerant on each (#1750). A
 * first-found return would leave an old-name orphan that `listSessionFilePaths`
 * still enumerates, so "Clear all" would appear to work and the document would
 * be back on the next restart.
 *
 * For an upload path `legacySessionPath` returns null and only the one name is
 * unlinked — uploads keep the legacy key, so the two names are the same file.
 */
export async function deleteSession(filePath: string): Promise<void> {
  for (const target of [sessionPathFor(filePath), legacySessionPath(filePath)]) {
    if (target === null) continue;
    try {
      await fs.unlink(target);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error("[Tandem] deleteSession: failed to delete", target, err);
      }
    }
  }
}

// --- CTRL_ROOM persistence (chat history) ---

const CTRL_SESSION_KEY = CTRL_ROOM;
let ctrlSnapshotQueue: Promise<void> = Promise.resolve();

function enqueueCtrlSnapshot<T>(task: () => Promise<T>): Promise<T> {
  const result = ctrlSnapshotQueue.then(task, task);
  // A failed snapshot must reject its own caller without poisoning later saves.
  ctrlSnapshotQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function cloneYDoc(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}

/**
 * Fold any in-flight `chatStream` sidecar entries into their chat rows and
 * delete them (#1340) — the durability half of the sidecar invariant: durable
 * CTRL state never carries a LIVE `chatStream` entry.
 *
 * TOTAL by construction, because this runs on every persist and every restore
 * for all users while the only streaming producer ships dark: an entry folds
 * only when it is a real `Y.Text` AND its chat row still exists; everything
 * else — an entry whose row the user erased mid-stream (a fold there would
 * durably resurrect a message the user just deleted), or a malformed value
 * from a future/buggy build — is deleted without folding.
 *
 * Runs on snapshot CLONES in the persist path (never mutates live user-visible
 * state) and on the freshly-restored doc in `restoreCtrlDoc` (a snapshot
 * written by a newer or buggy build may carry live entries; without the sweep
 * an orphan `Y.Text` would stay authoritative over its chat row with no
 * collector until the next persist).
 *
 * It is also the ONLY path that sees an ABANDONED entry — a producer that
 * crashed or hung without finalizing emits no further writes — so the sidecar
 * staleness tripwire is reconciled from here, with the ids as found, before
 * anything is folded or deleted.
 */
function foldChatStream(doc: Y.Doc): void {
  const streamMap = doc.getMap(Y_MAP_CHAT_STREAM);
  reconcileStreamSidecars(streamMap.keys());
  if (streamMap.size === 0) return;
  const chatMap = doc.getMap(Y_MAP_CHAT);
  withInternal(doc, () => {
    for (const [id, value] of Array.from(streamMap.entries())) {
      const existing = chatMap.get(id) as Record<string, unknown> | undefined;
      // `length > 0`: an EMPTY `Y.Text` is malformed state, not a streamed
      // empty reply — folding it would blank a chat row holding real text,
      // which is the opposite of what this defensive sweep is for. It falls
      // through to the unconditional delete: drop the sidecar, keep the row.
      if (existing && value instanceof Y.Text && value.length > 0) {
        chatMap.set(id, { ...existing, text: value.toString() });
      }
      streamMap.delete(id);
    }
  });
}

function pruneCtrlDocumentNames(doc: Y.Doc): void {
  const referencedDocumentIds = new Set<string>();
  doc.getMap(Y_MAP_CHAT).forEach((value) => {
    const documentId = (value as { documentId?: unknown } | null)?.documentId;
    if (typeof documentId === "string" && documentId) referencedDocumentIds.add(documentId);
  });

  const documentNames = doc.getMap(Y_MAP_CHAT_DOCUMENT_NAMES);
  for (const [id, value] of documentNames.entries()) {
    if (!referencedDocumentIds.has(id) || typeof value !== "string") {
      documentNames.delete(id);
      continue;
    }
    const fileName = path.basename(value.replace(/\\/g, "/")).trim();
    if (!fileName) documentNames.delete(id);
    else if (fileName !== value) documentNames.set(id, fileName);
  }
}

async function persistCtrlSnapshot(doc: Y.Doc): Promise<void> {
  if (!sessionDirReady) {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    sessionDirReady = true;
  }

  // Fold in-flight streamed text into the chat rows BEFORE pruning/encoding,
  // so a crash mid-stream durably keeps the last-flushed text and the file
  // never contains a live chatStream entry (#1340). Snapshot-only, like the
  // prunes below — the live doc's sidecar is finalized by its producer.
  foldChatStream(doc);

  // Prune the snapshot, never the live CTRL doc. User-visible deletions must not
  // happen until the corresponding atomic write has succeeded.
  const chatMap = doc.getMap(Y_MAP_CHAT);
  const entries: Array<{ id: string; timestamp: number }> = [];
  chatMap.forEach((value, key) => {
    const msg = value as { timestamp: number };
    entries.push({ id: key, timestamp: msg.timestamp });
  });
  if (entries.length > 200) {
    entries.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    const toDelete = entries.slice(0, entries.length - 200);
    withInternal(doc, () => {
      for (const entry of toDelete) chatMap.delete(entry.id);
    });
  }

  // Defense in depth: durable metadata is restricted to basename-only names
  // for documents referenced by retained chat messages.
  withInternal(doc, () => pruneCtrlDocumentNames(doc));

  const state = Y.encodeStateAsUpdate(doc);
  const ydocState = Buffer.from(state).toString("base64");
  const data = { ydocState, lastAccessed: Date.now() };
  const sessionPath = path.join(SESSION_DIR, `${CTRL_SESSION_KEY}.json`);
  await atomicWrite(sessionPath, JSON.stringify(data));
}

/** Save the CTRL_ROOM Y.Doc (chat history) */
export async function saveCtrlSession(doc: Y.Doc): Promise<void> {
  // Reserve queue order before taking the snapshot. A save called after a
  // queued clear therefore cannot encode the pre-clear live map.
  return enqueueCtrlSnapshot(async () => {
    const snapshot = cloneYDoc(doc);
    await persistCtrlSnapshot(snapshot);
  });
}

/**
 * Durably clear the chat IDs visible when the request began. The live CRDT is
 * unchanged until the cloned CTRL snapshot is atomically on disk. Messages
 * arriving while the request waits in the queue are retained.
 */
export async function clearCtrlChatDurably(doc: Y.Doc): Promise<number> {
  const liveChat = doc.getMap(Y_MAP_CHAT);
  const capturedIds = Array.from(liveChat.keys());
  // Enqueue synchronously after capturing the request's IDs. Both cloning and
  // persistence happen inside this shared queue; later saves cannot overtake.
  return enqueueCtrlSnapshot(async () => {
    const snapshot = cloneYDoc(doc);
    const snapshotChat = snapshot.getMap(Y_MAP_CHAT);
    const snapshotStream = snapshot.getMap(Y_MAP_CHAT_STREAM);
    withInternal(snapshot, () => {
      for (const id of capturedIds) {
        snapshotChat.delete(id);
        // Belt-and-braces (#1340). `foldChatStream` already cannot resurrect
        // the row — it re-`set`s only when `existing && value instanceof Y.Text`
        // and `snapshotChat.delete(id)` above ran first, in this same
        // transaction — so this delete is REDUNDANT with that `existing &&`
        // guard. Kept so the clone never carries an entry for an erased id even
        // if the guard is ever loosened; it is hygiene, not a data-loss gate.
        if (snapshotStream.has(id)) snapshotStream.delete(id);
      }
    });
    await persistCtrlSnapshot(snapshot);
    const liveStream = doc.getMap(Y_MAP_CHAT_STREAM);
    withInternal(doc, () => {
      for (const id of capturedIds) {
        liveChat.delete(id);
        // A clear racing an in-flight stream must not leave an orphan Y.Text;
        // updateClaudeChatMessage's !existing guard then keeps later flushes
        // no-ops (and deletes any entry a mid-race flush recreated).
        if (liveStream.has(id)) liveStream.delete(id);
      }
      // Recompute from the current live map so messages that arrived while
      // the snapshot persisted retain their filename metadata. This also
      // clears legacy orphan metadata when chat was already empty.
      pruneCtrlDocumentNames(doc);
    });
    return capturedIds.length;
  });
}

/** Load the CTRL_ROOM session if it exists */
export async function loadCtrlSession(): Promise<string | null> {
  const sessionPath = path.join(SESSION_DIR, `${CTRL_SESSION_KEY}.json`);
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    const data = JSON.parse(content);
    return data.ydocState ?? null;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      // Stays `unlink`, deliberately NOT quarantined like document sessions:
      // the ctrl record is small and rebuilt from defaults on the next save,
      // so a 30-day quarantine would preserve nothing worth diagnosing.
      // (Kept distinct so /simplify does not "align" it with quarantineSession.)
      console.error(`[Tandem] Corrupted ctrl session ${sessionPath}, removing:`, err.message);
      await fs.unlink(sessionPath).catch((unlinkErr) => {
        console.error(
          `[Tandem] Failed to remove corrupted ctrl session ${sessionPath}:`,
          unlinkErr,
        );
      });
      return null;
    }
    console.error(`[Tandem] Failed to read ctrl session:`, err);
    return null;
  }
}

/** Restore a CTRL_ROOM Y.Doc from base64 state. Sweeps any live `chatStream`
 *  entries the snapshot carried (fold-or-delete) — the write side keeps them
 *  out of durable files, but a blind `applyUpdate` of a foreign/future
 *  snapshot must not import an orphan sidecar entry that stays authoritative
 *  over its chat row with no collector (#1340). */
export function restoreCtrlDoc(doc: Y.Doc, base64State: string): void {
  const state = Buffer.from(base64State, "base64");
  Y.applyUpdate(doc, new Uint8Array(state));
  foldChatStream(doc);
}

/**
 * Scan the session directory for document sessions that can be restored.
 * Skips the ctrl session, upload:// paths, and corrupt files.
 * Returns file paths sorted by most recently accessed first.
 */
/**
 * One restorable document session, as `listSessionFilePaths` reports it.
 *
 * Named rather than inline because `documents/open.ts`'s `openFromRestore`
 * derives its parameter from it with `Pick`. Losing `readOnly` on the restore
 * path is a bug that has shipped (#1591), and two independently-written
 * structural types are exactly how it comes back: the caller destructures the
 * fields it remembers, the callee declares the fields it remembers, and
 * nothing makes them disagree out loud.
 */
export interface SessionFileEntry {
  filePath: string;
  lastAccessed: number;
  readOnly: boolean;
}

/** A `SessionFileEntry` still carrying the filename it came from, for the
 *  MTIME-keyed migration dedupe. Never leaves this module. */
interface RawSessionFileEntry extends SessionFileEntry {
  file: string;
}

export async function listSessionFilePaths(): Promise<SessionFileEntry[]> {
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const files = await fs.readdir(SESSION_DIR);
    const results: RawSessionFileEntry[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      // Skip ctrl session. Keyed on the LITERAL name `saveCtrlSession` writes
      // (`CTRL_SESSION_KEY = CTRL_ROOM = "__tandem_ctrl__"`, encode-invariant).
      // #1750 rehashed DOCUMENT keys only — the ctrl session deliberately keeps
      // its literal name, so this stays literal too.
      if (file === `${encodeURIComponent(CTRL_ROOM)}.json`) continue;

      try {
        const raw = await fs.readFile(path.join(SESSION_DIR, file), "utf-8");
        const data = JSON.parse(raw) as SessionData;
        if (!data.filePath || isUploadPath(data.filePath)) continue;
        // Same screen as `sourceFileChanged` (#1417): these strings come off
        // disk and are handed to restore callers that will open them. Those
        // callers validate too, so this is defence in depth — but keeping an
        // unsafe path out of the restore list entirely is cheaper than relying
        // on every future consumer of this list to re-check.
        const unsafe = rejectUnsafeWindowsPrefix(data.filePath);
        if (unsafe !== null) {
          // Logged, not silently dropped: this list is what the restore UI
          // shows, so a session vanishing from it with no explanation looks
          // like data loss to the user and like nothing at all to whoever is
          // debugging it.
          console.error(`[Tandem] Omitting session ${file} from restore list: ${unsafe}`);
          continue;
        }
        results.push({
          file,
          filePath: data.filePath,
          lastAccessed: data.lastAccessed ?? 0,
          // Strict `=== true`, same don't-trust-a-bare-`JSON.parse` rule as
          // `narrowConflict`: this value comes off disk and decides whether the
          // restored tab is writable, so `"true"`, `1` or `{}` must all restore
          // writable rather than truthily locking a document the user can edit.
          // Absent → false, which is every record written before this field
          // existed, and every writable document today.
          readOnly: data.readOnly === true,
        });
      } catch (err) {
        // The boot sweep never reaches loadSession for an unparseable file —
        // its own JSON.parse throws first — so without this third quarantine
        // caller the corrupt-JSON class still silently loses the tab at
        // startup. Stays BROAD: ENOENT/EACCES on a file that vanished
        // mid-sweep must still `continue`; only the quarantine is
        // SyntaxError-gated. NOTE the absolute path: `file` is a bare
        // `readdir` name, and passing it would resolve against cwd, ENOENT,
        // and be swallowed by the tolerance below into a silent no-quarantine.
        // This list has three callers (restoreOpenDocuments,
        // listSessionsMetadata, clearAllSessions), so a Recents refresh can
        // quarantine mid-session — a live, deliverable toast path, and why a
        // quarantine can originate from a listing, not only from an open.
        if (err instanceof SyntaxError) {
          await quarantineSession(path.join(SESSION_DIR, file));
        }
        console.error(`[Tandem] Skipping unreadable session file ${file}:`, err);
      }
    }

    const deduped = await dedupeByFilePath(results);
    // The sort keeps `lastAccessed`; the dedupe above uses file MTIME. The two
    // clocks answer different questions — "when did the user last touch this
    // document" versus "which of these two files was written more recently" —
    // and the migration criterion has to be the same one `loadSession` uses.
    deduped.sort((a, b) => b.lastAccessed - a.lastAccessed);
    return deduped.map(({ file: _file, ...entry }) => entry);
  } catch (err) {
    console.error("[Tandem] Failed to read session directory:", err);
    return [];
  }
}

/**
 * Collapse records that describe the same `filePath` to one, keeping the file
 * with the newer MTIME — the same criterion `loadSession`'s migration uses, so
 * the restore list and the restore itself cannot pick different records and
 * restore with the loser's `readOnly` (#1591's class).
 *
 * Duplicates exist only inside the #1750 migration window, so the `stat` is
 * LAZY: groups of one are passed through untouched. The session directory is
 * bounded only by the 30-day GC, and an unconditional per-file stat would be a
 * permanent boot cost for a one-shot need.
 */
async function dedupeByFilePath(entries: RawSessionFileEntry[]): Promise<RawSessionFileEntry[]> {
  const groups = new Map<string, RawSessionFileEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.filePath);
    if (group) group.push(entry);
    else groups.set(entry.filePath, [entry]);
  }
  const out: RawSessionFileEntry[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    let best = group[0];
    let bestMtime = (await mtimeOf(path.join(SESSION_DIR, best.file))) ?? -1;
    for (const candidate of group.slice(1)) {
      const mtime = (await mtimeOf(path.join(SESSION_DIR, candidate.file))) ?? -1;
      if (mtime > bestMtime) {
        best = candidate;
        bestMtime = mtime;
      }
    }
    out.push(best);
  }
  return out;
}

/** Metadata for a single persisted document session, surfaced in the Sessions UI. */
export interface SessionMetadata {
  filePath: string;
  /** Last-accessed timestamp (ms since epoch) from the session record. */
  lastAccessed: number;
  /** Count of live (non-tombstoned) annotations in the durable envelope, 0 if none. */
  annotationCount: number;
}

/**
 * Count live annotations for a document path by reading its durable annotation
 * envelope (`<docHash>.json`). Tombstones and replies don't count. Returns 0 if
 * the envelope is missing, corrupt, or a future schema version — the count is a
 * best-effort UI hint, never load-bearing.
 */
async function annotationCountForPath(filePath: string): Promise<number> {
  const hash = docHash(filePath);
  const envelopePath = path.join(getAnnotationsDir(), `${hash}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(envelopePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[Tandem] annotationCountForPath: failed to read", envelopePath, err);
    }
    return 0;
  }
  const parsed = parseAnnotationDoc(raw);
  if (!parsed.ok) return 0;
  return parsed.doc.annotations.length;
}

/**
 * List persisted document sessions with display metadata for the Sessions UI:
 * file path, last-accessed time, and live annotation count. Sorted most
 * recently accessed first (inherits ordering from `listSessionFilePaths`).
 */
export async function listSessionsMetadata(): Promise<SessionMetadata[]> {
  const sessions = await listSessionFilePaths();
  return Promise.all(
    sessions.map(async ({ filePath, lastAccessed }) => ({
      filePath,
      lastAccessed,
      annotationCount: await annotationCountForPath(filePath),
    })),
  );
}

/**
 * Delete every persisted document session (the "Clear all" action). The
 * CTRL_ROOM chat session and upload:// sessions are preserved — only the
 * document sessions surfaced in the UI are removed. Returns the count deleted.
 * No-op in read-only mode.
 */
export async function clearAllSessions(): Promise<number> {
  if (isStoreReadOnly()) return 0;
  const sessions = await listSessionFilePaths();
  let deleted = 0;
  for (const { filePath } of sessions) {
    await deleteSession(filePath);
    deleted++;
  }
  return deleted;
}

/**
 * Delete orphaned per-document annotation files older than `SESSION_MAX_AGE`.
 *
 * Phase 1 of the durable-annotations plan ships this as a best-effort startup
 * hint — issue #318 tracks the full policy (e.g., cross-referencing against
 * active session files, retention tiers). For now we only GC files whose
 * names match `<64-hex>.json` or `upload_<id>.json`, leaving `.corrupt.*`,
 * `.future`, and the `store.lock` file alone.
 *
 * Matches the 30-day cutoff used by `cleanupSessions` (same constant).
 */
export async function cleanupOrphanedAnnotationFiles(): Promise<{
  cleaned: number;
  raced: number;
  failed: number;
}> {
  const dir = getAnnotationsDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { cleaned: 0, raced: 0, failed: 0 };
    console.error("[Tandem] Failed to read annotations directory:", err);
    return { cleaned: 0, raced: 0, failed: 0 };
  }

  // Only consider files that match the known per-doc envelope filename shape.
  // Quarantined (`.corrupt.<ts>`), parked (`.future`), and the lockfile are
  // skipped — they carry their own lifecycles.

  // Fan out stat + unlink so this isn't O(N) serial syscalls on startup.
  const now = Date.now();
  type Result = "cleaned" | "raced" | "skipped" | "failed";
  const results = await Promise.all(
    files
      .filter((file) => ENVELOPE_FILENAME_RE.test(file))
      .map(async (file): Promise<Result> => {
        const filePath = path.join(dir, file);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs <= SESSION_MAX_AGE) return "skipped";
          await fs.unlink(filePath);
          return "cleaned";
        } catch (err) {
          // ENOENT is benign — another tandem instance racing the same GC got
          // there first. Anything else (permissions, locks, I/O) points at a
          // real problem the operator needs to see with a code to triage on.
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") return "raced"; // peer cleaned it first
          console.error(
            `[Tandem] cleanupOrphanedAnnotationFiles: failed to process ${file} (${code ?? "unknown"}):`,
            err,
          );
          return "failed";
        }
      }),
  );
  return {
    cleaned: results.filter((r) => r === "cleaned").length,
    raced: results.filter((r) => r === "raced").length,
    failed: results.filter((r) => r === "failed").length,
  };
}

/**
 * Compact stale tombstones from CLOSED documents' annotation envelopes (#318).
 *
 * Tombstones prevent a stale reconnecting browser tab from resurrecting a
 * deleted annotation (the anti-resurrection merge in `sync.ts`). They are only
 * needed while such a stale peer might reconnect, which is bounded by SESSION
 * GC: a session older than `SESSION_MAX_AGE` (30d) is itself reaped, so a
 * tombstone older than that horizon can no longer be contradicted by a
 * reconnecting peer carrying the pre-deletion copy.
 *
 * Safety contract:
 *   - Only CLOSED docs are swept. `openDocHashes` (the docHashes of currently
 *     open documents) is the guard: an open doc's in-memory `tombstonesByDoc`
 *     ledger is authoritative and MUST NOT be contradicted by a disk rewrite.
 *     (At the current pre-`restoreOpenDocuments` call site this set is empty,
 *     but the guard is load-bearing if the call site ever moves.)
 *   - Only tombstones with `deletedAt` older than `SESSION_MAX_AGE` are
 *     dropped. Annotations, replies, and fresh tombstones are preserved.
 *   - The rewrite is routed through the store's `queueWrite`/`flush` (atomic
 *     write + debounce coalescing), never a raw `fs.writeFile`.
 *   - No-op in read-only mode.
 *
 * @param openDocHashes docHashes of documents currently open (skip these).
 * @returns count of envelopes whose tombstone array was compacted.
 */
export async function cleanupStaleTombstones(
  openDocHashes: ReadonlySet<string> = new Set(),
): Promise<number> {
  if (isStoreReadOnly()) return 0;

  const dir = getAnnotationsDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    console.error("[Tandem] cleanupStaleTombstones: failed to read annotations dir:", err);
    return 0;
  }

  const now = Date.now();
  let compacted = 0;

  for (const file of files) {
    if (!ENVELOPE_FILENAME_RE.test(file)) continue;
    const fileHash = file.slice(0, -".json".length);
    // Open-doc guard: never mutate an open doc's envelope from disk — its
    // in-memory tombstone ledger is authoritative.
    if (openDocHashes.has(fileHash)) continue;

    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, file), "utf-8");
    } catch (err) {
      console.error(`[Tandem] cleanupStaleTombstones: failed to read ${file}:`, err);
      continue;
    }

    const parsed = parseAnnotationDoc(raw);
    if (!parsed.ok) continue; // corrupt/future files have their own lifecycle
    const doc = parsed.doc;
    if (doc.tombstones.length === 0) continue;

    const kept = doc.tombstones.filter((t) => now - t.deletedAt <= SESSION_MAX_AGE);
    if (kept.length === doc.tombstones.length) continue; // nothing stale

    // Re-key the rewrite to the FILENAME hash, not the envelope's internal
    // docHash — a hand-edited file whose internal docHash disagrees with its
    // filename must not write to a different path (which would orphan the
    // stale file and create a duplicate). The filename is the storage key.
    const rewritten = { ...doc, docHash: fileHash, tombstones: kept };
    const store = createStore(fileHash, { filePath: doc.meta.filePath });
    store.queueWrite(() => rewritten);
    try {
      await store.flush();
      compacted++;
    } catch (err) {
      console.error(`[Tandem] cleanupStaleTombstones: failed to rewrite ${file}:`, err);
    }
  }

  return compacted;
}

/** Delete sessions older than 30 days */
export async function cleanupSessions(): Promise<number> {
  let cleaned = 0;
  let files: string[];
  try {
    files = await fs.readdir(SESSION_DIR);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    console.error("[Tandem] Failed to read session directory:", err);
    return 0;
  }

  const now = Date.now();
  for (const file of files) {
    try {
      const filePath = path.join(SESSION_DIR, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > SESSION_MAX_AGE) {
        await fs.unlink(filePath);
        cleaned++;
      }
    } catch (err) {
      console.error(`[Tandem] cleanupSessions: failed to process ${file}:`, err);
    }
  }
  return cleaned;
}

// --- Auto-save ---

let autoSaveTimer: ReturnType<typeof setInterval> | null = null;
let autoSaveCallback: (() => Promise<void>) | null = null;

/** Check if auto-save is currently running */
export function isAutoSaveRunning(): boolean {
  return autoSaveTimer !== null;
}

/** Start auto-saving every 60 seconds. Pass a callback that saves the current session. */
export function startAutoSave(callback: () => Promise<void>): void {
  stopAutoSave();
  autoSaveCallback = callback;
  autoSaveTimer = setInterval(async () => {
    try {
      await autoSaveCallback?.();
    } catch (err) {
      console.error("[Tandem] Auto-save failed:", err);
    }
  }, AUTO_SAVE_INTERVAL);
}

/** Stop auto-save timer */
export function stopAutoSave(): void {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
  autoSaveCallback = null;
}
