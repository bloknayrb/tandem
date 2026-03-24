# Chat Sidebar + Edit Sync Fix

**Date:** 2026-03-23
**Status:** Draft

## Problem

Two issues with Tandem's real-time collaboration:

1. **Edit sync broken:** Claude's `tandem_edit` mutations don't reliably appear in the browser. Root cause: when all browser clients disconnect, Hocuspocus destroys its Y.Doc instance, but the server's `documents` map in `provider.ts` retains a stale reference to the destroyed doc. Subsequent MCP mutations go to a dead doc and are lost on reconnect.

2. **No way to talk to Claude from Tandem:** Users can create annotations (highlights, comments, questions) but have no direct messaging channel. Claude only sees user actions when it polls `tandem_checkInbox`. There's no focused "look at this" interaction without switching to the terminal.

## Solution

### Part 1: Edit Sync Fix

**Root cause:** Hocuspocus's `afterUnloadDocument` lifecycle event fires when all browsers disconnect, destroying the doc and removing it from Hocuspocus's internal map. But `provider.ts`'s `documents` Map still holds the destroyed instance. `getOrCreateDocument()` returns a dead doc for subsequent MCP calls.

**Fix in `src/server/yjs/provider.ts`:**

Add `afterUnloadDocument` hook — delete the entry from our `documents` map when Hocuspocus unloads a room, so the next `getOrCreateDocument()` creates a fresh Y.Doc.

```typescript
async onLoadDocument({ document, documentName }) {
  const existing = documents.get(documentName);
  if (existing && existing !== document) {
    const update = Y.encodeStateAsUpdate(existing);
    Y.applyUpdate(document, update);
    existing.destroy();
  }
  documents.set(documentName, document);
  return document;
},

async afterUnloadDocument({ documentName }) {
  if (documents.has(documentName)) {
    documents.delete(documentName);
    console.error(`[Hocuspocus] Unloaded document from map: ${documentName}`);
  }
},
```

Note: `onLoadDocument` continues to return `document` as before. The Hocuspocus v2 extension API uses the return value to bind the doc to the room — removing it could cause regressions. The return value may cause a redundant self-merge internally, but this is idempotent and harmless.

### Part 2: Chat Sidebar

#### Data Model

Session-scoped chat stored on the `__tandem_ctrl__` Y.Doc in `Y.Map('chat')`, keyed by message ID.

```typescript
// In src/shared/types.ts
interface ChatMessage {
  id: string;                // "msg_" + timestamp + "_" + random (via generateMessageId)
  author: 'user' | 'claude';
  text: string;
  timestamp: number;
  documentId?: string;       // active document when message was sent
  anchor?: {                 // optional text selection context (flat text offsets)
    from: number;            // flat offset (server coordinate system)
    to: number;              // flat offset (server coordinate system)
    textSnapshot: string;    // captured text for display fallback when offsets drift
  };
  replyTo?: string;          // ID of message being responded to
  read: boolean;             // set true when Claude processes via checkInbox
}
```

**Design decisions:**

- **Session-scoped, not per-document.** Users talk to Claude regardless of which tab is active. `documentId` field preserves which doc was active for context without fragmenting the conversation.
- **`read` field in Y.Map** instead of in-memory `surfacedIds` for chat messages. Survives server restarts. Also enables unread badge in UI.
- **`anchor` stores flat text offsets** (server coordinate system, same as annotations). Client converts from ProseMirror positions via `pmPosToFlatOffset` when sending, and back via `flatOffsetToPmPos` when rendering click-to-scroll. If offsets drift after edits, the `textSnapshot` is displayed instead. Keeps v1 simple — no Yjs Relative Positions.
- **Message ordering:** sort by `(timestamp, id)` for deterministic display. Same pattern as annotations.
- **Bounded growth:** prune messages beyond the newest 200 during session save. Prevents Y.Doc bloat.
- **ID generation:** new `generateMessageId()` in `src/shared/utils.ts`, following the same pattern as `generateAnnotationId()` but with `msg_` prefix.

#### Server Changes

**Modify `tandem_checkInbox` (`src/server/mcp/awareness.ts`):**

Read Y.Map('chat') from the `__tandem_ctrl__` doc in addition to per-document annotations. The `documentId` parameter continues to scope only the annotations bucket — chat is always read from `__tandem_ctrl__` regardless of which document is targeted. Return new user messages (where `read === false`) in a `chatMessages` array. After surfacing, set `read: true` on each message in the Y.Map.

Return shape adds:
```typescript
{
  // ...existing userActions, userResponses...
  chatMessages: Array<{
    id: string;
    text: string;
    timestamp: number;
    documentId?: string;
    anchor?: { from: number; to: number; textSnapshot: string };
    replyTo?: string;
  }>;
}
```

Summary string adds: `"2 new chat messages"` when applicable.

**New tool: `tandem_reply` (`src/server/mcp/awareness.ts`):**

```
tandem_reply(text: string, replyTo?: string, documentId?: string)
```

Writes a ChatMessage with `author: 'claude'`, `read: true` to Y.Map('chat') on `__tandem_ctrl__`. Optional `replyTo` links to the user message being answered. Optional `documentId` overrides the active document context; if omitted, uses `getActiveDocId()` (may be null if no document is open, which is fine — `documentId` is optional on ChatMessage). This brings the tool count to 26.

#### Client Changes

**New component: `ChatPanel` (`src/client/panels/ChatPanel.tsx`):**

Props: `ctrlYdoc: Y.Doc` (the `__tandem_ctrl__` Y.Doc from `bootstrapRef`), `editor: TiptapEditor | null`, `activeDocId: string | null`, `openDocs: Map`.

- Renders as a toggleable panel (tab alongside SidePanel, or a split view)
- **Message list:** scrollable, newest at bottom. Each message shows:
  - Author badge (user/Claude)
  - Document context badge if `documentId` present (e.g., "essay.md") — clickable, switches tab
  - Quoted anchor text if `anchor` present — clickable, scrolls editor to anchor location via `flatOffsetToPmPos` + `scrollIntoView` (same pattern as `SidePanel.tsx`)
  - Message text (Claude responses rendered as markdown via `react-markdown` with default sanitization)
  - Timestamp
- **Input area:** text input at bottom with send button
  - If user has text selected in editor, shows selection badge above input: "with selection: [first 40 chars...]"
  - Selection captured via `onMouseDown` on send button (same pattern as Toolbar's `captureSelectionRange` at `Toolbar.tsx:112-116`) — must fire before editor loses focus and ProseMirror clears the selection
  - Enter to send, Shift+Enter for newline
  - On send: convert PM selection to flat offsets via `pmPosToFlatOffset`, extract `textSnapshot` from editor state, write ChatMessage to `ctrlYdoc.getMap('chat')`
- **Unread indicator:** badge on chat tab showing count of messages where `read === false` and `author === 'claude'`

**Integration in `App.tsx`:**

- Pass `bootstrapRef.current.ydoc` (the `__tandem_ctrl__` Y.Doc) as `ctrlYdoc` prop to ChatPanel
- ChatPanel observes `ctrlYdoc.getMap('chat')` for changes via Y.Map `observe` callback
- ChatPanel writes user messages to Y.Map('chat') with current `activeDocId` as `documentId`
- Add toggle state for showing ChatPanel vs SidePanel (or show both in split view)

**Persistence for `__tandem_ctrl__`:**

The `__tandem_ctrl__` doc is not file-backed, so it's not covered by the existing session persistence system (which keys on file paths). Add a dedicated save/restore for the ctrl doc in `src/server/session/manager.ts`, keyed as `__tandem_ctrl__`. This ensures chat history survives server restarts. Prune to newest 200 messages during save.

#### Security

- Markdown rendering for Claude responses uses `react-markdown` (already a common React dependency) with no `allowedElements` override for script/iframe — safe by default. No `dangerouslySetInnerHTML`.
- All messages stay local (localhost Y.Doc, no external transmission)

## Files Changed

| File | Change |
|------|--------|
| `src/server/yjs/provider.ts` | Add `afterUnloadDocument` hook |
| `src/shared/types.ts` | Add `ChatMessage` interface |
| `src/shared/utils.ts` | Add `generateMessageId()` function |
| `src/server/mcp/awareness.ts` | Extend `tandem_checkInbox` to read chat, add `tandem_reply` tool |
| `src/server/session/manager.ts` | Add ctrl doc persistence for chat history |
| `src/client/panels/ChatPanel.tsx` | New file — chat sidebar component |
| `src/client/App.tsx` | Wire ChatPanel to `__tandem_ctrl__` Y.Doc, observe Y.Map('chat'), add panel toggle |
| `src/client/App.css` | Chat panel styles |
| `package.json` | Add `react-markdown` dependency |
| `docs/mcp-tools.md` | Document `tandem_reply` (tool #26) |
| `docs/architecture.md` | Add chat data flow diagram |
| `CLAUDE.md` | Update tool count and implementation status |

## Future: Channels Integration

When Claude Code's channels API matures on Windows (currently blocked by stdio transport reliability — see project memory `reference_channels_api.md`), the chat sidebar can be upgraded to push messages directly into Claude Code's session via channel notifications instead of polling via `tandem_checkInbox`. The Y.Map('chat') data model stays the same — only the delivery mechanism changes.

## Testing

- Unit tests for ChatMessage read/write on Y.Map('chat')
- Unit test for `generateMessageId()` produces `msg_`-prefixed unique IDs
- Unit test for `tandem_checkInbox` returning chat messages and marking them read
- Unit test for `tandem_checkInbox` with `documentId` param — verify chat is always session-scoped, annotations are document-scoped
- Unit test for `tandem_reply` writing to Y.Map('chat') with correct fields
- Integration test: verify `afterUnloadDocument` cleans up `documents` map
- Integration test: MCP edit after browser disconnect/reconnect → edit appears in browser
- Integration test: ctrl doc session persistence — save and restore chat history
- Manual browser test: send message with selection, verify anchor renders, click anchor scrolls editor
- Manual test: conversation spanning multiple documents, verify documentId badges
- Manual test: verify `react-markdown` renders Claude responses safely (no script execution)
