# Roadmap

This file holds only what is **ahead**. What shipped is in [CHANGELOG.md](../CHANGELOG.md). The
design history and every older plan are in [roadmap-history.md](roadmap-history.md), a snapshot
frozen on 2026-09-28.

**Keeping it true.** When something ships, delete its line here. CHANGELOG already records it,
and a "DONE" left behind is how the old roadmap drifted. When an issue closes, remove it from
this file in the same PR, or say what replaced it. Every status below carries the date it was
last checked. Re-check before relying on it, and use `gh issue view` rather than trusting a
state recorded here.

_Last reconciled against the tracker, flags and CHANGELOG: 2026-09-28 (v0.28.0)._

## Active — Toward v1.0

> Every core feature rock-solid + redesign complete + pending decisions finalized. Quality > speed.
> — the v1.0 thesis (Bryan, 2026-05-14). The date floats; none is set.

### Where v1.0 stands

The code is essentially complete. What remains is one engineering reshape, the commercial
setup, hardware verification, and two flag flips.

1. **The license surface gate (#1521) has to land dark before the flip.** Its policy is
   **Decision F** (2026-09-06, recorded on #1827 and #1788): restricted mode is *symmetric
   read-only*, and the annotation mutators move from ungated to gated in both halves.
   #1521's own acceptance criteria predate that decision and contradict it (see its
   2026-09-08 comment), so reconcile the issue with Decision F before implementing anything.
   Flipping `LICENSE_GATE_ENABLED` on today's per-tool gate would ship a shape ADR-040 no
   longer describes.
2. **Commercial readiness** — see [the exit criteria](#v100-exit-criteria). The live
   checklist is [licensing-operations.md §8](licensing-operations.md#8-pre-launch-gate-all-of-these-before-a-stranger-can-pay),
   and all of it is unchecked. #1117, the old commercial-infra tracker, was closed on
   2026-06-13 with every box unchecked, so it tracks nothing.
3. **Hardware verification.** This covers the install matrix (#2034). Windows is the only
   platform with a machine on hand.
4. **Two flips at the cut, in two independent systems:**
   - **Licensing.** `LICENSE_GATE_ENABLED` (`tsup.config.ts`) and `LICENSE_UPDATE_ENDPOINT`
     (`src-tauri/src/lib.rs`) flip together. `tests/docs/license-flip-consts.test.ts` fails
     on a half-flip.
   - **Local models.** `BYO_MODELS_ENABLED` (`src/shared/constants.ts`) flips for #1123. The
     whole M1a→M4 track is merged dark and has been in the tree since v0.20.0. What remains
     is the flip and its gates.
5. **The pre-v1.0 review's remainder.** 10 of 93 `v1-review` issues are open: #1792, #1822,
   #1823, #1825, #1827, #1920, #1942, #1943, #2001, and #1754 (moot while `.docx` is dark).
   #1942 (key rotation) is dated 2027-03-01 and does not block.

### Decisions still owed

| Question | Where | Why it blocks |
|---|---|---|
| **Pricing.** Still unset. #1117 tracked it and closed with it unchecked, and licensing-operations.md §8 does not have it. ADR-040 §6's LLC requirement was withdrawn on 2026-10-09 (no company will be formed); whether an accountant is wanted before taking money was not decided then and stays here. | ADR-040 §6 | Nothing else tracks it |
| **`LICENSE` in every artifact.** `LICENSE` now names the desktop app and the Claude Code plugin, but the desktop bundle ships no copy (review C6, decision B7), no artifact ships a third-party notices file (B8), and the plugin marketplace entry installs from the default branch rather than a release, so it belongs to no version (decision A7's `ref` pin). | [2026-10-01 licence review](reviews/2026-10-01-license-review.md) C6, L1 | BUSL requires the License displayed on each copy |
| **The grandfather cohort.** Who gets a free license, and do `README.md`, ADR-040 §3 and the in-app copy all say the same? | [licensing-operations.md §1c](licensing-operations.md#1c-the-cohort-problem-settle-this-before-the-flip) | The README already makes a public promise |
| **Whether `tandem deactivate` is required.** It is if EU resale law makes a remove-license path mandatory. | #1943, licensing-terms.md §6 | The licensor's reading of that law decides whether it joins the commercial gate |
| **Two-window Solo/Tandem policy.** A second window can flip the mode, which lets Solo-held comments reach Claude. | #1899 | Adopt, re-assert, or stay warn-only |

**"At RC" means the build intended to become v1.0.0, checked before the tag.** Under Decision
G (#1748), any tag containing `-` publishes as a prerelease, and Bryan does not expect RC
tags in this repo. So wherever a criterion below says "at RC", run it on that build.

### Dated checkpoints

These are recorded here so they surface. Each one has a tracked issue, and at its date the
outcome is keep, replace or retire.

| Date | Issue | Checkpoint |
|---|---|---|
| monthly — next 2026-10-29 | #1506 | Has Claude Code gone modern-only? Last pass 2026-09-29: no |
| 2026-11-01 | #1345 | Revisit packaged-desktop WebDriver smoke (workflow disabled 2026-08-08) |
| 2026-11-09 | #1363 | Native theme push on Linux |
| 2026-11-30 | #1687 | Converge the lifecycle result families |
| 2026-12-01 | #1728 | Make `coverage` a required check, or record that its floors stay advisory |
| 2026-12-01 | #1712 | Verify the app.css citations in the design-spec docs |
| 2026-12-15 | #2015 | Claude Code function hooks as a fifth push path |
| 2027-02-24 | #1599 | Accepted: config-mutation lost-update race |
| 2027-02-26 | #1633 | ui-inspector screenshots on Windows |
| 2027-02-28 | #1671 | Accepted: caller-named write destinations |
| 2027-03-01 | #1942 | Rotate the license signing key |

### Open work that bears on v1.0

This is a selection, not the full open list: issues judged on 2026-09-28 to affect
correctness, security, install or a named gate. Not all of them block. Triage each group
before the flip: fix it, mark it post-v1.0 below, or accept it in
[security.md](security.md#open-findings). For everything else, run `gh issue list`.

- **Security findings:** #1884 (the channel permission relay serves its `description` to local callers; its LAN half is dark under ADR-056), #1885, #1949 (signing-job isolation), #1822 (the v1-review Lows). The RC security sweep is #1199.
- **Sidecar and process lifecycle:** #1988 (orphaned sidecar after a force-quit on macOS/Linux), #1994, #1869, #2041.
- **Correctness:** #2001, #1997, #2064, #2069, #2070, #1981 (the 100 kB body parser shadowing `/api`), #1982, #1980, #1662, #1632, #2009, #1920, #2112, #1523.
- **Distribution and setup:** #1533, #1610, #1704, #1895, #1792, #1354 (the plugin monitor can't be resolved from a GUI launch).
- **Tutorial gate:** #1696, #1725, #1711.
- **Accessibility gate:** #1721, #1683.
- **CI and tests:** #1831 (`claude-code-review.yml` dead since 2026-05-27), #1862, #1911, #1937, #2073, #1333, #1734.
- **Dependency majors:** #1857 (tiptap 3 + hocuspocus 4 + zod 4 + TS 7), #2098, #2099, #2100.
- **Docs owed:** #2075.

## Shelved

- **`.docx` support (2026-09-24, [ADR-053](decisions.md#adr-053-docx-ships-dark)).** It is out of the live build behind `DOCX_ENABLED` because it wasn't ready for serious work. The code stays merged and tested. Re-enabling it is ADR-053's checklist (#2110), not a one-line flip. #576 shipped it, and #1142 is the open umbrella for editing `.docx` with confidence. The history file's Step 5b and Word Comment Import sections describe what it did while it shipped.
- **Tandem's Cowork setup (2026-10-02, [ADR-055](decisions.md#adr-055-cowork-setup-ships-dark)).** It is out of the live build behind `COWORK_ENABLED`, and Cowork is out of v1.0. The route the setup builds was never verified against a desktop app whose server is pinned to loopback. The code stays merged and tested. Re-enabling it is ADR-055's checklist (#2134), which starts with the transport matrix retired from #1455.
- **SuperDoc as the `.docx` engine (2026-09-24, ADR-052).** Shelved after the engine spike reported NO-GO on nine of its ten questions.

## Integration Policy (ADR-038)

Tandem's integration contract is **MCP**. The default integration is **Claude** (Claude Code
and Claude Desktop). It is what we recommend and test against, and Claude-specific extras
are built around it. Any MCP-capable client can connect to the same endpoint and use the same
tools. Other clients are best-effort: compatible with the MCP contract, but not validated.

Four push paths wake a Claude session, and none is the default at setup:
- **Self-armed `/api/wake` watch** (ADR-049). It is recommended first, but only where Claude Code offers a Monitor tool.
- **Plugin monitor.**
- **Opt-in channel shim** (`--with-channel-shim`), which is the fallback.
- **Supervisor stdin**, for auto-launched sessions.

Pull (`tandem_checkInbox`) is always authoritative. Integration setup runs through the
wizard, and Tandem never adds an integration without it. (The boot sweep does rewrite Tandem's
own existing MCP entries to keep them converged.) The browser UI stays: removing it would need
a fresh decision, the install matrix, and an announcement (#1467). Full policy:
[ADR-038](decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration).

## v1.0.0 Exit Criteria

Each criterion below carries a status, checked 2026-09-28. The last recorded hardware smoke is
[the v0.25.0 run](release-smoke-checklist.md#what-the-v0250-run-settled). None is recorded for
v0.26.0, v0.27.0 or v0.28.0.

**Install matrix (D12 = full parity). UNMET. Tracker: #2034.**
- Windows 10 22H2 and Windows 11 23H2. Only Windows 11 build 26200 has been observed. On it, a fresh install passed on the v0.22.1 run. The updater and file association (cold and warm) passed on the v0.22.1 and v0.23.0 runs, and the updater passed again on v0.25.0.
- macOS 14 Sonoma, on both Intel and Apple Silicon, as a notarized `.app` with no Gatekeeper warning. The v0.25.0 build notarized with "Accepted". Two real-hardware observations exist (Gatekeeper silent, updater v0.19.0→v0.20.0), but the OS and CPU went unrecorded, so neither ticks this row.
- macOS 26.1 on Apple Silicon (M1). Unobserved.
- Ubuntu 22.04 LTS (`.AppImage` and `.deb`). `.deb` install-and-load is automated per tag in an `ubuntu:22.04` container. The AppImage is unobserved.
- Fedora 39 (`.rpm`). The per-tag container is **Fedora 44**, not 39. Either change the criterion or run 39.
- Windows `.msi`. `bundle.targets` is `"all"`, so an MSI ships, but no smoke row covers it.

**Functional gates**
- **Claude Code CLI works zero-config:** loopback-exempt, and tools work unchanged. Checked at RC.
- **Claude Code version compatibility.** UNMET. At RC, the connect → tools → wake → reply loop runs against the current stable Claude Code and the latest release of the previous minor, and the report records both versions. "Wake" means the self-armed `/api/wake` watch where a Monitor tool exists, falling back to the channel shim where it does not, and the report says which path each run used. It also needs a #1506 pass dated within the RC window; that check is what guards against a *future* Claude Code release. #1505 (serving MCP `2026-07-28` alongside the legacy protocol) needs a migration to the v2 SDK packages (`@modelcontextprotocol/server` and friends, per #1506's 2026-09-29 pass), so until it lands a modern-only Claude Code would break Tandem outright.
- **Tauri update flow.** PARTIAL. Download → install → restart must work on all three platforms, with the sidecar restarting and no data loss. Observed on macOS once and on Windows three times, most recently v0.24.1→v0.25.0 (closing #1596). Linux has not been observed. The `MayHaveFailed` arm, which should show the banner, is untested. A successful update writes nothing to `tandem.log` at the release log level, so someone has to watch the window.
- **Tutorial.** PARTIAL. It must complete end to end on `sample/welcome.md` with anchors holding. The anchor regression test exists (`tests/design-system-impl/tutorial-anchor.test.ts`). Open: #1696, #1725, #1711.
- **Dark/light toggle** works on desktop and in the browser. No recorded run.
- **First-run wizard and keychain.** UNMET. One-click Claude Code connect has to work on all three platforms (detect → connect → `/mcp` shows Tandem's tools). The OS keychain must also pass a store→read round-trip on Windows Credential Manager and macOS Keychain, which CI cannot do. The rows exist in the smoke checklist (§1–§2, #1761), but no run of them is recorded.
- **Updater banner and dot.** PARTIAL. The dot was observed on the macOS update run, and the Windows runs recorded the in-app banner. The dot clearing, on opening settings or on install, was not recorded.
- **Local model.** UNMET, and verifiable only after the `BYO_MODELS_ENABLED` flip. Run a ≥14B model via Ollama, fully offline. The chat round-trip is the default-on tier. With the experimental editing toggle on, the model reads the document, comments on the user's selected text, and proposes a replacement that the user accepts or rejects. Multi-step and 50-page autonomous flows are out of scope. See ADR-039.

**Soak gates**
- **Observer soak.** UNMET, with no recorded run. Six docs open, rapid tab switching, Y.Doc swaps, and network drop and reconnect, with zero leaks and zero broken observers. Then a one-hour session with 50+ annotations, 20+ tab opens and closes, and 5+ network blips.
- **Claude config JSON shapes corpus.** PARTIAL. It is automated in `tests/server/integrations/apply-malformed.test.ts` (#645). The named-pipe transport, 5 MB+ and concurrent Claude Desktop write shapes have not been confirmed individually.
- **AR5 `.docx` batch-promote soak.** Suspended while `.docx` ships dark. Restore it with ADR-053's re-enable checklist (#2110), which un-skips the automated `batch-promote` E2E specs but does not mention this manual row.

**Security gate.** The threshold is **zero unresolved HIGH findings**, self-graded by the `security-reviewer` agent.
- The last full run, on 2026-08-05, failed with two HIGHs. Both are now fixed: #1291 by PR #1296, and #1292 through the #1340 work. The threshold has been met since #1292 closed on 2026-09-08.
- The RC re-run (#1199) is still owed. It covers every HTTP route added since v0.13.0, enumerated by diffing the route registrations, plus outbound surfaces the diff cannot find (the local-model client's SSRF posture). The method is the three-surface audit (CORS × Host header × loopback-vs-LAN) plus path validation. The LAN leg now checks that a release build cannot listen beyond the machine (ADR-056), rather than auditing what a LAN peer reaches.
- The open findings listed above in *Open work that bears on v1.0* are in scope.
- Full history is in [security.md](security.md#open-findings) and in the history file.

**Performance gate.** PARTIAL. See [perf-gate-results.md](perf-gate-results.md).
- **Pass conditions** on the smoke-checklist machines, using the ~50-page fixture from `scripts/fixtures/make-perf-doc.mjs`:
  - open-to-interactive under 3 s
  - an annotation create or accept reflected in the editor under 500 ms
  - no frame stall over 100 ms during a scripted scroll
- **Run 3 (2026-09-11)** passed every condition on one Windows 11 workstation. macOS and Linux were never measured.
- **Open:** #1333 (condition 3 uncharacterised on Windows) and #1734 (its last comment calls it closeable).
- **If a run fails, that is a finding to fix, not a reason to relax the numbers.** [perf-gate-results.md](perf-gate-results.md) relies on this rule.

**Commercial readiness.** UNMET. This gates the license flip. If it is not ready at code-complete, the date floats and **the gate flag does not ship enabled**. A v1.0 demanding a license nobody can buy is a brick.
- Pricing settled, and the accountant question answered (ADR-040 §6; see above).
- **MoR checkout live end to end:** a test purchase goes through the issuance webhook, the signed license is delivered, and it activates a gate-ON build.
- Grandfather licenses issued to the cohort decided under §1c.
- **[licensing-operations.md §8](licensing-operations.md#8-pre-launch-gate-all-of-these-before-a-stranger-can-pay) is complete.** §8 owns the item list, and several of its items fail silently if skipped. For example, the issuance Worker's Ed25519 key import has never run on real Cloudflare, and a failure there returns 503 on every webhook. Two items need more than their checkbox says:
  - **Terms, refund policy and privacy notice.** None exists. [licensing-terms.md](licensing-terms.md) is a working draft. No counsel is being consulted, so the licensor writes the final versions.
  - **The beta-cohort claim path.** Decide who is grandfathered, and make the banner and wall copy name the beta offer (§1c item 2). Keys go out privately, never in an issue or comment: verification is offline, so anyone can activate a key that has been posted publicly.

**Accessibility.** PARTIAL. See [a11y-gate-results.md](a11y-gate-results.md).
- Windows Narrator and macOS VoiceOver full walkthroughs are both **unrun**. Each needs a human at a real OS.
- Forced colors, the axe-core scan, keyboard-only navigation, and WCAG AA contrast across all status colors and themes all **pass**. Contrast must be re-verified after any redesign. The axe scans exclude the editable document, whose colours are measured separately.
- Open: #1721 (axe contrast failures land in `incomplete` and go unasserted) and #1683 (dark-theme pressed state).

**Cleanup gates**
- **The uninstaller strips all integration entries** on Windows and on macOS `.app` removal, leaving no orphan entries in the Claude config JSON. Unverified: the v0.23.0 run skipped uninstall.
- **Zero open position- or anchor-related bugs.** UNMET. #2001, #1997, #2112, #2114, #1523, #1632 and #2070 are open.
- **Inline decorations show on pending annotations** after MCP creates them, in the Tauri build. No recorded run.

**Documentation gates**
- CHANGELOG `[1.0.0]` section finalized.
- Every redesign artboard is either shipped or deferred with a reason.
- Every locked design decision (D1–D12, in the history file) is linked to an ADR or PR.
- **A bad-release recovery runbook**, written and rehearsed once without moving the real `latest` pointer. None exists today.
  - **Rehearsal build.** Rehearsing needs a way to point a build at a staged manifest. The smoke checklist assumes an "updater endpoint override", but none exists in code: the public endpoint is fixed in `tauri.conf.json`, and the licensed one is a compiled const.
  - **Desktop.** The license update Worker is meant to proxy the same `releases/latest/download/latest.json` (its `wrangler.toml` holds a placeholder until it is deployed), and it adds no caching of its own. So moving GitHub's `latest` pointer back should stop a broken release on both routes. Record how long real clients take to see the change the first time the procedure is used.
  - **npm.** `npm dist-tag` and/or `npm deprecate`.
  - **ADR-043.** This doesn't conflict with [ADR-043](decisions.md#adr-043-updater--no-rollback-no-in-updater-post-restart-health-probe-v1), which rules out *client-side* rollback.

## After v1.0

What is deliberately not in v1.0 and is still open. Closed and shipped rows from the old
deferred table are in the history file.

**v1.1 (committed)**
- **Cloud BYO-model providers** (OpenAI, Gemini, Anthropic API keys) and their adapter. Behind `BYO_MODELS_ENABLED` per [ADR-039](decisions.md#adr-039-non-mcp-model-providers-local-slice-v10-cloud-slice-v11).

**Deferred, open**
- **Diff/Apply-edit hunk staging.** D3 locked option B (modal-based) for a v1.1 *revisit*, which is not a commitment. The surface is the `.docx` Apply-changes flow, so it waits on #2110.
- **Merge and conflicts.** Three-way merge and a side-by-side conflict UI. Keep-vs-reload is what v1.0 has.
- **RANGE_MOVED auto-retry.** The caller retries with relocated coordinates today.
- **Provider-keyed annotation authorship.** Every MCP client is stored as author `"claude"` (#2115). Local models have provider-keyed authorship (M3); other MCP clients don't.
- **Per-provider auto-launchers, and validating MCP clients other than Claude.**
- **Obsidian vaults**, out of scope for v1 (Decision A, #1827). The README says so. Tandem warns once per open when a `.md` file contains a `[[…]]` wikilink.
- **Document groups**, only if demand appears: named groups, cross-reference tools, split panes.
- **Server auto-stop on idle.** Never wired.
- **Review mode:** a threshold banner and document dimming.
- **Platform follow-ups:** #552 (KDE titlebar), #317 (firewall rule scoping for Cowork on macOS/Linux), #630 (a `startup-file-error` event for `request_open_file` POST failures, plus its HTTP tests).
- **Linux tray fallback** when libappindicator is absent. Today the app exits cleanly with no tray.
- **Flag annotations on externally changed text.** Degraded anchors are surfaced to Claude (`anchor: "degraded"`), but the user sees no flag.
- **Design decisions deferred by D2, D5 and D7–D9:**
  - an authorship gutter and its pulses (D2 picked per-character)
  - mobile/responsive (D7)
  - author chip or avatar (D8)
  - compact density (D9)
  - annotation emoji reactions, which are an explicit cut, not a deferral (D5)
- **Desktop shell:** frameless window, vibrancy, multi-window, and a file-explorer sidebar are out of scope per HANDOFF.
- **Re-enabling `.docx`** (#2110).
- **Re-enabling Tandem's Cowork setup** (#2134), with Cowork on macOS/Linux (#316) and the pre-flight enum decision (#1373) behind it.
- **Re-enabling the non-loopback bind** (#2141, ADR-056), with the #1906 decision and the #1952 fix behind it.

## Known Limitations (v1)

These are intentional scope boundaries, not bugs:

- **No `.docx`.** Release builds open `.md`, `.txt` and `.html` (`.html` opens read-only). `.docx` is shelved (ADR-053).
- **No Cowork setup.** Tandem does not set itself up inside Claude Desktop's Cowork, and Cowork is not a supported surface (ADR-055).
- **No LAN exposure.** Tandem listens on this computer only; a non-loopback `TANDEM_BIND_HOST` is refused at start (ADR-056).
- No formula support in tables
- No `.xlsx`/`.csv` support
- No drawing/freeform annotation
- **One human per document.** Several Claude sessions can connect at once (ADR-045), but there is no multi-human collaboration.
- **Documents over ~50 pages.** Tandem warns Claude when one opens. The perf gate passed at ~50 pages on one Windows machine, and larger documents are unmeasured.
- No plugin/extension architecture — custom extensions require code changes

## Future Extensions (v2+)

- **Progressive Web App (PWA)** — Lower priority now that the desktop app ships. Would still be useful as a lighter-weight alternative for users who prefer not to install a native app.
- Further model providers beyond v1.1's cloud slice, through the same registry surface (ADR-039)
- Spreadsheet component (Handsontable/AG Grid)
- Drawing/freeform annotation layer
- Exportable annotated documents as PDF (Markdown and JSON annotation export already ship)
- Code editing mode (CodeMirror 6)
- Standalone mode with a direct Anthropic API connection (no MCP client required) — an alternative to the MCP integration path, not a replacement
