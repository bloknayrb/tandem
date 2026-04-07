# Wave 4: Notification, Interruption & Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-state interruption system with Solo/Tandem toggle, add dwell-time selection events, configurable layout, click-to-navigate annotations, and skill-directed response routing.

**Architecture:** Six independent tasks that can be implemented sequentially. The shared types/constants task lands first (Task 1), then Solo/Tandem mode (Task 2), dwell-time selection (Task 3), click-to-navigate (Task 4), configurable layout (Task 5), and finally the skill update + cleanup (Task 6). Each task produces a working, testable state.

**Tech Stack:** React (inline styles), Y.js CRDTs, Tiptap/ProseMirror, Vitest, TypeScript

---

### Task 1: Shared Types & Constants

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`
- Test: `tests/client/solo-tandem-mode.test.ts`

- [ ] **Step 1: Write failing test for new TandemMode type and shouldShowInMode function**

```typescript
// tests/client/solo-tandem-mode.test.ts
import { describe, it, expect } from "vitest";
import { shouldShowInMode } from "../../src/client/hooks/useModeGate.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

describe("shouldShowInMode", () => {
  describe('mode = "tandem"', () => {
    it("shows all pending annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ status: "pending" }), "tandem")).toBe(true);
    });
    it("shows accepted annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ status: "accepted" }), "tandem")).toBe(true);
    });
    it("shows dismissed annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ status: "dismissed" }), "tandem")).toBe(true);
    });
  });

  describe('mode = "solo"', () => {
    it("hides pending claude annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ status: "pending", author: "claude" }), "solo")).toBe(false);
    });
    it("shows pending user annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ status: "pending", author: "user" }), "solo")).toBe(true);
    });
    it("shows accepted annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ status: "accepted", author: "claude" }), "solo")).toBe(true);
    });
    it("shows dismissed annotations", () => {
      expect(shouldShowInMode(makeAnnotation({ status: "dismissed", author: "claude" }), "solo")).toBe(true);
    });
  });
});

describe("gateModeAnnotations", () => {
  it("holds claude pending in solo, counts them", () => {
    const anns = [
      makeAnnotation({ id: "a1", status: "pending", author: "claude" }),
      makeAnnotation({ id: "a2", status: "pending", author: "user" }),
      makeAnnotation({ id: "a3", status: "accepted", author: "claude" }),
    ];
    const { shouldShowInMode: show } = await import("../../src/client/hooks/useModeGate.js");
    const visible = anns.filter(a => show(a, "solo"));
    const held = anns.filter(a => !show(a, "solo") && a.status === "pending");
    expect(visible).toHaveLength(2);
    expect(held).toHaveLength(1);
  });

  it("shows everything in tandem mode", () => {
    const anns = [
      makeAnnotation({ id: "a1", status: "pending", author: "claude" }),
      makeAnnotation({ id: "a2", status: "pending", author: "user" }),
    ];
    const visible = anns.filter(a => shouldShowInMode(a, "tandem"));
    expect(visible).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/client/solo-tandem-mode.test.ts`
Expected: FAIL — `useModeGate` module not found

- [ ] **Step 3: Add TandemMode type and constants**

In `src/shared/types.ts`, add after line 28 (after `AnnotationActionSchema`):

```typescript
export const TandemModeSchema = z.enum(["solo", "tandem"]);
export type TandemMode = z.infer<typeof TandemModeSchema>;
```

Remove line 26:
```typescript
// DELETE: export const InterruptionModeSchema = z.enum(["all", "urgent-only", "paused"]);
```

Remove line 49:
```typescript
// DELETE: export type InterruptionMode = z.infer<typeof InterruptionModeSchema>;
```

In `src/shared/constants.ts`, replace lines 24-25:

```typescript
// DELETE these two lines:
// export const INTERRUPTION_MODE_DEFAULT = "all" as const;
// export const INTERRUPTION_MODE_KEY = "tandem:interruptionMode";

// ADD:
export const TANDEM_MODE_DEFAULT = "tandem" as const;
export const TANDEM_MODE_KEY = "tandem:mode";
export const TANDEM_SETTINGS_KEY = "tandem:settings";
export const SELECTION_DWELL_DEFAULT_MS = 1000;
export const SELECTION_DWELL_MIN_MS = 500;
export const SELECTION_DWELL_MAX_MS = 3000;
```

- [ ] **Step 4: Create useModeGate hook**

```typescript
// src/client/hooks/useModeGate.ts
import { useMemo } from "react";
import type { Annotation, TandemMode } from "../../shared/types";

/**
 * Should an annotation be shown given the current mode?
 * Solo mode hides pending Claude annotations. Everything else is visible.
 */
export function shouldShowInMode(ann: Annotation, mode: TandemMode): boolean {
  if (ann.status !== "pending") return true;
  if (mode === "tandem") return true;
  // Solo: only show user-authored pending annotations
  return ann.author !== "claude";
}

export function useModeGate(annotations: Annotation[], mode: TandemMode) {
  return useMemo(() => {
    const visibleAnnotations: Annotation[] = [];
    let heldCount = 0;
    for (const a of annotations) {
      if (shouldShowInMode(a, mode)) {
        visibleAnnotations.push(a);
      } else if (a.status === "pending") {
        heldCount++;
      }
    }
    return { visibleAnnotations, heldCount };
  }, [annotations, mode]);
}
```

- [ ] **Step 5: Fix test import and run tests**

Update the test file to use static imports (remove the dynamic import):

```typescript
// Fix the gateModeAnnotations test — use static import
import { shouldShowInMode } from "../../src/client/hooks/useModeGate.js";
```

Run: `npm test -- tests/client/solo-tandem-mode.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts src/client/hooks/useModeGate.ts tests/client/solo-tandem-mode.test.ts
git commit -m "feat: add TandemMode type, useModeGate hook, and new constants

Replaces InterruptionMode (all/urgent-only/paused) with TandemMode (solo/tandem).
Solo mode hides pending Claude annotations; tandem shows everything.

Closes #207 (partial)"
```

---

### Task 2: Solo/Tandem Toggle in Status Bar & App Integration

**Files:**
- Modify: `src/client/status/StatusBar.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/panels/SidePanel.tsx`
- Modify: `src/server/mcp/document.ts:468-500`
- Modify: `src/server/mcp/awareness.ts:179-219`
- Delete: `src/client/hooks/useAnnotationGate.ts`
- Delete: `tests/client/annotation-gate.test.ts`

- [ ] **Step 1: Update StatusBar — replace MODES with Solo/Tandem toggle**

Replace the `StatusBarProps` interface (lines 6-20) and `MODES` array (lines 22-30) in `src/client/status/StatusBar.tsx`:

```typescript
import type { TandemMode, WidthMode } from "../../shared/types";

interface StatusBarProps {
  connected: boolean;
  connectionStatus: ConnectionStatus;
  reconnectAttempts: number;
  disconnectedSince: number | null;
  claudeStatus: string | null;
  claudeActive: boolean;
  readOnly?: boolean;
  documentCount?: number;
  tandemMode: TandemMode;
  onModeChange: (mode: TandemMode) => void;
  heldCount: number;
  widthMode: WidthMode;
  onToggleWidthMode: () => void;
}
```

Replace the mode switcher JSX (lines 150-193) with:

```tsx
{/* Solo/Tandem mode toggle */}
<div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
  {heldCount > 0 && (
    <span
      style={{
        padding: "1px 6px",
        fontSize: "10px",
        fontWeight: 600,
        color: "#92400e",
        background: "#fef3c7",
        borderRadius: "9999px",
      }}
    >
      {heldCount} held
    </span>
  )}
  <div
    style={{
      display: "flex",
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      overflow: "hidden",
    }}
  >
    <button
      title="Write undisturbed — Claude only responds when you message"
      onClick={() => onModeChange("solo")}
      style={{
        padding: "1px 8px",
        fontSize: "11px",
        border: "none",
        cursor: "pointer",
        background: tandemMode === "solo" ? "#6366f1" : "transparent",
        color: tandemMode === "solo" ? "#fff" : "#6b7280",
        fontWeight: tandemMode === "solo" ? 600 : 400,
        borderRight: "1px solid #d1d5db",
      }}
    >
      Solo
    </button>
    <button
      title="Full collaboration — Claude reacts to selections and document changes"
      onClick={() => onModeChange("tandem")}
      style={{
        padding: "1px 8px",
        fontSize: "11px",
        border: "none",
        cursor: "pointer",
        background: tandemMode === "tandem" ? "#6366f1" : "transparent",
        color: tandemMode === "tandem" ? "#fff" : "#6b7280",
        fontWeight: tandemMode === "tandem" ? 600 : 400,
      }}
    >
      Tandem
    </button>
  </div>
  <span
    style={{
      width: "7px",
      height: "7px",
      borderRadius: "50%",
      background: tandemMode === "tandem" ? "#22c55e" : "#9ca3af",
      display: "inline-block",
    }}
  />
  <span style={{ fontSize: "11px", color: "#6b7280" }}>
    {tandemMode === "tandem" ? "Claude is active" : "Claude is listening"}
  </span>
</div>
```

Update the component function signature to destructure `tandemMode` and `onModeChange` (replacing `interruptionMode`).

- [ ] **Step 2: Update App.tsx — replace InterruptionMode with TandemMode**

In `src/client/App.tsx`:

Replace imports (lines 14-26): change `InterruptionMode` → `TandemMode`, `InterruptionModeSchema` → `TandemModeSchema`, `INTERRUPTION_MODE_DEFAULT` → `TANDEM_MODE_DEFAULT`, `INTERRUPTION_MODE_KEY` → `TANDEM_MODE_KEY`. Remove `useAnnotationGate` import, add `useModeGate` import.

Replace the interruptionMode state block (lines 143-168):

```typescript
// Solo/Tandem mode — persisted to localStorage, broadcast to CTRL_ROOM
const [tandemMode, setTandemMode] = useState<TandemMode>(() => {
  try {
    const saved = localStorage.getItem(TANDEM_MODE_KEY);
    return TandemModeSchema.safeParse(saved).success
      ? (saved as TandemMode)
      : TANDEM_MODE_DEFAULT;
  } catch {
    return TANDEM_MODE_DEFAULT;
  }
});
useEffect(() => {
  try {
    localStorage.setItem(TANDEM_MODE_KEY, tandemMode);
  } catch {}
}, [tandemMode]);

// Broadcast mode to CTRL_ROOM Y.Map (global, not per-document)
useEffect(() => {
  if (!bootstrapYdoc) return;
  const awareness = bootstrapYdoc.getMap(Y_MAP_USER_AWARENESS);
  awareness.set("mode", tandemMode);
  // Clean up orphan key from old interruption mode system
  awareness.delete("interruptionMode");
}, [tandemMode, bootstrapYdoc]);
```

Replace the useAnnotationGate call (line 189):

```typescript
const { visibleAnnotations, heldCount } = useModeGate(annotations, tandemMode);
```

Update StatusBar props (lines 542-556): replace `interruptionMode={interruptionMode}` with `tandemMode={tandemMode}`, `onModeChange={setInterruptionMode}` with `onModeChange={setTandemMode}`.

Update SidePanel props (lines 524-538): replace `interruptionMode={interruptionMode}` and `onModeChange={setInterruptionMode}` with `tandemMode={tandemMode}` and `onModeChange={setTandemMode}`.

- [ ] **Step 3: Update SidePanel props**

In `src/client/panels/SidePanel.tsx`, update the interface (lines 12-26):

Replace `interruptionMode?: InterruptionMode` with `tandemMode?: TandemMode` and `onModeChange?: (mode: InterruptionMode) => void` with `onModeChange?: (mode: TandemMode) => void`. Update the import from `InterruptionMode` to `TandemMode`.

Search the SidePanel file for any usage of `interruptionMode` and replace with `tandemMode`.

- [ ] **Step 4: Update server MCP tools — tandem_status and tandem_checkInbox**

In `src/server/mcp/document.ts` (lines 468-500), replace the interruptionMode reading block:

```typescript
// Read the user's mode from CTRL_ROOM Y.Map
const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
const ctrlAwareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
const mode = (ctrlAwareness.get("mode") as string) ?? TANDEM_MODE_DEFAULT;
```

And in the return object, replace `interruptionMode` with `mode`.

Update imports: replace `INTERRUPTION_MODE_DEFAULT` with `TANDEM_MODE_DEFAULT`, add `CTRL_ROOM` if not already imported.

In `src/server/mcp/awareness.ts` (lines 179-180), replace:

```typescript
const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
const ctrlAwareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
const mode = (ctrlAwareness.get("mode") as string) ?? TANDEM_MODE_DEFAULT;
```

And in the return object (line 219), replace `interruptionMode` with `mode`.

Update imports similarly.

- [ ] **Step 5: Delete old files**

```bash
rm src/client/hooks/useAnnotationGate.ts
rm tests/client/annotation-gate.test.ts
```

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: All tests pass (some may need import updates if they reference InterruptionMode)

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: No errors. Fix any remaining references to `InterruptionMode`, `interruptionMode`, `INTERRUPTION_MODE_DEFAULT`, or `INTERRUPTION_MODE_KEY`.

- [ ] **Step 8: Manual browser test**

Start `npm run dev:standalone`. Open Chrome to localhost:5173. Verify:
- Status bar shows Solo/Tandem toggle (not All/Urgent/Paused)
- Clicking Solo shows grey dot + "Claude is listening"
- Clicking Tandem shows green dot + "Claude is active"
- Tooltips appear on hover
- Mode persists across page refresh

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: replace All/Urgent/Paused with Solo/Tandem mode toggle

- StatusBar shows two-state segmented toggle with tooltips
- Mode broadcast to CTRL_ROOM (global, not per-document)
- useModeGate replaces useAnnotationGate (simpler: solo hides claude pending)
- tandem_status and tandem_checkInbox return 'mode' instead of 'interruptionMode'
- Old interruptionMode Y.Map key cleaned up on startup

Closes #207"
```

---

### Task 3: Selection Event Dwell Time

**Files:**
- Modify: `src/server/events/queue.ts:171-196`
- Modify: `src/channel/event-bridge.ts:12,186-191`
- Modify: `src/channel/event-bridge.ts` (Solo mode suppression)
- Test: `tests/server/event-queue-dwell.test.ts`

- [ ] **Step 1: Write failing test for dwell-time selection events**

```typescript
// tests/server/event-queue-dwell.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  attachObservers,
  detachObservers,
  resetForTesting,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { Y_MAP_USER_AWARENESS } from "../../src/shared/constants.js";
import { SELECTION_DWELL_DEFAULT_MS } from "../../src/shared/constants.js";

afterEach(() => {
  resetForTesting();
  vi.useRealTimers();
});

function collectEvents(): { events: TandemEvent[]; cleanup: () => void } {
  const events: TandemEvent[] = [];
  const cb = (event: TandemEvent) => events.push(event);
  subscribe(cb);
  return { events, cleanup: () => unsubscribe(cb) };
}

describe("selection dwell time", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new Y.Doc();
    attachObservers("test-doc", doc);
  });

  afterEach(() => {
    detachObservers("test-doc");
    doc.destroy();
  });

  it("does not emit selection event immediately", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set("selection", { from: 10, to: 20, selectedText: "hello", timestamp: Date.now() });
    // No time has passed — event should NOT have fired
    expect(events.filter(e => e.type === "selection:changed")).toHaveLength(0);
    cleanup();
  });

  it("emits selection event after dwell time elapses", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set("selection", { from: 10, to: 20, selectedText: "hello", timestamp: Date.now() });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS + 50);
    expect(events.filter(e => e.type === "selection:changed")).toHaveLength(1);
    cleanup();
  });

  it("resets dwell timer on new selection before expiry", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set("selection", { from: 10, to: 20, selectedText: "hello", timestamp: Date.now() });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS - 100);
    // New selection before dwell completes
    awareness.set("selection", { from: 30, to: 50, selectedText: "world", timestamp: Date.now() });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS - 100);
    // Still not enough time for the second selection
    expect(events.filter(e => e.type === "selection:changed")).toHaveLength(0);
    vi.advanceTimersByTime(200);
    // Now it should fire with the second selection
    const selEvents = events.filter(e => e.type === "selection:changed");
    expect(selEvents).toHaveLength(1);
    expect((selEvents[0].payload as { selectedText: string }).selectedText).toBe("world");
    cleanup();
  });

  it("cancels dwell timer when selection is cleared", () => {
    const { events, cleanup } = collectEvents();
    const awareness = doc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set("selection", { from: 10, to: 20, selectedText: "hello", timestamp: Date.now() });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS - 100);
    // Clear selection (cursor click)
    awareness.set("selection", { from: 15, to: 15, timestamp: Date.now() });
    vi.advanceTimersByTime(SELECTION_DWELL_DEFAULT_MS + 500);
    expect(events.filter(e => e.type === "selection:changed")).toHaveLength(0);
    cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/event-queue-dwell.test.ts`
Expected: FAIL — events fire immediately (no dwell)

- [ ] **Step 3: Add dwell timer to selection observer in queue.ts**

In `src/server/events/queue.ts`, replace the user awareness observer (lines 172-196):

```typescript
// 2. User awareness observer (selection changes — with dwell timer)
const userAwareness = doc.getMap(Y_MAP_USER_AWARENESS);
let selectionDwellTimer: ReturnType<typeof setTimeout> | null = null;

const awarenessObs = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
  if (txn.origin === MCP_ORIGIN) return;

  if (event.keysChanged.has("selection")) {
    const selection = userAwareness.get("selection") as
      | { from: FlatOffset; to: FlatOffset; selectedText?: string }
      | undefined;

    // Cancel any pending dwell timer
    if (selectionDwellTimer) {
      clearTimeout(selectionDwellTimer);
      selectionDwellTimer = null;
    }

    // Skip cleared selections (cursor moves without selecting text)
    if (!selection || selection.from === selection.to) return;

    // Start dwell timer — only emit after user holds selection steady
    selectionDwellTimer = setTimeout(() => {
      selectionDwellTimer = null;
      pushEvent({
        id: generateEventId(),
        type: "selection:changed",
        timestamp: Date.now(),
        documentId: docName,
        payload: {
          from: selection.from,
          to: selection.to,
          selectedText: selection.selectedText ?? "",
        },
      });
    }, SELECTION_DWELL_DEFAULT_MS);
  }
};
userAwareness.observe(awarenessObs);
cleanups.push(() => {
  userAwareness.unobserve(awarenessObs);
  if (selectionDwellTimer) clearTimeout(selectionDwellTimer);
});
```

Add `SELECTION_DWELL_DEFAULT_MS` to the imports from `../../shared/constants.js`.

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/server/event-queue-dwell.test.ts`
Expected: PASS

Run: `npm test -- tests/server/event-queue.test.ts`
Expected: PASS (existing tests may need timer advancement — check and fix)

- [ ] **Step 5: Reduce event-bridge selection debounce**

In `src/channel/event-bridge.ts`, change line 12:

```typescript
const SELECTION_DEBOUNCE_MS = 300; // Reduced from 1500 — client-side dwell is primary gate
```

- [ ] **Step 6: Add Solo mode suppression to event-bridge**

In `src/channel/event-bridge.ts`, add mode checking in `connectAndStream`. After parsing the event (after line 183), add a mode check before processing non-chat events:

```typescript
// Solo mode: suppress all non-chat events
if (event.type !== "chat:message") {
  try {
    const modeRes = await fetch(`${tandemUrl}/api/mode`);
    if (modeRes.ok) {
      const { mode } = await modeRes.json() as { mode: string };
      if (mode === "solo") {
        if (eventId) onEventId(eventId);
        continue;
      }
    }
  } catch {
    // If mode check fails, deliver the event (fail-open)
  }
}
```

Add the `/api/mode` endpoint in `src/server/mcp/api-routes.ts`:

```typescript
app.get("/api/mode", (_req, res) => {
  const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
  const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
  const mode = (awareness.get("mode") as string) ?? TANDEM_MODE_DEFAULT;
  res.json({ mode });
});
```

- [ ] **Step 7: Add selection event metadata for response routing**

In `src/server/events/types.ts`, update `formatEventContent` for `selection:changed` (line 141-144):

```typescript
case "selection:changed": {
  const { from, to, selectedText } = event.payload;
  if (!selectedText) return `User cleared selection${doc}`;
  return `User is pointing at text (${from}-${to}): "${selectedText}"${doc} — respond via tandem_reply`;
}
```

Update `formatEventMeta` (add after line 183):

```typescript
case "selection:changed":
  meta.respond_via = "tandem_reply";
  break;
```

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 9: Manual test**

Start `npm run dev:standalone`. Open Chrome:
1. Select text in the editor — no immediate reaction in terminal
2. Hold selection for ~1 second — event fires
3. Switch to Solo mode — selections don't fire at all
4. Switch back to Tandem — selections fire again after dwell

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: dwell-time selection events + Solo mode suppression

- Selection events require 1s dwell before firing (configurable)
- Dwell timer resets on new selection, cancels on clear
- Event-bridge suppresses non-chat events in Solo mode via /api/mode
- Selection events include respond_via: tandem_reply metadata
- Event-bridge debounce reduced from 1500ms to 300ms (dwell is primary gate)

Closes #188"
```

---

### Task 4: Click-to-Navigate Annotations

**Files:**
- Modify: `src/client/editor/Editor.tsx`
- Modify: `src/client/App.tsx`

- [ ] **Step 1: Add click handler to Editor component**

In `src/client/editor/Editor.tsx`, find the EditorContent or useEditor setup. Add an `onClick` handler on the editor container that checks for `data-annotation-id`:

```typescript
const handleEditorClick = useCallback((e: React.MouseEvent) => {
  const target = (e.target as HTMLElement).closest("[data-annotation-id]");
  if (!target) return;
  const annotationId = target.getAttribute("data-annotation-id");
  if (annotationId) {
    onAnnotationClick?.(annotationId);
  }
}, [onAnnotationClick]);
```

Add `onAnnotationClick?: (annotationId: string) => void` to the Editor's props interface.

Attach the click handler to the editor wrapper div.

- [ ] **Step 2: Wire click-to-navigate in App.tsx**

In `src/client/App.tsx`, add a callback for annotation clicks:

```typescript
const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

const handleAnnotationClick = useCallback((annotationId: string) => {
  // Guard: don't swap if user is composing a chat message
  if (chatInputRef.current && chatInputRef.current.value.trim() !== "") return;
  setShowChat(false); // Switch to Annotations tab
  setActiveAnnotationId(annotationId);
}, []);
```

Pass `onAnnotationClick={handleAnnotationClick}` to the `<Editor>` component.

Pass `chatInputRef` to `<ChatPanel>` so it can attach the ref to its textarea.

- [ ] **Step 3: Add scroll-to and highlight in SidePanel**

In `src/client/panels/SidePanel.tsx`, add an effect that scrolls to the active annotation when `activeAnnotationId` changes:

```typescript
useEffect(() => {
  if (!activeAnnotationId) return;
  const card = document.querySelector(`[data-testid="annotation-card-${activeAnnotationId}"]`);
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    card.classList.add("tandem-annotation-flash");
    const onEnd = () => card.classList.remove("tandem-annotation-flash");
    card.addEventListener("animationend", onEnd, { once: true });
  }
}, [activeAnnotationId]);
```

Add a `<style>` tag for the flash animation:

```tsx
<style>{`
  @keyframes tandem-annotation-flash {
    0% { background-color: rgba(99, 102, 241, 0.2); }
    100% { background-color: transparent; }
  }
  .tandem-annotation-flash {
    animation: tandem-annotation-flash 0.8s ease-out;
  }
`}</style>
```

- [ ] **Step 4: Manual test**

Start `npm run dev:standalone`. Open Chrome with a document that has annotations:
1. Click on annotated text in the editor
2. Verify the panel switches to Annotations tab
3. Verify the correct annotation card scrolls into view and flashes
4. Type something in the chat input, then click annotated text — verify no tab swap
5. Clear the chat input, click annotated text — verify tab swap works again

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: click annotated text to navigate to annotation card

- Clicking text with data-annotation-id swaps to Annotations tab
- Annotation card scrolls into view with highlight flash animation
- Guarded: no swap if user has unsent text in chat input"
```

---

### Task 5: Configurable Layout + Settings Popover + Tab Badges

**Files:**
- Create: `src/client/components/SettingsPopover.tsx`
- Create: `src/client/hooks/useTandemSettings.ts`
- Create: `src/client/layouts/TabbedLayout.tsx`
- Create: `src/client/layouts/ThreePanelLayout.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/status/StatusBar.tsx`

- [ ] **Step 1: Create settings hook**

```typescript
// src/client/hooks/useTandemSettings.ts
import { useState, useCallback } from "react";
import {
  TANDEM_SETTINGS_KEY,
  SELECTION_DWELL_DEFAULT_MS,
  SELECTION_DWELL_MIN_MS,
  SELECTION_DWELL_MAX_MS,
} from "../../shared/constants";

export type LayoutMode = "tabbed" | "three-panel";
export type PrimaryTab = "chat" | "annotations";
export type PanelOrder = "chat-editor-annotations" | "annotations-editor-chat";

export interface TandemSettings {
  layout: LayoutMode;
  primaryTab: PrimaryTab;
  panelOrder: PanelOrder;
  selectionDwellMs: number;
}

const DEFAULTS: TandemSettings = {
  layout: "tabbed",
  primaryTab: "chat",
  panelOrder: "chat-editor-annotations",
  selectionDwellMs: SELECTION_DWELL_DEFAULT_MS,
};

function loadSettings(): TandemSettings {
  try {
    const saved = localStorage.getItem(TANDEM_SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        layout: parsed.layout === "three-panel" ? "three-panel" : "tabbed",
        primaryTab: parsed.primaryTab === "annotations" ? "annotations" : "chat",
        panelOrder:
          parsed.panelOrder === "annotations-editor-chat"
            ? "annotations-editor-chat"
            : "chat-editor-annotations",
        selectionDwellMs: Math.max(
          SELECTION_DWELL_MIN_MS,
          Math.min(SELECTION_DWELL_MAX_MS, Number(parsed.selectionDwellMs) || SELECTION_DWELL_DEFAULT_MS),
        ),
      };
    }
  } catch {}
  return DEFAULTS;
}

export function useTandemSettings() {
  const [settings, setSettingsState] = useState<TandemSettings>(loadSettings);

  const updateSettings = useCallback((partial: Partial<TandemSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...partial };
      try {
        localStorage.setItem(TANDEM_SETTINGS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  return { settings, updateSettings };
}
```

- [ ] **Step 2: Create SettingsPopover component**

```typescript
// src/client/components/SettingsPopover.tsx
import React, { useEffect, useRef } from "react";
import type { TandemSettings, LayoutMode, PrimaryTab, PanelOrder } from "../hooks/useTandemSettings";
import { SELECTION_DWELL_MIN_MS, SELECTION_DWELL_MAX_MS } from "../../shared/constants";

interface SettingsPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRect: DOMRect | null;
  settings: TandemSettings;
  onUpdate: (partial: Partial<TandemSettings>) => void;
}

export function SettingsPopover({ open, onClose, anchorRect, settings, onUpdate }: SettingsPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  const isNarrow = window.innerWidth < 768;

  const layoutOption = (mode: LayoutMode, label: string, desc: string, disabled = false) => (
    <button
      key={mode}
      disabled={disabled}
      onClick={() => onUpdate({ layout: mode })}
      style={{
        flex: 1,
        padding: "10px",
        border: settings.layout === mode ? "2px solid #6366f1" : "1px solid #d1d5db",
        borderRadius: "6px",
        background: settings.layout === mode ? "#eef2ff" : "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        textAlign: "left",
      }}
    >
      <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "4px" }}>{label}</div>
      <div style={{ fontSize: "11px", color: "#6b7280" }}>{desc}</div>
    </button>
  );

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        bottom: `${window.innerHeight - anchorRect.top + 8}px`,
        left: `${anchorRect.left}px`,
        width: "340px",
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: "8px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
        padding: "16px",
        zIndex: 1000,
        fontSize: "13px",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: "12px" }}>Layout Settings</div>

      {/* Layout choice */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        {layoutOption("tabbed", "Tabbed Panel", "Editor + side panel with Chat/Annotations tabs")}
        {layoutOption(
          "three-panel",
          "Three Panel",
          "Chat, Editor, and Annotations side by side",
          isNarrow,
        )}
      </div>

      {/* Primary tab (tabbed only) */}
      {settings.layout === "tabbed" && (
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "#374151", marginBottom: "4px" }}>
            Default tab
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            {(["chat", "annotations"] as PrimaryTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => onUpdate({ primaryTab: tab })}
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  fontSize: "11px",
                  border: settings.primaryTab === tab ? "1px solid #6366f1" : "1px solid #d1d5db",
                  borderRadius: "4px",
                  background: settings.primaryTab === tab ? "#eef2ff" : "#fff",
                  cursor: "pointer",
                  color: settings.primaryTab === tab ? "#4338ca" : "#6b7280",
                  fontWeight: settings.primaryTab === tab ? 600 : 400,
                  textTransform: "capitalize",
                }}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Panel order (three-panel only) */}
      {settings.layout === "three-panel" && (
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "#374151", marginBottom: "4px" }}>
            Panel order
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            {(
              [
                { value: "chat-editor-annotations" as PanelOrder, label: "Chat | Editor | Annotations" },
                { value: "annotations-editor-chat" as PanelOrder, label: "Annotations | Editor | Chat" },
              ] as const
            ).map(({ value, label }) => (
              <button
                key={value}
                onClick={() => onUpdate({ panelOrder: value })}
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  fontSize: "10px",
                  border: settings.panelOrder === value ? "1px solid #6366f1" : "1px solid #d1d5db",
                  borderRadius: "4px",
                  background: settings.panelOrder === value ? "#eef2ff" : "#fff",
                  cursor: "pointer",
                  color: settings.panelOrder === value ? "#4338ca" : "#6b7280",
                  fontWeight: settings.panelOrder === value ? 600 : 400,
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Selection dwell time */}
      <div>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "#374151", marginBottom: "4px" }}>
          Selection dwell time: {(settings.selectionDwellMs / 1000).toFixed(1)}s
        </div>
        <div style={{ fontSize: "10px", color: "#9ca3af", marginBottom: "6px" }}>
          How long you hold a selection before Claude notices
        </div>
        <input
          type="range"
          min={SELECTION_DWELL_MIN_MS}
          max={SELECTION_DWELL_MAX_MS}
          step={100}
          value={settings.selectionDwellMs}
          onChange={(e) => onUpdate({ selectionDwellMs: Number(e.target.value) })}
          style={{ width: "100%" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "#9ca3af" }}>
          <span>0.5s</span>
          <span>3s</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add gear icon to StatusBar**

In `src/client/status/StatusBar.tsx`, add a gear button next to the Solo/Tandem toggle. Add props:

```typescript
onSettingsClick?: (rect: DOMRect) => void;
```

Add the button after the width mode button:

```tsx
<button
  title="Layout settings"
  aria-label="Layout settings"
  onClick={(e) => onSettingsClick?.(e.currentTarget.getBoundingClientRect())}
  style={{
    padding: "1px 6px",
    fontSize: "13px",
    border: "1px solid #d1d5db",
    borderRadius: "4px",
    cursor: "pointer",
    background: "transparent",
    color: "#6b7280",
    lineHeight: 1,
  }}
>
  ⚙
</button>
```

- [ ] **Step 4: Create TabbedLayout component**

```typescript
// src/client/layouts/TabbedLayout.tsx
import React from "react";
import type { PrimaryTab } from "../hooks/useTandemSettings";

interface TabbedLayoutProps {
  panelWidth: number;
  showChat: boolean;
  onShowChat: (show: boolean) => void;
  onCaptureSelection: () => void;
  annotationBadge: number;
  chatBadge: number;
  editorSlot: React.ReactNode;
  chatSlot: React.ReactNode;
  annotationsSlot: React.ReactNode;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function TabbedLayout({
  panelWidth,
  showChat,
  onShowChat,
  onCaptureSelection,
  annotationBadge,
  chatBadge,
  editorSlot,
  chatSlot,
  annotationsSlot,
  onResizeStart,
}: TabbedLayoutProps) {
  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      <div style={{ flex: 1, overflow: "auto" }}>
        {editorSlot}
      </div>
      {/* Resize handle */}
      <div
        data-testid="panel-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        tabIndex={0}
        onMouseDown={onResizeStart}
        style={{
          width: "4px",
          cursor: "col-resize",
          background: "transparent",
          flexShrink: 0,
          transition: "background 0.15s",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#d1d5db"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
      />
      <div style={{ display: "flex", flexDirection: "column", width: `${panelWidth}px`, borderLeft: "1px solid #e5e7eb" }}>
        {/* Tab toggle */}
        <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>
          <button
            onClick={() => onShowChat(false)}
            style={{
              flex: 1, padding: "8px", fontSize: "12px",
              fontWeight: showChat ? 400 : 600,
              border: "none", borderBottom: showChat ? "none" : "2px solid #6366f1",
              background: "transparent", cursor: "pointer",
              color: showChat ? "#6b7280" : "#6366f1",
              position: "relative",
            }}
          >
            Annotations
            {showChat && annotationBadge > 0 && (
              <span
                className="tandem-badge-pulse"
                style={{
                  position: "absolute", top: "4px", right: "8px",
                  background: "#ef4444", color: "#fff", fontSize: "9px",
                  width: "16px", height: "16px", borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 700,
                }}
                onAnimationEnd={(e) => (e.currentTarget as HTMLElement).classList.remove("tandem-badge-pulse")}
              >
                {annotationBadge > 9 ? "9+" : annotationBadge}
              </span>
            )}
          </button>
          <button
            onMouseDown={onCaptureSelection}
            onClick={() => onShowChat(true)}
            style={{
              flex: 1, padding: "8px", fontSize: "12px",
              fontWeight: showChat ? 600 : 400,
              border: "none", borderBottom: showChat ? "2px solid #6366f1" : "none",
              background: "transparent", cursor: "pointer",
              color: showChat ? "#6366f1" : "#6b7280",
              position: "relative",
            }}
          >
            Chat
            {!showChat && chatBadge > 0 && (
              <span
                className="tandem-badge-pulse"
                style={{
                  position: "absolute", top: "4px", right: "8px",
                  background: "#3b82f6", color: "#fff", fontSize: "9px",
                  width: "16px", height: "16px", borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 700,
                }}
                onAnimationEnd={(e) => (e.currentTarget as HTMLElement).classList.remove("tandem-badge-pulse")}
              >
                {chatBadge > 9 ? "9+" : chatBadge}
              </span>
            )}
          </button>
        </div>
        <style>{`
          @keyframes tandem-badge-pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.3); }
            100% { transform: scale(1); }
          }
          .tandem-badge-pulse { animation: tandem-badge-pulse 0.3s ease-out; }
        `}</style>
        {/* Panels — both mounted, toggle visibility */}
        <div style={{ display: showChat ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {chatSlot}
        </div>
        <div style={{ display: showChat ? "none" : "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {annotationsSlot}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create ThreePanelLayout component**

```typescript
// src/client/layouts/ThreePanelLayout.tsx
import React from "react";
import type { PanelOrder } from "../hooks/useTandemSettings";

interface ThreePanelLayoutProps {
  panelOrder: PanelOrder;
  leftPanelWidth: number;
  rightPanelWidth: number;
  onLeftResizeStart: (e: React.MouseEvent) => void;
  onRightResizeStart: (e: React.MouseEvent) => void;
  editorSlot: React.ReactNode;
  chatSlot: React.ReactNode;
  annotationsSlot: React.ReactNode;
}

function PanelHeader({ label }: { label: string }) {
  return (
    <div style={{
      padding: "8px 12px", borderBottom: "1px solid #e5e7eb",
      background: "#f9fafb", fontSize: "12px", fontWeight: 600, color: "#374151",
    }}>
      {label}
    </div>
  );
}

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      style={{
        width: "4px", cursor: "col-resize", background: "transparent",
        flexShrink: 0, transition: "background 0.15s",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#d1d5db"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
    />
  );
}

export function ThreePanelLayout({
  panelOrder,
  leftPanelWidth,
  rightPanelWidth,
  onLeftResizeStart,
  onRightResizeStart,
  editorSlot,
  chatSlot,
  annotationsSlot,
}: ThreePanelLayoutProps) {
  const leftSlot = panelOrder === "chat-editor-annotations" ? chatSlot : annotationsSlot;
  const rightSlot = panelOrder === "chat-editor-annotations" ? annotationsSlot : chatSlot;
  const leftLabel = panelOrder === "chat-editor-annotations" ? "Chat" : "Annotations";
  const rightLabel = panelOrder === "chat-editor-annotations" ? "Annotations" : "Chat";

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* Left panel */}
      <div style={{
        width: `${leftPanelWidth}px`, display: "flex", flexDirection: "column",
        borderRight: "1px solid #e5e7eb", minWidth: "200px", maxWidth: "400px",
      }}>
        <PanelHeader label={leftLabel} />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {leftSlot}
        </div>
      </div>
      <ResizeHandle onMouseDown={onLeftResizeStart} />
      {/* Editor */}
      <div style={{ flex: 1, overflow: "auto", minWidth: "300px" }}>
        {editorSlot}
      </div>
      <ResizeHandle onMouseDown={onRightResizeStart} />
      {/* Right panel */}
      <div style={{
        width: `${rightPanelWidth}px`, display: "flex", flexDirection: "column",
        borderLeft: "1px solid #e5e7eb", minWidth: "200px", maxWidth: "400px",
      }}>
        <PanelHeader label={rightLabel} />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {rightSlot}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Integrate layouts and settings into App.tsx**

In `src/client/App.tsx`:

1. Import `useTandemSettings`, `SettingsPopover`, `TabbedLayout`, `ThreePanelLayout`
2. Add `const { settings, updateSettings } = useTandemSettings();`
3. Add settings popover state: `const [settingsOpen, setSettingsOpen] = useState(false);` and `const [settingsAnchor, setSettingsAnchor] = useState<DOMRect | null>(null);`
4. Initialize `showChat` from settings: `const [showChat, setShowChat] = useState(settings.primaryTab === "chat");`
5. Replace the main layout div (lines 384-541) with a conditional:

```tsx
{settings.layout === "three-panel" && window.innerWidth >= 768 ? (
  <ThreePanelLayout
    panelOrder={settings.panelOrder}
    leftPanelWidth={panelWidth}
    rightPanelWidth={panelWidth}
    onLeftResizeStart={handleResizeStart}
    onRightResizeStart={handleResizeStart}
    editorSlot={editorContent}
    chatSlot={chatPanel}
    annotationsSlot={annotationsPanel}
  />
) : (
  <TabbedLayout
    panelWidth={panelWidth}
    showChat={showChat}
    onShowChat={setShowChat}
    onCaptureSelection={captureSelectionForChat}
    annotationBadge={pendingAnnotationBadge}
    chatBadge={unreadChatBadge}
    editorSlot={editorContent}
    chatSlot={chatPanel}
    annotationsSlot={annotationsPanel}
    onResizeStart={handleResizeStart}
  />
)}
```

Extract the editor content, chat panel, and annotations panel into variables above the return so they can be passed as slots to either layout.

6. Pass settings callback to StatusBar: `onSettingsClick={(rect) => { setSettingsAnchor(rect); setSettingsOpen(true); }}`
7. Add `<SettingsPopover>` in the JSX

- [ ] **Step 7: Add badge tracking state**

Track annotation and chat badge counts in App.tsx:

```typescript
// Track pending annotation count for badge (when chat tab is active)
const pendingAnnotationBadge = useMemo(() => {
  if (!showChat) return 0; // badge only shows when on chat tab
  return visibleAnnotations.filter(a => a.status === "pending").length;
}, [visibleAnnotations, showChat]);

// Track unread chat messages for badge (when annotations tab is active)
const [unreadChatBadge, setUnreadChatBadge] = useState(0);
// Reset badge when switching to chat tab
useEffect(() => {
  if (showChat) setUnreadChatBadge(0);
}, [showChat]);
```

Pass an `onNewMessage` callback to ChatPanel that increments `unreadChatBadge` when `!showChat`.

- [ ] **Step 8: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: All pass

- [ ] **Step 9: Manual test**

Start `npm run dev:standalone`. Open Chrome:
1. Click the gear icon — settings popover appears
2. Select "Three Panel" — layout changes to three columns
3. Switch panel order — chat and annotations swap sides
4. Adjust dwell slider — setting persists across refresh
5. Select "Tabbed" — back to original layout
6. Change default tab to Annotations — on refresh, Annotations tab is primary
7. Resize browser below 768px with three-panel selected — falls back to tabbed
8. While on Chat tab, trigger an annotation — red badge appears on Annotations tab
9. Switch to Annotations — badge clears

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: configurable layout with settings popover + tab badges

- Settings popover with visual layout previews (gear icon in status bar)
- Tabbed layout (default): editor + tabbed right panel
- Three-panel layout: chat + editor + annotations side by side
- Configurable primary tab, panel order, selection dwell time
- Tab badges: red count for annotations, blue for chat
- Three-panel disabled below 768px viewport width
- All settings persisted in localStorage

Closes #206"
```

---

### Task 6: Skill Update + Documentation + Cleanup

**Files:**
- Modify: Tandem skill file (if in repo)
- Modify: `docs/mcp-tools.md`
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update Tandem skill with response routing instructions**

Find the Tandem skill file. Add these behavioral instructions:

```markdown
## Response Routing

When reacting to document events (selections, annotation actions, document changes), respond via `tandem_reply` so your response appears in the Tandem chat panel. Reserve terminal output for work outside the document context (file operations, code generation, etc.).

## Solo/Tandem Mode

Check the user's mode via `tandem_checkInbox` or `tandem_status`. The response includes a `mode` field:
- `"tandem"` — Full collaboration. React to selections, create annotations, respond to document events.
- `"solo"` — User is writing undisturbed. Do not proactively annotate or react to document events. Only respond when the user explicitly sends a chat message.

## Selection Events

When a selection event arrives, the user is pointing at specific text for your attention. Respond briefly in chat (via `tandem_reply`) acknowledging what they've highlighted and ask what they'd like you to do with it, or provide a relevant observation.
```

- [ ] **Step 2: Update CLAUDE.md**

Update the "Key Patterns" section to reflect:
- Solo/Tandem replaces All/Urgent/Paused
- Mode is on CTRL_ROOM, not per-document
- Selection events use dwell time
- `tandem_status` and `tandem_checkInbox` return `mode` not `interruptionMode`

Update the "Gotchas" section to remove references to the old interruption mode system.

- [ ] **Step 3: Update docs/mcp-tools.md**

Update `tandem_status` and `tandem_checkInbox` documentation to show `mode` field instead of `interruptionMode`.

- [ ] **Step 4: Update CHANGELOG.md**

Add Wave 4 entry:

```markdown
## Wave 4: Notification & Interruption Redesign

- **Solo/Tandem mode** replaces All/Urgent/Paused interruption controls (#207)
- **Dwell-time selection events** — selections fire after 1s hold, configurable (#188)
- **Configurable layout** — tabbed or three-panel, with settings popover (#206)
- **Click-to-navigate** — click annotated text to jump to annotation card
- **Tab badges** — notification counts on inactive panel tabs
- **Skill-directed response routing** — Claude responds in chat panel, not terminal
- Review banner replaced with per-annotation toasts (#208, landed earlier)
```

- [ ] **Step 5: Run full test suite**

Run: `npm test && npm run typecheck`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: update skill, CLAUDE.md, and changelog for Wave 4

- Tandem skill updated with response routing and Solo/Tandem mode guidance
- CLAUDE.md reflects new mode system and selection dwell behavior
- MCP tool docs updated for mode field
- CHANGELOG entry for Wave 4"
```

---

## File Map Summary

| Action | File | Task |
|--------|------|------|
| Create | `src/client/hooks/useModeGate.ts` | 1 |
| Create | `tests/client/solo-tandem-mode.test.ts` | 1 |
| Create | `src/client/components/SettingsPopover.tsx` | 5 |
| Create | `src/client/hooks/useTandemSettings.ts` | 5 |
| Create | `src/client/layouts/TabbedLayout.tsx` | 5 |
| Create | `src/client/layouts/ThreePanelLayout.tsx` | 5 |
| Create | `tests/server/event-queue-dwell.test.ts` | 3 |
| Modify | `src/shared/types.ts` | 1 |
| Modify | `src/shared/constants.ts` | 1 |
| Modify | `src/client/status/StatusBar.tsx` | 2, 5 |
| Modify | `src/client/App.tsx` | 2, 4, 5 |
| Modify | `src/client/panels/SidePanel.tsx` | 2, 4 |
| Modify | `src/client/editor/Editor.tsx` | 4 |
| Modify | `src/server/events/queue.ts` | 3 |
| Modify | `src/channel/event-bridge.ts` | 3 |
| Modify | `src/server/events/types.ts` | 3 |
| Modify | `src/server/mcp/api-routes.ts` | 3 |
| Modify | `src/server/mcp/document.ts` | 2 |
| Modify | `src/server/mcp/awareness.ts` | 2 |
| Delete | `src/client/hooks/useAnnotationGate.ts` | 2 |
| Delete | `tests/client/annotation-gate.test.ts` | 2 |
