<p align="center">
  <img src="docs/assets/banner.png" alt="Tandem — work on documents with your AI without copy-paste" width="800">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tandem-editor"><img src="https://img.shields.io/npm/v/tandem-editor?label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BUSL--1.1-blue" alt="License: BUSL-1.1"></a>
  <a href="https://github.com/bloknayrb/tandem/releases/latest"><img src="https://img.shields.io/github/v/release/bloknayrb/tandem?label=release" alt="Latest release"></a>
</p>

**You point at text. Your AI sees it. You iterate together — without leaving the document.**

Tandem is an editor that hooks into your AI as an [MCP](https://modelcontextprotocol.io) server. Open a document, highlight the passage you want to discuss, and your AI reads your selection directly — no copy-paste, no "here's the paragraph I mean," no losing your place. Suggestions, comments, and rewrites show up as annotations you can accept, dismiss, or talk back to in the document itself.

Tandem is approaching v1.0 and shipping continuous improvements. Quality over speed; date floats.

## What Tandem is

Most AI-and-text tools are either writing assistants that generate paragraphs for you, or chat windows where you paste text in and read text back. Tandem is neither. It's an **iteration surface** — a document that both you and your AI can see, with your AI sitting alongside you instead of in a sidebar. You point at what you mean, the AI sees it, and the two of you work the text together.

Because Tandem connects through MCP, it isn't a stripped-down editor with a model bolted on. It's your full AI — with all its knowledge, your conversation context, and every tool it has access to — just now it can also see and edit your document.

> Tandem's integration contract is **MCP**. The default integration is **Claude** (Claude Code + Claude Desktop) — it's what we recommend, what we test against, and it ships with the channel push, cowork, plugin monitor, and auto-launcher features. Any MCP-capable client can connect to the same MCP HTTP endpoint and use the same 26 tools, but the Claude-specific transports don't apply. Other clients are **best-effort, MCP-contract-compatible, not validated** today.
>
> **Integration setup** runs through the integration setup wizard (#477 PR 3). Today's transitional behavior — Tandem auto-writing its MCP entry to Claude's config files on Tauri startup — is **deprecated when the wizard ships**. Going forward, every integration (Claude included) is configured via the wizard, never silently.
>
> See [ADR-038](docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) for the full policy.

## See it in action

<p align="center">
  <img src="docs/screenshots/01-editor-overview.png" alt="The Tandem editor showing a document with inline highlights and a side panel listing annotations" width="800">
</p>

*The editor with a document open. Annotations live in the right rail; you accept, dismiss, or edit each one individually.*

<p align="center">
  <img src="docs/screenshots/05-review-mode.png" alt="Keyboard review mode highlighting the current annotation with Tab/Y/N/E hints" width="800">
</p>

*Press `Ctrl+Shift+R` to enter keyboard review mode. `Tab` to move, `Y` to accept, `N` to dismiss, `E` to edit, with a 10-second undo window.*

<p align="center">
  <img src="docs/screenshots/03-side-panel.png" alt="Annotation card showing a suggested rewrite with original and replacement text" width="800">
</p>

*Suggestion cards show a visual diff — original in red strikethrough, replacement in green. Each annotation is an addressable object you can talk back to.*

Screenshots reflect the current UI; redesign chrome continues to land through release.

## Install

### Which AI clients work?

| AI surface | Status |
|---|---|
| **Claude Code** (local CLI) | Default. Validated. Channel push supported. |
| **Claude Desktop** (local app) | Supported via the Cowork bridge. Channel push N/A. |
| **claude.ai web chat** | Not supported. Would require exposing the local server publicly via a tunnel, which is outside scope. |
| **Other MCP-capable clients** (Cursor, Continue.dev, LM Studio, Ollama, …) | Best-effort, MCP-contract-compatible, not validated. |
| **Non-MCP AIs** (ChatGPT direct, Gemini direct, etc.) | Not supported today. Multi-provider support is in progress via the Agent SDK adapter ([ADR-038 §3](docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)); not yet shippable. |

> The default integration is **Claude**; other MCP-capable clients connect via the same MCP HTTP endpoint and the same 26 tools but don't get the Claude-specific transports. See [ADR-038](docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) for the full policy.

**Compatibility is a goal, not an accommodation.** Tandem is built MCP-first specifically so the integration surface stays open. If your client isn't on this list and you'd like it to work, [open an issue](https://github.com/bloknayrb/tandem/issues) — describe the client, what it speaks, and how you'd like to use it with Tandem. Patches that don't regress the Claude default are welcome. *Best-effort* describes our test discipline, not our intent — it doesn't mean we won't help.

### Requirements

- **Windows 10 22H2 or Windows 11.** The installer is signed via Azure Trusted Signing ([ADR-030](docs/decisions.md)) and bundles WebView2 Runtime — Win 11 already has it; the NSIS installer auto-installs it on Win 10 if missing. Until SmartScreen reputation accumulates for the signing certificate, first launch may show a *"Windows protected your PC"* warning — see [troubleshooting](docs/troubleshooting.md#windows-smartscreen-warning) for the bypass.
- **macOS 12 (Monterey) or later.** The `.app` is notarized; no Gatekeeper warning expected.
- **Linux:** `.AppImage` (any glibc 2.31+) or `.deb` (Ubuntu 22.04+) / `.rpm` (Fedora 39+).
- **Node.js 22+** — only required for the npm install path.
- **Claude Code or Claude Desktop** — only required for the default integration path. See [Anthropic's install instructions](https://docs.anthropic.com/en/docs/claude-code/quickstart).

### Desktop app (recommended)

Download the installer for your platform from the [latest release](https://github.com/bloknayrb/tandem/releases/latest). No Node.js, no terminal.

The desktop app bundles everything: server, sidecar, and OS-keychain storage for per-client auth tokens. Updates land automatically.

**File associations** register on install — double-clicking a `.md`, `.txt`, or `.html` file opens it directly in Tandem.

**Connecting Claude.** Today the desktop app auto-configures whichever Claude integration it detects on launch: Claude Code, Claude Desktop, or both. Install Claude, install Tandem, and Claude's MCP entry is written for you. Open Claude Code (or Claude Desktop with Cowork) and the Tandem tools are available immediately.

> An opt-in **integration setup wizard** for fine-grained control of the integration list — including non-Claude MCP clients — is available behind a Settings toggle (**Settings → AI Assistant → Show integration setup wizard (preview)**). The wizard's audience is non-Claude clients and users who want to manage configuration explicitly; if you only use Claude, the silent auto-config path is the recommended one until the wizard becomes default-on.

### npm + Claude Code

Requires Node.js 22+ and [Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart). On Windows, the commands below work in PowerShell, `cmd.exe`, and WSL — the npm-installed `tandem` shim is a `.cmd` file, so there's no PowerShell execution-policy issue.

```bash
npm install -g tandem-editor
tandem setup     # writes MCP config + installs Claude Code skill
tandem           # starts server and opens the editor
```

Re-run `tandem setup` after upgrading (`npm update -g tandem-editor && tandem setup`).

#### Live-collaborator mode

For the full real-time experience with Claude Code, add the `tandem-channel` entry once and start Claude Code with the channel-push flag:

```bash
tandem setup --with-channel-shim   # one-time
claude --dangerously-load-development-channels server:tandem-channel
```

The `--dangerously-load-development-channels` flag is Claude Code's marker for unstable APIs; Tandem's channel push uses one of them. The flag becomes unnecessary when the Channels API stabilizes.

With channel push on, the editor pushes selections, annotation actions, and chat messages to Claude over SSE the moment they happen — Tandem feels like there's another person on the other end of the document, watching what you highlight and reacting in place. **Recommended layout:** snap the Claude Code terminal to one side of your screen and the Tandem editor to the other.

#### Without channel push

You don't have to enable channel push — every Tandem feature works without it. Two paths keep the conversation flowing:

1. **Just chat in the terminal.** Every time you send Claude a message, it has a chance to call `tandem_checkInbox` and pick up your latest selection, any annotations you've acted on, and any chat from the Tandem sidebar. Zero setup.
2. **Background polling with `/loop`.** Ask Claude to check in on its own: `/loop 30s check tandem inbox and respond to any new messages`. Responses lag by up to that interval; you don't have to prompt manually.

Either way, Claude reads the same selections, annotations, and chat through the same `tandem_checkInbox` tool. Channel push changes *when* Claude finds out, not *whether* it can see.

### Other MCP clients

Any MCP-capable client (Cursor, Continue.dev, LM Studio, Ollama, custom integrations) can connect to Tandem over the same MCP contract Claude uses — best-effort, MCP-contract-compatible, not validated. We don't intentionally break other clients; we don't test them in CI.

- **MCP HTTP endpoint:** `http://127.0.0.1:3479/mcp`
- **SSE event stream:** `http://127.0.0.1:3479/api/events` — subscribe to get the same real-time events Claude does via channel push.
- **Tools:** see [docs/mcp-tools.md](docs/mcp-tools.md).

The minimum config that works in most MCP clients:

```json
{
  "mcpServers": {
    "tandem": {
      "type": "http",
      "url": "http://127.0.0.1:3479/mcp"
    }
  }
}
```

For setting up non-Claude integrations interactively, enable the **integration setup wizard** in the desktop app (**Settings → AI Assistant → Show integration setup wizard (preview)**). It walks through MCP entry writing, auth token provisioning, and the `/api/events` subscription path per client.

**Tried Tandem with a client that's not in the table?** [File an issue](https://github.com/bloknayrb/tandem/issues) with the working config — we'll add it to the examples so the next person doesn't have to figure it out.

### Verify

Check the server is up:

```bash
curl http://127.0.0.1:3479/health
# → {"status":"ok","version":"x.y.z","transport":"http","hasSession":false}
```

`hasSession` becomes `true` once an MCP client connects. (Source checkouts also get `npm run doctor` — see [docs/cli.md](docs/cli.md).)

### First 5 minutes

On first launch, `sample/welcome.md` opens automatically with three tutorial annotations and a floating tutorial card walking through the core loop.

<p align="center">
  <img src="docs/screenshots/08-onboarding-tutorial.png" alt="Tandem on first launch with the welcome document and onboarding tutorial card visible" width="800">
</p>

1. **Highlight a paragraph** in the editor.
2. **Ask your AI about it** — *"what do you think of this?"* — in the terminal or chat.
3. **Accept, dismiss, or edit** the annotation it leaves. Press `Ctrl+Shift+R` for keyboard review mode.

That's the whole loop. The rest is variations on it.

## How it works

### The core loop

You open a document. You highlight a passage. Your AI reads your selection directly through the MCP tools — no paste — and responds either in the chat sidebar or as an annotation on the text. You accept, dismiss, edit, or follow up. Repeat.

### Annotations

The differentiator. Each annotation Claude creates — highlight, comment, suggestion, flag — is a **first-class addressable object**, not ephemeral sidebar content. They're stored in a CRDT-backed Y.Map with stable IDs, survive server restarts, can be queried by ID, and are exportable as a structured Markdown review report.

Notes you create yourself are **user-private** ([ADR-027](docs/decisions.md)) — they're stripped from every MCP response and never appear in channel events. The AI cannot read them.

### Channels (real-time push)

The Tandem server emits an SSE stream at `/api/events` for selections, annotation actions, and chat messages. **Claude Code today** subscribes to that stream via the channel shim, behind the `--dangerously-load-development-channels` flag (Claude Code's marker for unstable APIs). The flag becomes unnecessary when the Channels API stabilizes. Other MCP clients can subscribe to `/api/events` directly to get the same events.

## Trust

**Local-first.** The server binds to `127.0.0.1` by default. Your documents stay on disk; there are no Tandem-operated servers in the picture. LAN exposure is opt-in and token-gated.

**Privacy.** Notes are user-private ([ADR-027](docs/decisions.md)) — the AI never reads them. Selections are dwell-time-gated so incidental clicks don't leak text. Only the documents you've opened are reachable through MCP tools.

**No telemetry.** No usage analytics, no crash reports, no beacons. The only outbound traffic Tandem initiates is to your AI client over loopback.

See [docs/security.md](docs/security.md) for the full security model — CORS allowlist, DNS-rebinding protection, auth-token rotation, and the LAN binding contract.

## Features

### Documents and editing

Multi-document tabs (drag to reorder), `.md`/`.txt`/`.html` with lossless round-trip, `.docx` in review-only mode with imported Word comments. Scratchpad documents (`Ctrl+N`) for unsaved drafts. Command palette (`Ctrl+K`) for everything else. Find and replace with regex, case-insensitive, whole-word, and cross-document scopes. Outline panel with click-to-jump. Internal-link navigation across open documents. Light/Dark/System themes (WCAG AA contrast). Atomic file saves — write to temp, then rename.

### AI collaboration

MCP tool surface for the AI to open documents, read text, edit ranges, create and resolve annotations, send chat replies, and read user awareness. Chat sidebar with selection-as-context — clicking the anchored selection on an old message scrolls back to that passage. Solo / Tandem mode toggle that queues non-urgent annotations when you're heads-down. Per-character authorship coloring (blue for you, orange for Claude), togglable per document. Threaded replies on any annotation. Real-time push (Claude Code today; other MCP clients subscribe to `/api/events`).

### Review workflow

CRDT-anchored annotations — highlight, comment, suggestion, flag — that survive edits, file reloads, and server restarts. Side panel with filters by type, author, and status; bulk accept / bulk dismiss. Keyboard review mode (`Ctrl+Shift+R`): `Tab` to move, `Y` accept, `N` dismiss, `E` edit, with a 10-second undo countdown. Word comment import from `.docx`. `tandem_exportAnnotations` produces a structured Markdown review report.

### Distribution and operations

Tauri desktop app for Windows (code-signed via Azure Trusted Signing), macOS (notarized universal), and Linux (`.AppImage` / `.deb` / `.rpm`). `tandem-editor` on npm for a global install. OS-keychain-backed per-client auth token storage. LAN binding (`TANDEM_BIND_HOST=0.0.0.0`) with auto-generated tokens and `tandem rotate-token` for in-place rotation with a 60-second grace window. Session persistence across restarts. Settings panel (Appearance, Editor, Network, Accessibility, Collaboration, AI Assistant, Models).

## MCP tools at a glance

26 active tools across 5 capability areas. See [docs/mcp-tools.md](docs/mcp-tools.md) for the full reference.

| Area | What it does |
|---|---|
| **Document** | Open, switch, list, close, and convert documents; read text content and outlines; save back to disk. |
| **Annotation** | Create, resolve, remove, and edit annotations; query the annotation list; export a review report. |
| **Apply** | Edit text ranges directly (typed edits, replacements, deletions) when annotations aren't the right surface. |
| **Navigation** | Inspect the active selection, jump to ranges, and resolve internal links. |
| **Awareness** | Read user presence and Solo/Tandem mode; check the inbox for selection events, chat messages, and annotation actions; reply in the chat sidebar. |

Plus a **Cowork bridge** for Claude Desktop via `tandem mcp-stdio`.

## Where Tandem is headed

Themes in flight toward v1.0. No dates, no promises:

- **Configuration without surprises** — a first-run wizard replaces today's silent auto-config for every integration, Claude included.
- **Model configuration for multiple providers** — a settings-driven registry so adding an alternate model doesn't require editing config files by hand.
- **Annotation durability** — content-hash identity so annotations survive aggressive document rewrites.
- **`.docx` body export** — production-quality round-trip from review-only to a real save path.
- **Cross-platform polish** — notarization, install matrix, accessibility gate, observer soak across all three platforms.

Beyond v1.0:

- High-fidelity `.docx` round-trip with formatting preservation.
- Code editing mode (CodeMirror 6 surface) for reviewing code the same way you review prose.
- Additional providers reachable through the model registry, including non-MCP providers via the Agent SDK adapter.

See the full [Roadmap](docs/roadmap.md) for known limitations and items explicitly out of scope for v1.

## Docs and references

- **[User Guide](docs/user-guide.md)** — Editor UI, annotations, chat, review mode, keyboard shortcuts.
- **[MCP Tool Reference](docs/mcp-tools.md)** — Every tool, its inputs, and its outputs.
- **[Architecture](docs/architecture.md)** — System design, data flows, coordinate systems, channel push.
- **[Workflows](docs/workflows.md)** — End-to-end usage patterns.
- **[Roadmap](docs/roadmap.md)** — Active waves, deferred items, known limitations.
- **[Design Decisions](docs/decisions.md)** — ADR-001 through ADR-038. Integration policy: [ADR-038](docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration).
- **[CHANGELOG](CHANGELOG.md)** — Release notes.
- **[Configuration](docs/configuration.md)** — Environment variables, LAN binding, app-data directories.
- **[CLI Reference](docs/cli.md)** — Every `tandem` subcommand and flag.
- **[Troubleshooting](docs/troubleshooting.md)** — Common failures with diagnostic steps.
- **[Security](docs/security.md)** — Network posture, auth, privacy, no-telemetry statement.

## Contributing

Tandem is a small project. Issues and pull requests are welcome — bug reports, MCP client configs that worked for you, and patches that don't regress the Claude default integration are all in scope.

<details>
<summary><strong>Development setup</strong></summary>

```bash
git clone https://github.com/bloknayrb/tandem.git
cd tandem
npm install
npm run dev:standalone   # backend (:3478, :3479) + frontend (:5173)
```

Open <http://127.0.0.1:5173>. The repo's `.mcp.json` configures Claude Code automatically when run from this directory.

**Tech stack:**

- Editor: [Svelte 5](https://svelte.dev), [Tiptap](https://tiptap.dev), [Vite](https://vitejs.dev), TypeScript
- Server: Node.js, [Hocuspocus](https://github.com/ueberdosis/hocuspocus) (Yjs WebSocket), [Express](https://expressjs.com), [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- CRDT: [Yjs](https://yjs.dev), [y-prosemirror](https://github.com/yjs/y-prosemirror)
- File I/O: [mammoth.js](https://github.com/mwilliamson/mammoth.js) (`.docx`), [unified](https://unifiedjs.com) / [remark](https://github.com/remarkjs/remark) (`.md`)
- Desktop: [Tauri 2](https://v2.tauri.app)

**Tauri development** requires the [Rust toolchain](https://www.rust-lang.org/tools/install) and [Tauri CLI](https://v2.tauri.app/start/prerequisites/). Web-only development (`npm run dev:standalone`) does not require Rust.

See [docs/cli.md](docs/cli.md#npm-run-scripts-source-checkouts-only) for the full list of npm scripts (build, test, lint, audit).

</details>

## License

Tandem is licensed under the [Business Source License 1.1](LICENSE).
