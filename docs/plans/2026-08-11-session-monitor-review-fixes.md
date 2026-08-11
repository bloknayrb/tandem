# Plan: fix the PR review findings on #1393 and #1397

**Date:** 2026-08-11
**Diffs reviewed:** `20117da..0b1d80e` (#1393, spike harness) and
`codex/fix/session-monitor-auto-arm..fix/first-use-arming-probability-v2` (#1397, product prose).
**Reviewers:** five agents (two code reviews, comments, tests, silent failures), then three more on
this plan. Every finding was re-checked against the branch before it entered this plan. What did not
survive that check is in §5.

Line numbers refer to `scripts/spikes/session_monitor_acceptance.py` and
`scripts/spikes/test_session_monitor_acceptance.py` unless noted.

## 1. What held up, and what didn't

Held up: `_evaluate_shape` handles all six reachable row shapes correctly, `_pid_alive`'s ctypes
rewrite is correct, `ingest_capture` cannot launder a diagnostic import into release-eligible
evidence (every artifact is re-hashed and compared with `compare_digest`). #1397's two prose strings
are factually accurate and its version bump is complete.

Didn't: the new decline path records a negative without showing the negative was the model's choice.
That is A1. There is also one evidence-integrity bug (A3) and one untested invariant (A2).

**The evidence bundle is intact**, at `…\scratchpad\session-monitor-fixture` — ten `direct-live`
rows, ten hook traces. I briefly reported it lost; my `find` used `-maxdepth 7` and the path is
deeper than that. So the PASS in #1393 is auditable, and A4 and A11 below are settled from the real
traces rather than from docs. A session-scoped scratchpad is still the wrong home for signed
evidence, which is A14.

## 2. Where each change goes

| Work | Branch | PR |
|---|---|---|
| §3, §4 (harness) | `codex/test/session-monitor-acceptance` | #1393 |
| B1, B2 (product tests) | `fix/first-use-arming-probability-v2` | #1397 |

#1398 (`.gitignore`) is untouched.

## 3. Critical

### A1. Make a recorded decline attributable

**Problem.** "The model chose not to arm" and "the skill never worked in this session" look
identical to the harness: `Stop` fires, no `Skill` event, no marker file. `capture()` records both as
a healthy row with a benign negative (`:1293-1311`). A false decline can't produce a false PASS — it
lowers `natural_successes` — but it can blame the model for a real breakage.

**Fix, in two parts, both using evidence the row already has.**

**A1a — no change needed.** Two of the three causes are already gated. A broken install or a failed
refresh fails the hash proofs computed before the PTY spawns: plugin rows need
`candidate_skill_sha256` and `ready_skill_sha256` to equal `plugin_candidate`, managed rows need the
v9→candidate transition plus `ready_at <= server_ready_at`. Either mismatch is inconclusive
(`:2444-2471`). Recorded here because the first draft of this plan built a live probe to catch causes
that were already covered.

**A1b — one branch.** The third cause has a discriminator already in the row. A decline with
`status_succeeded: True` means the model reached Tandem, got a `wakeUrl`, and chose not to arm —
attributable, and exactly the measurement. `status_succeeded: False` means the session never got a
good status response, so the negative means nothing:

```python
if not chain["skill_dispatched"] and not chain["status_succeeded"]:
    inconclusive.append(
        f"{trial_id}: decline is not attributable — no successful tandem_status in this session"
    )
```

`status_succeeded` is deliberately outside `DISPATCH_CONSEQUENT_FIELDS`, so it is free to serve as
the test. Both stored declines carry it true, so this does not change the measured result.

**One semantic point.** A decline caused by the skill's *description* failing to attract the model is
a genuine product decline and must count as one — that is the measurement #1397 exists to move. Only
breakage and unreachability are rig failures.

### A2. Test the PENDING branch

**Problem.** If the settle window closes with the classification still `pending` — no dispatch signal
and no completed `Stop` — `capture()` raises `structured-monitor-idle-not-observed` (`:1309-1311`).
That raise is the "a decline needs positive proof" invariant, and nothing tests it. Treating PENDING
as declined would turn a hung trial into a benign negative.

**A stand-in driver cannot test this.** Every stand-in in the suite replaces `ConptyTrialDriver`
wholesale — `DecliningDriver.capture()` (`test:1586-1612`) builds a `MachineTrialCapture` by hand and
never enters the real method, as do `FakeDriver` (`test:295`) and `FakeConptyDriver` (`test:363`).
Such a test would only re-prove that `produce_trial` converts a `TrialCaptureFailure` into a
`failed-live` row, which `FailingDriver` already covers (`test:988`), and an inverted comparator
would pass it.

**Fix.** Extract the decision at `:1294-1311` into a pure function, following the `classify_dispatch`
precedent this file already sets and the suite already tests directly (`test:1382-1440`):
`settle_and_classify(classify_turn, monitor_idle, wait_until) -> str`, returning the classification
or the sentinel that makes `capture()` raise. Test it with fabricated `classify_turn` callables. The
extraction is the test strategy — without a seam there is nothing to assert against.

### A3. Superseded evidence bundles point at the wrong capture

**Problem** (`:1960-1977`). `_supersede_prior_capture` renames `artifacts/<trial_id>/` to
`artifacts/<trial_id>.superseded-N/`, then writes the prior evidence row verbatim to
`superseded-evidence-row.json`. That row's `artifacts[].path` values still read
`artifacts/<trial_id>/…`, the live slot. Once the slot is repopulated, following the archived
manifest returns the *new* capture's bytes instead of failing. Silently wrong, in a module whose
contract is "never deletes, always auditable".

**Fix.** Rewrite the archived row's and moved manifest's paths to the supersede location before
writing them. Assert that each path resolves under the supersede dir *and* that the bytes match the
recorded sha — an existence check alone would pass against this bug.

## 4. Important — harness

**A4. Filter dispatch on the skill's name, not just the tool's.** `tool_name == "skill"` (`:240`) is
correct: across the ten traces every host tool name is bare (`Skill` ×3, `Monitor` ×7, `ToolSearch`
×20) and every MCP tool is prefixed (`mcp__plugin_tandem_tandem__*` ×38), which is the split the
file's `.endswith(...)` convention encodes. `tool_name == "monitor"` (`:353`, `:1641`, `:1704`) is
correct for the same reason. But the check reads *only* `tool_name`, so any skill the model invokes
counts as a Tandem dispatch. Also require the final `:`-delimited segment of `tool_input.skill` to be
`tandem` — the observed value is bare `tandem` even with the plugin fixture installed, and matching
the final segment also covers the qualified `tandem:tandem` form that `.claude-plugin/plugin.json`
uses. One test pins all of it.

The traces also show the two-signal union is load-bearing, not defensive: the 3 `Skill` events are
the 3 dispatching naturals, and all 4 controls were caught by the marker file alone.

**A5. Dropped.** See §5.

**A6. Rename the harness timestamp key to `harness_at`.** `capture-event.mjs` writes
`JSON.stringify({ at: Date.now()/1000, ...payload })` (`:644`) with the spread second, so a
host-supplied `at` would silently replace our timestamp. No `at` exists in the documented
`PreToolUse` or `Stop` schemas, so this is defense rather than a live bug — but the real traces carry
`background_tasks`, `session_crons`, `model` and `duration_ms`, none of them documented, so the
schemas are visibly still growing. Scope: eight reader functions (`:241`, `:274`, `:347`, `:358`,
`:362`, `:373`, `:1630`, `:1638`, `:1705`, `:1728`) plus 14 test fixtures. Leave
`server_lines.append({"at": …})` at `:1082` alone — that is a server-log line, not a hook event.

**A7. Assert the settle constant's value, not just its presence.** `test:1442-1454` does
`assertIn("DISPATCH_SETTLE_SECONDS", source)`, which passes at `0.15`. Use
`assertGreaterEqual(subject.DISPATCH_SETTLE_SECONDS, 15.0)`.

**A8. Convert two `getsource` assertions, keep four with a stated reason.** Six call sites:

- `test:1458` — the one real conversion candidate, and it depends on A2's extraction. Until then,
  tighten the substring to the exact comparator text so an operator flip fails.
- `test:1647` — extract the `bool(silent_pids) or dispatch_classification == DISPATCH_DECLINED`
  boolean and unit-test it.
- `test:610` (auth preflight before spawn) — cannot convert; proving execution order needs a live run
  or an instrumented call list, and the first raising fake prevents later calls. Keep with a comment.
- `test:1444`/`:1454` (settle window) — keep as-is; A5 is dropped, so there is no new seam.
- `test:1660` — already half-behavioural; keep the `PRECONDITION_FIELDS[:3]` text guard.

**A9. Add a plausibility self-check to `passing_evidence`, scoped narrowly.** The fixture never
asserts that a row it builds is physically possible; the decline case is only correct today because
three fields moved into `CHAIN_FIELDS` and thus under a conditional loop. The invariant — if
`skill_dispatched` is falsy, no `DISPATCH_CONSEQUENT_FIELDS` member may be true — holds for every row
the harness can *produce*. But two tests deliberately build the forbidden shape to prove
`evaluate()`'s contradiction check fires: `test:1514-1530` and `test:1532`. A blanket assertion would
abort both and destroy coverage of the check A1b depends on. So this is a self-check on
`passing_evidence`'s own default output only, never applied to rows a test has modified. Audit call
sites before flipping the default `status_succeeded` to `True`.

**A10. Extract `injection_budget`.** `test:942-960` re-implements the budget formula instead of
calling `:1288`, and its copy also approximates `deadline - time.monotonic()` as `timeout_seconds`.
Extract `injection_budget(deadline, now, reserve)` and test that; what stays unverified shrinks to
call-site plumbing.

**A11. Correct two comment claims.** `wakeUrl` is described as shipping in every read-mode
`tandem_status` response in two prod comments (`:77`, `:2504`) and two test comments (`test:1479`,
`test:1582`); `document.ts` spreads it conditionally and it is absent in stdio — qualify it. And cite
the "measured 45s to 664s" figure rather than softening it: the bundle is intact and the numbers are
in each trial's `server_log.monitor_timing`.

**A12. Name rig failures instead of burying them.** `_open_acceptance_document`'s broad
`except Exception` and the injector's discarded `returncode` both fail safely — observations degrade
to `False`, never to a fabricated `True` — but the cause lands only in a `server_log` blob nothing
reads. Collect them into `server_log["failures"]` and include that list in `evaluate`'s inconclusive
reason.

**A13. Trim the `_install_structured_trace_hooks` permission comment** (19 lines, four interleaved
ideas) without losing the why. Rides along with A11.

**A14. Document that `--root` must be a durable path**, in the module docstring and the runbook
output. A session scratchpad nearly cost this run's bundle.

**A15. Give the control arm a first-class signal.** A typed `/tandem` produces
`UserPromptExpansion`, not `PreToolUse Skill` — which is why control rows needed the marker file as a
second signal, and why the control arm's evidence currently depends on a monitor process spawning.
Add `UserPromptExpansion` to the fixture's hook set and accept it for control rows. Purely additive,
and it makes the control arm observable on shapes where no monitor spawns.

## 5. Important — product tests (#1397)

**B1. Pin the description.** `tests/skill-instruction-contract.test.ts` asserts on the skill body and
the version number only, so reverting the `description:` rewrite while keeping `version: 11` passes
every test in the diff — and that description is the deliverable. Assert its two load-bearing clauses
("before the first `tandem_*` call", "lone status check").

**B2. Assert the Solo clause's direction.** `toMatch(/solo/i)`
(`tests/server/mcp-server-instructions.test.ts:71`) still passes if "hold annotations" becomes
"surface annotations". Require `/hold annotations/i` and forbid `/surface|reveal/i` in that clause.

## 6. Rejected

- **An in-session `/tandem` probe after a decline, plus a `skill_invocable` precondition.** Killed on
  three counts. It resolves through the CLI's slash registry rather than the model's discovery path,
  so it proves the file is loadable, not that discovery works. A probe failure raises, becomes
  `FAILED_LIVE_CAPTURE`, and discards the whole row's evidence (`:1358`, `:2385-2386`). And a
  `PRECONDITION_FIELDS` entry lets one flaky row force its entire shape to INCONCLUSIVE
  (`:2473-2478`) — a clean 2-of-3 natural pass could fail on a third row's hiccup. A1 replaces it
  with one branch.
- **Widening the settle window, or replacing it with trace quiescence.** The argument rested on the
  file's own "measured between 45s and 664s", which measures something else: `_monitor_timing`
  (`:1696-1721`) is `PreToolUse Monitor` → `PostToolUse Monitor`, i.e. how long the armed Monitor
  call blocked the turn, already bounded by the outer wait at `:1288`. `DISPATCH_SETTLE_SECONDS`
  absorbs hook-subprocess write latency for a turn that has already emitted `Stop` — sub-second.
  Quiescence was also worse: "no new lines for ≥5s" ends early when writes are OS-buffered, which
  reopens the contamination the window prevents. A11 keeps the part that was real (cite the figure).
- **`when: "always"` on the plugin monitor. Decided against by Bryan, 2026-08-11** — "i dont want the
  monitor to always be armed." This closes the question #1354 left open; my 3-of-6 first-use
  measurement was new input to it and did not change the answer. #1354 and ADR-049 stand, and the
  model-independent option is off the table, so first-use arming stays a matter of raising
  probability (#1397) rather than removing the judgment. Record in ADR-049 alongside #1397's
  amendment.
- **Deriving dispatch from the `Skill` event alone.** A typed `/tandem` emits no such event, so this
  pins every control row false and makes `controls_pass` unreachable. The union stands.
- **Re-running the ten trials now** — gated, not rejected. A re-run before A1b reproduces the same
  unattributable declines. Needs Bryan's machine and the fixture login.
- **The `plugin-control` dispatched-but-incomplete asymmetry** — pre-existing, out of scope.
- **The injector's fixed 750ms wait** — pre-existing; comment corrected under A11, behavior alone.
- **The decoy-vs-advisory conflict** — already tracked as follow-up in #1397's body.

## 7. Verification

- `python -m unittest scripts.spikes.test_session_monitor_acceptance` — 69 tests today, expect ~+8:
  `settle_and_classify` including PENDING→raise, the A1b branch, archived supersede paths resolving
  with matching shas, the `tool_input.skill` filter and the bare-name pin, a hostile `at` payload,
  the teardown-vacuity boolean, `injection_budget`.
- `npm run typecheck` and `npm test` on the #1397 branch.
- **Not claimed:** that any of this validates the product change. Per #1397's body, a green ten-trial
  re-run must not be read as validation while the decoy suppresses the wake advisory. A re-run here
  would only confirm that declines are attributable.

## 8. Order

1. A3, A6, A7, A9, A10, A11 + A13, A14 — mechanical.
2. A2's extraction, then A1b. A2 creates the seam; A8's `test:1458` conversion needs it too. Doing
   A1b first would change the decline semantics while its control flow is still untested.
3. A4 — the `tool_input.skill` filter and the test pinning the bare tool names.
4. A15 — independent of the rest.
5. B1, B2 on the #1397 branch.
6. Add the bundle's location to #1393's body so the PASS it cites is checkable by someone other than
   this session.
