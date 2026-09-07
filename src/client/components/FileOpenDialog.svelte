<script lang="ts">
import { API_UPLOAD } from "../../shared/api-paths.js";
import { SUPPORTED_EXTENSIONS } from "../../shared/constants.js";
import { scrollFade } from "../actions/scrollFade.svelte.js";
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { pickNativeFilePath } from "../utils/browse-file.js";
import { API_BASE, readFileForUpload } from "../utils/fileUpload.js";
import {
  addRecentFile,
  clearRecentFiles,
  loadRecentFiles,
  recentFilePaths,
  saveRecentFiles,
} from "../utils/recentFiles.js";
import { openServerPath } from "../utils/server-paths.js";
import {
  clearAllSessions,
  deleteSessionByPath,
  fetchSessions,
  type SessionMetadata,
} from "../utils/sessions.js";

interface Props {
  onClose: () => void;
}

const { onClose }: Props = $props();

let error = $state<string | null>(null);
let loading = $state(false);
let fileInputEl: HTMLInputElement | undefined = $state();
let recentFiles = $state<string[]>(recentFilePaths(loadRecentFiles()));

// --- Saved sessions (#103) ---
let sessions = $state<SessionMetadata[]>([]);
let sessionsExpanded = $state(false);
let sessionsLoading = $state(false);
// Tracks whether a load has succeeded at least once, so collapse/expand (or
// clearing to an empty list) doesn't re-fetch. Distinct from `sessions.length`,
// which is 0 both before the first load AND when there are genuinely none.
let sessionsLoaded = $state(false);
let sessionsError = $state<string | null>(null);

// #1773: deleting a saved session is irreversible — it discards the persisted
// Y.Doc state, the sourceFileMtime and the annotations the row advertises — so
// both delete affordances arm first and act on a second, explicit click. Two
// separate cells, never one shared flag: the BulkActions lesson (SidePanel.svelte
// "a third value on one flag renders the wrong row's wording against the wrong
// action"). `pendingDeletePath` also means at most one row is ever armed.
let pendingDeletePath = $state<string | null>(null);
let clearAllArmed = $state(false);

// Every arm/disarm swaps the button that currently has focus out of the DOM, so
// without focus management the browser drops focus to <body> — which is OUTSIDE
// the role="dialog" div that owns the Escape handler. The armed confirm would
// then be uncancellable by keyboard and Escape would stop closing the dialog,
// in exactly the state this two-step confirm creates. The dialog is not
// focus-trapped (#1778), so Tab from <body> can walk into browser chrome.
//
// Attachments, not `bind:this` + $effect: each node gets its OWN callback, so
// there is no shared bound ref for another row's teardown to null out — the
// hazard SidePanel.svelte:193-198 documents for keyed {#each} rows.
let sessionsToggleEl: HTMLButtonElement | undefined = $state();

/** Focus a node the moment it mounts. Only used where mounting IS the arm. */
function focusOnMount(node: HTMLElement) {
  node.focus();
}

// Disarming has to be gated on intent: the rest-state buttons also mount when
// the list first renders, and focusing one there would steal focus from the
// autofocused Browse button. A plain `let` on purpose — this is read inside an
// attachment, and a $state cell read-and-written in the same reaction is the
// self-invalidating shape.
let refocusOnDisarm: string | null = null;

// Row keys are file paths, so Clear all needs one that cannot collide with a
// real one. NUL is not legal in a path on any platform Tandem runs on.
const CLEAR_ALL_FOCUS_KEY = "\0clear-all";

/** Focus this node only if it is the arm button whose confirm was just cancelled. */
function focusIfDisarmed(key: string) {
  return (node: HTMLElement) => {
    if (refocusOnDisarm !== key) return;
    refocusOnDisarm = null;
    node.focus();
  };
}

/**
 * Park focus on the sessions toggle after a CONFIRMED action. The confirm button
 * is gone either way — the row (or the whole list) unmounted on success, and it
 * swapped back to the arm button on failure — so there is no node to return to.
 */
function parkFocusAfterConfirm() {
  sessionsToggleEl?.focus();
}

// Both confirms render the same destructive/cancel button pair, so the recipe
// lives once here and is interpolated — the `smallBtnBase` shape from
// BulkActions.svelte, which is also the component this confirm mirrors. A
// shared CSS class cannot cross the component boundary (Svelte scopes styles),
// and this file styles inline everywhere else.
const confirmBtnBase =
  "border: none; font-size: 11px; cursor: pointer; padding: 2px 8px; border-radius: var(--tandem-r-1); line-height: 1.4;";
const destructiveBtnStyle = `${confirmBtnBase} background: var(--tandem-error-bg); color: var(--tandem-error-fg-strong); font-weight: 600;`;
const cancelBtnStyle = `${confirmBtnBase} background: none; color: var(--tandem-fg-subtle);`;

async function loadSessions() {
  sessionsLoading = true;
  sessionsError = null;
  const result = await fetchSessions();
  if (result.ok) {
    sessions = result.data;
    sessionsLoaded = true;
  } else {
    sessionsError = result.error;
  }
  sessionsLoading = false;
}

function toggleSessions() {
  sessionsExpanded = !sessionsExpanded;
  // Collapsing disarms, so re-expanding never re-mounts into a confirm state.
  pendingDeletePath = null;
  clearAllArmed = false;
  if (sessionsExpanded && !sessionsLoaded && !sessionsLoading) {
    void loadSessions();
  }
}

async function deleteSession(filePath: string) {
  sessionsError = null;
  const result = await deleteSessionByPath(filePath);
  if (result.ok) {
    sessions = sessions.filter((s) => s.filePath !== filePath);
  } else {
    sessionsError = result.error;
  }
}

async function clearSessions() {
  sessionsError = null;
  const result = await clearAllSessions();
  if (result.ok) {
    sessions = [];
  } else {
    sessionsError = result.error;
  }
}

function formatRelativeTime(ms: number): string {
  if (!ms) return "unknown";
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const extensionList = Array.from(SUPPORTED_EXTENSIONS).sort();
const acceptAttr = extensionList.join(",");

function pushRecent(path: string) {
  const updated = addRecentFile(loadRecentFiles(), path);
  saveRecentFiles(updated);
  recentFiles = recentFilePaths(updated);
}

function handleClearRecent() {
  clearRecentFiles();
  recentFiles = [];
}

async function openByPath(pathToOpen: string) {
  if (loading) return;
  error = null;
  loading = true;
  try {
    const result = await openServerPath(pathToOpen);
    if (!result.ok) {
      error = result.error;
      return;
    }
    pushRecent(pathToOpen);
    onClose();
  } finally {
    loading = false;
  }
}

async function browseNative() {
  if (loading) return;
  try {
    const selected = await pickNativeFilePath();
    if (selected) await openByPath(selected);
  } catch (err) {
    error = `File picker unavailable: ${err instanceof Error ? err.message : err}`;
  }
}

async function uploadFile(file: File) {
  if (loading) return;
  error = null;
  loading = true;
  try {
    const content = await readFileForUpload(file);
    const res = await fetch(`${API_BASE}${API_UPLOAD}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: file.name, content }),
    });
    const data = await res.json();
    if (!res.ok) {
      error = data.message ?? "Failed to open file";
      return;
    }
    onClose();
  } catch (err) {
    console.error("FileOpenDialog: upload failed", err);
    if (err instanceof SyntaxError) {
      error = "Server returned an unexpected response";
    } else if (err instanceof TypeError) {
      error = "Unexpected response format";
    } else {
      error = "Cannot reach server. Is it running?";
    }
  } finally {
    loading = false;
  }
}

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) uploadFile(file);
}

function handleBrowse() {
  if (isTauriRuntime()) {
    void browseNative();
  } else {
    fileInputEl?.click();
  }
}
</script>

<div
  role="dialog"
  aria-modal="true"
  aria-label="Open File"
  tabindex={-1}
  style="position: fixed; inset: 0; z-index: var(--tandem-z-above-titlebar); display: flex; align-items: flex-start; justify-content: center; padding-top: 80px; background: color-mix(in srgb, var(--tandem-bg) 70%, transparent);"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") onClose();
  }}
>
  <div
    style="background: var(--tandem-surface); border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-5); box-shadow: var(--tandem-shadow-3); width: 440px; padding: 20px;"
    data-testid="file-open-dialog"
  >
    <div style="display: flex; justify-content: space-between; margin-bottom: 16px;">
      <h3 style="margin: 0; font-size: 15px; font-weight: 600; color: var(--tandem-fg);">
        Open File
      </h3>
      <button
        class="modal-close"
        onclick={onClose}
        aria-label="Close"
      >
        ×
      </button>
    </div>

    <!-- svelte-ignore a11y_autofocus -->
    <button
      autofocus
      onclick={handleBrowse}
      disabled={loading}
      type="button"
      style={`width: 100%; padding: 12px; font-size: 14px; font-weight: 500; border: none; border-radius: var(--tandem-r-2); cursor: ${loading ? "wait" : "pointer"}; background: ${loading ? "var(--tandem-fg-subtle)" : "var(--tandem-accent)"}; color: var(--tandem-accent-fg);`}
      data-testid="file-open-browse"
    >
      {loading ? "Opening…" : "Browse…"}
    </button>
    {#if !isTauriRuntime()}
      <input
        bind:this={fileInputEl}
        type="file"
        accept={acceptAttr}
        onchange={handleFileSelect}
        style="display: none;"
      />
    {/if}

    {#if isTauriRuntime()}
      <p
        style="margin: 8px 0 0; font-size: 11px; color: var(--tandem-fg-subtle); text-align: center;"
      >
        …or drop a file anywhere in the window
      </p>
    {/if}

    {#if recentFiles.length > 0}
      <div data-testid="recent-files-list" style="margin-top: 16px;">
        <div
          style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;"
        >
          <span
            style="font-size: 11px; color: var(--tandem-fg-subtle); text-transform: uppercase; letter-spacing: 0.05em;"
          >
            Recent
          </span>
          <button
            data-testid="clear-recent-files"
            onclick={handleClearRecent}
            type="button"
            style="background: none; border: none; color: var(--tandem-fg-subtle); font-size: 11px; cursor: pointer; padding: 0; text-decoration: underline;"
          >
            Clear all
          </button>
        </div>
        <div
          class="tandem-scroll-fade-y"
          use:scrollFade={"y"}
          style="max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;"
        >
          {#each recentFiles as p, i (p)}
            {@const parts = p.split(/[/\\]/)}
            {@const filename = parts.at(-1) ?? p}
            {@const dir = parts.slice(0, -1).join("/") || "/"}
            <button
              type="button"
              data-testid={`recent-file-${i}`}
              onclick={() => openByPath(p)}
              style="background: none; border: none; padding: 6px 8px; border-radius: var(--tandem-r-2); cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 1px;"
              onmouseenter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "var(--tandem-surface-muted)";
              }}
              onmouseleave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              }}
            >
              <span style="font-size: 13px; color: var(--tandem-fg);">{filename}</span>
              <span
                style="font-size: 11px; color: var(--tandem-fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px;"
              >
                {dir}
              </span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Saved sessions (#103): list persisted sessions with reopen / delete / clear-all -->
    <div data-testid="sessions-section" style="margin-top: 16px;">
      <button
        type="button"
        data-testid="sessions-toggle"
        bind:this={sessionsToggleEl}
        onclick={toggleSessions}
        aria-expanded={sessionsExpanded}
        style="width: 100%; background: none; border: none; padding: 0; cursor: pointer; display: flex; justify-content: space-between; align-items: center; color: var(--tandem-fg-subtle);"
      >
        <span style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
          Saved sessions
        </span>
        <span style="font-size: 11px;">{sessionsExpanded ? "▾" : "▸"}</span>
      </button>

      {#if sessionsExpanded}
        {#if sessionsLoading}
          <p
            data-testid="sessions-loading"
            style="margin: 8px 0 0; font-size: 12px; color: var(--tandem-fg-subtle);"
          >
            Loading…
          </p>
        {:else if sessions.length === 0}
          <p
            data-testid="sessions-empty"
            style="margin: 8px 0 0; font-size: 12px; color: var(--tandem-fg-subtle);"
          >
            No saved sessions.
          </p>
        {:else}
          <div
            style="display: flex; justify-content: flex-end; align-items: center; gap: 6px; margin: 6px 0;"
          >
            {#if clearAllArmed}
              <!-- #1773: Clear all keeps its OWN confirm rather than sharing the
                   row-level flag — one flag carrying a third value renders the
                   wrong wording against the wrong action. -->
              <span style="font-size: 11px; color: var(--tandem-fg);">
                Clear all {sessions.length} saved session{sessions.length === 1 ? "" : "s"}?
              </span>
              <button
                type="button"
                data-testid="sessions-clear-all-confirm"
                {@attach focusOnMount}
                onclick={async () => {
                  clearAllArmed = false;
                  await clearSessions();
                  parkFocusAfterConfirm();
                }}
                style={destructiveBtnStyle}
              >
                Clear all
              </button>
              <button
                type="button"
                data-testid="sessions-clear-all-cancel"
                onclick={() => {
                  clearAllArmed = false;
                  refocusOnDisarm = CLEAR_ALL_FOCUS_KEY;
                }}
                style={cancelBtnStyle}
              >
                Cancel
              </button>
            {:else}
              <button
                data-testid="sessions-clear-all"
                {@attach focusIfDisarmed(CLEAR_ALL_FOCUS_KEY)}
                onclick={() => {
                  clearAllArmed = true;
                  pendingDeletePath = null;
                }}
                type="button"
                style="background: none; border: none; color: var(--tandem-fg-subtle); font-size: 11px; cursor: pointer; padding: 0; text-decoration: underline;"
              >
                Clear all…
              </button>
            {/if}
          </div>
          <div
            class="tandem-scroll-fade-y"
            use:scrollFade={"y"}
            style="max-height: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;"
          >
            {#each sessions as session (session.filePath)}
              {@const parts = session.filePath.split(/[/\\]/)}
              {@const filename = parts.at(-1) ?? session.filePath}
              {@const dir = parts.slice(0, -1).join("/") || "/"}
              <div
                data-testid="session-row"
                style="display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: var(--tandem-r-2);"
              >
                <button
                  type="button"
                  data-testid="session-reopen"
                  onclick={() => openByPath(session.filePath)}
                  title={session.filePath}
                  style="flex: 1; min-width: 0; background: none; border: none; padding: 0; cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 1px;"
                >
                  <span style="font-size: 13px; color: var(--tandem-fg);">{filename}</span>
                  <span
                    style="font-size: 11px; color: var(--tandem-fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                  >
                    {dir}
                  </span>
                  <span style="font-size: 11px; color: var(--tandem-fg-subtle);">
                    {formatRelativeTime(session.lastAccessed)} · {session.annotationCount} annotation{session.annotationCount ===
                    1
                      ? ""
                      : "s"}
                  </span>
                </button>
                {#if pendingDeletePath === session.filePath}
                  <!-- #1773: the row's × swaps whole for this confirm pair, the
                       BulkActions shape. Focus moves by ATTACHMENT rather than a
                       bind:this + $effect: the rows live in a keyed {#each}, so
                       one shared bound ref would be nulled by the other row's
                       teardown. No aria-expanded either — the arm button leaves
                       the DOM at the moment it would go true. -->
                  <button
                    type="button"
                    data-testid="session-delete-confirm"
                    {@attach focusOnMount}
                    onclick={async () => {
                      pendingDeletePath = null;
                      await deleteSession(session.filePath);
                      parkFocusAfterConfirm();
                    }}
                    aria-label={`Confirm delete session for ${filename}`}
                    style={destructiveBtnStyle}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    data-testid="session-delete-cancel"
                    onclick={() => {
                      pendingDeletePath = null;
                      refocusOnDisarm = session.filePath;
                    }}
                    aria-label={`Cancel deleting session for ${filename}`}
                    style={cancelBtnStyle}
                  >
                    Cancel
                  </button>
                {:else}
                  <button
                    type="button"
                    data-testid="session-delete"
                    {@attach focusIfDisarmed(session.filePath)}
                    onclick={() => {
                      pendingDeletePath = session.filePath;
                      clearAllArmed = false;
                    }}
                    aria-label={`Delete session for ${filename}…`}
                    style="background: none; border: none; color: var(--tandem-fg-subtle); font-size: 14px; cursor: pointer; padding: 4px; line-height: 1;"
                  >
                    ×
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        {#if sessionsError}
          <div
            data-testid="sessions-error"
            style="margin-top: 8px; padding: 8px 10px; font-size: 12px; color: var(--tandem-error-fg-strong); background: var(--tandem-error-bg); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-error-border);"
          >
            {sessionsError}
          </div>
        {/if}
      {/if}
    </div>

    {#if error}
      <div
        style="margin-top: 10px; padding: 8px 10px; font-size: 12px; color: var(--tandem-error-fg-strong); background: var(--tandem-error-bg); border-radius: var(--tandem-r-2); border: 1px solid var(--tandem-error-border);"
        data-testid="file-open-error"
      >
        {error}
      </div>
    {/if}
  </div>
</div>

<style>
  /* Close button — mirrors SettingsModal.svelte's `.settings-modal-close` recipe
     so the modal family reads as one. Inline style cannot express :hover /
     :focus-visible. */
  .modal-close {
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--tandem-fg-subtle);
    font-size: 18px;
    line-height: 1;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    padding: 0;
    border-radius: var(--tandem-r-2);
  }
  .modal-close:hover,
  .modal-close:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface-sunk);
    outline: none;
  }
</style>
