# Backlog triage — 2026-08-06

**Live open count: 47** (`gh issue list --state open --limit 200 --json number --jq 'length'` → `47`, run at synthesis time).

**Drift since the plan was written.** Plan assumed 43 → 46. Four issues were filed on 2026-08-06 within a 47-minute window: #1306 (15:01:21Z), #1307 (15:01:40Z), #1308 (15:03:50Z), #1310 (15:48:46Z). PR #1309 (merged 15:55:23Z) and PR #1311 (OPEN) are pull requests, not issues, and are not in the 47. **#1265 is an open PR, not an issue** — it does not consume a backlog slot; the "parked #1265" line in the plan refers to a draft PR.

**One issue the plan did not account for: #1302** (heading dropdown clipped by the `overflow:hidden` track).

> **CORRECTION (applied post-synthesis, verified by hand).** Synthesis assigned #1302 a Wave 2 branch.
> That is a **duplicate**: PR **#1304** declares `Closes #1302` (`closingIssuesReferences: [1302]`) and
> is already in the merge queue. Synthesis verified the defect at HEAD `6b5c7a3`, which is the
> *accessibility* branch and does not contain #1304's fix — hence the false negative.
>
> The technical analysis is corroborated, not discarded: #1304 fixes exactly the three popovers
> synthesis identified (heading menu, highlight color picker, link editor) via an overflow **axis
> split** — `overflow-x: clip` rather than `hidden`, because a `visible`/`hidden` pair computes to
> `auto` per CSS Overflow 3 and would re-clip vertically. It also adds
> `tests/e2e/formatting-bar-popovers.spec.ts` against `data-testid="formatting-bar"`, which is the
> exact coverage gap synthesis named as the reason this shipped. **Branch 2-A is dropped**; #1302's
> state is "fixed by open PR #1304, pending merge".

Disposition coverage of the 47:
- **Wave-assigned: 17** (6 W1, 4 W2, 2 W3, 3 W4a, 2 W4b) + #1302 fixed by an open PR
- **Decision brief (Stage B doc or Stage A judgement call): 25**
- **Parked: 4** (primary state; 2 more park *after* their brief is answered)
- **Close: 0 outright** — every close is downstream of a brief (see Close list, all marked sequential)

---

## Wave table

Deviations from the plan are marked **[DEV]** with the reason.

### Wave 1 — v1.0 RC security + untrusted-input hardening

Two parallel branches. They share **zero files**, verified below in the collision map.

| Branch | Issues | Files | Notes |
|---|---|---|---|
| **1-A** `fix/docx-decompressed-ceiling` | **#1310** | `src/server/file-io/{index.ts,docx-footnotes.ts,docx-lost-features.ts,docx-comments.ts,docx-apply.ts}` (5) | **[DEV]** #1310 had no wave. Assigned here and sequenced **first in the wave**. Rationale (Stage A): it is the only finding in the batch reachable in the **default shipped desktop config** — drag-drop, `tandem_open`, OS file-association all reach the same `file-io/index.ts` fan-out with no flag, no LAN bind, no auth. #1292 is unreachable until the BYO flag flips; #1293 needs `TANDEM_BIND_HOST`; #1294 needs a non-loopback caller. Impact is availability + unsaved-edit loss (OOM kill never reaches `autoSaveAllToDisk`). Fix is scoped, no decision needed: reuse the existing `declaredSize()` gate (`docx-lost-features.ts:425-426`, sole call site `:506`) at each main-part read before `async("text")`. |
| **1-B** `fix/rc-security-batch` (sequential commits) | **#1294, #1293, #1295, #1292, #1307** | see collision map | Plan's single-branch shape retained. Order: **1-pre** derive the file set by grepping every `path:line` in the four issues → **1a** #1294 scrubs + #1295 six LOW + #1292 sink cap → **1b** #1293 per-caller pass across 22 invocations in 11 files, `routes/shutdown.ts` as reference, never modified → **1c** doc sweep over #1293's ~10 files plus #1307. |

**#1294 carries a body edit, not just a code fix.** Stage A: its second reachability bullet ("reachable by any website today via the opaque-origin CORS bug in #1291") is **dead** — 8596240 replaced the `"null"` ACAO fallback with conditional emission (`src/server/mcp/api-routes.ts:145-147`), `isLocalhostOrigin` returns false for `"null"` (`:104`), #1291 CLOSED 2026-08-05T21:09:58Z. Strike or annotate that bullet before fixing; keep the #1293 bullet, which survives. Honest re-derivation may land #1294 at LOW.

**#1294's defect is untouched** — `git diff --stat master HEAD` over its six files is EMPTY; `rename.ts:65`, `backups.ts:76`, `existing-config.ts:204`, `install-claude-cli.ts:329`, `_shared.ts:116` all verbatim. Do not read "#1291 fixed" as "#1294 fixed".

**#1292 stays in the wave, not parked** — per the plan, `docs/roadmap.md` states the threshold unconditionally. Note the tension: Stage A confirms it is flag-flip-only and blocks the #1123 flip; fixing it here is the cheaper order.

**#1199 is NOT the wave umbrella.** **[DEV]** Plan treated it as covering Wave 1; Stage A parks it (no RC tag exists — `git tag --list "*rc*"` returns only `archive/pr285-round3-backup`). Wave 1 is the *pre-RC* pass; #1199 is the re-run at the RC tag. See Parked list.

---

### Wave 2 — independent smalls

Two parallel branches, ≤6 files each.

| Branch | Issues | Files |
|---|---|---|
| ~~**2-A**~~ | ~~#1302~~ | **DROPPED — already fixed by open PR #1304.** See the correction at the top. |
| **2-B** | **#1306**, **#1270** | `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs` (`extract_file_arg`), server extension allowlist; `sample/welcome.md` |
| **2-C** | **#1289**, **#1269** | `infra/license-issuance-worker/`; `src/client/components/Activity*` |

**#1302 — the analysis, retained for the #1304 merge review.** `src/client/shell/FormattingBar.svelte:141` was confirmed clipped at `6b5c7a3` (the a11y branch, pre-#1304): `overflow: hidden` on the track, with the comment immediately above it (`:136-140`) already documenting the exact hazard for the Decorations button. Three absolutely-positioned popovers inside the track were affected: heading menu, highlight color picker (both measured `reachable: false`), link editor (clipped but hit-testable). Long-standing, not a regression (`f3a6d037`, 2026-05-07). **#1304 fixes all three** and adds the missing E2E — existing coverage (`tests/e2e/toolbar-redesign.spec.ts:489-495`) only exercised the selection-popup variant, which is why this shipped. Synthesis independently preferred a portal off the trigger's measured rect; #1304 instead uses an overflow axis split and documents the truncation trade it accepts (a clipped control that takes keyboard focus can no longer be scrolled into view, confined to the browser distribution below 640px since `minWidth` is 800). **Worth confirming during the #1304 review** — that trade is stated but only bites a surface neither of us exercised.

**#630 removed from Wave 2.** **[DEV]** Plan had "#630 items 1-2 on its own worktree". Stage B **refutes** that: items 1, 2 AND 3 all shipped 2026-06-08 in `01e8adc` (`pub enum RejectionReason` at `src-tauri/src/lib.rs:342`; `STARTUP_REJECTION` Mutex at `:148`, command at `:198` registered `:1507`; `classify_opened_url` at `:453`). The Rust cold-compile worktree cost the plan was budgeting for buys nothing. #630 → decision queue + park.

---

### Wave 3 — decision-gated + Rust

| Branch | Issues | Notes |
|---|---|---|
| **3-A** | **#1213** | **Blocked on a decision** (see queue row D-13). Do not start until the era/negotiation question is answered. Whatever the answer, the body's line refs must be corrected: gate is `src/server/events/queue.ts:175-180` (not `sse.ts`), consumer gate `src/shared/sse-consumer.ts:472-479` (not `:398-406`), collaborator abort `collaborator.ts:302-303`. |
| **3-B** | **#1118** | Own branch, Rust (`src-tauri/`). No collision with 3-A. |

---

### Wave 4a — the external field reports

**Run early.** These are the backlog's only reports from a real external user.

| Branch | Issues |
|---|---|
| **4a-A** | **#1298**, **#1300**, **#1299** minus its EPERM part |
| **4a-B** | **#1299** EPERM one-file fix |

---

### Wave 4b

| Branch | Issues | Notes |
|---|---|---|
| **4b-A** | **#1288** | Profile first. The measurement in the issue is 7851ms of click-dispatch vs 379ms of actual accept — the defect is **hit-testability**, not accept cost. Do not optimize the accept path. |
| **4b-B** | **#1253** | Empirical probe of the modern-era MCP server shape + re-test ADR-012's untested 2024 stateless-crash claim. Sequential after brief-438 is answered (it is that brief's first successor). |

---

### Wave 5 — post-decision work

Populated by whatever Bryan answers in the decision queue. Currently expected: **#832** left-rail plumbing (brief-design-shelf carve-out 1), **#1287** copy pass, **#995** `/table` slash command, **#994**+**#1262**, **#992**, **#798** docs-only PR, plus the issue-body/close actions from every brief.

---

## Collision map

Derived from callsites Stage A and Stage B actually cited. `file → [issues]`. Only files with **>1 issue**, or that pin a branch boundary, are listed.

| File | Issues | Consequence |
|---|---|---|
| `src/server/integrations/api-routes.ts` | #1293 (`:280-281` the no-op gate), #1294 (`:321-330` ungated GET, `:332`, `:912` stderrTail) | **Hard collision.** Same branch, sequential commits. This is the single strongest argument for the plan's one-branch Wave 1-B. |
| `src/server/integrations/existing-config.ts` | #1294 (`:204`), #1293 (doc sweep) | Same branch. |
| `src/server/mcp/routes/{rename,backups,_shared}.ts` | #1294, #1293 (doc sweep), #1295 (L1 `/api/backups/restore`) | Same branch. |
| `src/server/mcp/api-routes.ts` | #1307 (the #1291 invariant, `:104`, `:145-147`), #1293 (doc sweep) | Same branch — #1307's carrier lives in the file 1c is already sweeping. |
| `src/server/local-model/collaborator.ts` | #1292 (streaming sink), #1213 (`:302-303` un-mode-gated abort), #1123 (flag site `:363`) | **Cross-wave.** #1292 in W1-B, #1213 in W3 — W3 is decision-gated and starts later, so no parallel conflict. Do not move #1213 earlier. |
| `src/server/events/queue.ts` | #1213 (`:175-180`, `:277-283`, `:365`) | W3 only. |
| `src/shared/sse-consumer.ts` | #1213 (`:472-479`) | W3 only. |
| `src/server/file-io/*.ts` | **#1310 only** | Confirms 1-A can run parallel to 1-B. |
| `src-tauri/src/lib.rs` | #1306 (`extract_file_arg`), #630 (items 4-7, `:591`/`:611`/`:656`), #552 (`:2651` `setup_overlay_titlebar`), #1118 | **Four-way.** #630 and #552 are parked/briefed, #1118 is W3-B. **#1306 (W2-B) and #1118 (W3-B) must not run in parallel** — different waves, so fine as sequenced, but do not compress W2 and W3. |
| `src/client/shell/FormattingBar.svelte` + `editor/toolbar/*` | **#1302 only**, via open PR #1304 | Not a wave branch. #1304 also regenerates `tests/design-system-impl/__snapshots__/testid-set.snap.txt`, adding `formatting-bar-track` and `formatting-bar-wrap`. It touches **no** `CLAUDE.md` — the merge (`13b0300`) lists 12 files and none is `CLAUDE.md`, which carries no testid list of its own (it points at `docs/design-system-impl/testid-manifest.md`). No conflict with `e74a49a`. |
| `src/client/components/SettingsModal.svelte` / `AppearanceSettings.svelte` | #1262, #994, #992 | All three are Wave-5 post-decision; **one branch** when they land. |
| `src/client/status/StatusBar.svelte`, `src/client/status/status-ai-view.ts` | #1287 | Wave 5, isolated. |
| `src/client/panels/PeekStrip.svelte` | #832 | Wave 5, isolated. |
| `docs/roadmap.md`, `docs/decisions.md` | #1199, #438, #1263, #321, #316, #798, #1252 | Docs-only; serialize the doc PRs or expect trivial conflicts. Not a code-branch constraint. |

E2E remains a **global mutex** (workers:1, fixed ports, shared app-data dir wiped at server start): #1302, #995, #994, #1288 all want E2E. Only one branch may run E2E at a time regardless of wave.

---

## Decision queue — Bryan's to-do list

Rows D-1 to D-13 have a brief in this directory (linked in the Recommendation column). Rows **D-14 to D-16** are Stage A judgement calls with **no brief written** — the reasoning is inline in the row.

| # | Issues | Question | Recommendation | Yes unblocks | No unblocks |
|---|---|---|---|---|---|
| D-1 | #989 #964 #928 #916 #892 #832 | Defer four past v1.0, ship #832's left-rail half now, close #892 as superseded? | **Yes**, with two carve-outs ([`brief-design-shelf.md`](brief-design-shelf.md), high) | Milestone 4 post-v1.0; one small PR threading real heading levels into `PeekStrip.svelte:77-81` (currently hardcoded fake h1/h2/h2/h3/h2 on a shipped surface); close #892 citing #917 | #989 and #892 each need a design pass; #964 needs a streaming document-write path; #916 needs a user-feel procedure that doesn't exist |
| D-2 | #316 #317 #552 | v1.0 ships Cowork auto-setup on macOS/Linux, or Windows-only with the rest deferred? | **Windows-only** ([`brief-platform.md`](brief-platform.md), high) | ~1 day of copy + roadmap edits; reword `CoworkSettings.svelte:137`; document the manual `npx -y tandem-editor mcp-stdio` path | #317 becomes a v1.0 blocker needing a real-Mac network-topology probe first; budget hardware acquisition before code |
| D-3 | #997 | Ship the reduced right-click re-arm, or close in favour of extending the #923 native menu? | **Close #997**, extend the native menu ([`brief-997.md`](brief-997.md), high) | Add annotate/highlight items to `context-menu/{types,dispatch}.ts` + Rust builder | A hand-run Windows spike on DOM-paint-before-`popup_menu` *before* estimating |
| D-4 | #995 | Ship `/table` as fixed 3×3-with-header slash command only? | **Yes** ([`brief-995.md`](brief-995.md), high) | One PR: `SlashCommandId` entry + unit test + round-trip E2E. Close the paste line item as already shipped (`markdown-paste.ts:247-259,337`, #1184 / 624eb4e) | Column-alignment UI needs its own design pass |
| D-5 | #994 #1262 | Adopt the allowlist context-menu policy? And is the Settings split "Appearance = looks / Editor = behaves"? | **Yes** to both, never `Flags::CONTEXT_MENU` ([`brief-994.md`](brief-994.md), high) | One client module + per-surface markers, no Rust; one small Settings-markup PR (E2E selectors like `appearance-show-raw-markdown` need aliases) | — |
| D-6 | #992 | Accept `set_theme`'s blast radius (native file dialogs + title bar) for themed menus? | **Yes**, option 1 ([`brief-992.md`](brief-992.md), **medium**) | ~40 lines: `set_window_theme` command + effect gated on `theme !== 'system'`. **Hand-verify on the Windows box before writing the changelog line** — muda's Win32 popup dark mode lags and this is unverified | Menus stay system-themed |
| D-7 | #321 | Close as "condition unmet", or park with a named reopen trigger? | **Park** ([`brief-321.md`](brief-321.md), high) | Body edit + strip `needs-design-decision`; keeps the loopback constraint discoverable as a decision, not an incidental comment | Close + add a sentence to ADR-023's consequences |
| D-8 | #438 (+#1252 #1253 #1249) | Close #438 as superseded, and commit to "dual-era, legacy retained indefinitely"? | **Yes to both** ([`brief-438.md`](brief-438.md), high) | Rewrite #438 as shipped/moved/dropped and close; ADR-045 amendment; a detector for SDK `SUPPORTED_PROTOCOL_VERSIONS` (#1252's watch item has none); sequence #1253 → #1249 → #1252 | #438 stays open misleading readers — its body still asks for a design doc that exists (PR #1064) and calls transport multiplexing an open evaluation that ADR-045 answered |
| D-9 | #798 (+#964 #832) | Does GA need all A1–A29, or the named subset? | **Named subset — already on master** ([`brief-798-status-audit.md`](brief-798-status-audit.md), high) | One docs-only PR to `motion.md`: A6b + A16b exemption paragraphs, reconcile the stale DoD checkboxes at `:347-356` (six of eight unchecked); then close #798 | Build a runtime SVG connector tracking two moving DOM nodes across scroll/rail-resize/margin-mode, design review first |
| D-10 | #1263 | Keep chat global in CTRL_ROOM? | **Remain global** ([`brief-1263.md`](brief-1263.md), high) | One ADR + close; no code | Multi-PR: per-room chat maps, `chatSeen` baseline migration, a home for documentId-less messages, Clear-Chat blast radius |
| D-11 | #1308 (+PR #1311) | Merge the KG retirement but restore `/diverge`, and adopt kill-date-as-issue? | **Split PR #1311** ([`brief-1308.md`](brief-1308.md), high) — KG criterion met (27 nodes, 27 staleness warnings, last content commit dd39e8f 2026-05-25); `/diverge`'s was **not** (invoked 9657de1 2026-05-29 and again 2026-07-20 in `.claude/plans/diverge/solo-defer-and-release.md`, 23 days past the gate — invisible to sweep 767b7d1 because `.claude/plans/` is gitignored) | Amend #1311 to restore `diverge.md` + seven agents; re-date the gate with a **tracked-file-evaluable** criterion; two kill-gate issues; convention into CLAUDE.md; close #1308 | Merge as-is — but then correct the commit-message claim that `/diverge` was never invoked, since `.claude/plans/diverge/` remains on disk contradicting it |
| D-12 | #1287 | In Solo, suppress the working-pill/status text, or fix the copy? | **Fix the copy** ([`brief-1287.md`](brief-1287.md), **medium**). Reject option C (server-side mode gates on the writes) — it would be the first place Solo suppresses *state* rather than *delivery* | Copy pass over `SOLO_PAUSED` in `status-ai-view.ts`; one conditional in the `aiIndicatorContent` snippet; record the five-surface enumeration; E2E on `status-ai-indicator`. Client-only | Flip `canAnimate` false, gate the pill on `!soloMode` — and accept users can no longer distinguish idle from working-invisibly |
| D-13 | #630 | Rewrite to items 4-7 + 8, or close outright? | **Option A: rewrite** ([`brief-630-split.md`](brief-630-split.md), high). The brief **refutes** the requested split — items 1-3 all shipped in `01e8adc` | Body edit striking 1-3 with a pointer to `01e8adc`; resolve item 7 as "log-only, documented" in the same edit; retitle to follow-ups, label low-priority | Close outright (also defensible — all user-visible payload shipped); record that 4-7 were dropped as diagnostics-only so they aren't later mistaken for unfinished correctness work |
| **D-14** | **#1213** | *(no brief written — Stage A judgement call)* Build the capability-negotiation seam, or accept two permanent Solo gates? | **None offered.** Settled: the forwarder half shipped (`queue.ts:175-180`); the consumer half must **not** be deleted as the issue's step 2 instructs — CLAUDE.md, the in-code comment at `sse-consumer.ts:455-459`, and Bryan's own comment (2026-08-02T01:59:15Z) all agree, and the skew is verifiable (`.claude-plugin/plugin.json:31` pins `tandem-editor@0.20.1`; `routes/info.ts` has no capability field). Sub-questions: (i) is a permanently-redundant gate acceptable at one `/api/mode` fetch per non-chat event with an unbounded stale-preserving cache; (ii) if yes, retitle/rescope #1213 so the tracker stops instructing a deletion four in-repo sources forbid; (iii) if no, is a self-describing `soloForwarderGate: true` on `/api/info` worth the new public surface | Wave 3-A | Retitle-only, then #1213 becomes a docs/line-ref fix |
| **D-15** | **#1197** | *(no brief)* Keep spending `workflow_dispatch` cycles on the WebView2/msedgedriver regression, or declare the WebDriver smoke environmentally dead and record the skip? | **None offered.** Cause (a) is **closed** (see Close list). Cause (b) has **no version knob left**: `.github/workflows/tauri-webdriver.yml:166` already makes the exact runtime version the first candidate, and runs 30974836130 / 31022514071 / 31027157696 all report `Edge WebDriver: 150.0.4078.105 (exact runtime match)` and still fail `DevToolsActivePort file doesn't exist`. The leading hypothesis (driver must match version not just major) is **refuted by measurement**. The app is provably alive in the same run (`[Hocuspocus] Client connected to: welcome-fnxsvz`); only the CDP handshake is missing. Next suspect is wry/WebView2 `AdditionalBrowserArguments` vs the driver's `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` — **unverified**, Windows-only, not reproducible from this session | A scoped spike on the browser-arguments collision | Record the skip per the `no-hardware-for-release-smoke` convention; #1197 closes with (a) fixed and (b) documented as third-party |
| **D-16** | **#1045** | *(no brief)* Pin a known-good CLI range via managed settings (`requiredMinimumVersion`/`requiredMaximumVersion`)? | **Bryan's call, and the issue accepts an explicit decline.** Mechanism still exists in the installed CLI (2.1.223: 5 + 10 hits). Item (a) is done and closeable (see Close list). Zero product/release risk — touches `.claude/` only, no `src/`, no `src-tauri/`, no workflow; can be settled at any time independent of any wave | Add the keys to `.claude/settings.json` or a managed-settings file (none exists: `ls C:/ProgramData/ClaudeCode/` → no such directory) | Record the decline on the issue and close #1045 entirely |

---

## Close list

Every entry here is **sequential** — it becomes actionable only after the named decision. There are no outright closes.

| Issue | Gate | Citation proving closeability |
|---|---|---|
| #892 | after D-1 | Stated motivation (anchored margins degrading under collision pressure) consumed by #917, shipped 2026-07-30; `docs/plans/2026-07-30-margin-vertical-pressure-elastic-width.md` |
| #997 | after D-3 | Two body claims stale at HEAD: pop-up now defaults **below** (`selection-toolbar.ts:36-42`), and it is armed only by pointerup/keyboard dwell with `e.button !== 0` early-return (`Toolbar.svelte:196-197`, `:391`) — a right-click never arms it. Literal ask (DOM above an OS menu) is impossible; the issue admits it |
| #438 | after D-8 | Phase 1 shipped: ADR-045 at `docs/decisions.md:900`, PR #1233 MERGED 2026-07-23T08:14:35Z. Design doc exists: `docs/spikes/per-client-identity-spec.md`, PR #1064 merged 2026-06-08T07:30:28Z. Residual moved to #1252/#1253/#1249 |
| #798 | after D-9 | 27 of 29 scenes + s3 verified commit-by-commit on origin/master; A6b and A16b are the only outstanding halves, and #798's own DoD permits "a documented exemption in motion.md" |
| #1263 | after D-10 | Decided-not-changed; chat is global in CTRL_ROOM (`constants.ts:184`, `awareness.ts:94-95`, `ctrl-chat.ts:19`); #1264 already made unread + filenames documentId-aware while deliberately leaving scope global |
| #1308 | after D-11 | Convention adopted + two kill-gate issues opened |
| #1045 **item (a) only** | after D-16 | Already implemented and merged: `f13f81d` (2026-06-05) *"fix(hooks): inject Stop-hook reminder as additionalContext JSON (#1045)"*, hardened by `a252ab6`. Current `.claude/hooks/stop-cycle-check.sh:42` emits `hookSpecificOutput.additionalContext` via jq with a stderr fallback at `:44-46`. **No doc drift left to fix:** CLAUDE.md's stale "Informational nudge at turn end" line was already removed by `e74a49a` (an ancestor of this document's own commit), and `.claude/hooks/README.md:57` describes the hook accurately ("emits an informational nudge") |
| #1197 **cause (a) only** | after D-15 | Two proofs. CDN self-healed: run 31027157696 (v0.20.1) prints `LATEST_RELEASE_150: 150.0.4078.110` / `Edge WebDriver: 150.0.4078.105 (exact runtime match)`, zero `miss` lines. Workflow hardened: `d3c0a6f` via merge `771a289` (PR #1261) added the `$pinned` table at `.github/workflows/tauri-webdriver.yml:135` plus in-major walk-back at `:158-222`. **The issue stays open on cause (b).** |
| #630 | if D-13 answers "close" | All items 1-3 shipped 2026-06-08 in `01e8adc`; remaining 4-7 are diagnostics-only |
| #321 | if D-7 answers "close" | Precondition verifiably unmet — Hocuspocus hard-bound to loopback (`src/server/yjs/provider.ts:107-112`); Cowork reaches Tandem via a host-side stdio proxy (ADR-023, `docs/decisions.md:172`); launcher forbidden from a wildcard bind except behind an opt-in that is itself unbuilt (`src-tauri/src/integrations_probe.rs:322-324`: "MUST NEVER set `TANDEM_BIND_HOST=0.0.0.0` **unless the user has opted into LAN mode with an auth token** (#477 PR 4 out of scope)") |

---

## Parked list

| Issue | Park reason | Concrete unblocking condition |
|---|---|---|
| **#1199** | Its own trigger is unmet: it says "Blocked on the RC tag existing" and asks for a re-audit "against the RC-tag tree". No RC tag exists (`git tag --list "*rc*"` → only `archive/pr285-round3-backup`; newest release tag v0.20.1). The 2026-08-05 run was a **pre-RC pass on master** — `30126ba` is docs-only (`git show --stat` → `docs/roadmap.md \| 7 ++++++-`), it *records* a sweep, it did not perform one. Scope bullet 3 (surfaces wired by the licensing/local-model flips) is un-runnable by construction: `tsup.config.ts:20 const LICENSE_GATE_ENABLED = false`, `src/shared/constants.ts:67 export const BYO_MODELS_ENABLED = false` | An RC tag exists **and** both flag flips have landed. (#1292 resolving is a separate precondition for the gate's zero-HIGH threshold; it does not by itself unblock the re-run.) **Action now:** link #1291–#1295 + #1310 into the body so the pre-RC pass isn't re-done |
| **#1123** | Not stale — the M0 kill gate was resolved **14 days early**, 2026-06-18 in PR #1141 (`f8536ad`), verdict at `docs/spikes/local-llm-capability-spike.md:3`. But the flip is security-blocked, and the issue body is now a stale planning document (advertises a future kill date, promises "full-collaborator depth", pins M1-M4 to v0.17.0 — void per `docs/roadmap.md:558`) | (a) #1292 resolved (`docs/roadmap.md:616` records it as flag-flip-blocking), then (b) the one-const flip at `src/shared/constants.ts:67`, after which per-agent accept/dismiss routing and the E2E stub-server harness become buildable. **Action now:** post the Stage A recommended comment verbatim and strip "M0 spike runs now, kill date 2026-07-02" from the title — the single most misleading string in the tracker |
| **#1134** | Per plan. Offline annotation queuing is a design-shaped feature with no v1.0 gate | A v1.0 decision that offline editing is in scope |
| **#1142** | Per plan. `.docx` confidence umbrella; Phase 0 shipped, remainder is post-v1.0 surgical-patch work | Post-v1.0 |
| **#1252**, **#1249** | Sequential after D-8. Successors of #438; #1249's fix and #1252's timing both depend on #1253's empirical answer | #1253 (Wave 4b-B) lands |

---

## Dropped with reasons

- **PR #1265** (Codex integration) — a **pull request**, not a backlog issue; explicitly paused by Bryan 2026-08-04 with the PR in draft. Not resumed unprompted. Does not consume a triage slot.
- **PR #1311** — a pull request; its disposition is D-11's output, not an independent item.
- **#1310's `docx-apply.ts:489` citation** — noted as imprecise (that line is inside `applyTrackedChanges`, the *apply* path, not the import fan-out; the real fourth import reader is `docx-comments.ts:133`). Not dropped — it makes the issue *understate* the defect, and `docx-apply.ts` has four further ungated reads at `:708`, `:765`, `:811`, `:837`. Correct the citation when the fix lands.
- **#1306 / #1307 body verification** — Stage A flagged both as UNVERIFIED (out of its scope). Assigned to waves on title-and-shape grounds. **The implementer verifies before fixing**; if either turns out non-defective, bounce it back rather than fixing to spec.
- **Hardware-gated release smoke rows** — unchanged and deliberately not triaged; per the `no-hardware-for-release-smoke` convention, record the skip. (v0.20.x did land the first real macOS passes.)

---

## Invariant check

**Every one of the 47 open issues carries exactly one primary state.** Full assignment:

- **Wave (17):** 1310, 1292, 1293, 1294, 1295, 1307 · 1289, 1270, 1269, 1306 · 1213, 1118 · 1298, 1299, 1300 · 1288, 1253
- **Fixed by an open PR (1):** 1302 (PR #1304, pending merge) — a state synthesis lacked; see the correction at the top
- **Decision brief (25):** 989, 964, 928, 916, 892, 832 · 316, 317, 552 · 997 · 995 · 994, 1262 · 992 · 321 · 438, 1249, 1252 · 798 · 1263 · 1308 · 1287 · 630 · 1045 · 1197
- **Parked (4 primary):** 1199, 1123, 1134, 1142 — plus 1252 and 1249, which are **sequential** (brief-438 first, then park; counted under brief above, listed again under Parked)
- **Close (0 primary):** every close is sequential behind a brief

**Issues appearing in two states — all SEQUENTIAL, declared:**

| Issue | Sequence |
|---|---|
| #1213 | brief (D-14) **→ then** Wave 3-A. Wave 3 does not start until D-14 is answered. |
| #1253 | brief-438 (D-8) **→ then** Wave 4b-B. |
| #1249, #1252 | brief-438 (D-8) **→ then** parked behind #1253. |
| #832 | brief-design-shelf (D-1) **→ then** Wave 5 (the left-rail carve-out). |
| #1287 | brief (D-12) **→ then** Wave 5 (copy pass). |
| #995, #994, #1262, #992, #798 | brief **→ then** Wave 5. |
| #892, #997, #438, #798, #1263, #1308, #630, #321 | brief **→ then** close. |
| #1045 | brief (D-16) for item (b) **→ then** close item (a) regardless of the answer. |
| #1197 | brief (D-15) for cause (b) **→** close cause (a) regardless; issue stays open. |
| #1199, #1123 | park **→ and** a body/title correction action *now*, which does not change the state. |

**Issues with no state: none.**

**One count reconciliation:** 17 wave + 25 brief = 42; 1249 and 1252 are counted in the brief bucket (they park only *after* brief-438 is answered), so primary-parked is 4 (1199, 1123, 1134, 1142) and the totals are 17 + 25 + 4 = **46**. The 47th is **#1302**, in the fixed-by-open-PR state — precisely the state the correction block at the top of this document was written to introduce. Explicit full enumeration of all 47 in issue order, one state each:

316·B 317·B 321·B 438·B 552·B 630·B 798·B 832·B 892·B 916·B 928·B 964·B 989·B 992·B 994·B 995·B 997·B 1045·B 1118·W3 1123·P 1134·P 1142·P 1197·B 1199·P 1213·B→W3 1249·B 1252·B 1253·B→W4b 1262·B 1263·B 1269·W2 1270·W2 1287·B 1288·W4b 1289·W2 1292·W1 1293·W1 1294·W1 1295·W1 1298·W4a 1299·W4a 1300·W4a **1302·PR#1304** 1306·W2 1307·W1 1308·B 1310·W1

= 47. B=25, W=17 (a `→W` arrow means the issue is counted as its eventual wave; Wave 5 is not a scheduled wave here, so all seven brief→Wave-5 issues carry a bare `B`), P=4, PR=1. No issue unassigned, no non-sequential double-state.

**Correction note.** Synthesis originally reported W=19 with #1302 in Wave 2. The invariant it enforced — "exactly one primary state" — was sound; the state *vocabulary* was incomplete. It had no "fixed by an open PR" state, so an issue with a merge-queued fix could only be expressed as unfixed work. That is the failure mode worth carrying forward: an exhaustive-looking partition can still be exhaustive over the wrong set of states.
