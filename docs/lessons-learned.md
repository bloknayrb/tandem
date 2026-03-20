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

## 6. MCP Tool Response Boilerplate

**Problem:** Every MCP tool needs `{ content: [{ type: 'text', text: JSON.stringify(...) }] }` wrapping. With 16+ tools, this pattern was duplicated everywhere, making the code fragile and verbose.

**Solution:** Extracted shared helpers (`mcpSuccess`, `mcpError`, `noDocumentError`) into `response.ts` (ADR-008). Eliminated 267 lines of boilerplate.
