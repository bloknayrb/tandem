# Wave 4: Notification, Interruption & Layout Redesign

**Date**: 2026-04-07
**Issues**: #188, #206, #207 (plus #208 already merged)
**Status**: Design approved

## Summary

Replace the current interruption mode system (All/Urgent/Paused) with a binary Solo/Tandem toggle, add dwell-time-based selection events, introduce a configurable layout system with visual previews, and update the Tandem skill so Claude responds in the chat panel rather than the terminal.

## 1. Solo/Tandem Mode Toggle

**Replaces**: The three-state All/Urgent/Paused segmented control in the status bar.

### Behavior

| | Solo Mode | Tandem Mode |
|---|---|---|
| Selection channel events | Suppressed at event-bridge | Fired after dwell time |
| Document change channel events | Suppressed at event-bridge | Fired |
| Annotation creation by Claude | Held (queued, not shown until mode change) | Active |
| User chat messages | Delivered to Claude | Delivered to Claude |
| `tandem_getSelections` (on-demand) | Returns only the current selection (no history) | Returns current selection |
| Status bar indicator | Grey dot, "Claude is listening" | Green dot, "Claude is active" |

**Solo mode** suppresses all passive channel events at the event-bridge level. Annotations are still written to Y.Map normally by the server — Solo mode filters at the channel delivery layer, not at the CRDT layer. Claude remains reachable via explicit chat messages — it goes quiet, not deaf.

In Solo mode, `tandem_getSelections` returns only the user's current selection (whatever is highlighted right now). Previous selections are overwritten, not accumulated. No backlog of selection events is buffered for later delivery when switching back to Tandem mode.

**Tandem mode** enables full collaboration. Claude reacts to selections (with dwell time), creates annotations, and responds to document events.

### Where suppression happens

Suppression is implemented in `src/channel/event-bridge.ts`, not in the client or server event queue. The event queue (`queue.ts`) continues to emit events normally — the event-bridge checks the current mode from `CTRL_ROOM`'s Y.Map and drops non-chat events when in Solo mode. This means:

- Y.Map writes proceed normally in both modes (no CRDT divergence)
- `tandem_checkInbox` still works (explicit user action)
- `tandem_getSelections` still works (on-demand polling)
- The event-bridge does NOT buffer Solo-mode events for replay on mode switch

### UI

- Segmented toggle in the status bar: `[Solo] [Tandem]`
- Active state uses indigo background (#6366f1), inactive is transparent
- Tooltips on each button: Solo = "Write undisturbed — Claude only responds when you message", Tandem = "Full collaboration — Claude reacts to selections and document changes"
- Status indicator dot + label to the right of the toggle
- Persisted in localStorage (`tandem:mode`), broadcast to `CTRL_ROOM`'s Y.Map (global, not per-document) so Claude and the server can read it

### What it replaces

- Delete `MODES` array in StatusBar.tsx (the All/Urgent/Paused definitions)
- Delete `useAnnotationGate.ts` hook (three-state filtering logic)
- Delete `InterruptionMode` type and `InterruptionModeSchema` from shared types
- Delete `INTERRUPTION_MODE_KEY`, `INTERRUPTION_MODE_DEFAULT` from constants
- Replace with a `TandemMode` type (`"solo" | "tandem"`) and simpler filtering: in Solo mode, pending annotations from Claude are held client-side; in Tandem mode, all annotations are shown
- Update `tandem_status` MCP response to return `mode: "solo" | "tandem"` instead of `interruptionMode`. The old field is removed — MCP consumers must use the new field.

### Migration

- localStorage: `tandem:mode` with values `"solo"` | `"tandem"` (default: `"tandem"`). Old `interruptionMode` localStorage key is ignored (falls back to default).
- Y.Map: Mode is written to `CTRL_ROOM`'s Y.Map under key `"mode"`. On startup, the client deletes the orphan `"interruptionMode"` key from each document's `userAwareness` Y.Map within a transaction to clean up stale data from the old three-state system.

## 2. Selection Event Dwell Time

**Addresses**: #188, #206

### Behavior

Selection events fire only after the user holds a selection for a configurable dwell time (default: 1 second). This filters out casual clicks and drag-in-progress noise while preserving the "point at text, Claude reacts" interaction.

- **Dwell timer starts** when a text selection (from !== to) stabilizes (no further selection changes for the dwell duration)
- **Dwell timer resets** on any selection change during the wait
- **Cleared selections** (cursor click, from === to) cancel any pending timer and are not emitted
- **Solo mode** suppresses the event entirely regardless of dwell (at the event-bridge level)

### Debounce chain

Three stages gate selection events, each serving a distinct purpose:

1. **Y.Map write debounce (150ms, client)** — remains in `awareness.ts`. Reduces CRDT sync traffic by coalescing rapid drag-selection changes. The Y.Map is written after 150ms of selection stability. This ensures `tandem_getSelections` sees a reasonably current selection without flooding the network.

2. **Dwell timer (configurable, default 1000ms, server event queue)** — new. After the Y.Map write lands and the server-side observer fires, the observer starts a dwell timer. If no new selection arrives within the dwell period, the event is emitted to the event-bridge. This is the primary "intentional pointing" gate.

3. **Event-bridge coalescing (300ms, channel)** — reduced from the current 1500ms `SELECTION_DEBOUNCE_MS` in `event-bridge.ts`. A short coalescing window to handle any rapid-fire events that slip through. The client-side dwell is the primary filter now.

Effective minimum latency from selection to Claude: ~150ms + 1000ms + 300ms = ~1.45s at default settings. This is intentional — selection events represent deliberate pointing, not cursor movement.

### Implementation

- `src/client/editor/extensions/awareness.ts`: Keep the 150ms Y.Map write debounce as-is
- `src/server/events/queue.ts`: Add a dwell timer to the selection observer. On `selection` key change, start/reset a timer. On expiry, emit the event. Read dwell duration from settings (localStorage-persisted, default 1000ms).
- `src/channel/event-bridge.ts`: Reduce `SELECTION_DEBOUNCE_MS` from 1500 to 300
- Dwell duration is stored client-side in localStorage (`tandem:selectionDwell`) and does NOT need to be broadcast via Y.Map — the dwell timer runs server-side using a value passed at startup or read from the settings file

### Skill-directed response routing

When a selection event fires, Claude should respond via `tandem_reply` (in the chat panel), not in the terminal. This is achieved through:

1. **Event metadata**: Selection events include `respondVia: "tandem_reply"` in their payload
2. **Event format**: The notification text frames the event conversationally, e.g., "User is pointing at: '...' — respond via tandem_reply"
3. **Skill update**: The Tandem skill instructs Claude to use `tandem_reply` for all document-context reactions and reserve terminal output for non-document tasks

This is behavioral guidance, not a hard server-side route. Claude follows skill instructions reliably in practice.

## 3. Configurable Layout

**Addresses**: #206

### Layout Options

**Option A: Tabbed Panel (default)**
- Editor on the left, single right panel with Chat and Annotations tabs
- User chooses which tab is primary (default on load): Chat or Annotations
- Default primary tab: Chat
- Clicking annotated text in the editor auto-swaps to the Annotations tab and scrolls to the relevant annotation card
- Manual tab click to return to the other tab (no auto-return)
- Notification badge (count) on the inactive tab when there's activity

**Option B: Three-Panel**
- Three side-by-side panels: Chat, Editor, Annotations
- User chooses panel order: Chat|Editor|Annotations or Annotations|Editor|Chat
- No tab switching needed — both panels always visible
- Clicking annotated text scrolls the Annotations panel to the relevant card (no tab swap needed)
- **Responsive constraint**: Three-panel is disabled below 768px viewport width. If the user has three-panel selected and resizes below the breakpoint, the layout automatically falls back to tabbed. A CSS media query hides the three-panel option in the settings popover below this width.

### Settings Popover

Accessed via a **gear icon** in the status bar (next to the Solo/Tandem toggle).

Opens a **popover anchored to the gear icon** (not a full modal — four settings don't warrant a blocking dialog). The popover contains visual previews of each layout option as miniature wireframe diagrams. Users click a layout preview to select it. Dismisses on outside click or Escape key.

**Settings in the popover:**
1. **Layout**: Tabbed or Three-Panel (visual preview cards, click to select)
2. **Primary tab** (tabbed only): Chat or Annotations radio buttons
3. **Panel order** (three-panel only): Chat|Editor|Annotations or Annotations|Editor|Chat (visual preview)
4. **Selection dwell time**: Slider, 0.5s–3s, default 1s. Label: "How long you hold a selection before Claude notices"

All settings persisted in localStorage under `tandem:settings`.

### Panel Resize

Both layout options support the existing drag-to-resize behavior. In the three-panel layout, each panel boundary is independently resizable. Panel widths are persisted in localStorage. Min/max constraints: each side panel minimum 200px, maximum 400px. Editor always gets remaining space (flex: 1) with a minimum of 300px.

### Tab Badge

When the inactive tab has new activity (new annotations arrive, new chat messages), a notification badge appears on the tab:
- Red dot with count for annotations (pending count)
- Blue dot for unread chat messages
- **Pulse animation**: On the first unread item arriving, the badge plays a brief CSS pulse animation (~300ms) to draw attention. Subsequent increments update the count silently without re-animating. The pulse class is removed via `animationend` event.

This ensures users don't miss activity when viewing the other tab.

## 4. Click-to-Navigate Annotations

When the user clicks on text in the editor that has an associated annotation:

1. **Tabbed layout**: Panel swaps to the Annotations tab (if not already showing), scrolls to and highlights the relevant annotation card
2. **Three-panel layout**: Annotations panel scrolls to and highlights the relevant annotation card (no tab swap needed)

The annotation card receives a brief highlight animation (e.g., background flash) to draw attention.

### Implementation

- The Tiptap decoration system already sets `data-annotation-id` as an HTML attribute on every decorated range (annotation.ts lines 52, 62, 70, 79, 88)
- Add a click handler on the editor that checks `event.target.closest('[data-annotation-id]')`:
  1. Reads the annotation ID from the `data-annotation-id` attribute
  2. Sets the active tab to Annotations (tabbed layout only)
  3. Scrolls the annotation panel to the matching card
  4. Applies a highlight animation to the card

### Guard: unsent chat text

If the user is composing a chat message (input has text), clicking annotated text should NOT auto-swap to the Annotations tab. This prevents losing focus and draft text mid-composition. The click-to-navigate only triggers when the chat input is empty. Check via a ref on the chat input element (`chatInputRef.current.value === ""`).

## 5. Skill Update

The Tandem skill (Claude's behavioral instructions when working with Tandem) needs updates to match the new design:

1. **Response routing**: "When reacting to document events (selections, annotation actions, document changes), respond via `tandem_reply` so your response appears in the Tandem chat panel. Reserve terminal output for work outside the document context (file operations, code generation, etc.)."

2. **Solo/Tandem awareness**: "Check the user's mode via `tandem_checkInbox` or `tandem_status`. In Solo mode, do not proactively annotate or react to document events. Only respond when the user explicitly sends a chat message."

3. **Selection reactions**: "When a selection event arrives, the user is pointing at specific text for your attention. Respond briefly in chat acknowledging what they've highlighted and ask what they'd like you to do with it, or provide a relevant observation."

## Files Affected

### Delete
- `src/client/hooks/useAnnotationGate.ts` — replaced by simpler Solo/Tandem filtering
- `InterruptionMode` type, `InterruptionModeSchema`, `INTERRUPTION_MODE_KEY`, `INTERRUPTION_MODE_DEFAULT` from shared types/constants

### Modify
- `src/client/App.tsx` — layout system, mode state, tab badge, orphan Y.Map key cleanup
- `src/client/status/StatusBar.tsx` — Solo/Tandem toggle with tooltips, gear icon, remove old mode buttons
- `src/client/editor/extensions/awareness.ts` — keep 150ms Y.Map debounce, no changes needed here
- `src/client/panels/ChatPanel.tsx` — badge support, unsent-text guard ref
- `src/client/panels/SidePanel.tsx` — scroll-to-annotation support
- `src/server/events/queue.ts` — add dwell timer to selection observer
- `src/channel/event-bridge.ts` — Solo mode event suppression, selection event metadata (`respondVia`), reduce debounce to 300ms
- `src/server/mcp/api-routes.ts` — update `tandem_status` response: `mode` field replaces `interruptionMode`
- `src/shared/constants.ts` — new constants for settings keys, dwell defaults, remove old interruption constants
- `src/shared/types.ts` — new `TandemMode` type, settings types, remove `InterruptionMode`

### Create
- `src/client/components/SettingsPopover.tsx` — layout preferences popover with visual previews
- `src/client/hooks/useTandemSettings.ts` — settings state management, localStorage persistence
- `src/client/layouts/TabbedLayout.tsx` — tabbed panel layout component (extract from App.tsx)
- `src/client/layouts/ThreePanelLayout.tsx` — three-panel layout component

## Out of Scope

- Panel drag-and-drop reordering (preset positions only)
- Per-document settings (all settings are global)
- Server-side enforcement of response routing (skill-based only)
- Changes to annotation types or actions (#193, #199 are Wave 5)
- Claude cursor (#209 is Wave 6)
