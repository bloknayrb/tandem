/**
 * Scratchpad persistence + close-warning hook (#864).
 *
 * Scratchpads are ephemeral in-memory Y.Doc rooms (synthetic path
 * `upload://scratchpad/<uuid>/Scratchpad.md`) with NO durable store and NO
 * close warning, so content is lost on app close / tab close. This hook:
 *
 *  1. Observes each open scratchpad tab's Y.Doc `update` event and persists its
 *     plain-text content to localStorage (debounced) keyed by install id plus
 *     the scratchpad UUID — NOT by docHash. All scratchpads collapse to one
 *     docHash, so keying by hash would let concurrent scratchpads overwrite each
 *     other's recovery content; the install segment is #1387.
 *  2. Restores the most-recently-persisted unsaved scratchpad content into a
 *     freshly-opened scratchpad (each Ctrl+N mints a new UUID, so recovery
 *     targets the latest persisted text rather than an exact UUID match).
 *  3. Registers a `beforeunload` warning when any scratchpad has unsaved
 *     content, and exposes `hasUnsavedContent(uuid)` for the tab-close
 *     confirmation.
 *
 * All localStorage access is wrapped in try/catch — some browsers (incognito,
 * storage-disabled) throw on access (CLAUDE.md gotcha).
 *
 * Scratchpad annotations are intentionally out of scope (accepted loss); only
 * document text is persisted.
 */
import type { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { withBrowser } from "../../shared/origins.js";
import { isScratchpadPath, scratchpadUuidFromPath } from "../../shared/paths.js";
import type { OpenTab } from "../types.js";
import { type Debounced, debounce } from "../utils/debounce.js";

/**
 * localStorage key for a scratchpad's persisted text.
 *
 * Keyed by INSTALL as well as UUID (#1387). Successive Tandem servers are
 * reached at the same host:port, which is one `localStorage` bucket, so a key
 * carrying only the UUID is readable by all of them in turn — and since a
 * fresh scratchpad has no key of its own, the
 * latest-pointer fallback below would restore one server's content into
 * another's document. Scoping by install makes that lookup miss, which is the
 * whole fix; see `utils/install-id.ts` for why the server's session-store path
 * is the right discriminator and `generationId` is not.
 */
export function scratchpadStorageKey(installId: string, uuid: string): string {
  return `tandem:scratchpad:${installId}:${uuid}`;
}

/**
 * Pointer to the UUID of the most recently persisted unsaved scratchpad, per
 * install. Must be install-scoped for the same reason as the content key — a
 * global pointer would send every install to the same content.
 *
 * The `tandem:scratchpad:` prefix is load-bearing beyond tidiness: the E2E
 * cleanups clear recovery by prefix match, so keeping it means that clearing
 * still reaches both key kinds, for every install.
 */
function scratchpadLatestKey(installId: string): string {
  return `tandem:scratchpad:${installId}:latest`;
}

/**
 * Delete the pre-#1387 unscoped keys (`tandem:scratchpad:<uuid>` and
 * `tandem:scratchpad:latest`) on hook creation, without reading them.
 *
 * Nothing addresses those keys any more, so left alone they sit in the user's
 * browser forever holding document text — and it is precisely the text that
 * crossed installs, so "forever" is the wrong retention for it.
 *
 * Deliberately a purge and not a migration. Adopting a legacy value would have
 * to guess which install wrote it, and the whole class of gated read-throughs
 * was rejected on the plan: the gating condition is not client-detectable, so
 * every variant fails open on a foreign install's content. The cost is one
 * release's worth of unsaved scratchpad text for someone upgrading mid-edit —
 * already the accepted cost of not reading these at all. This only makes the
 * loss immediate instead of leaving the content behind to be lost silently.
 *
 * The discriminator is segment count: a scoped key is
 * `tandem:scratchpad:<install>:<uuid|latest>` (four segments) and neither an
 * install id (8 hex chars) nor a `randomUUID()` contains a colon, so exactly
 * three segments means legacy. The `tandem:scratchpad:` prefix check is the
 * other half of the guard and is load-bearing: `tandem:headingCollapse:<docId>`
 * is a real neighbour with the same segment count, and sweeping it would wipe
 * every user's heading-collapse state on every start.
 *
 * Scoped keys belonging to an install this browser no longer talks to are
 * deliberately NOT swept. Two installs alternate legitimately on one machine —
 * the desktop sidecar and a dev server take turns on the same port — so
 * "not the current install" does not mean "dead", and deleting on that basis
 * would destroy a real draft. Growth is bounded in practice because the paths
 * that vary are fixed, not per-run (`playwright.config.ts` pins
 * `/tmp/tandem-e2e-data`, design baselines pin their own); a user accumulates
 * one or two ids for life, and a new one is minted only by something as rare as
 * an app-data root move.
 */
function purgeLegacyScratchpadKeys(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null) continue;
      if (!key.startsWith("tandem:scratchpad:")) continue;
      if (key.split(":").length === 3) doomed.push(key);
    }
    // Collected first: removing during the walk reindexes localStorage under
    // the loop and would skip every other match.
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // Ignore — storage-disabled browsers (CLAUDE.md gotcha). A SecurityError
    // mid-loop leaves a PARTIAL purge rather than none; harmless, since this
    // runs again on the next hook creation and nothing writes these keys.
  }
}

const PERSIST_DEBOUNCE_MS = 500;

/**
 * Extract plain text from a Y.XmlFragment ("default" document content). Walks
 * top-level block elements (paragraphs, headings, list items, etc.) and joins
 * their text content with newlines. Inline marks are dropped — recovery is
 * plain text, matching the issue's "unsaved content" scope.
 */
export function extractFragmentBlocks(fragment: Y.XmlFragment): string[] {
  const blocks: string[] = [];
  const collect = (node: Y.XmlElement | Y.XmlText | Y.XmlHook): string => {
    if (node instanceof Y.XmlText) return node.toString();
    if (node instanceof Y.XmlElement) {
      let s = "";
      for (let i = 0; i < node.length; i++) {
        s += collect(node.get(i) as Y.XmlElement | Y.XmlText | Y.XmlHook);
      }
      return s;
    }
    return "";
  };
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
      blocks.push(collect(child as Y.XmlElement | Y.XmlText));
    }
  }
  while (blocks.length > 0 && blocks[blocks.length - 1] === "") blocks.pop();
  return blocks;
}

export function extractFragmentText(fragment: Y.XmlFragment): string {
  return extractFragmentBlocks(fragment).join("\n");
}

/**
 * Encode a scratchpad's blocks for localStorage.
 *
 * JSON, not `blocks.join("\n")`, because since #1448 a paragraph's own text can
 * contain a literal `\n` — that is what stops a soft wrap becoming a hard break.
 * With `\n` doing double duty as both the intra-block character and the
 * block separator, the split on restore could not tell them apart, and a
 * recovered scratchpad came back with one paragraph per WRAPPED LINE: crash
 * recovery silently reformatting the thing it exists to preserve.
 */
export function encodeScratchpadBlocks(blocks: string[]): string {
  return JSON.stringify(blocks);
}

/**
 * Decode what {@link encodeScratchpadBlocks} wrote.
 *
 * Falls back to the pre-#1448 newline-delimited form for a value already sitting
 * in a user's localStorage from an older build — an upgrade must not be the
 * thing that discards their unsaved text. That form genuinely cannot represent
 * an intra-block newline, so splitting it is the correct reading of it.
 */
export function decodeScratchpadBlocks(stored: string): string[] {
  if (stored.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.every((b) => typeof b === "string")) {
        return parsed as string[];
      }
    } catch {
      // Not our JSON after all — read it as legacy text below.
    }
  }
  return stored.split("\n");
}

interface ScratchpadEntry {
  uuid: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  updateHandler: () => void;
  /** One-shot `synced` listener used to defer restore until after initial sync. */
  syncedHandler: (() => void) | null;
  persist: Debounced<[]>;
}

export interface ScratchpadPersistence {
  /** True when the scratchpad with this UUID currently has unsaved content. */
  hasUnsavedContent: (uuid: string) => boolean;
  /**
   * Discard a scratchpad's persisted recovery content (localStorage + the
   * `latest` pointer). Called when the user confirms closing a scratchpad whose
   * content they accept losing — without this the next open would restore the
   * just-discarded text, contradicting the "content will be lost" warning.
   */
  clearUnsaved: (uuid: string) => void;
  /** Caller invokes this in component teardown. */
  destroy: () => void;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable — recovery silently degrades; never crash.
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Wire scratchpad persistence for the live set of open tabs.
 *
 * @param getTabs Reactive accessor for the current open tabs. The hook diffs
 *   this on every change to attach/detach Y.Doc observers per scratchpad.
 * @param getInstallId Accessor for the connected server's install id, or `null`
 *   before `/api/info` has answered. Injected rather than read from module
 *   state so the cross-install behaviour is testable without a live connection.
 *   **Storage is suppressed while this is `null`** — fail closed. A fail-open
 *   default would restore under whatever key happened to be reachable, which is
 *   the #1387 bug with extra steps.
 *
 *   Scoped deliberately to *storage*: the unsaved-content warning still fires
 *   (see `persistEntry`), and `clearUnsaved` still clears its flag. Widening the
 *   guard to those would trade a content leak for silent content loss.
 *
 *   Note the two suppressed paths recover differently. Persist retries on the
 *   next debounced update, so a null window costs nothing once the id lands.
 *   **Restore does not retry** — it runs once per attach (directly, or from a
 *   one-shot `synced` listener), so a null read forfeits recovery for that tab's
 *   whole lifetime. That asymmetry is tolerable only because the branch is
 *   unreachable in production: `yjsSync` builds no provider until
 *   `fetchServerIdentity` resolves, and that same response carries both the
 *   generation id and `storagePath` (they share one `if (loopback)` block in
 *   `server/mcp/routes/info.ts`). Split those two fields and this comes alive.
 */
export function createScratchpadPersistence(
  getTabs: () => OpenTab[],
  getInstallId: () => string | null,
): ScratchpadPersistence {
  // Tracked scratchpad rooms keyed by UUID. Non-reactive — observers drive
  // persistence directly; the unsaved-content map below carries reactive state.
  const entries = new Map<string, ScratchpadEntry>();
  // Reactive unsaved-content flags keyed by UUID (drives beforeunload + close
  // confirmation). $state so consumers re-derive when content appears/clears.
  const unsaved = $state<Record<string, boolean>>({});

  const anyUnsaved = () => Object.values(unsaved).some(Boolean);

  purgeLegacyScratchpadKeys();

  const persistEntry = (entry: ScratchpadEntry) => {
    const fragment = entry.ydoc.getXmlFragment("default");
    const blocks = extractFragmentBlocks(fragment);
    const hasContent = blocks.join("").length > 0;
    // The warning flag tracks the DOCUMENT, not whether we managed to store it.
    // It is set before the fail-closed return below and outside the empty/
    // non-empty split, because the two questions are independent: "is there
    // unsaved text here" is answered by the fragment alone. Deriving it from a
    // successful write instead would mean content we could not persist closes
    // with no prompt at all — the case where the warning matters MOST, since
    // the recovery net is exactly what is missing. (The pre-existing storage
    // wrappers swallow QuotaExceededError for the same reason: on a failed
    // write the flag stays true and the user is warned.)
    unsaved[entry.uuid] = hasContent;

    const installId = getInstallId();
    if (installId === null) return; // fail closed on STORAGE only — see getInstallId
    const latestKey = scratchpadLatestKey(installId);
    const key = scratchpadStorageKey(installId, entry.uuid);
    if (!hasContent) {
      // Empty scratchpad — clear any stale recovery so a later open doesn't
      // resurrect text the user deleted.
      removeStorage(key);
      if (readStorage(latestKey) === entry.uuid) {
        removeStorage(latestKey);
      }
      return;
    }
    writeStorage(key, encodeScratchpadBlocks(blocks));
    writeStorage(latestKey, entry.uuid);
  };

  const attach = (uuid: string, ydoc: Y.Doc, provider: HocuspocusProvider) => {
    if (entries.has(uuid)) return;
    const entry: ScratchpadEntry = {
      uuid,
      ydoc,
      provider,
      updateHandler: () => {},
      syncedHandler: null,
      persist: debounce(() => {}, PERSIST_DEBOUNCE_MS),
    };
    entry.persist = debounce(() => persistEntry(entry), PERSIST_DEBOUNCE_MS);
    // Observe the Y.Doc `update` event (NOT a content-reading $effect, which
    // would re-run per keystroke). Persistence is debounced behind it.
    entry.updateHandler = () => entry.persist();
    ydoc.on("update", entry.updateHandler);
    entries.set(uuid, entry);

    // Restore must wait until the provider has synced the room's authoritative
    // state — restoring before sync races the incoming server content and the
    // CRDT merge would DUPLICATE it (server content + our injected paragraphs).
    // If already synced (rare here, since attach fires as the tab appears), run
    // immediately; otherwise defer to a one-shot `synced` listener.
    if (provider.synced) {
      restoreInto(entry);
    } else {
      const onSynced = () => {
        entry.syncedHandler = null;
        provider.off("synced", onSynced);
        // The entry may have been detached while waiting.
        if (entries.get(uuid) === entry) restoreInto(entry);
      };
      entry.syncedHandler = onSynced;
      provider.on("synced", onSynced);
    }
  };

  const restoreInto = (entry: ScratchpadEntry) => {
    const installId = getInstallId();
    if (installId === null) {
      // Fail closed — see getInstallId. Warn rather than return silently: this
      // is one-shot, so the user simply sees an empty scratchpad and cannot
      // distinguish "nothing to recover" from "recovery was skipped", and a
      // developer chasing it has no artifact but an unread localStorage key.
      // Same reasoning as `buildDecorations`' CRDT-fallback warning.
      console.warn(
        "[Tandem] Scratchpad recovery skipped: install id unknown (/api/info reported no storagePath). This does not retry for this scratchpad.",
      );
      return;
    }

    const fragment = entry.ydoc.getXmlFragment("default");
    // Only restore into a genuinely empty scratchpad (provider has synced, so
    // a non-empty fragment means real server content we must not clobber).
    if (extractFragmentText(fragment).length > 0) return;

    // Prefer an exact-UUID match (same room reopened); else fall back to the
    // latest persisted scratchpad for cross-session recovery.
    //
    // The `latest`-pointer fallback is GATED to single-open sessions
    // (`entries.size === 1`). Without this gate, opening a fresh scratchpad
    // B while A is still open and unsaved would copy A's content into B and
    // then `removeStorage(scratchpadStorageKey(A))` below — deleting A's
    // recovery key while A is still open and dirty. Attach order is
    // load-bearing here: `attach()` calls `entries.set(uuid, entry)` BEFORE
    // invoking `restoreInto`, so at this point `entries.size === 1` means
    // "this is the only open scratchpad" regardless of caller timing.
    let sourceUuid = entry.uuid;
    let stored = readStorage(scratchpadStorageKey(installId, sourceUuid));
    if (stored === null && entries.size === 1) {
      const latest = readStorage(scratchpadLatestKey(installId));
      if (latest && latest !== entry.uuid) {
        stored = readStorage(scratchpadStorageKey(installId, latest));
        sourceUuid = latest;
      }
    }
    if (stored === null || stored.length === 0) return;

    // Insert restored text as paragraphs into the (empty) fragment. y-prosemirror
    // reconciles this into the editor on mount. Build elements detached then
    // insert in one transaction so the populate path stays atomic.
    const paragraphs = decodeScratchpadBlocks(stored).map((block) => {
      const p = new Y.XmlElement("paragraph");
      if (block.length > 0) p.insert(0, [new Y.XmlText(block)]);
      return p;
    });
    // Privacy invariant: BROWSER_ORIGIN is the only origin NOT in CHANNEL_SKIP
    // (see src/shared/origins.ts and src/server/events/queue.ts). Tagging this
    // restore as `browser` is safe ONLY because there is no channel observer
    // over the document's content XmlFragment — existing observers (annotations,
    // replies, awareness, ctrl-chat, ctrl-meta) don't fire on content inserts,
    // and ctrl-meta filters document:opened/document:switched by isUploadPath.
    // If a future change adds a content-XmlFragment channel observer, it MUST
    // filter on opts.uploadDoc (matching the annotations-observer pattern in
    // queue.ts) — otherwise scratchpad content would leak via the channel.
    withBrowser(entry.ydoc, () => {
      // Clear any default empty paragraph y-prosemirror may have created.
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      fragment.insert(0, paragraphs);
    });

    // Re-point latest at THIS scratchpad's UUID and persist under it so the
    // recovered content survives a subsequent reload of this room.
    writeStorage(scratchpadStorageKey(installId, entry.uuid), stored);
    writeStorage(scratchpadLatestKey(installId), entry.uuid);
    if (sourceUuid !== entry.uuid) removeStorage(scratchpadStorageKey(installId, sourceUuid));
    unsaved[entry.uuid] = true;
  };

  const detach = (uuid: string) => {
    const entry = entries.get(uuid);
    if (!entry) return;
    // Flush a pending debounced write so the final keystroke is persisted.
    entry.persist.flush();
    entry.ydoc.off("update", entry.updateHandler);
    if (entry.syncedHandler) entry.provider.off("synced", entry.syncedHandler);
    entries.delete(uuid);
    // Leave the reactive `unsaved` flag and localStorage content in place: a
    // closed scratchpad's content is still recoverable on the next open unless
    // the caller explicitly discards it via clearUnsaved (confirmed close).
  };

  const clearUnsaved = (uuid: string) => {
    // Unlike persist/restore this does NOT fail closed on a null install id:
    // the reactive flag must still clear so a confirmed close stops warning.
    // Guarding it too would latch `unsaved[uuid]` true forever — the confirm
    // dialog would re-fire on every close attempt and `beforeunload` would warn
    // permanently, since detach() runs right after and nothing recomputes it.
    //
    // The storage removal IS skipped, and there is NO retry to recover it: the
    // sole caller is the confirmed-close path, after which detach() drops the
    // entry and each new scratchpad mints a fresh UUID. A skipped removal
    // therefore leaves both the content key and the `latest` pointer behind,
    // and the fallback below can restore the very text the user confirmed
    // discarding. Acceptable only because the null branch is unreachable in
    // production (see getInstallId) — not because it self-heals.
    const installId = getInstallId();
    if (installId !== null) {
      removeStorage(scratchpadStorageKey(installId, uuid));
      const latestKey = scratchpadLatestKey(installId);
      if (readStorage(latestKey) === uuid) removeStorage(latestKey);
    }
    // Drop any pending debounced write so it can't re-persist after discard.
    entries.get(uuid)?.persist.cancel();
    unsaved[uuid] = false;
  };

  // Use $effect.root so the hook owns its effect lifetime and can be fully torn
  // down via destroy() (mirrors createYjsSync's pattern; the hook is created at
  // App.svelte script top-level, not inside a render-scoped effect).
  const stopEffects = $effect.root(() => {
    // Diff open tabs → attach/detach scratchpad observers. Reading getTabs()
    // makes this effect re-run on any tab open/close.
    $effect(() => {
      const tabs = getTabs();
      const liveUuids = new Set<string>();
      for (const tab of tabs) {
        if (!isScratchpadPath(tab.filePath)) continue;
        const uuid = scratchpadUuidFromPath(tab.filePath);
        if (!uuid) continue;
        liveUuids.add(uuid);
        attach(uuid, tab.ydoc, tab.provider);
      }
      for (const uuid of [...entries.keys()]) {
        if (!liveUuids.has(uuid)) detach(uuid);
      }
    });

    // beforeunload warning when any scratchpad has unsaved content. Follows the
    // existing addEventListener-in-$effect-with-cleanup pattern.
    $effect(() => {
      const onBeforeUnload = (ev: BeforeUnloadEvent) => {
        if (!anyUnsaved()) return;
        // Flush all pending debounced writes so a reload doesn't lose the tail.
        for (const entry of entries.values()) entry.persist.flush();
        ev.preventDefault();
        // Legacy browsers require returnValue set; the string is not shown.
        ev.returnValue = "You have unsaved scratchpad content.";
        return "You have unsaved scratchpad content.";
      };
      window.addEventListener("beforeunload", onBeforeUnload);
      return () => window.removeEventListener("beforeunload", onBeforeUnload);
    });
  });

  return {
    hasUnsavedContent: (uuid: string) => unsaved[uuid] === true,
    clearUnsaved,
    destroy: () => {
      stopEffects();
      for (const uuid of [...entries.keys()]) detach(uuid);
    },
  };
}
