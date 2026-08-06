# Plan: v1.0 Roadmap Reconciliation (rev 2 — agent feedback incorporated)

**Branch:** `claude/roadmap-1-0-wjb5vv` · **Date:** 2026-06-11 · **Origin:** roadmap review session (Bryan asked: what's on the agenda to 1.0, what's missing; then: plan fixes for everything found, resolve design decisions where possible).

**Rev 2:** incorporates findings from three adversarial reviews (contrarian, fact-check, process). All factual claims below were verified by the fact-check agent against repo + GitHub state on 2026-06-11 unless noted.

## Findings being addressed

| # | Finding | Severity |
|---|---------|----------|
| F1 | ADR-040 licensing engineering (license-to-run, trial gate, license-checked updater — §3/§4/§6 all **Accepted**) has no tracking issue, no wave slot; the `#394 Monetization` row sits in the **Deferred to Post-v1.0** table (roadmap.md:626) while its own text says the work is v1.0 | Critical-path gap |
| F1b | **(from review)** No commercial-readiness exit criterion exists: the hard gate activates at v1.0, so §5 counsel + live MoR checkout + grandfather issuance are tag-blockers — a v1.0 demanding an unpurchasable license is a brick | Critical-path gap |
| F2 | Exit criterion "Multi-provider models registry (D4)" (roadmap.md:560) is unreachable: BYO-models surface hidden behind `BYO_MODELS_ENABLED=false` (constants.ts:18) since v0.14.0 (#1018/#1022); no server-side LLM client exists; ADR-039 is a Reserved placeholder | Decision/reality contradiction |
| F3 | Commercial launch infra (MoR, issuance webhook, LLC/accountant, §5 counsel) has no calendar-gate row, unlike the Wave-0 Apple cert (roadmap.md:20) | Critical-path gap (non-code) |
| F4 | No security gate in exit criteria despite **~14** new HTTP surfaces in v0.13.6–v0.14.0 (incl. `POST /api/shutdown` and the three `/api/sessions*` routes the original list missed) | Exit-criteria gap |
| F5 | No performance gate; known-limitation says ~50 pages (roadmap.md:641); render-path perf unverified (annotation-store perf IS covered by `tests/server/annotations/perf.test.ts` #335; #609 atomic-update pin exists) | Exit-criteria gap |
| F6 | Smoke checklist tests previous→current updates only; no forward (current→next) step; the gate-ON licensed-build path would first run in production on launch day | Checklist gap |
| F7 | Node actions-runtime migration overdue: GitHub forced node24 default 2026-06-02 (node20 removed 2026-09-16); all first-party actions on node20 majors (`checkout@v4` ×5 files incl. `claude-code-review.yml`, `setup-node@v4` ×4, `upload-artifact@v4` in ci.yml only) | Overdue CI item |
| F8 | Doc drift: v0.14.0 "Planned" (roadmap.md:540) though released 2026-06-10 and roadmap.md:505 itself says 3c-ii-c "landed v0.14.0"; v0.13.6 absent from cadence; Wave 3/4 rows pending though shipped (AR5/AR6 hardening shipped **v0.13.6**, CHANGELOG:142); CLAUDE.md:169 calls v0.14.0 content "unreleased" AND says "v0.14.0 retains its planned annotation-migration scope" | Doc drift |
| F9 | #925 decided via ADR-043 (option c, 2026-06-07) but open; its acceptance says close once ADR lands; boot-marker follow-up never filed | Issue hygiene |
| F10 | #319 largely superseded: `tandem doctor --json` shipped **v0.13.6**; Copy Diagnostics + `GET /api/diagnostics` + Open Log Folder shipped v0.14.0. True residuals: dedicated tabular Diagnostics view, warning highlighting, "Open *annotations* folder" | Issue hygiene |
| F11 | #1042 unactioned; NOTE: the `// codeql[js/path-injection]` comments it describes were **removed** in `4d5ee62` (GitHub doesn't honor them; suppression = `path.basename()` taint-terminators + `lgtm[]` markers + Security-tab dismissal); its cited line numbers have drifted post-#1040 | Small verification |

## Design decisions proposed (Bryan veto = per-DD checklist in PR body)

- **DD1 (F2):** v1.0 ships the Claude-Code-wizard connect path only; BYO-models registry UI stays flag-gated off; ADR-039 adapter + #477 PR 5 → **v1.1**. Framing per review: this *resolves a question the locked text left open* — the PR-5 row itself says "whether the adapter ships in v1.0 wave 6 or slips to v1.1 is open" (roadmap.md:451), and ADR-039 says "possibly v1.1". Stated consequence (must appear in the amendment text): **v1.0 charges money while the reachable audience is still Claude-Code users** — breadth via the multi-provider registry (ADR-040 §1's friction-lowering mechanism) arrives v1.1. Rejected middle path: minimal Anthropic-direct outbound client — that's an agent runtime built after the feature-complete line; roadmap already files "Standalone mode with direct Anthropic API" under v2+.
- **DD2 (F1/F1b/F3):** licensing stays v1.0; schedule as dedicated release **v0.16.0** between v0.15.0 and v1.0.0. Why not before v0.15.0: v0.15.0 is hardware-bound and parallelizable (Bryan does hardware while licensing code is written concurrently); the deep install matrix re-runs at v1.0 exit anyway. Bonus: the public v0.16.0→v1.0.0 hop exercises the updater transition to the license-checked endpoint once for real. **Plus (review blocker): add a Commercial-readiness exit criterion** — §5 accepted (counsel-drafted), MoR checkout live end-to-end (test purchase → license issued via webhook), grandfather licenses issued — before the gate flag flips / v1.0.0 tag; if not ready, the date floats (per thesis), the gate flag does NOT ship on.
- **DD3 (F9):** close #925 per its own acceptance; file boot-marker follow-up first.
- **DD4 (F10):** close #319 as superseded. Closing comment: corrected residual list (tabular view, warning highlighting, Open-annotations-folder — NOT `--json`, which shipped v0.13.6), acknowledge the 0.13.6 changelog's "issue stays open" note and the issue's filed-as-condition provenance, explain Copy Diagnostics meets the core user need (paste-into-bug-report).
- **DD5 (F7):** bump first-party actions to node24 majors — `checkout@v6` (v6.0.3), `setup-node@v6` (v6.4.0), `upload-artifact@v7` (v7.0.1) (verified via releases pages 2026-06-11). Keep `node-version: 22` (matches `engines` + bundled sidecar). The roadmap line 369 item is about the actions **runtime**, not project Node.

## Work items (execution order)

### W1 — File GitHub issues (numbers needed by W2)
1. **Licensing engineering tracker** — "v1.0 license-to-run + trial gate + license-checked updater (ADR-040 §3/§4/§6)". PR sequence: **L1** Ed25519 license format + on-device verify in the server (booted by both Tauri sidecar and npm CLI per §6) + offline issuance/signing script (also serves grandfathering); **L2** trial clock (on-device, soft per §3) + trial banner + activation UI + hard gate behind build flag flipped at v1.0; **L3** license-checked update endpoint (Keygen or CF Worker per §6) + updater entitlement wiring, logs only what authorizes (§4); **L4** grandfathering issuance + doc surfaces per ADR-040 consequences. Note: §5 counsel gates **charging/tag**, not landing gate code (see commercial-readiness criterion).
2. **Commercial launch infra (Bryan-led calendar gate)** — MoR account (Polar.sh/Paddle), issuance webhook, LLC + accountant, §5 counsel draft. Mirrors Wave-0 Apple-cert pattern; feeds the commercial-readiness exit criterion.
3. **Updater pending-update boot marker** — the ADR-043 deferred follow-up.

### W2 — Launch security sweep agent (background, results folded in before commit)
Spawn `security-reviewer` (review-only) over all HTTP surfaces added v0.13.6–v0.14.0: store/reclaim-lock, diagnostics, backups + backups/restore, rename, document/raw, document/reload, docx-conflict/resolve, integrations/install-claude-code, integrations/claude-cli-status, **sessions + sessions/delete + sessions/clear (#103, v0.13.6)**, **shutdown (#1088, v0.14.0)**, `/api/info` generationId field, `/health` hasSession field. Three-surface audit pattern (lessons-learned). Disposition: trivial fixes (comment/log/testid) may bundle in this PR after `/simplify`; **any fix altering request handling or gating goes in its own PR, linked**. HIGH findings → issues, linked from the new gate row.

### W3 — Docs truth sweep (one commit; runs while W2 agent works)
`docs/roadmap.md`:
- Cadence: add v0.13.6 (Released 2026-06-04); v0.14.0 → Released 2026-06-10; insert v0.16.0 licensing row; v0.15.0/v1.0.0 unchanged.
- Wave table: Wave 3 residual → shipped v0.13.6; Wave 4 → shipped v0.14.0; add licensing wave row.
- D4 amendments per DD1 (dated, original text struck not deleted; quote the PR-5 "is open" hedge): Locked Decisions table, exit criterion :560 → wizard-based ("first-run wizard one-click Claude Code connect works on all three platforms; BYO surfaces remain hidden while `BYO_MODELS_ENABLED` is off"), #477 PR-5 row → v1.1, Out-of-scope list, Future Extensions :651.
- Move #394 row out of Deferred table → "v1.0 licensing" subsection referencing W1 issues.
- Exit criteria additions: **Security gate** — generative phrasing ("all HTTP routes added since v0.13.0, enumerated at RC by diffing route registrations in `api-paths.ts`/`api-routes.ts`/`routes/`; initial floor list: …W2 list…; method: three-surface audit; threshold: zero unresolved HIGH; findings recorded as linked issues; re-run at RC tag; self-graded by security-reviewer agent — acceptable at two-person scale"). **Performance gate** — fixture: checked-in generator script producing a ~50-page markdown doc; thresholds: open-to-interactive < 3s, annotation create/accept reflects < 500ms, no >100ms frame stall during scripted scroll (DevTools trace); hardware: the smoke-checklist machines; acknowledges existing partial coverage (annotation-store perf #335, #609 pin) and that the gate is unvalidated until RC (risk register). **Commercial readiness** per DD2.
- Node row :369 → reword to actions-runtime bump, mark done, cite forced-default date.
`docs/v10-triage.md`: D4 rows (~:96, :140) — same dated-amendment treatment as roadmap D4 (it's the declared triage source of truth).
`README.md`: :118 multi-provider overclaim → present-tense accurate (Claude Code via wizard; BYO models v1.1); :166 adapter row → "targeted v1.1".
`docs/decisions.md`: ADR-039 placeholder → "targeted v1.1 (2026-06-11)"; ADR-040 §1 dated note (friction-lowering ships v1.0 via wizard; multi-provider registry v1.1); ADR-040 consequences → pointer to W1 issues; check ADR-038 Context for stale D4-multi-provider claims.
`docs/positioning.md`: verified consistent by review — re-check only if ADR-038 edit reveals coupling.
`CLAUDE.md`: Status — fix BOTH stale clauses ("post-0.13.6 unreleased work…" → released in v0.14.0 2026-06-10; "v0.14.0 retains its planned annotation-migration scope" → shipped: hardening v0.13.6, 3c-ii-c + #576 v0.14.0).
`docs/release-smoke-checklist.md`: forward-update step **with mechanic** (re-serve the current signed artifact under a bumped version in a staged `latest.json` via updater endpoint override — sig signs artifact bytes, version field independent); gate-ON RC step (trial banner → simulated expiry → activation with real signed license → updater entitlement, Windows + macOS minimum); link licensing issue.

### W4 — CI actions bump (one commit)
Files: `ci.yml` (checkout ×2, setup-node, upload-artifact), `publish.yml` (checkout, setup-node), `tauri-release.yml` (checkout, setup-node), `tauri-webdriver.yml` (checkout, setup-node), `claude-code-review.yml` (**checkout only** — `claude-code-action@v1` is third-party, untouched). upload-artifact appears ONLY in ci.yml (single job, fixed name, `if: failure()` — no naming/overwrite hazard). Check majors' breaking-changes notes before editing. Verification: `actionlint` locally if available; PR CI validates ci.yml + claude-code-review.yml; optionally `workflow_dispatch` tauri-webdriver.yml on this branch; **do NOT add workflow_dispatch to tauri-release.yml** (sign-guard + OIDC environment binding deliberately fail non-tag runs); PR body states tauri-release.yml/publish.yml are first exercised at next tag/release. **Pre-flight: push W4 commit early** — if the credential lacks `workflow` scope the push fails fast and W4 splits into a Bryan-pushed commit; the rest of the PR proceeds without it.

### W5 — Fold in sweep results, commit, push, PR
Conventional commits per work item. Run the `code-review` skill on the diff before pushing. Push `-u origin claude/roadmap-1-0-wjb5vv`; open ready-for-review PR. PR body: **per-DD sign-off checklist** (`- [ ] DD1 …` × 5), the charge-while-Claude-gated consequence stated plainly, wave-numbering caveat (Bryan-local plan), tag-workflow verification caveat, sweep summary.

### W6 — Issue hygiene (after PR exists, comments link it)
- #925: comment (refs → ADR-043, option (c), follow-up issue) + close.
- #319: comment per DD4 (corrected residuals) + close.
- #1042: attempt the code-scanning alerts API (`GET /repos/.../code-scanning/alerts?path=...`); regardless, comment the repo-side truth: PR #1038 merged, no config exclusion, `codeql[]` comments removed in `4d5ee62` (not honored by GitHub), suppression = basename taint-terminators + `lgtm[]` + Security-tab dismissal, line numbers drifted. Close if alerts confirm clean; else leave open for the Security-tab eyeball with the checklist updated.

## Explicitly out of scope
Implementing L1–L4 or the ADR-039 adapter; running the performance measurements (gate explicitly marked unvalidated-until-RC); hardware smoke; design issues needing hardware/testers/taste (#316/#317/#552/#832/#892/#916/#917/#928/#989/#992/#994/#995/#997/#438/#321/#630/#798/#964/#1112/#1045-residual).

## Risks
- DD1/DD2 amend locked decisions → dated amendments (precedent: roadmap :459 Spike-B override), per-DD PR checklist, nothing destructive.
- v0.16.0 numbering may collide with Bryan-local wave plan → PR-body flag.
- Action major bumps on tag-only workflows unverifiable pre-merge → actionlint + dispatch-run + PR-body caveat.
- `workflow` token scope may block pushing W4 → early push fails fast, W4 splits out.
- Performance gate unvalidated until RC → recorded in the gate text itself.
- Issue closes reversible; comments carry full rationale.

## Rev 3 — post-implementation review fixes (2026-06-11)

The W5 diff review (4 finder agents over the committed diff) produced 16 accepted findings, applied in a follow-up commit. Deviations from rev 2 worth recording:

- **W1.3 issue numbers:** filed as #1116 (licensing), #1117 (commercial infra), #1118 (boot marker); security sweep findings filed as #1121. ADR-043 and the updater spike checklist now cite #1118 (rev-2 left them saying "to be filed").
- **v1.0.0 cadence row** was rewritten (gates + flag flip), not "unchanged" as W3 stated — intentional consequence of DD2's exit-criteria additions.
- **Beyond plan, from review:** `sample/welcome.md` + `tests/fixtures/welcome-snapshot.md` still told new users to open the flag-hidden Models settings (in-product counterpart of F2) — copy replaced in lockstep, AR6 anchor tests green. README "comments included" softened to the ADR-027-accurate claim. positioning.md multi-provider question resolved to v1.1. Stale roadmap #576/#428 rows fixed. Keychain store→read round-trip added to the wizard exit criterion (the struck D4 criterion was the only release-time real-keychain check). Duplicated D4/licensing rationale compressed to single-owner + pointers (drift control).
