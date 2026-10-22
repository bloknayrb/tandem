---
tags: [map, audience/contributor]
aliases: [Internals, Architecture map, How Tandem works]
---

# Internals

How Tandem is put together: the layers, the data flows, the three coordinate systems, and the
decisions behind them. Back to the [docs hub](../README.md).

## Architecture

- [Architecture](../architecture.md) answers "how do the pieces fit?" Read it before changing
  anything that crosses the editor, the server and the AI. Useful sections:
  - [System context](../architecture.md#system-context) and
    [container diagram](../architecture.md#container-diagram): the three layers.
  - [Data flows](../architecture.md#data-flows), including
    [annotation writes](../architecture.md#annotation-writes-three-surfaces-one-guarded-seam) and
    the [chat data flow](../architecture.md#chat-data-flow).
  - [Channel push](../architecture.md#channel-push-real-time-events),
    [origin tagging](../architecture.md#origin-tagging-echo-prevention) and the
    [plugin monitor](../architecture.md#plugin-monitor): how events reach the AI.
  - [Shared state (Y.Doc)](../architecture.md#shared-state-ydoc) and
    [multi-document rooms](../architecture.md#ydoc-identity-and-multi-document-rooms).
  - [Tauri desktop layer](../architecture.md#tauri-desktop-layer): the sidecar, tray, updater and
    origin handling.
  - [File map](../architecture.md#file-map): where each part of the code lives.
- Rendered diagrams, each a page plus the JSON it was drawn from:
  [system architecture](../architecture-diagrams/system-architecture.html)
  ([JSON](../architecture-diagrams/system-architecture.json)),
  [annotation lifecycle](../architecture-diagrams/annotation-lifecycle.html)
  ([JSON](../architecture-diagrams/annotation-lifecycle.json)),
  [coordinate systems](../architecture-diagrams/coordinate-systems.html)
  ([JSON](../architecture-diagrams/coordinate-systems.json)) and
  [Tauri desktop](../architecture-diagrams/tauri-desktop.html)
  ([JSON](../architecture-diagrams/tauri-desktop.json)).

## The three coordinate systems

Positions in a document are counted three ways, and mixing them up is a silent bug.

- [Flat offsets](../glossary.md#flat-offsets): what the server and the MCP tools use.
- [ProseMirror positions](../glossary.md#prosemirror-positions): what the editor uses.
- [RelativePositions](../glossary.md#relativeposition): CRDT anchors that survive concurrent edits.
- [Architecture → Coordinate systems](../architecture.md#coordinate-systems) has a worked example
  and the position-module APIs; [MCP tools → Coordinate system](../mcp-tools.md#coordinate-system)
  is the tool-facing summary; [Y.js / CRDT gotchas](../gotchas.md#yjs--crdt) lists the traps.

## The MCP surface

- [MCP tool reference](../mcp-tools.md) answers "what does each tool take and return?" It also
  documents the [HTTP API](../mcp-tools.md#http-api), the
  [channel API](../mcp-tools.md#channel-api-real-time-push) and the
  [Claude Code runtime contract](../mcp-tools.md#claude-code-cli-runtime-contract).
- [Integrations](../integrations.md) is the client compatibility table.

## Decisions by topic

Every ADR lives in [decisions.md](../decisions.md). Grouped by what they govern:

- **Editor and sync:** [ADR-001](../decisions.md#adr-001-tiptap-over-prosemirror-direct) Tiptap,
  [ADR-002](../decisions.md#adr-002-hocuspocus-for-yjs-websocket-hocuspocusprovider-on-the-client) Hocuspocus,
  [ADR-009](../decisions.md#adr-009-two-pass-ydoc-loading-for-correct-inline-mark-ordering) Y.Doc loading,
  [ADR-033](../decisions.md#adr-033-document-registry-and-named-hocuspocus-lifecycle-interface) document registry,
  [ADR-034](../decisions.md#adr-034-file-open-pipeline-with-named-entry-points-and-shared-core) file-open pipeline,
  [ADR-036](../decisions.md#adr-036-format-adapter-as-capability-set) format adapters,
  [ADR-042](../decisions.md#adr-042-markdown-fidelity--raw-construct-passthrough--visibility-toggle) Markdown fidelity.
- **Positions:** [ADR-005](../decisions.md#adr-005-node-anchored-ranges-for-overlays),
  [ADR-018](../decisions.md#adr-018-unified-position-modules-issue-68),
  [ADR-021](../decisions.md#adr-021-extracttext-for-tandem_gettextcontent-issue-148),
  [ADR-032](../decisions.md#adr-032-position-module-results-as-tagged-variants).
- **Annotations:** [ADR-007](../decisions.md#adr-007-ymap-for-annotations) storage,
  [ADR-022](../decisions.md#adr-022-unified-annotation-types--5-to-3-issues-193-245) the three types,
  [ADR-027](../decisions.md#adr-027-annotation-system-redesign--audience-based-model) the audience model and private notes,
  [ADR-035](../decisions.md#adr-035-annotation-lifecycle-module) the lifecycle module.
- **Origin tagging:** [ADR-031](../decisions.md#adr-031-origin-tagged-transaction-wrappers), with the
  [which-helper table](../gotchas.md#origin-tagging--which-helper-to-use-critical-rule-2).
- **MCP-first integration:** [ADR-003](../decisions.md#adr-003-mcp-over-rest-for-claude-integration),
  [ADR-038](../decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) the policy,
  [ADR-008](../decisions.md#adr-008-shared-mcp-response-helpers),
  [ADR-010](../decisions.md#adr-010-docidfrompath-for-multi-document-room-names) and
  [ADR-011](../decisions.md#adr-011-optional-documentid-on-all-mcp-tools) document IDs,
  [ADR-024](../decisions.md#adr-024-bearer_methods_supported-is-advisory-metadata-claude-code-ignores-it-phase-2-spike).
- **Transport and multi-session:** [ADR-012](../decisions.md#adr-012-streamable-http-transport-replacing-stdio) HTTP transport,
  [ADR-045](../decisions.md#adr-045-mcp-transport-multiplexing--one-mcpserver-per-session-keyed-by-mcp-session-id) one MCP server per client session.
- **Push, wake and chat:** [ADR-019](../decisions.md#adr-019-channel-shim-for-push-notifications-issue-106--claude-default-integration) channel shim,
  [ADR-020](../decisions.md#adr-020-sse-for-ephemeral-toast-notifications-issue-101) toasts over SSE,
  [ADR-028](../decisions.md#adr-028-plugin-monitor-url-and-auth-resolution--userconfig-over-hardcoded-default) plugin monitor,
  [ADR-047](../decisions.md#adr-047-claude-code-push-transport-activation) push activation,
  [ADR-049](../decisions.md#adr-049-the-self-armed-wake--ws-transport-no-arbitration-payload-free-frames) the self-armed wake,
  [ADR-013](../decisions.md#adr-013-chat-persistence-via-json-files-not-crdt) and
  [ADR-048](../decisions.md#adr-048-chat-stays-global-ctrl_room-scoped-not-document-scoped) chat.
- **Security:** [ADR-050](../decisions.md#adr-050-api-is-loopback-only-for-non-get-enforced-at-the-mount)
  loopback-only mutations, [ADR-030](../decisions.md#adr-030-windows-code-signing-via-azure-trusted-signing--oidc) Windows signing.
- **Dark gates:** [ADR-040](../decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license) licensing,
  [ADR-039](../decisions.md#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11) local models,
  [ADR-053](../decisions.md#adr-053-docx-ships-dark) `.docx`,
  [ADR-055](../decisions.md#adr-055-cowork-setup-ships-dark) Cowork setup,
  [ADR-056](../decisions.md#adr-056-the-non-loopback-bind-ships-dark) the LAN bind. Earlier `.docx`
  and Cowork records: [ADR-004](../decisions.md#adr-004-docx-review-only-by-default),
  [ADR-052](../decisions.md#adr-052-superdoc-replaces-the-docx-readwrite-pipeline-server-side-behind-the-existing-editor) (shelved),
  [ADR-023](../decisions.md#adr-023-cowork-plugin-bridge--stdio-via-npx-not-http-prs-301-304--claude-default-integration),
  [ADR-044](../decisions.md#adr-044-cowork-detection--dual-scan-roots-shape-guard-write-time-revalidation-background-heal).
- **Desktop app:** [ADR-043](../decisions.md#adr-043-updater--no-rollback-no-in-updater-post-restart-health-probe-v1) updater,
  [ADR-046](../decisions.md#adr-046-start-at-login--desktop-only-hidden-boot-deferred-ai-launch) start-at-login.
- **Client UI:** [ADR-025](../decisions.md#adr-025-svelte-5-migration-decision-probe-312) Svelte 5,
  [ADR-026](../decisions.md#adr-026-redesign-gap-audit-decisions-439) redesign gaps,
  [ADR-029](../decisions.md#adr-029-action-registry-and-command-palette) command palette,
  [ADR-037](../decisions.md#adr-037-layout-model--rune-store-layered-over-settings) layout model,
  [ADR-041](../decisions.md#adr-041-customizable-keyboard-shortcuts-override-layer) shortcuts.
- **Build, storage and tests:** [ADR-006](../decisions.md#adr-006-consoleerror-for-server-logs) logging,
  [ADR-014](../decisions.md#adr-014-cross-platform-session-paths-via-env-paths) session paths,
  [ADR-015](../decisions.md#adr-015-tsup-for-server-bundling) bundling,
  [ADR-016](../decisions.md#adr-016-http-api-for-browser-file-opening) browser file opening,
  [ADR-017](../decisions.md#adr-017-playwright-e2e-tests-with-mcp-sdk-client) E2E tests,
  [ADR-051](../decisions.md#adr-051-an-advisory-ci-jobs-guarantees-are-enforced-by-a-wiring-test-inside-check) advisory CI jobs.

## Related maps

[Contributing](contributing.md) · [Connecting an AI](connecting-ai.md) ·
[Security and licensing](security-and-licensing.md) · [History](history.md) ·
[Glossary](../glossary.md)
