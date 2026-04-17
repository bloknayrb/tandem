# Lessons Learned

## 1. Y.Doc Identity Mismatch

**Problem:** When both MCP tools and Hocuspocus create Y.Docs, they must share the same instance. If each creates its own Y.Doc for the same room, edits on one don't appear in the other.

**Solution:** Use a fixed room name ('default'). In `onLoadDocument`, merge any pre-existing MCP content into the Hocuspocus-provided doc via `Y.encodeStateAsUpdate`/`Y.applyUpdate`, then swap the map entry so both sides reference the same instance.

**Impact:** Critical -- without this, the entire collaboration loop breaks silently.

## 2. Y.XmlElement.toJSON() Does Not Return Plain Text

**Problem:** Calling `toJSON()` on a Y.XmlElement returns an XML/JSON structure representation, not the plain text content.

**Solution:** Recursively walk children, collecting `Y.XmlText.toString()` for text extraction. Implemented as `getElementText()` in `document-model.ts`.

## 3. MCP stdio Transport Reserves stdout

*[Historical — stdio replaced by HTTP transport in ADR-012, but console redirection kept as defense-in-depth.]*

**Problem:** The MCP protocol uses stdin/stdout for message framing. Any `console.log()` output corrupts the protocol stream, causing parse errors and dropped messages.

**Solution:** All server-side logging uses `console.error()`. This is enforced by convention (ADR-006). The `console.log/warn/info = console.error` redirect in `index.ts` remains active even in HTTP mode.

## 4. Hocuspocus Callbacks Must Be Async

**Problem:** TypeScript requires the `async` keyword on Hocuspocus handler callbacks (`onConnect`, `onDisconnect`, `onLoadDocument`) even if the handler body doesn't await anything.

**Solution:** Always declare handlers as `async`. Not doing so causes TypeScript compilation errors.

## 5. React StrictMode Double-Mount

**Problem:** `useMemo` for Y.Doc/provider creation is unsafe under React StrictMode. The first cleanup destroys the Y.Doc, but the second mount reuses the destroyed instance, causing silent failures.

**Solution:** Use `useRef` + `useEffect` with proper cleanup. The ref holds the Y.Doc and provider; the effect creates them on mount and destroys them on unmount. This handles the StrictMode double-mount correctly.

## 6. y-websocket Is Protocol-Incompatible with Hocuspocus v2

**Problem:** Hocuspocus v2 prepends `writeVarString(documentName)` to every outgoing WebSocket frame. `y-websocket` reads the first byte as the outer message type. For `name="default"` (7 chars), it reads `0x07`, finds no handler, and silently ignores every message. Incoming messages from `y-websocket` also lack the document name prefix, so Hocuspocus reads the first sync byte (`0x00`) as a zero-length string, creating a phantom `""` document instead of `"default"`. The two sides sync completely different Y.Docs and the browser always shows empty content.

**Solution:** Use `@hocuspocus/provider` (the official Hocuspocus client) instead of `y-websocket`. It implements the correct wire protocol and has the same API surface (`awareness`, `on('status')`, `destroy()`).

**Impact:** Critical — `y-websocket` appears to "work" (WebSocket connects, status shows "Connected") but document content never reaches the browser.

## 7. MCP Server Must Start Before Hocuspocus

*[Historical — applies to stdio mode only. HTTP mode starts both concurrently since there's no init timeout race.]*

**Problem:** Claude Code sends the MCP `initialize` request immediately after spawning the server process. If `startHocuspocus()` (which includes `freePort` + a 300ms delay + socket bind) runs first, the process doesn't respond to `initialize` in time. Claude Code's timeout fires, it kills the process, and the MCP tools never appear.

**Solution:** Call `startMcpServer()` first (connects to stdio immediately). Run `startHocuspocus()` in a non-awaited background IIFE with `.catch()`. The MCP SDK's `StdioServerTransport` keeps the event loop alive, and Hocuspocus finishes binding ~300ms later without blocking the MCP handshake.

**Impact:** Critical — without this ordering, every `/mcp` reconnect kills the server after exactly one tool call.

## 8. MCP Tool Response Boilerplate

**Problem:** Every MCP tool needs `{ content: [{ type: 'text', text: JSON.stringify(...) }] }` wrapping. With 16+ tools, this pattern was duplicated everywhere, making the code fragile and verbose.

**Solution:** Extracted shared helpers (`mcpSuccess`, `mcpError`, `noDocumentError`) into `response.ts` (ADR-008). Eliminated 267 lines of boilerplate.

## 9. Yjs Detached Y.XmlText Reverses Insert Order

**Problem:** `Y.XmlText.insert()` and `Y.XmlText.format()` do not preserve insertion order when the text node is not yet attached to a `Y.Doc`. Formatted segments (bold, italic) end up after plain text segments regardless of insertion order. The Yjs "Invalid access: Add Yjs type to a document before reading data" warning hints at this but doesn't prevent the operation — the data is silently corrupted.

**Solution:** Never populate text content on detached Y.XmlText. Build the element tree with empty text nodes, attach the entire tree to the Y.Doc via `fragment.insert()`, then populate text in a second pass. Also use `insert(offset, text, attrs)` with explicit `{ bold: null, italic: null, ... }` for plain text — without explicit nulls, Yjs inherits formatting from adjacent formatted segments.

**Impact:** Critical for any Yjs code that builds formatted documents programmatically. The corruption is invisible until round-trip: the document looks correct in memory but serializes with marks in the wrong position.

## 10. StrictMode-Unsafe Allocation in React State Updaters

**Problem:** Creating `new Y.Doc()` and `new HocuspocusProvider()` inside a `setTabs` updater function opens real WebSocket connections. React StrictMode calls updater functions twice, creating orphaned connections with no cleanup path.

**Solution:** Allocate Y.Doc and HocuspocusProvider objects outside the state updater, then pass the finished array into `setTabs`. Use refs (`handleDocumentListRef`) for callbacks that need to be current without triggering re-renders.

**Impact:** Without this, every document open in dev mode creates a duplicate WebSocket connection that leaks until page reload.

## 11. broadcastOpenDocs Must Update All Open Doc Rooms

**Problem (revised):** Writing the open documents list only to the active document's Y.Map leaves previously-active docs with a stale list. Example: open `a.md` (active, writes `[a]` to `a`'s room), then open `b.md` (active, writes `[a,b]` to `b`'s room and CTRL_ROOM). When the browser connects and creates a HocuspocusProvider for `a.md`, `a`'s `documentMeta.openDocuments` is still `[a]`. The per-tab `metaObserver` fires with `serverIds = {a}`, which triggers removal of `b`'s tab — the browser is left with 1 tab even though 2 docs are open.

**Solution:** `broadcastOpenDocs` writes the full list to ALL open doc rooms on every call (O(n) writes), plus the CTRL_ROOM bootstrap channel. This ensures every Y.Doc in every room always carries the current complete list, so no per-tab sync can produce a stale removal.

**Tradeoff:** O(n) writes per broadcast vs. the original O(1) design. With typical document counts (1–10 docs), this is not a practical concern.

## 12. Bootstrap Room Must Receive Doc List Broadcast

**Problem:** The client's bootstrap HocuspocusProvider connects to room `__tandem_ctrl__` to discover which documents are open. If `broadcastOpenDocs` only writes to individual document rooms, the bootstrap observer never fires on initial page load, and the browser shows "No document open" even after `tandem_open` succeeds.

**Solution:** `broadcastOpenDocs` always writes to `__tandem_ctrl__` first (so new/reconnecting clients discover docs), then to all open doc rooms (Lesson 11). The CTRL_ROOM write is the primary discovery channel; per-doc writes keep per-tab observers consistent.

**Impact:** Without the CTRL_ROOM write, the client can never render tabs on first load. The server reports docs as open but the browser doesn't know about them.

## 13. MCP Stdio Transport Disconnects Under Claude Code

**Problem:** The Tandem MCP server's stdio transport disconnects after the first `tandem_open` tool call when running under Claude Code. The server process stays alive (Hocuspocus continues listening), but the MCP stdio channel dies. Subsequent tool calls fail with "Not connected."

**Investigation:** Standalone testing via Node.js subprocess proves the server handles sequential tool calls correctly — both `tandem_open` calls return valid JSON-RPC responses. No stdout corruption detected (instrumented `process.stdout.write`). No uncaught exceptions. `console.log`, `console.warn`, and `console.info` are all redirected to stderr.

**Resolution:** Migrated from stdio to Streamable HTTP transport (ADR-012). MCP now runs on HTTP port 3479 via Express + `StreamableHTTPServerTransport` in stateful mode. Claude Code connects via `type: "http"` in `.mcp.json`. Sequential tool calls (including `tandem_open` → follow-up calls) work reliably. Stdio preserved as fallback via `TANDEM_TRANSPORT=stdio`.

**Impact:** Issue #8 resolved. Multi-document browser testing unblocked.

## 14. Y.Map Observers Created in Event Handlers Need Explicit Cleanup

**Problem:** When a Y.Map observer is registered *inside* another observer's callback (e.g., creating a `documentMeta.observe()` for each new tab inside `handleDocumentListRef`), the observer function is not reachable by any existing cleanup path — the standard `useEffect` cleanup only covers observers registered at effect setup time, not ones created dynamically later.

**Solution:** Store the unobserve function in a parallel ref-based Map (e.g., `tabMetaCleanupsRef`) keyed by the resource ID. When the resource is removed (tab closed), look up and call the cleanup before calling `ydoc.destroy()`.

**Pattern:**
```typescript
const metaObserver = () => { /* ... */ };
meta.observe(metaObserver);
cleanupMapRef.current.set(id, () => meta.unobserve(metaObserver));

// On removal:
cleanupMapRef.current.get(id)?.();
cleanupMapRef.current.delete(id);
t.ydoc.destroy();
```

**Impact:** Without explicit unobserve, the Y.Map retains a reference to the observer closure, preventing GC of the closure's captured variables. `ydoc.destroy()` stops further event delivery but doesn't always free the observer reference depending on Y.js internals.

## 15. Streamable HTTP Transport: Per-Session Lifecycle

**Problem:** The MCP SDK's `StreamableHTTPServerTransport` rejects re-initialization on an already-initialized transport (400 "Server already initialized"). A single long-lived transport means Claude Code's `/mcp` restart fails silently — the only workaround was restarting the entire Tandem server.

**Solution:** Rotate the transport on each `initialize` request while reusing the long-lived `McpServer` (tool registrations in `_registeredTools` survive `close()`/`connect()` cycles). The POST handler uses the SDK's `isInitializeRequest()` to detect initialize messages and calls `connectFreshTransport()`, which tears down the old transport via `mcpServer.close()` and creates a fresh one. A promise-chain lock serializes concurrent rotations. Stateless mode (`sessionIdGenerator: undefined`) still doesn't work — each transport needs `sessionIdGenerator` for session tracking.

**Impact:** Without per-session rotation, every `/mcp` restart in Claude Code requires a full server restart. The SDK's `Protocol.connect()` explicitly supports reconnection ("Call close() before connecting to a new transport").

## 16. Hocuspocus `afterUnloadDocument` vs MCP Document Lifetime

**Problem:** Hocuspocus fires `afterUnloadDocument` when all WebSocket clients disconnect from a room, deleting the Y.Doc from the shared `documents` map. But MCP tools may still consider that document "open" (it's in the `openDocs` map). If auto-save then calls `getOrCreateDocument()`, it gets a new empty Y.Doc and overwrites the session file with empty content. On the next restore, the session appears valid (`restoredFromSession: true`) but the document is empty (`tokenEstimate: 0`).

A secondary issue: `saveCtrlSession` persists the entire `__tandem_ctrl__` Y.Doc including `documentMeta.openDocuments`. After a server restart, browsers see this stale list and create providers for rooms the server hasn't opened, causing phantom/duplicate tabs.

**Solution:** Use a callback predicate (`setShouldKeepDocument`) so `afterUnloadDocument` checks whether MCP still tracks the document (or it's the `__tandem_ctrl__` bootstrap channel) before evicting it. This avoids a circular import between `provider.ts` and `document-service.ts`. Additionally, clear `openDocuments` and `activeDocumentId` from the ctrl doc immediately after restoring chat history, and add a defensive fallback in `tandem_open` that re-reads the source file if a restored session yields an empty doc.

**Impact:** Without this fix, any browser disconnect (tab close, navigation, network hiccup) can silently corrupt the session file, causing data loss on next open. The stale `openDocuments` list causes confusing phantom tabs on every server restart.

## 17. Extracting Shared Logic from MCP Handlers

**Problem:** `tandem_open` in `document.ts` was a 150-line function combining path resolution, format detection, session restore, Y.Doc loading, doc registration, and broadcast. When the HTTP API needed the same logic, the only option was copy-paste or extraction.

**Solution:** Extract the core file-opening workflow into `file-opener.ts` with two entry points: `openFileByPath` (disk files) and `openFileFromContent` (uploads). Both MCP's `tandem_open` and the HTTP API routes call into file-opener. Shared helpers (`writeDocMeta`, `buildResult`, `ensureAutoSave`) eliminate duplication within the module.

**Impact:** `document.ts` dropped from ~600 to ~450 lines. The open logic is independently testable (11 unit tests). Adding new file-open entry points (CLI, VS Code extension) only requires calling `openFileByPath`.

## 18. E2E Test Reliability with Yjs Sync

**Problem:** E2E tests create server-side state via MCP tool calls, then assert on browser-side DOM changes. The multi-hop sync chain (MCP → Y.Doc → Hocuspocus WS → browser provider → React → ProseMirror decorations) introduces variable latency. Tests that assert immediately after MCP calls fail intermittently.

**Solution:** Three techniques:
1. **`data-testid` attributes** for stable selectors — CSS classes and text content can change; test IDs are explicit contracts.
2. **Playwright auto-waiting** with generous timeouts (10s for annotation sync, 5s for UI transitions) — Playwright's `expect(locator).toBeVisible({ timeout })` retries until the element appears.
3. **Temp fixture dirs** per test via `fs.mkdtemp()` — each test gets unique file paths, preventing session restore interference from previous runs.

**Also:** `workers: 1` is essential — the MCP server supports one session at a time. Parallel tests would fight over the transport. And flat-text offsets in test fixtures must account for heading prefixes (`# ` = 2 chars) — offset 0 is the `#`, not the text content.

## 19. Centralize Y.Map Key Strings as Constants

**Problem:** Y.Map key strings like `"annotations"`, `"awareness"`, `"chat"` appeared as raw string literals across 20+ files. A typo in any one of them creates a silently disconnected map — the writer pushes to one key while the reader observes another, with no runtime error or type error.

**Solution:** Define all Y.Map keys as named exports in `shared/constants.ts` (`Y_MAP_ANNOTATIONS`, `Y_MAP_AWARENESS`, `Y_MAP_USER_AWARENESS`, `Y_MAP_CHAT`, `Y_MAP_DOCUMENT_META`). Import the constant everywhere. TypeScript catches misspelled import names at compile time.

## 20. Y.Map Origin Tagging for Echo Prevention

**Problem:** When the channel shim forwards real-time events to Claude Code, Claude must not receive notifications for its own tool calls. Without filtering, a `tandem_comment` call would trigger an `annotation:created` event that the shim would push back to Claude, creating confusion and wasted tokens.

**Solution:** All MCP-initiated Y.Map writes wrap mutations in `doc.transact(() => { ... }, 'mcp')`. Y.Map observers in the event queue check `txn.origin === MCP_ORIGIN` and skip events from MCP-tagged transactions. The `MCP_ORIGIN` constant is exported from `events/queue.ts` and imported at all 10 callsites across 6 files.

**Impact:** Critical for channel correctness. Browser-originated changes use Hocuspocus Connection objects as the transaction origin, which are always distinct from the `'mcp'` string.

## 21. Hocuspocus Session Restore Creates "add" Not "update" Events

**Problem:** During testing, Y.Map observers on the annotations map saw `change.action === "add"` for annotations that were already accepted/dismissed. The observer only emits `annotation:accepted`/`annotation:dismissed` events for `change.action === "update"` (which fires when a browser user changes an existing annotation's status). On server restart, session restore replays the entire Y.Doc state — all annotations appear as fresh `"add"` events, not `"update"` events, even if their status is already `"accepted"`.

**Solution:** This is correct and intentional. The event queue should not replay old accept/dismiss decisions on server restart — those were already delivered to Claude in the previous session. Only live user actions (real-time `"update"` changes) should trigger push events.

**Impact:** Low — this is working as designed. But it's surprising during manual testing if you expect to see events for previously-resolved annotations after a server restart.

## 22. Channels API Meta Keys Must Use Underscores

**Problem:** The Claude Code Channels API silently drops meta keys containing hyphens. Event metadata like `{ "document-id": "..." }` arrives at Claude Code as an empty object.

**Solution:** Use underscores in all meta keys: `document_id`, `annotation_id`, `event_type`, `message_id`. The `formatEventMeta()` function in `events/types.ts` enforces this convention.

**Impact:** Subtle — the meta appears to be set correctly on the server side, but Claude Code never receives it. No error is reported. Discovered during initial channel integration testing.

## 23. Hocuspocus Internal State for Force-Unload

**Problem:** `Hocuspocus.unloadDocument(doc)` bails early if `doc.getConnectionsCount() > 0` (line 598 in `Hocuspocus.ts`). `closeConnections(docName)` is fire-and-forget — it returns `void`, not a `Promise`, because the actual close happens behind `lock.acquire('close', ...)` in `Connection.close()`. There's no way to await all connections being fully closed before calling `unloadDocument`.

**Solution:** Bypass `unloadDocument` entirely and manipulate Hocuspocus's internal state directly:

```typescript
const hp = getHocuspocus();
// 1. Force-close WebSocket connections (fire-and-forget safety net)
hp.closeConnections(docName);
// 2. Remove from Hocuspocus's internal Document map
const hpDoc = hp.documents.get(docName);
if (hpDoc) {
  hp.documents.delete(docName);
  hpDoc.destroy();
}
// 3. Clear in-flight load promises (prevents stale state on reconnect)
hp.loadingDocuments.delete(docName);
```

The orphaned Hocuspocus `Document`'s close handlers become no-ops when they look up the document name in `hp.documents` and find nothing. This is deterministic — no timing races.

**Key internals** (Hocuspocus v2.15.3, `@hocuspocus/server`):

| Property/Method | Type | Notes |
|----------------|------|-------|
| `hp.documents` | `Map<string, Document>` | Active documents, keyed by room name. Public but undocumented. |
| `hp.loadingDocuments` | `Map<string, Promise<Document>>` | Guards against concurrent `createDocument` calls for the same room. |
| `hp.closeConnections(name?)` | `void` | Gracefully closes all WebSocket connections for a room. Fire-and-forget. |
| `hp.unloadDocument(doc)` | `Promise<any>` | Removes doc from map + fires `afterUnloadDocument` hook. **Bails if connections > 0.** |
| `Document.destroy()` | `void` | Cleans up internal state. Called by Hocuspocus during unload. |
| `Document.connections` | `Map<string, ...>` | Active WebSocket connections to this document. |
| `Document.getConnectionsCount()` | `number` | Sum of WebSocket + direct connections. |

**Impact:** These are public properties but not part of any documented/typed API. Brittle across Hocuspocus major upgrades — pin the version and grep for usage when upgrading.

## 24. Port Polling vs Fixed Sleep on Windows

**Problem:** The server startup used a fixed `setTimeout(300)` between `freePort()` and `Hocuspocus.listen()`. On Windows, port release after `taskkill` is not instant — the OS may hold the port in TIME_WAIT for several seconds. The fixed sleep was sometimes too short (causing EADDRINUSE) and always wasteful when the port was already free.

**Solution:** Replace the fixed sleep with `waitForPort()` in `platform.ts`, which polls every 100ms (up to 5s default) by attempting a TCP `connect()` and checking for `ECONNREFUSED` (port free) vs success (port still held). Hocuspocus `.listen()` is also wrapped with EADDRINUSE detection for a clear error message.

**Impact:** Eliminates a class of flaky startup failures on Windows, especially after unclean shutdowns. The polling approach adapts to actual OS port release timing instead of guessing.

## 25. Atomic Undo for Accepted Suggestions

**Problem:** When a user accepts a suggestion, the text edit is applied and the annotation status changes to "accepted". If undo only reverts the status without reverting the text edit, the document ends up in an inconsistent state — the suggestion's `newText` is in the document but the annotation shows as "pending" again.

**Solution:** The undo handler for accepted suggestions atomically reverts both the text edit (restoring the original text at the annotation's range) and the annotation status in a single operation. The original text is captured at accept time and stored alongside the undo timer. For dismissed annotations (no text edit), undo only reverts the status.

**Impact:** Without atomic undo, users could create documents where the text doesn't match any annotation state — confusing for both the user and Claude on subsequent reads.

## 26. Deterministic E2E State via MCP Tool Calls

**Problem:** The E2E tab switching test was flaky because it relied on browser-side tab click events to switch documents, but the Yjs sync chain (browser click → Y.Map update → server → broadcast → browser re-render) introduced non-deterministic timing. The test would sometimes assert on stale content.

**Solution:** Use `tandem_switchDocument` (an MCP tool call) to set the active document server-side before asserting on browser state. Combined with `data-active='false'` attribute selectors to wait for the inactive tab to appear, this makes the test deterministic — the server state is the source of truth, and the browser catches up via Playwright's auto-waiting.

**Impact:** General pattern: when E2E tests need specific server state, set it via MCP tools rather than simulating browser interactions. MCP calls are synchronous (request/response), while browser interactions trigger async multi-hop sync chains.

## 27. SSE for Ephemeral Data Instead of CRDT

**Problem:** Toast notifications (annotation range failures, save errors) needed to reach the browser but didn't fit the Y.Map pattern — they're transient, don't need conflict resolution, and shouldn't persist across sessions.

**Solution:** A dedicated SSE endpoint (`GET /api/notify-stream`) with a server-side ring buffer. The browser connects via native `EventSource` in the `useNotifications` hook. Separate from the channel SSE (`GET /api/events`) which serves Claude Code.

**Impact:** Clean architectural boundary — persistent shared state goes through Y.Map/CRDT, ephemeral notifications go through SSE. Adding a Y.Map for notifications would have introduced CRDT state bloat (Y.Map entries persist in the internal state vector even after deletion) for data that's fundamentally fire-and-forget.

## 28. React Ref Identity in useEffect Dependencies

**Problem:** The `useTabOrder` hook initially used a derived array as a `useEffect` dependency. Even when the array contents were identical, React's reference equality check saw a new array on every render, causing the effect to fire on every render cycle — leading to unnecessary re-renders and potential infinite loops.

**Solution:** Use scalar values (e.g., `.length`, a hash, or specific primitive fields) as `useEffect` dependencies instead of derived objects or arrays. When watching an array for changes, use its `.length` or a serialized representation, not the array reference itself.

**Impact:** Subtle performance bug — the component appears to work correctly but re-renders orders of magnitude more often than necessary. Visible in React DevTools Profiler or by adding a `console.log` inside the effect.

## 29. localStorage Access Needs try-catch in Client Code

**Problem:** The `useTutorial` hook stores completion state in `localStorage`. Some browsers (incognito mode in certain configurations, enterprise browsers with storage policies, or when quota is exceeded) throw exceptions on `localStorage.getItem()` or `setItem()` calls. Without a guard, this crashes the entire React component tree.

**Solution:** Wrap all `localStorage` access in try-catch blocks. On read failure, return a sensible default (e.g., tutorial not completed). On write failure, silently continue — the tutorial will re-show next time, which is a better failure mode than crashing the app.

**Impact:** Without this, a small percentage of users in restricted browser environments would see a white screen instead of the editor. The tutorial is a nice-to-have; the editor is essential.

## 30. Ambiguous indexOf Targeting for Annotation Range Resolution

**Problem:** When resolving annotation ranges for imported Word comments, using `indexOf` to find the target text can match the wrong occurrence if the text appears multiple times in the document. The first match wins, which may not be the correct location for the annotation.

**Solution:** Use context-aware targeting — resolve the range using both the target text and surrounding context (nearby heading, paragraph position). The `anchoredRange()` function creates CRDT-anchored positions at resolution time, so even if the flat offset drifts later, the relative position stays correct. For tutorial annotations, use specific unique text snippets that only appear once in the welcome document.

**Impact:** Annotations appearing at the wrong location are confusing for users and can lead to incorrect accept/dismiss decisions. Always prefer unique text patterns or occurrence-indexed matching over bare `indexOf`.

## 31. Coordinate System Consistency: extractText vs extractMarkdown

**Problem:** `tandem_getTextContent` used `extractMarkdown()` for .md files, which produces markdown syntax (`> ` for blockquotes, `- ` for list items, etc.). But the annotation coordinate system uses flat text offsets from `extractText()`, which includes heading prefixes (`## `) and `\n` separators but NOT markdown block-level syntax. After a blockquote, the character offsets from `extractMarkdown()` diverge from `extractText()` — every `> ` prefix shifts subsequent offsets by 2 characters per blockquote line. Claude would read text via `tandem_getTextContent`, find a passage at offset N, then place an annotation at offset N — but the annotation coordinate system expected a different offset, so the annotation landed in the wrong place.

**Solution:** `tandem_getTextContent` now always uses `extractText()` regardless of file format. The flat text format is the single source of truth for all offset-bearing operations. If Claude needs actual markdown, `tandem_save` writes the file to disk and Claude can read it via other means.

**Key principle:** Any tool that returns character offsets (or text that will be used to compute character offsets) must use the same text representation as the annotation coordinate system. Mixing representations is a silent correctness bug — annotations appear to work but land in the wrong location, and the drift is proportional to the amount of block-level markdown syntax before the target range.

## 32. Channel Selection Events Flood the Context Window

**Problem:** The `selection:changed` event fires on every cursor movement and click in the editor. When the channel shim forwarded all of these to Claude Code, a single browsing session produced 25+ "User cleared selection" notifications in seconds, burning context and drowning out actionable events like chat messages and annotation actions. Additionally, actual text selection events never arrive at all — only "cleared selection" (cursor-only) events.

**Root cause (discovered via raw SSE inspection):** The client awareness extension (`awareness.ts`) called `pmSelectionToFlat()` which returned `{ from, to }` — flat offsets only, with no `selectedText` field. Every selection event arrived at the server with `selectedText: ""` regardless of whether the user selected text or just clicked. This caused `formatEventContent` to label everything "User cleared selection" (empty string is falsy), masking that these were real text selections.

Initial attempts to filter at the bridge and server levels had no effect because the filters checked `from === to` (cursor-only), but real selections had `from !== to` — they just lacked text content. The "cleared selection" label sent debugging down the wrong path for several hours.

**Solution:** Three-layer fix, culminating in the removal of `selection:changed` as a standalone event type (#188):
1. **Client** (`awareness.ts`): Extract selected text via `state.doc.textBetween()`, truncate to 200 chars, debounce Y.Map writes at 150ms during drag. Cancel debounce on deselect.
2. **Server** (`queue.ts`): Replaced standalone `selection:changed` events with a per-document selection buffer. Selections are stored after a configurable dwell time and attached to the next `chat:message` for the same document. This eliminates context-window flooding while preserving selection context where it matters — alongside the user's question.
3. **Bridge** (`event-bridge.ts`): Selection debouncing and filtering remains as defense-in-depth, but no `selection:changed` events flow through the channel anymore.

**Key principle:** When debugging event pipelines, inspect the raw wire format at each layer (SSE stream, bridge input, channel output). Misleading labels can send you on a multi-hour chase — the "User cleared selection" label masked that these were real selections with missing data. High-frequency UI interactions should be batched with their semantic trigger (e.g., selection with the chat message that references it) rather than pushed as standalone events.

## 33. Security Audit Patterns

**Problem:** A full security audit uncovered 25 findings across 7 categories — UNC path validation gaps, missing Origin header checks, unsanitized URLs in imported documents, ReDoS via user-supplied regex, DNS rebinding on unprotected endpoints, silent error swallowing in session management, and missing React error boundaries.

**Key findings:**
- UNC path validation must be applied to *every* user-controlled path parameter, not just the primary file open/save paths. The `backupPath` parameter in `tandem_applyChanges` was missed because it wasn't part of the main file I/O flow.
- WebSocket Origin header validation must reject *missing* headers, not just *invalid* ones. Connections from `file://` pages or browser extensions don't send Origin.
- Imported `.docx` content can contain `javascript:` URLs in hyperlinks. Protocol-allowlisting (`http:`, `https:`, `mailto:` only) prevents XSS when Tiptap renders the links.
- User-supplied regex in `tandem_search` needs both a match count cap and a time-based bailout to prevent catastrophic backtracking from blocking the event loop.
- Every `catch {}` block (bare catch) is a code smell. Distinguish expected errors (ENOENT) from corruption (SyntaxError) from system errors (EACCES). Session file corruption from a crash during save silently loses all annotations if you just `return null`.
- A React ErrorBoundary at the app root prevents any rendering error from producing an unrecoverable white screen. Without it, corrupted Y.Map data (realistic after CRDT merges) can crash the entire UI.

**Process:** Run security and error-handling audits in parallel using specialized reviewers. The security reviewer catches attack surfaces; the silent-failure hunter catches error handling that hides bugs or data loss. Together they provide comprehensive coverage.

## 34. Clear Y.Docs In-Place Instead of Destroying Them

**Problem:** `tandem_open` with `force: true` destroyed the Y.Doc and Hocuspocus room, then recreated both. The client tab got a new ydoc, but the React observer effect only depended on `activeTabId` (unchanged string), so annotation observers were never re-attached. Sidebar showed "No annotations" while ProseMirror inline decorations rendered fine — because ProseMirror reads from the live ydoc directly, but React state was stuck on the old (destroyed) ydoc's Y.Map.

**Root cause:** Destroying a Y.Doc severs all observer subscriptions. Recreating produces a new instance that existing references don't track. This is the same bug class as the documented "Hocuspocus replaces Y.Doc in onLoadDocument" gotcha, which required manual observer re-attachment.

**Fix:** Replace destroy-and-recreate with in-place clearing. `clearAndReload` in `file-opener.ts` clears all Y.Maps (annotations, awareness, userAwareness) and repopulates content in a single `doc.transact()`. The Y.Doc instance, Hocuspocus room, and client WebSocket connections all survive. Server event queue observers are re-attached via `attachObservers()` after the transaction.

**Key insight:** When multiple subsystems hold references to a Y.Doc (server event queue, client React hooks, ProseMirror extensions), destroying the doc creates a coordination problem that no amount of lifecycle management can reliably solve. Clearing in-place eliminates the problem entirely. See the observer ownership table in [architecture.md](architecture.md) for the full list of who observes what.

**Diagnostic pattern:** If the sidebar shows "No annotations" but inline decorations render, the React Y.Map observer is attached to a stale Y.Doc. Check whether the Y.Doc instance was replaced without the observer effect re-firing.

## 35. Startup Document Opens Must Precede Server Bind

**Problem:** After upgrading Tandem, the CHANGELOG.md tab opened in the browser but then disappeared. The version check and changelog open ran *after* `Promise.all([startMcpServerHttp, startHocuspocus])`, but the browser auto-opens when MCP binds (inside that Promise.all). A stale browser tab from the previous version reconnecting could CRDT-merge its old `openDocuments` list — which lacked the changelog — and win the Y.Map conflict resolution, removing the tab.

**Fix:** Move the version check + changelog open (and the `sample/welcome.md` fallback) to before `Promise.all`, after `restoreOpenDocuments()` and `waitForPort()`. These operations only need the filesystem and in-memory Y.Docs — no server required. By the time any client connects, the Y.Doc state is fully settled.

**Key insight:** Any document that should appear on startup must be opened before Hocuspocus binds. The browser auto-open and stale tab reconnection both create races where clients can receive (and merge back) incomplete `openDocuments` lists. The general rule: settle all Y.Doc state before accepting WebSocket connections.

## 36. Dead CRDT RelativePositions Must Be Stripped, Not Preserved

**Problem:** After `reloadFromDisk` replaces Y.Doc content, all CRDT items are new. Old `relRange` RelativePositions reference deleted items. `refreshRange` tried `relPosToFlatOffset` → got null → returned the annotation unchanged with the dead `relRange` still set. The lazy re-attachment path (which creates new relRange from flat offsets) only fires when `relRange` is absent, so annotations were permanently stuck with non-functional CRDT anchors.

**Fix:** When `relPosToFlatOffset` returns null for either endpoint, strip the dead `relRange` and attempt re-anchoring from flat offsets via `flatOffsetToRelPos`. If that also fails, delete `relRange` entirely so the lazy path can recover on the next call.

**Key insight:** A dead `relRange` is worse than no `relRange`. The lazy attachment path is the recovery mechanism, but it only fires when the field is falsy. Preserving a non-functional reference blocks recovery. The general pattern: when a cached/derived value becomes invalid, delete it rather than keeping it around — stale data that prevents self-healing is the worst kind.

## 37. File Watcher Self-Write Suppression Must Check at Event Arrival

**Problem:** When Tandem saves a file (`tandem_save`), it calls `suppressNextChange(filePath)` to prevent the file watcher from triggering a reload loop. The initial implementation checked the suppress flag inside the debounce timer callback (500ms later). If another external edit arrived within that window, the debounce timer would reset, and the suppress flag would be consumed by the wrong event — silently swallowing the external change.

**Fix:** Check and clear the suppress flag at event arrival time (inside the `fs.watch` callback), before starting the debounce timer. This ensures the suppress only affects the immediate event batch from the self-write, not a later external edit that happens to arrive within the debounce window.

**Key insight:** Debounce and suppression are independent concerns. Suppression answers "should I ignore this event?" — that's an arrival-time decision. Debounce answers "should I wait for more events before acting?" — that's a delivery-time decision. Mixing them (checking suppress at delivery time) creates a race where the suppress can consume the wrong event.

## 38. Privacy Signals Fail Closed, Not Open

**Problem:** Solo mode is a user-driven privacy preference — the user has explicitly asked Claude not to process events. If `/api/mode` fails and the monitor falls back to "tandem" (the permissive default), Claude silently gains access to activity the user asked to suppress.

**Solution:** Startup mode warm-up (`getCachedMode()`) fails closed to "solo" on any error. The hot-path background refresh (`refreshMode()`) is fire-and-forget and leaves `cachedMode` unchanged on failure — stale-preferred, not fail-closed — to avoid randomly suppressing events mid-session when the server hiccups.

**Key insight:** Distinct failure modes need distinct fallbacks. The cold-start case and the mid-session-transient case have opposite risk profiles: leaking activity on cold start is worse than the brief stale window from a transient mid-session failure.

## 39. Retry Budgets Must Reset on Stable Uptime, Not Per Event

**Problem:** Resetting the reconnect counter every time an event is successfully delivered lets a server that crashes after each event reconnect forever — the cap never fires because the counter resets before it exhausts.

**Solution:** Reset the retry counter only after the connection has been healthy for a meaningful continuous window (`STABLE_CONNECTION_MS` = 60s here). This decouples the "is the server stable?" signal from event throughput.

**Key insight:** The question the retry budget is trying to answer is "has this connection been healthy long enough to warrant resetting the budget?" — not "did any event arrive?" A server that delivers one event and then crashes is not a healthy server.

## 40. Stdio Plugin Hosts Route stdout to the User, Not stderr

**Problem:** Claude Code plugin hosts surface stdout lines as user-visible notifications and swallow stderr entirely. Any user-facing state — including "monitor died, restart Tandem" — written to stderr is invisible in normal operation.

**Solution:** Write all user-facing output (formatted event notifications, exhaustion messages) to stdout. Reserve stderr for developer/debugging output that only matters when running the monitor by hand outside of Claude Code.

**Key insight:** This is a platform contract, not a preference. Know which stream your host reads. For Claude Code plugins: stdout = user channel, stderr = dev null in production.

## 41. Vitest Isolates Modules Per File, Not Per Test

**Problem:** Module-level state (mode caches, registered signal handlers, in-flight promise locks) bleeds between tests in the same file, causing order-dependent failures. In development, module-level side effects like `console.*` redirects also pollute Vitest's own console routing when the module is imported for tests.

**Solution:** Export a `_resetForTests()` helper from any module with stateful singletons and call it in every `beforeEach`. Guard module-level side effects behind `process.env.VITEST !== "true"` so importing the module in a test context doesn't activate production behavior.

**Key insight:** Vitest's module isolation boundary is the test file, not the test. Treat module-level state the same way you treat global DOM state in browser tests — reset it explicitly, don't assume isolation.

## 42. AbortSignal Passed to fetch Governs the Response Body Too

**Problem:** `fetchWithTimeout(..., CONNECT_FETCH_TIMEOUT_MS)` wrapped the `/api/events` fetch with `AbortSignal.timeout(10_000)` intending a 10s *handshake* budget. But undici's `AbortSignal` governs the *entire* response lifecycle including the body `ReadableStream`, so every SSE stream aborted at 10s. The 60s `STABLE_CONNECTION_MS` retry reset was unreachable — no connection ever stayed up long enough to qualify as "stable."

**Fix:** Split handshake timeout from stream lifetime. Use a local `AbortController` + `setTimeout` that is cleared as soon as the fetch settles, then install a separate inactivity watchdog that resets `lastActivityAt` on each successful `reader.read()`:

```ts
const connectCtrl = new AbortController();
const connectTimer = setTimeout(
  () => connectCtrl.abort(new Error("handshake timeout")),
  CONNECT_FETCH_TIMEOUT_MS,
);
let res: Response;
try {
  res = await fetch(url, { headers, signal: connectCtrl.signal });
} finally {
  clearTimeout(connectTimer);
}
```

Pass an `Error` argument to `abort()` so the reason flows through to `fetch`'s rejection — a bare `abort()` loses the handshake-vs-body distinction when you later surface the error to logs.

**Follow-on gotcha:** `reader.cancel(reason)` resolves the pending `read()` with `{done: true}` — it does NOT reject, and the `reason` argument is not surfaced to the caller. To propagate the cause (e.g., "was this a natural end-of-stream or a watchdog cancel?"), set a local flag before cancelling and branch on it after `done: true`:

```ts
let inactivityTimedOut = false;
const watchdog = setInterval(() => {
  if (Date.now() - lastActivityAt > SSE_INACTIVITY_TIMEOUT_MS) {
    inactivityTimedOut = true;
    reader.cancel(new Error("SSE inactivity timeout")).catch(() => {});
  }
}, SSE_INACTIVITY_TIMEOUT_MS / 4);
// ...
if (done) throw inactivityTimedOut ? new Error("SSE inactivity timeout") : new Error("SSE stream ended");
```

**Key insight:** `AbortSignal` on fetch is an all-or-nothing contract — it doesn't distinguish "connect" from "read" the way curl's `--connect-timeout` vs `--max-time` do. If you want separable timeouts, split handshake and body into two mechanisms (controller + watchdog). Streaming clients always need the split.

## 43. Fire-and-Forget POSTs Must Be Drained Before process.exit

**Problem:** `clearAwareness` and `flushAwareness` issued `fetch(...).catch(...)` without awaiting — the standard fire-and-forget pattern for best-effort telemetry. But under SIGINT, the shutdown handler called `process.exit(0)` while those POSTs were still in flight. The server saw a stale `active: true` update as the last awareness message, not the shutdown `active: false` clear.

**Fix:** Track outstanding POSTs in a module-level `Set<Promise<unknown>>`, add each on issue, remove in `.finally()`. The shutdown handler `Promise.allSettled`s the set before issuing its own clear:

```ts
const outstandingAwareness = new Set<Promise<unknown>>();
function trackAwareness(p: Promise<unknown>): void {
  outstandingAwareness.add(p);
  p.finally(() => outstandingAwareness.delete(p));
}

async function finalClearAwareness(): Promise<void> {
  if (outstandingAwareness.size > 0) await Promise.allSettled(outstandingAwareness);
  // ... issue shutdown clear
}
```

The `.finally()` alone is enough — `Set.delete` cannot throw, so no trailing `.catch()` is needed.

**Key insight:** Fire-and-forget is only safe inside a process that will keep running. The moment you introduce a shutdown path, fire-and-forget becomes fire-and-lose. Any side effect whose ordering matters relative to exit needs a drain set. Corollary: the `AWARENESS_FETCH_TIMEOUT_MS` bound on each individual POST is what keeps the drain itself bounded — shutdown can't hang forever on a stuck server.

## 44. Shared Observer Cleanups Need a Phase Parameter, Not a Single Lambda

**Problem:** `registerAnnotationObserver` returned a `() => void` cleanup that was invoked on BOTH a live Hocuspocus Y.Doc swap (`reattachObservers`) and a true document close (`clearFileSyncContext`). The cleanup dropped the per-doc tombstone ledger from memory. On a swap, a debounced snapshot write could still be queued against the old Y.Doc — by the time the debounce window fired, the ledger had been wiped and the thunk serialized `tombstones: []` to disk. Silent deletion data loss on every browser reconnect, invisible until a user opened the file again and saw their deleted annotations resurrect (see #333).

**Fix:** Change the cleanup signature to `(phase?: "swap" | "close") => void`. The swap phase unobserves maps and drops the live context registry entry but LEAVES the tombstone ledger in place for any in-flight debounced write to snapshot. The close phase does the full teardown including the ledger. Callers that don't care about the distinction (file-opener, document-service) keep passing the raw cleanup through the queue-registry indirection; only `reattachObservers` needs to explicitly thread the `"swap"` phase.

**Key insight:** When a teardown function is shared across distinct lifecycle phases (live-swap vs unload), a single nullary cleanup hides the phase distinction from future readers and invites silent data loss. A typed phase parameter makes the "what survives what" question explicit at every call site and at the cleanup definition. Default the parameter to the more conservative phase (close/full-teardown) so legacy callers stay safe.
