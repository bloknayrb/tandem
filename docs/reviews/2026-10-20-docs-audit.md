# Documentation audit — 2026-10-20

A whole-repo documentation audit, run on 2026-10-20 against master at `a8435c0`. It checked
every live document against the code: user docs, setup and configuration references, the
security and licensing docs, the release and operations runbooks, the design-system set, the
developer reference, and the agent instructions (`CLAUDE.md`, `AGENTS.md`). The fixes ship in
the same PR as this file. Two follow-up PRs are planned (see [Follow-ups](#7-follow-ups-planned)).

## 1. Summary

**How it ran.**

1. **Planning pass.** Three Explore agents mapped the doc set, split it into live and
   historical documents, and recorded first findings (IDs `P`, `S`, `D`).
2. **Audit.** Five agents each took one area: security and data (`SEC`), licensing (`LIC`),
   ops and release (`OPS`), the design system (`DS`), and cross-doc consistency plus
   `CLAUDE.md`/`AGENTS.md` (`X`, `AG`). With the planning pass, that makes six raw finding
   sets.
3. **Verification.** Three verifier agents re-read the cited code for every finding. Each
   finding got a verdict (CONFIRMED, MODIFIED or REJECTED), a class, and a list of the tests
   that pin the text it touches.
4. **Fix.** Seven fix agents each owned a disjoint set of files. When a fix belonged in a file
   an agent did not own, the agent handed it off. A final handoffs pass applied those.

**Verdicts (250 verified rows).** Findings reported twice are counted once per row. Rows
S01–S05 cover five screenshot slots, and MERGE-METHOD is a decision record, not a doc defect.

| Verdict | Rows |
|---|---|
| CONFIRMED | 213 |
| MODIFIED (the verifier corrected the claim or the fix) | 35 |
| REJECTED | 2 |

**Classes.**

| Class | Rows | Meaning |
|---|---|---|
| DOC | 227 | Documentation change only. Includes LIC20, which also carries a counsel question. |
| BRYAN | 10 | Needs a maintainer decision. |
| CLAUDEMD | 7 | Edits agent instructions in `CLAUDE.md` or `AGENTS.md`. |
| CODE | 4 | The code or a code comment is wrong, not the doc. |
| SHOT | 2 | Stale screenshots. |

**Outcomes.**

| Outcome | Rows | Which |
|---|---|---|
| Fixed in this PR | 232 | Includes five rows fixed as far as a doc can go that still need a decision: P06, LIC01, LIC20, OPS08, OPS22 |
| Deferred | 3 | S01–S05 and S06 (screenshots PR); P43 (code issue) |
| Needs maintainer, no change made | 8 | LIC02, LIC27, LIC29, OPS15, OPS20, OPS29, OPS32, MERGE-METHOD |
| No action | 7 | D12 and D13 (rejected), D20 (historical), LIC34, LIC35, X15 and X16 (informational) |

The fix agents also found issues the audit had missed. They appear as `new` rows in the
tables below. The ones not fixed here are recorded under
[Code issues](#6-code-issues-found-not-fixed-in-this-docs-pr) and
[Follow-ups](#7-follow-ups-planned).

## 2. Method and scope

**Live versus historical.** A live doc claims to describe the product as it is now, and every
live doc was checked against source. Historical sets are dated records of what was true or
planned at the time: earlier reviews under `docs/reviews/`, the design-system phase plans and
previews, design notes, plans, and the 2026-06-18 licensing design spec. These were
**indexed, not rewritten**. A historical file got at most a status banner saying that it is
historical and what superseded it. ADRs follow the same rule: where an ADR's record had gone
stale (ADR-031, ADR-046), the fix adds a dated amendment and leaves the original text alone.

**Pinning constraints.** Several things decided the shape of a fix, not just whether it passed:

- **Claim tests under `tests/docs/`.** Many docs carry sentences, counts or headings that a
  test parses. Examples:
  - The security findings register: bullet openings, the accepted-findings count, and one
    verbatim predicate.
  - Trial-length wording in the README and the licensing docs.
  - The licence flip constants and the AI-surface inventory.
  - The loopback-gate enumeration.
  - Wording about Real-time updates and the plugin monitor in the README and user guide.
  - The channel-shim opt-in rule.
  - Session-file names.
  - The slash-menu alias list.
  - The batch/bulk layout phrases in the derived spec.
  - The semantic-token inset values.
  - The issue and PR templates.

  Fixes reworded around these pins and kept every pinned phrase. Two repo-wide wording sweeps
  (`stateless-transport-claims` and `cwd-dependent-checks-claims`) scan all of `docs/`. For
  that reason this report paraphrases each stale claim and quotes none.
- **The Rust `include_str!`.** [release-smoke-checklist.md](../release-smoke-checklist.md) is
  compiled into a `src-tauri` test that matches three literal log lines in it. Its edits left
  those lines byte-identical.
- **Shipped docs.** Some files reach users as they are, so a mistake in one is a product bug:
  - [workflows.md](../workflows.md) and [CHANGELOG.md](../../CHANGELOG.md) are bundled in the
    desktop app and opened read-only there. Relative links in them do nothing in the app, so
    both now use absolute repository URLs. A new test, `tests/docs/shipped-doc-links.test.ts`,
    guards both files.
  - [sample/welcome.md](../../sample/welcome.md) carries the tutorial anchors and has a test
    fixture copy, which was updated with it.
  - [skills/tandem/SKILL.md](../../skills/tandem/SKILL.md) is installed into user sessions.
    Its edit bumped the frontmatter version, so the startup refresh will deliver it.
  - The `data-testid` snapshot, not the manifest, is the selector contract.

**Rules the fixes followed.** User docs got no source line numbers and no internal jargon.
Dev docs cite a symbol or a section, not `file:line`, wherever nothing pins the line form.
Dark features (`.docx`, Cowork setup, the licence gate, local models, the LAN bind) are never
described as available.

## 3. Findings by area

Each row paraphrases a finding and does not quote the stale text. "Handoffs pass" means a fix
agent routed the item to the final cleanup pass, which applied it in this PR. "§5" and "§6"
refer to the sections below.

### User docs

Covers [README](../../README.md), [user-guide.md](../user-guide.md),
[troubleshooting.md](../troubleshooting.md), [workflows.md](../workflows.md),
[integrations.md](../integrations.md), [positioning.md](../positioning.md),
[welcome.md](../../sample/welcome.md), the shipped [SKILL.md](../../skills/tandem/SKILL.md)
and the demo script.

| ID | Severity | Where | Finding (paraphrased) | Outcome |
|---|---|---|---|---|
| P01 | high | user-guide, positioning | Said the file on disk changes only when you save. Edited `.md`/`.txt` files autosave every 60 s and at quit. | Fixed. New Autosave paragraph. positioning.md fixed in the handoffs pass. |
| P04 | high | workflows | Described Solo as a hold in both directions that hides the AI's annotations. Only your outbound comments are held; the AI is asked to wait. | Fixed |
| P05 | high | user-guide, troubleshooting | Named a disconnection message the UI no longer shows. | Fixed. Covers the empty-state notice and the delayed banner with its setting. |
| P06 | med | README | Pointer promised pricing in a License section that gives none. | Pointer reworded; price decision in §5 |
| P07 | med | README | Real-time-updates text was duplicated, and the user copy linked into the developer block. | Merged into one top-level section; pinned phrases kept |
| P08 | low | README, troubleshooting | Named a relaunch button that does not exist. | Fixed. Names the status-bar restart and the palette command. |
| P09 | low | README | Did not say the plugin also adds a channel entry, which stays inert without the flag. | Fixed |
| P10 | low | README | Implied that a note is private only when marked. | Fixed. All notes are private. |
| P11 | low | README | Implied one-click setup is missing on macOS/Linux. What remains is hardware verification. | Fixed |
| P12 | med | user-guide | Put Replay tutorial in the wrong settings tab. The sidebar footer was undocumented. | Fixed |
| P13 | med | user-guide | Left out AI Assistant tab controls: selection sensitivity, the floating toolbar, and Tandem's Claude start mode and run length. | Fixed |
| P14 | med | user-guide | Called spellcheck opt-in. It is on by default. | Fixed |
| P15 | med | user-guide | Did not document the AI pill's standby states or its Start action. | Fixed |
| P16 | med | user-guide | Did not document the chat panel's Start control, its resume state, the Claude Code offer or the greeting. | Fixed |
| P17 | med | user-guide | Had no section on a file changing on disk while it has unsaved edits. | New section |
| P18 | low-med | user-guide | Shortcut tables were missing several bindings. | Fixed |
| P19 | low | user-guide | Presented slash-menu aliases as filters, but some only display. | Fixed; pinned alias list kept |
| P20 | low | user-guide | Did not document several shipped surfaces: heading collapse, the brand menu, the tray, banners, scratchpad recovery and saved sessions. | Fixed |
| P21 | low | user-guide | Carried a version-specific caveat about something unmeasured. | Dropped |
| P22 | low | user-guide | The Solo push row named only some of the external push consumers. | Fixed; all four named |
| X06 | med | user-guide | The push paragraph named a selection event type that does not exist. | Fixed |
| P23 | low-med | troubleshooting | The quick diagnostic implied the channel entry is required. | Fixed; marked optional |
| P24 | low | troubleshooting | Named Cowork in a comparison while Cowork setup ships dark. | Removed |
| P25 | low | troubleshooting | Did not name the palette command that starts a fresh conversation. | Fixed |
| P26 | low | troubleshooting | Had no entries for read-only settings or an update that did not finish. | Added |
| P27 | low | troubleshooting | Listed `.htm` without saying the installer does not register it. | Note added; `.htm` kept (pinned) |
| P33 | med | workflows | An example had the AI leave highlights. It leaves comments. | Fixed |
| P34 | med | workflows | Got scratchpad close and recovery wrong, and suggested a create route the open tool cannot take. | Fixed. The fix agent also corrected the verifier on what happens after a confirmed close. |
| P35 | low | workflows | Gave the wrong location for the tutorial highlight and the wrong completion rule for step 2. | Fixed |
| P36 | low-med | workflows | The in-app guide carried a contributor E2E section and personal example paths. | Moved to CONTRIBUTING; neutral paths here and in mcp-tools |
| D19 | med | workflows | Relative links do nothing in the copy bundled with the desktop app. | Absolute URLs; new shipped-doc-links test |
| P37 | low | integrations | Listed a local model runtime as an MCP client. The ADR quote had no plain-language gloss. | Fixed; quote untouched |
| P39 | low | positioning | The `.docx` moat paragraphs read as current. | Shelved notes added |
| P40 | low | positioning | Named a control that does not exist and a removed tool. The last-updated stamp was stale. | Fixed |
| X09 | low | positioning | Presented local-model support as shipped. | Marked as v1.0 |
| P41 | low | shipped SKILL.md | Gave the wrong label for the working-directory setting. | Fixed; skill version bumped, contract test updated |
| P42 | low | welcome.md | Got four things wrong: outline collapse, Ctrl+N, the Settings shortcut, and desktop auto-start. | Fixed; tutorial anchors intact |
| X08 | low | welcome.md | Said the AI leaves highlights. | Fixed; test fixture updated with it |
| X07 | low | README | Described the plugin monitor without its Monitor-tool precondition or the shim fallback. | Fixed |
| X13 | low | README | The quick start did not mention autosave. | Fixed |
| DS70 | med | demo script | A demo step had the AI make a highlight. | Changed to a user highlight |
| P43 | low | filter bar (code) | Shows the Imported chip while `.docx` is dark. | Code issue, §6 |
| new | — | user-guide | Documented a link shortcut that nothing binds. | Doc claims removed; code issue, §6 |
| new | — | user-guide | The License tab row promised trial status while the gate is dark. | Fixed |
| new | — | integrations | An awareness bullet named selection events. | Fixed |
| new | — | README | Said beta users skip the trial outright. They skip it by activating their key. | Fixed (handoffs pass) |

### Setup, CLI and configuration

Covers [configuration.md](../configuration.md), [cli.md](../cli.md) and the CLI help text.

| ID | Severity | Where | Finding (paraphrased) | Outcome |
|---|---|---|---|---|
| P02 | high | configuration, troubleshooting | The app-data tables listed only the npm paths. | Desktop column added; links to data-locations |
| P03 | high | configuration | Said the app-data override also moves the auth token. | Fixed. Gives the npm path and says the desktop uses the keychain. |
| P31 | med | configuration | Presented the transport variable as an ordinary choice. | Now says it selects a legacy mode; leave it unset |
| P32 | med | configuration | A developer note said test runs free the product ports. | Rewritten. Points at the reserved ports in `scripts/test-ports.ts`. |
| P28 | low | CLI `--help` | The start command's help said it opens the editor. It only prints the URL. | Fixed in `src/cli/index.ts` |
| P29 | low | cli | Gave contributor npm scripts no clear audience. | Intro relabelled; heading kept (inbound anchor) |
| P30 | low | cli | Named an internal remote flag. | Generic wording |
| D18 | low | cli | Called the HTML baseline gallery screenshots. | Fixed |

### Security and data

Covers [security.md](../security.md) and [data-locations.md](../data-locations.md). Every
register edit kept the parsed bullet openings, kept the accepted-findings count, and changed
no finding's status.

| ID | Severity | Where | Finding (paraphrased) | Outcome |
|---|---|---|---|---|
| SEC01 | med | security | Cited the CORS allowlist by stale line ranges. | Cited by symbol |
| SEC02 | med | security | The WebSocket/Host paragraph had stale cites, and its Host-allowlist contrast needed restating. | Fixed. The verifier corrected the audit here. |
| SEC03 | med | security | The body-limit paragraph had stale cites. | Cited by symbol |
| SEC04 | low | security | The #1488 entry got wrong how its handlers sit relative to auth. | Fixed |
| SEC05 | low | security | Named only one of the two SSE streams. | Both named |
| SEC06 | low | security | Miscounted the save skip-returns, in both the doc and the audit. | Count corrected; missing conditions added |
| SEC07 | low | security | The convert-path realpath narrative was stale. | Updated; the rejoin is scoped to annotations |
| SEC08 | low | security | The #2037 entry's line cites had drifted. | Statement cites; pinned predicate kept verbatim |
| SEC09 | med | security | The #1599 entry's cites had drifted, including in its void condition. | Cited by symbol |
| SEC10 | low | security | The #1654 entry's cites had drifted, and the audit had misplaced them. | Cited by symbol |
| SEC11 | low | security | The #1666 entry used bare line cites. | Cited by symbol; historical pinned range left |
| SEC12 | med | security | The #1609 entry counted three unscreened reads, but one is now screened. | Re-scoped to two |
| SEC13 | low | security | Cited a doctor symbol that no longer exists. | Replaced |
| SEC14 | low | security | Gave line cites for the licence constant, the permission capability and the session dir. | Cited by symbol |
| X04 | med | security | Got wrong where the token file lives relative to the app-data override. | Fixed |
| SEC15, P38 | med | data-locations | Said the keychain store status is never checked. | Fixed; only the real-machine round trip is unverified |
| SEC16, X05 | med | data-locations | Called the auth-token file npm-only. The desktop creates or adopts it as the keychain fallback. | Fixed |
| SEC17 | med | data-locations | Did not mention the temp file an interrupted save leaves behind. | Fixed |
| SEC18 | low | data-locations | Said broken Claude configs are quarantined. | Fixed |
| SEC19 | low | data-locations | Was missing rows for the update marker, the desktop sample copy and the models store. | Added; the models store is worded as normally absent |

### Licensing

Covers [licensing-explained.md](../licensing-explained.md),
[licensing-operations.md](../licensing-operations.md),
[licensing-terms.md](../licensing-terms.md), the [update Worker
README](../../infra/license-update-worker/README.md) and the [issuance Worker
README](../../infra/license-issuance-worker/README.md).

| ID | Severity | Where | Finding (paraphrased) | Outcome |
|---|---|---|---|---|
| LIC01 | med | README, ADR-040 | The README price pointer was empty, and an old price range in ADR-040 was not marked superseded. | ADR marker added; README decision in §5 |
| LIC02 | med | roadmap | Lists pricing as unset although a price is recorded. | §5 |
| LIC03 | med | licensing-operations | The update-route bullet contradicted the code. | Rewritten from the route's six arms |
| LIC04, SEC20 | med | update Worker README | The routing step was wrong. | Rewritten |
| LIC05 | low | update Worker README, code comments | Cited a section of ADR-040 that does not exist. | README fixed; comments fixed in the handoffs pass |
| LIC06, SEC21 | low | update Worker README | The no-update reasons and the alerting were incomplete. | Fixed |
| LIC07 | low | update Worker README | The wrangler command was unpinned. | Pinned |
| LIC08 | med | licensing-operations | Activation steps led with the CLI. | Settings → License first |
| LIC09 | med | licensing-operations | Paraphrased the beta-claim path in its old wording. | Fixed |
| LIC10 | low | licensing-operations | Miscounted the facts. | Fixed |
| LIC11 | med | licensing-operations | Pointed to the historical spec as current. | Fixed; spec untouched |
| LIC12 | low | licensing-operations | A section cite pointed at the wrong document. | Fixed |
| LIC13 | low | licensing-operations | Said the KV writer is a deleted webhook. | Fixed |
| LIC14 | low | licensing-operations | Said the ledger lacks a field that it has; the signed blob is what lacks it. | Fixed |
| LIC15 | low | licensing-operations | Left the key id out of the field lists. | Fixed |
| LIC16 | med | licensing-explained | The sample licence had no key id. | Fixed |
| LIC17 | low | licensing-explained | Stated the refusal wire shape imprecisely. | Fixed |
| LIC18 | low | licensing-explained | Cited the file associations by line range. | Fixed |
| LIC19 | low | licensing-explained | Got wrong which installs the trial applies to. | Fixed |
| LIC20 | med | README, licensing-explained, licensing-terms | Did not say that the current LICENSE text has not shipped in any release yet. | Sentence added; README in the handoffs pass; counsel question in §5 |
| LIC21 | low | licensing-explained, licensing-terms | The no-limit sentences were loose. | Fixed |
| LIC22 | low | licensing-explained | The advice for a bad signature skipped updating first. | Doc fixed; app copy in §6 |
| LIC23 | low | licensing-terms | Quoted a code comment that no longer exists. | Fixed |
| LIC24 | low | licensing-terms | Described the licence email in its old form. | Fixed |
| LIC25 | med | licensing-terms | A counsel item was partly answered already. | Narrowed and kept |
| LIC26 | low | licensing-terms | Described the gate as covering the whole app. | Fixed |
| LIC27 | low | licensing-terms, ADR-040 | The ADR status line and the terms header disagree about counsel. | §5 |
| LIC28 | med | positioning | Did not mention the keyless editor grant. | Fixed (handoffs pass) |
| LIC29 | low | positioning | The pricing rationale conflicts with LICENSE. | §5 |
| LIC30 | low | positioning | Cited the wrong ADR section for local models and did not say they need a key. | Fixed (handoffs pass) |
| LIC31, SEC22 | low | issuance Worker README | Listed the wrong set of required configuration. | Fixed |
| LIC32 | low | issuance Worker README | Was worded as if part of an old PR. | Fixed |
| LIC33 | low | three licensing docs, data-locations | Used the wrong ADR-040 anchor. | Fixed |
| LIC34, LIC35 | info | — | Sweep and pin summaries. | No action |

### Ops and release

Covers the [notarization runbook](../428-macos-notarization-runbook.md), the [smoke
checklist](../release-smoke-checklist.md), the [release skill](../../.claude/skills/release/SKILL.md),
[perf](../perf-gate-results.md) and [a11y](../a11y-gate-results.md) gate records,
[stacked-prs.md](../stacked-prs.md), the [hooks README](../../.claude/hooks/README.md),
[`/diverge`](../../.claude/commands/diverge.md), the issue and PR templates, and the CHANGELOG.

| ID | Severity | Where | Finding (paraphrased) | Outcome |
|---|---|---|---|---|
| OPS01 | high | notarization runbook | Recommended a smoke test with a throwaway tag, which the release job refuses. | Rewritten around an RC version bump |
| OPS02 | high | notarization runbook | The intro described the signing secrets as not yet set up. | Fixed |
| OPS03 | med | notarization runbook | Described the wrong behaviour when a certificate is missing. | Fixed |
| OPS04 | med | notarization runbook | Named the wrong step as the one that creates the draft. | Fixed |
| OPS05 | med | notarization runbook | The workflow summary still said steps skip gracefully. | Fixed |
| OPS06 | low | notarization runbook | Mixed bring-up history into the instructions. | Retitled as a rotation/recovery runbook |
| OPS07 | low | release workflow (code comment) | A comment described a graceful no-op. | Comment fixed |
| OPS08 | med | smoke checklist | The forward-update row needs a runtime endpoint override that does not exist. | Marked not runnable; mechanism in §5 |
| OPS09 | low | smoke checklist | Had no check that npm publishing finished before the global-install step. | Row added; the verifier narrowed the claim |
| OPS10 | med | release skill | Named the wrong step as the one that creates the draft. | Fixed |
| OPS11 | low | release skill | Credited the release body to the wrong step. | Fixed |
| OPS12 | low | release skill | The asset breakdown was ambiguous. | Fixed |
| OPS13 | med | release skill, changelog skill | The commit listing missed squash-merged PRs. | Both skills use first-parent |
| OPS14 | low | release skill | The pre-merge commands left out the tests typecheck. | Fixed |
| OPS15 | low | release skill | Has a project-memory step that no tracked file defines. | §5 |
| OPS16 | low | release skill | Did not account for the merge queue's commit or runs. | Fixed |
| OPS17, X01 | med | perf gate record | Described perf runs as using the product ports. | Fixed |
| OPS18 | low | a11y gate record | Gave test counts with no date. | Dated |
| OPS19 | low | a11y gate record | A line cite was stale and its "only consumer" claim no longer held. | Dated |
| OPS20 | med | stacked-prs | Whether stacks go through the merge queue is unknown. | §5 |
| X14 | low | stacked-prs | Did not mention the merge queue. | Fixed |
| OPS21 | low | stacked-prs | A banner had no date. | Dated |
| OPS23 | med | hooks README, hook header | Overstated what the sensitive-file hook matches. | README fixed; header fixed in the handoffs pass |
| OPS24 | low | hooks README, hook header | Gave the wrong frequency for the stop-cycle reminder. | Same |
| OPS26 | low | hooks README | Left out one case where the plan-review gate blocks. | Fixed |
| OPS27 | low | hooks README | Gave the wrong path for the constants file. | Fixed |
| OPS28 | low | ui-inspector skill | Miscounted the failure modes. | Fixed |
| OPS29 | med | /diverge | Its dated gate has no tracked issue. | §5 |
| OPS30 | low | /diverge | Used a line cite. | Fixed |
| OPS31 | low | /diverge | Relied on a gitignored reference, and a reframed run left no trace. | Fixed |
| OPS32 | low | bug template | Has no environment block. | §5 |
| OPS33 | low | issue templates | Did not prompt for the human-evidence label. | Fixed; pinned text byte-identical |
| OPS34 | low | PR template | Did not list the verification steps. | Added to CONTRIBUTING; template untouched (pinned) |
| MERGE-METHOD | info | CI, CONTRIBUTING, CLAUDE.md | No tracked file records the queue's merge method. | §5 |
| D16 | med | CHANGELOG | The Unreleased section was missing five merged PRs. | Fixed |
| new | — | CHANGELOG | Relative links do nothing in the in-app copy. | Absolute URLs; shipped-doc-links test covers it (handoffs pass) |
| new | — | hooks README | Gave the wrong scope for the extract-markdown check. | Fixed |

### Design system

Covers [semantic-tokens.md](../semantic-tokens.md), `docs/design-system-impl/` (including the
[testid manifest](../design-system-impl/testid-manifest.md)), `docs/design-notes/`,
`docs/architecture-diagrams/` and the baseline capture script.

| ID | Severity | Where | Finding (paraphrased) | Outcome |
|---|---|---|---|---|
| DS01–DS05 | med–low | testid manifest | Listed ids as live that were removed or renamed. | Reconciled against the snapshot; removals noted where they happened |
| DS06–DS08, DS12 | med–low | testid manifest | Whole families and many ids were missing. | Added |
| DS09, DS10 | low | testid manifest | The notes on scan behaviour were incomplete. | Fixed |
| DS11 | med | testid manifest | The header implied the manifest is authoritative. | Rewritten. The snapshot is the contract; reconciliation date added. |
| DS13, DS14 | med | tutorial-anchor manifest | Its anchor line cites were wrong. | Replaced with a section column |
| DS15–DS17 | low | tutorial-anchor manifest | Seeding behaviour was incomplete, and it carried a dead lesson key and line numbers. | Fixed |
| DS18 | med | derived spec | Listed the wrong card actions. | Re-derived from the component; the verifier corrected the audit |
| DS19–DS22 | med–low | derived spec | Had a wrong audience value, a nonexistent tool name, a wrong variant count and a line cite. | Fixed |
| DS23, DS24 | med | derived spec | The settings-tab and wizard sections were out of date. | Marked historical or superseded |
| DS25 | med | derived spec | Had an anti-pattern banning banner actions, but banners ship with actions. | Narrowed |
| DS26, DS27, DS29, DS30 | low | derived spec | A retired component, a dead lesson key, an anti-pattern scope, and a shipped phase still shown as pending. | Fixed; pinned 3.4 phrases and headings kept |
| DS28 | low | derived spec | Had no status banner. | Added |
| DS31–DS37 | med–low | motion | Easing tokens and keyframes were described as missing; the dwell default was wrong; a retired-banner reason was wrong; a shipped item was still pending. | Past tense, labelled snapshots, values corrected |
| DS38–DS43 | med–low | token audit | Had stale contrast values, line-range cites, the lint described as running in CI, and adoption status not marked. | Updated |
| D14, DS44–DS50 | med–low | semantic-tokens | Listed only the light and dark blocks, called the enumeration complete when it was not, overstated the shadow scope, and named removed annotation flags. | Fixed. CLAUDE.md companion fixed too. |
| DS51 | low | capture script (code comment) | Its docblock gave the wrong surface and scene counts. | Fixed |
| new | — | baseline combine script | A header comment gave the wrong baseline count. | Fixed (handoffs pass) |
| DS52 | low | baseline procedure | Implied the warm theme is captured. | Fixed |
| DS53–DS62 | med–info | historical design-system files and design notes | Historical documents read as current. | Status or superseded banners only, bodies not rewritten |
| new | — | annotation-edge-colors preview | Named a nonexistent tool. | Fixed (handoffs pass) |
| DS63–DS68 | med–low | architecture diagrams | Had a wrong release point, a wrong updater edge, missing dark notes, a wrong emit rule, and missing anchor outcomes. | Fixed in JSON and HTML in lockstep |
| DS69 | low | architecture | No doc linked the diagrams. | Pointer added |

### Developer reference

Covers [CONTRIBUTING.md](../../CONTRIBUTING.md), [architecture.md](../architecture.md),
[decisions.md](../decisions.md), [gotchas.md](../gotchas.md), [roadmap.md](../roadmap.md),
[mcp-tools.md](../mcp-tools.md) and the [screenshot slot spec](../screenshots/README.md).

| ID | Severity | Where | Finding (paraphrased) | Outcome |
|---|---|---|---|---|
| D01 | high | CONTRIBUTING | Said E2E frees the product ports. | Fixed. E2E uses a reserved pair. |
| D02 | med | CONTRIBUTING | The pre-push list was missing a step. | Four steps listed |
| D03 | med | architecture | Had a broken anchor. | Fixed |
| D04 | low | decisions | Used the wrong ADR-046 anchor slug. | Fixed |
| D05 | low | decisions (ADR-031) | Cited a re-export that does not exist. | Dated amendment |
| D06 | med | architecture | Described a keyboard review mode that does not exist. | Fixed |
| D07 | med | architecture | Got the toolbar component's role wrong. | Fixed |
| D08 | low | architecture | Got the editor-settings component's contents wrong. | Fixed |
| D09 | low | architecture | Did not tag the `.docx` flow as dark. | Fixed |
| D10 | low | architecture | Gave a stale line count. | Dropped |
| D11 | low-med | architecture | The file map was missing modules. | Added |
| D12 | low | gotchas | Said the force-reload bullet contradicts itself. | Rejected: consistent with its body and with CLAUDE.md |
| D13 | low | gotchas | Said `.docx` material needs a dark note. | Rejected: the file-level banner covers it |
| D15 | med | roadmap | The reconciliation was stale. | Re-reconciled; pricing row left for LIC02 |
| D20 | low | historical review spec | An anchor sits inside a quoted instruction. | Left untouched (historical); link check passes |
| X02 | low | decisions (ADR-046) | A consequence note about port handling was stale. | Dated amendment |
| X03 | med | gotchas | Listed only the npm root for session files. | Desktop root added |
| X10 | low | architecture | Listed `.docx` as an OS association. | Fixed |
| X11 | low | architecture | Used a renamed constant. | Fixed |
| X12 | low | mcp-tools | The plaintext list included an extension that cannot be opened. | Fixed |
| X15, X16 | info | — | Confirmations. | No action |
| S07 | med | screenshot spec | Had stale port and pipeline wording. | Fixed |
| S08 | low | screenshot spec | Its embed column used drifting line numbers. | Section links |

### Agent instructions (CLAUDE.md, AGENTS.md)

Edited with care. The rules these files state were kept, and only the facts were corrected.
The CLAUDE.md pins (the acceptance harness, `windows-acl-proof`, the findings bullet, and
tool counts) still hold.

| ID | Severity | Where | Finding (paraphrased) | Outcome |
|---|---|---|---|---|
| D17, OPS22 | med | CLAUDE.md | The required-checks bullet described the pre-queue up-to-date rule. | Now names the merge queue and says the method is unrecorded; re-measuring is in §5 |
| OPS25 | low | CLAUDE.md | Overstated which flags the no-verify hook matches. | Names the single long flag |
| AG01 | med | CLAUDE.md | Called imported Word comments comment-type records. They arrive as private notes. | Fixed |
| AG02 | med | AGENTS.md | Said nothing blocks a raw transaction, but a CI test does. | Fixed |
| AG03 | low | CLAUDE.md | Gave only one location for session files. | Fixed |
| AG04 | low | AGENTS.md | The typecheck description was incomplete. | Fixed |
| AG05 | low | AGENTS.md | The build description was incomplete. | Fixed |
| D14/DS44 | med | CLAUDE.md | The semantic-tokens bullet left out the warm block. | Fixed |

## 4. Screenshots

**Addressed in the follow-up screenshots PR.** This PR fixed the slot spec's text (S07, S08)
but recaptured no images.

| Slot | Priority | What is stale |
|---|---|---|
| 01 | high | Old Reject wording (the UI says Dismiss), an old connection label, and old welcome text that lists `.docx` |
| 03 | high | Reject buttons on the suggestion card |
| 04 | high | A read-only tab badge that no longer exists, and the old connection label |
| 09 | high | An old version badge, and no Notifications tab |
| 11 | high | Old review-button wording |
| 02 | background | Element shot without the Annotations/Chat tab strip its own spec requires |
| 13 | background | Old welcome text and the old connection label behind the wizard |

**Proposed new slots.** Each one documents a surface this PR added to the
[user guide](../user-guide.md). New numbers start after 14, because slot 05 is retired and must
not be reused. Under the spec's standing rule, each slot needs an embedding section before its
capture step lands.

- The AI pill in a standby state with its Start action (Status Bar).
- The chat panel's Tandem's Claude controls and the Claude Code offer (Tandem's Claude in Chat).
- The disk-change banner with its two choices (When a File Changes on Disk).
- The brand menu with its theme swatches, including Warm (Brand Menu).
- The connection-lost banner and the server-unavailable empty state (Banners, and the matching
  troubleshooting entry).
- The Settings sidebar footer (Below the settings list), or a recapture of 09 framed to show it.

Slot 14 (the desktop window) is still manual and still has no embedding page.

## 5. Needs a maintainer decision (Bryan)

| Item | Decision needed | State in this PR |
|---|---|---|
| P06 / LIC01 | Whether the README states the price. | The pointer was reworded so it no longer promises a price. ADR-040's old range is marked superseded. |
| LIC02 | Whether the [roadmap](../roadmap.md) pricing rows should show the price as decided (only the accountant question would stay open) or as provisional everywhere. | Untouched |
| LIC27 | How to reconcile the ADR-040 status line, which cites a counsel draft, with the [licensing-terms](../licensing-terms.md) header, which says no counsel is engaged. Annotate one of them; do not rewrite ADR history. | Untouched |
| LIC29 | Whether to keep the [positioning](../positioning.md) argument that paying beats building from source. LICENSE treats a self-built copy as the same Licensed Work. Drop it, or restate what it means (effort rather than legality). | Untouched |
| LIC20 | A counsel question: can the reach-back clause in the unreleased LICENSE text extend grants to versions already released? | The docs now say the current wording ships with the next release |
| OPS08 | How a release smoke run should exercise the forward update. Options are a staging build with a different updater endpoint, or a real override. | Checklist row marked not runnable, with the reason |
| OPS15 | What the release skill's project-memory step means, and where that memory lives. Or delete the step. | Untouched |
| OPS20, MERGE-METHOD, OPS22 | Re-measure branch protection and the rulesets (the API refused this session), and record the merge queue's merge method in CLAUDE.md. Then confirm whether `gh stack` stacks go through the queue. | CLAUDE.md now names the queue and says the method is unrecorded. [stacked-prs.md](../stacked-prs.md) keeps an open caveat. |
| OPS29 | File the [`/diverge`](../../.claude/commands/diverge.md) review gate as an issue with its date in the title, and cite it in the command, as the dated-gates rule requires. | Not filed (issue search was unavailable from this session) |
| OPS32 | Whether to add an environment block to the [bug template](../../.github/ISSUE_TEMPLATE/bug_report.md) (version, install type, OS, or pasted diagnostics), given that #1605 deliberately keeps the template short. | Untouched |

## 6. Code issues found (not fixed in this docs PR)

| Item | Where | Issue |
|---|---|---|
| P43 | filter bar (`FilterBar.svelte`) | The Imported author chip always shows. Only `.docx` import creates that author, and `.docx` ships dark. Gate the chip on the `.docx` flag. |
| Ctrl+K | formatting toolbar's Link button tooltip; `RESERVED_CHORDS` in the keybindings | Both advertise a link shortcut that nothing binds, because the link extension ships no keymap. Either bind it to open the link editor, or drop the tooltip and the reservation. If it gets bound, restore the user-guide row. |
| LIC22 | `src/shared/license-copy.ts` | The bad-signature message does not suggest updating Tandem before asking for a reissue. The doc now does. |
| Hook scope | `block-sensitive.sh`, `block-no-verify.sh` | Optional. Widen the sensitive-file pattern (the Cargo lockfile, `.env` variants) and the no-verify match (short flag, env bypass). The docs now describe what the hooks actually match. |
| Stale comment | `src/server/log-filter.ts` | The docblock implies every boot frees the product ports. Only a boot that skips the probe does. |
| Stale comment | `tests/docs/welcome-links.test.ts` | The docblock says an unresolvable relative link fails silently. The editor now shows a notice. |

**Fixed in this PR:**

- P28: the `tandem` start command's `--help` text in `src/cli/index.ts`.
- OPS07: the release workflow comment.
- DS51: the capture-script docblock.
- In the handoffs pass:
  - The LIC05 code comments.
  - The baseline combine-script header.
  - The hook script headers.

## 7. Follow-ups planned

**PR 2: screenshots.** Recapture slots 01, 03, 04, 09 and 11, and the backgrounds of 02 and 13.
Decide which of the proposed slots in §4 to add, and give each one an embedding section.

**PR 3: wiki overlay.** This adds:

- A docs hub page.
- Reading maps per audience: user, operator, contributor, agent.
- A glossary.
- Frontmatter that marks each doc live or historical.
- Related-links footers.
- Upgrades to `scripts/check-doc-links.mjs`.
- A CI link check.

The hub is where the live-versus-historical index from §2 will live.

**Smaller leftovers**, noted by the fix agents and not in any finding:

- The architecture file map lists two directories twice.
- The format-support line in `mcp-tools.md` has no inline dark note for `.docx`. The file-level
  banner covers it.
- If the npm-scripts heading in `cli.md` is ever renamed, CONTRIBUTING's link to it must move
  with it.
