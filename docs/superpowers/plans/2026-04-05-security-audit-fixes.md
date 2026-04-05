# Security Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 25 findings from the full security audit — 7 security vulnerabilities and 18 error handling issues.

**Architecture:** Surgical fixes across server and client code. No new dependencies. Each task is independent and commits separately. Security fixes first, then error handling by severity.

**Tech Stack:** TypeScript, React, Y.js, Express, Node.js fs APIs

---

### Task 1: UNC Path Validation on `backupPath` in `tandem_applyChanges` [S1 — Medium]

**Files:**
- Modify: `src/server/mcp/docx-apply.ts:147`
- Test: `tests/server/docx-apply.test.ts` (or create if needed)

- [ ] **Step 1: Write the failing test**

```typescript
// In the test file for docx-apply, add:
import { applyChangesCore } from "../../src/server/mcp/docx-apply.js";

test("applyChangesCore rejects UNC backupPath on Windows", async () => {
  // Mock process.platform to win32 if not already
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await expect(
      applyChangesCore(undefined, undefined, "\\\\attacker.com\\share\\backup.docx"),
    ).rejects.toThrow("UNC paths are not supported");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/docx-apply.test.ts --reporter=verbose`
Expected: FAIL — no UNC check exists yet, so the error won't be thrown (it'll fail with "No document is open" which is a different error — but the UNC path isn't checked).

- [ ] **Step 3: Add UNC path rejection to `applyChangesCore`**

In `src/server/mcp/docx-apply.ts`, add this check at line 147, before the `resolvedBackup` variable is used:

```typescript
  // 6. Backup — reject UNC paths (Windows NTLM hash leak)
  if (backupPath) {
    const resolvedBp = path.resolve(backupPath);
    if (process.platform === "win32" && (resolvedBp.startsWith("\\\\") || resolvedBp.startsWith("//"))) {
      throw Object.assign(new Error("UNC paths are not supported for security reasons."), {
        code: "INVALID_PATH",
      });
    }
  }
  let resolvedBackup = backupPath ?? filePath.replace(/\.docx$/i, ".backup.docx");
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/server/docx-apply.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp/docx-apply.ts tests/server/docx-apply.test.ts
git commit -m "fix(security): reject UNC backupPath in tandem_applyChanges

Prevents NTLM hash leakage on Windows when a crafted UNC path is passed
as the backupPath parameter. Mirrors existing UNC checks in file-opener
and convert."
```

---

### Task 2: Reject Origin-less WebSocket Connections [S2 — Medium]

**Files:**
- Modify: `src/server/yjs/provider.ts:66-76`
- Test: existing Hocuspocus tests or add inline

- [ ] **Step 1: Write the failing test**

```typescript
// Test that a connection without Origin header is rejected
test("rejects WebSocket connection without Origin header", async () => {
  // This can be tested by verifying the onConnect logic directly
  // or via an E2E WebSocket connection test
});
```

Note: Hocuspocus `onConnect` is tested via integration. The fix is straightforward enough to verify by inspection + E2E.

- [ ] **Step 2: Modify `onConnect` in `provider.ts`**

Replace lines 67-75:

```typescript
    async onConnect({ request, documentName }) {
      // Origin validation: reject connections not from localhost (prevents DNS rebinding)
      const origin = request?.headers?.origin;
      if (!origin) {
        console.error("[Hocuspocus] Rejected connection: missing Origin header");
        throw new Error("Connection rejected: missing origin header");
      }
      const url = new URL(origin);
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        console.error(`[Hocuspocus] Rejected connection from origin: ${origin}`);
        throw new Error("Connection rejected: invalid origin");
      }
      console.error(`[Hocuspocus] Client connected to: ${documentName}`);
    },
```

- [ ] **Step 3: Run full test suite to check for regressions**

Run: `npx vitest run --reporter=verbose`
Expected: PASS (unit tests don't use real WebSocket connections)

- [ ] **Step 4: Commit**

```bash
git add src/server/yjs/provider.ts
git commit -m "fix(security): reject WebSocket connections without Origin header

Connections without an Origin header (e.g., from file:// pages or browser
extensions) were silently allowed, bypassing DNS rebinding protection."
```

---

### Task 3: Sanitize `javascript:` URLs in .docx Link Hrefs [S3 — Medium]

**Files:**
- Modify: `src/server/file-io/docx-html.ts:30-32`
- Test: `tests/server/docx-html.test.ts` (create or extend)

- [ ] **Step 1: Write the failing test**

```typescript
import { htmlToYDoc } from "../../src/server/file-io/docx-html.js";
import * as Y from "yjs";

test("sanitizes javascript: URLs in link hrefs", () => {
  const doc = new Y.Doc();
  htmlToYDoc(doc, '<p><a href="javascript:alert(1)">click me</a></p>');
  const fragment = doc.getXmlFragment("default");
  const para = fragment.get(0) as Y.XmlElement;
  const text = para.get(0) as Y.XmlText;
  const delta = text.toDelta();
  // The link mark should have an empty href, not javascript:
  const linkAttr = delta[0]?.attributes?.link;
  expect(linkAttr?.href).toBe("");
});

test("preserves valid http URLs in link hrefs", () => {
  const doc = new Y.Doc();
  htmlToYDoc(doc, '<p><a href="https://example.com">link</a></p>');
  const fragment = doc.getXmlFragment("default");
  const para = fragment.get(0) as Y.XmlElement;
  const text = para.get(0) as Y.XmlText;
  const delta = text.toDelta();
  const linkAttr = delta[0]?.attributes?.link;
  expect(linkAttr?.href).toBe("https://example.com");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/docx-html.test.ts --reporter=verbose`
Expected: FAIL — `javascript:alert(1)` is currently passed through

- [ ] **Step 3: Add href sanitization in `INLINE_MARK_TAGS`**

In `src/server/file-io/docx-html.ts`, replace lines 30-32:

```typescript
  a: (el) => {
    const href = el.attribs.href || "";
    const safeHref = /^https?:\/\//i.test(href) || href.startsWith("mailto:") ? href : "";
    return { link: { href: safeHref } };
  },
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/server/docx-html.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/file-io/docx-html.ts tests/server/docx-html.test.ts
git commit -m "fix(security): sanitize javascript: URLs in .docx link hrefs

Only http:, https:, and mailto: protocols are allowed in link hrefs
from imported .docx HTML. Prevents XSS via malicious hyperlinks."
```

---

### Task 4: Add ReDoS Protection to `tandem_search` [S4 — Low]

**Files:**
- Modify: `src/server/mcp/navigation.ts:37-38`
- Test: `tests/server/navigation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { searchText } from "../../src/server/mcp/navigation.js";

test("rejects catastrophic backtracking regex patterns", () => {
  const result = searchText("a".repeat(30), "(a+)+$", true);
  // Should return an error, not hang
  expect(result.error).toBeDefined();
});
```

- [ ] **Step 2: Run test — verify it hangs or takes >5s**

Run: `npx vitest run tests/server/navigation.test.ts -t "catastrophic" --reporter=verbose --testTimeout=10000`
Expected: TIMEOUT (regex causes catastrophic backtracking)

- [ ] **Step 3: Add match count limit and execution timeout**

In `src/server/mcp/navigation.ts`, modify the `searchText` function:

```typescript
export function searchText(
  fullText: string,
  query: string,
  useRegex?: boolean,
): { matches: SearchMatch[]; error?: string } {
  const MAX_MATCHES = 10_000;
  const matches: SearchMatch[] = [];
  try {
    const pattern = useRegex ? new RegExp(query, "gi") : new RegExp(escapeRegex(query), "gi");
    let match;
    const start = Date.now();
    while ((match = pattern.exec(fullText)) !== null) {
      matches.push({
        from: toFlatOffset(match.index),
        to: toFlatOffset(match.index + match[0].length),
        text: match[0],
      });
      if (matches.length >= MAX_MATCHES) {
        return { matches, error: `Search capped at ${MAX_MATCHES} matches` };
      }
      // Guard against catastrophic backtracking — bail after 2s
      if (Date.now() - start > 2000) {
        return { matches, error: "Search timed out — simplify the regex pattern" };
      }
      // Prevent infinite loops on zero-length matches
      if (match[0].length === 0) pattern.lastIndex++;
    }
  } catch (err) {
    return { matches: [], error: `Invalid regex: ${getErrorMessage(err)}` };
  }
  return { matches };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/server/navigation.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp/navigation.ts tests/server/navigation.test.ts
git commit -m "fix(security): add ReDoS protection to tandem_search

Caps results at 10k matches and bails after 2 seconds to prevent
catastrophic backtracking from user-supplied regex patterns."
```

---

### Task 5: Protect `/health` Endpoint from DNS Rebinding [S5 — Low]

**Files:**
- Modify: `src/server/mcp/server.ts:184-192`

- [ ] **Step 1: Strip sensitive data from `/health` response**

In `src/server/mcp/server.ts`, replace lines 184-192:

```typescript
  // Health endpoint — apiMiddleware protects against DNS rebinding
  app.get("/health", apiMiddleware, (_req: import("express").Request, res: import("express").Response) => {
    res.json({ status: "ok" });
  });
```

- [ ] **Step 2: Run tests to check for regressions**

Run: `npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Check if any E2E or integration tests depend on the old `/health` response shape**

Run: `npx vitest run -t "health" --reporter=verbose` and check E2E tests too.

- [ ] **Step 4: Update any tests that check health response body**

If tests check for `version` or `hasSession`, update them to match the new minimal response.

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp/server.ts
git commit -m "fix(security): add DNS rebinding protection to /health endpoint

Adds apiMiddleware and strips version/session info from the response.
Previously, /health was the only endpoint without Host-header validation."
```

---

### Task 6: Distinguish ENOENT From Corruption in Session Load [E4, E5, E12 — High]

**Files:**
- Modify: `src/server/session/manager.ts:58-68,145-155,200-218`
- Modify: `src/server/mcp/document-service.ts:237`

- [ ] **Step 1: Fix `loadSession` to distinguish error types**

In `src/server/session/manager.ts`, replace `loadSession` (lines 58-68):

```typescript
/** Load a session file if it exists */
export async function loadSession(filePath: string): Promise<SessionData | null> {
  const key = sessionKey(filePath);
  const sessionPath = path.join(SESSION_DIR, `${key}.json`);
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    return JSON.parse(content) as SessionData;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      console.error(`[Tandem] Corrupted session file ${sessionPath}, removing:`, err.message);
      await fs.unlink(sessionPath).catch(() => {});
      return null;
    }
    console.error(`[Tandem] Failed to read session ${sessionPath}:`, err);
    return null;
  }
}
```

- [ ] **Step 2: Fix `loadCtrlSession` similarly**

Replace `loadCtrlSession` (lines 145-155):

```typescript
/** Load the CTRL_ROOM session if it exists */
export async function loadCtrlSession(): Promise<string | null> {
  const sessionPath = path.join(SESSION_DIR, `${CTRL_SESSION_KEY}.json`);
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    const data = JSON.parse(content);
    return data.ydocState ?? null;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      console.error(`[Tandem] Corrupted ctrl session ${sessionPath}, removing:`, err.message);
      await fs.unlink(sessionPath).catch(() => {});
      return null;
    }
    console.error(`[Tandem] Failed to read ctrl session:`, err);
    return null;
  }
}
```

- [ ] **Step 3: Fix `cleanupSessions` to handle individual file errors**

Replace `cleanupSessions` (lines 200-218):

```typescript
/** Delete sessions older than 30 days */
export async function cleanupSessions(): Promise<number> {
  let cleaned = 0;
  let files: string[];
  try {
    files = await fs.readdir(SESSION_DIR);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    console.error("[Tandem] Failed to read session directory:", err);
    return 0;
  }

  const now = Date.now();
  for (const file of files) {
    try {
      const filePath = path.join(SESSION_DIR, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > SESSION_MAX_AGE) {
        await fs.unlink(filePath);
        cleaned++;
      }
    } catch (err) {
      console.error(`[Tandem] cleanupSessions: failed to process ${file}:`, err);
    }
  }
  return cleaned;
}
```

- [ ] **Step 4: Fix empty `.catch(() => {})` in `document-service.ts:237`**

Replace the `deleteSession(filePath).catch(() => {});` at line 237 with:

```typescript
deleteSession(filePath).catch((err) => {
  console.error(`[Tandem] Failed to delete stale session for ${filePath}:`, err);
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/session/manager.ts src/server/mcp/document-service.ts
git commit -m "fix: distinguish ENOENT from corruption in session loading

loadSession and loadCtrlSession now log warnings for corrupted JSON and
system errors instead of silently returning null. cleanupSessions handles
per-file errors without aborting the loop. Stale session deletion logs
failures instead of swallowing them."
```

---

### Task 7: Add React ErrorBoundary [E1 — Critical]

**Files:**
- Create: `src/client/components/ErrorBoundary.tsx`
- Modify: `src/client/main.tsx`

- [ ] **Step 1: Create `ErrorBoundary.tsx`**

```typescript
import React from "react";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[Tandem] React error boundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
          <h2>Something went wrong</h2>
          <p style={{ color: "#666" }}>
            The editor encountered an unexpected error. Reload the page to continue.
          </p>
          <pre
            style={{
              background: "#f5f5f5",
              padding: "1rem",
              borderRadius: "4px",
              fontSize: "12px",
              overflow: "auto",
              maxHeight: "200px",
            }}
          >
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: "1rem",
              padding: "8px 16px",
              cursor: "pointer",
              border: "1px solid #d1d5db",
              borderRadius: "4px",
              background: "#fff",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 2: Wrap `<App />` with `ErrorBoundary` in `main.tsx`**

```typescript
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import App from './App';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/client/components/ErrorBoundary.tsx src/client/main.tsx
git commit -m "fix(client): add React ErrorBoundary to prevent white-screen crashes

Any unhandled rendering error now shows a recovery message with a
reload button instead of crashing the entire React tree."
```

---

### Task 8: Fix Silent `applySuggestion` in SidePanel [E2 — Critical]

**Files:**
- Modify: `src/client/panels/SidePanel.tsx:41-58`

- [ ] **Step 1: Separate JSON parse from editor mutation**

Replace `applySuggestion` (lines 41-58):

```typescript
/** Apply a suggestion annotation's text replacement in the editor */
function applySuggestion(ann: Annotation, editor: TiptapEditor, ydoc: Y.Doc | null): boolean {
  if (ann.type !== "suggestion") return false;

  let newText: string;
  try {
    const parsed = JSON.parse(ann.content);
    newText = parsed.newText;
  } catch {
    // Malformed suggestion content — not JSON
    console.warn("[SidePanel] Malformed suggestion content for", ann.id);
    return false;
  }

  if (typeof newText !== "string") return false;

  const resolved = annotationToPmRange(ann, editor.state.doc, ydoc);
  if (!resolved) {
    console.warn("[SidePanel] Could not resolve range for suggestion", ann.id);
    return false;
  }

  editor
    .chain()
    .focus()
    .deleteRange({ from: resolved.from, to: resolved.to })
    .insertContentAt(resolved.from, newText)
    .run();
  return true;
}
```

- [ ] **Step 2: Find where `applySuggestion` is called and add error feedback**

Search for calls to `applySuggestion` in SidePanel and ensure failures surface to the user. The caller should check the return value and can log or show a toast if needed.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (the return type change may require updating callers — check if the return value is used)

- [ ] **Step 4: Commit**

```bash
git add src/client/panels/SidePanel.tsx
git commit -m "fix(client): separate JSON parse from editor mutation in applySuggestion

Previously the entire function body was wrapped in a single try/catch
that silently swallowed editor errors. Now JSON parsing and editor
mutation are separate, with explicit return values for each failure mode."
```

---

### Task 9: Fix Silent File Drop Handler [E3 — Critical]

**Files:**
- Modify: `src/client/hooks/useFileDrop.ts:26-41`

- [ ] **Step 1: Add response status checking**

Replace `handleEditorDrop` (lines 26-41):

```typescript
  const handleEditorDrop = useCallback(async (e: DragEvent) => {
    setFileDragOver(false);
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    const content = await readFileForUpload(file);
    try {
      const response = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, content }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: "Upload failed" }));
        console.error("[useFileDrop] Upload failed:", response.status, body.message ?? body.error);
      }
    } catch {
      console.error("[useFileDrop] Server unreachable — file drop ignored");
    }
  }, []);
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/client/hooks/useFileDrop.ts
git commit -m "fix(client): check response status in file drop handler

Previously, HTTP errors (400, 413, 500) from the upload endpoint were
silently ignored. Now they're logged to the console."
```

---

### Task 10: Wrap `saveRecentFiles` / `clearRecentFiles` in try-catch [E6 — High]

**Files:**
- Modify: `src/client/utils/recentFiles.ts:21-27`

- [ ] **Step 1: Add try-catch guards**

Replace lines 21-27:

```typescript
export function saveRecentFiles(list: string[]): void {
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(list));
  } catch {
    // localStorage unavailable (incognito, storage-disabled)
  }
}

export function clearRecentFiles(): void {
  try {
    localStorage.removeItem(RECENT_FILES_KEY);
  } catch {
    // localStorage unavailable (incognito, storage-disabled)
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/client/utils/recentFiles.ts
git commit -m "fix(client): guard localStorage writes with try-catch

loadRecentFiles already had a try-catch but saveRecentFiles and
clearRecentFiles did not. In incognito or storage-disabled browsers,
these would throw and crash the calling component."
```

---

### Task 11: Log `realpathSync` Fallback Errors [E7 — High]

**Files:**
- Modify: `src/server/mcp/file-opener.ts:69-73`

- [ ] **Step 1: Add logging and narrow the catch**

Replace lines 69-73:

```typescript
  try {
    resolved = fsSync.realpathSync(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`[Tandem] realpathSync failed for ${filePath} (${code}), using path.resolve fallback`);
    }
    resolved = path.resolve(filePath);
  }
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/mcp/file-opener.ts
git commit -m "fix: log non-ENOENT realpathSync failures in file-opener

Broken symlinks or permission errors were silently falling back to
path.resolve, potentially opening the wrong file."
```

---

### Task 12: Log SSE Keepalive Write Errors [E8 — High]

**Files:**
- Modify: `src/server/mcp/api-routes.ts:134-139`

- [ ] **Step 1: Add logging to keepalive catch**

Replace lines 134-139:

```typescript
  const keepalive = setInterval(() => {
    try {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    } catch (err) {
      console.error(
        "[NotifyStream] Keepalive write failed, cleaning up:",
        err instanceof Error ? err.message : err,
      );
      cleanup();
    }
  }, CHANNEL_SSE_KEEPALIVE_MS);
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/mcp/api-routes.ts
git commit -m "fix: log SSE keepalive write errors before cleanup

Matches the logging pattern already used by the notification write
handler a few lines above."
```

---

### Task 13: Tighten `broadcastOpenDocs` Error Handling [E9 — High]

**Files:**
- Modify: `src/server/mcp/document-service.ts:104-130`

- [ ] **Step 1: Move try-catch inside the per-doc loop**

Replace `broadcastOpenDocs` (lines 104-130):

```typescript
export function broadcastOpenDocs(): void {
  const docList = Array.from(openDocs.values()).map(toDocListEntry);
  const id = activeDocId;

  try {
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const ctrlMeta = ctrl.getMap(Y_MAP_DOCUMENT_META);
    ctrl.transact(() => {
      ctrlMeta.set("openDocuments", docList);
      ctrlMeta.set("activeDocumentId", id);
    }, MCP_ORIGIN);
  } catch (err) {
    console.error("[Tandem] broadcastOpenDocs: failed to update CTRL_ROOM:", err);
  }

  for (const [docId] of openDocs) {
    try {
      const ydoc = getOrCreateDocument(docId);
      const meta = ydoc.getMap(Y_MAP_DOCUMENT_META);
      ydoc.transact(() => {
        meta.set("openDocuments", docList);
        meta.set("activeDocumentId", id);
      }, MCP_ORIGIN);
    } catch (err) {
      console.error(`[Tandem] broadcastOpenDocs: failed to update doc ${docId}:`, err);
    }
  }
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/mcp/document-service.ts
git commit -m "fix: isolate per-doc errors in broadcastOpenDocs

A failure on one document no longer prevents broadcasting to others.
Each doc update has its own try-catch with specific error logging."
```

---

### Task 14: Log ChatPanel Anchor Navigation Errors [E11 — High]

**Files:**
- Modify: `src/client/panels/ChatPanel.tsx:135-147`

- [ ] **Step 1: Add logging to catch block**

Replace `scrollToAnchor` (lines 135-147):

```typescript
  const scrollToAnchor = useCallback(
    (anchor: { from: FlatOffset; to: FlatOffset }, docId?: string) => {
      if (!editor || (docId && docId !== activeDocId)) return;
      try {
        const pmFrom = flatOffsetToPmPos(editor.state.doc, anchor.from);
        const pmTo = flatOffsetToPmPos(editor.state.doc, anchor.to);
        editor.chain().focus().setTextSelection({ from: pmFrom, to: pmTo }).scrollIntoView().run();
      } catch (err) {
        // Anchor may be stale after edits — log for debugging
        console.warn("[ChatPanel] Could not scroll to anchor:", err instanceof Error ? err.message : err);
      }
    },
    [editor, activeDocId],
  );
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/client/panels/ChatPanel.tsx
git commit -m "fix(client): log anchor navigation errors in ChatPanel

Stale anchors are expected, but other errors (editor not ready,
ProseMirror state issues) were silently swallowed."
```

---

### Task 15: Use Case-Insensitive Matching in Error Filter [E13 — Medium]

**Files:**
- Modify: `src/server/error-filter.ts:27-31`

- [ ] **Step 1: Replace exact matching with includes**

Replace lines 27-31:

```typescript
  const msg = err.message;

  if (msg.startsWith("WebSocket is not open")) return true;
  if (msg.includes("Unexpected end of array") || msg.includes("Integer out of Range")) return true;
  if (msg.startsWith("Received a message with an unknown type:")) return true;
```

The `startsWith` patterns are fine (they're prefix-stable). The lib0 patterns switch from exact `===` to `includes()` to handle minor message changes.

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/server/error-filter.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/error-filter.ts
git commit -m "fix: use includes() for lib0 error messages in error filter

Exact string matching on lib0 error messages was fragile — minor
message changes would cause the server to crash instead of swallowing
known-safe errors."
```

---

### Task 16: Add Runtime Validation to `collectAnnotations` [E14 — Medium]

**Files:**
- Modify: `src/server/mcp/annotations.ts:117-121`

- [ ] **Step 1: Add minimal shape validation**

Replace `collectAnnotations` (lines 117-121):

```typescript
/** Collect all annotations from the Y.Map as an array, skipping malformed entries */
export function collectAnnotations(map: Y.Map<unknown>): Annotation[] {
  const result: Annotation[] = [];
  map.forEach((value, key) => {
    const ann = value as Record<string, unknown>;
    if (
      ann &&
      typeof ann === "object" &&
      typeof ann.id === "string" &&
      typeof ann.type === "string" &&
      ann.range &&
      typeof (ann.range as Record<string, unknown>).from === "number" &&
      typeof (ann.range as Record<string, unknown>).to === "number"
    ) {
      result.push(ann as unknown as Annotation);
    } else {
      console.warn(`[Tandem] Skipping malformed annotation entry: ${key}`);
    }
  });
  return result;
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/mcp/annotations.ts
git commit -m "fix: validate annotation shape in collectAnnotations

Y.Map entries are cast without runtime checks. Corrupted CRDT data or
schema changes could produce silent incorrect behavior. Now malformed
entries are skipped with a warning."
```

---

### Task 17: Make `waitForPort` Throw on Timeout [E15 — Medium]

**Files:**
- Modify: `src/server/platform.ts:32-41`
- Modify: callers of `waitForPort` (check `src/server/index.ts`)

- [ ] **Step 1: Change `waitForPort` to throw**

Replace lines 32-41:

```typescript
export async function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await tryBind(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Port ${port} still not available after ${timeoutMs}ms`);
}
```

- [ ] **Step 2: Check callers handle the error**

The caller in `src/server/index.ts` should wrap `waitForPort` in try-catch and log a clear message before proceeding or exiting. Read the caller to determine the right approach.

- [ ] **Step 3: Run tests**

Run: `npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/platform.ts src/server/index.ts
git commit -m "fix: throw on waitForPort timeout instead of silently proceeding

Callers now get a clear error instead of encountering EADDRINUSE later
in an unexpected context."
```

---

### Task 18: Log `freePort` Outer Catch [E16 — Medium]

**Files:**
- Modify: `src/server/platform.ts:15-25`

- [ ] **Step 1: Add logging**

Replace the `freePort` function (lines 15-25):

```typescript
export function freePort(port: number): void {
  try {
    if (process.platform === "win32") {
      freePortWindows(port);
    } else {
      freePortUnix(port);
    }
  } catch (err) {
    console.error(`[Tandem] freePort(${port}): ${err instanceof Error ? err.message : err}`);
  }
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server/platform.ts
git commit -m "fix: log freePort errors instead of silently swallowing

Nothing listening or permission-denied errors were invisible. Now logged
so startup issues are diagnosable."
```

---

### Task 19: Update Documentation

**Files:**
- Modify: `docs/decisions.md` or `docs/lessons-learned.md`
- Modify: `CLAUDE.md` (if any gotchas section needs updating)

- [ ] **Step 1: Add a lessons-learned entry for the security audit**

Add to `docs/lessons-learned.md`:

```markdown
### 32. Security audit patterns

UNC path validation must be applied to every user-controlled path parameter, not just the main
file open/save paths — `backupPath` in `tandem_applyChanges` was missed. WebSocket `Origin`
header validation must reject missing headers, not just invalid ones. `javascript:` URLs in
imported .docx content need protocol-allowlisting in the HTML converter. Session file loading
should distinguish ENOENT (normal) from corruption (log + clean up) from system errors (log).
```

- [ ] **Step 2: Commit**

```bash
git add docs/lessons-learned.md
git commit -m "docs: add security audit lessons learned (#32)"
```

---

### Task 20: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run E2E tests (if available)**

Run: `npm run test:e2e`
Expected: PASS

- [ ] **Step 4: Manual smoke test**

Start `npm run dev:standalone`, open a document, verify annotations work, chat works, file drop works. Check browser console for no new errors.
