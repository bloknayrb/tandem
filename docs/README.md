# Tandem documentation

Tandem is an editor where you and an AI work on the same document at the same time: the AI reads
what you highlight, leaves comments and suggestions beside the text, and chats with you, while
your files stay on your own disk. These docs are laid out like a wiki. The pages under `docs/` are
the notes, the **maps** below group them by what you are trying to do, and the
[glossary](glossary.md) defines the terms they share. Most pages describe Tandem as it is now;
dated plans, reviews and spikes are kept as history and say so at the top.

## Start here

**I want to use Tandem.** Read the [README](../README.md#install) to install it, then the
[user guide](user-guide.md). The [Using Tandem map](maps/using-tandem.md) lists everything else:
workflows, settings, the command line.

**I'm connecting an AI.** The [Connecting an AI map](maps/connecting-ai.md) covers the setup
routes, how Claude hears about your comments and chat in real time, Solo and Tandem modes, and the
MCP tool reference.

**Something's wrong.** Start with [troubleshooting](troubleshooting.md). The
[Troubleshooting and your data map](maps/troubleshooting-and-data.md) adds where Tandem keeps
its files, how to remove them, and what it sends anywhere.

**I'm contributing code.** Read [CONTRIBUTING](../CONTRIBUTING.md), then the
[Contributing map](maps/contributing.md) for the rules that fail silently, the design system and
the review tooling. The [Internals map](maps/internals.md) explains how the pieces fit together.

**I maintain or release Tandem.** The [Releases and operations map](maps/releases-and-ops.md)
holds the release checklist, signing runbook, gate results and roadmap. The
[Security and licensing map](maps/security-and-licensing.md) holds the security model and the
licence system.

**I want the history and decisions.** The [decision records](decisions.md) explain why things are
the way they are; the [Internals map](maps/internals.md#decisions-by-topic) groups them by topic.
The [History map](maps/history.md) indexes the dated plans, reviews, spikes and design records.

## Maps

| Map | For |
|---|---|
| [Using Tandem](maps/using-tandem.md) | People writing and reviewing documents |
| [Connecting an AI](maps/connecting-ai.md) | Setting up Claude Code, Claude Desktop or another MCP client, and real-time updates |
| [Troubleshooting and your data](maps/troubleshooting-and-data.md) | Fixing problems, finding and removing Tandem's files, privacy |
| [Contributing](maps/contributing.md) | Working on the code: setup, rules, design system, review agents |
| [Internals](maps/internals.md) | Architecture, data flows, coordinate systems, decisions by topic |
| [Security and licensing](maps/security-and-licensing.md) | The security model and the v1.0 licence system |
| [Releases and operations](maps/releases-and-ops.md) | Cutting and checking a release, gates, roadmap |
| [History](maps/history.md) | Dated plans, reviews, spikes and design records |
| [Glossary](glossary.md) | Every term above, in plain language |

Several features are built but switched off in releases. The docs call this "ships dark"; the
[glossary](glossary.md#ships-dark) lists them, and no map presents one as available.

## Reading these docs in Obsidian

Open the repository root (the folder holding `README.md` and `docs/`) as an Obsidian vault. The
links are ordinary relative Markdown links, so they work in Obsidian, on GitHub and in any editor;
there are no wikilinks to convert. The maps, the glossary and the two index pages carry `tags` and
`aliases` in their frontmatter, so Obsidian's tag pane and quick switcher find them by name. This
page has no frontmatter because GitHub would render it as a table at the top.
