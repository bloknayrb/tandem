/**
 * Named file-open entry points, and the pipeline behind them (ADR-034).
 *
 * This module is the published seam for opening documents into a Tandem
 * session, and as of Unit 7a it is also where the work happens. ADR-034's four
 * named entry points are all live here:
 *
 *   - `openFromDisk(filePath, opts?)` — opens an existing file path on disk.
 *   - `openFromUpload(fileName, content)` — opens browser-uploaded content
 *     under a synthetic `upload://` path.
 *   - `openScratchpad(content?)` — opens an ephemeral markdown buffer, seeded
 *     with `content` when given.
 *   - `openFromRestore(entry)` — reopens a document from disk-cached session
 *     state at startup.
 *
 * `openFromRestore` is the one that changes the shape of the module graph.
 * `restoreOpenDocuments` used to reach `mcp/file-opener.ts` through a dynamic
 * `import()` whose only job was breaking the cycle that file-opener's static
 * import of document-service created. With the pipeline living below both,
 * that import is static — which is why the last three dynamic imports in
 * document-service disappeared alongside it.
 *
 * **But do not read that as "acyclic", because it is not.** The specific
 * `file-opener.ts ↔ document-service.ts` pair is gone; a three-module cycle
 * replaced it: `open.ts → autosave.ts → mcp/document-service.ts → open.ts`.
 * It is inert at runtime — no module in it touches a cross-cycle binding at
 * top level, every use is inside an `async function` invoked after the graph
 * has initialized — but inert is not absent, and the next person to add a
 * top-level `const` here is the one who finds out. Its load-bearing edge is
 * `autosave.ts`'s import of `autoSaveAllToDisk`; moving that function out of
 * document-service is what would actually break it, and that is Unit 7c/8's
 * to do, not this unit's.
 *
 * `tests/docs/documents-boundary.test.ts` cannot see this cycle and is not
 * meant to: its acyclicity check is deliberately scoped to cycles contained
 * *entirely within* `documents/`, and this one routes through `mcp/`. What
 * that suite does hold is the edge itself, written down in FAN_OUT as the one
 * `documents/ → document-service` import — so the cycle is visible as its
 * parts even though nothing calls it a cycle.
 *
 * **What is still in `mcp/file-opener.ts`, and why.** Three entries remain,
 * and they are the reload family, not the open family:
 * `reloadDocumentFromMarkdown` (`routes/document-reload.ts`),
 * `restoreDocumentFromBackup` (`routes/backups.ts`, `mcp/docx-apply.ts`) and
 * `resolveExternalConflict` (`routes/external-conflict.ts`). Each replaces the
 * content of an ALREADY-open document; none of them opens one. Unit 7c decides
 * where they land. Until then `tests/server/documents-open.test.ts` names the
 * four call sites that may reach them (`restoreDocumentFromBackup` has two),
 * so a fifth reaching back into file-opener is a test failure rather than a
 * quiet regrowth.
 *
 * Two corrections to what this header used to claim, both load-bearing enough
 * that a reader acting on them would be wrong:
 *
 *   - Upload content is **not** "never written back". A `upload://` document is
 *     promoted to a real file by Save-As, at which point its entry's `source`
 *     flips to `"file"` and it saves like any other document.
 *   - `openScratchpad` has taken an optional `content` argument since #979; it
 *     opens an empty buffer only when called with none.
 */

import { randomUUID } from "node:crypto";
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import type * as Y from "yjs";
import {
  AUTO_SAVE_FORMATS,
  CHARS_PER_PAGE,
  LARGE_FILE_PAGE_THRESHOLD,
  MAX_FILE_SIZE,
  SUPPORTED_EXTENSIONS,
  VERY_LARGE_FILE_PAGE_THRESHOLD,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_READ_ONLY,
  Y_MAP_SAVED_AT_VERSION,
} from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import { SCRATCHPAD_PREFIX, UPLOAD_PREFIX } from "../../shared/paths.js";
import type { ExternalConflictState } from "../../shared/types.js";
import { rejectUnsafeWindowsPrefix } from "../../shared/windows-path-safety.js";
import { getAdapter } from "../file-io/index.js";
import { detectFormat, docIdFromPath, extractText } from "../mcp/document-model.js";
import { injectTutorialAnnotations } from "../mcp/tutorial-annotations.js";
import {
  loadSession,
  narrowConflict,
  restoreYDoc,
  type SessionFileEntry,
  sessionModelIsStale,
  sourceFileChanged,
} from "../session/manager.js";
import { getDocument, getOrCreateDocument } from "../yjs/provider.js";
import { wireAnnotationStore } from "./annotation-wiring.js";
import { ensureAutoSave } from "./autosave.js";
import { flagExternalConflict } from "./conflict.js";
import { markDirty, registerDirtyObserver } from "./dirty.js";
import { clearAndReload, loadContentIntoDoc, populateDocFromContent } from "./populate.js";
import {
  activateDocument,
  getOpenDocs,
  type OpenDoc,
  openDocument,
  openDocumentWhenReady,
} from "./registry.js";
import { wireFileWatcher } from "./watcher.js";

export interface OpenFileResult {
  documentId: string;
  filePath: string;
  fileName: string;
  format: string;
  readOnly: boolean;
  source: "file" | "upload";
  tokenEstimate: number;
  pageEstimate: number;
  restoredFromSession: boolean;
  alreadyOpen: boolean;
  forceReloaded: boolean;
  warnings?: string[];
}

/** Resolved + validated path metadata for openFromDisk. stat is NOT included — only used for the size check. */
interface ResolvedPath {
  resolved: string;
  format: string;
  readOnly: boolean;
  id: string;
}

/**
 * Compare two filesystem paths for identity. Case-insensitive on Windows, to
 * match `docIdFromPath`'s lowercasing and the OS's case-insensitive semantics.
 */
function pathsEqual(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Open a file by its absolute path on disk.
 * Throws on errors (ENOENT, EACCES, EBUSY, etc.) — caller maps to MCP or HTTP responses.
 * Pass `force: true` to reload from disk even if already open (clears all document state).
 * Pass `readOnly: true` to force the document open in read-only mode (e.g. CHANGELOG.md).
 */
export async function openFromDisk(
  filePath: string,
  options?: { force?: boolean; readOnly?: boolean },
): Promise<OpenFileResult> {
  const {
    resolved,
    format,
    readOnly: derivedReadOnly,
    id,
  } = await resolveAndValidatePath(filePath);
  // Caller may override the derived readOnly (e.g. force changelog read-only).
  const readOnly = options?.readOnly === true ? true : derivedReadOnly;
  const fileName = path.basename(resolved);
  const openDocs = getOpenDocs();
  let existingId = id;
  let existing = openDocs.get(id);

  // Realpath fallback: after a rename, a doc stays registered under its ORIGINAL
  // path-hash id but now points at `resolved`. `docIdFromPath(resolved)` no
  // longer matches that id, so without this scan openFromDisk would open a
  // DUPLICATE tab of the same file. (Save-As has the same latent property —
  // promote keeps the upload-derived id; this cures both. See #1017.)
  if (!existing) {
    for (const [openId, d] of openDocs) {
      if (d.source === "file" && pathsEqual(d.filePath, resolved)) {
        existingId = openId;
        existing = d;
        break;
      }
    }
  }

  // Already open — force-reload or switch to existing
  if (existing) {
    const forceReload = options?.force === true;
    if (forceReload) {
      // Force-reload stays inline — distinct lifecycle from normal open.
      // Read the buffer here so the fs.readFile sink sits at the call site
      // where `resolved` was just produced by resolveAndValidatePath —
      // CodeQL traces the sanitizer cross-line within a function but not
      // across function boundaries.
      const doc = getDocument(existingId) ?? getOrCreateDocument(existingId);
      const reloadBuffer =
        format === "docx" ? await fs.readFile(resolved) : await fs.readFile(resolved, "utf-8");
      await clearAndReload(existingId, doc, resolved, format, existing, reloadBuffer, {
        readOnly,
      });
      await openDocumentWhenReady(
        { id: existingId, filePath: resolved, format, readOnly, source: "file" },
        async () => {
          await wireAnnotationStore(existingId, doc, resolved);
        },
      );
      ensureAutoSave();
      return {
        ...buildResult(doc, {
          documentId: existingId,
          filePath: resolved,
          fileName,
          format,
          readOnly,
          source: "file",
          restoredFromSession: false,
        }),
        forceReloaded: true,
      };
    }
    return handleAlreadyOpen(
      existingId,
      getOrCreateDocument(existingId),
      format,
      resolved,
      readOnly,
      existing,
      options?.readOnly === true,
    );
  }

  // Normal open
  const doc = getOrCreateDocument(id);
  const restore = await maybeRestoreSession(resolved, doc, fileName, format, readOnly);
  const restoredFromSession = restore.restored;
  if (!restoredFromSession) {
    await loadContentIntoDoc(doc, format, resolved, id);
  }
  await finalizeDocOpen(id, doc, resolved, fileName, format, readOnly);

  // A restored session that carried unsaved edits re-arms the module-state
  // dirty flag (#1069) — it was lost with the previous process. Must run AFTER
  // finalizeDocOpen's registerDirtyObserver. Without this, autosave would skip
  // the restored-but-unpersisted edits, and the watcher would treat the doc as
  // clean and auto-reload over the only copy of them.
  if (restore.sessionDirty) {
    markDirty(id);
  }

  // Restore-vs-reload prompt (#1069, every format since #1238): a restored
  // session carrying unsaved edits diverges from the on-disk file. Flag it
  // AFTER finalizeDocOpen so writeDocMeta's stale-flag tombstone runs first and
  // this fresh detection wins.
  if (restore.unsavedRestore) {
    const { diskChanged, sessionMtime, conflict } = restore.unsavedRestore;
    if (diskChanged && sessionMtime > 0) {
      // The disk file changed UNDER the restored unsaved edits. Hold the save
      // baseline at the SESSION's mtime (overriding initSavedBaseline's
      // current-mtime value) so the explicit-save external-modification guard
      // blocks until the user resolves the banner — "keep" re-baselines to the
      // current mtime, "reload" takes the disk content. Otherwise a habitual
      // Ctrl+S would silently overwrite the external changes.
      //
      // This is belt-and-braces now, and it does NOT reach the carried-conflict
      // case: there, sessionMtime already equals the current disk mtime, so
      // `diskChanged` is false and this never fires. What actually holds the
      // line for a carried conflict is saveDocumentToDisk's flag check.
      const meta = doc.getMap(Y_MAP_DOCUMENT_META);
      withInternal(doc, () => meta.set(Y_MAP_SAVED_AT_VERSION, sessionMtime));
    }
    // A carried flag is re-raised verbatim — relabelling a detected
    // "external-edit" as an "unsaved-restore" would show the user the wrong
    // question about a divergence Tandem had already identified precisely.
    flagExternalConflict(
      id,
      doc,
      resolved,
      conflict ?? {
        kind: "unsaved-restore",
        diskChanged,
        detectedAt: Date.now(),
      },
    );
  }

  // Inject tutorial annotations whenever the sample welcome document is opened,
  // regardless of whether TANDEM_NO_SAMPLE skipped the server startup auto-open.
  // injectTutorialAnnotations is idempotent — safe to call on session-restored docs.
  if (resolved.endsWith(path.join("sample", "welcome.md"))) {
    injectTutorialAnnotations(doc);
  }

  return {
    ...buildResult(doc, {
      documentId: id,
      filePath: resolved,
      fileName,
      format,
      readOnly,
      source: "file",
      restoredFromSession,
    }),
    forceReloaded: false,
  };
}

/**
 * Open a file from uploaded content (no disk path).
 * Used when the browser drag-and-drops or selects a file.
 */
export async function openFromUpload(
  fileName: string,
  content: string | Buffer,
): Promise<OpenFileResult> {
  const ext = path.extname(fileName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw Object.assign(
      new Error(
        `Unsupported file format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
      ),
      { code: "UNSUPPORTED_FORMAT" },
    );
  }

  const contentSize =
    content instanceof Buffer ? content.length : Buffer.byteLength(content as string);
  if (contentSize > MAX_FILE_SIZE) {
    throw Object.assign(new Error("File exceeds 50MB limit."), { code: "FILE_TOO_LARGE" });
  }

  const format = detectFormat(fileName);
  const readOnly = true;
  const syntheticPath = `${UPLOAD_PREFIX}${randomUUID()}/${fileName}`;
  const id = docIdFromPath(syntheticPath);

  const doc = getOrCreateDocument(id);
  // Display name is the uploaded filename, not the synthetic upload path, so
  // notifications don't leak the internal path shape to the user.
  await populateDocFromContent(doc, format, content, id, {
    displayName: fileName,
    dedupSource: syntheticPath,
  });

  await openDocumentWhenReady(
    { id, filePath: syntheticPath, format, readOnly, source: "upload" },
    async () => {
      writeDocMeta(doc, id, fileName, format, readOnly);
      await initSavedBaseline(doc);
      await wireAnnotationStore(id, doc, syntheticPath);
    },
  );
  ensureAutoSave();

  return buildResult(doc, {
    documentId: id,
    filePath: syntheticPath,
    fileName,
    format,
    readOnly,
    source: "upload",
    restoredFromSession: false,
  });
}

/**
 * Open a new ephemeral scratchpad document.
 *
 * A scratchpad has no file on disk. It uses a synthetic `upload://scratchpad/<uuid>/Scratchpad.md`
 * path, which ensures:
 * - Session manager skips it (isUploadPath filter in listSessionFilePaths)
 * - Auto-save skips it (source === "upload" guard in saveDocumentToDisk / autoSaveAllToDisk)
 * - Recent-files list excludes it (isUploadPath guard in App.svelte)
 *
 * Each call mints a new UUID so closing a scratchpad tab and opening another
 * always yields a fresh empty document. Content is gone when the tab is closed.
 */
export async function openScratchpad(content?: string): Promise<OpenFileResult> {
  const uuid = randomUUID();
  const syntheticPath = `${SCRATCHPAD_PREFIX}${uuid}/Scratchpad.md`;
  const fileName = "Scratchpad.md";
  const format = "md";
  const readOnly = false;
  const id = docIdFromPath(syntheticPath);

  const doc = getOrCreateDocument(id);
  // Optional initial markdown content (#979). Empty (the default) clears the
  // fragment; Tiptap creates a default paragraph on first mount. Structured
  // content is parsed into real blocks via the same markdown adapter. Sync
  // apply inside a single transact preserves the populate path's atomicity
  // invariant (#609). Seeded content is not authorship-stamped — scratchpads are
  // ephemeral (no durable store), so the decorative overlay carries no value.
  const adapter = getAdapter(format);
  const prepared = await adapter.parse(content ?? "");
  withInternal(doc, () => adapter.apply(doc, prepared));

  await openDocumentWhenReady(
    { id, filePath: syntheticPath, format, readOnly, source: "upload" },
    async () => {
      writeDocMeta(doc, id, fileName, format, readOnly);
      await initSavedBaseline(doc);
      // Skip wireAnnotationStore — scratchpads are ephemeral; durable store
      // would leave orphaned JSON files in the annotations directory on close.
    },
  );
  ensureAutoSave();

  return {
    ...buildResult(doc, {
      documentId: id,
      filePath: syntheticPath,
      fileName,
      format,
      readOnly,
      source: "upload",
      restoredFromSession: false,
    }),
    forceReloaded: false,
  };
}

/** Throw INVALID_PATH if `p` carries a UNC / extended-length / device prefix. */
function assertSafePathPrefix(p: string): void {
  const reason = rejectUnsafeWindowsPrefix(p);
  if (reason) throw Object.assign(new Error(reason), { code: "INVALID_PATH" });
}

/**
 * Resolve a raw file path to its canonical form, validate it (UNC check,
 * extension check, size limit), derive format / readOnly / doc ID.
 * stat is used only for the size check and is not returned.
 */
async function resolveAndValidatePath(filePath: string): Promise<ResolvedPath> {
  // ORDER IS THE POINT. `realpathSync` on `\\evil.com\share\x.md` OPENS the SMB
  // connection — and leaks the NTLM hash — before any post-canonicalization
  // check could reject it, so the UNC gate has to run first, on the raw input
  // and on `path.resolve`'s output.
  //
  // These pre-checks are deliberately NOT gated on `process.platform ===
  // "win32"`, matching `windows-path-safety.ts`'s own header and the four
  // existing ungated call sites (convert.ts, document-service.ts,
  // rename-recovery.ts, node-binary.ts): the path string can reach code that
  // runs on Windows via shared state. The helper also covers `\\?\UNC\…`, which
  // the previous inline two-prefix check did not.
  assertSafePathPrefix(filePath);

  let resolved = path.resolve(filePath);
  assertSafePathPrefix(resolved);

  try {
    resolved = fsSync.realpathSync(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(
        `[Tandem] realpathSync failed for ${filePath} (${code}), using path.resolve fallback`,
      );
    }
    resolved = path.resolve(filePath);
  }

  // Defense-in-depth, kept deliberately: a Windows junction can canonicalize to
  // a UNC target that neither pre-check could see.
  assertSafePathPrefix(resolved);

  const ext = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw Object.assign(
      new Error(
        `Unsupported file format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
      ),
      { code: "UNSUPPORTED_FORMAT" },
    );
  }

  const stat = await fs.stat(resolved);
  if (stat.size > MAX_FILE_SIZE) {
    throw Object.assign(new Error("File exceeds 50MB limit."), { code: "FILE_TOO_LARGE" });
  }

  const format = detectFormat(resolved);
  // .docx is now editable (#576): edits are held in the Y.Doc and written back
  // to the original on EXPLICIT save (`saveDocumentToDisk` binary branch). The
  // protective layer is "never overwrite without an explicit save", not
  // read-only — so .docx opens writable like .md / .txt. (Auto-save still skips
  // .docx via BINARY_SAVE_FORMATS being disjoint from AUTO_SAVE_FORMATS.)
  const readOnly = false;
  const id = docIdFromPath(resolved);

  return { resolved, format, readOnly, id };
}

/**
 * Handle the non-force already-open branch: activate the doc and broadcast.
 * This is the only place that sets alreadyOpen: true in the return value.
 *
 * If the caller explicitly requests readOnly: true and the existing record
 * is not already read-only, we upgrade the document to read-only in both the
 * open-docs registry and the Y.Doc metadata so clients see the correct flag.
 * We never downgrade an existing readOnly:true document — the explicit signal
 * only upgrades.
 */
function handleAlreadyOpen(
  id: string,
  doc: Y.Doc,
  format: string,
  resolved: string,
  readOnly: boolean,
  existing: OpenDoc,
  explicitReadOnly: boolean,
): OpenFileResult {
  // Upgrade to read-only when explicitly requested and not already read-only.
  // Both branches end in exactly one broadcast: `openDocument` carries the
  // metadata change and the activation together, so the upgrade never
  // publishes an intermediate state.
  if (explicitReadOnly && !existing.readOnly) {
    const meta = doc.getMap(Y_MAP_DOCUMENT_META);
    withInternal(doc, () => {
      meta.delete(Y_MAP_READ_ONLY);
      meta.set(Y_MAP_READ_ONLY, true);
    });
    openDocument({ ...existing, readOnly: true });
  } else {
    activateDocument(id);
  }
  return {
    ...buildResult(doc, {
      documentId: id,
      filePath: resolved,
      fileName: path.basename(resolved),
      format,
      readOnly,
      source: "file",
      restoredFromSession: false,
    }),
    alreadyOpen: true,
  };
}

/** Result of maybeRestoreSession (#1069, widened in #1238).
 *  - `sessionDirty`: the restored session carried unsaved edits — the caller
 *    re-arms the module-state dirty flag (lost across restarts) so autosave
 *    and the watcher's dirty check see the truth.
 *  - `unsavedRestore`: set when the user must be prompted — the caller surfaces
 *    the restore-vs-reload banner. `sessionMtime` is the on-disk mtime recorded
 *    when the session was saved (0 if it couldn't be stat'd). `conflict` carries
 *    a flag that was already pending at session-save time, so the caller can
 *    re-raise it VERBATIM rather than relabelling an "external-edit" as an
 *    "unsaved-restore". */
interface RestoreResult {
  restored: boolean;
  sessionDirty?: boolean;
  unsavedRestore?: {
    diskChanged: boolean;
    sessionMtime: number;
    conflict?: ExternalConflictState;
  };
}

/**
 * Attempt to restore a Y.Doc from a saved session.
 * `restored` is true ONLY if the session was restored AND the fragment is
 * non-empty. Returns `restored: false` if no session exists, the source file
 * has changed, or the restored fragment is empty (falls back to loading from
 * source file).
 *
 * Exception (#1069, widened to all formats in #1238): a session flagged `dirty`
 * restores EVEN IF the source file changed on disk. That session is the only
 * copy of the user's unsaved edits — dropping it for the disk copy (the old
 * `.md` behaviour) is silent data loss. The caller flags the divergence so the
 * user can choose keep-vs-reload explicitly.
 */
async function maybeRestoreSession(
  resolved: string,
  doc: Y.Doc,
  fileName: string,
  format: string,
  readOnly: boolean,
): Promise<RestoreResult> {
  const session = await loadSession(resolved);
  if (session && sessionModelIsStale(session)) {
    // #1448 W3. Falling through to a fresh parse of the source file, which is
    // the same content read by a load path that no longer damages it. Only
    // clean, on-disk sessions reach here — see `sessionModelIsStale`.
    console.error(
      `[Tandem] Session for ${fileName} predates the current document model; re-reading from the file`,
    );
    return { restored: false };
  }
  if (session) {
    const changed = await sourceFileChanged(session);
    const dirtySession = session.dirty === true;
    if (!changed || dirtySession) {
      restoreYDoc(doc, session);
      const fragment = doc.getXmlFragment("default");
      if (fragment.length > 0) {
        // Two independent reasons to prompt:
        //
        // (a) A conflict was already pending when the session was written.
        //     Carry it across verbatim — it CANNOT be re-derived from
        //     `changed`, because saveSession stats the file at save time, so
        //     sourceFileMtime IS the external write's mtime and
        //     sourceFileChanged reads false on reopen. Without the carry a
        //     restart launders an unresolved conflict away and autosave
        //     overwrites the external file on the next tick.
        //
        // (b) The session holds unpersisted edits that autosave will never
        //     resolve on its own — either the disk also changed, or the format
        //     is not autosaveable (.docx, .html). For an autosaveable format
        //     over an unchanged disk there is nothing to choose: the next tick
        //     persists them. UNLESS the source was deleted or the mtime guard
        //     is already blocking, in which case autosave never runs and the
        //     edits sit unpersisted with no banner. That gap is ACCEPTED, not
        //     handled: both sub-cases are already unreconcilable.
        //
        // `readOnly` gates only (b), the SYNTHESIZED prompt: a read-only doc
        // refuses every save path, so raising a fresh keep-vs-reload choice
        // over restored-but-unpersistable edits is noise.
        //
        // It must NOT gate (a). Suppressing a CARRIED conflict does not defer
        // it, it DESTROYS it: `writeDocMeta` has already tombstoned the flag
        // out of the restored Y.Doc, and the next session write (60s tick or
        // shutdown, neither of which filters read-only docs) rewrites
        // `conflict` from that now-empty Y.Doc. Reopening the same file
        // writable afterwards then finds no flag and autosaves over the
        // external change — the exact laundering the carry exists to prevent,
        // reachable via View Changelog or any `POST /api/open {readOnly:true}`.
        // The banner is not a dead end here either: "Reload from file" is a
        // working branch on a read-only document.
        const carried = narrowConflict(session.conflict);
        const needsPrompt =
          carried !== undefined ||
          (!readOnly && dirtySession && (changed || !AUTO_SAVE_FORMATS.has(format)));
        return {
          restored: true,
          sessionDirty: dirtySession,
          ...(needsPrompt
            ? {
                unsavedRestore: {
                  diskChanged: changed,
                  sessionMtime: session.sourceFileMtime,
                  ...(carried ? { conflict: carried } : {}),
                },
              }
            : {}),
        };
      }
      console.error(
        `[Tandem] Session restore yielded empty doc for ${fileName}, falling back to source file`,
      );
    }
  }
  return { restored: false };
}

/**
 * Finalize a normal (non-force) document open: register in open-docs map,
 * set active, write metadata, init saved baseline, wire annotation store,
 * broadcast, start auto-save, and (for non-docx) set up the file watcher.
 *
 * NOTE: openFromUpload follows a similar sequence but intentionally omits
 * wireFileWatcher and calls initSavedBaseline without a path argument (upload
 * path — no mtime tracking). These divergences are intentional, not drift.
 */
async function finalizeDocOpen(
  id: string,
  doc: Y.Doc,
  resolved: string,
  fileName: string,
  format: string,
  readOnly: boolean,
): Promise<void> {
  await openDocumentWhenReady(
    { id, filePath: resolved, format, readOnly, source: "file" },
    async () => {
      writeDocMeta(doc, id, fileName, format, readOnly);
      await initSavedBaseline(doc, resolved);
      // Normal first open of a real file — enable rename recovery (#313).
      await wireAnnotationStore(id, doc, resolved, { allowRecovery: true });

      // Register the autosave dirty-tracking observer NOW (#851), after content
      // has been loaded into the body — so the open-time baseline is "clean" and
      // a doc opened to view but never edited never autosaves. Registering here
      // (not only in the Hocuspocus swap path) ensures MCP-only edits
      // (tandem_edit) are tracked even when no browser has connected yet. The
      // observer is keyed by docId in module state and re-registered on swap, so
      // it survives the Y.Doc replacement in onLoadDocument.
      registerDirtyObserver(id, doc);
    },
  );
  ensureAutoSave();

  // Watch for external file changes. Clean docs reload from disk in every
  // format; docs with unsaved edits get a conflict flag instead of an
  // auto-reload (see wireFileWatcher's dirty branch).
  wireFileWatcher(id, resolved, format);
}

// --- Private helpers ---

/**
 * Set the initial savedAtVersion baseline so the client knows the file is clean on open.
 * Uses the file's mtime when available so the first auto-save can detect external modifications.
 */
async function initSavedBaseline(doc: Y.Doc, filePath?: string): Promise<void> {
  let baseline = Date.now();
  if (filePath) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) baseline = stat.mtimeMs;
  }
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  withInternal(doc, () => meta.set(Y_MAP_SAVED_AT_VERSION, baseline));
}

function writeDocMeta(
  doc: Y.Doc,
  id: string,
  fileName: string,
  format: string,
  readOnly: boolean,
): void {
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  withInternal(doc, () => {
    // Tombstone any session-persisted value so a stale session's higher-clock
    // write can't override the authoritative readOnly passed by the caller.
    // The same delete-before-set pattern is required in handleAlreadyOpen.
    meta.delete(Y_MAP_READ_ONLY);
    meta.set(Y_MAP_READ_ONLY, readOnly);
    meta.set("format", format);
    meta.set("documentId", id);
    meta.set("fileName", fileName);
    // A conflict flag persisted inside a restored session is stale detection
    // state — clear it here; openFromDisk re-flags freshly when the current
    // open actually warrants it (#1069).
    meta.delete(Y_MAP_EXTERNAL_CONFLICT);
  });
}

function buildResult(
  doc: Y.Doc,
  base: Omit<
    OpenFileResult,
    "tokenEstimate" | "pageEstimate" | "alreadyOpen" | "forceReloaded" | "warnings"
  >,
): OpenFileResult {
  const textContent = extractText(doc);
  const textLen = textContent.length;
  const pageEstimate = Math.ceil(textLen / CHARS_PER_PAGE);

  const warnings: string[] = [];
  if (pageEstimate >= VERY_LARGE_FILE_PAGE_THRESHOLD) {
    warnings.push(
      `Very large document (~${pageEstimate} pages). Consider splitting into smaller files.`,
    );
  } else if (pageEstimate >= LARGE_FILE_PAGE_THRESHOLD) {
    warnings.push(`Large document (~${pageEstimate} pages). Operations may be slower than usual.`);
  }

  return {
    ...base,
    tokenEstimate: Math.ceil(textLen / 4),
    pageEstimate,
    alreadyOpen: false,
    forceReloaded: false,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Reopen a document from disk-cached session state (ADR-034's fourth entry).
 *
 * Deliberately a named entry rather than a bare `openFromDisk` call, because
 * the `readOnly` flag is the part callers forget: without carrying it back
 * through, every restored document takes `resolveAndValidatePath`'s hardcoded
 * `false` and a read-only tab (View Changelog) comes back writable — a bug that
 * has been shipped once already (#1591). Naming the restore path is what gives
 * that flag somewhere to live.
 *
 * The parameter is a `Pick` of `SessionFileEntry` rather than a hand-written
 * `{ filePath, readOnly? }`, so the two fields have one definition instead of
 * two that must be kept in agreement by eye — if `readOnly` ever stops being a
 * bare boolean, this follows automatically. `lastAccessed` stays out because
 * restore has no business receiving it.
 *
 * Be clear about what that does NOT buy, because it is the half worth knowing:
 * a `Pick` selects named fields, so a THIRD field added to `SessionFileEntry`
 * that restore must honour still will not force this signature to widen. The
 * type makes the existing fields consistent; it does not make forgetting a new
 * one a compile error. #1591 was that class of bug, and what actually guards
 * against a repeat is this entry point existing at all — one named place where
 * the question "what does restore have to carry?" is asked.
 */
export async function openFromRestore(
  entry: Pick<SessionFileEntry, "filePath" | "readOnly">,
): Promise<OpenFileResult> {
  return await openFromDisk(entry.filePath, { readOnly: entry.readOnly });
}

/**
 * Tagged variant for `OpenFileResult.kind` — derived from the existing
 * `restoredFromSession` / `alreadyOpen` / `forceReloaded` booleans.
 * ADR-034 part 2 promotes this to a real discriminator on the result
 * type; part 1 exposes it as a derivation so callers can adopt the
 * vocabulary now.
 *
 *   - `fresh`            — first time this session; content loaded from disk or
 *                          upload, or seeded from a scratchpad's optional content
 *   - `restored`         — disk-cached session state was applied; no disk re-read
 *   - `already-open`     — caller asked for a doc that's already tracked; no-op switch
 *   - `force-reloaded`   — caller passed `force: true`; doc state replaced from disk
 */
export type OpenResultKind = "fresh" | "restored" | "already-open" | "force-reloaded";

export function kindOfOpenResult(result: OpenFileResult): OpenResultKind {
  if (result.forceReloaded) return "force-reloaded";
  if (result.alreadyOpen) return "already-open";
  if (result.restoredFromSession) return "restored";
  return "fresh";
}
