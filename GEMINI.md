# Tandem

## Project Overview

Tandem is a collaborative AI-human document editor designed to eliminate the friction of copy-pasting text between an editor and an LLM (specifically Claude). It hooks into Claude via the Model Context Protocol (MCP), allowing Claude to read selections directly, suggest edits as annotations, and chat alongside the document. 

Tandem operates as both an npm CLI package and a standalone native desktop application. It creates a shared state where Claude can interact with the document in real-time, resembling a human collaborator on a shared document.

## Tech Stack & Architecture

- **Frontend:** React 19, Tiptap (ProseMirror-based editor), Vite
- **Backend (Node):** Node.js, Express, Hocuspocus (WebSocket server for Yjs), MCP SDK
- **Desktop (Native):** Tauri, Rust
- **Collaboration / State:** Yjs (CRDT), y-prosemirror
- **Parsing/Conversion:** mammoth.js (for `.docx`), unified/remark (for `.md`)
- **Testing:** Vitest (Unit), Playwright (E2E)

### Architecture Overview
Tandem uses a three-layer architecture: **Browser (Tiptap)** <-> **Tandem Server** (Hocuspocus on :3478 + MCP HTTP on :3479) <-> **Claude Code**. A channel shim (`src/channel/`) pushes real-time events to Claude via SSE.

### Directory Structure
- `src/client/`: Tiptap editor, React components, and hooks (`useYjsSync`, etc.).
- `src/server/`: Node.js backend handling MCP endpoints, Hocuspocus, and coordinate conversions.
- `src/channel/`: Real-time push notification shim.
- `src/cli/`: CLI entrypoint and setup logic.
- `src/shared/`: Shared types, constants, and position utilities.
- `src-tauri/`: Rust backend for the desktop application.
- `tests/`: E2E (Playwright) and unit (Vitest) tests.

## Building and Running

### Web Development
- **Start Full Stack:** `npm run dev:standalone` (Client on `:5173`, Server on `:3478`/`:3479`)
- **Start Client Only:** `npm run dev:client`
- **Start Server Only:** `npm run dev:server`
- **Build Production:** `npm run build`

### Desktop Development (Tauri)
- **Start Tauri Dev:** `npm run dev:tauri`
- **Build Tauri App:** `npm run build:tauri`

### Testing
- **Unit Tests:** `npm test`
- **E2E Tests:** `npm run test:e2e` (Note: This kills existing processes on :3478/:3479)
- **E2E UI Mode:** `npm run test:e2e:ui`

## Critical Development Rules

1.  **Y.Map Keys:** Always use constants from `shared/constants.ts` (e.g., `Y_MAP_ANNOTATIONS`)—never raw strings.
2.  **MCP Writes:** All server-side Y.Map writes MUST use `doc.transact(() => { ... }, 'mcp')` to prevent echo events.
3.  **Stdout is Reserved:** `console.log` is redirected to stderr. Do not add dependencies that log to stdout as they will corrupt the MCP wire in stdio mode.
4.  **Coordinate Systems:** Use `validateRange()` and `anchoredRange()` from `server/positions.ts` for offsets. Never use raw offsets.
5.  **Text Extraction:** Use `extractText()` for `tandem_getTextContent`. Avoid `extractMarkdown()` as it shifts offsets.
6.  **Heading Protection:** `tandem_edit` rejects ranges overlapping heading prefixes (e.g., `## `).
7.  **E2E Selectors:** Use `data-testid` attributes (kebab-case) for testing (e.g., `accept-btn`, `annotation-card-{id}`).
8.  **Tauri Windows Prefix:** Always call `strip_win_prefix()` in Rust on paths returned by Tauri APIs before passing to the Node sidecar.

## Development Conventions

- **Formatting:** Biome (`npm run format`) — 2 spaces, double quotes, 100-char width.
- **Linting:** ESLint (`npm run lint`). Biome linter is disabled.
- **Type Checking:** Strict TypeScript. Run `npm run typecheck` before pushing.
- **Commit Hooks:** Husky and lint-staged run ESLint and Biome on changed files.
- **Solo/Tandem Mode:** Respect the `mode` returned by `tandem_status`. In `solo` mode, hold non-urgent annotations.
