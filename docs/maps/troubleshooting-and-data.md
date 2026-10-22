---
tags: [map, audience/user]
aliases: [Troubleshooting and your data, Troubleshooting map, Data map]
---

# Troubleshooting and your data

What to do when something goes wrong, where Tandem keeps its files, how to remove them, and what
it sends anywhere. Back to the [docs hub](../README.md).

## When something goes wrong

- [Troubleshooting](../troubleshooting.md) answers "why isn't this working?" Start with its
  [quick diagnostic](../troubleshooting.md#quick-diagnostic), which runs the built-in checks.
- Common entries: [I sent a chat message or left a comment and nothing happened](../troubleshooting.md#i-sent-a-chat-message-or-left-a-comment-and-nothing-happened),
  [port already in use](../troubleshooting.md#port-already-in-use),
  [the editor lost its connection](../troubleshooting.md#editor-shows-server-unavailable-or-weve-lost-the-connection-to-the-tandem-server),
  [an empty editor](../troubleshooting.md#empty-editor-with-no-document),
  [a document will not open](../troubleshooting.md#a-document-will-not-open--a-tab-did-not-come-back),
  [double-clicking a file does nothing](../troubleshooting.md#double-clicking-a-file-does-nothing),
  [settings are read-only](../troubleshooting.md#settings-say-they-are-read-only) and
  [the Windows SmartScreen warning](../troubleshooting.md#windows-smartscreen-warning).
- [Recovering a previous version of a document](../troubleshooting.md#recovering-a-previous-version-of-a-document)
  answers "Tandem changed my file; can I get the old one back?"
- [Reset session state](../troubleshooting.md#reset-session-state),
  [Reading server logs](../troubleshooting.md#reading-server-logs) and
  [Sharing diagnostics](../troubleshooting.md#sharing-diagnostics) are the next steps when an entry
  doesn't fit.
- [User guide → Troubleshooting](../user-guide.md#troubleshooting) is a shorter, editor-side list.
- AI connection problems have their own list in [Connecting an AI](connecting-ai.md#when-it-doesnt-connect).

## Your data

- [Data locations](../data-locations.md) answers "where does Tandem keep things, and how do I
  remove all of it?" It covers the [app-data directory](../data-locations.md#app-data-directory),
  [logs](../data-locations.md#logs), the [OS keychain](../data-locations.md#os-keychain), the
  [entries Tandem writes into other programs' config](../data-locations.md#entries-tandem-writes-into-other-programs-config)
  and [uninstalling cleanly](../data-locations.md#uninstalling-cleanly).
- [Configuration](../configuration.md) answers "how do I move Tandem's data or change its ports?"
  See [app-data directories](../configuration.md#app-data-directories) and
  [rotating the token](../configuration.md#rotating-the-token).
- [CLI → uninstall scrub](../cli.md#tandem---uninstall-scrub) removes what an npm install wrote.

## Privacy and security, in brief

- [README → Privacy and trust](../../README.md#privacy-and-trust) is the user-level summary: your
  documents stay on disk, notes stay private, Solo holds your comments back, and there is no
  telemetry by default.
- [Security → Network posture](../security.md#network-posture) and
  [Privacy](../security.md#privacy) say what listens where and what leaves your machine.
- [Telemetry and crash reporting](../security.md#telemetry-none-by-default-crash-reporting-strictly-opt-in)
  explains the opt-in crash reporting.
- [Reporting security issues](../security.md#reporting-security-issues) says how to report one.
- The full model is in the [Security and licensing map](security-and-licensing.md).

## Related maps

[Using Tandem](using-tandem.md) · [Connecting an AI](connecting-ai.md) · [Glossary](../glossary.md)
