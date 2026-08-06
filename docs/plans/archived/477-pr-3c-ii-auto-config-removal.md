# PR 3c-ii — Auto-configuration removal per ADR-038 §2b

> Plan file. Revised 2026-05-18 after three adversarial reviews (security, contrarian, completeness).

## Goal

Replace the silent Tandem-writes-Claude's-config behavior with explicit wizard-driven setup, per **ADR-038 §2b**. The ADR's literal wording was "TTY-mode wrapper that prompts for the same answers the GUI wizard collects" — the contrarian review correctly flagged this as YAGNI for power users. **Amended in this PR series:** `tandem setup` becomes non-interactive `tandem setup --apply [--target=…]` instead of a TTY prompt flow. The amendment will be noted in ADR-038 §2b when 3c-ii-c ships.

## Constraint: don't strand upgraders, don't break power users

- Existing `~/.claude.json` entries from prior Tandem versions are preserved by the wizard (re-validated against an allowlist).
- `tandem rotate-token` (`src/cli/rotate-token.ts`) still needs silent file-writes — it's auth rotation, not initial config. The library factor in 3c-ii-a keeps `applyConfigWithToken` callable; rotate-token continues to use it.
- `tandem setup --apply` stays scriptable for CI / dotfile users.

## Sub-PR split (3 PRs)

### PR 3c-ii-a — Server library factor (pure refactor, no behavior change)

**Scope.**
- Move from `src/cli/setup.ts` to `src/server/integrations/apply.ts`:
  - `applyConfig`, `applyConfigWithToken`
  - `detectTargets` (including MSIX detection)
  - `buildMcpEntries`
  - `validateChannelShimPrereq`
  - `installSkill`
  - `TargetKind`, `DetectedTarget`, `McpEntry`, `McpEntries` types
- `src/cli/setup.ts` re-exports for back-compat (so `tandem rotate-token` and existing tests don't break).
- `src/cli/skill-content.ts` stays in `src/cli/` (it's imported by `installSkill`; cross-boundary import is fine since `apply.ts` is server-side and `skill-content.ts` is just a constant string export).
- `src/server/mcp/routes/setup.ts` imports from `apply.ts` instead of `../../../cli/setup.js`.
- `src/server/integrations/existing-config.ts` already imports `detectTargets` — repoint to `./apply.js`.
- Tests:
  - Move `tests/cli/setup.test.ts` test cases that cover the moved helpers to `tests/server/integrations/apply.test.ts` (heavy lift; tests stay coverage-equivalent).
  - Keep `tests/cli/setup.test.ts` for `runSetup` (CLI orchestration) only.
  - All paths green: `npm run typecheck && npm test`.

**No schema change. No behavior change. No deletions yet.** This is the prerequisite refactor so 3c-ii-b and 3c-ii-c have a clean import surface.

**Touches.** Server-side library only. No client, no Tauri, no docs (except code refs in moved tests).

**Risk: low.** Pure refactor.

### PR 3c-ii-b — Wizard apply path + first-run auto-open (gated on redesign wave settling)

**Scope.**
- **Schema bump v2 → v3** in `src/server/integrations/schema.ts`:
  - Add optional `apply: "create" | "update" | "skip"` field on `IntegrationConfig` (default `"create"`).
  - Bump `INTEGRATIONS_SCHEMA_VERSION` to 3.
  - Add v2→v3 migration in `src/server/integrations/migrations.ts` (no-op data-wise; sets `apply: "create"` on read for v2 files).
- **New separate endpoint `POST /api/integrations/apply`** (contrarian S1). Keeps intent and side-effect cleanly separated:
  - `POST /api/integrations` continues to persist Tandem's intent to `integrations.json` (pure).
  - `POST /api/integrations/apply` reads the persisted file, iterates integrations with `apply !== "skip"`, calls the library `applyConfig` for each.
  - Wizard's `save()` calls both in sequence: persist → apply.
- **Path-traversal mitigation (security B1).** Apply path validates `configPath` against the set returned by `detectTargets()`. UNC paths rejected (mirror `hasUncPrefix` from `src/server/mcp/routes/_shared.ts:7-9`). `configPath` from the request body is **ignored** — server uses its own `detectTargets()` enumeration. The wizard's `configPath` field in `IntegrationConfig` becomes informational (display-only); apply uses target enumeration.
- **`installSkill` destination home-derived only (security B2).** No request body controls path.
- **Existing-entry preservation with re-validation (security B3).** When the wizard surfaces "already configured" entries from `readExistingTandemEntries`, the entries are validated against a strict schema:
  - HTTP entries: `url` must start `http://127.0.0.1:` or `http://localhost:`.
  - Stdio entries: `command` must be `node`, `npx`, or a known sidecar binary name; `args` must be string array.
  - Entries failing validation are surfaced to the user with a warning and `apply: "skip"` (preserved on disk but Tandem won't re-write them).
- **Idempotency: diff and offer "update" (contrarian B2).** When `readExistingTandemEntries` finds a Tandem entry that differs from what the wizard would write (token added/removed, channel shim added/removed), the detect step surfaces this as a diff item ("Update existing entry?" with both shapes shown). `apply` field is set per-integration based on the user's pick.
- **Channel shim handling (contrarian S3).** The current `applyConfig` silently DELETES stale `tandem-channel` entries when `withChannelShim` is false. The wizard's diff step surfaces this as a removal item the user must confirm. The library `applyConfig` gets a new `confirmStaleRemoval: boolean` param; the wizard sets it to `false` and pre-resolves removals in the diff step. CLI default stays `true` for back-compat until 3c-ii-c.
- **First-run wizard auto-open — transport-agnostic (contrarian B3).** Move `showIntegrationWizard` from a settings toggle to a derived state in `useTandemSettings.ts`:
  - Wizard auto-opens when `integrations.json` is empty/missing AND `readExistingTandemEntries` finds nothing.
  - Works in both Tauri AND npm-browser (driven by the `integrations.json` state on the server, not `window.__TAURI__`).
  - Settings toggle becomes a "Reopen wizard" affordance (manual reopen).
  - `last-seen-version` records "user dismissed wizard" so subsequent launches don't re-prompt.
- **`show_no_claude_dialog` trigger relocates (contrarian N4).** Currently fires from `run_setup()` when zero targets detected; in 3c-ii-c that function dies. Move the trigger to the wizard's detect-step "no integrations found" state, surfaced as a non-blocking dialog inside the modal.
- **E2E spec update:** `tests/e2e/integration-wizard.spec.ts` updates — auto-open on first run, toggle becomes "Reopen" affordance.

**Touches.** `src/client/App.svelte` (mount conditional), `src/client/hooks/useTandemSettings.ts`, `src/client/hooks/useIntegrationWizard.svelte.ts`, `src/client/components/IntegrationWizardModal.svelte`, `src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte`, `src/server/integrations/api-routes.ts`, `src/server/integrations/schema.ts`, `src/server/integrations/migrations.ts`, `src/server/integrations/existing-config.ts` (re-validation), `src/server/integrations/apply.ts` (param additions), E2E spec.

**Risk: medium.** Touches App.svelte + wizard UI surface during/after redesign wave.

**Gate:** wait for the redesign session's current wave to land first (per user decision). Confirmed via webhook on PR #742 close or master inspection.

### PR 3c-ii-c — Delete `/api/setup` + Tauri `run_setup()` + rewrite `tandem setup` as `--apply` wrapper

**Scope.**
- Delete `src/server/mcp/routes/setup.ts`.
- Deregister `/api/setup` route in `src/server/mcp/api-routes.ts`. Remove `API_SETUP` constant from `src/shared/api-paths.ts`.
- Delete `tests/server/setup-route.test.ts` and `tests/server/setup-api.test.ts` (if they exist).
- Delete `src-tauri/src/lib.rs:run_setup()`, `SETUP_URL` const, and its call site. Replace startup behavior with a no-op (the client handles wizard auto-open via the transport-agnostic detection from 3c-ii-b).
- Rewrite `src/cli/setup.ts:runSetup()` as a non-interactive wrapper:
  - `tandem setup` (no args) → reads `integrations.json`; if empty, prints "Run `tandem` to launch the editor and complete first-run setup, or use `--apply` to write default Claude config non-interactively." If non-empty, prints `--apply` invocation hint.
  - `tandem setup --apply [--target=claude-code|claude-desktop]` → calls `applyConfig` for the picked target(s) using `detectTargets()` + `buildMcpEntries()`. Same write behavior as today's `runSetup` but explicit. Defaults to all detected targets.
  - `tandem setup --apply --force` → preserves `--force` semantics (write to default paths even if not detected).
  - `tandem setup --apply --with-channel-shim` → preserves `--with-channel-shim` flag.
  - Skill install runs unconditionally as a side-effect of any `--apply` invocation, since it's per-user not per-integration (contrarian S5).
- `src/cli/index.ts` help text updated.
- `tests/cli/setup.test.ts` rewritten: assertions on `--apply`, `--force`, `--with-channel-shim`, "no args" output.
- **Doc sweep (completeness audit):**
  - `README.md` lines 25, 27, 37, 41, 43, 47, 49, 52, 215-219, 233, 268, 290 — flip to wizard-first language.
  - `docs/architecture.md` lines 40, 302, 428, 661-667, 764, 821 — describe new flow.
  - `docs/user-guide.md` lines 31, 266, 268 — update.
  - `docs/workflows.md` lines 9, 17, 20, 61 — update.
  - `docs/decisions.md` ADR-038 §2b — add "Status: implemented in PR 3c-ii-{a..c}" + amendment note about TTY → `--apply`.
  - `CLAUDE.md` line 56 — update `src/cli/setup.ts` description.
  - `CHANGELOG.md` — Breaking-Changes entry for v0.13.0 (silent auto-config removed; wizard required for first-run; `tandem setup --apply` replaces `tandem setup`).
  - `docs/roadmap.md:444` — expand 3c-ii row into a/b/c sub-rows matching the 3a/3b/3c-i pattern.
  - `src-tauri/src/integrations_probe.rs:120` — update sidecar.json doc-comment to reflect the wizard's writer responsibility.

**Touches.** Server route deletion, CLI rewrite, Tauri Rust, doc sweep.

**Risk: low-medium.** Pure deletion + CLI rewrite + doc updates. Independent of redesign work.

**Gate:** ships after 3c-ii-a (library factor) and 3c-ii-b (wizard apply path) land. The contrarian S4 suggested gating on "one shipped release telemetry" — for a two-person project with no telemetry, that's not actionable. Compromise: user confirms a + b work in a real Tauri build before c lands.

## Migration UX gap (ADR-038 §2b)

Handled in 3c-ii-b: wizard's detect step surfaces existing entries with re-validation per security review B3. User clicks through with `apply: "skip"` to preserve. The wizard never silently rewrites or deletes.

## Open questions for adversarial review (resolved in revision)

1. **`applyConfig` location?** → `src/server/integrations/apply.ts`. (Resolved.)
2. **Atomic-per-batch errors?** → Per-integration error, non-fatal, reported in response. (Resolved.)
3. **TTY vs `--apply`?** → `--apply` non-interactive. (Resolved — ADR-038 §2b amended.)
4. **`--with-channel-shim` survival?** → Preserved as flag. (Resolved.)
5. **Settings toggle?** → Repurposed as "Reopen wizard" affordance. (Resolved.)

## Sequencing

- 3c-ii-a (server-only library factor) — **SHIPPED PR #747 (2026-05-18)**.
- 3c-ii-b (wizard apply + first-run auto-open) — gated on redesign wave settling.
- 3c-ii-c (deletion + CLI rewrite + doc sweep) — gated on a + b.

## Soak override

User explicitly waived the ≥1-week PR 3c-i soak gate. Recording the override here.

## Files of record

`/home/user/tandem/docs/plans/477-pr-3c-ii-auto-config-removal.md` (this file).

ADR-038 §2b citation: `/home/user/tandem/docs/decisions.md:692-715`.
