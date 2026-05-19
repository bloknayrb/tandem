# Knowledge Graph (Pilot)

A small hand-curated graph of Tandem's **concepts, critical rules, and most-cited ADRs**. Built for Claude (me) to answer questions like "what governs writes to Y.Doc?" or "which rules apply when I touch coordinate-system code?" — the prose docs encode this implicitly; the graph makes it queryable.

**Status:** Pilot (started 2026-05-18).

**Kill criterion:** Review on **2026-06-01**. If I haven't run a query that surprised me in two weeks, delete this directory.

## Why this exists (and what was deliberately cut)

Two adversarial reviews of the original 150-node plan landed hard:

- **Maintenance decay > build time.** Tandem ships ~20 PRs/week. A large graph rots faster than it pays off. Stale graph is *worse* than no graph because structured data looks authoritative.
- **No query the graph wins that grep loses.** For most tasks (add MCP tool, fix a bug, refactor a function), `grep` is faster and authoritative. The one class of query grep loses: "what *constraints* govern a concept that spans multiple modules?" — e.g., the origin contract, coordinate-system rules.

The pilot keeps only the slice that survives that critique: **concept ⇄ rule ⇄ ADR**, no file-level or MCP-tool nodes (those are grep's job).

## Layout

- `nodes/<id>.md` — one file per node, YAML frontmatter + prose body
- `edges.json` — typed relationships between nodes
- `../../scripts/kg.mjs` — query CLI (`npm run kg neighbors <id>` etc.)
- `../../scripts/kg-lint.mjs` — validator (`npm run kg:lint`)

## Node schema (frontmatter)

```yaml
---
id: concept-y-doc           # kebab-case, stable
type: concept               # concept | rule | adr
name: Y.Doc                 # human-readable
last_verified: 2026-05-18   # bump when content is checked
sources:                    # file paths and doc anchors
  - src/server/yjs/
  - docs/architecture.md#y-map-observer-ownership
---
```

The body is prose — short summary in the first sentence, expert-targeted detail below.

## Edge types (7)

- `governs` — rule → concept it constrains
- `decided_by` — concept → ADR that decided its design
- `supersedes` — ADR → ADR it replaces (currently unused — add if I find verifiable cases)
- `implemented_in` — concept → file or symbol
- `refines` — child concept → parent concept
- `related` — bidirectional "see also"
- `enforced_by` — rule → hook / script / lint that enforces it

## Maintenance

- `npm run kg:lint` validates every `source:` path exists and every edge endpoint resolves
- Bump `last_verified` when you re-read a node's body and confirm it
- If a node's `last_verified` is more than 60 days old, lint warns (not fails)
- This is project memory for Claude, not user-facing docs — keep prose terse and current rather than comprehensive
