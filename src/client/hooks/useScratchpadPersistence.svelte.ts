/**
 * Scratchpad persistence + close-warning hook (#864).
 *
 * Scratchpads are ephemeral in-memory Y.Doc rooms (synthetic path
 * `upload://scratchpad/<uuid>/Scratchpad.md`) with NO durable store and NO
 * close warning, so content is lost on app close / tab close. This hook:
 *
 *  1. Observes each open scratchpad tab's Y.Doc `update` event and persists its
 *     plain-text content to localStorage (debounced) keyed by the scratchpad
 *     UUID — NOT by docHash. All scratchpads collapse to one docHash, so keying
 *     by hash would let concurrent scratchpads overwrite each other's recovery
 *     content.
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

/** localStorage key for a scratchpad's persisted text, keyed by UUID. */
export function scratchpadStorageKey(uuid: string): string {
  return `tandem:scratchpad:${uuid}`;
}

/** Pointer to the UUID of the most recently persisted unsaved scratchpad. */
const SCRATCHPAD_LATEST_KEY = "tandem:scratchpad:latest";

const PERSIST_DEBOUNCE_MS = 500;

/**
 * Extract plain text from a Y.XmlFragment ("default" document content). Walks
 * top-level block elements (paragraphs, headings, list items, etc.) and joins
 * their text content with newlines. Inline marks are dropped — recovery is
 * plain text, matching the issue's "unsaved content" scope.
 */
export function extractFragmentText(fragment: Y.XmlFragment): string {
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
  return blocks.join("\n").replace(/\n+$/, "");
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
 */
export function createScratchpadPersistence(getTabs: () => OpenTab[]): ScratchpadPersistence {
  // Tracked scratchpad rooms keyed by UUID. Non-reactive — observers drive
  // persistence directly; the unsaved-content map below carries reactive state.
  const entries = new Map<string, ScratchpadEntry>();
  // Reactive unsaved-content flags keyed by UUID (drives beforeunload + close
  // confirmation). $state so consumers re-derive when content appears/clears.
  const unsaved = $state<Record<string, boolean>>({});

  const anyUnsaved = () => Object.values(unsaved).some(Boolean);

  const persistEntry = (entry: ScratchpadEntry) => {
    const fragment = entry.ydoc.getXmlFragment("default");
    const text = extractFragmentText(fragment);
    const key = scratchpadStorageKey(entry.uuid);
    if (text.length === 0) {
      // Empty scratchpad — clear any stale recovery so we don't warn on close.
      removeStorage(key);
      if (readStorage(SCRATCHPAD_LATEST_KEY) === entry.uuid) {
        removeStorage(SCRATCHPAD_LATEST_KEY);
      }
      unsaved[entry.uuid] = false;
      return;
    }
    writeStorage(key, text);
    writeStorage(SCRATCHPAD_LATEST_KEY, entry.uuid);
    unsaved[entry.uuid] = true;
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
    const fragment = entry.ydoc.getXmlFragment("default");
    // Only restore into a genuinely empty scratchpad (provider has synced, so
    // a non-empty fragment means real server content we must not clobber).
    if (extractFragmentText(fragment).length > 0) return;

    // Prefer an exact-UUID match (same room reopened); else fall back to the
    // latest persisted scratchpad for cross-session recovery.
    let sourceUuid = entry.uuid;
    let stored = readStorage(scratchpadStorageKey(sourceUuid));
    if (stored === null) {
      const latest = readStorage(SCRATCHPAD_LATEST_KEY);
      if (latest && latest !== entry.uuid) {
        stored = readStorage(scratchpadStorageKey(latest));
        sourceUuid = latest;
      }
    }
    if (stored === null || stored.length === 0) return;

    // Insert restored text as paragraphs into the (empty) fragment. y-prosemirror
    // reconciles this into the editor on mount. Build elements detached then
    // insert in one transaction so the populate path stays atomic.
    const lines = stored.split("\n");
    const paragraphs = lines.map((line) => {
      const p = new Y.XmlElement("paragraph");
      if (line.length > 0) p.insert(0, [new Y.XmlText(line)]);
      return p;
    });
    withBrowser(entry.ydoc, () => {
      // Clear any default empty paragraph y-prosemirror may have created.
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      fragment.insert(0, paragraphs);
    });

    // Re-point latest at THIS scratchpad's UUID and persist under it so the
    // recovered content survives a subsequent reload of this room.
    writeStorage(scratchpadStorageKey(entry.uuid), stored);
    writeStorage(SCRATCHPAD_LATEST_KEY, entry.uuid);
    if (sourceUuid !== entry.uuid) removeStorage(scratchpadStorageKey(sourceUuid));
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
    removeStorage(scratchpadStorageKey(uuid));
    if (readStorage(SCRATCHPAD_LATEST_KEY) === uuid) removeStorage(SCRATCHPAD_LATEST_KEY);
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
