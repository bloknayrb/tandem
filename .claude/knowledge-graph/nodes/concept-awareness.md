---
id: concept-awareness
type: concept
name: Awareness (presence + dwell)
last_verified: 2026-05-18
sources:
  - src/server/mcp/awareness.ts
  - src/client/cowork/
  - src/shared/constants.ts
---

# Awareness

User presence + selection state stored in per-document `Y.Map(awareness)`. Drives the cowork sidebar, paragraph-focus indicators, and selection-event channel pushes.

**Dwell-time gating:** selection events only fire after the user holds a selection steady for the configured dwell time (default 1s). This prevents firehose-spam on every cursor move and is what makes the channel push tractable for Claude to react to.

Awareness writes are `browser`-origin, so they generate channel events (see `concept-channel-events`).

The Claude focus paragraph indicator (gutter decoration in `awareness.ts`) uses `--tandem-claude-focus-bg` / `--tandem-claude-focus-border`, derived from `--tandem-author-claude` via `color-mix` — Claude's "current paragraph" while editing.
