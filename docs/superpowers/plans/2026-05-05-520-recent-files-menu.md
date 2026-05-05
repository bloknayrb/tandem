# #520 — Recent Files Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking the `+` tab button opens a floating menu showing recently opened files. Selecting one opens it via `POST /api/open`. "Browse files…" falls through to the existing `FileOpenDialog`.

**Architecture:** Add a module-level cache (30s TTL) to `recentFiles.ts` and wrap `saveRecentFiles` to auto-invalidate. Create `RecentFilesMenu.svelte` as a self-contained floating menu. Modify `DocumentTabs.svelte` to toggle the menu on `+` click, render it below the button, and wire both open paths. The `+` button keeps its existing `data-testid="open-file-btn"` so existing E2E tests continue to work.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Playwright (E2E)

---

## Files changed

| File | Action |
|---|---|
| `src/client/utils/recentFiles.ts` | Modify — add cache + auto-invalidating saveRecentFiles |
| `src/client/tabs/RecentFilesMenu.svelte` | Create — floating recent files menu component |
| `src/client/tabs/DocumentTabs.svelte` | Modify — toggle menu on + click, wire open/browse |
| `tests/client/recent-files.test.ts` | Modify — add cache tests |

---

### Task 1: Write failing cache tests

**Files:**
- Modify: `tests/client/recent-files.test.ts`

The file already exists with 5 tests for `addRecentFile`. Add cache tests after them.

- [ ] **Step 1: Add tests**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
// ... existing imports and tests ...

describe("loadRecentFilesCached", () => {
  beforeEach(() => {
    // Ensure each test starts with a cold cache by importing the module fresh
    // or calling invalidateRecentFilesCache if available.
    vi.resetModules();
  });

  it("returns same array on second call within 30s (no localStorage re-read)", async () => {
    const { loadRecentFilesCached, invalidateRecentFilesCache, saveRecentFiles } = await import(
      "../../src/client/utils/recentFiles"
    );
    invalidateRecentFilesCache();

    // Seed one file
    saveRecentFiles(["/a/file.md"]);

    const first = loadRecentFilesCached();
    // Add a second file directly via localStorage to simulate external write
    saveRecentFiles(["/b/other.md", "/a/file.md"]);

    // Second call within TTL should return the cached (stale) result
    const second = loadRecentFilesCached();
    expect(second).toBe(first); // same reference = cache hit
  });

  it("re-reads localStorage after cache is manually invalidated", async () => {
    const { loadRecentFilesCached, invalidateRecentFilesCache, saveRecentFiles } = await import(
      "../../src/client/utils/recentFiles"
    );
    invalidateRecentFilesCache();

    saveRecentFiles(["/a/file.md"]);
    loadRecentFilesCached(); // warm cache

    saveRecentFiles(["/b/other.md", "/a/file.md"]);
    invalidateRecentFilesCache();

    const result = loadRecentFilesCached();
    expect(result[0]).toBe("/b/other.md"); // fresh read
  });

  it("saveRecentFiles auto-invalidates cache so next read is fresh", async () => {
    const { loadRecentFilesCached, invalidateRecentFilesCache, saveRecentFiles } = await import(
      "../../src/client/utils/recentFiles"
    );
    invalidateRecentFilesCache();

    saveRecentFiles(["/a/file.md"]);
    loadRecentFilesCached(); // warm cache

    // saveRecentFiles should bust the cache
    saveRecentFiles(["/new.md"]);
    const result = loadRecentFilesCached();
    expect(result[0]).toBe("/new.md");
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- tests/client/recent-files.test.ts
```

Expected: the 3 new tests fail with `loadRecentFilesCached is not a function` or similar.

---

### Task 2: Implement cache in recentFiles.ts

**Files:**
- Modify: `src/client/utils/recentFiles.ts`

- [ ] **Step 1: Add cache and the two new exports**

Replace the entire file with:

```ts
import { RECENT_FILES_CAP, RECENT_FILES_KEY } from "../../shared/constants.js";

/** Add a path to the recent files list. Deduplicates, caps at RECENT_FILES_CAP, most recent first. */
export function addRecentFile(list: string[], path: string, cap = RECENT_FILES_CAP): string[] {
  const filtered = list.filter((p) => p !== path);
  return [path, ...filtered].slice(0, cap);
}

export function loadRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FILES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch (err) {
    console.warn("[tandem] failed to load recent files:", err);
    return [];
  }
}

export function saveRecentFiles(list: string[]): void {
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(list));
    invalidateRecentFilesCache();
  } catch (err) {
    console.warn("[tandem] failed to save recent files:", err);
  }
}

export function clearRecentFiles(): void {
  try {
    localStorage.removeItem(RECENT_FILES_KEY);
    invalidateRecentFilesCache();
  } catch (err) {
    console.warn("[tandem] failed to clear recent files:", err);
  }
}

// ---------------------------------------------------------------------------
// Cache — avoids repeated localStorage reads when the menu opens repeatedly
// ---------------------------------------------------------------------------

const CACHE_TTL = 30_000;
let _cache: { files: string[]; ts: number } | null = null;

export function loadRecentFilesCached(): string[] {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL) return _cache.files;
  const files = loadRecentFiles();
  _cache = { files, ts: now };
  return files;
}

export function invalidateRecentFilesCache(): void {
  _cache = null;
}
```

- [ ] **Step 2: Run tests**

```bash
npm test -- tests/client/recent-files.test.ts
```

Expected: all tests pass (5 original + 3 new = 8 total).

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

---

### Task 3: Create RecentFilesMenu.svelte

**Files:**
- Create: `src/client/tabs/RecentFilesMenu.svelte`

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
import { path as tauriPath } from "@tauri-apps/api";

interface Props {
  recentFiles: string[];
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}

let { recentFiles, onOpen, onBrowse, onClose }: Props = $props();

function basename(p: string): string {
  // Works on both / and \ separators
  return p.replace(/[/\\]+$/, "").replace(/.*[/\\]/, "");
}

function extBadge(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md") return "M";
  if (ext === "docx" || ext === "doc") return "W";
  if (ext === "txt") return "T";
  if (ext === "html" || ext === "htm") return "H";
  return ext.slice(0, 1).toUpperCase() || "?";
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    onClose();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    const items = getFocusableItems();
    const idx = items.indexOf(document.activeElement as HTMLElement);
    items[(idx + 1) % items.length]?.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    const items = getFocusableItems();
    const idx = items.indexOf(document.activeElement as HTMLElement);
    items[(idx - 1 + items.length) % items.length]?.focus();
  }
}

function getFocusableItems(): HTMLElement[] {
  return Array.from(
    menuEl?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [],
  );
}

let menuEl: HTMLDivElement | null = $state(null);

$effect(() => {
  if (!menuEl) return;
  // Focus first item on open
  const items = getFocusableItems();
  items[0]?.focus();
});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={menuEl}
  role="menu"
  aria-label="Recent files"
  onkeydown={handleKeyDown}
  style="position: absolute; top: 100%; left: 0; margin-top: 4px; min-width: 260px; max-width: 400px; background: var(--tandem-surface); border: 1px solid var(--tandem-border); border-radius: 8px; box-shadow: 0 4px 16px color-mix(in srgb, var(--tandem-fg) 12%, transparent); z-index: 200; overflow: hidden;"
>
  <div style="padding: 6px 12px 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--tandem-fg-subtle);">
    Recent files
  </div>

  {#each recentFiles as filePath}
    <button
      role="menuitem"
      type="button"
      onclick={() => onOpen(filePath)}
      title={filePath}
      style="display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 12px; border: none; background: transparent; cursor: pointer; text-align: left; color: var(--tandem-fg); font-size: 13px;"
      onmouseenter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--tandem-surface-hover, var(--tandem-surface-muted))"; }}
      onmouseleave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
    >
      <span style="font-size: 10px; font-weight: 700; font-family: var(--tandem-font-mono); color: var(--tandem-fg-muted); min-width: 14px; text-align: center;">
        {extBadge(filePath)}
      </span>
      <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
        {basename(filePath)}
      </span>
    </button>
  {/each}

  {#if recentFiles.length > 0}
    <div style="height: 1px; background: var(--tandem-border); margin: 4px 0;"></div>
  {/if}

  <button
    role="menuitem"
    type="button"
    onclick={onBrowse}
    style="display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 12px 8px; border: none; background: transparent; cursor: pointer; text-align: left; color: var(--tandem-fg-muted); font-size: 13px;"
    onmouseenter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--tandem-surface-hover, var(--tandem-surface-muted))"; }}
    onmouseleave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
  >
    Browse files…
  </button>
</div>
```

Note: the `@tauri-apps/api` `path` import is not needed and can be removed — the `basename` function handles path parsing purely in JS. Remove that import line.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

---

### Task 4: Wire RecentFilesMenu into DocumentTabs.svelte

**Files:**
- Modify: `src/client/tabs/DocumentTabs.svelte`

- [ ] **Step 1: Add imports and state**

At the top of the `<script>` block in `DocumentTabs.svelte`, add the import:

```ts
import RecentFilesMenu from "./RecentFilesMenu.svelte";
import { loadRecentFilesCached, invalidateRecentFilesCache } from "../utils/recentFiles";
import { API_BASE } from "../utils/fileUpload";
```

Add state variables after the existing state (find where `showDialog` is declared):

```ts
let showRecent = $state(false);
let recentFiles = $state<string[]>([]);
let openBtnEl: HTMLButtonElement | null = $state(null);
```

- [ ] **Step 2: Add click-outside handler**

Add a `$effect` that closes the menu on pointer-down outside:

```ts
$effect(() => {
  if (!showRecent) return;

  function handlePointerDown(e: PointerEvent) {
    const target = e.target as Node | null;
    if (!target) return;
    // Don't close if click is inside the menu or the button itself
    if (openBtnEl?.contains(target)) return;
    // Don't close on Tauri drag-region clicks
    if ((target as Element).closest?.("[data-tauri-drag-region]")) return;
    showRecent = false;
  }

  window.addEventListener("pointerdown", handlePointerDown, true);
  return () => window.removeEventListener("pointerdown", handlePointerDown, true);
});
```

- [ ] **Step 3: Update the + button onclick**

The current + button at line 220 reads:

```svelte
<button
  onclick={() => (showDialog = true)}
  data-testid="open-file-btn"
  ...
>
```

Replace `onclick` with logic that toggles the recent-files menu (or falls through to dialog when list is empty):

```svelte
<button
  bind:this={openBtnEl}
  onclick={() => {
    const files = loadRecentFilesCached();
    if (files.length === 0) {
      showDialog = true;
    } else {
      recentFiles = files;
      showRecent = !showRecent;
    }
  }}
  data-testid="open-file-btn"
  ...
>
```

Keep all other attributes (title, style, onmouseenter, onmouseleave) unchanged.

- [ ] **Step 4: Render the menu below the button**

After the closing `>` of the `+` button (line 235) and before `{#if showDialog}`, add:

```svelte
{#if showRecent}
  <div style="position: relative;">
    <RecentFilesMenu
      {recentFiles}
      onOpen={async (filePath) => {
        showRecent = false;
        try {
          const res = await fetch(`${API_BASE}/open`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filePath }),
          });
          if (!res.ok) {
            const err = await res.text();
            console.warn("[tandem] failed to open recent file:", err);
          }
        } catch (err) {
          console.warn("[tandem] failed to open recent file:", err);
        }
      }}
      onBrowse={() => {
        showRecent = false;
        showDialog = true;
      }}
      onClose={() => (showRecent = false)}
    />
  </div>
{/if}
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors. If `API_BASE` is not exported from `fileUpload.ts`, check its actual export path:

```bash
grep -rn "export.*API_BASE\|API_BASE" src/client/utils/
```

Use whatever path exports it.

---

### Task 5: Run full test suite and commit

- [ ] **Step 1: Run all unit tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 2: Manual smoke test**

Start the dev server:

```bash
npm run dev:standalone
```

Open the browser at `http://localhost:5173`. Open a file, then open another. Click `+` — the recent files menu should appear with the previously opened files. Select one — it should open. Click `+` again and press Escape — menu should close. Click "Browse files…" — `FileOpenDialog` should appear.

If no recent files exist yet, clicking `+` should open `FileOpenDialog` directly (fallthrough path).

- [ ] **Step 3: Confirm existing open-file-btn E2E test still passes**

```bash
npm run test:e2e -- --grep "open-file-btn\|open file"
```

The existing test clicks `open-file-btn` and expects `FileOpenDialog` to appear. This still works because when no recent files are cached the button falls through directly to `showDialog = true`. If the test runs with a non-empty recent files list, it will see the menu instead — adjust the test to click "Browse files…" inside the menu, or clear localStorage before the test runs.

- [ ] **Step 4: Commit**

```bash
git add src/client/utils/recentFiles.ts src/client/tabs/RecentFilesMenu.svelte src/client/tabs/DocumentTabs.svelte tests/client/recent-files.test.ts
git commit -m "feat(#520): recent files menu on + tab button"
```
