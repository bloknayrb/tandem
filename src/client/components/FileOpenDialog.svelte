<script lang="ts">
import { API_UPLOAD } from "../../shared/api-paths.js";
import { SUPPORTED_EXTENSIONS } from "../../shared/constants.js";
import { scrollFade } from "../actions/scrollFade.svelte.js";
import { isTauriRuntime } from "../cowork/cowork-helpers";
import { API_BASE, readFileForUpload } from "../utils/fileUpload.js";
import {
  addRecentFile,
  clearRecentFiles,
  loadRecentFiles,
  saveRecentFiles,
} from "../utils/recentFiles.js";
import { openServerPath } from "../utils/server-paths.js";

interface Props {
  onClose: () => void;
}

const { onClose }: Props = $props();

let error = $state<string | null>(null);
let loading = $state(false);
let fileInputEl: HTMLInputElement | undefined = $state();
let recentFiles = $state<string[]>(loadRecentFiles());

const extensionList = Array.from(SUPPORTED_EXTENSIONS).sort();
const acceptAttr = extensionList.join(",");
const filterExtensions = extensionList.map((ext) => ext.replace(/^\./, ""));

function pushRecent(path: string) {
  recentFiles = (() => {
    const updated = addRecentFile(recentFiles, path);
    saveRecentFiles(updated);
    return updated;
  })();
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
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Open file in Tandem",
      filters: [{ name: "Documents", extensions: filterExtensions }],
    });
    if (typeof selected === "string") {
      await openByPath(selected);
    }
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
  style="position: fixed; inset: 0; z-index: var(--tandem-z-above-titlebar); display: flex; align-items: flex-start; justify-content: center; padding-top: 80px; background: rgba(0,0,0,0.3);"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") onClose();
  }}
>
  <div
    style="background: var(--tandem-surface); border-radius: var(--tandem-r-4); box-shadow: var(--tandem-shadow-3); width: 440px; padding: 20px;"
    data-testid="file-open-dialog"
  >
    <div style="display: flex; justify-content: space-between; margin-bottom: 16px;">
      <h3 style="margin: 0; font-size: 15px; font-weight: 600; color: var(--tandem-fg);">
        Open File
      </h3>
      <button
        onclick={onClose}
        style="background: none; border: none; cursor: pointer; font-size: 16px; color: var(--tandem-fg-subtle);"
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
