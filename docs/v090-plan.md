# Roadmap Gap Remediation — v0.9.0 Preparation

## Context

v0.8.0 shipped 2026-04-26. The roadmap (`docs/roadmap.md`) has stale text from items that shipped ahead of schedule or were closed without updating the doc. All v0.9.0 scope items remain unimplemented. This plan reconciles the roadmap with reality, then sequences the v0.9.0 work.

The current branch (`fix/audit-findings-batch`, 5 commits) has legitimate hardening fixes that should merge to master first, giving us a clean baseline.

**Plan reviewed by 3 independent agents.** Corrections applied: PR 5 event types already done, highlight palette migration added, doc scope expanded, panel-layout.ts gap fixed, accentHue clamping specified, test file list completed.

---

## What's Stale (Needs Roadmap Update)

| Area | Problem |
|------|---------|
| PR e (#370) | Roadmap says "targeting v0.9.0" — actually merged 2026-04-26 in v0.8.0 |
| PR f (#371) | Roadmap says "merge timing depends on Svelte probe" — merged 2026-04-26 |
| #434 (NSIS kill) | Roadmap says bundled in v0.8.0 re-release — GH issue still open |
| #436 (PREUNINSTALL) | Roadmap says included in PR e — GH issue still open |
| #439 (redesign audit) | ADR-026 completed — GH issue still open |
| v0.9.0 scope line | Lists "PR e (includes #436)" which already shipped; missing #440–#445 |
| Phase 5 (prop-drilling) | Conditional on Phase 4 results — never evaluated. ADR-025 Svelte Go supersedes it. |
| #341 (event unions) | Discriminated union already exists in `src/shared/events/types.ts` (8 variants, not 7 as roadmap implies). Branded coordinate types already exist in `src/shared/positions/types.ts`. Remaining #341 work is only the CI smoke test. |

---

## What's Unfinished (v0.9.0 Items — None Started)

### Blockers
- **#440** — `heldInSolo` field on `AnnotationBase` (`src/shared/types.ts:71`, no field exists yet)
- **#441** — `/api/info` endpoint (prerequisite for #435; no route exists in `src/server/mcp/routes/`)

### Redesign Data Model (#439/ADR-026)
- **#442** — 7 new `TandemSettings` fields + `showAuthorship` default `false` → `true` (per GH issue body, which enumerates exactly 7 fields; roadmap says "8" counting the default flip)
- **#443** — Authorship decorations: CSS classes → `data-tandem-author` attributes (current: `src/client/editor/extensions/authorship.ts:61`, CSS in `src/client/editor/editor.css:64-66`)
- **#444** — Editor width minimum 50% → 40% (two clamp sites in `useTandemSettings.ts:83,127` + slider `min={50}` in `EditorSettings.tsx:24`)
- **#445** — `tabbed-left` layout variant (needs: `LayoutMode` type, `PanelLayout` union in `panel-layout.ts:13-15`, `App.tsx:184-201` init + transition)

### Highlight Palette Migration (ADR-026)
- **Not tracked as an issue yet.** ADR-026 says palette switches from 5 colors to 4: yellow/green/blue/pink. Current `HighlightColorSchema` in `src/shared/types.ts:19` is `z.enum(["yellow", "red", "green", "blue", "purple"])`. Removing `red` and `purple` is a **data-loss risk** — existing annotations with those colors will fail Zod validation in `migrateToV1()`. Needs migration logic mapping `red` → closest (pink? yellow?) and `purple` → closest (blue? pink?). **File a GH issue before implementation.**

### MCP Tool Consolidation (#259) — CRITICAL: Last Breaking Window
- Deprecate `tandem_suggest` (error stub + updated description string)
- Hard-remove `tandem_getContent` and `tandem_getSelections`
- Merge `tandem_setStatus` into `tandem_status` (read/write with optional params)
- Update **all** docs and skill files referencing removed tools (see full list under PR 4)
- Net result: ~28 tools (down from 31)

### UX Polish
- **#435** — Version indicator in UI (depends on #441)
- **#437** — "View Changelog" button in Settings panel

### Distribution
- **#316** — macOS/Linux Cowork auto-setup
- **#317** — OS-specific firewall rules (macOS/Linux)
- **#322** — Network-type detection for Cowork

### Remaining from #341
- ADR-023 CI smoke test (event type work is already complete)

---

## Implementation Sequence

### Pre-work: Merge `fix/audit-findings-batch` to master
The 5 commits (checkpoint fix, decoration sync race, fatal diagnostics, roadmap docs, event-bridge hardening) are ready. Merge first for a clean baseline.

### PR 1: Roadmap Reconciliation (docs only)
- **Branch from:** master (post-merge)
- **Scope:** Fix all stale text listed above. Mark Phase 5 as SKIPPED (Svelte Go supersedes). Update v0.9.0 scope line to include #440–#445, remove already-shipped PR e, note #341 event types are done. Correct the "7 event types" count to 8 throughout the roadmap.
- **Closes:** #434, #436, #439
- **Files:** `docs/roadmap.md`
- **Effort:** ~30 min

### Wave 2 — All parallel, all branch from master after PR 1

#### PR 2: Schema Foundations (#440 + #442 + #444 + highlight palette)
- Add `heldInSolo?: boolean` to `AnnotationBase` in `src/shared/types.ts:71`
- Add 7 new fields to `TandemSettings` interface + `DEFAULTS` in `src/client/hooks/useTandemSettings.ts`:
  - `accentHue: number` (default 239)
  - `editorFont: "serif" | "sans" | "mono"` (default `"sans"`)
  - `density: "compact" | "cozy" | "spacious"` (default `"cozy"`)
  - `defaultMode: "solo" | "tandem"` (default `"tandem"`)
  - `highContrast: boolean` (default `false`)
  - `annotationPatterns: boolean` (default `false`)
  - `selectionToolbar: boolean` (default `true`)
- Change `showAuthorship` default from `false` to `true`. **Migration decision:** accept that all upgrading users get authorship on. This is intentional per ADR-026 — authorship is a core feature. No version-gating needed.
- Change `editorWidthPercent` clamp in **both** locations:
  - `loadSettings()` at line 83: `Math.max(50, ...)` → `Math.max(40, ...)`
  - `mergeAndClampSettings()` at line 127: `Math.max(50, ...)` → `Math.max(40, ...)`
- Update slider `min={50}` → `min={40}` in `src/client/components/EditorSettings.tsx:24`
- Extend `LayoutMode` to `"tabbed" | "three-panel" | "tabbed-left"` (type only — render logic in PR 7)
- Add parsing branches in `loadSettings()` for each new field:
  - Boolean fields: `=== true` guard
  - Enum fields: membership check against allowed values (e.g., `["serif", "sans", "mono"].includes(x)`)
  - `accentHue`: **Use explicit range check `(typeof x === 'number' && x >= 0 && x <= 360)`, NOT the falsy-0 idiom.** Hue 0 (red) is valid. The existing `Number(x) || DEFAULT` pattern must NOT be used for `accentHue`.
- Add `accentHue` clamping to `mergeAndClampSettings()`: `Math.max(0, Math.min(360, merged.accentHue))`
- **Highlight palette migration:** Update `HighlightColorSchema` from `["yellow", "red", "green", "blue", "purple"]` to `["yellow", "green", "blue", "pink"]`. Add migration in `migrateToV1()` (or annotation load path): `red` → `yellow`, `purple` → `blue`. **File GH issue first** for the palette change. Update the skill file `skills/tandem/SKILL.md:41` which lists all 5 colors.
- Update unit tests in `tests/client/useTandemSettings.test.ts`:
  - `BASE` fixture (line 256): change `showAuthorship: false` → `true`
  - Clamp tests (lines 131-134, 267-269): change expected minimum from 50 to 40
  - Add test: `accentHue: 0` is preserved (not reverted to default)
  - Add test: `loadSettings()` parses `"tabbed-left"` as valid layout
  - Add test for each new field: valid value, invalid/unknown value, absent value
- **No UI rendering changes** — settings UI deferred to Svelte (v0.10.0+)
- **Closes:** #440, #442, #444 (clamp + slider)
- **Key files:** `src/shared/types.ts`, `src/client/hooks/useTandemSettings.ts`, `src/client/components/EditorSettings.tsx`, `skills/tandem/SKILL.md` (color list), `tests/client/useTandemSettings.test.ts`
- **Effort:** ~1 day

#### PR 3: `/api/info` Endpoint (#441)
- New route `src/server/mcp/routes/info.ts`
- Return: app version (`APP_VERSION` from `src/server/mcp/server.ts:25-34`), tool count, data directory path (env-paths), platform, token last-rotated timestamp
- Register in `src/server/mcp/api-routes.ts` (existing pattern: `registerApiRoutes()` at line 92)
- Add unit tests
- **Closes:** #441
- **Key files:** `src/server/mcp/routes/info.ts` (new), `src/server/mcp/api-routes.ts`
- **Effort:** ~0.5 day

#### PR 4: MCP Tool Consolidation (#259) — HIGHEST PRIORITY
This is the last breaking-change window before semver lock. If it slips, removals wait until v2.0.

**Tool changes:**
- **`tandem_suggest`** (`src/server/mcp/annotations.ts:379-417`): Replace functional body with error stub returning `{ error: "DEPRECATED", replacement: "tandem_comment" }`. **Also update the tool's `description` string** in the registration to say "DEPRECATED — use tandem_comment with suggestedText instead" so `tools/list` responses reflect the state for cached Claude sessions.
- **`tandem_getContent`** (`src/server/mcp/document.ts:217-231`): Hard-remove.
- **`tandem_getSelections`** (`src/server/mcp/awareness.ts:29-57`): Hard-remove.
- **`tandem_setStatus`** (`src/server/mcp/navigation.ts:151-192`): Merge into `tandem_status` (`src/server/mcp/document.ts:507-535` — note: different file). Add optional params `text?: string`, `focusParagraph?: number`, `focusOffset?: number`, `documentId?: string`. When `text` is provided, write to awareness map (current setStatus logic). When omitted, read-only (current status logic). Update the merged tool's description to clearly document both modes. Delete `tandem_setStatus` from `navigation.ts`.

**Test updates (same PR — grep confirmed all references):**
- `tests/server/document-tools.test.ts` (line 42: `tandem_getContent`)
- `tests/server/awareness-tools.test.ts` (lines 280, 348: `tandem_setStatus`, `tandem_getSelections`)
- `tests/server/annotation-tools.test.ts` (line 58: `tandem_suggest`)
- `tests/server/mcp-tool-integration.test.ts` (lines 189, 193: `tandem_setStatus`)
- `tests/server/edit-annotation.test.ts` (references `tandem_suggest`)
- `tests/e2e/annotation-lifecycle.spec.ts` (line 106: `tandem_suggest`)
- `scripts/screenshots/capture.spec.ts` (references `tandem_suggest`, `tandem_setStatus`)

**Documentation updates (same PR — every file that references removed tools):**
- `CLAUDE.md`: Update "31 MCP tools" → "28 MCP tools" (appears in docs link line and Status section). Remove `tandem_suggest` from Key Patterns line 60.
- `README.md`: Update "31 MCP tools" count.
- `docs/mcp-tools.md`: Remove `tandem_getContent` section (line 102), `tandem_getSelections` section (line 780). Update `tandem_suggest` section (line 420) to deprecation notice. Replace `tandem_setStatus` section (line 733) with merged `tandem_status` write-mode docs. Update tool count (line 3).
- `docs/workflows.md`: Update `tandem_setStatus` references (lines 88, 120, 195) to `tandem_status`.
- `docs/architecture.md`: Update `tandem_setStatus` example (line 121) to `tandem_status`.
- `skills/tandem/SKILL.md`: **Critical — this is the Claude Code auto-loaded skill.** Update hard rules (line 18: remove `tandem_suggest`), workflow (line 30: `tandem_setStatus` → `tandem_status`), annotation guide (line 43: `tandem_suggest` → `tandem_comment` with `suggestedText`), collaboration etiquette (line 62: `tandem_setStatus` → `tandem_status`).
- `src/server/mcp/launcher.ts` (line 17): Update system prompt string that references `tandem_suggest`.
- `docs/decisions.md`: Leave as-is (historical ADR record, not operational).
- `docs/superpowers/specs/`: Leave as-is (historical design specs, not auto-loaded).

- **Closes:** #259
- **Key files:** `src/server/mcp/annotations.ts`, `src/server/mcp/document.ts`, `src/server/mcp/awareness.ts`, `src/server/mcp/navigation.ts`, `skills/tandem/SKILL.md`, `CLAUDE.md`, `README.md`, `docs/mcp-tools.md`, `docs/workflows.md`, `docs/architecture.md`, `src/server/mcp/launcher.ts`
- **Effort:** ~2 days (tool changes straightforward; doc + test updates are the bulk)

#### PR 5: ADR-023 CI Smoke Test
- **Note:** #341 discriminated event unions are **already complete** in `src/shared/events/types.ts` — fully typed union with 8 variants, parse guard, format helpers, exhaustive switch. No type work needed.
- **Remaining work:** Add CI step to `.github/workflows/ci.yml` that validates the Cowork stdio bridge (e.g., `npm run build && node dist/server/index.js --health-check` or a quick roundtrip test).
- Update roadmap to mark #341 event types as done, CI smoke test as the residual.
- **Closes:** #341
- **Effort:** ~0.5 day

#### PR 6: Cowork Cross-Platform (#316, #317, #322)
- #316: macOS/Linux Cowork auto-setup in `src/cli/setup.ts` + Tauri `run_setup()`
- #317: OS-specific firewall scoping (macOS `pfctl`, Linux `ufw`). Must be idempotent — rerunning setup shouldn't duplicate rules. Must handle privilege escalation gracefully (prompt, not crash). Must surface errors clearly to user.
- #322: Network-type detection for Cowork mode safety warnings
- **Pre-check:** Verify #433 (TOCTOU hardening) does not apply to the new macOS/Linux code paths. If the same race exists, either fix it in this PR or document why it doesn't apply.
- **Closes:** #316, #317, #322
- **Effort:** ~2–3 days

### Wave 3 — Depends on Wave 2

#### PR 7: Authorship Attributes + tabbed-left Layout (#443 + #445)
- **Depends on:** PR 2 (needs extended `LayoutMode` type)
- **#443:** In `src/client/editor/extensions/authorship.ts:61`, change:
  - From: `class: \`tandem-authorship tandem-authorship--${entry.author}\``
  - To: `'data-tandem-author': entry.author` (keep `class: 'tandem-authorship'` for base styling)
  - Update CSS in `src/client/editor/editor.css:64-66` (**not** `index.html` — no authorship selectors exist there):
    - `.tandem-authorship--user` → `[data-tandem-author="user"]`
    - `.tandem-authorship--claude` → `[data-tandem-author="claude"]`
    - Add `[data-tandem-author="import"]` rule (currently missing — imported annotations have no authorship styling)
- **#445:** Add `tabbed-left` layout support:
  - Extend `PanelLayout` union in `src/client/panel-layout.ts:13-15`: add `| { kind: "tabbed-left"; left: number }`
  - Update `App.tsx` initialization (`line 184-188`): add third branch for `settings.layout === "tabbed-left"` → `{ kind: "tabbed-left", left: loadPanelWidth("left") }`
  - Update `App.tsx` layout transition effect (`lines 192-201`): add `tabbed-left` case so switching between layouts preserves widths correctly
  - Add render branch in `App.tsx` for `panelLayout.kind === "tabbed-left"` (side panel on left, editor on right)
  - Verify `useDragResize.ts` handles `PanelSide` correctly for the left-side resize handle
- **Tests:** Unit test for authorship decoration attrs. Unit test for `tabbed-left` initialization and transition.
- **Closes:** #443, #445
- **Key files:** `src/client/editor/extensions/authorship.ts`, `src/client/editor/editor.css`, `src/client/panel-layout.ts`, `src/client/App.tsx`, `src/client/hooks/useDragResize.ts`
- **Effort:** ~1.5 days

#### PR 8: Version Indicator + Changelog Button (#435 + #437)
- **Depends on:** PR 3 (`/api/info` endpoint)
- #435: Fetch version from `GET /api/info`, display in Settings footer or StatusBar
- #437: "View Changelog" button in Settings → opens `CHANGELOG.md` via `POST /api/open` (route exists at `src/server/mcp/routes/open.ts`)
- **Closes:** #435, #437
- **Effort:** ~0.5 day

---

## Dependency Graph

```
fix/audit-findings-batch → merge to master
                              ↓
                         PR 1 (docs)
                              ↓
        ┌──────────┬──────────┼──────────┬──────────┐
       PR 2       PR 3       PR 4       PR 5       PR 6
    (schema+    (/api/info) (MCP#259)  (CI test)  (distro)
     palette)
        ↓          ↓
      PR 7       PR 8
   (attrs+      (version+
    layout)     changelog)
```

PRs 2–6 are fully independent and run in parallel.
PRs 7 and 8 each have one dependency.

**Critical path:** PR 4 (#259) is highest priority — last breaking-change window.

---

## Deferred Items (With Rationale)

| Item | Disposition | Why |
|------|-------------|-----|
| Phase 5 (prop-drilling) | SKIP permanently | ADR-025 Svelte Go replaces the React component tree in v0.10.0. SidePanel has 14 props but they're root-to-leaf, not deep drilling. Refactoring doomed components is waste. |
| #311 (forced-colors audit) | Keep in v0.12.0 | Scoped with dark theme work where all token values are reviewed. |
| #433 (Cowork TOCTOU) | Post-v1.0 | Security edge case. PR 6 must verify new macOS/Linux paths aren't affected (noted above). |
| #438 (per-client identity) | Post-v1.0 | Enhancement; v1.0 model is single user + Claude. |
| #364 (stdio timeout mirror) | Post-v1.0 | Not blocking anything. PR 5 CI smoke test exercises the path. |
| #318 (tombstone GC) | Post-v1.0 | Storage works correctly; disk usage not a reported problem. |

---

## Distribution Coordination (v0.9.0 Release)

v0.9.0 is the first release where three surfaces must stay version-coherent.

**Release sequence:**
1. All PRs merged to master, CI green
2. Tag `v0.9.0`, create GitHub Release
3. npm publish triggers automatically (GitHub Release → CI)
4. Verify `npx -y tandem-editor --version` returns `0.9.0`
5. Trigger Tauri release build — reads version from `package.json`
6. Verify Tauri auto-updater `latest.json` points to new version
7. Smoke test: fresh Tauri install → Cowork workspace → `tandem_status` returns `running: true`

**Rollback per surface:**
- **npm:** Publish `0.9.1` hotfix (prefer over `npm unpublish`)
- **Cowork/npx:** Follows npm automatically
- **Tauri:** Update `latest.json` to point back to v0.8.0 artifacts, or publish v0.9.1 Tauri build

**MCP breaking change communication:** The `tandem_suggest` error stub returns a structured payload (not a protocol error), so existing Claude sessions get a clear message pointing to `tandem_comment`. `tandem_getContent` and `tandem_getSelections` will return "tool not found" until session reconnects — acceptable for a pre-1.0 semver-locked change.

---

## Verification

After all PRs merge:
1. `npm run typecheck` — clean
2. `npm test` — all pass (tool removal + settings tests updated)
3. `npm run test:e2e` — annotation lifecycle works with consolidated tools
4. `npm run check:tokens` — no raw hex regressions
5. Manual: `tandem_suggest` call returns structured deprecation error with updated description in `tools/list`
6. Manual: `tandem_status` with `text` param writes to awareness; without params, read-only
7. Manual: `GET /api/info` returns version + tool count (28)
8. Manual: Annotations with old `red`/`purple` highlight colors load correctly (migrated)
9. Manual: `showAuthorship` displays authorship decorations by default on fresh profile
10. Manual: Editor width slider allows dragging to 40%
11. Roadmap doc accurately reflects shipped state
12. `skills/tandem/SKILL.md` references only current tools and colors
