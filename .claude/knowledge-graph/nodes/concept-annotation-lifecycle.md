---
id: concept-annotation-lifecycle
type: concept
name: Annotation lifecycle
last_verified: 2026-05-18
sources:
  - src/server/annotations/
  - docs/decisions.md#adr-027-annotation-system-redesign--audience-based-model
---

# Annotation lifecycle

Annotations live in `Y.Map('annotations')` (governed by `rule-ymap-key-constants`), keyed by stable id. State machine: **pending → accepted | dismissed**. `tandem_editAnnotation` only works on pending; accepted/dismissed return an error.

Types (3): `highlight` (user-only, color-coded), `comment` (Claude-created, may include `suggestedText`), `note` (personal, **not surfaced to Claude** per ADR-027). The `directedAt` field is deprecated and stripped on read.

Authors (3): `"user"`, `"claude"`, `"import"` (Word comments from .docx files).

**ADR-027 privacy contract:** notes are user-private — Claude never reads them via MCP tools or channel events. The MCP read paths (`tandem_getAnnotations`, channel event filtering) strip note entries before responding.

Lifecycle module (`adr-035`) provides the canonical state transitions; durable-sync writes annotations to disk on a debounce. The durable-sync observer skips `file-sync` and `internal` origins (see `concept-origin-contract`).

Annotation ranges use `AnchoredRange` (flat offset + Y.RelativePosition); the Y.RelativePosition survives concurrent edits and is re-anchored after `reloadFromDisk`.
