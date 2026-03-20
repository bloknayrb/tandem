# Tandem

Collaborative AI-human document editor. Both Bryan and Claude see and edit the same document in real-time.

## Setup

```bash
cd tandem
npm install
npm run dev
```

## Architecture

- **Frontend:** React + Tiptap editor with Yjs collaboration
- **Backend:** Hocuspocus (Yjs WebSocket) + MCP server (stdio)
- **Claude integration:** MCP tools discovered natively by Claude Code

## Usage

Claude calls `tandem_open("file.md")` and the document appears in browser. Both can edit, highlight, comment, and annotate in real-time.

## MCP Configuration

Add to Claude Code settings:
```json
{
  "mcpServers": {
    "tandem": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/tandem/dist/server/index.js"],
      "env": { "TANDEM_PORT": "3478" }
    }
  }
}
```
