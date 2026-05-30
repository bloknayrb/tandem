# CHANGELOG Strategy — Design System Impl Umbrella

How sub-PRs into `feat/design-system-impl` interact with `CHANGELOG.md` while the umbrella is open, and how the final umbrella → master merge promotes the work into a release entry.

## Default: rollup section

While the umbrella branch is open, every sub-PR adds **one line** under a dedicated `### Changed` subsection inside `[Unreleased]`:

```markdown
## [Unreleased]

### Changed

- **Design system re-skin (umbrella `feat/design-system-impl`):**
  - TitleBar re-skinned to the bundle's visual language (#NNN, sub-PR 1.1)
  - FormatBar / Toolbar re-skinned (#NNN, sub-PR 1.2)
  - Editor + LeftRail re-skinned (#NNN, sub-PR 1.3)
  - …
```

Sub-PR ID format: `(#GH-pr-number, sub-PR <plan-section>)`. The plan section comes from the plan's sub-PR table (1.1, 1.2, … 3.10), so anyone reading the CHANGELOG can cross-reference back to the rationale + bundle source.

Visual-only sub-PRs share the umbrella rollup bullet — they do NOT get their own top-level `### Changed` entry. The rollup is the contract; nesting reads cleanly in the final release notes.

## Behavior changes get their own entry

If a sub-PR introduces user-visible behavior beyond pure visual updates (different keyboard handling, new affordance, removed control, changed default), it gets its own top-level entry under the appropriate Keep-a-Changelog section (`Added` / `Changed` / `Removed` / `Fixed`) **in addition** to the rollup bullet. The standalone entry describes the behavior; the rollup bullet records the surface re-skin. Two entries, not one.

Example: if Sub-PR 1.6 (CommandPalette re-skin) also adds a new query-prefix routing rule, it adds:
- A rollup bullet under "Design system re-skin": "CommandPalette re-skinned (#NNN, sub-PR 1.6)"
- A standalone `### Added` entry: "**CommandPalette: `\\` prefix routes to documentation (#NNN)** — new fourth-prefix branch alongside `#/@/?/>`…"

## Conflict overrides get a note

If a sub-PR uses the conflict-resolution override protocol from `conflicts-resolved.md`, it adds an italic note to its rollup bullet:

```markdown
- TitleBar re-skinned (#NNN, sub-PR 1.1) — _conflict #1 override: bundle component replaced production wholesale; Tauri integration re-wired on top per reviewer agreement._
```

This keeps the override visible in release notes for anyone tracing back why the architecture diverged from the plan.

## Final merge promotion

When the umbrella merges to master, the rollup section gets promoted into the version entry:

1. The `### Changed` "Design system re-skin" subsection moves verbatim into the new version block (e.g. `## [0.14.0] - 2026-MM-DD`), no rewrite required.
2. Standalone behavior-change entries promote to their existing top-level sections (Added/Changed/Removed/Fixed) within that version block.
3. A version-level summary line goes above the rollup: e.g. "**App-wide visual re-skin from the Tandem Design System (1) bundle.** Every shipped surface re-styled to the bundle's tokens, type, motion, and chrome. See sub-PR list below for surface-level granularity."

## Token + manifest changes

- Phase 0 commits (token audit, testid manifest, tutorial-anchor manifest, derived-spec, conflicts-resolved, this doc, perf-baseline) are infrastructure for the umbrella; they do NOT add CHANGELOG entries individually. The umbrella merge gets a single "**Design system re-skin infrastructure (docs/design-system-impl/, CI gates, snapshot baselines)**" bullet covering all of Phase 0.
- Token additions from Phase 0c that any sub-PR actually consumes get a one-line note in that sub-PR's bullet (e.g. "uses new `--tandem-density-compact` token from bundle").
- The CI token blocklist extension to `scripts/check-semantic-tokens.ts` gets a single `### Changed` bullet at umbrella merge: "**`check-semantic-tokens.ts` enforces bundle-origin color blocklist** — extends the existing CI gate."

## Phase 4 / motion follow-up

The motion-language work is explicitly out of scope for this umbrella (Conflict #9, Phase 0k). Its follow-up PR series gets its own CHANGELOG entries when that work lands, not this one.

## Tooling

No script automation for the rollup — it's hand-maintained. Every sub-PR PR description should include a "CHANGELOG entry added under `[Unreleased] → ### Changed → Design system re-skin`" line under verification so reviewers can confirm at a glance.
