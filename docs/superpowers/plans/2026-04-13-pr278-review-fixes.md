# PR #278 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all 5 findings from the PR #278 code review: extract duplicated test logic, add logging to silent catch blocks, strengthen test assertions, and add defensive error handling.

**Architecture:** Pure refactoring and test hardening — no behavioral changes. The cycling logic extraction is a move, not a rewrite. The catch-block logging follows the existing `console.warn('[tandem] ...')` convention used elsewhere in App.tsx.

**Tech Stack:** TypeScript, React, Vitest

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/client/hooks/useTabCycleKeyboard.ts` | Extract `cycleTab` as exported pure function |
| Modify | `tests/client/useTabCycleKeyboard.test.ts` | Import `cycleTab` from source instead of duplicating |
| Modify | `src/client/utils/recentFiles.ts` | Add `console.warn` to three empty catch blocks |
| Modify | `src/client/App.tsx` | Wrap recent-files useEffect body in try-catch |
| Modify | `tests/server/document-service.test.ts` | Add saveSession-not-called + deleteSession-rejection tests |

---

### Task 1: Extract `cycleTab` from hook, import in test

**Files:**
- Modify: `src/client/hooks/useTabCycleKeyboard.ts:17-29`
- Modify: `tests/client/useTabCycleKeyboard.test.ts:1-18`

- [ ] **Step 1: Extract the pure function in the hook module**

In `src/client/hooks/useTabCycleKeyboard.ts`, extract the index arithmetic into an exported function above the hook. The hook's handler calls it instead of inlining the math.

```typescript
import { useEffect, useRef } from "react";

/** Pure cycling logic — exported for direct testing. */
export function cycleTab(
  tabs: Array<{ id: string }>,
  activeTabId: string | null,
  shiftKey: boolean,
): string | null {
  if (tabs.length < 2) return null;
  const currentIdx = tabs.findIndex((t) => t.id === activeTabId);
  const direction = shiftKey ? -1 : 1;
  const nextIdx = (currentIdx + direction + tabs.length) % tabs.length;
  return tabs[nextIdx].id;
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab to cycle through document tabs.
 * Registers a single listener on mount; refs avoid churn on every tab switch.
 */
export function useTabCycleKeyboard(
  orderedTabs: Array<{ id: string }>,
  activeTabId: string | null,
  setActiveTabId: (id: string) => void,
): void {
  const tabsRef = useRef(orderedTabs);
  tabsRef.current = orderedTabs;
  const activeRef = useRef(activeTabId);
  activeRef.current = activeTabId;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key !== "Tab") return;

      const nextId = cycleTab(tabsRef.current, activeRef.current, e.shiftKey);
      if (!nextId) return;

      e.preventDefault();
      setActiveTabId(nextId);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setActiveTabId]);
}
```

- [ ] **Step 2: Update the test to import from source**

Replace the duplicated function in `tests/client/useTabCycleKeyboard.test.ts` with an import:

```typescript
import { describe, expect, it } from "vitest";
import { cycleTab } from "../../src/client/hooks/useTabCycleKeyboard.js";

const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("cycleTab", () => {
  it("cycles forward from first tab", () => {
    expect(cycleTab(tabs, "a", false)).toBe("b");
  });

  it("cycles forward from last tab wraps to first", () => {
    expect(cycleTab(tabs, "c", false)).toBe("a");
  });

  it("cycles backward from first tab wraps to last", () => {
    expect(cycleTab(tabs, "a", true)).toBe("c");
  });

  it("cycles backward from middle tab", () => {
    expect(cycleTab(tabs, "b", true)).toBe("a");
  });

  it("returns null with fewer than 2 tabs", () => {
    expect(cycleTab([{ id: "only" }], "only", false)).toBeNull();
  });

  it("returns null with zero tabs", () => {
    expect(cycleTab([], null, false)).toBeNull();
  });

  it("handles unknown activeTabId by cycling from index -1", () => {
    // findIndex returns -1, so (-1 + 1 + 3) % 3 = 0 → first tab
    expect(cycleTab(tabs, "unknown", false)).toBe("a");
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/client/useTabCycleKeyboard.test.ts`
Expected: 7 tests PASS (the 6 originals + new zero-tabs case)

- [ ] **Step 4: Commit**

```bash
git add src/client/hooks/useTabCycleKeyboard.ts tests/client/useTabCycleKeyboard.test.ts
git commit -m "refactor(tabs): extract cycleTab as exported pure function

Test now imports the production function instead of duplicating logic.
Added zero-tabs edge case."
```

---

### Task 2: Add `console.warn` to `recentFiles.ts` catch blocks

**Files:**
- Modify: `src/client/utils/recentFiles.ts:16,24-26,32-34`

- [ ] **Step 1: Add logging to all three catch blocks**

In `src/client/utils/recentFiles.ts`, replace the three bare `catch` blocks:

```typescript
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
  } catch (err) {
    console.warn("[tandem] failed to save recent files:", err);
  }
}

export function clearRecentFiles(): void {
  try {
    localStorage.removeItem(RECENT_FILES_KEY);
  } catch (err) {
    console.warn("[tandem] failed to clear recent files:", err);
  }
}
```

- [ ] **Step 2: Run tests to confirm no regressions**

Run: `npx vitest run tests/client/`
Expected: All client tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/client/utils/recentFiles.ts
git commit -m "fix(client): add console.warn to recentFiles.ts catch blocks

Matches the logging convention used in App.tsx localStorage access.
Empty catches hid JSON.parse errors and storage failures."
```

---

### Task 3: Wrap App.tsx recent-files useEffect in try-catch

**Files:**
- Modify: `src/client/App.tsx:175-188`

- [ ] **Step 1: Add try-catch wrapper**

In `src/client/App.tsx`, wrap the recent-files useEffect body to match the pattern at lines 192-200:

```typescript
  // Sync open tabs into the recent files list so files opened by Claude also appear.
  // Dep is tabs.length (not tabs) to avoid spurious fires from array identity changes.
  useEffect(() => {
    if (tabs.length === 0) return;
    try {
      const before = loadRecentFiles();
      let recent = before;
      for (const tab of tabs) {
        if (!tab.filePath.startsWith("upload://")) {
          recent = addRecentFile(recent, tab.filePath);
        }
      }
      if (recent.length !== before.length || recent.some((p, i) => p !== before[i])) {
        saveRecentFiles(recent);
      }
    } catch (err) {
      console.warn("[tandem] failed to sync recent files:", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length]);
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/client/`
Expected: All client tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/client/App.tsx
git commit -m "fix(client): add try-catch to recent-files sync useEffect

Consistent with all other localStorage access in App.tsx."
```

---

### Task 4: Strengthen document-service close tests

**Files:**
- Modify: `tests/server/document-service.test.ts:359-366`

- [ ] **Step 1: Add saveSession-not-called assertion to existing test**

In `tests/server/document-service.test.ts`, modify the "deletes the session file on close" test to also assert that `saveSession` was not called. This guards against regression to the exact bug the PR fixes:

```typescript
  it("deletes the session file on close", async () => {
    const { deleteSession, saveSession } = await import(
      "../../src/server/session/manager.js"
    );
    vi.mocked(saveSession).mockClear();
    addDoc("del-session", makeOpenDoc("del-session", "/tmp/del.md"));
    setActiveDocId("del-session");

    await closeDocumentById("del-session");
    expect(deleteSession).toHaveBeenCalledWith("/tmp/del.md");
    expect(saveSession).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Add deleteSession-rejection test**

Add a new test after the existing one that verifies close still succeeds when `deleteSession` rejects:

```typescript
  it("succeeds even when deleteSession rejects", async () => {
    const { deleteSession } = await import("../../src/server/session/manager.js");
    vi.mocked(deleteSession).mockClear();
    vi.mocked(deleteSession).mockRejectedValueOnce(new Error("EPERM"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    addDoc("fail-del", makeOpenDoc("fail-del", "/tmp/fail.md"));
    setActiveDocId("fail-del");

    const result = await closeDocumentById("fail-del");
    expect(result.success).toBe(true);
    expect(hasDoc("fail-del")).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete session"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/server/document-service.test.ts`
Expected: All tests pass, including the 2 modified/new ones.

- [ ] **Step 4: Commit**

```bash
git add tests/server/document-service.test.ts
git commit -m "test(server): strengthen closeDocumentById session tests

Assert saveSession is NOT called on close (guards against regression).
Assert close succeeds even when deleteSession rejects (defense-in-depth)."
```

---

### Task 5: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All 1014+ tests pass (1012 existing + 2 new).

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors.
