---
tags: [glossary, reference]
aliases: [Glossary, Tandem glossary, Terms]
---

# Glossary

Plain-language definitions of the words Tandem's docs use. Each entry links to the doc that
owns the detail; when the two disagree, the linked doc wins. Back to the [docs hub](README.md).

**By theme**

- **Working with the AI:** [Solo mode](#solo-mode) · [Tandem mode](#tandem-mode) ·
  [annotation](#annotation) · [comment](#comment) · [suggestion](#suggestion) · [note](#note) ·
  [highlight](#highlight) · [pending, accepted, dismissed](#pending-accepted-dismissed) ·
  [inbox](#inbox) · [chat](#chat)
- **Documents:** [scratchpad](#scratchpad) · [read-only document](#read-only-document) ·
  [upload](#upload) · [documentId](#documentid)
- **Connecting and waking Claude:** [MCP](#mcp) · [MCP server](#mcp-server) ·
  [Tandem's Claude](#tandems-claude) · [supervisor](#supervisor) · [wake watch](#wake-watch) ·
  [plugin monitor](#plugin-monitor) · [channel shim](#channel-shim) · [push and pull](#push-and-pull)
- **Dark features:** [ships dark](#ships-dark) · [.docx support](#docx-support) ·
  [Cowork setup](#cowork-setup) · [licensing gate](#licensing-gate) ·
  [local-model collaborator](#local-model-collaborator) · [LAN bind](#lan-bind)
- **Under the hood:** [Hocuspocus](#hocuspocus) · [Y.Doc and CRDT](#ydoc-and-crdt) ·
  [flat offsets](#flat-offsets) · [ProseMirror positions](#prosemirror-positions) ·
  [RelativePosition](#relativeposition) · [degraded anchor](#degraded-anchor) ·
  [origin tags](#origin-tags) · [CTRL_ROOM](#ctrl_room)
- **Your machine:** [app-data directory](#app-data-directory) · [auth token](#auth-token)
- **Contributing:** [reserved harness ports](#reserved-harness-ports) · [ADR](#adr) ·
  [claim tests](#claim-tests)

## Solo mode

One of the two collaboration modes, switched from the title bar. In Solo, the comments and replies
you write are held back from the AI until you switch to Tandem mode; chat messages and document
edits still flow both ways. The hold is enforced on everything the AI reads, while the AI's own
restraint during Solo is a request from Tandem's skill, not a block. The mode is app-wide, not
per document. See [Solo / Tandem mode](user-guide.md#solo--tandem-mode) and
[Privacy and trust](../README.md#privacy-and-trust).

## Tandem mode

The default collaboration mode: your comments and replies reach the AI as you write them, and its
annotations appear as they arrive. Switching from Solo back to Tandem releases everything that was
held, together. See [Solo / Tandem mode](user-guide.md#solo--tandem-mode).

## Annotation

Feedback attached to a span of text: a [highlight](#highlight), a [comment](#comment) or a
[note](#note). Annotations are stored beside the document's content, not inside it, so they never
change your file and they follow their text as it is edited. See
[Annotations](user-guide.md#annotations) and
[ADR-027](decisions.md#adr-027-annotation-system-redesign--audience-based-model).

## Comment

The shared annotation type: you write comments to ask the AI something about a passage, and it
writes comments to give you feedback. Each one appears as a card in the side panel or the margin.
See [Comment](user-guide.md#comment).

## Suggestion

An AI comment that carries replacement text. Its card shows the change as a diff, and accepting it
rewrites the passage; Undo reverts both the text and the card. Only the AI makes suggestions; to
get one, ask in a comment. See [Comment](user-guide.md#comment).

## Note

A private annotation for yourself. The AI cannot read, edit, resolve or reply to a note through any
tool or event, in either mode. You can promote a note to a comment if you later want the AI to see
it. See [Note](user-guide.md#note) and
[ADR-027](decisions.md#adr-027-annotation-system-redesign--audience-based-model).

## Highlight

A coloured mark you put on text, in one of four colours, to flag a passage for yourself. The AI
never creates highlights. See [Highlight](user-guide.md#highlight).

## Pending, accepted, dismissed

The three states of an annotation. A new one is pending; **Accept** or **Dismiss** resolves it,
and accepting a suggestion also applies its text. Only pending annotations can be edited.
See [Reviewing annotations](user-guide.md#reviewing-annotations) and
[ADR-035](decisions.md#adr-035-annotation-lifecycle-module).

## Inbox

What the AI pulls with `tandem_checkInbox`: your new chat messages, comments and replies, and your
accepts and dismissals since it last looked, plus the current mode. The inbox is the authority on
what the AI has been told; every push route only nudges Claude to check it. See
[Awareness tools](mcp-tools.md#awareness-tools) and
[Polling remains authoritative](user-guide.md#polling-remains-authoritative).

## Chat

The conversation panel beside the document. There is one chat thread for the whole app, not one
per document; each message records which document it was sent from. The AI answers with
`tandem_reply`. Chat is never held in Solo mode. See [Chat](user-guide.md#chat) and
[ADR-048](decisions.md#adr-048-chat-stays-global-ctrl_room-scoped-not-document-scoped).

## Scratchpad

A Markdown document not tied to any file, for drafting before you decide where the text belongs.
**Save As** turns it into an ordinary file. The AI can create one with `tandem_scratchpad`. See
[Scratchpads](user-guide.md#scratchpads) and
[Using scratchpads for drafting](workflows.md#using-scratchpads-for-drafting).

## Read-only document

A document Tandem opens for reading and annotating but never writes back. The status bar shows
**Review Only**. Uploaded files, every HTML file and the changelog opened from Settings are
read-only. See [Supported formats](user-guide.md#supported-formats).

## Upload

In the browser build, a file opened through the **Open File** dialog's **Browse…** button. It gets
a synthetic `upload://` path and is always read-only: saving keeps its annotations but cannot write
to disk. See [Opening files](user-guide.md#opening-files).

## documentId

The stable ID of an open document, derived from its file path. Every MCP tool takes an optional
`documentId` and defaults to the active document. See
[Multi-document support](mcp-tools.md#multi-document-support) and
[ADR-010](decisions.md#adr-010-docidfrompath-for-multi-document-room-names).

## MCP

The Model Context Protocol, an open standard that lets AI clients call tools. It is Tandem's
integration contract: Claude Code is the default and most-tested client, and any MCP-capable
client can connect. See [Integrations](integrations.md#the-mcp-integration-policy) and
[ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration).

## MCP server

The part of the Tandem server that AI clients connect to over HTTP, on this computer only. It
exposes the MCP tools and also serves the editor's `/api` routes. Each connected client gets its
own MCP session. See the [MCP tool reference](mcp-tools.md) and
[ADR-045](decisions.md#adr-045-mcp-transport-multiplexing--one-mcpserver-per-session-keyed-by-mcp-session-id).

## Tandem's Claude

A Claude Code session that Tandem starts and runs in the background to answer your chat and
comments. You can start or turn it off from the chat panel, and choose how it starts and whether
it stops when idle under Settings → AI Assistant. It is woken by the [supervisor](#supervisor),
so it needs no push setup. See [Tandem's Claude in chat](user-guide.md#tandems-claude-in-chat).

## Supervisor

The server component that launches Tandem's Claude and wakes it. When a chat message or annotation
event arrives, it writes a short turn telling Claude to check its inbox; the turn carries no
content, and Solo holds apply to it. A chat message can also start a stopped Tandem's Claude. See
[Auto-launched sessions](architecture.md#auto-launched-sessions-do-not-use-the-channel-1266) and
[A message starts a stopped Claude](architecture.md#a-message-starts-a-stopped-claude-2196).

## Wake watch

The self-armed push route for a Claude Code session you start yourself: Claude watches a wake
stream on the Tandem server with its built-in Monitor tool, and each frame tells it to check its
inbox. Frames carry no message content. See
[Real-time updates](../README.md#real-time-updates) and
[ADR-049](decisions.md#adr-049-the-self-armed-wake--ws-transport-no-arbitration-payload-free-frames).

Tandem's skill arms the watch automatically on the first Tandem response that carries the
wake-stream address: `tandem_open`, `tandem_scratchpad` or a read-mode `tandem_status`. Claude
Code ends a watch after at most 30 minutes, and the skill re-arms it.

It works only where Claude Code offers a Monitor tool. That tool is enabled per account, not per
version, and on Windows it also needs Git Bash; the stream answers only on this computer. Where
Claude Code offers no Monitor tool, the [channel shim](#channel-shim) is the fallback.

## Plugin monitor

A watcher shipped in Tandem's Claude Code plugin. It starts the first time Claude uses Tandem's
skill in a session, not before, so ask for Tandem by name. It shares the wake watch's per-account
Monitor gate but does not need Git Bash on Windows. Start `claude` from a terminal so it can find
Node. See [Plugin install](../README.md#plugin-install) and
[Plugin monitor](architecture.md#plugin-monitor).

## Channel shim

An optional relay (`tandem-channel`) that delivers Tandem events into a Claude Code session through
Claude Code's channels feature. It is opt-in: the setup wizard cannot register it; only
`tandem setup --apply --with-channel-shim` does, and Claude Code must also be started with the
channel flag each time, in an interactive session. It depends on no Monitor tool, which makes it
the fallback when the other routes are unavailable. See
[Real-time updates](../README.md#real-time-updates) and
[Why the channel is opt-in](architecture.md#why-tandem-channel-is-opt-in).

## Push and pull

Pull is the AI checking its [inbox](#inbox), and it is always authoritative. Push is any of the
four routes that wake an idle Claude: the [supervisor](#supervisor), the [wake watch](#wake-watch),
the [plugin monitor](#plugin-monitor) and the [channel shim](#channel-shim). Push is best-effort; a
wake can be dropped or rate-limited, so Claude keeps polling. In Solo mode only chat messages are
pushed. See [Real-time push](user-guide.md#real-time-push-recommended).

## Ships dark

Built, merged and tested, but switched off in release builds by a constant in the source, so users
cannot reach it. Docs that describe a dark feature describe the code, not something you can use
today, and turning one on follows its ADR's checklist. Five features ship dark:
[.docx support](#docx-support), [Cowork setup](#cowork-setup), the
[licensing gate](#licensing-gate), the [local-model collaborator](#local-model-collaborator) and
the [LAN bind](#lan-bind). Licensing and the local model are inert at runtime; the `.docx` and
Cowork switches still clean up after earlier versions. See [Status](../CLAUDE.md#status).

## .docx support

Opening and saving Word documents. It ships dark: a release refuses `.docx` files with a message,
and the `.docx`-only MCP tools are not offered. To work on a Word document, save a copy as plain
text or HTML from Word. See [Supported formats](user-guide.md#supported-formats) and
[ADR-053](decisions.md#adr-053-docx-ships-dark).

## Cowork setup

Tandem's setup for Cowork, Claude Desktop's local agent mode. It ships dark and Cowork is not part
of v1.0. What an earlier version wrote stays until you uninstall. See [Cowork](../README.md#cowork),
[data-locations](data-locations.md#if-you-enabled-cowork-in-an-earlier-version) and
[ADR-055](decisions.md#adr-055-cowork-setup-ships-dark).

## Licensing gate

The v1.0 one-time paid licence. Without a key, Tandem stays a fully editable editor and only the AI
features are refused, at the points where the AI connects. It ships dark: the public beta is free
for personal use and nothing is enforced. See [How licensing works](licensing-explained.md) and
[ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license).

## Local-model collaborator

Letting a local model (Ollama, LM Studio) act as the collaborator instead of Claude. It ships dark,
the Settings **Models** tab is hidden, and it is planned to switch on at v1.0. See
[ADR-039](decisions.md#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11) and the
[roadmap](roadmap.md#active--toward-v10).

## LAN bind

Letting the server listen beyond this computer. It ships dark: Tandem binds to the loopback address
only and refuses a non-loopback bind host. See [LAN exposure](configuration.md#lan-exposure),
[Network posture](security.md#network-posture) and
[ADR-056](decisions.md#adr-056-the-non-loopback-bind-ships-dark).

## Hocuspocus

The WebSocket server that keeps each open document in sync between the Tandem server and the
editor, one room per document. See
[ADR-002](decisions.md#adr-002-hocuspocus-for-yjs-websocket-hocuspocusprovider-on-the-client) and
[Container diagram](architecture.md#container-diagram).

## Y.Doc and CRDT

A CRDT (conflict-free replicated data type) lets several editors change the same data and merge
without locks. Tandem uses Yjs: each open document is one Y.Doc holding its content, annotations and
presence, and every change goes through the server's copy. See
[Shared state](architecture.md#shared-state-ydoc).

## Flat offsets

Character positions into a document's plain text, as the server and the MCP tools count them.
They include heading prefixes such as `## ` and the line breaks between blocks, and are counted in
UTF-16 code units. See [Coordinate systems](architecture.md#coordinate-systems) and
[Coordinate system](mcp-tools.md#coordinate-system).

## ProseMirror positions

The editor's own positions, which count node boundaries instead of characters and include no
heading prefixes. They stay inside the editor; the AI never sees them. See
[Coordinate systems](architecture.md#coordinate-systems).

## RelativePosition

A Yjs anchor tied to particular characters rather than to a number, so it keeps pointing at the
same text while others edit. An annotation keeps one beside its flat range, and
`anchoredRange()` creates the two together. See
[Yjs RelativePosition](architecture.md#yjs-relativeposition-crdt-anchored-ranges).

## Degraded anchor

An annotation whose anchor no longer matches the text it was made on, usually because that text was
edited or deleted. `tandem_getAnnotations` marks it `degraded` and reports the last range the server
trusted. See [Annotation tools](mcp-tools.md#annotation-tools) and the
[Y.js / CRDT gotchas](gotchas.md#yjs--crdt).

## Origin tags

A label on every change to a Y.Doc saying where it came from (the MCP tools, file sync, the browser
and so on), applied through helper functions. The label decides which changes become events for the
AI, which stops Tandem echoing the AI's own edits back to it. See
[Which helper to use](gotchas.md#origin-tagging--which-helper-to-use-critical-rule-2) and
[ADR-031](decisions.md#adr-031-origin-tagged-transaction-wrappers).

## CTRL_ROOM

A reserved sync room for app-wide state rather than for one document: the list of open documents,
the Solo/Tandem mode and the chat thread. It is never a valid document ID. See
[Multi-document rooms](architecture.md#ydoc-identity-and-multi-document-rooms) and
[ADR-048](decisions.md#adr-048-chat-stays-global-ctrl_room-scoped-not-document-scoped).

## App-data directory

The folder where Tandem keeps its own state: saved sessions, the durable annotation store, backups
taken before it overwrites a file, and integration and launcher settings. The desktop app and the
npm install use separate folders, and logs live elsewhere. Your documents stay where they are. See
[App data directory](data-locations.md#app-data-directory) and
[Configuration](configuration.md#app-data-directories).

## Auth token

A random secret Tandem generates so that callers from outside this computer must prove who they
are; callers on this computer do not need it. The desktop app keeps it in the OS keychain, the npm
install in a file, and `tandem rotate-token` replaces it. See [Auth tokens](security.md#auth-tokens)
and [Rotating the token](configuration.md#rotating-the-token).

## Reserved harness ports

Dedicated ports, defined in `scripts/test-ports.ts`, that the end-to-end and performance test runs
use instead of the product's own, so tests can run beside a live Tandem. Anything else holding them
is refused or stopped. See [Running E2E tests](../CONTRIBUTING.md#running-e2e-tests) and the
[Testing gotchas](gotchas.md#testing--e2e).

## ADR

Architecture Decision Record: a numbered entry in [decisions.md](decisions.md) recording a choice,
why it was made and what it rules out. A superseded ADR gets a dated amendment rather than a
rewrite. The [internals map](maps/internals.md) groups the key ones by topic.

## Claim tests

Tests under [`tests/docs/`](../tests/docs/) that read the documentation and fail when a sentence,
count or list in a doc stops matching the code, or when a claim already proven false comes back.
If one fails after a doc edit, it has flagged a pinned phrase. See the
[docs audit's method section](reviews/2026-10-20-docs-audit.md#2-method-and-scope).
