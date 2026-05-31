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
let sessionsError = $state<string | null>(null);

async function loadSessions() {
  sessionsLoading = true;
  sessionsError = null;
  const result = await fetchSessions();
  if (result.ok) {
    sessions = result.data;
  } else {
    sessionsError = result.error;
  }
  sessionsLoading = false;
}

function toggleSessions() {
  sessionsExpanded = !sessionsExpanded;
  if (sessionsExpanded && sessions.length === 0 && !sessionsLoading) {
    void loadSessions();
  }
}

async function deleteSession(filePath: string) {
  const result = await deleteSessionByPath(filePath);
  if (result.ok) {
    sessions = sessions.filter((s) => s.filePath !== filePath);
  } else {
    sessionsError = result.error;
  }
}

async function clearSessions() {
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
          <div style="display: flex; justify-content: flex-end; margin: 6px 0;">
            <button
              data-testid="sessions-clear-all"
              onclick={clearSessions}
              type="button"
              style="background: none; border: none; color: var(--tandem-fg-subtle); font-size: 11px; cursor: pointer; padding: 0; text-decoration: underline;"
            >
              Clear all
            </button>
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
                <button
                  type="button"
                  data-testid="session-delete"
                  onclick={() => deleteSession(session.filePath)}
                  aria-label={`Delete session for ${filename}`}
                  style="background: none; border: none; color: var(--tandem-fg-subtle); font-size: 14px; cursor: pointer; padding: 4px; line-height: 1;"
                >
                  ×
                </button>
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
