<p align="center">
  <a href="https://www.npmjs.com/package/tandem-editor"><img src="https://img.shields.io/npm/v/tandem-editor?label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BUSL--1.1-blue" alt="License: BUSL-1.1"></a>
  <a href="https://github.com/bloknayrb/tandem/releases/latest"><img src="https://img.shields.io/github/v/release/bloknayrb/tandem?label=release" alt="Latest release"></a>
</p>

**An editor where you and an AI work on the same document at the same time.**

Tandem is a document editor that lets you and an AI work on the same file together. You highlight a passage. The AI sees what you highlighted and can ask about it, comment on it, or propose changes that appear as cards beside your document. You decide what to keep.

One thing to know up front: the AI side requires an MCP-capable AI client — [Claude Code](https://claude.com/claude-code) is the default — and the subscription behind it (for Claude, a paid Anthropic plan). Without one connected, Tandem is a capable local document editor and nothing more.

Tandem is approaching v1.0 and ships continuous improvements. See [CHANGELOG.md](CHANGELOG.md) for what is in the latest release.

## Contents

- [What Tandem does](#what-tandem-does)
- [See it in action](#see-it-in-action)
- [Who Tandem is for](#who-tandem-is-for)
- [Getting started](#getting-started)
- [How you work with Tandem](#how-you-work-with-tandem)
- [Privacy and trust](#privacy-and-trust)
- [Where Tandem is headed](#where-tandem-is-headed)
- [Documentation](#documentation)
- [License](#license)
- [For developers and contributors](#for-developers-and-contributors)
  - [Architecture overview](#architecture-overview)
  - [The MCP integration policy](#the-mcp-integration-policy)
  - [MCP tools at a glance](#mcp-tools-at-a-glance)
  - [Channel push and real-time updates](#channel-push-and-real-time-updates)
  - [Development setup](#development-setup)
  - [Tech stack](#tech-stack)
  - [How to contribute](#how-to-contribute)

## What Tandem does

Most people use AI on a document by copying a passage into a chat window, asking a question, and pasting the answer back. Tandem closes that loop. The AI sits beside the document you are editing and reads from it directly.

When you highlight text, the AI sees the selection as you make it. You can ask it for a rewrite, a summary, a check on tone, or a second opinion. Its suggestions appear as cards next to the document. Accept them, set them aside, or reply to ask for something different.

Tandem is built to work with Anthropic's Claude out of the box. Other AI tools can also connect. See [the developer section](#the-mcp-integration-policy) below for the details of which clients work and which are tested first.

## See it in action

<p align="center">
  <img src="docs/screenshots/01-editor-overview.png" alt="The Tandem editor with a document open on the left and a panel of AI suggestion cards on the right" width="800">
</p>

*The main view. Your document fills the left side. The chat panel and any suggestions from the AI sit on the right.*

<p align="center">
  <img src="docs/screenshots/03-side-panel.png" alt="A close-up of suggestion cards beside the document, including a replacement card showing the original text in red strikethrough and the proposed text in green" width="500">
</p>

*A suggestion from the AI. Your current text and the proposed replacement appear together. Buttons let you accept the change or set it aside.*

## Who Tandem is for

- If you draft long-form writing and want a second reader for tone and structure.
- If you review documents — an essay, a thesis chapter, a report, or a contract — and want a faster pass.
- When a colleague hands you a document to mark up.
- When the AI wrote a draft and you need to decide what to keep.

Tandem is built for individuals working on their own documents. The example document types above are just that — examples; the workflow is the same whatever you are writing or reviewing. The interface is English-only for now.

## Getting started

### System requirements

Windows 10 version 22H2 or Windows 11. macOS 12 (Monterey) or later. Linux with glibc 2.31 or later (Ubuntu 20.04+, Debian 11+, Fedora 34+). On Windows, the first launch may show a "Windows protected your PC" warning until the installer's signing certificate accumulates SmartScreen reputation. See [docs/troubleshooting.md#windows-smartscreen-warning](docs/troubleshooting.md#windows-smartscreen-warning) for the steps to dismiss it.

### Download the desktop app (recommended)

Pick the installer for your platform from the [latest release](https://github.com/bloknayrb/tandem/releases/latest). Windows, macOS, and Linux builds are available.

The desktop app bundles the editor, the server it talks to, and storage for the connection token. Updates land automatically. Double-clicking a `.md`, `.txt`, or `.html` file opens it directly in Tandem.

### What you get

- Multiple documents open in tabs, with `.md`, `.txt`, `.html`, and `.docx` support (Word files are editable; the original is only written when you explicitly save).
- A scratchpad (`Ctrl+N`) for drafts you do not want to save to disk.
- A command palette (`Ctrl+Shift+P`) for quick actions.
- Find and replace, including across all open tabs.
- An outline panel for navigating long documents.
- Light and dark themes.
- Keyboard navigation through pending suggestions: `Alt+]` and `Alt+[` to move between them, `Ctrl+Enter` to accept, `Ctrl+Shift+Enter` to dismiss.

### Other ways to install

If you use a terminal, you can also install Tandem with `npm install -g tandem-editor`, then run `tandem` to launch — the first-run wizard connects Claude. (For a scripted, non-interactive setup, run `tandem setup --apply` once first.) This works the same as the desktop app and is mostly useful if you already have Node.js installed.

### Got stuck

See [docs/troubleshooting.md](docs/troubleshooting.md) for common problems and how to resolve them.

## How you work with Tandem

1. Open a document in Tandem.
2. Start Claude. Tandem and Claude connect automatically once you have run setup once.
3. Type a question in the chat panel, or highlight text in the document to focus the AI on a passage. The AI sees what you highlight as you highlight it.
4. The AI's suggestions appear as cards beside the document. You decide what to accept.
5. Save when you are finished.

See [docs/workflows.md](docs/workflows.md) for examples of how this looks in daily use.

## Privacy and trust

- Tandem itself runs on your computer and stores your documents on your disk. We do not operate any servers that hold your files.
- When you ask the AI to do something, the text you share with it goes to whichever AI service you are using. For example, if you connect Claude, the text goes to Anthropic under their terms. Tandem does not relay or copy your document anywhere else.
- Tandem includes a private notes feature. Notes you mark as private are stripped from every response the AI sees ([ADR-027](docs/decisions.md)).
- Tandem does not collect telemetry or analytics by default — no usage data, and **crash reporting is off unless you turn it on**. Crash reporting is strictly opt-in: it activates only when you set the `TANDEM_SENTRY_DSN` environment variable to a [Sentry](https://sentry.io) or self-hosted [GlitchTip](https://glitchtip.com) DSN of your own. With that variable unset (the default), no crash data ever leaves your machine. When enabled, Tandem ships Rust panics, native crash minidumps, JavaScript errors, and unhandled rejections to *your* configured endpoint, scrubbing home-directory paths (to `~`), obvious API keys/bearer tokens, and request/document payloads before anything is sent. Self-hosting GlitchTip keeps the data fully under your control, in keeping with Tandem's local-first posture.
- When paid licensing arrives at v1.0, running the app will validate a signed license file on your own machine (no network call required); update checks will remain network-only, carry no analytics, and the update service will log only what it needs to authorize the download.

See [docs/security.md](docs/security.md) for the full security model.

## Where Tandem is headed

Tandem is on the way to a v1.0 release. Recent releases added support for multiple AI providers and in-app configuration for connections and models. Work still in progress covers improvements to how Word documents round-trip through the editor, turnkey setup on macOS and Linux, and final polish. Tandem is free during the public beta; at v1.0 it moves to a one-time paid license, and beta users are grandfathered with a free license. The full plan lives in [docs/roadmap.md](docs/roadmap.md).

## Documentation

- [docs/user-guide.md](docs/user-guide.md) for a longer walkthrough of the editor.
- [docs/workflows.md](docs/workflows.md) for daily usage patterns.
- [docs/troubleshooting.md](docs/troubleshooting.md) for when something goes wrong.
- [docs/data-locations.md](docs/data-locations.md) for where Tandem stores data and how to uninstall cleanly.
- [docs/positioning.md](docs/positioning.md) for the longer story of why Tandem exists.
- [docs/decisions.md](docs/decisions.md) for design decisions (ADRs).
- [docs/roadmap.md](docs/roadmap.md) for what is coming.
- [docs/architecture.md](docs/architecture.md) for diagrams and the file map.
- [docs/mcp-tools.md](docs/mcp-tools.md) for the MCP tool reference.
- [docs/security.md](docs/security.md) for the security model.
- [docs/configuration.md](docs/configuration.md) for advanced configuration.
- [docs/cli.md](docs/cli.md) for CLI command reference.
- [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

Tandem is free during the public beta. At v1.0 it moves to a one-time paid license; existing beta users are grandfathered with a free license. It is licensed under the Business Source License 1.1 (BUSL-1.1); see [LICENSE](LICENSE) for the terms.

---

## For developers and contributors

### Architecture overview

Three layers: the editor (Tiptap inside a Tauri desktop app or a browser), the Tandem server (Hocuspocus on port 3478 for collaborative edits and an MCP HTTP server on port 3479 for AI tool calls), and the AI client (Claude Code or any other MCP-capable client). The full file map and data flows live in [docs/architecture.md](docs/architecture.md).

### The MCP integration policy

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is an open standard for AI clients to talk to tools and data sources. Tandem exposes its document and annotation surface over MCP, which is how AI clients like Claude read and modify the file you are editing.

The integration policy is set by [ADR-038](docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration):

> Tandem's integration contract is **MCP**. The default integration is **Claude** (Claude Code + Claude Desktop) — it's what we recommend, what we test against, and it ships with the channel push, cowork, plugin monitor, and auto-launcher features. Any MCP-capable client can connect to the same MCP HTTP endpoint and use the same 27 tools, but the Claude-specific transports don't apply. Other clients are **best-effort, MCP-contract-compatible, not validated** today.
>
> **Integration setup** runs through the integration setup wizard (#477 PR 3). The earlier transitional behavior — Tandem auto-writing its MCP entry to Claude's config files on Tauri startup — was **removed in #477 PR 3c-ii-c**. Every integration (Claude included) is now configured via the wizard, never silently; `tandem setup --apply` is the scriptable non-interactive equivalent.

Client compatibility:

| AI surface | Status |
|---|---|
| **Claude Code** (local CLI) | Default. Validated. Channel push supported. |
| **Claude Desktop** (local app) | Supported via the Cowork bridge. Channel push N/A. |
| **claude.ai web chat** | Not supported. Would require exposing the local server publicly via a tunnel, which is outside scope. |
| **Other MCP-capable clients** (Cursor, Continue.dev, LM Studio, Ollama, …) | Best-effort, MCP-contract-compatible, not validated. |
| **Non-MCP AIs** (ChatGPT direct, Gemini direct, etc.) | Not supported today. Multi-provider support is in progress via the Agent SDK adapter ([ADR-038 §3](docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)); not yet shippable. |

### MCP tools at a glance

27 active tools across five capability areas. Full reference: [docs/mcp-tools.md](docs/mcp-tools.md).

- **Document.** Open, switch, list, close, and convert documents; read text content and outlines; save back to disk.
- **Annotation.** Create, resolve, remove, and edit annotations; query the annotation list; export a review report.
- **Apply.** Edit text ranges directly when an annotation is not the right surface.
- **Navigation.** Inspect the active selection, jump to ranges, and resolve internal links.
- **Awareness.** Read user presence and Solo/Tandem mode; check the inbox for selection events, chat messages, and annotation actions; reply in the chat sidebar.

### Channel push and real-time updates

Channel push delivers events (selections, annotation actions, chat messages) to the AI client over Server-Sent Events the moment they happen, so the AI does not have to poll. Two install options:

```bash
tandem setup --apply --with-channel-shim                   # persistent setup
claude --dangerously-load-development-channels server:tandem-channel   # one-off
```

The `--dangerously-load-development-channels` flag is Claude Code's marker for unstable APIs; it becomes unnecessary when the Channels API stabilizes.

Without channel push, the AI uses `tandem_checkInbox` to pull the same events on demand. You can also ask Claude to poll periodically with `/loop 30s check tandem inbox and respond to any new messages`.

### Development setup

```bash
git clone https://github.com/bloknayrb/tandem.git
cd tandem
npm install
npm run dev:standalone   # backend (:3478, :3479) + frontend (:5173)
```

Open <http://127.0.0.1:5173>. The repo's `.mcp.json` configures Claude Code automatically when run from this directory.

Verify the server is up:

```bash
curl http://127.0.0.1:3479/health
# → {"status":"ok","version":"x.y.z","transport":"http","hasSession":false}
```

For exposing the server on a LAN, set `TANDEM_BIND_HOST` and use `tandem rotate-token` to rotate the auth token. See [docs/security.md](docs/security.md) for the full network posture.

See [docs/cli.md](docs/cli.md#npm-run-scripts-source-checkouts-only) for the full list of npm scripts.

### Tech stack

Tandem is built on [Tiptap](https://tiptap.dev) and [ProseMirror](https://prosemirror.net) (editor), [Yjs](https://yjs.dev) and [Hocuspocus](https://github.com/ueberdosis/hocuspocus) (CRDT sync), [Tauri 2](https://v2.tauri.app) (desktop), and [Svelte 5](https://svelte.dev) (UI).

### How to contribute

Open an issue first for non-trivial changes; for bug reports and small fixes, a PR is fine. Follow the workflow described in [CLAUDE.md](CLAUDE.md). Run `npm run typecheck` and `npm test` before opening a pull request.
