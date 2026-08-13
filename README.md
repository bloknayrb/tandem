<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logotype-dark.png">
    <img src="docs/assets/logotype-light.png" alt="Tandem" width="280">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tandem-editor"><img src="https://img.shields.io/npm/v/tandem-editor?label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BUSL--1.1-blue" alt="License: BUSL-1.1"></a>
  <a href="https://github.com/bloknayrb/tandem/releases/latest"><img src="https://img.shields.io/github/v/release/bloknayrb/tandem?label=release" alt="Latest release"></a>
</p>

**An editor where you and an AI work on the same document at the same time.**

## Why I built this

At work I kept asking Claude to draft a report for me. I'd have it write into a scratch file in my
Obsidian vault, and the file would update the instant Claude touched it — which was great, right up
until I had something to say about it. If I wanted one paragraph changed, or wanted to ask what a
particular sentence was even doing there, I was back to copying text into the chat window and pasting
the answer out again. It was a one-way street. And Claude couldn't open a note for me either — I had
to go find it myself.

Tandem is what closed that loop. I tell Claude to pull something up in Tandem, and then I just keep
talking to it there: in the chat beside the document, or by commenting on a specific paragraph, or by
highlighting a sentence and asking about *that* — it knows what I'm pointing at. It works the other
way too. I can open any file in Tandem and Claude is already attached to it, with no session to start
and nothing to paste in. (If I want it to see the rest of that folder as well, Tandem offers to
relaunch it there.)

One thing to know up front: the AI side needs an AI client running on your own computer, plus the subscription behind it. [Claude Code](https://claude.com/claude-code) is the default, and a Claude Pro or Max subscription includes it. Clients connect over [MCP](https://modelcontextprotocol.io) — an open standard for letting an AI reach tools and files — so others can be used too. [Install](#install) below covers the setup, which is a wizard rather than a config file. Without a client connected, Tandem is a capable local document editor and nothing more.

<p align="center">
  <img src="docs/screenshots/01-editor-overview.png" alt="The Tandem editor with a document open on the left and a panel of AI annotation cards on the right" width="820">
</p>

*Your document on the left, the AI's comments and suggested rewrites as cards on the right. Accept, reject, or reply to ask for something different.*

## Who Tandem is for

- You draft long-form writing — an essay, a report, a proposal, a design doc — and want a second reader for tone and structure.
- You review what someone else wrote — a thesis chapter, a contract, a spec — and want a faster pass.
- The AI wrote a draft and you need to decide what to keep.

Tandem is built for individuals working on their own documents. The document types above are examples; the workflow is the same whatever you are writing. The interface is English-only for now.

## Install

**[Download the installer for your platform →](https://github.com/bloknayrb/tandem/releases/latest)** Windows, macOS, and Linux. The desktop app bundles the editor, its server, and its own updates; double-clicking a `.md`, `.markdown`, `.txt`, `.html`, or `.docx` file opens it in Tandem.

Then connect your AI. Tandem opens a setup wizard on first run: if [Claude Code](https://claude.com/claude-code) is not installed it can install it for you in one click on all three platforms, and it writes the connection settings itself. Reopen it any time from **Settings → AI Assistant**. Two things worth knowing before you start — **a Claude Pro or Max subscription includes Claude Code** (pay-as-you-go API billing works too), and **the Claude you use at claude.ai in a browser cannot connect**, because a web page has no way to reach a file on your disk. A subscription is necessary but not sufficient: you also need Claude Code, or Claude Desktop, locally.

Prefer a different AI? Any MCP-capable client can connect to the same endpoint — see [docs/integrations.md](docs/integrations.md) for what is supported and what is untested, and [Cowork](#cowork) for connecting Claude Desktop on Windows.

<details>
<summary><b>System requirements</b></summary>

Windows 10 version 22H2 or Windows 11. macOS 12 (Monterey) or later. Linux with glibc 2.31 or later (Ubuntu 20.04+, Debian 11+, Fedora 34+). On Windows, the first launch may show a "Windows protected your PC" warning until the installer's signing certificate accumulates SmartScreen reputation — see [the troubleshooting entry](docs/troubleshooting.md#windows-smartscreen-warning) for how to dismiss it.

</details>

<details>
<summary><b>Install from npm instead</b></summary>

`npm install -g tandem-editor` (Node.js 22.12 or newer required), then run `tandem` — it starts the server and prints a `http://127.0.0.1:3479` URL that opens the editor in your browser, where the first-run wizard connects Claude. For a scripted, non-interactive setup, run `tandem setup --apply` once first. This is mostly useful if you already have Node.js; the desktop app is the recommended experience.

</details>

<details>
<summary><b>Real-time updates for hand-started sessions</b></summary>

**How Claude starts matters.** Tandem talks to Claude over two independent connections: one lets Claude read and edit your document, the other tells it the moment you comment or send a chat message. Sessions Tandem launches for you — including the desktop app's **Relaunch Claude** button — get both, and need no setup from you. A session you start yourself by typing `claude` begins with the first connection; on its first successful read-mode `tandem_status`, Tandem's bundled skill automatically tells it to attempt the second with the built-in Monitor when that tool is available.

The simplest needs no installation at all: **the built-in Monitor watch starts automatically on first Tandem use.** The bundled skill reads the live wake-stream address from that first successful `tandem_status` and makes one persistent attempt for the session. If that attempt was skipped, asking Claude to watch is a recovery step, not normal setup. It does need a Claude Code that offers a built-in Monitor tool. That is enabled per account rather than per version, so upgrading will not add it, and on Windows it also needs Git Bash. The plugin monitor shares the same per-account feature gate, so it cannot help when that gate is off. But the plugin monitor does not require Git Bash on Windows and can fall back to PowerShell, so it may help when Git Bash is the missing precondition. The third option below, the channel shim, avoids both requirements.

The second is to install the Tandem plugin, which also needs no flag — see [Real-time updates](#real-time-updates) below. It starts watching the first time Claude uses Tandem's skill in a session, so ask for Tandem by name ("let's work on this in Tandem") rather than expecting it to be listening before you have mentioned it. Start `claude` from a terminal window if you install it: the plugin's monitor uses whatever program path that shell has, and a Claude Code started from a desktop icon may not have one it can use.

The third is the channel shim, which has to be registered and then switched on for each session:

```bash
tandem setup --apply --with-channel-shim                              # once
claude --dangerously-load-development-channels server:tandem-channel  # every session
```

Choose one setup route where possible. A plugin-backed session whose Claude Code also offers the built-in Monitor may start both automatically when it first uses Tandem's skill. Those wakes contain no message content; host rate limiting can hide the overlap, and the inbox de-duplicates what Claude reads. If wakes visibly double, ask Claude to stop its built-in watch with `TaskStop`.

Without any of them nothing breaks and nothing is lost: your messages and comments are saved, and Claude sees them the next time it checks its inbox. But it will not react on its own, which reads as Claude ignoring you. If that is what you are seeing, [this troubleshooting entry](docs/troubleshooting.md#i-sent-a-chat-message-or-left-a-comment-and-nothing-happened) walks through it, and **Settings → About → Copy Diagnostics** (or `tandem doctor`, on npm installs) reports whether anything is listening. More detail in [Real-time updates](#real-time-updates).

</details>

## How you work with Tandem

1. Open a document in Tandem.
2. Start your AI client — Claude Code, in the default setup. Once you have been through [Install](#install), Tandem and Claude find each other automatically; you do not reconnect them each time.
3. Type a question in the chat panel, or highlight text in the document to focus the AI on a passage. The AI sees what you highlight as you highlight it.
4. The AI's suggestions appear as cards beside the document. You decide what to accept.
5. Save when you are finished.

See [docs/workflows.md](docs/workflows.md) for examples of how this looks in daily use.

## What you get

- Multiple documents open in tabs, with `.md`, `.markdown`, `.txt`, `.html`, and `.docx` support (Word files are editable; the original is only written when you explicitly save).
- Word round-trip: edit a `.docx` and save it back as a real Word file, with the comments you sent your AI written back as native Word comments. Tandem snapshots a file before its first write, so you can restore the original from inside the app.
- A scratchpad (`Ctrl+N`) for drafts you do not want to save to disk.
- A command palette (`Ctrl+Shift+P`) with fuzzy search, ranked by how well each result matches.
- Find and replace, including across all open tabs.
- An outline panel for navigating long documents.
- Paste that keeps its structure: Markdown tables and images arrive as real tables and images, and a URL pasted over selected text becomes a link.
- Suggestions shown as word-level diffs, so you can see exactly which words change.
- Optional smart typography (curly quotes, em dashes) and a spellcheck toggle, in Settings (`Ctrl+,`).
- Light and dark themes.
- Keyboard navigation through pending suggestions: `Alt+]` and `Alt+[` to move between them, `Ctrl+Enter` to accept, `Ctrl+Shift+Enter` to reject.

<details>
<summary><b>More screenshots</b></summary>

<p align="center">
  <img src="docs/screenshots/03-side-panel.png" alt="A close-up of annotation cards beside the document, including a replacement card showing the original text in red strikethrough and the proposed text in green, with Accept and Reject buttons" width="500">
</p>

*Annotations from the AI. Comments and suggestions appear as cards. For a replacement, your current text and the proposed wording show together — accept the change, reject it, or reply to ask for something different.*

<p align="center">
  <img src="docs/screenshots/02-chat-sidebar.png" alt="The chat panel showing a question from the user and a reply from the AI assistant about the document" width="460">
</p>

*The chat panel. Ask a question about the document and the AI answers in place — it can read the file directly, so there is nothing to copy and paste.*

<p align="center">
  <img src="docs/screenshots/04-toolbar-actions.png" alt="The top of the editor showing several documents open in tabs, the formatting toolbar, a text selection, and the Solo and Tandem mode toggle" width="800">
</p>

*Several documents open in tabs, with the formatting toolbar above the text. Highlight a passage and the AI sees the selection as you make it. The Solo / Tandem toggle on the right decides whether you are working alongside the AI or on your own — see [Privacy and trust](#privacy-and-trust) for what Solo holds back.*

</details>

## Privacy and trust

- Tandem itself runs on your computer and stores your documents on your disk. We do not operate any servers that hold your files.
- When you ask the AI to do something, the text you share with it goes to whichever AI service you are using. For example, if you connect Claude, the text goes to Anthropic under their terms. Tandem does not relay or copy your document anywhere else.
- Tandem includes a private notes feature. Notes you mark as private are stripped from every response the AI sees ([ADR-027](docs/decisions.md)).
- **Solo mode holds your work back from the AI.** The Solo / Tandem toggle in the title bar (`Ctrl+Shift+M`) is not just a notification setting: while you are in Solo, the comments and replies *you* write are withheld from what the AI is told and from what it can look up — its inbox, its reads of the annotation list, and the live updates pushed to it. Each held item shows an amber **Held** pill, the status bar keeps a running count, and switching back to Tandem releases the set together. The hold is enforced where the AI reads, not just where things are displayed — including the annotation export, which reports how many items it withheld rather than quietly including them. What Solo does *not* cover: it holds comments and replies, not the document text itself, which the AI can still read. See [the user guide](docs/user-guide.md#solo--tandem-mode) for the full boundary.
- Tandem does not collect telemetry or analytics by default — no usage data, and **crash reporting is off unless you turn it on**. It activates only if you set `TANDEM_SENTRY_DSN` to a [Sentry](https://sentry.io) or self-hosted [GlitchTip](https://glitchtip.com) endpoint of your own; unset (the default), no crash data ever leaves your machine. Sent reports are scrubbed of home-directory paths, API keys, and document payloads — see [docs/security.md](docs/security.md) for the details.
- When paid licensing arrives at v1.0, running the app will validate a signed license file on your own machine (no network call required); update checks will remain network-only, carry no analytics, and the update service will log only what it needs to authorize the download. Once activated, a paid license runs indefinitely — the run check only verifies the signature. The one-year window governs which updates you're offered, not whether the app keeps working.

See [docs/security.md](docs/security.md) for the full security model.

## Where Tandem is headed

Tandem is approaching v1.0 and ships continuous improvements; [CHANGELOG.md](CHANGELOG.md) records what landed in each release and [docs/roadmap.md](docs/roadmap.md) has the full plan. Today the supported integration is Claude (Claude Code / Claude Desktop) over MCP, set up by the in-app wizard. Local models (Ollama, LM Studio) are committed for v1.0 — built and shipping in the app already, but switched off until then, so you won't see a Models tab in this release ([#1123](https://github.com/bloknayrb/tandem/issues/1123)). Same one-time license; cloud API-key providers (OpenAI, Gemini) follow in v1.1. Work still in progress covers turnkey setup on macOS and Linux, switching on the licensing that is already built into the app, and final polish; pricing is covered under [License](#license) below.

## Documentation and help

**Something not working?** Run the built-in diagnostics first — they check the setup problems behind most first-launch failures. In the desktop app: **Settings → About → Copy Diagnostics**. On an npm install: `tandem doctor`. (The desktop app does not install the `tandem` command, so use the button rather than the CLI.) Then see [docs/troubleshooting.md](docs/troubleshooting.md).

| | |
|---|---|
| [User guide](docs/user-guide.md) | a longer walkthrough of the editor |
| [Workflows](docs/workflows.md) | daily usage patterns |
| [Troubleshooting](docs/troubleshooting.md) | when something goes wrong |
| [Data locations](docs/data-locations.md) | where Tandem stores data, and clean uninstall |
| [Integrations](docs/integrations.md) | which AI clients connect, and how |
| [Security](docs/security.md) | the full security model |
| [Licensing](docs/licensing-explained.md) | how licensing works at v1.0, plain English first |
| [Configuration](docs/configuration.md) · [CLI](docs/cli.md) | advanced setup and command reference |
| [Positioning](docs/positioning.md) · [Decisions](docs/decisions.md) · [Roadmap](docs/roadmap.md) · [Architecture](docs/architecture.md) · [MCP tools](docs/mcp-tools.md) | why Tandem exists, ADRs, what's next, diagrams, the MCP tool reference |
| [CHANGELOG](CHANGELOG.md) | release notes |

## License

Tandem is free during the public beta. At v1.0 it moves to a one-time paid license; existing beta users are grandfathered with a free license. It is licensed under the Business Source License 1.1 (BUSL-1.1); see [LICENSE](LICENSE) for the terms.

**Claiming the beta license:** Tandem has no telemetry, analytics, or signup, so there is no list of beta users to work from — we can only grandfather people who tell us they're here. If you've been using the beta, email <support@tandem.ink> with roughly when you first installed it, and you'll be sent a free license before enforcement turns on. Activate it as soon as it arrives (Settings → License) rather than filing it away: the pre-v1.0 build says licensing isn't enforced yet, which is true, and is exactly why an unactivated key is easy to lose.

---

## Cowork

[Cowork](https://www.anthropic.com/news/claude-code-on-the-web) is Claude Desktop's local agent mode — Claude runs in an isolated VM on your machine. Tandem connects to it through Claude's **plugin system**, but you don't add a marketplace or run any `/plugin` commands yourself.

- **How to enable (Windows desktop app):** open the integration wizard (Settings → AI Assistant, or "Set up" next to Cowork) and click **Enable Cowork**, or toggle it on in Settings → Network. Tandem writes the plugin entry into every detected Cowork workspace and adds a Windows firewall rule so the VM can reach the Tandem server on this computer. That firewall step needs admin once — without it, the VM can't connect.
- **Why it's automated, not a manual marketplace install:** inside the VM the plugin must point at `host.docker.internal:3479` and carry a per-machine secret auth token. A published marketplace plugin can't carry that token, so Tandem provisions the workspace entries directly. (The published `tandem@tandem-editor` marketplace plugin is for Claude Code running *on the host*, over `127.0.0.1` — see below.)
- **Verify:** in a Cowork session, ask Claude to open or list your documents — Tandem's tools should appear. If they don't, re-run Enable.
- **Real-time updates:** live annotation/chat push needs the Tandem desktop app plus one of the push transports (see [Real-time updates](#real-time-updates)); the Cowork connection itself is request/response. Note the self-armed watch is **not** one of the options here — its wake stream refuses non-loopback peers, so a session inside a Cowork VM cannot reach it.
- **macOS / Linux:** not yet — tracked in #316 / #317.

For Claude Code on the host, the published plugin can be added from the marketplace instead of the wizard:

```bash
claude plugin marketplace add bloknayrb/tandem
claude plugin install tandem@tandem-editor
```

This activates the MCP tools, the bundled skill, and — on Claude Code 2.1.212 or newer — a monitor that delivers real-time events with no extra flag. See [Real-time updates](#real-time-updates) for how that compares to the other two.

<details>
<summary><h2>For developers and contributors</h2></summary>

Building Tandem, running it from source, the git hooks, and the checks to run before a pull request live in **[CONTRIBUTING.md](CONTRIBUTING.md)**. The MCP integration policy (ADR-038), the client compatibility table, and the MCP tools by capability area live in **[docs/integrations.md](docs/integrations.md)**.

Three layers: the editor (Tiptap inside a Tauri desktop app or a browser), the Tandem server (Hocuspocus on port 3478 for collaborative edits and an MCP HTTP server on port 3479 for AI tool calls), and the AI client (Claude Code or any other MCP-capable client). The full file map and data flows live in [docs/architecture.md](docs/architecture.md). Tandem is built on [Tiptap](https://tiptap.dev) and [ProseMirror](https://prosemirror.net) (editor), [Yjs](https://yjs.dev) and [Hocuspocus](https://github.com/ueberdosis/hocuspocus) (CRDT sync), [Tauri 2](https://v2.tauri.app) (desktop), and [Svelte 5](https://svelte.dev) (UI).

### Real-time updates

Real-time delivery gets events (annotation actions, chat messages) to the AI the moment they happen, so it does not have to wait until it next polls. There are three setup routes; they are not layers you need to configure together. When the plugin and built-in Monitor are both available, however, first skill use can start both automatically — a safe but potentially wasteful overlap described below.

None of them is needed for a session Tandem launches for you. Those are woken directly by Tandem over the session's own input and use none of the three; everything below is about sessions you start by hand.

**A self-armed watch** needs nothing installed and no flag. On first Tandem use, the bundled skill automatically reads the wake-stream address from the first successful `tandem_status` and makes one persistent built-in Monitor attempt. It lasts for that session and disappears with it, which is also the point — nothing is left configured on your machine. Asking Claude to watch is recovery if the automatic attempt was skipped. Two limits: it needs a Claude Code that offers a built-in Monitor tool, and the wake stream is **loopback-only**, so it does not reach a session running anywhere but this machine — Cowork included.

**The plugin monitor** needs no flag either, and once installed it applies to every session — but it starts watching only when Claude first uses Tandem's skill in that session, not the moment the session opens. In practice that means asking for Tandem by name; a Claude that has never been told about Tandem is not listening yet. That is deliberate: it used to start in every session including ones with nothing to do with Tandem, so when it could not run it reported a failure in all of them. Two further conditions: it requires **Claude Code 2.1.212 or newer** — on older versions the install still succeeds and the monitor simply never runs, with nothing to tell you so — and you should start `claude` from a terminal, because the monitor runs with whatever program path that session was given and a desktop-icon launch may not include Node. If it reports `exit 127`, that is this.

**The channel shim** is the transport Tandem has tested against longest ([ADR-028](docs/decisions.md)). It is **not registered by default** — that changed in the release this note ships with, because a shim whose session never enables the flag connects, delivers nothing, and makes Tandem believe something is listening. Registering it is also not enough on its own; the session has to be started with the flag as well:

```bash
tandem setup --apply --with-channel-shim                   # once
claude --dangerously-load-development-channels server:tandem-channel   # every session
```

The flag is Claude Code's marker for unstable APIs. It works only in an interactive session, and it is required rather than optional: `tandem-channel` is a plain MCP server, and Claude Code's channel allowlist covers only plugins, so there is no list Tandem could join that would remove the need for it. If you already have it configured, your configuration is untouched and keeps working — the change is to what a *new* setup writes. To remove it, re-run `tandem setup --apply` without the flag.

Choose one setup route where possible. A plugin-backed session may still start its packaged monitor and built-in watch automatically. Wakes carry no message content, the inbox de-duplicates what Claude reads, and host rate limiting can hide the overlap; if wakes visibly double, ask Claude to stop its built-in watch with `TaskStop`.

Note that Solo mode suppresses annotation events on all three by design — chat still comes through. If you are testing real-time delivery and only chat arrives, check the mode toggle before debugging the transport.

Without any of them, the AI uses `tandem_checkInbox` to pull the same events on demand. You can also ask Claude to poll periodically with `/loop 30s check tandem inbox and respond to any new messages`.

</details>
