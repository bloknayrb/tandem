# Chat Sidebar + Edit Sync Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix edit sync so Claude's mutations reliably appear in the browser, and add a chat sidebar for direct user↔Claude messaging within Tandem.

**Architecture:** Session-scoped chat via Y.Map('chat') on the `__tandem_ctrl__` Y.Doc. Edit sync fixed by cleaning up stale Y.Doc references when Hocuspocus unloads documents. New `tandem_reply` MCP tool (tool #26) for Claude responses. ChatPanel React component with selection-aware message input.

**Tech Stack:** Yjs, Hocuspocus v2, MCP SDK, React, Tiptap, react-markdown, vitest

**Spec:** `docs/superpowers/specs/2026-03-23-chat-sidebar-and-edit-sync-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/server/yjs/provider.ts` | Y.Doc lifecycle — add `afterUnloadDocument` hook |
| `src/shared/types.ts` | Add `ChatMessage` interface |
| `src/shared/utils.ts` | Add `generateMessageId()` |
| `src/server/mcp/awareness.ts` | Extend `tandem_checkInbox`, add `tandem_reply` |
| `src/server/mcp/document.ts` | Update `saveCurrentSession` to include ctrl doc |
| `src/server/session/manager.ts` | Add `saveCtrlSession` / `loadCtrlSession` |
| `src/client/panels/ChatPanel.tsx` | New — chat sidebar UI |
| `src/client/App.tsx` | Wire ChatPanel, observe Y.Map('chat') |
| `src/client/App.css` | Chat panel styles |
| `package.json` | Add `react-markdown` |
| `tests/server/provider.test.ts` | Tests for afterUnloadDocument |
| `tests/server/chat.test.ts` | Tests for chat read/write/reply |

---

### Task 1: Edit Sync Fix — afterUnloadDocument hook

**Files:**
- Modify: `src/server/yjs/provider.ts:29-68`
- Create: `tests/server/provider.test.ts`

- [ ] **Step 1: Write failing test for stale doc cleanup**

```typescript
// tests/server/provider.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';

// We test the documents map behavior directly since Hocuspocus hooks
// are called by Hocuspocus internals. We simulate the lifecycle.
describe('afterUnloadDocument cleanup', () => {
  // Import the module functions — they operate on the shared `documents` Map
  let getOrCreateDocument: (name: string) => Y.Doc;
  let getDocument: (name: string) => Y.Doc | undefined;

  beforeEach(async () => {
    // Dynamic import to get fresh module state per test
    // Note: vitest module cache means we need resetModules or test the exports
    const mod = await import('../../src/server/yjs/provider.js');
    getOrCreateDocument = mod.getOrCreateDocument;
    getDocument = mod.getDocument;
  });

  it('getOrCreateDocument creates a new doc if none exists', () => {
    const doc = getOrCreateDocument('test-room');
    expect(doc).toBeInstanceOf(Y.Doc);
    expect(getDocument('test-room')).toBe(doc);
  });

  it('getOrCreateDocument returns existing doc', () => {
    const doc1 = getOrCreateDocument('test-room');
    const doc2 = getOrCreateDocument('test-room');
    expect(doc1).toBe(doc2);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `npx vitest run tests/server/provider.test.ts`
Expected: PASS — these test existing behavior

- [ ] **Step 3: Add afterUnloadDocument hook and removeDocument export**

In `src/server/yjs/provider.ts`, add a `removeDocument` function and add the `afterUnloadDocument` hook to `startHocuspocus`:

```typescript
// Add after getOrCreateDocument (line 27):

/**
 * Remove a document from the map. Called by afterUnloadDocument when
 * Hocuspocus destroys a room's doc after all clients disconnect.
 */
export function removeDocument(name: string): boolean {
  return documents.delete(name);
}
```

Add the hook inside the Hocuspocus config object (after `onLoadDocument`, before the closing `});`):

```typescript
    async afterUnloadDocument({ documentName }) {
      if (documents.has(documentName)) {
        documents.delete(documentName);
        console.error(`[Hocuspocus] Unloaded document from map: ${documentName}`);
      }
    },
```

- [ ] **Step 4: Write test for removeDocument**

Add to `tests/server/provider.test.ts`:

```typescript
  it('removeDocument clears the map entry', async () => {
    const mod = await import('../../src/server/yjs/provider.js');
    mod.getOrCreateDocument('room-to-remove');
    expect(mod.getDocument('room-to-remove')).toBeDefined();
    const removed = mod.removeDocument('room-to-remove');
    expect(removed).toBe(true);
    expect(mod.getDocument('room-to-remove')).toBeUndefined();
  });

  it('getOrCreateDocument creates fresh doc after removeDocument', async () => {
    const mod = await import('../../src/server/yjs/provider.js');
    const doc1 = mod.getOrCreateDocument('recycled-room');
    mod.removeDocument('recycled-room');
    const doc2 = mod.getOrCreateDocument('recycled-room');
    expect(doc2).not.toBe(doc1);
    expect(doc2).toBeInstanceOf(Y.Doc);
  });
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/server/provider.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/yjs/provider.ts tests/server/provider.test.ts
git commit -m "fix(server): add afterUnloadDocument hook to clean up stale Y.Doc refs

Hocuspocus destroys its doc when all browsers disconnect, but our
documents map retained the dead reference. MCP edits then mutated a
destroyed doc and were lost on reconnect."
```

---

### Task 2: ChatMessage type and generateMessageId

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/utils.ts`
- Create: `tests/server/chat.test.ts`

- [ ] **Step 1: Add ChatMessage to types.ts**

Add at end of `src/shared/types.ts` (after `SessionData` interface, line 124):

```typescript
/** Chat message between user and Claude, stored in Y.Map('chat') on __tandem_ctrl__ */
export interface ChatMessage {
  id: string;
  author: 'user' | 'claude';
  text: string;
  timestamp: number;
  documentId?: string;
  anchor?: {
    from: number;
    to: number;
    textSnapshot: string;
  };
  replyTo?: string;
  read: boolean;
}
```

- [ ] **Step 2: Add generateMessageId to utils.ts**

Add to `src/shared/utils.ts`:

```typescript
/** Generate a unique chat message ID. */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
```

- [ ] **Step 3: Write tests for generateMessageId**

Create `tests/server/chat.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateMessageId } from '../../src/shared/utils.js';

describe('generateMessageId', () => {
  it('produces msg_ prefixed IDs', () => {
    const id = generateMessageId();
    expect(id).toMatch(/^msg_\d+_[a-z0-9]+$/);
  });

  it('produces unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateMessageId()));
    expect(ids.size).toBe(100);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/server/chat.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/utils.ts tests/server/chat.test.ts
git commit -m "feat(shared): add ChatMessage type and generateMessageId utility"
```

---

### Task 3: Extend tandem_checkInbox to read chat messages

**Files:**
- Modify: `src/server/mcp/awareness.ts:1-173`

- [ ] **Step 1: Write failing test for checkInbox chat integration**

Add to `tests/server/chat.test.ts`:

```typescript
import * as Y from 'yjs';
import { getOrCreateDocument } from '../../src/server/yjs/provider.js';
import type { ChatMessage } from '../../src/shared/types.js';

describe('tandem_checkInbox chat messages', () => {
  it('reads unread user messages from __tandem_ctrl__ chat map', () => {
    const ctrlDoc = getOrCreateDocument('__tandem_ctrl__');
    const chatMap = ctrlDoc.getMap('chat');

    const msg: ChatMessage = {
      id: 'msg_test_001',
      author: 'user',
      text: 'Look at this paragraph',
      timestamp: Date.now(),
      documentId: 'test-doc',
      read: false,
    };
    chatMap.set(msg.id, msg);

    // Read the map and filter for unread user messages
    const unread: ChatMessage[] = [];
    chatMap.forEach((value) => {
      const m = value as ChatMessage;
      if (m.author === 'user' && !m.read) {
        unread.push(m);
      }
    });

    expect(unread).toHaveLength(1);
    expect(unread[0].text).toBe('Look at this paragraph');
  });

  it('marks messages as read after processing', () => {
    const ctrlDoc = getOrCreateDocument('__tandem_ctrl__');
    const chatMap = ctrlDoc.getMap('chat');

    const msg: ChatMessage = {
      id: 'msg_test_002',
      author: 'user',
      text: 'Check this section',
      timestamp: Date.now(),
      read: false,
    };
    chatMap.set(msg.id, msg);

    // Simulate marking as read
    const existing = chatMap.get(msg.id) as ChatMessage;
    chatMap.set(msg.id, { ...existing, read: true });

    const afterRead = chatMap.get(msg.id) as ChatMessage;
    expect(afterRead.read).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/server/chat.test.ts`
Expected: PASS (these test Y.Map behavior directly)

- [ ] **Step 3: Extend tandem_checkInbox in awareness.ts**

In `src/server/mcp/awareness.ts`, add the chat reading logic. After line 7 add import:

```typescript
import type { Annotation, ChatMessage } from '../../shared/types.js';
```

Inside the `tandem_checkInbox` handler (after the annotation loop at line 109, before the activity section at line 111), add:

```typescript
      // Bucket 3: unread chat messages from __tandem_ctrl__
      const ctrlDoc = getOrCreateDocument('__tandem_ctrl__');
      const chatMap = ctrlDoc.getMap('chat');
      const chatMessages: Array<Omit<ChatMessage, 'read' | 'author'>> = [];

      chatMap.forEach((value) => {
        const msg = value as ChatMessage;
        if (msg.author === 'user' && !msg.read) {
          chatMessages.push({
            id: msg.id,
            text: msg.text,
            timestamp: msg.timestamp,
            ...(msg.documentId ? { documentId: msg.documentId } : {}),
            ...(msg.anchor ? { anchor: msg.anchor } : {}),
            ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          });
          // Mark as read
          chatMap.set(msg.id, { ...msg, read: true });
        }
      });
```

Update the summary builder (around line 126) to include chat count:

```typescript
      if (chatMessages.length > 0) {
        parts.push(`${chatMessages.length} new chat message${chatMessages.length > 1 ? 's' : ''}`);
      }
```

Update the `hasNew` check (around line 149):

```typescript
      const hasNew = userActions.length > 0 || userResponses.length > 0 || chatMessages.length > 0;
```

Add `chatMessages` to the return object (around line 151):

```typescript
      return mcpSuccess({
        summary,
        hasNew,
        userActions,
        userResponses,
        chatMessages,
        activity: { /* ...unchanged... */ },
      });
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp/awareness.ts tests/server/chat.test.ts
git commit -m "feat(server): extend tandem_checkInbox to surface chat messages

Reads unread user messages from Y.Map('chat') on __tandem_ctrl__.
Marks them read after surfacing. Chat is always session-scoped —
documentId param only scopes the annotations bucket."
```

---

### Task 4: Add tandem_reply tool

**Files:**
- Modify: `src/server/mcp/awareness.ts`

- [ ] **Step 1: Write failing test for tandem_reply**

Add to `tests/server/chat.test.ts`:

```typescript
import { generateMessageId } from '../../src/shared/utils.js';

describe('tandem_reply', () => {
  it('writes a claude message to __tandem_ctrl__ chat map', () => {
    const ctrlDoc = getOrCreateDocument('__tandem_ctrl__');
    const chatMap = ctrlDoc.getMap('chat');

    // Simulate what tandem_reply does
    const id = generateMessageId();
    const reply: ChatMessage = {
      id,
      author: 'claude',
      text: 'I see the issue in that paragraph. Here is a suggestion...',
      timestamp: Date.now(),
      read: true, // Claude's own messages are always read
    };
    chatMap.set(id, reply);

    const stored = chatMap.get(id) as ChatMessage;
    expect(stored.author).toBe('claude');
    expect(stored.text).toContain('I see the issue');
    expect(stored.read).toBe(true);
  });

  it('links reply to original message via replyTo', () => {
    const ctrlDoc = getOrCreateDocument('__tandem_ctrl__');
    const chatMap = ctrlDoc.getMap('chat');

    const originalId = 'msg_original_123';
    const replyId = generateMessageId();
    const reply: ChatMessage = {
      id: replyId,
      author: 'claude',
      text: 'Response to your question',
      timestamp: Date.now(),
      replyTo: originalId,
      read: true,
    };
    chatMap.set(replyId, reply);

    const stored = chatMap.get(replyId) as ChatMessage;
    expect(stored.replyTo).toBe(originalId);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/server/chat.test.ts`
Expected: PASS

- [ ] **Step 3: Add tandem_reply tool registration**

In `src/server/mcp/awareness.ts`, add import at top:

```typescript
import { generateMessageId } from '../../shared/utils.js';
import { getActiveDocId } from './document.js';
```

Add the tool registration inside `registerAwarenessTools`, after the `tandem_checkInbox` tool (after line 164):

```typescript
  server.tool(
    'tandem_reply',
    'Send a chat message to the user in the Tandem sidebar. Use this to respond to chat messages from tandem_checkInbox.',
    {
      text: z.string().describe('Your message to the user'),
      replyTo: z.string().optional().describe('ID of the user message you are replying to'),
      documentId: z.string().optional().describe('Document context for this reply (defaults to active document)'),
    },
    async ({ text, replyTo, documentId }) => {
      const ctrlDoc = getOrCreateDocument('__tandem_ctrl__');
      const chatMap = ctrlDoc.getMap('chat');

      const id = generateMessageId();
      const docId = documentId ?? getActiveDocId() ?? undefined;

      const msg: ChatMessage = {
        id,
        author: 'claude',
        text,
        timestamp: Date.now(),
        ...(docId ? { documentId: docId } : {}),
        ...(replyTo ? { replyTo } : {}),
        read: true,
      };

      chatMap.set(id, msg);

      return mcpSuccess({ sent: true, messageId: id });
    }
  );
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp/awareness.ts tests/server/chat.test.ts
git commit -m "feat(server): add tandem_reply tool for Claude→user chat messages

Tool #26. Writes to Y.Map('chat') on __tandem_ctrl__ with author
'claude'. Supports replyTo for threading and optional documentId
for context."
```

---

### Task 5: Ctrl doc session persistence

**Files:**
- Modify: `src/server/session/manager.ts`
- Modify: `src/server/mcp/document.ts:74-80`

- [ ] **Step 1: Add ctrl doc save/load to session manager**

In `src/server/session/manager.ts`, add after `deleteSession` (line 92):

```typescript
const CTRL_SESSION_KEY = '__tandem_ctrl__';

/** Save the __tandem_ctrl__ Y.Doc (chat history) */
export async function saveCtrlSession(doc: Y.Doc): Promise<void> {
  if (!sessionDirReady) {
    await fs.mkdir(SESSION_DIR, { recursive: true });
    sessionDirReady = true;
  }

  // Prune chat to newest 200 messages before saving
  const chatMap = doc.getMap('chat');
  const entries: Array<{ id: string; timestamp: number }> = [];
  chatMap.forEach((value, key) => {
    const msg = value as { timestamp: number };
    entries.push({ id: key, timestamp: msg.timestamp });
  });
  if (entries.length > 200) {
    entries.sort((a, b) => a.timestamp - b.timestamp);
    const toDelete = entries.slice(0, entries.length - 200);
    for (const entry of toDelete) {
      chatMap.delete(entry.id);
    }
  }

  const state = Y.encodeStateAsUpdate(doc);
  const ydocState = Buffer.from(state).toString('base64');

  const data = { ydocState, lastAccessed: Date.now() };
  const sessionPath = path.join(SESSION_DIR, `${CTRL_SESSION_KEY}.json`);
  await fs.writeFile(sessionPath, JSON.stringify(data), 'utf-8');
}

/** Load the __tandem_ctrl__ session if it exists */
export async function loadCtrlSession(): Promise<string | null> {
  const sessionPath = path.join(SESSION_DIR, `${CTRL_SESSION_KEY}.json`);
  try {
    const content = await fs.readFile(sessionPath, 'utf-8');
    const data = JSON.parse(content);
    return data.ydocState ?? null;
  } catch {
    return null;
  }
}

/** Restore a __tandem_ctrl__ Y.Doc from base64 state */
export function restoreCtrlDoc(doc: Y.Doc, base64State: string): void {
  const state = Buffer.from(base64State, 'base64');
  Y.applyUpdate(doc, new Uint8Array(state));
}
```

- [ ] **Step 2: Update saveCurrentSession to include ctrl doc**

In `src/server/mcp/document.ts`, update the import (line 17):

```typescript
import {
  saveSession, loadSession, restoreYDoc, sourceFileChanged,
  startAutoSave, stopAutoSave, isAutoSaveRunning,
  saveCtrlSession, loadCtrlSession, restoreCtrlDoc,
} from '../session/manager.js';
```

Update `saveCurrentSession` (line 75-80):

```typescript
export async function saveCurrentSession(): Promise<void> {
  for (const [id, state] of openDocs) {
    const doc = getOrCreateDocument(id);
    await saveSession(state.filePath, state.format, doc);
  }
  // Also save the ctrl doc (chat history)
  const ctrlDoc = getOrCreateDocument('__tandem_ctrl__');
  await saveCtrlSession(ctrlDoc);
}
```

- [ ] **Step 3: Add ctrl doc restore at startup**

Add a new exported function in `src/server/mcp/document.ts` (after `saveCurrentSession`):

```typescript
/** Restore __tandem_ctrl__ chat history from session file if available. */
export async function restoreCtrlSession(): Promise<void> {
  const saved = await loadCtrlSession();
  if (saved) {
    const ctrlDoc = getOrCreateDocument('__tandem_ctrl__');
    restoreCtrlDoc(ctrlDoc, saved);
    console.error('[Tandem] Restored chat history from session');
  }
}
```

Then in `src/server/index.ts`, import and call it at startup. Add import:

```typescript
import { saveCurrentSession, restoreCtrlSession } from './mcp/document.js';
```

Call it in `main()` after session cleanup (after line 81):

```typescript
  // Restore chat history from previous session
  restoreCtrlSession().catch(() => {});
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/session/manager.ts src/server/mcp/document.ts src/server/index.ts
git commit -m "feat(server): persist __tandem_ctrl__ chat history across restarts

Saves ctrl doc Y.Doc state to session file. Prunes to newest 200
messages on save. Restores on next server start via restoreCtrlSession()."
```

---

### Task 6: Install react-markdown

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependency**

Run: `npm install react-markdown`

- [ ] **Step 2: Verify it installed**

Run: `node -e "require('react-markdown')"`
Expected: No error

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add react-markdown for chat sidebar message rendering"
```

---

### Task 7: ChatPanel component

**Files:**
- Create: `src/client/panels/ChatPanel.tsx`

- [ ] **Step 1: Create ChatPanel component**

```tsx
// src/client/panels/ChatPanel.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import ReactMarkdown from 'react-markdown';
import * as Y from 'yjs';
import { pmPosToFlatOffset } from '../editor/extensions/awareness';
import { flatOffsetToPmPos } from '../editor/extensions/annotation';
import { generateMessageId } from '../../shared/utils';
import type { ChatMessage } from '../../shared/types';

interface ChatPanelProps {
  ctrlYdoc: Y.Doc | null;
  editor: TiptapEditor | null;
  activeDocId: string | null;
  openDocs: Array<{ id: string; fileName: string }>;
}

export function ChatPanel({ ctrlYdoc, editor, activeDocId, openDocs }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [capturedAnchor, setCapturedAnchor] = useState<{
    from: number; to: number; textSnapshot: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Observe Y.Map('chat') for changes
  useEffect(() => {
    if (!ctrlYdoc) return;
    const chatMap = ctrlYdoc.getMap('chat');

    const observer = () => {
      const msgs: ChatMessage[] = [];
      chatMap.forEach((value) => {
        msgs.push(value as ChatMessage);
      });
      msgs.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
      setMessages(msgs);
    };

    chatMap.observe(observer);
    observer(); // Initial load
    return () => chatMap.unobserve(observer);
  }, [ctrlYdoc]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Capture selection on mousedown of send button (before editor loses focus)
  const captureSelection = useCallback(() => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) {
      setCapturedAnchor(null);
      return;
    }
    const flatFrom = pmPosToFlatOffset(editor.state.doc, from);
    const flatTo = pmPosToFlatOffset(editor.state.doc, to);
    const text = editor.state.doc.textBetween(from, to, '\n');
    setCapturedAnchor({
      from: flatFrom,
      to: flatTo,
      textSnapshot: text.length > 200 ? text.slice(0, 197) + '...' : text,
    });
  }, [editor]);

  const sendMessage = useCallback(() => {
    if (!ctrlYdoc || !inputText.trim()) return;
    const chatMap = ctrlYdoc.getMap('chat');

    const msg: ChatMessage = {
      id: generateMessageId(),
      author: 'user',
      text: inputText.trim(),
      timestamp: Date.now(),
      ...(activeDocId ? { documentId: activeDocId } : {}),
      ...(capturedAnchor ? { anchor: capturedAnchor } : {}),
      read: false,
    };

    chatMap.set(msg.id, msg);
    setInputText('');
    setCapturedAnchor(null);
  }, [ctrlYdoc, inputText, activeDocId, capturedAnchor]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const scrollToAnchor = useCallback((anchor: { from: number; to: number }, docId?: string) => {
    if (!editor || (docId && docId !== activeDocId)) return;
    try {
      const pmFrom = flatOffsetToPmPos(editor.state.doc, anchor.from);
      const pmTo = flatOffsetToPmPos(editor.state.doc, anchor.to);
      editor.chain().focus().setTextSelection({ from: pmFrom, to: pmTo }).scrollIntoView().run();
    } catch {
      // Anchor may be stale — ignore silently
    }
  }, [editor, activeDocId]);

  const getDocFileName = (docId?: string) => {
    if (!docId) return null;
    const doc = openDocs.find(d => d.id === docId);
    return doc?.fileName ?? null;
  };

  const unreadCount = messages.filter(m => m.author === 'claude' && !m.read).length;

  return (
    <div style={{
      width: '320px',
      borderLeft: '1px solid #e5e7eb',
      display: 'flex',
      flexDirection: 'column',
      background: '#fafafa',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #e5e7eb',
        fontWeight: 600,
        fontSize: '14px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        Chat
        {unreadCount > 0 && (
          <span style={{
            background: '#6366f1',
            color: 'white',
            borderRadius: '10px',
            padding: '2px 8px',
            fontSize: '11px',
          }}>
            {unreadCount}
          </span>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
        {messages.length === 0 && (
          <div style={{ color: '#9ca3af', fontSize: '13px', textAlign: 'center', marginTop: '24px' }}>
            No messages yet. Select text and send a message to Claude.
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} style={{
            marginBottom: '12px',
            padding: '8px 12px',
            borderRadius: '8px',
            background: msg.author === 'user' ? '#eef2ff' : '#ffffff',
            border: '1px solid ' + (msg.author === 'user' ? '#c7d2fe' : '#e5e7eb'),
            fontSize: '13px',
          }}>
            {/* Author + doc badge */}
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '4px' }}>
              <span style={{
                fontWeight: 600,
                fontSize: '11px',
                color: msg.author === 'claude' ? '#6366f1' : '#374151',
                textTransform: 'uppercase',
              }}>
                {msg.author}
              </span>
              {msg.documentId && (
                <span style={{
                  fontSize: '10px',
                  color: '#6b7280',
                  background: '#f3f4f6',
                  padding: '1px 6px',
                  borderRadius: '4px',
                }}>
                  {getDocFileName(msg.documentId) ?? msg.documentId}
                </span>
              )}
              <span style={{ fontSize: '10px', color: '#9ca3af', marginLeft: 'auto' }}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>

            {/* Anchor quote */}
            {msg.anchor && (
              <div
                onClick={() => scrollToAnchor(msg.anchor!, msg.documentId)}
                style={{
                  padding: '4px 8px',
                  marginBottom: '6px',
                  borderLeft: '3px solid #c7d2fe',
                  background: '#f5f3ff',
                  fontSize: '12px',
                  color: '#4338ca',
                  cursor: 'pointer',
                  borderRadius: '0 4px 4px 0',
                  maxHeight: '60px',
                  overflow: 'hidden',
                }}
                title="Click to scroll to this text"
              >
                {msg.anchor.textSnapshot.slice(0, 80)}
                {msg.anchor.textSnapshot.length > 80 ? '...' : ''}
              </div>
            )}

            {/* Message text */}
            {msg.author === 'claude' ? (
              <div className="chat-markdown">
                <ReactMarkdown>{msg.text}</ReactMarkdown>
              </div>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {msg.text}
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Anchor indicator */}
      {capturedAnchor && (
        <div style={{
          padding: '4px 12px',
          background: '#eef2ff',
          borderTop: '1px solid #c7d2fe',
          fontSize: '11px',
          color: '#4338ca',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>
            with selection: "{capturedAnchor.textSnapshot.slice(0, 40)}
            {capturedAnchor.textSnapshot.length > 40 ? '...' : ''}"
          </span>
          <button
            onClick={() => setCapturedAnchor(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#6b7280',
              fontSize: '14px',
            }}
          >
            x
          </button>
        </div>
      )}

      {/* Input area */}
      <div style={{
        padding: '8px 12px',
        borderTop: '1px solid #e5e7eb',
        display: 'flex',
        gap: '8px',
      }}>
        <textarea
          ref={inputRef}
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Claude..."
          rows={2}
          style={{
            flex: 1,
            padding: '8px',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '13px',
            resize: 'none',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <button
          onMouseDown={captureSelection}
          onClick={sendMessage}
          disabled={!inputText.trim()}
          style={{
            padding: '8px 12px',
            background: inputText.trim() ? '#6366f1' : '#d1d5db',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: inputText.trim() ? 'pointer' : 'default',
            fontSize: '13px',
            fontWeight: 500,
            alignSelf: 'flex-end',
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 3: Commit**

```bash
git add src/client/panels/ChatPanel.tsx
git commit -m "feat(client): add ChatPanel component for user-Claude messaging

Session-scoped chat sidebar with selection anchoring, markdown
rendering for Claude responses, auto-scroll, and unread badge."
```

---

### Task 8: Wire ChatPanel into App.tsx

**Files:**
- Modify: `src/client/App.tsx`

- [ ] **Step 1: Add imports and state**

At top of `App.tsx`, add import:

```typescript
import { ChatPanel } from './panels/ChatPanel';
```

Inside the `App` component, add state for panel toggle (after line 51):

```typescript
  const [showChat, setShowChat] = useState(false);
```

- [ ] **Step 2: Add ChatPanel to the layout**

Replace the SidePanel block (lines 365-377) with a panel container that toggles between them:

```tsx
        {showChat ? (
          <ChatPanel
            ctrlYdoc={bootstrapRef.current?.ydoc ?? null}
            editor={editorRef.current}
            activeDocId={activeTabId}
            openDocs={tabs.map(t => ({ id: t.id, fileName: t.fileName }))}
          />
        ) : (
          <SidePanel
            annotations={visibleAnnotations}
            editor={editorRef.current}
            ydoc={activeTab?.ydoc ?? null}
            heldCount={heldCount}
            interruptionMode={interruptionMode}
            onModeChange={setInterruptionMode}
            reviewMode={reviewMode}
            onToggleReviewMode={toggleReviewMode}
            onExitReviewMode={exitReviewMode}
            activeAnnotationId={activeAnnotationId}
            onActiveAnnotationChange={setActiveAnnotationId}
          />
        )}
```

- [ ] **Step 3: Add panel toggle to StatusBar or toolbar area**

Add a toggle button above the panels container. Inside the `<div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>` (line 346), before the editor div, or right after the editor div and before the panel — add toggle buttons:

After the SidePanel/ChatPanel block, add nothing — instead, add the toggle INSIDE the panel header area. A simpler approach: add toggle buttons just before the panel in the flex container.

Actually, the cleanest approach is to add toggle tabs right above the panel area. After line 345 (`<div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>`), wrap the panel side with toggle tabs:

Replace the entire right-side panel section with:

```tsx
        <div style={{ display: 'flex', flexDirection: 'column', width: '300px', borderLeft: '1px solid #e5e7eb' }}>
          {/* Panel toggle tabs */}
          <div style={{
            display: 'flex',
            borderBottom: '1px solid #e5e7eb',
            background: '#f9fafb',
          }}>
            <button
              onClick={() => setShowChat(false)}
              style={{
                flex: 1,
                padding: '8px',
                fontSize: '12px',
                fontWeight: showChat ? 400 : 600,
                border: 'none',
                borderBottom: showChat ? 'none' : '2px solid #6366f1',
                background: 'transparent',
                cursor: 'pointer',
                color: showChat ? '#6b7280' : '#6366f1',
              }}
            >
              Annotations
            </button>
            <button
              onClick={() => setShowChat(true)}
              style={{
                flex: 1,
                padding: '8px',
                fontSize: '12px',
                fontWeight: showChat ? 600 : 400,
                border: 'none',
                borderBottom: showChat ? '2px solid #6366f1' : 'none',
                background: 'transparent',
                cursor: 'pointer',
                color: showChat ? '#6366f1' : '#6b7280',
              }}
            >
              Chat
            </button>
          </div>
          {/* Panel content */}
          {showChat ? (
            <ChatPanel
              ctrlYdoc={bootstrapRef.current?.ydoc ?? null}
              editor={editorRef.current}
              activeDocId={activeTabId}
              openDocs={tabs.map(t => ({ id: t.id, fileName: t.fileName }))}
            />
          ) : (
            <SidePanel
              annotations={visibleAnnotations}
              editor={editorRef.current}
              ydoc={activeTab?.ydoc ?? null}
              heldCount={heldCount}
              interruptionMode={interruptionMode}
              onModeChange={setInterruptionMode}
              reviewMode={reviewMode}
              onToggleReviewMode={toggleReviewMode}
              onExitReviewMode={exitReviewMode}
              activeAnnotationId={activeAnnotationId}
              onActiveAnnotationChange={setActiveAnnotationId}
            />
          )}
        </div>
```

Note: Both panels must fill their container. Update ChatPanel's outermost div to `width: '100%'` (not `320px`). Also update SidePanel's outermost div from `width: '300px'` to `width: '100%'` (`SidePanel.tsx:225`). The parent wrapper controls the panel width at `300px`.

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit && npx vite build`
Expected: Builds successfully

- [ ] **Step 5: Commit**

```bash
git add src/client/App.tsx src/client/panels/ChatPanel.tsx
git commit -m "feat(client): wire ChatPanel into App with Annotations/Chat toggle tabs"
```

---

### Task 9: Update documentation

**Files:**
- Modify: `docs/mcp-tools.md`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add tandem_reply to mcp-tools.md**

Add a new section for `tandem_reply` following the existing format in `docs/mcp-tools.md`. Document params (`text`, `replyTo?`, `documentId?`), return shape (`{ sent, messageId }`), and a usage example.

- [ ] **Step 2: Update docs/architecture.md**

Add a "Chat Data Flow" section describing:
- Y.Map('chat') on `__tandem_ctrl__` Y.Doc
- User message flow: ChatPanel → Y.Map → Hocuspocus → server → tandem_checkInbox
- Claude reply flow: tandem_reply → Y.Map → Hocuspocus → browser → ChatPanel
- Session persistence: saveCtrlSession/restoreCtrlSession lifecycle

- [ ] **Step 3: Update CLAUDE.md**

Update the tool count references (grep for "24" and "25" and update to "26"). Update the implementation status section to reflect the chat sidebar and edit sync fix.

- [ ] **Step 4: Commit**

```bash
git add docs/mcp-tools.md docs/architecture.md CLAUDE.md
git commit -m "docs: document tandem_reply tool, chat data flow, and update implementation status"
```

---

### Task 10: Manual browser testing

This task is not automated — it requires running the full stack.

- [ ] **Step 1: Start the server**

Run: `npm run dev:standalone`

- [ ] **Step 2: Test edit sync fix**

1. Open Tandem in Chrome
2. Use Claude Code to `tandem_open` a test file
3. Verify content appears in browser
4. Close browser tab (triggers afterUnloadDocument)
5. Use Claude Code to `tandem_edit` the document
6. Re-open browser tab
7. Verify the edit appears

- [ ] **Step 3: Test chat sidebar**

1. Click "Chat" tab in the panel
2. Select text in the editor
3. Click "Send" — verify selection badge appears and message sends
4. Verify message appears in chat panel
5. In Claude Code, call `tandem_checkInbox` — verify `chatMessages` contains the message
6. Call `tandem_reply` with a response
7. Verify Claude's response appears in the chat panel with markdown rendering

- [ ] **Step 4: Test multi-document context**

1. Open two documents with `tandem_open`
2. Send chat messages from each document's tab
3. Verify `documentId` badges appear on messages
4. Verify clicking a doc badge when viewing the other tab (no-op for now, but doesn't crash)

- [ ] **Step 5: Test persistence**

1. Send a few chat messages
2. Restart the server (`npm run dev:server`)
3. Reconnect browser
4. Verify chat history persists
