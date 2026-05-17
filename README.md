<p align="center">
  <img src="docs/assets/banner.png" alt="Tandem — Collaborative AI-Human Document Editor" width="800">
</p>

Have you ever been working on a piece of writing with an AI and caught yourself copy-pasting the same paragraph into the chat for the fifth time just so the model knows what you're talking about? That's the friction Tandem eliminates. Open a file directly, or tell your AI "let's work on my draft in tandem" — the document appears in the editor, and from that point on you highlight text and the AI sees it directly. No pasting, no "here's the paragraph I mean," no losing your place.

Tandem hooks into your AI as an [MCP](https://modelcontextprotocol.io) server, so you're not stuck in some stripped-down document-editing silo. It's the full AI — with all its knowledge, your conversation context, and every tool it has access to — just now it can also see and edit your document.

> Tandem's integration contract is **MCP**. The default integration is **Claude** (Claude Code + Claude Desktop) — it's what we recommend, what we test against, and it ships with the channel push, cowork, plugin monitor, and auto-launcher features. Any MCP-capable client can connect to the same MCP HTTP endpoint and use the same 26 tools, but the Claude-specific transports don't apply. Other clients are **best-effort, MCP-contract-compatible, not validated** today. See [ADR-038](docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration).

## Why Tandem?

- **No more copy-paste ping-pong.** Select text in the editor, and your AI reads your selection directly. Ask "what do you think of this?" or "make this more concise" — the AI knows exactly which text you mean.
- **Your full AI, not a toy editor.** Tandem connects via MCP, so the AI keeps all its knowledge, all its tools, and your full conversation context. Need it to cross-reference your document against a codebase, a URL, or another file? It can — it's still the full client.
- **Iterate in place.** Your AI can suggest rewrites, leave comments, flag issues, and edit text — all appearing as annotations you accept, dismiss, or tweak right in the document.

## Quick Start

Pick the install path that matches your audience:

### Just want to use it — Desktop App

Download the installer for your platform from the [latest release](https://github.com/bloknayrb/tandem/releases/latest). No Node.js or terminal required.

**Connecting an AI:** today the desktop app auto-configures **Claude** (Claude Code + Claude Desktop) on launch — install Claude, install Tandem, and Claude's MCP entry is written for you. Open Claude Code and the `tandem_*` tools are available immediately.

**Integration setup wizard (preview):** an opt-in wizard for fine-grained control of the integration list — including **other MCP-capable clients** (Cursor, Continue.dev, LM Studio, Ollama, …) — is available behind a Settings toggle (Settings → Advanced → "Show integration setup wizard"). Enable it if you want to manage non-Claude integrations or pre-stage auth tokens before the v1.0 default-on flip. Until then, the wizard is hidden by default and silent auto-configuration of Claude is the path that ships.

The desktop app bundles everything: server, sidecar, and the OS keychain integration that stores any per-client auth tokens you set up. Updates land automatically.

### Power-user setup — npm + Claude Code channel push

Requires **Node.js 22+** ([download](https://nodejs.org)) and **Claude Code** (`npm install -g @anthropic-ai/claude-code`).

```bash
npm install -g tandem-editor
tandem setup     # registers MCP tools + installs Claude Code skill
tandem           # starts server + opens editor
```

`tandem setup` auto-detects Claude Code and Claude Desktop, writes MCP configuration, and installs a skill (`~/.claude/skills/tandem/SKILL.md`) that teaches Claude how to use Tandem's tools effectively. Re-run after upgrading (`npm update -g tandem-editor && tandem setup`).

> **Heads-up:** `tandem setup` is the v0.12.x transitional CLI. Once the wizard's auto-config-removal sub-PR (#477 PR 3c-ii) ships, `tandem setup` becomes a TTY wrapper around the wizard flow. Same questions, same end state — just no silent writes to your Claude config.

#### Channel push (recommended for Claude Code)

For the full live-collaborator experience, start Claude Code with the **channel push** flag after running `tandem setup --with-channel-shim`:

> **Desktop app users:** Claude Code is auto-configured every launch — skip the manual `--with-channel-shim` step. The `tandem_*` tools are available immediately.

```bash
tandem setup --with-channel-shim   # one-time: writes the tandem-channel entry
claude --dangerously-load-development-channels server:tandem-channel
```

This is the magic-sauce mode — and it's the one I'd recommend for Claude Code users. The channel shim pushes events (selections, annotations, chat) over SSE the moment they happen, so Tandem genuinely feels like there's another person on the other end of the document: someone watching what you highlight, reacting to edits you accept, and chiming in on a paragraph the instant you select it, the way a collaborator on a Google Doc would. The `--dangerously-load-development-channels` flag is an experimental Claude Code feature, which is why it isn't on by default — but turning it on is what makes the whole experience click.

**Recommended layout:** snap the Claude Code terminal to one side of your screen and the Tandem editor window to the other. You'll be flipping attention between them constantly, and having both visible is what makes the side-by-side-collaborator feeling land.

Then try:

```
"Open sample/welcome.md and review it with me"
```

Claude calls `tandem_open`, the document appears in the editor, and you're ready to collaborate.

#### The core loop — no copy/paste

1. Highlight a paragraph in the editor.
2. With channels on, Claude often reacts before you even say anything. Otherwise, just type what you want in the terminal: *"what do you think of this paragraph?"* or *"rewrite this to be more concise"*.
3. Claude reads your selection directly from the shared Tandem state (via `activity.selectedText` on `tandem_checkInbox`). You never paste the passage into the terminal.
4. Claude replies in the Tandem chat sidebar (`tandem_reply`) or drops annotations on the document (`tandem_annotate` / `tandem_suggestEdit`), which you can accept, dismiss, or edit in the side panel.

#### Prefer not to use the experimental flag?

You don't have to turn on channel push — every feature of Tandem works without it. You lose the "Claude reacts on its own" magic, but Claude still sees every selection, annotation, and chat message. Start Claude Code normally:

```bash
claude
```

Then pick one of two ways to keep the conversation flowing:

1. **Just chat in the terminal (simplest).** Every time you send Claude a message, it has a chance to call `tandem_checkInbox` and pick up your latest selection, any annotations you accepted or dismissed, and any chat messages from the Tandem sidebar. Zero setup — this is how it works out of the box. With Tandem and the terminal snapped side by side, the loop feels surprisingly natural; Claude just reacts when you nudge it rather than spontaneously.
2. **Background polling with `/loop` (hands-off).** Ask Claude to check in on its own using the `/loop` skill:
   ```
   /loop 30s check tandem inbox and respond to any new messages
   ```
   Claude polls every 30 seconds — responses lag by up to that interval, but you don't have to prompt it yourself.

Either way, Claude reads the exact same information (selections, annotations, chat) through the same `tandem_checkInbox` tool. The only thing channels change is *when* Claude finds out something happened — not *whether* it can see it.

### Connecting other MCP clients

Any MCP-capable client (Cursor, Continue.dev, LM Studio, Ollama, custom integrations) can connect to Tandem over the same MCP contract Claude uses:

- **MCP HTTP endpoint:** `http://127.0.0.1:3479/mcp`
- **SSE event stream:** `http://127.0.0.1:3479/api/events`
- **26 tools** at the MCP endpoint — same set Claude uses. See [docs/mcp-tools.md](docs/mcp-tools.md).

What works:
- All 26 MCP tools (document, annotation, chat, status).
- The SSE event stream — if your client subscribes, you get the same real-time events Claude does via channel push.

What doesn't:
- **Channel push as a Claude Code-style flag** — that's `--dangerously-load-development-channels`, which is a Claude Code-specific feature. Other MCP clients have to subscribe to `/api/events` themselves.
- **Auto-launch.** v1.0 only auto-launches Claude Code per [ADR-038](docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) §2. Other clients need to be started by you.
- **Cowork plugin bridge, Claude Code skill, plugin marketplace artifacts** — Claude-specific by design.

This is **best-effort, MCP-contract-compatible, not validated** today. We don't intentionally break other clients; we don't test them in CI. If you wire up a client and hit an issue, file it — patches that don't regress the Claude default are welcome.

### Verify

```bash
npm run doctor    # checks Node.js, MCP config, server health, ports
```

Or check the raw health endpoint:

```bash
curl http://127.0.0.1:3479/health
# → {"status":"ok","version":"0.8.0","transport":"http","hasSession":false}
```

`hasSession` becomes `true` once an MCP client connects.

<details>
<summary><strong>Development Setup</strong> (contributing / building from source)</summary>

```bash
git clone https://github.com/bloknayrb/tandem.git
cd tandem
npm install
npm run dev:standalone   # starts backend (:3478/:3479), editor client (:5173), and monitor
```

Open <http://127.0.0.1:5173> — you'll see `sample/welcome.md` loaded automatically on first run. The `.mcp.json` in the repo configures Claude Code automatically when run from this directory.

</details>

## Using Tandem

You point at text, Claude sees it. Here's how that plays out day-to-day:

- **Open a document.** Ask Claude (`"let's work on notes.md in tandem"`), drag a file onto the editor, or click the **+** in the tab bar. `.md`, `.txt`, `.html`, and `.docx` (review-only) are supported.
- **Point at what you mean.** Select text in the editor and ask Claude about "this paragraph" in the terminal — or just wait for Claude to react if you have channels on. Claude reads your selection directly, no copy-paste needed. Hold the selection for about a second so it registers (dwell-time gating filters out incidental clicks).
- **Iterate on Claude's response.** Claude's suggestions appear as annotations in the side panel — accept, dismiss, edit, or ask follow-up questions. Each round refines the text without you ever leaving the document. Press **Ctrl+Shift+R** for keyboard review mode: **Tab** to navigate, **Y** accept, **N** dismiss, **E** edit, **Z** undo within a 10-second window.
- **Heads-down vs collaborative.** Toggle **Solo** mode when you want to write without interruptions — Tandem queues non-urgent annotations until you flip back to **Tandem** mode. Both `tandem_status` and `tandem_checkInbox` return the current mode so Claude adapts its behavior automatically.
- **Save.** Ask Claude ("save the file"), press the save button, or let session auto-persistence take over — your documents and annotations survive server restarts either way.

## Features

Everything in Tandem is built around one idea: you work in the document, Claude works alongside you, and neither of you has to leave your surface to stay in sync.

### Chat

Send messages to Claude alongside your document. Select text before sending to attach it as context — Claude sees exactly what you mean. Clicking an anchored selection later scrolls back to that passage.

### Annotations

This is how Claude's feedback shows up in the document. Claude adds highlights, comments, suggestions, and flags directly on the text. Suggestion cards show a visual diff — original text in red strikethrough, replacement in green. The side panel lists all annotations with filtering by type, author, and status. Accept, dismiss, or edit each one individually — or use bulk actions to process them in batches.

### Review Mode

Press **Ctrl+Shift+R** to enter keyboard review mode. Navigate with **Tab**, accept with **Y**, dismiss with **N**, examine with **E**. A 10-second undo window with a visual countdown lets you reverse accidental accepts. Shortcut hints appear below the Review button.

### More

- **Full LLM via MCP** — Claude connects through MCP tools, so it retains all its knowledge, conversation context, and tool access while working on your document
- **Multi-document tabs** — open `.md`, `.txt`, `.html`, `.docx` files side by side; drag to reorder
- **.docx review-only mode** — open Word documents for annotation; imported Word comments appear alongside Claude's
- **Session persistence** — documents and annotations survive server restarts
- **Solo / Tandem mode** — flip to Solo when you want to write heads-down; Tandem queues non-urgent annotations until you're ready
- **Real-time channel push** *(recommended)* — with the `--dangerously-load-development-channels` Claude Code flag, selections, annotations, and chat push to Claude instantly, making Tandem feel like a live collaborator watching over your shoulder
- **Keyboard shortcuts** — press `?` for the full reference
- **Unsaved-changes indicator** — dot on tab title when a document has pending edits
- **Configurable display name** — set your name so Claude knows who's reviewing
- **Atomic file saves** — write to temp, then rename, preventing partial writes
- **E2E tested** — Playwright tests cover the annotation lifecycle end-to-end
- **Authorship text coloring** — blue for your edits, orange for Claude's, toggled per-document
- **Threaded annotation replies** — back-and-forth conversation on any annotation
- **Auto-save** — documents save on change; Ctrl+S for manual trigger
- **Settings popover** — Light/Dark/System theme, text size (S/M/L), reduce motion, display name (Ctrl+,)
- **Auth tokens for LAN exposure** — bind to `0.0.0.0` with auto-generated tokens; `tandem rotate-token` for rotation
- **Durable annotation persistence** — annotations survive server restarts independently of session files
- **Claude Code plugin** — `tandem mcp-stdio` + `tandem channel` bridge Tandem into Cowork and Claude Desktop

## Where Tandem is headed

Since the v0.4.0 desktop app launch, Tandem has added auth tokens for LAN exposure (v0.7.0), a Claude Code plugin bridge for Cowork and Claude Desktop (v0.6.0+), durable annotation persistence, settings with Light/Dark/System theming, authorship text coloring, and coordinate system correctness fixes with semantic token enforcement (v0.8.0). A few directions on the radar for later releases:

- **High-fidelity .docx round-trip** — current `.docx` support is review-only; production export is planned so you can stay in Tandem through the final draft.
- **Exportable annotated documents** — PDF (and eventually `.docx`) with annotations baked in, so you can share reviewed drafts outside Tandem.
- **Code editing mode** — CodeMirror 6 surface for reviewing code the same way you review prose.
- **Standalone mode** — direct Anthropic API connection (no MCP client required), for users who want an all-in-one Tandem experience without managing a separate AI client process. Complements the MCP-first integration model rather than replacing it.

See the full [Roadmap](docs/roadmap.md) and [Known Limitations](docs/roadmap.md#known-limitations-v1) for the complete picture, including items that are explicitly out of scope for v1.

## Documentation

- **[User Guide](docs/user-guide.md)** — How to use Tandem: editor UI, annotations, chat, review mode, keyboard shortcuts
- [MCP Tool Reference](docs/mcp-tools.md) — 29 MCP tools (26 active, 3 deprecated stubs) + channel API endpoints
- [Architecture](docs/architecture.md) — System design, data flows, coordinate systems, channel push
- [Workflows](docs/workflows.md) — Claude Code usage patterns: text iteration, cross-referencing, multi-model
- [Roadmap](docs/roadmap.md) — Phase 2+ roadmap, known issues, future extensions
- [Design Decisions](docs/decisions.md) — ADR-001 through ADR-038 (integration policy in [ADR-038](docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration))
- [Lessons Learned](docs/lessons-learned.md) — 73 implementation lessons

## CLI Commands

| Command                            | What it does                                                       |
| ---------------------------------- | ------------------------------------------------------------------ |
| `tandem`                           | Start server and open editor (global install)                      |
| `tandem setup`                     | Register MCP tools with Claude Code / Claude Desktop               |
| `tandem setup --force`             | Register to default paths regardless of auto-detection             |
| `tandem --version`                 | Show installed version                                             |
| `tandem --help`                    | Show usage                                                         |
| `tandem setup --with-channel-shim` | Also register the stdio channel shim                               |
| `tandem rotate-token`              | Rotate auth token (60-second grace window)                         |
| `tandem mcp-stdio`                 | Run as stdio MCP server (proxy to local HTTP, for plugin bridge)   |
| `tandem channel`                   | Run the channel shim (stdio MCP for plugin's tandem-channel entry) |

## MCP Configuration

Tandem's MCP contract is **two HTTP transports** at `http://127.0.0.1:3479`:

- **HTTP MCP** — all 26 tools (document, annotation, chat, status). Always on.
- **SSE event stream** at `/api/events` — real-time push of selections, annotations, and chat messages. Required for the live-collaborator experience.

For Claude Code specifically, the **channel shim** is a stdio MCP wrapper that subscribes to `/api/events` on Claude's behalf and exposes the events as MCP notifications. It's activated by the `--dangerously-load-development-channels server:tandem-channel` flag and is what enables the [magic-sauce mode](#channel-push-recommended-for-claude-code) described above. The shim is a Claude-specific transport on top of the MCP contract — other MCP clients subscribe to `/api/events` directly.

**Global install** (`tandem setup`): Automatically writes both entries to `~/.claude/mcp_settings.json` (Claude Code) and/or `claude_desktop_config.json` (Claude Desktop) with absolute paths. No manual configuration needed.

**Development setup** (`.mcp.json`): The repo includes a `.mcp.json` that configures both entries automatically when Claude Code runs from the repo directory:

```json
{
  "mcpServers": {
    "tandem": {
      "type": "http",
      "url": "http://127.0.0.1:3479/mcp"
    },
    "tandem-channel": {
      "command": "npx",
      "args": ["tsx", "src/channel/index.ts"],
      "env": { "TANDEM_URL": "http://127.0.0.1:3479" }
    }
  }
}
```

Both entries are cross-platform — no platform-specific configuration needed.

**Other MCP clients:** the `tandem` HTTP entry above is all you need. The `tandem-channel` stdio shim is Claude-specific and won't apply.

## Environment Variables

All optional — defaults work out of the box.

| Variable                           | Default                 | Description                                                     |
| ---------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `TANDEM_PORT`                      | `3478`                  | Hocuspocus WebSocket port                                       |
| `TANDEM_MCP_PORT`                  | `3479`                  | MCP HTTP + REST API port                                        |
| `TANDEM_URL`                       | `http://127.0.0.1:3479` | Channel shim server URL                                         |
| `TANDEM_TRANSPORT`                 | `http`                  | Transport mode (`http` or `stdio`)                              |
| `TANDEM_NO_SAMPLE`                 | unset                   | Set to `1` to skip auto-opening `sample/welcome.md`             |
| `TANDEM_CLAUDE_CMD`                | `claude`                | Claude Code executable name (for `tandem setup` auto-detection) |
| `TANDEM_BIND_HOST`                 | `127.0.0.1`             | Bind address for MCP HTTP (`0.0.0.0` for LAN)                   |
| `TANDEM_AUTH_TOKEN`                | auto-generated          | Override auth token (set by Tauri; manual use rare)             |
| `TANDEM_ALLOW_UNAUTHENTICATED_LAN` | unset                   | Set to `1` to skip token requirement on LAN bind                |
| `TANDEM_LAN_IP`                    | auto-detected           | Explicit LAN IP for multi-homed machines                        |
| `TANDEM_REQUEST_TIMEOUT_MS`        | `30000`                 | Per-request timeout in stdio bridge (ms)                        |
| `TANDEM_APP_DATA_DIR`              | platform default        | Override app-data root (sessions, auth-token, annotations)      |
| `TANDEM_ANNOTATION_STORE`          | unset                   | Set to `off` to disable durable annotation persistence          |

See `.env.example` for a copy-paste template.

## Troubleshooting

Run `npm run doctor` for a quick diagnostic of your setup. It checks Node.js version, `.mcp.json` config, server health, and port status.

**Claude Code says "MCP failed to connect"**
Start the server first (`tandem` for global install, or `npm run dev:standalone` for dev setup), then open Claude Code. The server must be running before Claude Code probes the MCP URL. If you restart the server, run `/mcp` in Claude Code to reconnect.

**Port already in use**
Tandem kills stale processes on :3478/:3479 at startup. If another app uses those ports, set `TANDEM_PORT` / `TANDEM_MCP_PORT` to different values and update `TANDEM_URL` to match.

**Channel shim fails to start**
The `tandem-channel` entry spawns a subprocess. For global installs, `tandem setup` writes absolute paths to the bundled `dist/channel/index.js` — re-run `tandem setup` after upgrading. For dev setup, if you see `MODULE_NOT_FOUND` with a production config (`node dist/channel/index.js`), run `npm run build`. The default dev config uses `npx tsx` and doesn't require a build step.

If the shim starts but logs `/api/events timed out after 10000ms`, `SSE inactivity timeout`, or `/api/channel-reply timed out after 5000ms`, the Tandem server accepted a connection but stopped responding on that path. Restart Tandem; the shim reports the timeout instead of hanging silently.

**Editor shows "Cannot reach the Tandem server"**
The editor connects to the server via WebSocket. For global installs, run `tandem` to start the server. For dev setup, use `npm run dev:standalone` (or `npm run dev:server`). The message appears after 3 seconds of failed connection.

**Empty editor with no document**
On first run, `sample/welcome.md` auto-opens. If you've cleared sessions or deleted the sample file, click the **+** button in the tab bar or drop a file onto the editor.

## Development

| Command                  | What it does                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `npm run dev:standalone` | **Recommended** — frontend + backend + monitor                                     |
| `npm run dev:server`     | Backend only: Hocuspocus (:3478) + MCP HTTP (:3479)                                |
| `npm run dev:client`     | Frontend only: Vite dev server (:5173)                                             |
| `npm run build`          | Production build (`dist/server/` + `dist/channel/` + `dist/cli/` + `dist/client/`) |
| `npm test`               | Run vitest (unit tests)                                                            |
| `npm run test:e2e`       | Run Playwright E2E tests                                                           |
| `npm run test:e2e:ui`    | Playwright UI mode                                                                 |
| `cargo tauri dev`        | Tauri desktop app (dev mode with hot-reload)                                       |
| `cargo tauri build`      | Tauri production build (installer output)                                          |

**Tauri development** requires the [Rust toolchain](https://www.rust-lang.org/tools/install) and [Tauri CLI](https://v2.tauri.app/start/prerequisites/). Web-only development (`npm run dev:standalone`) does not require Rust.

**Tech Stack:** Svelte 5, Tiptap, Vite, TypeScript | Node.js, Hocuspocus (Yjs WebSocket), MCP SDK, Express | Yjs (CRDT), y-prosemirror | mammoth.js (.docx), unified/remark (.md)

## License

Tandem is licensed under the [Business Source License 1.1](LICENSE). See `LICENSE` for full terms.
