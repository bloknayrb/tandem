<script lang="ts">
import { API_UPLOAD } from "../../shared/api-paths.js";
import { scrollFade } from "../actions/scrollFade.svelte.js";
import { isTauriRuntime } from "../cowork/cowork-helpers.js";
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

type Mode = "path" | "upload";

// #478: Default to "upload" (OS file picker) instead of "path"
let mode = $state<Mode>("upload");
let filePath = $state("");
let error = $state<string | null>(null);
let loading = $state(false);
let dragOver = $state(false);
let fileInputEl: HTMLInputElement | undefined = $state();
// Separate hidden input for the "Browse..." button (#378). The drop-zone input
// (`fileInputEl`) is wrapped inside the upload region and not in the DOM when
// `mode === "path"`, so the Browse button — which appears in path mode —
// needs its own input element to trigger the browser's native file picker.
let browseInputEl: HTMLInputElement | undefined = $state();
let recentFiles = $state<string[]>(loadRecentFiles());

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

function handlePathSubmit() {
  if (!filePath.trim()) return;
  openByPath(filePath.trim());
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

function handleFileDrop(e: DragEvent) {
  e.preventDefault();
  dragOver = false;
  const file = e.dataTransfer?.files[0];
  if (file) uploadFile(file);
}

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) uploadFile(file);
}

/**
 * #378 — "Browse..." button. In the Tauri desktop runtime we use the native
 * OS file picker via `@tauri-apps/plugin-dialog`, which returns the absolute
 * path on disk — we then POST it to `/api/open` (the same flow as the
 * path-paste input). In the browser we fall back to a hidden `<input
 * type="file">` and route the selected `File` through the existing upload
 * flow. Reference pattern: `pickFolder()` in `SettingsClaudeCodeTab.svelte`.
 */
async function pickFile() {
  if (loading) return;
  if (isTauriRuntime()) {
    error = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Supported", extensions: ["md", "txt", "docx", "html"] }],
      });
      if (typeof selected === "string") {
        void openByPath(selected);
      }
    } catch (err) {
      error = `File picker unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    // Browser path — reuse the existing hidden file input + upload flow.
    // Reset value so re-selecting the same file still fires `change`.
    error = null;
    if (browseInputEl) {
      browseInputEl.value = "";
      browseInputEl.click();
    }
  }
}
</script>

<div
  role="dialog"
  aria-modal="true"
  aria-label="Open File"
  tabindex={-1}
  style="position: fixed; inset: 0; z-index: 1000; display: flex; align-items: flex-start; justify-content: center; padding-top: 80px; background: rgba(0,0,0,0.3);"
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

    <!-- Mode toggle — #478: "Upload" renamed to "Open" -->
    <div style="display: flex; gap: 8px; margin-bottom: 16px;">
      <button
        onclick={() => (mode = "path")}
        style={`flex: 1; padding: 6px; font-size: 13px; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2); cursor: pointer; background: ${mode === "path" ? "var(--tandem-accent)" : "var(--tandem-surface)"}; color: ${mode === "path" ? "var(--tandem-accent-fg)" : "var(--tandem-fg)"};`}
      >
        File Path
      </button>
      <button
        onclick={() => (mode = "upload")}
        style={`flex: 1; padding: 6px; font-size: 13px; border: 1px solid var(--tandem-border); border-radius: var(--tandem-r-2); cursor: pointer; background: ${mode === "upload" ? "var(--tandem-accent)" : "var(--tandem-surface)"}; color: ${mode === "upload" ? "var(--tandem-accent-fg)" : "var(--tandem-fg)"};`}
      >
        Open
      </button>
    </div>

    {#if mode === "path"}
      <div>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          type="text"
          placeholder="Paste absolute file path..."
          bind:value={filePath}
          onkeydown={(e) => {
            if (e.key === "Enter") handlePathSubmit();
          }}
          style="width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); box-sizing: border-box; background: var(--tandem-surface); color: var(--tandem-fg);"
          data-testid="file-path-input"
        />
        <!-- #378 — Browse button. Hidden file input is used in the browser
             fallback (Tauri uses the native dialog instead). -->
        <input
          bind:this={browseInputEl}
          type="file"
          accept=".md,.txt,.html,.htm,.docx"
          onchange={handleFileSelect}
          style="display: none;"
        />
        <div style="display: flex; gap: 8px; margin-top: 10px;">
          <button
            onclick={handlePathSubmit}
            disabled={loading || !filePath.trim()}
            style={`flex: 1; padding: 8px; font-size: 13px; font-weight: 500; border: none; border-radius: var(--tandem-r-2); cursor: ${loading ? "wait" : "pointer"}; background: ${loading ? "var(--tandem-fg-subtle)" : "var(--tandem-accent)"}; color: var(--tandem-accent-fg); opacity: ${!filePath.trim() ? 0.5 : 1};`}
            data-testid="file-open-submit"
          >
            {loading ? "Opening..." : "Open"}
          </button>
          <button
            type="button"
            onclick={pickFile}
            disabled={loading}
            data-testid="file-browse-btn"
            style={`flex: 0 0 auto; padding: 8px 14px; font-size: 13px; font-weight: 500; border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-2); cursor: ${loading ? "wait" : "pointer"}; background: var(--tandem-surface); color: var(--tandem-fg);`}
          >
            Browse...
          </button>
        </div>

        <!-- Recent files -->
        {#if recentFiles.length > 0}
          <div data-testid="recent-files-list" style="margin-top: 14px;">
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
              style="max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;"
            >
              {#each recentFiles as p, i (p)}
                {@const parts = p.split(/[/\\]/)}
                {@const filename = parts.at(-1) ?? p}
                {@const dir = parts.slice(0, -1).join("/") || "/"}
                <button
                  type="button"
                  data-testid={`recent-file-${i}`}
                  onclick={() => {
                    filePath = p;
                    openByPath(p);
                  }}
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
      </div>
    {:else}
      <!-- #478: "Uploading..." renamed to "Opening..." -->
      <div
        role="button"
        tabindex={0}
        ondragover={(e) => {
          e.preventDefault();
          dragOver = true;
        }}
        ondragleave={() => (dragOver = false)}
        ondrop={handleFileDrop}
        onclick={() => fileInputEl?.click()}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") fileInputEl?.click();
        }}
        style={`border: 2px dashed ${dragOver ? "var(--tandem-accent)" : "var(--tandem-border-strong)"}; border-radius: var(--tandem-r-3); padding: 32px 16px; text-align: center; cursor: ${loading ? "wait" : "pointer"}; background: ${dragOver ? "var(--tandem-accent-bg)" : "var(--tandem-surface-muted)"}; transition: border-color 0.15s, background 0.15s;`}
        data-testid="file-upload-zone"
      >
        <input
          bind:this={fileInputEl}
          type="file"
          accept=".md,.txt,.html,.htm,.docx"
          onchange={handleFileSelect}
          style="display: none;"
        />
        <div style="font-size: 13px; color: var(--tandem-fg-muted);">
          {loading ? "Opening..." : "Drop a file here or click to browse"}
        </div>
        <div style="font-size: 11px; color: var(--tandem-fg-subtle); margin-top: 6px;">
          .md, .txt, .html, .docx
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
