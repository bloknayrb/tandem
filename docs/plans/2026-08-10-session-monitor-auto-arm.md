# Per-session monitor auto-arm on first Tandem use

**Status:** Revised after five adversarial passes. **Three shippable pieces, released as one
unit; the manifest change is deferred out of this work entirely.**

**The manifest is not being touched in this release.** Both packaged-monitor triggers stay.
The fourth pass's "keep the qualified entry, drop the bare one" design (option D) was found
to strand double-installed Windows users without Git Bash, and separately to depend on an
install ordering no release can impose — see §9.3, which records it as a **rejected** design
rather than deleting it, because the reasoning that killed it is the useful part.

What ships is the behavioural fix and its delivery path: **PR1 (skill) + PR2 (refresh
reachability) release together as one changelog entry**, with PR3's copy correction folded
into PR1. Manifest narrowing becomes migration work (§9), gated on a minimum-installed-version
mechanism that does not exist yet.
**Date:** 2026-08-10
**Refs:** #1389, #1390, ADR-028, ADR-047, ADR-049,
`docs/spikes/plugin-monitor-tty-activation.md`

## 1. Review receipt

The first draft was reviewed before implementation by three independent agents:

- **Architecture/session review:** rejected "exactly one wake path," identified dead
  plugin-monitor ownership, channel coexistence, global inbox routing, and resumed
  supervisor caveats.
- **Claude host-mechanics review:** found no evidence that ordinary Tandem MCP use
  deterministically dispatches the skill, or that the model can see bare versus
  plugin-qualified skill identity. It also found untested marketplace and version-skew
  states.
- **Privacy/UX/test review:** confirmed Solo and payload-free wake are sound, but found
  that skill refresh is tied incorrectly to supervisor startup and that the proposed
  regression test pre-invoked the skill instead of testing the product promise.

The second draft was re-reviewed by the same three agents. That pass found a confounded
v9 probe, stale in-memory skill risk, a zero-path version-skew transition, unobservable
wizard success, and a Windows capability regression. It responded with an isolated
candidate fixture, made every skew case a gate, and removed the unproven model-side
identity branch.

**Third pass (2026-08-10), against the code rather than the prose.** It verified the v9
gate, the refresh call site, the manifest, `wakeUrl`, and `/api/wake`, and found:

- The plan was roughly ten times the size of the change it gated. The behavioural fix is
  three lines in one file, and its safety net **already shipped** in `e71b75f`.
- Phase 0 re-measured findings the existing spike already holds (F8, F10, and the
  extracted arming loop). One question in it is genuinely open.
- Probe A was a gate with no numeric threshold whose pass and fail branches led to the
  same product copy.
- Two statements in the file-level plan were factually inverted (see §11, "Corrected
  from the previous draft").
- The Windows asymmetry the previous draft treated as hypothetical is **recorded fact**
  in ADR-049, and four shipped surfaces currently contradict it.

A fourth pass, run in parallel with the third against the same code, converged on the split
and on both inverted statements, and added four findings the third missed:

- **Phase 0 was circularly dependent on the code it forbade.** Probe A2 required a
  candidate v10 skill (WP-B's deliverable) and Probe E required WP-A built, yet §9 sequenced
  the implementing agents *after* the probes. The split resolves it: PR1 and PR2 land before
  any probe runs.
- **The plugin-delivered skill copy can never be server-refreshed** (§7.1). The previous
  draft's refresh reasoning covered only the standalone copy.
- **Duplicate wakes are the steady state for double-installed users**, not skew (§4.11) —
  F10's arming dispatch is the same dispatch v10 self-arms on.
- **The Windows gate was unsatisfiable** and is now a product decision (§9.3); **Probe E's
  observable was confounded** and now needs a version-distinctive marker (§9.1).

It also noted the existing ConPTY probe harness, which the previous draft ignored while
describing ~40 hand-run sessions.

This version splits the work, ships the fix first, and reduces the evidence gate to the
delta the spike does not cover.

**Product decisions, 2026-08-10 (Bryan).**

- **The channel declaration is not a conflict.** The shim only delivers behind an explicit
  flag, and a session where it delivers is one where doubled wakes can fire the stand-down.
  The harm is diagnostic, so the fix belongs in the advisory's reading rather than the
  manifest. **Still stands.** §9.5.
- **"Keep the monitor but stop it firing in every session" (option D).** Explored, designed,
  and then **rejected** by the fifth pass on two independent grounds. §9.3 keeps the full
  derivation.
- **The arming rule is session-local.** "Arm only if this session has no live path" is the
  correct rule and neither half is observable upfront — but the fifth pass correctly weakened
  the claim that doubled wakes are a reliable arbiter. §4.12.

**Fifth pass (2026-08-10, `2026-08-10-session-monitor-auto-arm-review.md`) — three
independent reviewers, two P0s, both accepted.**

- **P0-1: option D strands double-installed Windows users without Git Bash.** §9.3's table
  said that population ends with "self-armed watch only," which silently assumed they *can*
  self-arm. Without the `Monitor` tool they cannot, and today the bare trigger is what covers
  them. Removing it takes them from one path to **zero**.
- **P0-2: repository PR ordering is not user install ordering.** §7.1 already established
  that the plugin updates on a timeline Tandem does not control; §9.4 then argued that
  shipping PR1 first makes the manifest edit safe. Those contradict. A user can update the
  plugin *before* Tandem, leaving standalone v9 winning the bare dispatch and declining to
  self-arm — the reported bug, reproduced by the fix.
- Accepted P1s: probes need INCONCLUSIVE (see §9.1 — this repeats a lesson already recorded
  and not applied); PR1 and PR2 must **release** together, not merely merge separately; PR3's
  `SKILL.md` edit lands after PR1's version bump and would not be redelivered by a
  version-monotonic refresher, so it folds into PR1; doubled wakes are opportunistic, not an
  if-and-only-if signal; natural-language dispatch is unmeasured by every existing F-finding,
  which used explicit slash dispatch; the wizard plugin-install action contradicted the
  plan's own duplication warning.
- Accepted P2s: the wizard test contract must assert per-branch truthfulness, not just
  presence of the primary message; the `/plugin update` claim in §7.1 was asserted rather
  than verified; Probe T did not test enumeration.

## 2. Product requirement

When a hand-started Claude Code session begins ordinary work with Tandem, it should
automatically attempt to establish a session-scoped wake watch. The user should not have
to ask Claude to watch, install an additional plugin, or reason about Tandem's
process-global subscriber count.

Without that watch, an idle Claude cannot learn that the user commented, replied, or sent
chat after the active turn ended.

The honest invariant is:

> Every participating hand-started session attempts to acquire at least one usable wake
> path on first Tandem use. Tandem avoids duplicate paths where it controls the choice;
> legacy/version-skew duplicates remain safe because wakes are payload-free and
> `tandem_checkInbox` remains authoritative.

This is not an exactly-once delivery guarantee. Tandem cannot currently identify the
calling Claude session on the direct-HTTP MCP path, route an inbox item to the session
that owns a document, or prove that a host displayed a wake. Those are separate
per-client identity/routing concerns and must not be implied by this change.

## 3. Reproduced failure, and why it is already half-solved

The reporting machine had the current standalone skill (version 9), Tandem 0.21.0, and
Claude Code 2.1.226. Tandem reported 15 global subscribers: five plugin monitors and ten
channel shims belonging to other sessions. `skills/tandem/SKILL.md:87` arms the built-in
Monitor **"only if Tandem's tool output has told you nothing is subscribed"**, so the
uncovered new session never attempted to arm.

Three things about the current state matter, and the previous draft understated all three:

1. **The hole is already documented in the skill itself.** `SKILL.md:89` describes exactly
   this failure — a legacy shim "stays subscribed forever while delivering nothing," so
   "the count never reaches zero" and "you would decline to arm in exactly the session
   that needs it most." The existing mitigation is the user-initiated escape hatch ("or if
   the user asks you to"), which is a workaround, not a fix.
2. **The precondition is known to be unsound by construction.** `e71b75f` (2026-08-09)
   recorded that once the plugin monitor arms on skill dispatch rather than at session
   start, "the count Claude reads is therefore stale by construction." Recorded in ADR-028
   as a regression rather than a trade.
3. **The safety net the precondition was standing in for already shipped.** That same
   commit added `SKILL.md:102`: if every wake arrives twice, you are the second consumer —
   `TaskStop` your own watch and keep polling. The inbox de-duplicates, so a duplicate
   costs a wasted turn, not a duplicate reply.

Given (2) and (3), the precondition suppresses arming without buying anything. Removing it
is the follow-through on an already-recorded regression, not a new bet.

`src/server/mcp/wake-advisory.ts:20-25` documents the same structural gap on the server
side: because a positive count silences the advisory, "a session that is genuinely
uncovered while some OTHER consumer is attached gets no advisory."

## 4. Behavioral invariants

1. **Per-session attempt, not process-global inference.** Other subscribers never suppress
   this session's first-use Monitor attempt.
2. **Ordinary first Tandem use is the intended trigger.** The acceptance test starts with a
   natural-language Tandem request, not `/tandem` and not a pre-dispatched skill.
3. **No activity outside Tandem.** Sessions that never use Tandem start nothing.
4. **Attempt-based copy, always.** Skill dispatch is model judgement, not a host hook. No
   sampling result can justify "starts listening"; every user-facing surface says Claude
   **tries** to start listening on first Tandem use. This is settled and is not contingent
   on any probe outcome.
5. **Supervisor sessions do not self-arm.** Fresh and resumed Tandem-launched sessions use
   supervisor stdin wakes; the existing no-arm clause stays load-bearing.
6. **Payload-free wake.** Every wake leads to `tandem_checkInbox`; it carries no user or
   document content.
7. **Pull remains authoritative.** Continue inbox polling every 2–3 tool calls even after
   Monitor starts.
8. **Solo remains private.** A watch may be armed in Solo, but server-side gates keep
   Solo-held annotations out of external wake streams; chat may still wake.
9. **No guessed endpoint.** Read `wakeUrl` from read-mode `tandem_status`; absence means no
   self-armed path is available.
10. **Capability failure is explicit.** If Monitor is absent or its invocation fails, say so
    once, continue polling, and offer the channel shim. Do not guess whether the cause is
    the remote account gate, Windows Git Bash, safe mode, trust, or policy.
11. **Duplicate wakes are an accepted, disclosed cost of this release.** A double-installed
    user with the `Monitor` tool duplicates deterministically: F10 measured that the bare-name
    entry arms on a dispatch of the **non-plugin** skill copy, which is the same dispatch v10
    self-arms on. §9.3 explains why no manifest edit removes this without stranding somebody,
    and why the manifest is therefore untouched here. The host rejects duplicate monitor
    names, so no manifest-level singleton exists. Write the duplicate into the changelog as
    known behaviour with its recovery, not as an edge case, and do not promise a date for
    removing it.
12. **"Already covered" is not knowable when the decision is made, and not reliably knowable
    afterwards either.** The correct rule is *arm only if this session has no live path* —
    session-local state, never the global count. Neither half is checkable upfront: an MCP
    server named `tandem-channel` being present proves **registration, not delivery** (the
    shim subscribes to `/api/events` unconditionally at `src/channel/run.ts:207`, whether or
    not the host negotiated the channel), and a registered-but-inert shim is exactly §3's
    repro population — so a skill rule keyed on shim presence would recreate the reported bug
    in session-local form.

    Doubled wakes are the best available signal but are **opportunistic, not an
    if-and-only-if**. Host rate limiting coalesces and drops notifications — the burst
    measured in `docs/spikes/monitor-self-arm-probe.md` had at least 7 of 25 events never
    become notifications — so two live streams can present as one. `SKILL.md:102`'s `TaskStop`
    is therefore *recovery when the duplication is visible*, and duplicate wake and token cost
    may persist for a whole session when it is not. **The actual safety contract is the pair
    that does hold unconditionally: wakes are payload-free, and `tandem_checkInbox`
    de-duplicates.** Never describe `TaskStop` as bounding the cost.

    Whether the host lets the model **enumerate its own live Monitor tasks** is genuinely
    open and is the one question worth keeping from the discarded Probe B (§9.1). If it can,
    that becomes the first reliable upfront check and supersedes the empirical path.

## 5. What the existing spike already establishes

Cited so the deferred migration work probes the delta rather than re-running settled work,
and so this plan stops proposing probes for questions already answered. All from
`docs/spikes/plugin-monitor-tty-activation.md`.

| Question | Finding | Status |
|---|---|---|
| Does the shipped manifest arm on skill dispatch? | F10 — yes, on the **bare-name** entry, 16 s from dispatch | MEASURED |
| **Plugin-only:** does the qualified entry arm on ordinary dispatch? | **F6 — yes.** With only the plugin's own skill copy present, `on-skill-invoke:<plugin>:<skill>` arms; the bare form never does | MEASURED (twice) |
| **Double-installed:** which copy wins the bare dispatch? | **F7 — the non-plugin copy, and the qualified entry does not arm** | MEASURED (twice) |
| Can both name forms arm in one session? | F8 + the extracted arming loop — yes; dedupe key is `plugin:monitor-name`, and the host **rejects duplicate names**, so no manifest remedy exists | MEASURED + IN CODE |
| Does the host respawn a dead monitor? | F9 — no. One arm, stays dead | MEASURED |
| Is `Monitor` gated beyond version? | `tengu_amber_sentinel` (both paths) **plus** Git Bash on Windows (`Monitor` tool only) | IN CODE |
| Marketplace install vs `--plugin-dir` | **Not established.** The spike flags this itself for F1/F6/F7/F8/F10 | OPEN |
| Windows-without-Git-Bash population size | Not observable from the server | OPEN |

**F6 and F7 establish that *which* manifest entry fires is determined by which skill copy the
user installed.** The fourth pass read that as a free discriminator between the populations
that need different treatment. It is not — §9.3 explains why it sorts on the wrong axis — but
the finding itself is solid and is the starting point for any future migration design. **Note
what is missing from every row above: all of them used an explicit slash dispatch.**

The last two rows of the table are what the deferred migration work (§9) would need to
answer. Everything above them is cited, not re-run.

**A third gap the fifth pass surfaced, and it is the important one: every F-finding used an
explicit slash dispatch.** F6, F7 and F10 all typed `/armcheck` or `/tandem`. Nothing in the
spike measures whether *ordinary natural-language Tandem work* dispatches the skill at all,
or which copy it selects when two exist. That is the mechanism this entire plan rests on, and
it is the least evidenced thing in it. §12 turns it into a bounded acceptance sample rather
than an assumption.

**The probes are already scripted.** `scripts/spikes/` holds a working ConPTY harness —
`probe-monitor-tty.py`, `probe-skill-arm-trigger.py`, `probe-skill-name-collision.py`,
`probe-shipped-arm-trigger.py`, `probe-monitor-respawn.py` — which already automates "spawn
an interactive Claude, dispatch a skill, capture what armed," writes its own verdict line,
and has known failure modes documented (a near-empty capture is a decoder crash, not a
null). Anything in §9.1 is an adaptation of one of these, not a new hand-typed session.

## 6. PR1 — remove the precondition, and correct the Git Bash claim

The behavioural fix. **Merges as its own review unit but releases with PR2** (§13) — PR2 is
what delivers these instructions to the launcher-disabled and deferred-autostart population,
which is the population that reported the bug. A changelog entry for PR1 alone would claim a
fix that a large share of users would not receive.

**PR3's `SKILL.md` edit folds in here.** `refreshSkillIfStale()` is version-monotonic, so a
later PR that edits the skill without bumping past 10 is never redelivered to a user who
already received 10. Either fold it in or bump to 11; folding is simpler and keeps one bump
per release.

1. `skills/tandem/SKILL.md`:
   - bump `version: 9` → `10`;
   - at `:87`, fix the Git Bash overclaim (was PR3 item 1): "the plugin monitor will not help
     because it depends on the same host feature" is right about the account gate and wrong
     about Git Bash. Distinguish the shared precondition from the unshared one. See §8;
   - at `:87`, delete the clause *"and only if Tandem's tool output has told you nothing is
     subscribed"*, leaving the first successful read-mode `tandem_status` in a hand-started
     session to lead directly to one persistent Monitor attempt using `wakeUrl`;
   - rewrite `:89`, which exists only to explain the escape hatch the deletion makes moot.
     Replace it with the reason arming is now unconditional: the count is stale by
     construction, and doubled wakes are the recovery signal;
   - demote "ask Claude to watch" from workaround to recovery-only;
   - **retain unchanged**: `:91` (read `wakeUrl`, never guess), `:94` (the `Monitor({ws,
     persistent})` form), `:99` (supervisor no-arm), `:100` (payload-free), `:101`
     (best-effort, keep polling), `:102` (`TaskStop` duplicate stand-down), `:104` (SSE
     fallback), and the Monitor-absent guidance at `:87`. These already exist and are
     correct; PR1 must not disturb them.
2. **Do not touch `src/cli/skill-content.ts`.** It is a 20-line `readFileSync` of
   `skills/tandem/SKILL.md`, not a content source — the markdown is authoritative, they
   cannot drift, and no equality test is needed. (The previous draft had this inverted.)
3. Tests:
   - a lexical shipped-skill contract test, explicitly labelled an instruction guard,
     asserting version 10, persistent `Monitor`, `wakeUrl`, **no** zero-subscriber
     precondition, supervisor no-arm, failure fallback, and authoritative polling;
   - mutation-check that guard by restoring the version-9 conditional and confirming it
     fails;
   - update `tests/plugin-manifest.test.ts`'s derivation test if it reads the frontmatter
     version (it reads `name`; confirm before assuming);
   - the four-surface Git Bash assertions from §8.

**Why the code change needs no probe:** it removes a suppressor. The worst case is a
duplicate wake in a session that already had a path — the cost ADR-028 already accepted, and
one that survives whether or not this ships. There is no state this makes worse than today.
**The product *claim* does need evidence**, and that is §12's natural-prompt sample: removing
the suppressor is only a user-visible fix if ordinary Tandem work dispatches the skill at
all, which nothing has yet measured.

## 7. PR2 — make skill refresh reachable

Releases with PR1 (§13). Independently valuable and worse than the previous draft described.

`refreshSkillIfStale()` (`src/server/integrations/apply.ts:1178`) is called from exactly one
place: `src/server/index.ts:147`, as `void refreshSkillIfStale()` inside
`startLauncherSupervisor()`. Consequences:

- **Unreachable under `TANDEM_DISABLE_LAUNCHER=1` and `deferred-autostart`** — which is
  precisely the hand-launched population this work targets.
- Fire-and-forget, and it runs *after* the HTTP server is listening (`index.ts:657`,
  banner `:659-667`, `await startLauncherSupervisor()` at `:724`).
- It already performs **install-if-missing**, not just refresh: a missing file yields
  `onDiskVersion = -1` (`apply.ts:1189`), which is below the bundled version, so it writes.
  Its own docblock (`:1167-1177`) claims refresh-only semantics and calls `installSkill()`
  "the authoritative installer." The code contradicts the comment today.

Work:

1. Split `refreshSkillIfStale()` into two explicit semantics: refresh an existing
   setup-managed skill when the bundled version is newer, versus authoritative installation
   by wizard / `setup --apply` when the file is missing.
2. Move the existing-skill refresh out of `startLauncherSupervisor()` into awaited HTTP
   startup, before Tandem reports ready.
3. Do not install a missing standalone skill during generic server boot — plugin-only users
   must not silently acquire a second copy. This is a behaviour change from today; call it
   out in the changelog.
4. Preserve path hardening, atomic write, version monotonicity, and the loopback-only error
   side channel.
5. Note that `SKILL_CONTENT` is read **at module load**, so a long-running server holds
   boot-time bytes. Staleness is server-side as well as host-side; the split must not assume
   a re-read.
6. Test: normal startup, deferred autostart, launcher disabled, no Claude integration, stale
   v9, current/newer on-disk version, missing skill, and write failure.

### 7.1 The plugin-delivered skill copy can never be server-refreshed

PR2 fixes refresh for the **standalone** copy only, and that limit is structural rather
than an oversight to fix later.

`.claude-plugin/marketplace.json` sources the plugin as `{"source": "github", "repo":
"bloknayrb/tandem"}` with **no ref**, so a plugin install tracks master. Tandem's server
cannot write into Claude Code's plugin cache and must not try; §14 forbids automating the
consent boundary.

**State only what is established.** The load-bearing fact is that **Tandem does not control
when the cached plugin changes** — that follows directly from the cache being Claude Code's.
Whether refresh happens *only* on an explicit `claude plugin update`, or also on some
automatic schedule, is **not verified** and must not be asserted. Every conclusion below
holds under either behaviour, because both leave the timing outside our control; if a claim
ever needs the stronger version, verify it against the current CLI first.

Two consequences, both load-bearing:

- **F7 is why PR2 still works for most users.** The non-plugin copy wins the bare dispatch,
  and that is exactly the copy `refreshSkillIfStale()` owns. A double-installed user
  therefore executes the refreshed v10 body even while their plugin ships v9.
- **For a plugin-only user, v10 arrives on a timeline Tandem does not control.** PR1 does not
  reach them until their plugin cache changes. State this in the changelog rather than
  implying PR1 is universal.
- **The two channels can update in either order, and that is what killed option D.** The
  previous draft reasoned only about the plugin lagging. The plugin can equally lead: a user
  who updates the plugin but not Tandem Desktop runs a new manifest against a **v9** standalone
  skill. If that manifest had lost the bare trigger, the v9 copy would win the bare dispatch,
  decline to self-arm on the stale-count precondition, and the qualified trigger would not
  fire — zero paths, which is precisely §3's bug re-created by its own fix. **Release
  sequencing in this repository cannot impose an install order on two independently updated
  channels.** See §9.3 P0-2.

Do not add a "your plugin is stale" nag without first answering whether `doctor` can read the
enabled manifest version at all; if it cannot, we cannot detect the state we would nag about.

## 8. The Git Bash correction (folded into PR1)

Was PR3. **Folded into PR1** because its `SKILL.md` edit would otherwise land after PR1's
version bump and never be redelivered by the version-monotonic refresher (fifth pass, P1).
The three non-skill surfaces can travel in the same PR.

A live shipped defect that misdirects exactly the population §9.3 turns out to be unable to
protect any other way.

`docs/decisions.md:404` (ADR-049's 2026-08-09 amendment) records that the two paths share
the `tengu_amber_sentinel` gate, and that the Windows Git Bash precondition is one the
`Monitor` tool has **and the plugin monitor does not** — the plugin monitor falls back to
PowerShell. `docs/spikes/plugin-monitor-tty-activation.md:458-463` states it directly: on a
stock Windows box with no Git Bash, "the `Monitor` tool is not offered at all … while the
plugin monitor still runs."

Four shipped surfaces say the opposite:

- `skills/tandem/SKILL.md:87` — "the plugin monitor will not help because it depends on the
  same host feature"
- `src/cli/doctor.ts:1316` — "the plugin monitor needs the same tool and will not help"
- `docs/troubleshooting.md:139` — "(the plugin monitor needs the same tool)"
- `README.md:112` — "the plugin needs the same tool, so it will not help either"

The claim is right about the sentinel and wrong about Git Bash. For a Windows user with the
sentinel on and no Git Bash, the plugin monitor is their **only** automatic path, and all
four surfaces tell them not to bother.

Work: correct all four to distinguish the two preconditions — shared account gate, unshared
Windows shell requirement. Pin each with an assertion so the overclaim cannot return; a
copy-correction PR already passed over this once (#1353), because the sentence is *half*
true and a verification sweep confirms the true half.

This correction is now more than hygiene: §9.3 concludes that for Windows users without Git
Bash the packaged plugin monitor is not merely *an* automatic path but the **only** one we
can offer, and it is what we are choosing to keep. Copy that tells them it will not help is
directly contrary to the design.

## 9. Deferred — manifest narrowing as migration work, not part of this release

**No manifest change ships here.** Both packaged-monitor triggers stay exactly as they are.
§9.3 records why the fourth pass's design was rejected and what a future attempt must solve
first; §9.1's probes are retained because they remain the right questions, but none of them
gates the release any more.

### 9.1 Probes — retained, none release-gating

The fifth pass's P1 applies to every one of them, and it repeats a lesson already in the
project's memory that this plan failed to apply: **a two-branch verdict turns an ambiguous
host failure into a product decision.** `probe-shipped-arm-trigger.py:221-246` already models
the right shape — it reports INCONCLUSIVE when its positive control does not arm.

**Every probe below reports PASS, FAIL, or INCONCLUSIVE**, and the preconditions for a
non-INCONCLUSIVE verdict are the same for all of them:

- a trusted, interactive TTY (not `-p`, not print mode);
- safe mode off, hooks permitted, workspace trust accepted;
- a positive control that armed in the same run;
- skill dispatch positively observed, not inferred from the monitor's absence;
- a healthy capture (a near-empty one is a decoder crash, per the spike's own warning).

Two further rules, both from the fifth pass:

- **Separate trigger *matching* from process *liveness*.** A marker command proves `when`
  matched; it says nothing about whether the real `npx` command starts, survives PATH, or
  delivers a wake. These are different failures with different fixes; measure them apart.
- **Record plugin-only / double-installed and bare / qualified as independent cells.** No
  single cell's failure justifies a manifest change in either direction.

**Probe M — real marketplace install.** Install via
`claude plugin marketplace add bloknayrb/tandem` + `claude plugin install tandem@tandem-editor`
(not `--plugin-dir`) and confirm the shipped manifest's bare-name entry arms on skill
dispatch, reproducing F10 on the production install shape. Record the installed manifest
version.

> **PASS:** the production install shape behaves as `--plugin-dir` did for this cell. Note
> that this closes **one cell**, not the whole F1/F6/F7/F8/F10 set — the previous draft's
> "the findings transfer wholesale" was an overreach; each cell transfers only if measured.
> **FAIL** (positive control armed, this did not): marketplace installs genuinely differ, and
> that is a finding about distribution, not a licence to remove anything.
> **INCONCLUSIVE:** any precondition unmet.

**Probe S — split in two.** The fourth pass gave the fixture a distinctive marker, which the
fifth pass correctly noted does not fix the confound: PR1's *real* v10 carries no marker, so
a marker-bearing fixture tests the fixture, and natural dispatch can fail for reasons
unrelated to caching. Two separate questions, two separate runs:

**S1 — does PR2 actually rewrite the file?** Pure server-side, no host involved. Seed real v9
on disk, start Tandem through normal, launcher-disabled (`TANDEM_DISABLE_LAUNCHER=1`) and
deferred-autostart paths, and assert the on-disk file is real v10 before Tandem reports ready.
This is a test, not a probe — it belongs in PR2's suite.

**S2 — does a live session cache the old body?** Isolated fixture, both copies carrying
unconditional distinctive markers, `/tandem` dispatched **explicitly** so skill selection
cannot confound the caching question. Start Claude before the refresh; repeat with Claude
started after Tandem is ready.

> **PASS/FAIL:** which marker the session emits answers it directly. **INCONCLUSIVE:** no
> marker emitted at all. Never claim that rewriting a file updates instructions already in
> memory; if S2 shows caching, scope refresh to sessions started after Tandem is ready and
> add an explicit restart notice.

Natural-language prompting belongs in §12's acceptance sample, **not** in this probe.

**Probe Q — does the qualified entry arm for a plugin-only user, on the real manifest?** F6
measured this with synthetic names; F10 ran the real manifest but only in the double-install
shape. The cell is an inference. Re-run `probe-shipped-arm-trigger.py` with the non-plugin
copy removed — one run, no new harness.

> **PASS:** plugin-only users are covered by the qualified entry, which is what makes the
> §9.3 migration worth attempting later. **FAIL:** plugin-only users are not covered either,
> which makes the whole packaged monitor weaker than believed — a finding, still not a licence
> to remove it, since §9.3's P0-1 population depends on the *bare* entry, not this one.
> **INCONCLUSIVE:** any precondition unmet.
>
> This is no longer a release gate. The fourth pass made it one on the strength of option D;
> option D is rejected, so nothing waits on this.

**Probe T — can the model enumerate its own live Monitor tasks?** Per §4.12. The fourth
pass's method was wrong: dispatching twice and after `/compact` observes *duplicate
behaviour*, which is not the same question. Enumeration has to be tested directly — the
candidate instruction must **attempt to list or resolve current tasks before a second arm**,
and the run records which tools were available for that and what task identifiers, if any,
came back.

> **PASS:** enumerable → this becomes the first reliable upfront check and supersedes §4.12's
> empirical path; tighten "at most once per session" into a real check. **FAIL:** not
> enumerable → it stays instruction-level. **INCONCLUSIVE:** the second dispatch never
> happened, or no attempt to enumerate is visible in the trace. Non-blocking either way.

**There is no Windows probe.** The relation is settled statically (`Monitor`'s `isEnabled()`
is `Zue() && Jf()`, `Jf()` needs Git Bash on Windows, plugin monitors do not share it — so
built-in availability is a strict **subset** of plugin availability there); the negative case
is unreproducible on the only Windows host available, which has Git Bash; and the population
is gated on `tengu_amber_sentinel`, which Tandem cannot observe. A gate on it would block
forever or be rubber-stamped. §9.3 resolves the question by **not removing anything**, which
needs no number.

Probes run against a real TTY, in an isolated Claude configuration, after backing up prior
state, restoring it afterwards, and never overwriting the user's real installation. Traces
committed or attached.

**Removed from the previous draft.** Probe A is gone: skill dispatch is model judgement, not
a host hook, and §4 invariant 4 already settles the copy unconditionally, so both branches
of that gate led to the same product. If you want a dispatch smoke check, run five natural
prompts and record the ratio as an observation — not as a gate, and never as grounds for
deterministic copy. Probe D cases 3 and 4 are gone: F7 and F8 measured them. Probe B's
idempotence question is gone as a gate: the arming loop's dedupe key and the host's
duplicate-name rejection are extracted in the spike, and `SKILL.md:102` already carries the
recovery. Probe C's "does the current plugin monitor arm" is gone: that is F10.

### 9.2 The manifest is unchanged — what stays and why

- **both** `experimental.monitors[]` entries stay: `tandem-events`
  (`on-skill-invoke:tandem:tandem`) and `tandem-events-user-skill`
  (`on-skill-invoke:tandem`);
- **`tandem-channel` stays** (§9.5);
- `tandem monitor` stays as the CLI behind both entries, not deprecated;
- the channel shim remains the explicit fallback when the built-in Monitor is unavailable or
  fails;
- Tandem-launched sessions continue using supervisor stdin wake.

`tests/plugin-manifest.test.ts` needs **no change**, which is itself worth noting: the file
already pins both triggers, `always`-forbidden, name uniqueness, the `env`-absent rule, and
the version pins. Leave it alone.

`probe-shipped-arm-trigger.py` is **not** invalidated — the spike's tripwire fires on edits
to the monitor block, the plugin `name`, or `SKILL.md`'s frontmatter `name:`. PR1 changes
`version:`, not `name:`. No re-run required.

The spike amendment changes shape too. The fourth pass planned to record F6/F7's asymmetry as
a deliberate discriminator. That is no longer what happened, so record what did: the
asymmetry discriminates *plugin-only from double-installed*, but the property that actually
needs discriminating is **`Monitor`-tool availability**, and F6/F7 say nothing about it. That
is the correction worth preserving next to the measurements.

### 9.3 REJECTED — "keep the qualified entry, drop the bare one" (option D)

**Proposed and provisionally approved 2026-08-10 (Bryan); rejected the same day by the fifth
pass.** Kept in full because the reasoning is reusable and because a future reader will
otherwise re-derive it: the design is genuinely attractive and its flaw is not visible from
the manifest.

**The design.** Drop `tandem-events-user-skill`, keep `tandem-events`. F6 measured that a
plugin-only user's dispatch fires the qualified entry; F7 measured that in a double-installed
configuration the bare dispatch selects the standalone copy and the qualified entry does not
fire. So the manifest appears to separate the two populations for free.

**P0-1 — it strands double-installed users who lack the `Monitor` tool.** The fourth pass's
table asserted that double-installed users end with "self-armed watch only." That assumed
they *can* self-arm. On Windows without Git Bash the `Monitor` tool is not offered at all
(`docs/spikes/plugin-monitor-tty-activation.md:456-463`), so:

| | today | under option D |
|---|---|---|
| bare dispatch selects | standalone skill | standalone skill |
| standalone can self-arm? | **no** (no `Monitor` tool) | **no** |
| bare trigger fires packaged monitor? | **yes** | **removed** |
| qualified trigger fires? | no (F7) | no (F7) |
| **paths** | **1** | **0** |

Precise population: Windows **and** no Git Bash **and** `tengu_amber_sentinel` on **and**
both installs. Narrow — and a regression against shipped behaviour for every member of it.

**The generalisable reason, which is the part worth keeping.** The bare trigger is *harmful*
exactly when the `Monitor` tool is present (it duplicates the self-arm) and *load-bearing*
exactly when it is absent (it is the only path). Those conditions are perfectly
anti-correlated, and **the manifest cannot condition on `Monitor` availability**. So no
manifest-only edit separates the good case from the bad one. F6/F7's asymmetry is real but
sorts on the wrong axis: it discriminates *which copy is installed*, when what matters is
*what the host offers*.

**P0-2 — release order is not install order.** The fourth pass argued the edit was safe once
PR1 and PR2 shipped first. That is repository sequencing, and the plugin updates through a
channel Tandem does not control (§7.1). A user can update the plugin *before* Tandem:

```text
new plugin manifest (no bare trigger) + standalone skill still v9 + old Tandem server
  → v9 wins the bare dispatch
  → v9 declines to self-arm (unrelated subscriber, the §3 precondition)
  → qualified trigger does not fire
  → zero wake paths
```

That is §3's exact bug, re-created by its own fix, on an install shape no release ordering
can prevent. Waiting a release does not help: users may skip desktop updates indefinitely.

**What a future attempt must have first.** Not "wait and see" — these are concrete
prerequisites, and the work is not schedulable until at least one exists:

1. **A minimum-installed-version mechanism.** Some way for the plugin to decline to strand a
   user whose standalone skill predates v10 — the manifest has no conditional, so this
   probably means the *monitor process* self-checking and standing down, not the `when`
   clause.
2. **Or a migration that cannot leave an old standalone copy in the winning position** —
   e.g. `setup --apply` removing its own copy when the plugin is present, so there is only
   one skill and the qualified trigger always wins.
3. **Or an automatic path for hosts without the `Monitor` tool** that does not depend on the
   plugin monitor, which would make P0-1's population empty.

Until then: both triggers stay, the duplicate is disclosed (§4.11), and this is not a dated
gate — there is nothing to review on a timer, only work to do.

### 9.4 Rollout — nothing to order

With the manifest unchanged there is no cross-channel migration in this release. The only
ordering constraint left is internal: **PR1 and PR2 release together** (§13), because PR2 is
what delivers PR1's instructions to the launcher-disabled and deferred-autostart population.

### 9.5 DECIDED — the plugin keeps declaring `tandem-channel`

**Decision recorded 2026-08-10 (Bryan).** The channel only delivers when the user starts
Claude Code with `--dangerously-load-development-channels`. A session where it *is*
delivering is one where doubled wakes may become visible and `SKILL.md:102` can stand the
self-armed watch down — opportunistically, per §4.12, not reliably. Either way the cost is
bounded by the contract that does hold unconditionally: payload-free wakes and inbox
de-duplication. So there is no delivery *conflict* to fix, and removing the declaration would
break users currently running plugin + flag for no behavioural gain.

The residual cost is diagnostic, not functional, and it is real: the shim subscribes to
`/api/events` unconditionally (`src/channel/run.ts:207`) whether or not the host negotiated
the channel, so plugin installs inflate the subscriber count with consumers that deliver
nothing. After PR1 that count no longer gates arming, so it stops causing the §3 failure —
but it still makes `doctor` report coverage that does not exist and keeps
`takeWakeAdvisory()` silent for genuinely uncovered sessions. **Fix the reading, not the
manifest:** that is what §10's advisory work is for, and `doctor`'s subscriber line should
say plainly that a positive count does not mean this session is covered.

Consequence for copy: nothing here may describe Tandem as canonicalizing on a single path.
Plugin users retain several declared paths by design. Say so in the changelog.

## 10. Wizard and documentation

`IntegrationWizardModal.svelte`:

1. Render the primary Claude Code live-update guidance independently of
   `channelRegistered !== null`; that state controls only fallback details. This is #1389.
   **Hold it until §12's combined acceptance passes** — it is the copy that promises an
   automatic first-use attempt, so it must not ship ahead of evidence that the attempt
   happens.
2. Say that Claude **tries** to start listening on first Tandem use "where Claude Code
   offers a Monitor tool," and **name the channel shim as the fallback in the same
   sentence** — that phrasing is the CLAUDE.md contract, and the plugin monitor cannot cover
   for the account gate, so it must not be offered as the alternative there (§4 invariant 4).
3. Never mark the result configured, on, or live based on setup or skill dispatch. Tandem
   cannot observe per-session Monitor success.
4. Treat absent Monitor and failed invocation alike: state the limitation once, continue
   polling, disclose the channel fallback.
5. Branch channel fallback over registered, unregistered, and unknown states; never render
   registration alone as live push.
6. **#1390 — surface copyable commands; do not execute the install.** Scope reduced by the
   fifth pass, and correctly. `claude plugin marketplace add bloknayrb/tandem` and
   `claude plugin install tandem@tandem-editor` are plain CLI subcommands and Tandem could
   `execFile` them — but the wizard's apply route already writes the managed MCP entry **and**
   installs the standalone skill (`src/server/integrations/api-routes.ts:857-893`), so a
   plugin install offered *after* that produces exactly the double-installed shape whose
   duplicate this plan spends §9.3 failing to remove. The fourth pass proposed the action and
   warned against its consequence in the same section without resolving the contradiction.

   Ship the commands with a copy affordance in both branches of the explainer panel, which is
   what #1390 asks for. Executing an install is a **separate work package**, out of scope
   here, and it cannot be built as a button bolted onto the current flow — it needs the
   connection route chosen *before* mutation:

   - **Tandem-managed:** managed MCP entry + standalone skill; no plugin.
   - **Plugin-managed:** plugin only; skip the managed MCP entry, the channel entry, and
     `installSkill()`.
   - **Existing mixed state:** migration preview and separate consent before removing a route.
   - **Existing plugin-only state:** show it is installed rather than offering a second route.

   If that package is ever built, it carries its own contract: a loopback-only, Origin-checked,
   nonce-protected endpoint (the posture every other mutating route in `api-routes.ts` has);
   a fixed executable with allowlisted arguments and no client-supplied fragments; idempotent
   detection across marketplace-present / installed / enabled / disabled / alternate-marketplace;
   timeout, cancellation, restricted env, bounded and scrubbed output; a defined partial-failure
   state when marketplace registration succeeds and installation does not; success wording that
   says **"Plugin installed"** and never "live updates enabled"; and tests for no-click/no-mutation,
   exact arguments, missing CLI, timeout, failure, retry, existing install, non-loopback/CSRF
   rejection, and output redaction.
7. **Plugin install is not a fix for the Windows gap.** Recorded because it is the obvious
   wrong turn: a plugin install helps a user without a `Monitor` tool only because the
   manifest still declares a monitor for them — which §9.3 preserves by changing nothing.
   Installing the plugin is orthogonal to that and must never be presented as the remedy.

Keep the global advisory diagnostic-only (`src/server/mcp/wake-advisory.ts`):

1. Preserve `takeWakeAdvisory()` behavior and its Solo, one-shot, prompt-injection,
   envelope-order, and no-content protections.
2. Rewrite its comments and test descriptions so zero subscribers reads as a truthful global
   diagnostic, not the standalone self-arm trigger.
3. **Do not write "a positive count proves no per-session coverage."** `wake-advisory.ts:12-17`
   correctly says a positive count proves **nothing either way**; the previous draft would
   have replaced a true comment with a false one. Keep the existing framing.

Documentation surfaces to update: `README.md`, `CHANGELOG.md` under `[Unreleased]`,
`CLAUDE.md`, `docs/architecture.md`, `docs/decisions.md` (dated ADR-049 amendment),
`docs/troubleshooting.md`, `docs/user-guide.md`, `docs/cli.md`, `src/cli/setup.ts`,
`src/cli/doctor.ts`, `IntegrationWizardModal.svelte`.

Two documentation guards:

1. Positive: the skill, README, wizard, and user guide carry the verified first-use behavior
   and its Monitor limitation.
2. Pull authority: reject claims that push removes the need to poll; positively require that
   wakes are best-effort and `tandem_checkInbox` remains authoritative. Mutation-check by
   restoring the current user-guide "without needing to poll" sentence.

## 11. Corrected from the previous draft

Recorded rather than silently dropped, since both would have produced wrong code.

- **"Leave `src/cli/skill-content.ts` as the single content source" was inverted.**
  `skills/tandem/SKILL.md` is authoritative; `skill-content.ts:14-20` is a `readFileSync`
  loader whose own docblock says so. They cannot drift and need no equality test.
- **"Continue stating that a positive count proves no per-session coverage" was false.**
  `wake-advisory.ts:12-17` says a positive count proves nothing either way.
- **The §3 repro was presented as an undiscovered gap.** `SKILL.md:89` documents it, ADR-028
  records it as a regression, and `SKILL.md:102` already carries the mitigation.
- **The refresh problem was described as mis-ordering.** It is unreachability under two
  configurations, which is worse and makes PR2 more valuable.
- **The Windows asymmetry was framed as hypothetical.** It is in ADR-049 and the spike, and
  four shipped surfaces currently contradict it (§8).

From the fourth draft, corrected by the fifth pass:

- **Option D's population table was wrong.** "Double-installed → self-armed watch only"
  assumed the `Monitor` tool exists. Where it does not, the answer is "no path at all." A
  table column that states an outcome must state the precondition that outcome depends on.
- **Release ordering was treated as install ordering.** §7.1 had already established the two
  channels update independently; §9.4 then reasoned as though shipping order constrained
  them. Getting a fact right in one direction and forgetting it in the other is its own
  failure mode.
- **Probe verdicts were binary.** Two branches turn an ambiguous host failure into a product
  decision. The project already has this lesson recorded, and this plan did not apply it.
- **"Doubled wakes appear if and only if a second path delivers" was too strong.** Rate
  limiting can hide the duplication; `TaskStop` is opportunistic recovery, not a bound.
- **The PR4 gate was internally inconsistent** — the header promised one ~105 s run while the
  body defined four probes and the sequence required one. Resolved by removing the gate.
- **`/plugin update` was asserted as the sole refresh path** without verification. Only the
  weaker, sufficient claim is kept (§7.1).

## 12. Verification

### Automated

1. PR1's instruction guard plus its mutation check.
2. PR2's refresh lifecycle unit/integration tests, including S1 (§9.1) across normal,
   launcher-disabled and deferred-autostart startup.
3. The four-surface Git Bash assertions (§8), pinned so the half-true claim cannot return.
4. Existing wake-advisory, wake-socket Solo/chat, supervisor fresh/resume, event queue,
   setup/doctor, and plugin-manifest suites — **all unchanged**, since the manifest is not
   edited.
5. Wizard component/E2E coverage asserting the **complete rendered contract per branch**, not
   merely that the primary message is present — a presence-only assertion passes with wrong
   fallback instructions or inferred success styling:
   - all states: attempt-based wording, the Monitor qualification, no configured/on/live claim;
   - registered: launch flag only, and registration explicitly is not delivery;
   - unregistered: registration plus launch instructions;
   - unknown: explicitly unverified, no success styling;
   - Claude Desktop / stdio: no Claude Code Monitor or plugin guidance at all;
   - plugin commands present and copyable in **both** branches (#1390).
6. Documentation tripwires.

### Real-host acceptance — the combined gate

**This is one gate over PR1 + PR2 together, not a PR1 gate.** PR1 changes the instructions;
PR2 is what puts them on disk for the launcher-disabled and deferred-autostart population
that reported the bug. Seed **real v9**, start Tandem through normal, launcher-disabled and
deferred-autostart paths, verify the awaited v10 refresh landed, then run the original repro:

- unrelated subscriber already attached;
- no slash command;
- ordinary natural-language Tandem request;
- skill dispatch observed;
- successful `tandem_status` observed;
- one persistent built-in Monitor attempt observed;
- user event wakes the session;
- wake leads to `tandem_checkInbox`.

**Bounded sample, with a control, and a defined failure meaning.** The fourth pass said "a
failure to dispatch is not a regression — record the ratio and re-run," which made the gate
unfalsifiable. Every existing F-finding used an **explicit slash dispatch**; natural-language
dispatch is unmeasured. So: run a bounded natural-prompt sample **plus an explicit `/tandem`
control** in the same configuration.

- **At least one natural dispatch must complete the whole chain above.** That is the
  product claim; nothing else establishes it.
- **A dispatch that occurs and then declines to arm is a hard failure** — that is the
  precondition PR1 removes, still present.
- **Zero natural dispatches across the sample, with the explicit control passing**, means the
  host does not select the skill from ordinary work. PR1 then ships as an *instruction
  improvement only*, the changelog says so, and **#1389's automatic-attempt wizard copy does
  not ship**. It has not demonstrated the requested behaviour, and stronger copy must not
  paper over that.
- **Control also fails** → the rig is wrong; INCONCLUSIVE, fix the harness first.

Run the sample in **both** plugin-only and double-installed configurations with
version-distinctive bodies, since F6/F7 cannot tell us which copy natural language selects.

### Standard gates

Focused Vitest while iterating; `npm run typecheck`; `npm test`; `npm run test:e2e` for
wizard changes; manual Windows run, plus macOS/Linux verification or an explicit retained
platform caveat before any cross-platform claim.

## 13. Sequence

1. **PR1** — skill precondition removal, version 10, plus §8's Git Bash correction across all
   four surfaces. Test-first. Merges independently.
2. **PR2** — refresh reachability, including S1. Test-first. Merges independently.
3. **Combined real-host acceptance** (§12) — seeded v9, three startup modes, natural-prompt
   sample with explicit control, in both install shapes. **This is the release gate.**
4. **Privacy/transport reviewer** — Solo, payload-free wake, pull authority, supervisor,
   version skew, before any UI claim changes.
5. **Release PR1 + PR2 as one changelog entry**, with the §4.11 duplicate disclosed. If §12's
   natural sample returned zero dispatches, the entry claims an instruction improvement only.
6. **#1389 wizard copy + #1390 copyable commands** — ships only if §12 passed with at least
   one natural dispatch.
7. **Probe agent, non-blocking** — M, Q, S2, T against the existing `scripts/spikes/` harness,
   with PASS/FAIL/INCONCLUSIVE. These inform the deferred §9.3 migration; nothing waits on
   them.

Note what is *not* in this list: any manifest edit, and any plugin-install execution. Both
are deferred with their prerequisites recorded (§9.3, §10.6).

## 14. Scope boundaries

- No server-side subscriber leases or invented per-session identity.
- No claim that the correct document-owning session receives a globally claimed inbox item;
  per-client routing remains separate work.
- No push-based inbox suppression; pull remains authoritative.
- **No marketplace installation at all in this work** — automatic or click-driven. #1390 ships
  copyable commands only; executing an install needs the mutually-exclusive connection-route
  design and its security contract (§10.6), which is a separate work package.
- No channel-shim removal, from the manifest or anywhere else (§9.5); it remains the explicit
  fallback.
- **No manifest edit of any kind.** Both monitor triggers stay (§9.2). Narrowing is deferred
  until one of §9.3's three prerequisites exists.
- No configured/on/live wizard claim without directly observable per-session success — and no
  automatic-attempt claim at all unless §12's natural sample produced at least one dispatch.
