---
tags: [map, audience/user, audience/ai-setup]
aliases: [Connecting an AI, AI setup map, Push and wake map]
---

# Connecting an AI

How an AI client gets into Tandem, how it hears about your comments and chat, and what it can do
once connected. Back to the [docs hub](../README.md).

## Set it up

- [README → Install](../../README.md#install) answers "how do I connect Claude?" The setup wizard
  does the configuration; read this first.
- [README → Plugin install](../../README.md#plugin-install) answers "can I add Tandem to Claude
  Code as a plugin?" Read it if you prefer the marketplace route.
- [Integrations](../integrations.md) answers "which AI clients work, and how well?" Read it before
  connecting anything other than Claude.
- [User guide → Working with Claude Code](../user-guide.md#working-with-claude-code) walks through
  the connection from the editor's side.
- [CLI → `tandem setup`](../cli.md#tandem-setup) and [`tandem doctor`](../cli.md#tandem-doctor)
  cover the scripted setup and the self-check for npm installs.
- [Configuration → Binding and authentication](../configuration.md#binding-and-authentication)
  lists the environment variables for ports and tokens; most people never need it.

## Real-time updates and the inbox

Claude always learns what you did by checking its inbox (pull). Real-time routes only wake it
sooner (push), and none of them is the authority on what it sees.

- [README → Real-time updates](../../README.md#real-time-updates) answers "will Claude react on
  its own when I comment?" It compares the routes and says which to pick. Read this first.
- [User guide → Real-time push](../user-guide.md#real-time-push-recommended) and
  [Polling remains authoritative](../user-guide.md#polling-remains-authoritative) give the same
  picture from inside the editor.
- [Glossary → Wake watch](../glossary.md#wake-watch): the default route for a Claude Code session
  you start yourself. It works only where Claude Code offers a Monitor tool; where it doesn't, the
  [channel shim](../glossary.md#channel-shim) is the fallback.
- [Glossary → Plugin monitor](../glossary.md#plugin-monitor): starts the first time Claude uses
  Tandem's skill in a session.
- [Glossary → Supervisor](../glossary.md#supervisor): how sessions Tandem launches itself are
  woken, with no setup.
- [Architecture → Channel push](../architecture.md#channel-push-real-time-events),
  [Plugin monitor](../architecture.md#plugin-monitor) and
  [Why the channel is opt-in](../architecture.md#why-tandem-channel-is-opt-in) hold the mechanism,
  for contributors.
- [ADR-047](../decisions.md#adr-047-claude-code-push-transport-activation) and
  [ADR-049](../decisions.md#adr-049-the-self-armed-wake--ws-transport-no-arbitration-payload-free-frames)
  record why the routes are shaped this way.

## Solo and Tandem modes

- [User guide → Solo / Tandem mode](../user-guide.md#solo--tandem-mode) answers "what does Solo
  hold back, and from what?" Read it before relying on Solo for privacy.
- [README → Privacy and trust](../../README.md#privacy-and-trust) is the short version, with the
  privacy of notes.

## Tandem's Claude

- [User guide → Tandem's Claude in chat](../user-guide.md#tandems-claude-in-chat) answers "what is
  the Claude that Tandem runs for me, and how do I start or stop it?"
- [User guide → AI Assistant settings](../user-guide.md#ai-assistant-settings) covers how it starts
  and whether it stops when idle.
- [Architecture → Start mode and lifetime](../architecture.md#start-mode-and-lifetime-2195) is the
  contributor's view.

## What the AI can do

- [MCP tool reference](../mcp-tools.md) answers "what exactly can the AI call?" Start with
  [Response format](../mcp-tools.md#response-format) and [Error codes](../mcp-tools.md#error-codes),
  then the [document](../mcp-tools.md#document-tools), [annotation](../mcp-tools.md#annotation-tools),
  [navigation](../mcp-tools.md#navigation-tools) and [awareness](../mcp-tools.md#awareness-tools)
  tools. The [HTTP API](../mcp-tools.md#http-api) and
  [channel API](../mcp-tools.md#channel-api-real-time-push) sections serve non-Claude clients.
- [Integrations → MCP tools at a glance](../integrations.md#mcp-tools-at-a-glance) is the one-screen
  summary.
- [The shipped skill](../../skills/tandem/SKILL.md) is the instruction file installed into users'
  Claude Code sessions. Its [collaboration mode](../../skills/tandem/SKILL.md#collaboration-mode)
  and [getting woken while idle](../../skills/tandem/SKILL.md#getting-woken-while-idle) sections
  say how Claude is asked to behave.
- [Workflows](../workflows.md) shows real sessions with the tool calls in them.
- [ADR-038](../decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)
  is the MCP-first policy: Claude by default, any MCP client welcome.

## When it doesn't connect

- [Troubleshooting → Claude Code says MCP failed to connect](../troubleshooting.md#claude-code-says-mcp-failed-to-connect)
- [MCP shows connected but the tools fail](../troubleshooting.md#mcp-shows-connected-but-tandem-tools-fail)
- [Claude doesn't seem to know what Tandem is](../troubleshooting.md#claude-doesnt-seem-to-know-what-tandem-is)
- [I sent a message or left a comment and nothing happened](../troubleshooting.md#i-sent-a-chat-message-or-left-a-comment-and-nothing-happened):
  the real-time routes, step by step.
- [Tandem's Claude didn't say hello](../troubleshooting.md#tandems-claude-didnt-say-hello)
- [Tandem can't start Claude on Windows](../troubleshooting.md#tandem-cant-start-claude-on-windows-but-claude-works-in-a-terminal)
  and [Tandem says set up Claude Code, but it is installed](../troubleshooting.md#tandem-says-set-up-claude-code-but-claude-code-is-already-installed)
- [Plugin monitor reports exit 127](../troubleshooting.md#plugin-monitor-reports-script-failed-exit-127)
  and [the plugin install fails to clone](../troubleshooting.md#claude-plugin-install-fails-to-clone-ssh-vs-https)
- [The channel relay fails to start](../troubleshooting.md#channel-shim-fails-to-start)
- [Claude Desktop: failed to spawn process](../troubleshooting.md#failed-to-spawn-process-no-such-file-or-directory-claude-desktop)
- [Sharing diagnostics](../troubleshooting.md#sharing-diagnostics) when you need to ask for help.

## Related maps

[Using Tandem](using-tandem.md) · [Troubleshooting and your data](troubleshooting-and-data.md) ·
[Internals](internals.md) · [Glossary](../glossary.md)
