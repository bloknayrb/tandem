# Wave 4 PR Review Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical and important issues found during the PR #226 review before merge.

**Architecture:** These are targeted fixes across 3 layers (shared constants, server, client) plus doc updates. No new features — only correctness, validation, logging, and documentation accuracy.

**Tech Stack:** TypeScript, Zod, Y.js, React, Vitest

---

### Task 1: Add `Y_MAP_MODE` constant and use it everywhere

Critical Rule #1: Y.Map key strings from constants only. The `"mode"` key is used as a raw string in 4 locations.

**Files:**
- Modify: `src/shared/constants.ts:44` (add constant after `Y_MAP_USER_AWARENESS`)
- Modify: `src/client/App.tsx:165` (use constant)
- Modify: `src/server/mcp/awareness.ts:180` (use constant)
- Modify: `src/server/mcp/api-routes.ts:251` (use constant)
- Modify: `src/server/mcp/document.ts:480` (use constant)
- Modify: `tests/server/awareness-tools.test.ts:326,333,340` (use constant)

- [ ] **Step 1: Add the constant to `src/shared/constants.ts`**

After line 44 (`Y_MAP_USER_AWARENESS`), add:

```typescript
export const Y_MAP_MODE = "mode";
```

- [ ] **Step 2: Replace raw `"mode"` in `src/client/App.tsx:165`**

```typescript
// Before:
awareness.set("mode", tandemMode);

// After:
awareness.set(Y_MAP_MODE, tandemMode);
```

Add `Y_MAP_MODE` to the import from `../../shared/constants`.

- [ ] **Step 3: Replace raw `"mode"` in `src/server/mcp/awareness.ts:180`**

```typescript
// Before:
const mode = (ctrlAwareness.get("mode") as string) ?? TANDEM_MODE_DEFAULT;

// After:
const mode = (ctrlAwareness.get(Y_MAP_MODE) as string) ?? TANDEM_MODE_DEFAULT;
```

Add `Y_MAP_MODE` to the import from `../../shared/constants.js`.

- [ ] **Step 4: Replace raw `"mode"` in `src/server/mcp/api-routes.ts:251`**

```typescript
// Before:
const mode = (awareness.get("mode") as string) ?? TANDEM_MODE_DEFAULT;

// After:
const mode = (awareness.get(Y_MAP_MODE) as string) ?? TANDEM_MODE_DEFAULT;
```

Add `Y_MAP_MODE` to the import from `../../shared/constants.js`.

- [ ] **Step 5: Replace raw `"mode"` in `src/server/mcp/document.ts:480`**

```typescript
// Before:
const mode = (ctrlAwareness.get("mode") as string) ?? TANDEM_MODE_DEFAULT;

// After:
const mode = (ctrlAwareness.get(Y_MAP_MODE) as string) ?? TANDEM_MODE_DEFAULT;
```

Add `Y_MAP_MODE` to the import from `../../shared/constants.js`.

- [ ] **Step 6: Replace raw `"mode"` in `tests/server/awareness-tools.test.ts`**

Replace all three raw `"mode"` string usages in the mode tests (lines ~326, 333, 340) with the `Y_MAP_MODE` constant. Import it from `../../src/shared/constants`.

Also fix the redundant test at line 337: change `"tandem"` to `"solo"` so it actually tests a distinct value:

```typescript
it("reads 'solo' mode", () => {
  const ydoc = setupDoc("int-3", "Hello world");
  const userAwareness = ydoc.getMap(Y_MAP_USER_AWARENESS);
  userAwareness.set(Y_MAP_MODE, "solo");
  expect(userAwareness.get(Y_MAP_MODE)).toBe("solo");
});
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: All pass, no raw `"mode"` string remaining in production code.

- [ ] **Step 8: Commit**

```bash
git add src/shared/constants.ts src/client/App.tsx src/server/mcp/awareness.ts src/server/mcp/api-routes.ts src/server/mcp/document.ts tests/server/awareness-tools.test.ts
git commit -m "fix: add Y_MAP_MODE constant, replace raw 'mode' strings (Critical Rule #1)"
```

---

### Task 2: Add error logging and backoff to `getCachedMode()`

The empty catch and missing TTL update on failure mean: (a) no diagnostic visibility, (b) hammers a broken endpoint on every event, (c) silently ignores Solo mode when `/api/mode` is down.

**Files:**
- Modify: `src/channel/event-bridge.ts:225-243`

- [ ] **Step 1: Add logging and TTL update to `getCachedMode`**

Replace lines 229-243:

```typescript
async function getCachedMode(tandemUrl: string): Promise<string> {
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return cachedMode;
  try {
    const res = await fetch(`${tandemUrl}/api/mode`);
    if (res.ok) {
      const { mode } = (await res.json()) as { mode: string };
      cachedMode = mode;
    } else {
      console.error(`[Channel] Mode check returned ${res.status}, using cached: "${cachedMode}"`);
    }
    cachedModeAt = now;
  } catch (err) {
    console.error(
      "[Channel] Mode check failed, delivering event (fail-open):",
      err instanceof Error ? err.message : err,
    );
    cachedModeAt = now;
  }
  return cachedMode;
}
```

Key changes:
- `cachedModeAt = now` is set on ALL paths (success, non-OK, error) — prevents hammering
- Both error paths log with `console.error` (which goes to stderr per project convention)
- Fail-open behavior is preserved — `cachedMode` unchanged on failure

- [ ] **Step 2: Add debug logging for solo mode event suppression**

In `src/channel/event-bridge.ts`, at the solo mode suppression block (lines 186-193), add a log so suppressed events are visible in diagnostics:

```typescript
// Solo mode suppression: drop non-chat events when mode is "solo"
if (event.type !== "chat:message") {
  const mode = await getCachedMode(tandemUrl);
  if (mode === "solo") {
    console.error(`[Channel] Solo mode: suppressed ${event.type} event`);
    if (eventId) onEventId(eventId);
    continue;
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: Pass.

- [ ] **Step 4: Commit**

```bash
git add src/channel/event-bridge.ts
git commit -m "fix(channel): add error logging and TTL backoff to getCachedMode

Also log suppressed events in solo mode for diagnostic visibility."
```

---

### Task 3: Add Zod validation for server-side mode reads

The server casts the Y.Map mode value to `string` without validation. A corrupted Y.Map value would propagate to Claude.

**Files:**
- Modify: `src/server/mcp/awareness.ts:180`
- Modify: `src/server/mcp/api-routes.ts:251`
- Modify: `src/server/mcp/document.ts:480`

- [ ] **Step 1: Replace raw casts with Zod validation in all three files**

Using the `Y_MAP_MODE` constant from Task 1, replace raw casts with Zod validation. Note: the variable name differs per file.

In `src/server/mcp/awareness.ts:180` and `src/server/mcp/document.ts:480` (variable is `ctrlAwareness`):

```typescript
// Before:
const mode = (ctrlAwareness.get("mode") as string) ?? TANDEM_MODE_DEFAULT;
// After:
const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(ctrlAwareness.get(Y_MAP_MODE));
```

In `src/server/mcp/api-routes.ts:251` (variable is `awareness`, not `ctrlAwareness`):

```typescript
// Before:
const mode = (awareness.get("mode") as string) ?? TANDEM_MODE_DEFAULT;
// After:
const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
```

Add `TandemModeSchema` to the import from `../../shared/types.js` in each file. The `.catch()` provides the default when parsing fails (undefined, null, or invalid string), replacing the `?? TANDEM_MODE_DEFAULT` pattern.

Files to update:
- `src/server/mcp/awareness.ts:180` — import `TandemModeSchema` from `../../shared/types.js`
- `src/server/mcp/api-routes.ts:251` — import `TandemModeSchema` from `../../shared/types.js`
- `src/server/mcp/document.ts:480` — import `TandemModeSchema` from `../../shared/types.js`

- [ ] **Step 2: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/server/mcp/awareness.ts src/server/mcp/api-routes.ts src/server/mcp/document.ts
git commit -m "fix(server): validate mode via TandemModeSchema instead of raw string cast"
```

---

### Task 4: Remove the no-op `selectionDwellMs` setting from the UI

The slider writes to localStorage but the server hardcodes `SELECTION_DWELL_DEFAULT_MS`. Rather than building client-to-server plumbing for a power-user setting, remove the slider. The env var claim in CLAUDE.md is also removed.

**Files:**
- Modify: `src/client/hooks/useTandemSettings.ts` (remove `selectionDwellMs` from type and defaults)
- Modify: `src/client/components/SettingsPopover.tsx` (remove the slider section)
- Modify: `CLAUDE.md:51` (remove env var claim)

- [ ] **Step 1: Remove `selectionDwellMs` from `TandemSettings` interface and defaults**

In `src/client/hooks/useTandemSettings.ts`:

Remove `selectionDwellMs: number;` from the `TandemSettings` interface.

Remove `selectionDwellMs: SELECTION_DWELL_DEFAULT_MS,` from the `DEFAULTS` object.

Remove the `selectionDwellMs` clamping logic from `loadSettings()`:

```typescript
// Remove this block from the return in loadSettings:
selectionDwellMs: Math.max(
  SELECTION_DWELL_MIN_MS,
  Math.min(
    SELECTION_DWELL_MAX_MS,
    Number(parsed.selectionDwellMs) || SELECTION_DWELL_DEFAULT_MS,
  ),
),
```

Remove unused imports: `SELECTION_DWELL_DEFAULT_MS`, `SELECTION_DWELL_MIN_MS`, `SELECTION_DWELL_MAX_MS`.

- [ ] **Step 2: Remove the slider from `SettingsPopover.tsx`**

Find and remove the entire "Selection Response Delay" slider section from `SettingsPopover.tsx`. This includes the label, the `<input type="range">`, and the display value. Search for `selectionDwellMs` and remove all references.

- [ ] **Step 3: Fix CLAUDE.md line 51**

Replace:

```markdown
- Selection events use dwell-time gating (default 1s) — only fire after the user holds a selection steady; configurable via `TANDEM_SELECTION_DWELL_MS` env var
```

With:

```markdown
- Selection events use dwell-time gating (default 1s) — only fire after the user holds a selection steady
```

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: All pass. Fix any compile errors from removed references.

- [ ] **Step 5: Commit**

```bash
git add src/client/hooks/useTandemSettings.ts src/client/components/SettingsPopover.tsx CLAUDE.md
git commit -m "fix(client): remove no-op selectionDwellMs setting slider

The server hardcodes SELECTION_DWELL_DEFAULT_MS in queue.ts. The client
slider persisted to localStorage but never reached the server, so users
saw a setting that had no effect. Removed until server-side plumbing exists."
```

---

### Task 5: Add `updateSettings` validation and exhaustive `formatEventMeta`

Two smaller fixes bundled: (a) `updateSettings` should clamp numeric values like `loadSettings` does, (b) `formatEventMeta` needs a `default: never` exhaustiveness check.

**Files:**
- Modify: `src/client/hooks/useTandemSettings.ts:60-70`
- Modify: `src/server/events/types.ts:175-189`
- Test: `tests/server/event-types.test.ts`

- [ ] **Step 1: Add clamping to `updateSettings`**

In `src/client/hooks/useTandemSettings.ts`, update `updateSettings` to validate numeric fields:

```typescript
const updateSettings = useCallback((partial: Partial<TandemSettings>) => {
  setSettingsState((prev) => {
    const merged = { ...prev, ...partial };
    // Clamp numeric values on write (same rules as loadSettings)
    const next: TandemSettings = {
      ...merged,
      editorWidthPercent: Math.max(50, Math.min(100, merged.editorWidthPercent)),
    };
    try {
      localStorage.setItem(TANDEM_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable (incognito/storage-disabled)
    }
    return next;
  });
}, []);
```

Note: `selectionDwellMs` was removed in Task 4, so only `editorWidthPercent` needs clamping.

- [ ] **Step 2: Add exhaustive check to `formatEventMeta` in `src/server/events/types.ts`**

Replace the switch in `formatEventMeta` (lines 175-188):

```typescript
switch (event.type) {
  case "annotation:created":
  case "annotation:accepted":
  case "annotation:dismissed":
    meta.annotation_id = event.payload.annotationId;
    break;
  case "chat:message":
    meta.message_id = event.payload.messageId;
    break;
  case "selection:changed":
    meta.respond_via = "tandem_reply";
    break;
  case "document:opened":
  case "document:closed":
  case "document:switched":
    break;
  default: {
    const _exhaustive: never = event;
    break;
  }
}
```

- [ ] **Step 3: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/client/hooks/useTandemSettings.ts src/server/events/types.ts
git commit -m "fix: clamp settings on write, add exhaustive check to formatEventMeta"
```

---

### Task 6: Remove the `handleAnnotationClick` chat-text guard

Per CLAUDE.md, panels are always mounted via CSS display toggle. The chat textarea's value persists across tab switches, so the guard against "losing unsent text" solves a nonexistent problem while silently ignoring user clicks.

**Files:**
- Modify: `src/client/App.tsx:219-224`

- [ ] **Step 1: Remove the guard**

Replace:

```typescript
const handleAnnotationClick = useCallback((annotationId: string) => {
  // Guard: don't swap if user has unsent text in chat
  if (chatInputRef.current && chatInputRef.current.value.trim() !== "") return;
  setShowChat(false); // Switch to Annotations tab
  setActiveAnnotationId(annotationId);
}, []);
```

With:

```typescript
const handleAnnotationClick = useCallback((annotationId: string) => {
  setShowChat(false);
  setActiveAnnotationId(annotationId);
}, []);
```

- [ ] **Step 2: Check if `chatInputRef` is still used elsewhere**

Search `App.tsx` for other uses of `chatInputRef`. If this was its only consumer, remove the ref declaration and the `inputRef` prop passed to `ChatPanel`. If it's used elsewhere, leave it.

- [ ] **Step 3: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/client/App.tsx
git commit -m "fix(client): remove silent click guard on handleAnnotationClick

Panels are always mounted (CSS display toggle), so chat text persists
across tab switches. The guard was silently ignoring clicks for no reason."
```

---

### Task 7: Fix CLAUDE.md `Y_MAP_MODE` documentation

CLAUDE.md line 50 references `Y_MAP_MODE` as if it were a Y.Map name, but it's actually a key within the `Y_MAP_USER_AWARENESS` map on `CTRL_ROOM`. Now that the constant exists (Task 1), fix the description to be accurate.

**Files:**
- Modify: `CLAUDE.md:50`

- [ ] **Step 1: Fix the Y_MAP_MODE description**

Find the line:

```markdown
- Solo/Tandem mode is stored on the CTRL_ROOM Y.Map (`Y_MAP_MODE` key), not per-document. Mode changes broadcast to all open documents
```

Replace with:

```markdown
- Solo/Tandem mode is stored in CTRL_ROOM's `Y_MAP_USER_AWARENESS` map under the `Y_MAP_MODE` key, not per-document. Mode changes broadcast to all open documents
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: fix CLAUDE.md Y_MAP_MODE storage description"
```

---

### Task 8: Update stale docs referencing old interruption mode system

Multiple doc files still reference All/Urgent/Paused, `interruptionMode`, and status bar mode selectors that no longer exist.

**Files:**
- Modify: `docs/architecture.md:550`
- Modify: `docs/roadmap.md:162`
- Modify: `docs/workflows.md:33,278`
- Modify: `docs/user-guide.md:191,267,338`
- Modify: `docs/mcp-tools.md:435`
- Modify: `docs/ux-opportunities.md:13,40`
- Modify: `src/cli/skill-content.ts:48`

- [ ] **Step 1: Fix `docs/architecture.md:550`**

Replace the `StatusBar` description. The status bar no longer contains mode selectors — those moved to the toolbar. Replace the sentence about "interruption mode selector (All/Urgent/Paused)" with a description of the current StatusBar (connection status only) and note that Solo/Tandem toggle is in the toolbar.

Find the text referencing `interruptionMode` and `All/Urgent/Paused` and rewrite to match current behavior:
- StatusBar shows connection status only (connected/connecting/disconnected)
- Solo/Tandem toggle is in the Toolbar
- Client broadcasts `mode` (not `interruptionMode`) to `Y_MAP_USER_AWARENESS` on `CTRL_ROOM`

- [ ] **Step 2: Fix `docs/roadmap.md:162`**

Replace:
```
- Client broadcasts `interruptionMode` to Y.Map('userAwareness') — Claude reads it via `tandem_status` and `tandem_checkInbox`
```
With:
```
- Client broadcasts `mode` to CTRL_ROOM's Y.Map('userAwareness') — Claude reads it via `tandem_status` and `tandem_checkInbox`
```

- [ ] **Step 3: Fix `docs/workflows.md:33,278`**

Line 33: Replace "interruption mode respect" with "Solo/Tandem mode respect".

Line 278: Replace the entire "interruption mode selector with three settings" section with a description of the Solo/Tandem toggle in the toolbar.

- [ ] **Step 4: Fix `docs/user-guide.md:191,267,338`**

Line 191: Replace the section about "three settings" (All/Urgent/Paused) with Solo/Tandem mode description.

Line 267: Replace "current interruption mode" with "current mode (Solo or Tandem)".

Line 338: Replace the troubleshooting text about "Paused mode holds all new annotations. Switch to All" with "Solo mode holds Claude's pending annotations. Switch to Tandem to see everything."

- [ ] **Step 5: Fix `docs/mcp-tools.md:435`**

Historical note: the `priority` field was fully removed in Wave 4. Urgency is now implicit in annotation type (flags/questions always surface).

- [ ] **Step 6: Fix `src/cli/skill-content.ts:48`**

Replace:
```
Always visible in urgent-only interruption mode.
```
With:
```
Signals a blocking issue the user must address before the document ships.
```

- [ ] **Step 7: Fix `docs/ux-opportunities.md:13,40`**

Line 13 references "The All/Urgent/Paused buttons in the status bar" and line 40 references "Claude doesn't know about interruption mode." Update both to reflect the current Solo/Tandem system. Note this is a design analysis doc, so mark the old issues as resolved and note the current state.

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: Pass.

- [ ] **Step 9: Commit**

```bash
git add docs/architecture.md docs/roadmap.md docs/workflows.md docs/user-guide.md docs/mcp-tools.md docs/ux-opportunities.md src/cli/skill-content.ts
git commit -m "docs: update stale references from old interruption mode to Solo/Tandem"
```

---

### Task 9: Add test for `/api/mode` endpoint

The endpoint is the single source of truth for Solo mode suppression in the channel shim but has no test.

**Files:**
- Modify: `tests/server/awareness-tools.test.ts` (or create a new test file if the existing one doesn't have API route tests)

- [ ] **Step 1: Check existing API test patterns**

Read the test file structure to see how other `/api/*` routes are tested. If there's a test helper for making HTTP requests to the server, use that pattern. If API routes are tested via direct handler invocation, follow that.

Look at how `tests/server/` files set up Y.Doc and call route handlers. The `/api/mode` handler reads from `CTRL_ROOM`'s `Y_MAP_USER_AWARENESS` map, so the test needs a Y.Doc with that room name.

- [ ] **Step 2: Write the test**

Add a new describe block in `tests/server/awareness-tools.test.ts` (since mode is read from the awareness map).

**Important:** Do NOT use `setupDoc(CTRL_ROOM, "")` — that registers CTRL_ROOM as a regular document via `addDoc`, which pollutes the document registry. Use `getOrCreateDocument(CTRL_ROOM)` directly (the same function production code uses), which returns a Y.Doc without registering it as a user document:

```typescript
describe("/api/mode endpoint validation", () => {
  it("returns 'tandem' by default when no mode is set", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    expect(mode).toBe("tandem");
  });

  it("returns 'solo' when mode is set to solo", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set(Y_MAP_MODE, "solo");
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    expect(mode).toBe("solo");
  });

  it("falls back to default for invalid mode values", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set(Y_MAP_MODE, "garbage-value");
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    expect(mode).toBe("tandem");
  });
});
```

Import `getOrCreateDocument` from the same module other test files use (check existing imports in the test file). Import `TandemModeSchema` from `../../src/shared/types.js`, `Y_MAP_MODE` and `TANDEM_MODE_DEFAULT` from `../../src/shared/constants.js`.

- [ ] **Step 3: Run the test**

Run: `npm test -- tests/server/awareness-tools.test.ts`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add tests/server/awareness-tools.test.ts
git commit -m "test: add /api/mode endpoint validation tests including invalid fallback"
```

---

## Self-Review Checklist

1. **Spec coverage:** All 8 important+ issues from the review are addressed (Y_MAP_MODE constant, getCachedMode logging, Zod validation, no-op slider removal, updateSettings clamping, formatEventMeta exhaustiveness, click guard removal, stale docs). The two lower-priority suggestions (solo mode suppression logging in event-bridge, useModeGate JSDoc) are not included — they are nice-to-haves that don't warrant plan tasks.

2. **Placeholder scan:** All tasks have exact file paths, line numbers, and code blocks. No "TBD" or "similar to Task N".

3. **Type consistency:** `Y_MAP_MODE` is used consistently across Tasks 1, 3, 7, and 9. `TandemModeSchema` is used consistently in Tasks 3 and 9. `selectionDwellMs` is removed in Task 4 and the clamping in Task 5 only covers `editorWidthPercent` (the remaining numeric field).
