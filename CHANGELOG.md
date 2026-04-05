# Changelog

All notable changes to Tandem will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.7] - 2026-04-05

### Fixed

- Force-reload (`tandem_open` with `force: true`) now clears Y.Doc in-place instead of destroying the Hocuspocus room — sidebar, observers, and connections survive
- TOCTOU fix: session deletion moved after successful reload transaction
- Observer ownership table corrected in architecture docs

### Added

- 4 new tests for force-reload (annotation clearing, awareness clearing, .txt reload, metadata)
- Changelog opens as active tab on first startup after an npm update

## [0.2.6] - 2026-04-05

### Fixed

- Demo script rewritten to be self-referential for recording
- Observer ownership documentation added to architecture.md

## [0.2.5] - 2026-04-05

### Fixed

- `tandem setup` Claude Code MCP config path updated

## [0.2.4] - 2026-04-05

### Fixed

- Security audit findings (DNS rebinding, CORS, input validation)

## [0.2.3] - 2026-04-05

### Fixed

- `tandem setup` now writes Claude Code MCP config to `~/.claude.json` instead of `~/.claude/mcp_settings.json`, which Claude Code no longer reads

## [0.2.2] - 2025-04-05

### Fixed

- Silent failure review findings

## [0.2.1] - 2025-04-05

### Fixed

- Full security audit — 25 findings across 7 categories (#172)

## [0.2.0] - 2025-04-04

### Added

- Initial public release on npm as `tandem-editor`
- 30 MCP tools for collaborative document editing
- Multi-document tabs with CRDT-anchored annotations
- Chat sidebar with real-time channel push
- Support for .md, .docx, .txt, .html files
- `tandem` CLI with `setup` and `start` commands
- Claude Code skill auto-installation
