# #519 — Solo Rail Hiding and Held-Count Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user is in Solo mode, automatically hide the side panel (and resize handles) unless they opted out. Surface held annotation count in StatusBar so they can switch back to Tandem.

**Architecture:** Add `soloRailHidden: boolean` (default `true`) to `TandemSettings`. In `App.svelte` derive `effectivePanelHidden` from mode + setting without touching stored layout state — panels restore on Solo exit. Wrap panel columns + resize handles in `{#if !effectivePanelHidden}` blocks. Add `heldCount`, `mode`, `onShowHeld` props to `StatusBar` and wire them. Add a toggle in settings UI.

**Tech Stack:** Svelte 5, TypeScript, Vitest

---

## Files changed

| File | Action |
|---|---|
| `src/client/hooks/useTandemSettings.ts` | Modify — add `soloRailHidden` to type, defaults, loadSettings |
| `src/client/App.svelte` | Modify — add `effectivePanelHidden` derived; wrap panel columns + handles |
| `src/client/status/StatusBar.svelte` | Modify — add `heldCount`, `mode`, `onShowHeld` props + `sb-held` button |
| `src/client/components/CoworkSettings.svelte` | Modify — add "Hide side panel in Solo mode" toggle |
| `tests/client/settings.test.ts` | Create or modify — `soloRailHidden` round-trip test |

---

### Task 1: Write failing tests for soloRailHidden in loadSettings

**Files:**
- Modify or create: `tests/client/settings.test.ts`

- [ ] **Step 1: Check whether a settings unit test file already exists**

```bash
ls tests/client/settings*
```

If `tests/client/settings.test.ts` exists, open it and add the tests below. If it does not, create it.

- [ ] **Step 2: Write failing tests**

If creating the file from scratch:

```ts
import { beforeEach } from "vitest";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../../src/client/hooks/useTandemSettings";

// localStorage mock
const store: Record<string, string> = {};
beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(
    (k) => store[k] ?? null,
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(
    (k, v) => { store[k] = v; },
  );
});

describe("soloRailHidden setting", () => {
  it("defaults to true when absent from storage", () => {
    const s = loadSettings();
    expect(s.soloRailHidden).toBe(true);
  });

  it("round-trips false correctly (persists explicit opt-out)", () => {
    store["tandem:settings"] = JSON.stringify({ soloRailHidden: false });
    const s = loadSettings();
    expect(s.soloRailHidden).toBe(false);
  });

  it("treats true stored value as true", () => {
    store["tandem:settings"] = JSON.stringify({ soloRailHidden: true });
    const s = loadSettings();
    expect(s.soloRailHidden).toBe(true);
  });
});
```

If the file already exists, add just the `describe("soloRailHidden setting", ...)` block (keeping any existing imports and setup).

- [ ] **Step 3: Run to confirm they fail**

```bash
npm test -- tests/client/settings.test.ts
```

Expected: all 3 new tests fail with `soloRailHidden is not a property` or similar.

---

### Task 2: Add soloRailHidden to useTandemSettings.ts

**Files:**
- Modify: `src/client/hooks/useTandemSettings.ts`

- [ ] **Step 1: Add soloRailHidden to TandemSettings interface**

In `TandemSettings` (line 17), add after `selectionToolbar: boolean;`:

```ts
  soloRailHidden: boolean;
```

- [ ] **Step 2: Add to DEFAULTS**

In `DEFAULTS` (line 49), add after `selectionToolbar: true,`:

```ts
  soloRailHidden: true,
```

- [ ] **Step 3: Add parse line to loadSettings**

In the `return { ... }` block of `loadSettings` (inside the `try` block, lines 90–145), add after the `selectionToolbar` parse line:

```ts
        selectionToolbar: parsed.selectionToolbar === false ? false : DEFAULTS.selectionToolbar,
        soloRailHidden: parsed.soloRailHidden === false ? false : DEFAULTS.soloRailHidden,
```

(Add after `selectionToolbar`, before the closing `};` of the return object.)

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- tests/client/settings.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors. If typecheck complains about missing `soloRailHidden` in `mergeAndClampSettings`, that function uses spread (`{ ...prev, ...partial }`) so no changes needed there.

---

### Task 3: Add effectivePanelHidden to App.svelte and wrap panels

**Files:**
- Modify: `src/client/App.svelte`

- [ ] **Step 1: Add the effectivePanelHidden derived value**

In `src/client/App.svelte`, after the `panelLayout` state declaration and its `$effect` block (around line 189), add:

```ts
const effectivePanelHidden = $derived(
  modeState.tandemMode === "solo" && settingsState.settings.soloRailHidden,
);
```

- [ ] **Step 2: Wrap three-panel left panel + handle**

In the three-panel layout arm (lines 293–338), the current structure is:

```svelte
{#if panelLayout.kind === "three-panel"}
  <div style="... left panel ...">
    ...
  </div>
  {@render resizeHandle("left", ...)}
```

Wrap both the left panel `<div>` and its resize handle call inside `{#if !effectivePanelHidden}`:

```svelte
{#if panelLayout.kind === "three-panel"}
  {#if !effectivePanelHidden}
    <div style="... left panel ...">
      ...
    </div>
    {@render resizeHandle("left", (e) => dragResize.handleResizeStart(e, "left"), undefined, panelLayout.left)}
  {/if}
```

- [ ] **Step 3: Wrap three-panel right panel + handle**

The three-panel right side (lines 346–395) currently reads:

```svelte
{#if panelLayout.kind === "three-panel"}
  {@render resizeHandle("right", ...)}
  <div style="... right panel ...">
    ...
  </div>
```

Wrap both inside `{#if !effectivePanelHidden}`:

```svelte
{#if panelLayout.kind === "three-panel"}
  {#if !effectivePanelHidden}
    {@render resizeHandle("right", (e) => dragResize.handleResizeStart(e, "right"), undefined, getRightWidth(panelLayout))}
    <div style="... right panel ...">
      ...
    </div>
  {/if}
```

- [ ] **Step 4: Wrap tabbed-left panel + handle**

Lines 339–341:

```svelte
{:else if panelLayout.kind === "tabbed-left"}
  {@render tabbedPanel(panelLayout.left, "left")}
  {@render resizeHandle("left", ...)}
```

Replace with:

```svelte
{:else if panelLayout.kind === "tabbed-left"}
  {#if !effectivePanelHidden}
    {@render tabbedPanel(panelLayout.left, "left")}
    {@render resizeHandle("left", (e) => dragResize.handleResizeStart(e, "left"), undefined, panelLayout.left)}
  {/if}
```

- [ ] **Step 5: Wrap tabbed right panel + handle**

Lines 392–394:

```svelte
{:else if panelLayout.kind === "tabbed"}
  {@render resizeHandle("right", ..., "panel-resize-handle", ...)}
  {@render tabbedPanel(getRightWidth(panelLayout), "right")}
```

Replace with:

```svelte
{:else if panelLayout.kind === "tabbed"}
  {#if !effectivePanelHidden}
    {@render resizeHandle("right", (e) => dragResize.handleResizeStart(e, "right"), "panel-resize-handle", getRightWidth(panelLayout))}
    {@render tabbedPanel(getRightWidth(panelLayout), "right")}
  {/if}
```

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

---

### Task 4: Write failing tests for StatusBar sb-held button

**Files:**
- Modify or create: `tests/client/statusbar.test.ts` (or add to existing)

- [ ] **Step 1: Check for existing StatusBar test file**

```bash
ls tests/client/statusbar* tests/client/status*
```

- [ ] **Step 2: Write failing tests**

Create `tests/client/statusbar.test.ts` if it doesn't exist:

```ts
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import StatusBar from "../../src/client/status/StatusBar.svelte";

// Minimal required props
const baseProps = {
  connected: true,
  connectionStatus: "connected" as const,
  reconnectAttempts: 0,
  disconnectedSince: null,
  claudeStatus: null,
  claudeActive: false,
};

describe("StatusBar held badge", () => {
  it("renders sb-held button when heldCount > 0 and mode === solo", () => {
    const { container } = render(StatusBar, {
      props: { ...baseProps, heldCount: 3, mode: "solo" },
    });
    expect(container.querySelector("[data-testid='sb-held']")).toBeTruthy();
    expect(container.querySelector("[data-testid='sb-held']")?.textContent).toContain("3");
  });

  it("does not render sb-held when heldCount > 0 and mode === tandem", () => {
    const { container } = render(StatusBar, {
      props: { ...baseProps, heldCount: 3, mode: "tandem" },
    });
    expect(container.querySelector("[data-testid='sb-held']")).toBeNull();
  });

  it("does not render sb-held when heldCount === 0 and mode === solo", () => {
    const { container } = render(StatusBar, {
      props: { ...baseProps, heldCount: 0, mode: "solo" },
    });
    expect(container.querySelector("[data-testid='sb-held']")).toBeNull();
  });

  it("calls onShowHeld when sb-held button is clicked", async () => {
    let called = false;
    const { container } = render(StatusBar, {
      props: { ...baseProps, heldCount: 2, mode: "solo", onShowHeld: () => { called = true; } },
    });
    const btn = container.querySelector("[data-testid='sb-held']") as HTMLButtonElement;
    btn.click();
    expect(called).toBe(true);
  });
});
```

- [ ] **Step 3: Run to confirm they fail**

```bash
npm test -- tests/client/statusbar.test.ts
```

Expected: fail — `heldCount` and `mode` are not yet props on StatusBar.

---

### Task 5: Add heldCount, mode, onShowHeld to StatusBar.svelte

**Files:**
- Modify: `src/client/status/StatusBar.svelte`

- [ ] **Step 1: Add props to the Props interface**

In `src/client/status/StatusBar.svelte`, the current Props interface ends with `saving?: boolean`. Add after it:

```ts
interface Props {
  connected: boolean;
  connectionStatus: ConnectionStatus;
  reconnectAttempts: number;
  disconnectedSince: number | null;
  claudeStatus: string | null;
  claudeActive: boolean;
  readOnly?: boolean;
  documentCount?: number;
  saving?: boolean;
  heldCount?: number;
  mode?: import("../../shared/types").TandemMode;
  onShowHeld?: () => void;
}
```

- [ ] **Step 2: Add to destructure**

In the destructure block (line 19), add:

```ts
let {
  connected,
  connectionStatus,
  reconnectAttempts,
  disconnectedSince,
  claudeStatus,
  claudeActive,
  readOnly,
  documentCount = 0,
  saving = false,
  heldCount,
  mode,
  onShowHeld,
}: Props = $props();
```

- [ ] **Step 3: Add sb-held button to the template**

In the StatusBar template, find the right-side section (the area that already has the "Review Only" badge and Claude status). Add the `sb-held` button before the "Review Only" badge:

```svelte
{#if (heldCount ?? 0) > 0 && mode === "solo"}
  <button
    data-testid="sb-held"
    onclick={onShowHeld}
    title="Show held annotations — switches to Tandem"
    style="display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; font-size: 11px; font-weight: 600; border: 1px solid var(--tandem-warning-border); border-radius: 9999px; background: var(--tandem-warning-bg); color: var(--tandem-warning-fg-strong); cursor: pointer;"
  >
    <span style="width: 6px; height: 6px; border-radius: 50%; background: var(--tandem-warning-fg-strong); display: inline-block;"></span>
    {heldCount} held
  </button>
{/if}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/client/statusbar.test.ts
```

Expected: all 4 tests pass.

---

### Task 6: Wire heldCount and mode into StatusBar from App.svelte

**Files:**
- Modify: `src/client/App.svelte`

- [ ] **Step 1: Add props to the StatusBar call**

The current StatusBar call in `App.svelte` (lines 398–408) reads:

```svelte
<StatusBar
  connected={yjsSync.connected}
  connectionStatus={yjsSync.connectionStatus}
  reconnectAttempts={yjsSync.reconnectAttempts}
  disconnectedSince={yjsSync.disconnectedSince}
  claudeStatus={yjsSync.claudeStatus}
  claudeActive={yjsSync.claudeActive}
  readOnly={yjsSync.readOnly}
  documentCount={yjsSync.tabs.length}
  saving={saveShortcut.saving}
/>
```

Replace with:

```svelte
<StatusBar
  connected={yjsSync.connected}
  connectionStatus={yjsSync.connectionStatus}
  reconnectAttempts={yjsSync.reconnectAttempts}
  disconnectedSince={yjsSync.disconnectedSince}
  claudeStatus={yjsSync.claudeStatus}
  claudeActive={yjsSync.claudeActive}
  readOnly={yjsSync.readOnly}
  documentCount={yjsSync.tabs.length}
  saving={saveShortcut.saving}
  heldCount={modeGate.heldCount}
  mode={modeState.tandemMode}
  onShowHeld={() => modeState.setTandemMode("tandem")}
/>
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

---

### Task 7: Add settings toggle in CoworkSettings.svelte

**Files:**
- Modify: `src/client/components/CoworkSettings.svelte`

The spec says to verify at implementation time whether `CoworkSettings.svelte` is the right host. Open the file and look for the section that deals with Solo mode settings or behavior toggles. The component receives settings via props — check what props it takes.

- [ ] **Step 1: Find the props interface**

```bash
grep -n "interface Props\|let {" src/client/components/CoworkSettings.svelte | head -10
```

- [ ] **Step 2: Confirm settings + onUpdate are available**

`CoworkSettings` likely receives `settings: TandemSettings` and `onUpdate: (partial: Partial<TandemSettings>) => void` as props (it's rendered from `SettingsPopover`). Confirm:

```bash
grep -n "settings\|onUpdate" src/client/components/CoworkSettings.svelte | head -10
```

If these props are present, continue. If not, find which settings component is the right host by searching:

```bash
grep -rn "CoworkSettings\|AccessibilitySettings" src/client/components/SettingsPopover.svelte | head -10
```

Open the correct component and add the toggle there instead.

- [ ] **Step 3: Add the toggle**

In the appropriate settings section (Solo/Cowork area), add a labeled checkbox toggle. Add after the existing Solo-related settings:

```svelte
<label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; color: var(--tandem-fg);">
  <input
    type="checkbox"
    checked={settings.soloRailHidden}
    onchange={(e) => onUpdate({ soloRailHidden: (e.target as HTMLInputElement).checked })}
  />
  Hide side panel in Solo mode
</label>
<p style={helpTextStyle}>When enabled, the annotation panel hides automatically when you enter Solo mode and restores when you return to Tandem.</p>
```

(`helpTextStyle` is already defined in the component at line 43.)

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

---

### Task 8: Final verification and commit

- [ ] **Step 1: Run all unit tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 2: Commit**

```bash
git add src/client/hooks/useTandemSettings.ts src/client/App.svelte src/client/status/StatusBar.svelte src/client/components/CoworkSettings.svelte tests/client/settings.test.ts tests/client/statusbar.test.ts
git commit -m "feat(#519): hide side panel in Solo mode; add held-count in StatusBar"
```
