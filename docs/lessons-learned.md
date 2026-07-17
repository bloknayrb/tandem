# Lessons Learned

> **Scope note:** Many lessons below reference Claude-specific behavior (channel push, plugin monitor, cowork, Claude Code skill, etc.). Tandem's default integration is Claude per [ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration), so lessons learned working ON that path are the deepest documented; lessons that generalize to any MCP client are noted as such inline. Other MCP clients are best-effort and not validated today.

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
// Note: `getHocuspocus()` was removed in audit v2 (zero callers). The pattern below
// works against any direct Hocuspocus instance reference held by the caller.
const hp = hocuspocusInstance;
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
- A Svelte 5 `<svelte:boundary>` at the app root prevents any rendering error from producing an unrecoverable white screen. Without it, corrupted Y.Map data (realistic after CRDT merges) can crash the entire UI. The component-level `ErrorBoundary` wrapper additionally offers in-place recovery (capped at 3 attempts) before falling back to reload.

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

## 38. Mode Is Stale-Preserving — A Transient Failure Never Changes It

**Problem:** Solo/Tandem mode is a user-driven setting. The original monitor warm-up failed *closed* to "solo" and the channel failed *open* to "tandem"; #822's first refactor unified both on fail-closed-to-"solo". Both behaviors share the same defect: a transient `/api/mode` hiccup silently *changes the user's mode* to a hardcoded default. The user directive is that mode must NOT change unless the user explicitly changes it — neither fail-open nor fail-closed honors that.

**Solution (#822):** The mode cache is **stale-preserving**. `getCachedMode()` returns the last successfully-fetched mode on any failure and never overwrites `cachedMode` with a default. The hardcoded cold-start default (`TANDEM_MODE_DEFAULT`, `"tandem"`) is used in exactly one state: `cachedModeAt === 0`, meaning no fetch has ever succeeded. After the first success `cachedModeAt` is non-zero forever, so failures can never revert a known mode. The hot-path background refresh (`refreshMode()`) was already stale-preferred; this extends the same guarantee to the warm-up / first-fetch path. The net contract: once a real mode has been observed, the mode changes only when the server reports a new value — i.e. when the user toggles it.

**Key insight:** "Fail safe" for a *user setting* means "don't change the setting", not "pick the safest-looking default". A default — solo or tandem — is still a change the user didn't request. The only state without a prior user signal is the genuine cold start, and that is the only place a hardcoded default belongs.

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

**Key insight:** `AbortSignal` on fetch is an all-or-nothing contract — it doesn't distinguish "connect" from "read" the way curl's `--connect-timeout` vs `--max-time` do. If you want separable timeouts, split handshake and body into two mechanisms (controller + watchdog). Streaming clients always need the split. The same pattern now applies to both the plugin monitor and the legacy channel shim.

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

## 45. Tiptap Markdown Round-Trip Destroys Content It Can't Parse

**Problem:** Opening `docs/roadmap.md` in Tandem silently dropped all markdown tables. The Tiptap ProseMirror schema doesn't include a table node type, so `mdastToYDoc()` skips table MDAST nodes during conversion. When `saveMarkdown()` serializes the Y.Doc back, the tables are gone. Also injects blank lines after headings, wraps bare URLs in angle brackets, and adds HTML entities for bold formatting.

**Fix (pending, #379):** Either add `@tiptap/extension-table` to preserve table nodes, or implement raw-markdown pass-through for blocks Tiptap can't parse. At minimum, `tandem_save` should warn or refuse if the round-trip would lose content compared to the original file.

**Key insight:** A WYSIWYG editor that silently drops content it can't render is worse than one that refuses to open the file. The lossless round-trip guarantee in Step 5a only holds for the markdown subset Tiptap understands. Any markdown feature outside that subset — tables, footnotes, definition lists — is silently destroyed. Test round-trip fidelity on representative documents, not just simple markdown.

## 46. Annotation Offsets Can Diverge Between Editor and Server After File Edit

**Problem:** A user placed an annotation on the "Progressive Web App (PWA)" text near the bottom of `docs/roadmap.md`. When read via `tandem_checkInbox`, the `textSnippet` returned text from the Svelte probe section ~200 lines earlier. The annotation rendered correctly in the editor (highlight was on the right text) but the server's flat offset resolution pointed to the wrong location.

**Investigation (pending, #377):** Likely cause is that the editor's ProseMirror-to-flat-offset conversion and the server's `extractText()` disagree on character positions — possibly because the file was recently edited (PR #375) and the editor had a stale or differently-formatted Y.Doc. The CRDT RelativePosition anchors should handle this, but if they resolve against a different Y.Doc state than the flat offsets, the mismatch manifests as "correct in editor, wrong on server."

**Key insight:** The three-coordinate-system design (flat offsets, ProseMirror positions, CRDT RelativePositions) means any divergence between what the editor sees and what the server has produces silent misbehavior — Claude responds to the wrong text. This class of bug is invisible to unit tests that only exercise one coordinate system at a time. End-to-end testing must verify that annotations placed in the editor resolve to the same text on the server.

## 47. Tag Release Commits Only After All Fixes Are Merged

**Problem:** The v0.8.0 tag was pushed at the version-bump commit (`c096ab5`) before the `tokio` `macros` feature fix (`1ced4ba`) was merged. The Windows build failed because `tokio::join!` requires the `macros` feature flag. The draft release had Linux + macOS assets but no Windows installers.

**Fix:** Deleted the broken draft release, deleted the tag (both remote and local), merged the remaining fixes, and re-tagged at the correct commit. Order matters: the draft release MUST be deleted before pushing a new tag, because `tauri-apps/tauri-action@v0` searches for existing drafts by tag name and appends assets — creating name collisions with the partial artifacts.

**Key insight:** A version-bump commit is not a release-ready commit. The tag should go on the commit where CI is green and all release-scoped fixes are merged — not on the commit that changes the version number. For Tauri releases specifically: delete draft + remote tag + local tag, then re-tag. The `tauri-action` draft-reuse behavior means stale drafts are toxic to re-releases.

## 48. NSIS Installer Hooks Only Cover the Sidecar — Tauri Handles the Main Binary

**Problem:** During v0.8.0 upgrade installs, the NSIS installer failed to replace `node-sidecar.exe` with "Error opening file for writing" because the sidecar process was locked. The initial fix proposal used `taskkill /F /IM` to kill both `Tandem.exe` and `node-sidecar.exe`, but code review revealed two problems: (1) the main binary name is `tandem-desktop.exe` not `Tandem.exe`, and (2) Tauri already runs `CheckIfAppIsRunning` immediately after `NSIS_HOOK_PREINSTALL` with a user-facing dialog and graceful shutdown.

**Fix:** The `NSIS_HOOK_PREINSTALL` macro should ONLY kill the sidecar process. Use `nsis_tauri_utils::KillProcessCurrentUser` (not raw `taskkill`) for user-scoped kill that's consistent with how Tauri handles the main binary. Allow 2 seconds for file handles to release — the Rust side uses a 5-second polling loop for the same reason (`TerminateProcess` returns before Windows releases the exe file handle).

**Key insight:** Read the generated NSIS template (`src-tauri/target/release/nsis/x64/installer.nsi`) before writing installer hooks. It shows exactly which macros Tauri calls, in what order, and what utilities are available (`nsis_tauri_utils`). The binary name comes from `Cargo.toml [package].name`, not `tauri.conf.json productName`.

## 49. SDK `package.json` Resolves to CJS Stub via Exports Map

**Problem:** `require("@modelcontextprotocol/sdk/package.json")` in `tsup.config.ts` resolved to `dist/cjs/package.json` — a CJS type marker (`{"type": "commonjs"}`) without a `version` field — instead of the root `package.json`. `JSON.stringify(undefined)` returned `undefined`, which esbuild rejected as an invalid define value, breaking the CI build.

**Root cause:** The SDK's `exports` map doesn't expose `./package.json`. Node's CJS resolver falls through to `dist/cjs/package.json` (a real file in the dist tree). The `createRequire`-based require follows the same resolution path, so `require.resolve("@modelcontextprotocol/sdk/package.json")` returns the stub, not the root.

**Fix:** Resolve the stub path, then walk back past `dist/` to find the package root: `sdkStub.slice(0, sdkStub.lastIndexOf("dist"))` + `readFileSync(join(sdkRoot, "package.json"))`. A `typeof` guard in `server.ts` falls back to `"0.0.0-unknown"` in dev/test environments where tsup hasn't run.

**Key insight:** `require("some-package/package.json")` is not guaranteed to return the root `package.json` when the package has an `exports` map. Always verify that the resolved path is what you expect — `require.resolve()` can reveal the actual target. This is especially treacherous in build-time config files where the error surfaces in CI (where tsup runs) but not in dev (where tsx skips it).

## 50. AbortSignal.any Is Not Available in Older Safari / WKWebView

**Problem:** `useAppInfo` combined two abort signals via `AbortSignal.any([signal, AbortSignal.timeout(3000)])` — an idiomatic pattern for "whichever comes first" timeout + cleanup cancellation. This worked in Chrome and modern Safari, but Tauri's WKWebView on macOS 13 uses Safari 16, where `AbortSignal.any()` is undefined. The hook crashed on mount, leaving the Settings footer permanently in "loading" state.

**Fix:** Replace `AbortSignal.any` with the manual equivalent: a local `AbortController`, a `setTimeout` that calls `controller.abort()`, and a cleanup function that clears the timeout. More verbose but universally supported.

**Key insight:** Tauri's WKWebView version is pinned to the OS's Safari version, not the latest Safari release. macOS 13 ships Safari 16; macOS 14 ships Safari 17. Any Web API that landed in Safari 17+ (`AbortSignal.any`, `Set.prototype.intersection`, `URL.canParse`) is unavailable to Tauri users who haven't upgraded macOS. Always check MDN's Safari version column, not just "Safari: Yes", and treat the minimum supported macOS version as the API floor.

## 51. Browser Testing with Y.js Writes File Content Back to Disk

**Problem:** Clicking "View Changelog" opened `CHANGELOG.md` as a document tab, which created a Hocuspocus room and synced the file's Y.Doc state to the browser. When the dev server session auto-saved, the Y.Doc's representation of the changelog — which included content merged from the session restore — was written back to disk, producing a 1200-line diff in `CHANGELOG.md` that had nothing to do with the code changes.

**Fix:** After browser testing sessions that open real files, always `git checkout -- <file>` to restore the on-disk state before committing. Alternatively, use `readOnly: true` on test document opens to prevent session writes (which is what the View Changelog feature does in production — but the session file may still grow).

**Key insight:** The Tandem dev server treats every open file as a live Y.Doc with session persistence. Opening a file in the browser during manual testing is a write operation from the CRDT's perspective — even read-only documents populate a session file. Always check `git diff` after browser testing before committing, especially for files that weren't part of the feature under test.

## 52. Discriminated Union Variants Need Exhaustive Handling, Not Default Fallthroughs

**Problem:** `useDragResize` handled right-side drag with a two-arm conditional: `if (layout === "tabbed") { ... } else { /* three-panel logic */ }`. When `tabbed-left` was added as a third `PanelLayout` variant, right-drag silently fell into the three-panel branch — writing to a `right` width key that `tabbed-left` doesn't have, and reading from a `left` key that three-panel interprets differently. No TypeScript error, no runtime error, just wrong resize behavior.

**Fix:** Explicit arm-per-kind handling with an exhaustive pattern. Each layout variant gets its own branch with explicit localStorage key guards (`"left" in current` / `"right" in current`). TypeScript's control flow analysis ensures new variants produce a compile-time error if unhandled.

**Key insight:** When extending a discriminated union, grep for every `if/else` and `switch` that branches on the discriminant. A `default` or `else` branch that "handles everything else" silently absorbs new variants — this is the most common source of bugs when adding variants to an existing union. Prefer explicit arms that TypeScript can exhaustiveness-check over catch-all defaults.

## 53. Silent v0→v1 Migrations Destroy Forensic Trail

**Problem:** ADR-027's audience-based annotation model required migrating legacy `type:"flag"` records to `type:"note"` and stripping the deprecated `directedAt` field. The first implementation did both rewrites silently — `migrateFlagAndDirectedAt()` mutated the record in place, `parseAnnotationDoc` swallowed JSON-parse failures, and `migrateToV1` aggregated dropped records into a single count. When users hit issues post-migration, there was no log to correlate against. Three independent review agents (code-reviewer, silent-failure-hunter, pr-test-analyzer) converged on this as the top recurring weakness in the PR.

**Fix:** New `src/server/annotations/migration-log.ts` module exporting `loggedLegacyMigrations: Set<string>` keyed by `${docHash}:${kind}` for once-per-(doc, kind) dedup. Both `schema.ts` and `sync.ts` import from it (avoids the cycle that would form if either owned the Set directly — `sync.ts` already imports from `schema.ts`). `migrateToV1` logs each dropped record's id + Zod issues; `parseAnnotationDoc` logs JSON-parse failures and non-object payloads; the `directedAt` strip fast-path logs once per doc.

**Key insight:** A migration that silently rewrites data on read is a debugging black hole — operators see effects (data shape changes) but no cause (which migration fired, on which records). Log every silent rewrite at least once per doc per kind, with enough context (record id, error reason) to correlate against bug reports. Dedup is essential — a hot read path will spam logs without it. The shared-state-via-third-module pattern (extracting `loggedLegacyMigrations` to a new file rather than reversing an existing import) is the right way to break circular-import constraints when both modules need access.

## 54. Package Removal in Git Worktrees: Windows Node Resolution Masks CI Failures

When removing an npm package from `package.json` and running `npm install` in a git worktree, Node.js module resolution walks parent directories. On Windows, `tsc` and other tools will silently find the removed package in the main repo's `node_modules`, making local typecheck pass while CI (clean checkout, no parent fallback) fails.

**Rule:** After removing a package, verify it is truly gone by checking `node -e "console.log(require.resolve('<pkg>'))"` from inside the worktree's directory. If it resolves to a path outside the worktree, the removal is masked locally. Always grep for remaining imports (`grep -r "from '<pkg>'"`) and fix them before pushing.

## 55. Restart Long-Lived Backend State Before Browser Verification

**Problem:** Re-running the browser regression subset against an already-live Tandem backend surfaced intermittent MCP `Internal error` failures on open calls even though the code changes themselves were fine. The stale server, WebSocket, and browser processes from earlier runs were holding onto state that made the next suite execution noisy and misleading.

**Fix:** Before re-running browser smoke after a failure, identify and restart the long-lived Tandem server and dev server processes, then re-run the exact changed specs instead of assuming the old backend state is still trustworthy.

**Key insight:** Browser tests that depend on MCP/Yjs state are only as reliable as the backend session they attach to. If a run starts acting nondeterministic, restart the shared processes first; do not treat stale transport state as a product regression until you have a clean backend.

## 56. WAI-ARIA APG Toolbar Pattern for Transient Contextual Toolbars

WAI-ARIA APG Toolbar Pattern §3 classifies arrow-key navigation as MAY (not MUST) for transient contextual toolbars. Tab/Shift+Tab through buttons plus Escape-to-close is fully APG-compliant. No roving tabindex is needed. Slash-menu key collision is not possible because the slash menu's handleKeyDown only fires when slashCommandPluginKey state is active AND focus is in the editor view — a focused toolbar button is outside the editor view.

## 57. `tauri_build::build()` Checks All Declared Resources, Not Just the Sidecar

**Problem:** When adding `cargo test` to CI, `tauri_build::build()` failed because the sidecar binary (`binaries/node-sidecar-{triple}`) didn't exist AND because `dist/channel`, `dist/server`, and `dist/client` (declared as `resources` in `tauri.conf.json`) don't exist in a clean repo checkout.

**Solution:** Create stubs before running `cargo test`:
```bash
mkdir -p src-tauri/binaries dist/channel dist/server dist/client
touch "src-tauri/binaries/node-sidecar-${TRIPLE}" "src-tauri/binaries/node-sidecar-${TRIPLE}.exe"
```
Touch both with and without `.exe` so the same step works on Linux and Windows runners.

## 58. Ubuntu CI Needs GTK/WebKit System Libs for `cargo test` on Tauri Projects

**Problem:** `glib-sys` and `gobject-sys` crates fail to build on a bare Ubuntu runner because they need system headers.

**Solution:** Add an "Install Linux dependencies" step before any `cargo build/test` invocation:
```yaml
- name: Install Linux dependencies
  if: matrix.os == 'ubuntu-latest'
  run: sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```
Mirror the identical step already present in `tauri-release.yml`.

## 59. `tauri-plugin-decorum`'s `create_overlay_titlebar()` Must Be Called After Page Load, Not in `setup()`

**Problem:** `create_overlay_titlebar()` injects JS hit-test logic (`WM_NCHITTEST` intercept) into the WebView. The WebView clears that injected JS on page navigation. Calling it in Tauri's `setup()` means the JS runs before the page loads and is then wiped — button clicks land on the caption area (HTCAPTION) and the OS treats them as window-drag rather than forwarding them to the WebView.

**Solution:** Expose a `#[tauri::command]` (e.g., `setup_overlay_titlebar`) that calls `create_overlay_titlebar()`, and invoke it from the relevant Svelte component's `onMount` after the page has fully loaded.

## 60. Vitest for Svelte Components Using `invoke` Must Mock `@tauri-apps/api/core`

**Problem:** If only `@tauri-apps/api/window` is mocked, a component that does `Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/window")])` throws (no `invoke` export from the real module in happy-dom). The `onMount` catch swallows the error and `win` is never assigned — button clicks silently no-op with no visible failure.

**Solution:** Add `vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))` alongside the window mock. Also add a hardening test that asserts button handlers still fire even when `invoke` rejects, so future regressions surface via a different signal rather than silent no-ops.

## 61. Tauri Desktop Smoke Test for Live Theme-Flipping Requires the App Window to Have Focus

**Problem:** `useTauriTheme.svelte.ts` polls `get_app_theme` only when `document.hasFocus()` is true. During a manual smoke test, switching to Windows Settings to flip the OS theme causes the Tandem window to lose focus. The poll won't fire until the tester clicks back into the app.

**Solution:** Instruct smoke testers to click back on the Tandem window after flipping the OS theme before checking whether the theme updated.

## 62. Agent Branch Checkouts Stomp Uncommitted Working Tree Changes

**Problem:** When dispatching parallel implementation agents to work on different PR branches within the same git working tree, each agent runs `git checkout <their-branch>`. If you have uncommitted edits (e.g., a one-line fix staged but not committed), the branch switch silently carries those changes to the new branch — or discards them if the file doesn't exist on the target branch. The working tree ends up in an unexpected state.

**Solution:** Commit or stash any in-progress changes before dispatching agents that will call `git checkout`. Better: use `isolation: "worktree"` so agents operate in an isolated copy of the repo and can't affect each other's working trees.

## 63. Sequential PR Merges Accumulate CHANGELOG/CLAUDE.md Conflicts

**Problem:** When several PRs are merged to master in sequence and each one touched `CHANGELOG.md` and/or `CLAUDE.md` (unreleased entries, testid list), every subsequent branch needs a merge-master step that conflicts in the same two files. This is expected but easy to forget — the conflict is always the same pattern: HEAD has the branch's new entry, origin/master has the entries from previously-merged PRs.

**Solution:** Resolve by keeping ALL entries from both sides (no lines lost). The CHANGELOG `### Added` block and CLAUDE.md testid list should be additive — concatenate, don't pick one side.

## 64. `gh pr merge --squash --auto` Is Disabled on This Repo

**Problem:** `gh pr merge --squash --auto` returns `GraphQL: Auto merge is not allowed for this repository`. Auto-merge requires a branch protection setting that isn't enabled.

**Solution:** Use `gh pr merge --squash` (no `--auto`). If the branch has unresolved conflicts first update it: checkout → fetch origin master → merge → resolve → push — then merge.

## 65. Normative Default-Filling Should Not Emit SanitizationEvents

**Problem:** `sanitizeAnnotation` emitted `{ kind: "audience-derived" }` whenever it computed the `audience` field from annotation type. This fired on every annotation read, causing a console flood — the server-side dedup set helped, but client callsites had bare `console.warn` with no dedup.

**Solution:** Deriving a default from existing data is normative fill-in, not a lossy migration. Remove it from `SanitizationEvent` and `LegacyMigrationKind` entirely, and write the field explicitly at annotation creation time. Reserve `SanitizationEvent` only for actual lossy rewrites (type coercions, malformed data, field removal).

## 66. In-Memory Docs Need Explicit Channel Event Filter

**Problem:** Scratchpad documents (ephemeral, no file on disk) appeared as `document:opened` / `document:switched` channel events to Claude. The spec required they not be surfaced, but the channel event observer in `ctrl-meta.ts` had no upload-path filter.

**Solution:** Track upload/scratchpad doc IDs in a local `Set<string>` in `ctrl-meta.ts` and skip channel event emission for them. The Set needs to be maintained across open/close cycles because `getOpenDocs()` won't have the entry by the time the close event fires. See: `src/server/events/observers/ctrl-meta.ts`.

## 67. Triage Milestoned Issues Before Executing — Half May Already Be Done

**Problem:** In v0.11.0 planning, ~half of the scoped issues were already closed (#507, #492, #513–#522, #541) before implementation started. Dispatching agents to implement already-done work wastes significant time.

**Solution:** Always spend 5 minutes running `gh issue view <N>` on every milestoned issue before writing any code. For QA-closeout batches especially, do the triage pass first — it may eliminate the entire batch.

## 68. "Frozen Desktop UI" with Working Hover/Right-Click = Server Disconnected, Not JS-Hung

**Problem:** A user reported the v0.11.0 desktop app appeared frozen — buttons unresponsive — but the mouse cursor still changed on hover, native tooltips showed, and right-click worked. This pattern is easy to misdiagnose as a Svelte reactive loop / JS infinite loop (and the codebase has prior incidents of both). The actual cause was a stale `tsx watch src/server/index.ts` from an old `npm run dev:server` session squatting on ports 3478/3479 — the installed app's `start_sidecar` (`src-tauri/src/lib.rs:377`) did `if check_health() { skip spawn }`, trusted the dev server, but the WS handshake failed silently because of mismatched auth/session state. The status bar in fact reported "Disconnected", but the symptom description focused on "frozen UI."

**Solution (diagnostic):** When a desktop "frozen UI" is reported, **before** reading any Svelte/Tiptap code: (1) `Get-NetTCPConnection -LocalPort 3478,3479 -State Listen` and confirm the owning PID is a `node-sidecar.exe` (not a generic `node.exe` from a dev session); (2) `curl http://127.0.0.1:3479/health` to confirm version and `hasSession`; (3) look at the actual status-bar text — CSS hover, native tooltips, and right-click are all browser features that work without app JS, so "those still work" is consistent with disconnected just as much as with frozen JS.

**Solution (code):** Gate the `check_health` reuse early-return in `start_sidecar` on `cfg!(debug_assertions)`. Release builds always spawn their own sidecar; `freePort()` resolves port conflicts cleanly. Also drop `stdio: "ignore"` from `taskkill` in `freePortWindows` so any future kill failure is logged and diagnosable instead of silent.

## 69. CHANGELOG.md Was Silently Rewritten on Every Upgrade

**Problem:** After every release, the working tree on dev machines (and on user installs) showed a noisy `CHANGELOG.md` diff: `[1.0.0]` → `\[1.0.0]`, escaped underscores, escaped backticks. The diff was cosmetic — Markdown-equivalent — but accumulated on every release and confused anyone inspecting `git status` post-upgrade. Root cause traced through four layers: (1) `src/server/index.ts:357-365` auto-opened `CHANGELOG.md` writable on version upgrade, (2) `autoSaveAllToDisk` (`document-service.ts:217-230`) ran every 60s and serialized writable docs back to disk, (3) `saveMarkdown()` in `file-io/markdown.ts:11-20` called `remark-stringify` with no `handlers`/`unsafe` overrides, and (4) default `remark-stringify` escaping is conservative for hostile input — it backslash-escapes any character that *could* be Markdown-significant, which is wrong for content coming from Tandem's structured ProseMirror model.

**Surface-level fix (PR #603):** Pass `readOnly: true` to the upgrade-path `openFileByPath` call. `autoSaveAllToDisk` already skips `state.readOnly` documents (`document-service.ts:219`), so no save-path change was needed. Matches what the existing "View Changelog" button in Settings already does.

**Proper fix (issue #605, v0.12.0 milestone):** Configure `remark-stringify`'s `unsafe` extension or per-node `handlers` to stop over-escaping. The surface fix only covers `CHANGELOG.md`; the same noise still affects **any** `.md` file a user round-trips through Tandem. Needs golden-file fixtures to lock in correct behavior.

**Key insight:** When you see unexpected churn in a file on a clean checkout, suspect the autosave round-trip *before* assuming someone hand-edited it. Tandem treats every writable open file as a live Y.Doc that will be serialized back to disk on the next autosave tick. The escape hatch is `readOnly: true` on the open call — but the underlying serializer config is the real fix.

## 70. Playwright `locator.dragTo()` Does Not Fire HTML5 Drag Events

**Problem:** PR #625 added a `mouse drag reorders tabs` E2E spec to guard the drag-to-reorder fix in `DocumentTabs.svelte`. The spec used `from.dragTo(to, { targetPosition: ... })`. On Chromium, Playwright's `dragTo()` synthesizes `mousedown` / `mousemove` / `mouseup` — it does **not** dispatch HTML5 `dragstart` / `dragover` / `drop`. The production handlers in `DocumentTabs.svelte:218-220` listen to HTML5 drag events exclusively, so the spec passed on master (where reorder was broken) and on the branch — it never exercised the production code path it was supposed to guard. The multi-agent review on PR #625 caught it; otherwise it would have shipped as a false-positive regression guard.

**Solution:** Dispatch real HTML5 `DragEvent`s via `page.evaluate`. Two gotchas worth remembering:

1. **The `DragEvent` constructor ignores the `dataTransfer` init dict** on both Chromium and happy-dom — `new DragEvent("drop", { dataTransfer: dt })` leaves `event.dataTransfer === null`. Build a generic `Event` and assign `dataTransfer` via `Object.defineProperty(evt, "dataTransfer", { value: dt, configurable: true })`. Same for `clientX` / `clientY`. See `tests/e2e/tab-overflow.spec.ts` `mouse drag reorders tabs` for the canonical recipe.
2. **A single shared stub `DataTransfer`** (with `setData` / `getData` storing into a closure-scoped object) preserves the round-trip that real DnD would do, so the production code's `dataTransfer.getData("text/plain")` fallback path is still exercised.

**Companion lesson:** For reactive-race regressions where the bug requires interleaving an async event (a Yjs awareness ping re-deriving an upstream prop) *between* dragstart and drop, the synchronous `page.evaluate` recipe is not sufficient — the race never opens. Move that regression guard into a Vitest component test that uses `render` + `rerender` from `@testing-library/svelte` to simulate the mid-drag prop change explicitly. See `tests/client/DocumentTabs.svelte.test.ts` case B.

**Key insight:** Playwright is a mouse simulator, not a DOM-event simulator. Whenever the production handler is listening on a non-pointer event family (drag, paste, contextmenu, etc.), assume Playwright's high-level helpers won't fire it and dispatch the event explicitly. Verify by running the proposed spec against a bugged version of the code *before* trusting it as a regression guard.

**Update (tab reorder migrated to pointer events):** the HTML5-DnD tab reorder was itself broken in the Tauri desktop app — `dragDropEnabled: true` in `tauri.conf.json` (required by the native file-drop-to-open bridge in `useTauriFileDrop.svelte.ts`) makes the WebView **swallow all HTML5 drag events**. The synthetic-`DragEvent` E2E recipe above passed anyway because it never exercised native drag initiation, so the breakage went unnoticed. The fix reimplements reorder on **pointer events** (`pointerdown`/`pointermove`/`pointerup` + pointer capture), which Tauri does not suppress. The happy benefit: `page.mouse.down/move({steps})/up` *does* synthesize real pointer events, so `tests/e2e/tab-overflow.spec.ts` now drives the production path with native mouse steps — no `page.evaluate` synthetic-event hack needed. Two follow-on gotchas from that work: (1) a drag that ends over a *different* element often fires **no** trailing `click`, so a `{once:true}` click-suppressor lingers and eats the next legit click — add a `setTimeout(0)` cleanup fallback; (2) component tests that don't dispatch the trailing click leave that suppressor attached to `window`, polluting later tests — flush macrotasks in `afterEach`.

## 71. DOM-Nested Positioning Beats Manual Scroll Sync for Content-Anchored Overlays

**Problem:** PR #657 (#649 margin annotation view PR 1) needed to render bubbles in the document gutter at the vertical position of their anchor text, and have those bubbles follow the text as the user scrolls. The natural-but-wrong design is "margin column is a sibling of the editor at the scroll-container box level, with a `scroll` listener that re-applies `transform: translateY(-scrollTop)` to all bubbles." That path forces an rAF-throttled scroll listener, drags in identity-comparison plumbing to avoid the `effect_update_depth_exceeded` Svelte gotcha (see lessons in `feedback_svelte_state_bind_this_loop` and `feedback_svelte_effect_depth_guard` for prior incidents in this repo), and still produces sub-frame jitter on fast scrolls because the listener fires after layout has already painted.

**Solution:** Nest the overlay inside a `position: relative` positioning layer that wraps the editor content, all inside the existing `.editor-scroll` overflow container. Compute each bubble's `top` as `view.coordsAtPos(pos).top - layer.getBoundingClientRect().top`. That value is **scroll-invariant** by construction — both terms shift by the same `scrollTop` when the user scrolls, so the difference is constant. The bubble scrolls naturally because it lives inside the layer, which is inside the scrolling content.

**Recompute triggers (still required):**
- `editor.on("transaction", ...)` — doc edits move anchors
- `ResizeObserver` on the positioning layer — width/font changes reflow
- **Not** `scroll` — by design

**Failure handling:**
1. **`coordsAtPos` throws on invalid positions** (deleted nodes, mid-transaction Y.js state, freshly-inserted but not-yet-rendered ranges). Wrap per-annotation in `try/catch` and skip the offending bubble for the frame — one stale anchor must not kill the whole render pass.
2. **Sub-pixel jitter from reflow is real.** Compare last and next position maps with a 0.5px tolerance before re-assigning the reactive `$state`. Without the tolerance, a `clientHeight: 700.0` → `699.7` reflow propagates into every downstream `$effect` that reads the map.

**Where this lives:** `src/client/hooks/useMarginPositions.svelte.ts` (composable), `src/client/panels/MarginColumn.svelte` (overlay container), `src/client/App.svelte` (positioning-layer wrapper around the editor branch). See PR #657 commit `49ec66f`.

**Key insight:** Whenever a brief sounds like *"X should appear next to Y and follow it as the user scrolls,"* the right move is DOM nesting, not listener plumbing. The "free scroll sync" comes from putting the overlay inside the same scrolling content as its anchor — the browser does the work the listener would have done, and you only need to react to actual layout changes. Reach for this pattern for sticky-position indicators, gutter dots, inline suggestion previews, comment bubbles, and similar content-anchored UI.

## 72. Narrowing CORS / Host Allowlists Requires a Three-Surface Audit

**Problem:** PR #637 narrowed the server's HTTP CORS / Host allowlist and the Hocuspocus WebSocket `onConnect` origin check in lockstep — `localhost` was dropped, only `127.0.0.1` and `tauri.localhost` accepted. Server-side unit tests (`tests/server/api-middleware.test.ts`) were updated to assert the rejection. CI ran and 98 of 106 E2E tests failed.

The change appears to have moved only the validator boundary, but three independent call-site surfaces also hard-coded `localhost`:

1. **Playwright config + E2E tests.** `playwright.config.ts` had `baseURL: "http://localhost:5173"` and the Vite webServer URL pointed at `localhost`; every `page.goto("http://localhost:5173")` in `tests/e2e/*.spec.ts` did too. With the in-browser page origin now `localhost`, the Hocuspocus `onConnect` rejected every WebSocket. Node-side fetches in `helpers.ts` (`MCP_URL`), `scratchpad.spec.ts` (`API_BASE`), and a `page.evaluate`'d `EventSource(...)` in `settings-and-filters.spec.ts` also sent `Host: localhost:3479`, which `isHostAllowed` rejected.
2. **Vite dev server.** Vite's `server.host` defaults to `localhost`. With Playwright then switched to `127.0.0.1`, the page origin was unambiguous only after pinning `server.host: "127.0.0.1"` so Vite binds and answers under the same hostname the test navigates to.
3. **Client code itself.** Even after fixing 1 and 2, five tests still failed: `Ctrl+W close tab`, `Ctrl+Alt+T reopen`, `Ctrl+N switch tabs`, relative-link tab-open, scratchpad-via-palette. Cause: `src/client/utils/fileUpload.ts` exported `API_BASE = http://localhost:${DEFAULT_MCP_PORT}`; `yjsSync.svelte.ts` POSTed `/api/close` to `http://localhost:3479`; `useNotifications.svelte.ts` opened an `EventSource` on `localhost`; `ChatPanel.svelte` DELETE'd `/api/chat` on `localhost`. The page origin was now `127.0.0.1`, but the fetch URL was still `localhost`, so the request hit the server with `Host: localhost:3479` and got 403'd silently. The tab-close request was silently dropped, so the test's `toHaveCount(0)` assertion saw the tab still there.

**Solution:** When narrowing a CORS or Host allowlist, before pushing the PR run:

```sh
rg "http://localhost" src/client tests/e2e playwright.config.ts vite.config.ts
rg "ws://localhost" src/client
```

Migrate every match in lockstep with the validator change. WebSocket URLs (`ws://localhost`) can be left alone *only if* the server's WebSocket gate is origin-based (Hocuspocus's is), not Host-based — the Origin header is the page origin, not the WS URL host.

**Key insight:** "Narrow the allowlist" looks like a server-only change, but every client that hard-codes a hostname is implicitly part of the allowlist contract. Server tests passing don't prove the change is safe — they prove the validator works. The validator working is exactly what makes silent client-side regressions appear.

## 73. Schema-Backed Enums Make Palette Migrations Self-Sanitizing

**Problem:** When a UI palette changes (e.g. highlight colors `{red, yellow, green, blue, purple}` → `{yellow, green, blue, pink}`), old persisted annotations and stale clients can still produce legacy values. Naive renderers either crash, render an unstyled fallback, or leak the legacy color into the new UI.

**Solution:** Two layers, both already in place for highlights as of v0.11.0 (verified during v1.0 §1H audit on master):

1. **Zod schema as the boundary gate.** `HighlightColorSchema = z.enum(["yellow", "green", "blue", "pink"])` in `src/shared/types.ts`. Every MCP tool input is parsed through this schema, so a `tandem_addHighlight({ color: "red" })` call fails validation at the tool boundary with a clear error — it never reaches the Y.Map.
2. **`normalizeHighlightColor()` as the read-time sanitizer.** `src/shared/constants.ts` exports `normalizeHighlightColor(color)` that returns `color as HighlightColor` if it's a key of `HIGHLIGHT_COLORS`, else falls back to `"yellow"`. Used by the renderer and toolbar so a legacy `"red"` highlight loaded from disk renders as yellow without throwing.

**Verification (v1.0 §1H, 2026-05-14):** Grepping `src/client` for `"red"` / `"purple"` in highlight contexts returns zero matches. `HIGHLIGHT_COLORS` / `HIGHLIGHT_COLOR_VARS` / `HighlightColorSchema` all agree on `{yellow, green, blue, pink}`. The `showAuthorship` default is `true` in `useTandemSettings.ts`, and the loader preserves an explicit `false` while defaulting missing/legacy values to `true` (`parsed.showAuthorship === false ? false : DEFAULTS.showAuthorship`) — same self-sanitizing pattern, applied to a boolean default flip instead of an enum.

**Key insight:** A palette or default-value migration doesn't need a one-shot migration script if both write paths (schema validation) and read paths (normalize-on-read) are owned. The schema rejects new bad data, the normalizer absorbs old bad data, and the system converges without a flag day. Worth checking both layers exist whenever someone proposes "let's change the default of X" — if only one is in place, you'll get either crashes (no normalizer) or silent persistence of the old default (no schema gate).

## 74. Distinguish a Re-Sync from a Re-Command with an Epoch, Not a Value

**Problem:** The active document id is broadcast server→browser in `documentMeta` (CTRL_ROOM + every per-doc room) on every open/close/switch. But a local tab switch (Ctrl+1..9 / click) is *not* propagated to the server — it only sets client-local `activeTabIdState`. The reconcile (`handleDocumentList`) re-applied the server's active id on every sync, so any late per-tab `documentMeta` sync arriving *after* a local keyboard switch reverted it. This made `tests/e2e/keyboard-shortcuts.spec.ts` "Ctrl+N switches to the Nth tab" flaky: under CI load a stale re-broadcast landed after the keypress and snapped the active tab back. A previous 10s→15s timeout bump didn't help — it assumed slow rendering, not a revert.

**Why a value guard is insufficient:** "Skip the reconcile when the active id is unchanged" breaks a legitimate event — re-opening the *already-active* doc (`handleAlreadyOpen` → `setActiveDocId` → `broadcastOpenDocs`) writes the same value but is an intentional focus request. A value can't distinguish a stale CRDT replay from a genuine re-command. (Also note: Yjs `Map.set(key, sameValue)` *does* fire observers — suppression must happen in the observer's logic, not by relying on the write being skipped.)

**Solution:** A monotonic activation epoch. `setActiveDocId` increments `activeDocEpoch` on **every** call (even unchanged id); `broadcastOpenDocs` writes `Y_MAP_ACTIVE_DOCUMENT_EPOCH` in the same transaction as the active id. The client applies the server's active only when the epoch differs from the last it applied (`resolveActiveTabId` in `src/client/hooks/tab-reconcile.ts`). A stale replay carries the already-applied epoch (skip → local switch preserved); a genuine (re)activation carries a new epoch (apply → focus-steal preserved). `!==` (not `>`) survives a server-restart epoch reset.

**Key insight:** When local optimistic state can be clobbered by an idempotent server re-broadcast, the discriminator must be a *change token* (epoch/sequence), not the payload value — identical values can mean either "nothing happened, just re-syncing" or "do this again." Extract the decision into a pure function (mirrors `pickTabByDigit`) so the gate is unit-testable without a live provider. The E2E settle-gate (wait for the server's active tab to land before pressing) is a complementary guard against fragmented initial sync, not the fix itself.

## 75. A SIGKILL Between writeFile and rename Orphans Atomic-Write Temps — Only a Startup Sweep Can Reap Them

**Problem:** `atomicWrite`/`atomicWriteBuffer` (`src/server/file-io/index.ts`) write a `.tandem-tmp-<ts>-<12hex>` sibling, then `rename` it over the target. The rename error path already unlinks the temp on terminal failure, so *failed writes* never orphan. But when the process is **SIGKILLed** in the window between `fs.writeFile` and `fs.rename` — dev `cargo tauri dev` restarts, force-quits, crashes — the temp survives with no in-process cleanup ever able to catch it. 28 had silently piled up in a real annotations dir.

**Solution:** `reapOrphanedTemps` (`src/server/file-io/reaper.ts`), fired un-awaited at boot near `cleanupSessions()`, sweeps the annotations + sessions dirs (the only dirs Tandem owns — never user document dirs) for temps older than **1 hour**.

**Two non-obvious correctness points:**
- **The 1-hour age gate, not the store lock, closes the concurrent-instance race.** A second instance starting concurrently might have an in-flight write whose temp is seconds old. The annotation store lock would *seem* like the guard, but session-dir writes aren't gated by it — so gating the reaper on the lock would still let it delete a peer's fresh session temp. An age gate is the only thing that's correct across both dirs: anything older than an hour is unambiguously dead regardless of who's running. (The reaper *additionally* skips entirely when read-only, but that's defense-in-depth, not the race fix.)
- **The match regex is the deletion boundary, and it must be exact.** `^\.tandem-tmp-(\d+)-([0-9a-f]{12})$` — anchored both ends, fixed 12-hex suffix. This is what guarantees `store.lock`, `<hash>.json`, `.corrupt.<ts>`, `.future`, and session `.json` files can never be matched. A loose regex on a destructive sweep is a data-loss bug waiting to happen; the `$` anchor alone is what rejects `<valid-temp-name>.bak`.

**Key insight:** Crash-window orphans are structurally invisible to the code that created them — the only process that could clean up is already dead. The fix lives at the *next* boot, not in the write path. When the cleanup is destructive and runs against shared dirs, the safety comes from two independent gates (an exact-match filename regex *and* a time threshold that survives concurrent peers), and from firing it fire-and-forget-with-`.catch()` so a stray rejection can't reach the process-killing `unhandledRejection` handler.

## 76. Verify a Feature's Shipped-State in Code Before Planning to Build It

**Problem:** The roadmap listed AR5 (`.docx` Word-comment import → private-note → batch-promote) and AR6 (tutorial annotations) under "v0.14.0 — Planned." Taken at face value, the next move would have been to *implement* them. Two research passes instead found both were already fully implemented and live — AR5 via Wave 8 (#756), AR6 via the pre-existing tutorial seeding path. The real gap was not the feature; it was **test coverage** gating their v1.0 exit criteria, plus a stale roadmap line.

**Solution:** Before scoping, grep the codebase for the feature's mechanics (`injectCommentsAsAnnotations`, `promoteNotesToComments`, the channel observer's promote branch, `injectTutorialAnnotations`) and confirm what exists. The work then correctly re-scoped from "build AR5/AR6" to "harden AR5/AR6 to the exit gate" — a much smaller, test-only change with no production behavior change.

**Key insight:** Roadmap/status docs lag the code; they describe intent at write-time, not current reality. A planning step that trusts them can lead you to rebuild shipped work or miss that the true gap is elsewhere (tests, docs, a single edge case). The cheap insurance is a code-grep confirmation of shipped-state as step zero of planning — and, when you find drift, fix the status doc as part of the same change.

## 77. Two Privacy Surfaces, Two Different Gates — Channel Emit Keys on author+type, MCP-Read Keys on audience

**Problem:** During plan review an adversarial agent caught a real error: the plan asserted the channel-event gate (what surfaces an annotation to Claude in real time) keys on `audience === "outbound"`. It does not. The channel observer's promote branch (`src/server/events/observers/annotations.ts`) keys on `action === "update" && ann.author === "user" && ann.type === "comment" && oldRaw?.type === "note"`. `audience` is never read there. `audience` gates the *separate* MCP-read surface (`tandem_getAnnotations` excludes `type === "note"` and reports `notesExcluded`).

**Solution:** Tests and reviews must target the predicate of the surface they claim to cover. The promote-path coverage was split accordingly: the channel test asserts `author`/`type`/note-predecessor (and the privacy negatives — un-promoted notes, imports, and author-not-flipped writes must NOT emit); the integration/MCP-read assertions check `audience: "outbound"` and `type !== "note"`. A correctly-promoted annotation must satisfy *both* gates, but a single assertion on `audience` proves nothing about channel visibility, and vice versa.

**Key insight:** When a privacy invariant is enforced at more than one boundary, each boundary has its own discriminator — conflating them produces a test that passes while the surface it names is unguarded. Name the surface, find *its* gate in the code, and assert that exact predicate.

## 78. A Freshness / Snapshot Guard Must Exercise the Real Operation, Not Compare a Lossy Projection

**Problem:** The AR6 anchor-drift guard was first written to assert `extractText(liveDoc) === extractText(snapshotDoc)` — comparing the flat-text projection that tutorial anchoring's `indexOf` step resolves against. Code review (two reviewers, independently) flagged that this is lossy: `extractText` strips inline marks and flattens block structure, so two structurally-different documents can share an identical projection while real `anchoredRange` behaves differently (e.g. an offset that lands in a heading prefix in one but not the other, flipping `fullyAnchored` and silently dropping the annotation). The projection-equality check is exactly the silent-failure class the guard claimed to defend.

**Solution:** Run the *real* `injectTutorialAnnotations` against the live doc and assert each produced range slices back to its target text (`liveFlat.slice(ann.range.from, ann.range.to) === target`) plus uniqueness. Because the offsets now come from production's `indexOf`/`anchoredRange` rather than from the test, the assertion fails if real anchoring breaks — block-structure divergence included. (A parallel finding: an e2e "anti-tautology" slice that derives its own offset via `indexOf` and then slices the same string is tautological — there, the CRDT `relRange` round-trip via `relPosToFlatOffset` is the load-bearing guard, not the flat slice.)

**Key insight:** A guard that compares a *derived/lossy view* of two inputs tests the view, not the behavior. Prefer running the actual operation and asserting its observable output, so the test fails for the same reasons production would. If an assertion's inputs and expected value both come from the same source string, it's tautological — make the value come from the code under test.

## 79. A Merged PR's Head Branch May Be Auto-Deleted — `--force-with-lease` Then Fails "stale info"; Use a Plain Push

**Problem:** Continuing work on the same feature branch after its first PR squash-merged, `git push --force-with-lease` failed with `! [rejected] ... (stale info)` on every retry. The lease was comparing against a remote-tracking ref for a branch that **no longer existed** — GitHub's auto-delete-head-branch-on-merge had removed it. `git ls-remote origin <branch>` returned empty, confirming deletion.

**Solution:** When the remote branch is gone, a plain `git push -u origin <branch>` recreates it (no lease to satisfy). `git remote prune origin` first to clear the stale tracking ref. Also relevant in fresh web-execution containers: the `pre-push` hook runs `cargo test` on the Tauri crate, which needs GTK dev libs (`libgtk-3-dev` / `libwebkit2gtk-4.1-dev` / …) and sidecar/`dist` stubs — install them (per the CI notes in CLAUDE.md) rather than reaching for `--no-verify` (which the `block-no-verify` hook blocks anyway).

**Key insight:** `--force-with-lease` protects against *overwriting* a moved ref; it is the wrong tool when the ref was *deleted* — "stale info" there means "gone," not "someone else pushed." Check `ls-remote` before assuming a race. And a green local suite doesn't get you past a hook that builds a whole other toolchain — provision the environment the hook expects.

## 80. To Preserve a Parsed-But-Unsupported Markdown Construct, Re-Emit It as an mdast `html` Node — Verbatim and Escaper-Proof

**Problem:** `remark-gfm` parses footnotes, reference-style links, and inline HTML into structured mdast nodes (`footnoteReference`, `definition`, `linkReference`, …) that carry **no `.value` string**. The `mdast↔Y.Doc` mapping's `default` cases only preserved value-bearing nodes, so all of these were **silently dropped** on load and vanished on the first save (#981). Re-inserting their source as plain `text` nodes doesn't work either: `remark-stringify` runs its `text` handler over them and escapes `[`/`]`/`^`, so `[^1]` round-trips as `\[^1]`.

**Solution:** store the construct's verbatim markdown source (via `serializeMdastBlock`/`serializeMdastInline`, which reuse the configured serializer) and re-emit it as an mdast **`html` node**. `mdast-util-to-markdown`'s html handler is literally `return node.value || ''` — it never calls `state.safe()`, so the value is written byte-exact, bypassing the escaper entirely. This is the same mechanism the pre-existing `markdownHtml` raw-HTML-block path already used; #981 generalized it to a `markdownRaw` paragraph attribute (block) and a `rawMarkdown` mark (inline). The round-trip is a stable fixed point: re-parsing the emitted `[^1]` / `[^1]: …` reproduces the same gfm nodes.

**Key insight:** the `html` node is the one mdast type that serializes its content **literally**. When you need to round-trip *anything* the editor has no first-class node for, store the source as text and reverse-map it to an `html` node — don't try to out-clever the escaper from the `text` handler. Two coupled gotchas the agent review caught: (1) the inline mark name must be added to the server `ALL_MARKS` allowlist or `buildAttrs` writes it as `null` and y-prosemirror drops it; (2) store raw source as **text/marks, never `insertEmbed`** — an embed counts as flat-length 1 and desyncs every annotation offset after it.

## 81. A Background Retry Guard Must Classify the Outcome Before Marking — "Attempted" ≠ "Don't Retry"

**Problem:** The Cowork self-heal pass (`cowork_heal_pass`, a 5-min background task that installs the plugin entry into workspaces lacking one) used a once-per-process `HEAL_ATTEMPTED` set to stop a persistently-failing workspace from looping. Its first design marked **every** workspace it touched as attempted, *before* knowing the outcome (`missing.filter(|ws| attempted.insert(ws.clone()))`). So a workspace that failed *transiently* — a momentary file lock, an I/O blip, a keychain hiccup — was permanently stranded: never retried for the rest of the process lifetime, silently un-configured until the user restarted the app or hit Re-scan, with only a `log::warn!` no one reads. The guard meant to prevent a loop instead converted every flake into a permanent silent failure. PR review's silent-failure hunter flagged it; the security/scope reviewers confirmed the fix direction.

**Solution:** classify the install outcome and record in the attempt set **only terminal outcomes** — success (`Ok`/`AlreadyPresent`) and the one structurally-permanent failure (`InsecureAcl`, a redirected/synced path that will never become a safe write target). Transient outcomes (`Locked`/`SchemaDrift`/`Failed`/error) are left *out* of the set, so the next tick retries them and a momentary glitch self-heals. The classification is a tiny pure helper (`heal_outcome_is_terminal`) that's unit-tested over every `WriteStatus` variant — capturing the regression-prone invariant without needing to mock the keychain/disk deps the full pass carries. The structure is read-then-write across two short lock scopes (snapshot the set, attempt, then `extend` with the terminals), which is race-free because the heal pass is a single serialized interval task. Accepted trade-off: a genuinely persistent *non-ACL* failure (e.g. a corrupt file the source never rewrites) re-attempts each interval and logs each time — low-harm at a 5-min cadence, idempotent write, and arguably correct since a real persistent problem should stay visible.

**Key insight:** a "do this once" guard in a retry loop must key on *terminal* status, not on *having tried*. Marking before you know the outcome turns the anti-loop guard into a silent-failure amplifier for exactly the transient errors that retrying would fix. Separate the two questions — "did I attempt this?" vs "will retrying ever help?" — and only the second belongs in the don't-retry set. Extract the classifier so the invariant is tested even when the surrounding effectful loop isn't.

## 82. Measure the Pipeline, Don't Read It — a Live Round-Trip Corrected Three Static-Analysis Fidelity Claims

**Problem:** Scoping the `.docx` round-trip fidelity work (Phase 0d), a thorough static-analysis pass over the import/export code produced a feature×fidelity map that was confidently **wrong in three places**, because it conflated "a mapping exists in the code" with "the data ever reaches that mapping." It claimed footnotes are *silently discarded* (mammoth has "no footnote handler"); that underline round-trips natively (`docx-html.ts` maps `<u>`→underline); and that embedded images survive as `data:` `ImageRun`s. A live import→export→reimport on real `docx`-package fixtures showed all three false: mammoth *transforms* footnotes into a trailing `<ol id="footnote-N">` + inline `<sup><a>[n]</a></sup>` (content survives as a list — Tier-A *recoverable*, not lost); mammoth omits `<u>` entirely by default so underline never reaches the existing map (dropped); and mammoth wraps images in `<p>`, where `htmlToYDoc` drops inline images — so Word images don't round-trip at all. The same run surfaced a finding the map missed: imported Word comments arrive as private `note`s (ADR-027) and the export gate emits only `type === "comment"`, so a plain open→save **silently drops every Word comment** from the file.

**Solution:** build the measurement harness first (`tests/helpers/docx-fidelity-harness.ts` + `tests/server/docx-roundtrip-fidelity.test.ts`) and treat its output as authoritative over any read of the code. The harness drives the **real** adapter (`getAdapter("docx").parse/apply/saveBinary`, which includes the comment pipeline — a body-only re-implementation would make comment assertions vacuous) and captures a structure-and-anchor-aware model (full Y.Doc tree with nesting + structural attrs + per-segment mark runs, plus resolved annotation anchors), not flat text. Each corpus fixture's manifest entry asserts the *current* shape positively, so a regression OR a fix fails red.

**Key insight:** for a data-transformation pipeline, static reading tells you what the code is *prepared* to handle; only running real inputs tells you what it *does*. A mapping that's never fed (underline), a transform mistaken for a drop (footnotes), and a schema constraint that defeats an upstream import (inline images) are all invisible to code-reading and obvious to a round-trip. Build the scoreboard before the fix — and let it, not the map, classify each feature. (Cross-check against single-finding lens: the harness also caught the Word-comment-drop, which no amount of reading the export gate in isolation would have flagged as a *round-trip* loss.)

## 83. One Repo, Two CSS Pipelines — Identical CSS Compiles Differently Depending On Which File It Lives In

**Problem:** the selection popup painted a stray frosted rectangle for 6 weeks, in production builds only (#1189). The shape that made it survive review: `.tandem-floating-pill` in `index.html` declared `backdrop-filter: blur(8px)` + its `-webkit-` twin, and `Toolbar.svelte` scoped a `backdrop-filter: none` reset over it — **two byte-identical hand-written pairs**. The reset won the cascade and worked perfectly in dev. In a real build only the recipe survived. The follow-up issue (#1188) then recorded the wrong mechanism — "lightningcss collapses prefixed pairs; targets don't help; swap to esbuild" — which would have been actively counterproductive, and no artifact anywhere explained why the recipe's *identical* pair hadn't collapsed too. That unexplained half is the whole lesson: if the collapse were the entire story, both declarations would have been inert and there'd have been no bug at all.

**Solution:** measure the pipeline (lesson 82's method) instead of reading it. `index.html`'s inline `<style>` is emitted **verbatim** — Vite never routes it through lightningcss, proven by all 39 of its CSS comments surviving into `dist/client/index.html` untouched. Component `<style>` blocks and `src/client/**/*.css` **are** minified (`build.cssMinify: true` falls through to lightningcss, not esbuild — see Vite's `minifyCSS`), proven by 5 `-webkit-user-select` declarations appearing in the bundle that exist nowhere in source. So the recipe survived because its file is untouched; the reset died because its file isn't. **The bug needed the asymmetry, not the collapse** — same pipeline on both sides, either way, and there is no bug. The authoring rule that falls out inverts the instinct: in bundled CSS **hand-writing a vendor prefix is what breaks it**, because lightningcss is an autoprefixer and a hand-written pair fights it (`backdrop-filter` written standard-then-webkit collapses to the `-webkit-` form Chromium never implemented; written alone it is autoprefixed correctly for `safari16.4`). In `index.html` the rule reverses — nothing autoprefixes it, so prefixes must be hand-written. `tests/design-system-impl/css-pipeline-contract.test.ts` pins the contract against the real minifier with targets resolved from the real Vite config.

**Key insight:** when a bug requires two conditions and you can only explain one, the unexplained half is not a detail — it is usually the actual mechanism. Three separate artifacts (issue, test docblock, recipe comment) confidently described the collapse while none could account for why the other identical declaration lived; every one of them was reasoning from a plausible story rather than a measurement. Corollaries worth carrying: a "hazard" is only a hazard for the inputs it actually has (a one-off survey of 38 properties against lightningcss 1.32.0 found exactly two that collapse and exactly one that is *dangerous* — `-webkit-filter` is a working Chromium alias, `-webkit-backdrop-filter` never existed there; an independent reviewer's separate 40-property list reproduced the same result. Treat that as a dated measurement, not a standing invariant: the operational gate is `css-pipeline-contract.test.ts`, which probes whatever properties we *actually* pair rather than a list someone once wrote down — a committed 38-property sweep would mostly assert things about properties we don't use, and fail on dependency bumps that cost us nothing), and a rule generalised past its evidence breaks things (a blanket "no hand-written prefixes" ban would delete `-webkit-line-clamp`, which lightningcss will not add, silently un-clamping every annotation card). Encode both the ban and its counterexample, or the next reader will over-apply the half they remember.

## 84. A Wrong Error Message Sent Me Hunting A Component That Didn't Exist

**Problem:** the `.docx` baseline capture surfaced `state_unsafe_mutation` thrown from `StatusBar.svelte`'s `editorTick++`, with a stack running `Plugin.blur → EditorView.dispatch → Editor.emit → handler → set`. Svelte's message says *"Updating state inside `$derived(...)`, `$inspect(...)` or a template expression is forbidden."* So I went looking for the derived. There wasn't one. `getCount()` — the only thing the component's derived calls — is pure `editor.state.doc.textContent`; it dispatches nothing. Three reproduction attempts failed: a plain `pm.blur()` produced nothing, the palette's autofocus turned out to run in a microtask (where no reaction can be active), and closing a tab did nothing because Tandem reuses one editor instance and swaps the Y.Doc, so the focused DOM is never torn down.

**Solution:** read the throw condition instead of the message. `sources.js`'s `set()` fires on `active_reaction.f & (DERIVED | BLOCK_EFFECT | ASYNC | EAGER_EFFECT)` — **`BLOCK_EFFECT` is an ordinary `{#if}`/`{#each}` block**, which the message never mentions. No derived was ever involved. Tiptap emits `update`/`transaction` synchronously from ProseMirror's `dispatch`, ProseMirror dispatches from DOM handlers, and a native `blur` can fire *during* a render — so the `$state` write lands mid-reaction and throws. Two facts raise the stakes past dev noise: `state_unsafe_mutation()` has an `else` branch that throws in **production** too, and the blur transaction sets `setMeta('blur')` with no doc change, while `update` is gated on `docChanged` — so `transaction` is the only path in, and it is also the event that fires on every cursor move. Fix: bridge the external event into `$state` through a microtask (`createCoalescingTick`), where no reaction is active.

**Key insight:** an error message is a claim by a library author about the common case, not a specification of the condition — when the message and the stack disagree, the source settles it, and reading it took minutes after three failed reproductions built from the message's story. The second half is the one that nearly shipped a lie: after fixing StatusBar the error count stayed at **8**, and only the *stack* revealed StatusBar was gone and `FormattingToolbar` had taken its place — the same `tick++` copy-pasted, its own comment admitting it "mirrors FormattingToolbar's pattern." A pass/fail count would have read as "fix didn't work" (wrong) or, one component later, "fix worked" (also wrong, with three live crash sites left). When a bug is a copied idiom, the count is a rumour; grep for the idiom and fix the class. Verify with the negative result too — the crash going away proves nothing if the feature froze, so the check that mattered was that the chip still read `500 words`.
