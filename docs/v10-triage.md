# v1.0 Triage — Mark each row

For each row, replace the empty `Bryan` cell with one of: **Core** (must ship for v1.0), **Defer** (v1.1+), **Cut** (drop entirely), or **TBD**. To accept the recommendation in the `Rec` column, just type "ditto" or copy the rec value.

Full plan context lives in a maintainer-local planning doc. Once this triage is locked, the wave list in §4 of that plan becomes concrete.

**v1.0 thesis (your call, 2026-05-14):** every core feature rock-solid + redesign complete + pending decisions finalized. Quality over speed. Date is soft.

---

## 1A. Strategic "big-feature" candidates

| ID   | Item                                                       | Effort                                                           | Risk                                                            | Rec                                                      | Bryan |
| ---- | ---------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- | ----- |
| #477 | Local LLM integration (PR-4 quartet #642–#645 + PRs 1/3/5) | LARGE                                                            | CRITICAL — PR-4 rewrites `.claude.json` on every user's machine | TBD — if Core, requires ≥2-week feature-flag soak        | Core  |
| #576 | .docx write-back (docx-npm body export)                    | MEDIUM (10–13d body export; comment round-trip = separate spike) | HIGH                                                            | TBD — if Core, body export only (defer comments to v1.1) | Core  |

## 1B. Polish / UX from open issues

| ID   | Item                                    | Effort | Risk   | Rec                      | Bryan                          |
| ---- | --------------------------------------- | ------ | ------ | ------------------------ | ------------------------------ |
| #539 | Custom keyboard shortcut UI in settings | MEDIUM | LOW    | Defer                    | Core                           |
| #595 | Drag-to-reorder tabs                    | SMALL  | LOW    | Defer                    | Completed already              |
| #596 | Toggle text decorations                 | SMALL  | LOW    | Defer                    | Core                           |
| #597 | Document statistics in status bar       | SMALL  | LOW    | Defer                    | Core                           |
| #299 | "Show in file explorer"                 | SMALL  | LOW    | Defer                    | Defer                          |
| #314 | Export annotations as file              | SMALL  | LOW    | Defer                    | Defer                          |
| #265 | Welcome tutorial update                 | SMALL  | LOW    | Bundle into AR6 if cheap | Core                           |
| #319 | Diagnostics dashboard                   | MEDIUM | LOW    | Defer                    | Defer                          |
| #103 | Session management browser              | MEDIUM | LOW    | Defer                    | Defer                          |
| #153 | Embedded/inline images in documents     | LARGE  | MEDIUM | Defer                    | Defer                          |
| #269 | "UI/UX improvement" (vague scope)       | ??     | ??     | Triage scope or close    | This is basically the redesign |

## 1C. Bug fixes & stability

| ID   | Item                                        | Effort | Risk   | Rec                           | Bryan |
| ---- | ------------------------------------------- | ------ | ------ | ----------------------------- | ----- |
| #428 | macOS 26.1 M1 install bug                   | MEDIUM | HIGH   | **Core (production blocker)** | Core  |
| #631 | `restart_sidecar` silent failure            | SMALL  | MEDIUM | **Core**                      | Core  |
| #616 | Evict Y.Doc on cleanup failure              | SMALL  | LOW    | Defer                         | Core  |
| #244 | E2E Windows tsx watch + Playwright deadlock | MEDIUM | LOW    | Defer (CI annoyance)          | Core  |

## 1D. Architecture / refactors (defer-by-default)

| ID   | Item                                        | Effort | Risk                                | Rec           | Bryan |
| ---- | ------------------------------------------- | ------ | ----------------------------------- | ------------- | ----- |
| #438 | Per-client identity (Code + Cowork)         | LARGE  | HIGH (prereq for #452 multi-Claude) | Defer (v1.1+) | Defer |
| #320 | Annotation schema v1→v2 migration framework | MEDIUM | MEDIUM                              | Defer         | Defer |
| #313 | Content-hash annotation identity            | MEDIUM | LOW                                 | Defer         | Core  |
| #318 | Tombstone/GC for annotation store           | MEDIUM | LOW                                 | Defer         | Defer |
| #315 | Extract DocumentStore interface             | SMALL  | LOW                                 | Defer         | Defer |
| #321 | Hocuspocus WebSocket LAN auth               | MEDIUM | LOW                                 | Defer         | Defer |
| #282 | Extract SSE consumer                        | SMALL  | LOW                                 | Defer         | Defer |
| #633 | Extract matchShortcut helper                | SMALL  | LOW                                 | Defer         | Defer |
| #560 | tauri-driver E2E harness                    | MEDIUM | LOW                                 | Defer         | Defer |
| #632 | Workflow-nudge perf                         | SMALL  | LOW                                 | Defer         | Defer |

## 1E. Cross-platform packaging

| ID           | Item                                                 | Effort | Risk                     | Rec                                                       | Bryan         |
| ------------ | ---------------------------------------------------- | ------ | ------------------------ | --------------------------------------------------------- | ------------- |
| #428 cert    | Apple Developer cert + macOS notarization            | MEDIUM | CRITICAL (calendar gate) | **Core — start NOW**                                      | Core          |
| #316         | macOS/Linux Cowork auto-setup                        | LARGE  | HIGH                     | Defer (Win Cowork works; macOS/Linux fall back to CLI)    | Core          |
| #317         | OS-specific firewall scoping                         | MEDIUM | MEDIUM                   | Defer with #316                                           | Defer         |
| #433         | Cowork installer TOCTOU hardening                    | MEDIUM | LOW                      | Defer                                                     | Defer         |
| #552         | Verify titlebar on Linux/KDE                         | SMALL  | LOW                      | Defer                                                     | Defer         |
| #378         | Windows file picker                                  | MEDIUM | LOW                      | Defer (current dialog works)                              | Defer         |
| #566 vs #561 | Updater UX (modal vs banner vs native)               | MEDIUM | MEDIUM                   | Pick one for redesign coherence; else native (status quo) | Core (Banner) |
| #630         | PR #628 follow-ups (RejectionReason, macOS coverage) | SMALL  | LOW                      | Bundle into #428 work                                     | Defer         |
| #646         | Complete `TANDEM_TAURI_SIDECAR` migration cleanup    | SMALL  | LOW                      | Bundle with notarization wave                             | Defer         |

## 1F. Cleanup of in-flight #477 spike (decided by 1A row)

Current branch (`spike/477-sidecar-launcher`) holds the spike + PR-4 hardening pre-work.

- If #477 is **Core for v1.0**: PRs 1/3/4/5 ship; PR-4 quartet (#642–#645) hardens; PR-4 must soak behind a feature flag for ≥2 weeks (v0.13.0 hidden → v1.0 exposed).
- If #477 is **Deferred to v1.1**: spike findings doc lands as ADR; branch parks; #642–#646 stay open against #477; current branch closes.

## 1G. Redesign new surfaces (HANDOFF.md)

Per your redesign-complete rule: every shipped feature must have the new design. The "Core" surfaces below are those I judge necessary for the redesign to *feel* complete, even without #477/#576. Mark differently if you disagree.

| Surface                                                                                                  | Effort | Risk                                            | Rec                                                | Bryan   |
| -------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------- | -------------------------------------------------- | ------- |
| Selection mini-toolbar (Tiptap BubbleMenu) — B/I/S/code/heading/link + Highlight/Comment/Note/Ask Claude | MEDIUM | MEDIUM (suppression vs slash menu/find/palette) | **Core** (defines new toolbar UX)                  | Core    |
| Slash command menu (typing `/` → block types)                                                            | MEDIUM | LOW                                             | **Core**                                           | Core    |
| Authorship gutter (2px per-paragraph thread)                                                             | MEDIUM | MEDIUM (mechanism change — see D2)              | Decision D2                                        | Defer   |
| Editor body fonts (Source Serif 4 / Inter Tight / JetBrains Mono)                                        | SMALL  | LOW                                             | **Core**                                           | Core    |
| Paged .docx layout (white sheets on gray canvas)                                                         | MEDIUM | LOW                                             | **Core** for redesign-complete                     | Core    |
| Annotation reply thread expansion (overlay/modal frame)                                                  | MEDIUM | LOW                                             | **Core** (collapsed thread already ships)          | Core    |
| Annotation thread emoji reactions + status badge                                                         | MEDIUM | MEDIUM (new server data model, no spike)        | Decision D5 (rec: defer reactions; ship expansion) | Discard |
| Solo-mode held-count badge → status bar (move from toolbar/titlebar)                                     | SMALL  | LOW                                             | **Core**                                           | Core    |
| Settings sidebar nav (full tabbed modal) — ship as `SettingsModal.svelte` sibling                        | MEDIUM | MEDIUM                                          | **Core**                                           | Core    |
| Settings → Network panel (sidecar bind mode, retry, telemetry, token rotation status)                    | MEDIUM | LOW                                             | **Core**                                           | Core    |
| Diff / Apply-edit inline split view (hunk-by-hunk staging)                                               | LARGE  | HIGH (no spike yet)                             | Decision D3                                        | defer   |
| First-run onboarding wizard (model select + default mode + shortcuts cheat-sheet)                        | MEDIUM | MEDIUM (couples to #477)                        | Decision D4                                        | core — *amended 2026-06-11 (a): wizard half shipped (Claude Code connect, v0.13.0–v0.14.0); registry half → v1.1; (b) same day: local-model slice → back in v1.0 (see D4 row in §2)* |
| Shortcuts modal (⌘/)                                                                                     | SMALL  | LOW                                             | **Core**                                           | core    |
| Mobile / narrow-window layout (≤480px responsive)                                                        | LARGE  | LOW                                             | Decision D7 (rec: defer)                           | defer   |
| AR5 Word-import batch-promote (.docx comments → private notes → batch convert)                           | MEDIUM | HIGH (annotation type migration on import)      | **Core** (deferred from v0.12.0 batch)             | Core    |
| AR6 tutorial annotations (welcome.md teaches vocabulary)                                                 | MEDIUM | LOW                                             | **Core** (deferred from v0.12.0 batch)             | core    |
| Connection-degradation banner (full polish — partial today)                                              | SMALL  | LOW                                             | **Core**                                           | core    |
| Author chip/avatar on annotation cards                                                                   | SMALL  | LOW                                             | Decision D8                                        | defer   |
| Authorship gutter pulses when Claude is reading (presence indicator)                                     | MEDIUM | LOW                                             | Decision D2-adjacent                               | defer   |
| Empty state with slash menu (`empty` artboard)                                                           | SMALL  | LOW                                             | Bundle with slash menu work                        | core    |
| Compact density variant (`compact` artboard)                                                             | SMALL  | LOW                                             | Decision D9 (resolve with D1)                      | defer   |

## 1H. Redesign chores / migrations (verify status before shipping)

| Item                                                                                 | Suspected Status                                     | Rec                                               | Bryan                                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| Highlight palette migration (red/purple → pink/blue or sanitize-on-read fallback)    | Likely shipped v0.11.0 — verify                      | Verify; ship gap if any                           | i think shipped?                                                          |
| `showAuthorship` default flip false→true + optional migration toast                  | Likely shipped v0.11.0 — verify                      | Verify; ship migration toast if missing           | ok                                                                        |
| OKLCH `from var(...)` → `color-mix()` fallback for older WebView2 (Win 10)           | Status unclear                                       | **Core** if any tokens use OKLCH `from` syntax    | if this is a browser thing, we are deprecating the browser anyway, right? |
| `--tandem-*` prefix audit on production CSS (no bare `--accent`/`--ink`/`--surface`) | Production already namespaced; design files use bare | **Core** if any bare-prefixed vars leak into prod | Core                                                                      |
| `data-author` → `data-tandem-author` rename                                          | Shipped per CLAUDE.md                                | Done                                              | done                                                                      |

## 1I. Speculative HANDOFF items explicitly NOT in scope

Per HANDOFF "Things explicitly NOT designed":

- Document Groups (roadmap 7b)
- Multi-user collaboration (cursor stacking, presence, conflict resolution)
- PWA, .xlsx/.csv, freeform annotation
- MCP tool consolidation #259 (already shipped per CLAUDE.md)
- Frameless window vibrancy / multi-window / file explorer sidebar

These do not appear in the triage table. They are v2+. **Override:** add a row above if you want any pulled in.

---

## 2. Pending design decisions

These block specific implementation work. Each unlocks a downstream wave.

| #   | Decision                                                                                  | Options                                                                                                                                     | Rec                                            | Bryan                                                                     |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| D1  | Density × textSize collision (HANDOFF B1): both write font-size CSS variables             | (a) density controls spacing only, (b) density subsumes textSize, (c) status quo — verify and document                                      | TBD — verify current behavior first            | I think density should control interface, font size should control editor |
| D2  | Authorship visual: per-character (current) vs per-paragraph 2px gutter (design) vs hybrid | (a) per-character, (b) gutter, (c) hybrid (gutter for dominant author + character for inline runs per HANDOFF)                              | (c) hybrid                                     | i think we should just do per-character                                   |
| D3  | Diff/Apply-edit hunk-staging UX                                                           | (a) inline split-view (needs spike + impl, tight), (b) modal-based staging, (c) defer interactive staging — keep current ApplyChangesButton | (b) or (c)                                     | B                                                                         |
| D4  | First-run onboarding wizard                                                               | (a) full-screen modal with model select, (b) overlay (no model select), (c) defer if #477 deferred                                          | Couples to #477 (1A)                           | Core - a + allow setup for more than one model — *amended twice 2026-06-11: (a) registry/adapter half → v1.1; (b) local-model slice → back in v1.0 (Wave 5M/#1123, cloud stays v1.1). Canonical record: decisions.md ADR-039* |
| D5  | Annotation reply thread reactions                                                         | (a) ship reactions (new server model), (b) ship expanded thread without reactions, (c) defer expansion entirely                             | (b)                                            | agreed                                                                    |
| D6  | Updater UX                                                                                | (a) modal (#566), (b) banner (#561), (c) native dialog (status quo)                                                                         | (c) — current works; modal/banner is polish    | banner + indicator on settings icon                                       |
| D7  | Mobile / narrow-window                                                                    | (a) ship full responsive, (b) ship narrow-settings only (HANDOFF C5), (c) defer                                                             | (c)                                            | defer                                                                     |
| D8  | Author chip/avatar on annotation cards                                                    | (a) avatar (initial circle), (b) text label (current)                                                                                       | (a)                                            | defer, current implementation is fine for now                             |
| D9  | Compact density artboard                                                                  | (a) ship as third density option, (b) reuse cozy/spacious                                                                                   | depends on D1                                  | defer                                                                     |
| D10 | Selection mini-toolbar suppression rules (HANDOFF D3)                                     | suppress when slash query active, find bar focused, palette open (per HANDOFF)                                                              | Confirm per HANDOFF                            | ok                                                                        |
| D11 | Editor body fonts                                                                         | (a) bundle locally in `dist/client/fonts/` (Tauri offline-friendly), (b) Google Fonts CDN                                                   | (a)                                            | agreed for 1.0                                                            |
| D12 | macOS / Linux distribution at v1.0                                                        | (a) full parity (notarized macOS + AppImage Linux), (b) notarized macOS, Linux CLI-only, (c) Windows-only with macOS in v1.0.1              | (a) if cert+hardware ready, fallback (b) → (c) | we should aim for full parity for 1.0                                     |

---

## After you've marked everything

When done:

- This file gets folded back into the maintainer-local planning doc
- Wave list in §4 of the plan locks
- I verify §1H "likely shipped" items against current code (Wave 0 task #1)
- Apple Developer cert procurement starts (Wave 0 calendar gate)
- I park or close `spike/477-sidecar-launcher` based on the #477 row decision
- I replace `docs/roadmap.md` v0.12.0+ sections with the new wave structure
