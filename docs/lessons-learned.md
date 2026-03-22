# Lessons Learned

## 1. Y.Doc Identity Mismatch

**Problem:** When both MCP tools and Hocuspocus create Y.Docs, they must share the same instance. If each creates its own Y.Doc for the same room, edits on one don't appear in the other.

**Solution:** Use a fixed room name ('default'). In `onLoadDocument`, merge any pre-existing MCP content into the Hocuspocus-provided doc via `Y.encodeStateAsUpdate`/`Y.applyUpdate`, then swap the map entry so both sides reference the same instance.

**Impact:** Critical -- without this, the entire collaboration loop breaks silently.

## 2. Y.XmlElement.toJSON() Does Not Return Plain Text

**Problem:** Calling `toJSON()` on a Y.XmlElement returns an XML/JSON structure representation, not the plain text content.

**Solution:** Recursively walk children, collecting `Y.XmlText.toString()` for text extraction. Implemented as `getElementText()` in `document.ts`.

## 3. MCP stdio Transport Reserves stdout

**Problem:** The MCP protocol uses stdin/stdout for message framing. Any `console.log()` output corrupts the protocol stream, causing parse errors and dropped messages.

**Solution:** All server-side logging uses `console.error()`. This is enforced by convention (ADR-006).

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

## 11. broadcastOpenDocs Scope

**Problem:** Writing the open documents list to every open document's Y.Map creates O(n) Hocuspocus sync operations per open/close/switch. With 10 docs, a single tab switch triggers 20 Y.Map mutations across 10 rooms.

**Solution:** Only write to the active document's Y.Map('documentMeta'). The client's per-tab meta observer handles the broadcast. Non-active rooms don't receive unsolicited updates.

**Impact:** Reduces broadcast cost from O(n) to O(1) per operation. However, the bootstrap room (`__tandem_ctrl__`) must ALSO receive the broadcast — otherwise new clients can't discover the first document (see Lesson 12).

## 12. Bootstrap Room Must Receive Doc List Broadcast

**Problem:** The client's bootstrap HocuspocusProvider connects to room `__tandem_ctrl__` to discover which documents are open. If `broadcastOpenDocs` only writes to the active document's room, the bootstrap observer never fires, and the browser shows "No document open" even after `tandem_open` succeeds.

**Solution:** `broadcastOpenDocs` writes to both `__tandem_ctrl__` (so new/reconnecting clients discover docs) and the active document's room (so per-tab observers stay in sync). This is O(2) writes per broadcast, not O(n).

**Impact:** Without this, the client can never render tabs for the first document. The server reports docs as open but the browser doesn't know about them.

## 13. MCP Stdio Transport Disconnects Under Claude Code

**Problem:** The Tandem MCP server's stdio transport disconnects after the first `tandem_open` tool call when running under Claude Code. The server process stays alive (Hocuspocus continues listening), but the MCP stdio channel dies. Subsequent tool calls fail with "Not connected."

**Investigation:** Standalone testing via Node.js subprocess proves the server handles sequential tool calls correctly — both `tandem_open` calls return valid JSON-RPC responses. No stdout corruption detected (instrumented `process.stdout.write`). No uncaught exceptions. `console.log`, `console.warn`, and `console.info` are all redirected to stderr.

**Resolution:** Migrated from stdio to Streamable HTTP transport (ADR-012). MCP now runs on HTTP port 3479 via Express + `StreamableHTTPServerTransport` in stateful mode. Claude Code connects via `type: "http"` in `.mcp.json`. Sequential tool calls (including `tandem_open` → follow-up calls) work reliably. Stdio preserved as fallback via `TANDEM_TRANSPORT=stdio`.

**Impact:** Issue #8 resolved. Multi-document browser testing unblocked.

## 14. Streamable HTTP Transport Requires Stateful Mode

**Problem:** The MCP SDK's `StreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`) creates a new transport per request that crashes on the second call, because `server.connect(transport)` binds internal state to the first transport instance.

**Solution:** Use stateful mode with `sessionIdGenerator: () => randomUUID()`. Create one transport, connect once, route all HTTP requests through it. The transport manages session IDs via `Mcp-Session-Id` headers automatically.

**Impact:** Choosing stateless mode would silently break after the first tool call — exactly mimicking Issue #8 but for a different reason.
