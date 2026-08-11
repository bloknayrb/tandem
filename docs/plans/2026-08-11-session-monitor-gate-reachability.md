# Plan: make the session-monitor gate able to reach its own PASS state (PR #1393)

**Date:** 2026-08-11 (rev 2 — after two adversarial reviews, each of which found P0s)
**Branch:** `codex/test/session-monitor-acceptance`
**Scope:** `scripts/spikes/session_monitor_acceptance.py` + its test file. No product code.

Agent feedback incorporated. Rev 1 of this plan was wrong in three ways, all now corrected from
*measured* artifacts rather than argument: it would have broken every control row, mislabelled a
decline as self-contradictory, and claimed a verification step that cannot exist. Each is recorded
below rather than quietly deleted, because two of the three are traps a later revision could
re-enter.

## The contradiction, measured

The gate is designed to tolerate a natural-dispatch rate below 100%: PASS requires
`natural_successes >= 1 and controls_pass` (`:2342`), and a *zero*-dispatch sample is a separate
hard failure (`:2331`). So 1-of-3 is intended to pass.

It cannot. Current `evaluate` output for the plugin shape, from four real captures:

```
"verdict": "INCONCLUSIVE", "natural_successes": 1, "controls_pass": true,
"reasons": [
  "plugin-natural-1: release evidence requires direct live capture",
  "plugin-natural-1: process-tree teardown proof is absent",
  "plugin-natural-1: host control preconditions not established
     (capture_healthy, turn_idle_after_monitor, subscriber_growth_proven, autonomous_turn_seen)",
  ... same three for plugin-natural-2 ]
```

`natural_successes: 1` + `controls_pass: true` is *literally* the PASS predicate, and the verdict
is still INCONCLUSIVE. The two rows blocking it are the two naturals where the model chose not to
invoke the skill — the outcome the sample size exists to measure.

**Root cause is single, and it is not the schema.** A natural trial that never invokes the skill
never arms a monitor, so `_structured_monitor_is_idle` never becomes true; the wait at `:1149-1153`
burns the remaining budget and `:1156` raises `structured-monitor-idle-not-observed`. The capture
*aborts*. All three blockers are downstream of that one abort: no manifest → not `direct-live`; no
teardown phase → no process-tree proof; aborted → `capture_healthy` false.

## Why "no dispatch" is distinguishable from "the rig broke"

This is the objection that killed the previous attempt, and it is the right one: absence of a
signal also matches a broken hook, an unanswered permission dialog, a crashed MCP server, or a
hang. Two trace signals settle it, both verified against captured artifacts:

| | `plugin-natural-1` (declined) | `plugin-natural-3` (dispatched) | `plugin-control` (`/tandem`) |
|---|---|---|---|
| after `UserPromptSubmit` | `ToolSearch`, `tandem_status` | **`Skill`**, `ToolSearch`, `tandem_status`, **`Monitor`**, `tandem_checkInbox` | `ToolSearch`, `tandem_status`, **`Monitor`**, … (**no `Skill`**) |
| terminal event | **`Stop`** | `Stop`, then autonomous `UserPromptSubmit` | `Stop`, then autonomous `UserPromptSubmit` |

1. **`PreToolUse Skill`** is emitted when the *model* invokes the skill, independent of arming.
2. **`Stop` after the prompt** is positive proof the turn *completed* — the model made a choice
   rather than being blocked. A crash or hang produces no `Stop`. The permission-dialog case is
   already named separately (`_permission_dialog_blocking` → `permission-dialog-blocked-turn`).

A benign negative requires **both** a `Stop` and the absence of dispatch. Absence alone is never
sufficient.

### Correction 1 (P0, was wrong in rev 1): `/tandem` emits no `Skill` event

Rev 1 proposed deriving `skill_dispatched` from the `Skill` hook event **universally**. Measured
from `plugin-control`'s real trace: a typed `/tandem` slash dispatch produces **no `Skill` tool
event** — yet the same trace contains `PreToolUse Monitor`, so the skill unambiguously ran. A
universal rule would therefore have pinned `skill_dispatched: false` on every control row →
`controls_pass: false` permanently (`:2304-2307`, `:2327-2330`) → PASS *less* reachable than
today.

**What the marker actually is** (I had this wrong in rev 1, and the truth strengthens the case):
`silent-monitor-pids.log` is written by the plugin fixture's `experimental.monitors` command, which
`build_plugin_fixture` rewrites to `silent-monitor.mjs` (`:645-671`). Those monitors arm on
`on-skill-invoke`. So the marker is the **plugin runtime observing a skill invocation** — not a
model-followed instruction, and not the built-in `Monitor` arming (that is `monitor_attempted`,
keyed on a `Monitor` `PreToolUse` carrying the wake URL). That is exactly why the control row shows
`skill_dispatched: true` with no `Skill` tool event: the trigger fired though the model never
called the `Skill` tool.

Both shapes load the plugin fixture (`plugin_dir` is unconditional at `:1602` and passed as
`--plugin-dir` at `:1056`; the module docstring says `managed-double` runs "with the plugin also
present"), so this signal is available to managed trials too.

This is also precisely what the union *buys*: marker absent **and** `Skill` event present means the
model invoked the skill while the `on-skill-invoke` trigger did not fire — the #1354 trigger
regression. Under the marker alone that reads as a decline and is laundered; under the union it is
`skill_dispatched: true` with `monitor_attempted: false` → hard failure.

**Derivation is therefore a union, not a replacement:**

```
skill_dispatched = (PreToolUse "Skill" after prompt_submitted_at) or dispatch_marker_seen
```

This keeps the discriminator rev 1 wanted (`Skill` seen, marker absent → dispatched but did not
arm → hard failure via `:2308-2309`) while remaining correct for the slash-dispatch arm.

### Correction 2 (P0, was wrong in rev 1): `status_succeeded` is dispatch-independent

`wakeUrl` is present in **every** read-mode `tandem_status` response
(`src/server/mcp/document.ts:864-870`), gated only on the wake endpoint existing — not on arming.
A declining model still calls `tandem_status`. Measured on both stored decline rows:
`status_succeeded: True` with `skill_dispatched: False`. So `:2310-2313`
(`not skill_dispatched and any(other chain field)`) **fires** on a benign decline and appends
`"later chain evidence exists without observed dispatch"` — rev 1's central claim that a decline
appends no reason was simply false.

**Fix:** that contradiction check must range over the *dispatch-consequent* fields only —
`monitor_attempted`, `monitor_persistent`, `wake_seen`, `inbox_checked`, plus the three re-homed
below. `status_succeeded` is excluded, with a comment saying why, because a cheap read that any
turn may make is not evidence of dispatch.

### Correction 3 (P1): a fifth indistinguishable failure mode, named

A skill **present on disk with the right hash but never registered by the running session** (stale
skills registry, `CLAUDE_CONFIG_DIR` mismatch) produces the same signature as a decline: `Stop`,
no dispatch. The existing hash checks (`:2261-2292`) prove only the *file's bytes*, never that the
session loaded it as invocable. This is not fully separable from a decline by trace alone.

Partial mitigation, which is real but must not be overstated: every shape requires a control row
in the **same fixture and same install shape**, and `controls_pass` is a PASS precondition. A
passing control proves the skill *was* discoverable in that shape, so a same-shape natural decline
cannot be a discovery failure. The residual risk is a discovery failure that appears *between* the
control and natural runs. Stated as a limitation of the gate, not solved.

## The fix

### 1. `skill_dispatched` = `Skill` hook event **or** marker file
Per Correction 1. Keep the marker in `server_log` as the only evidence of a *silent* monitor pid.

### 2. Let a completed non-dispatching natural turn finish the capture
Add a second terminal condition to the monitor-idle wait: the turn `Stop`ped after
`prompt_submitted_at` with no dispatch signal. On that branch skip injection and the subscriber
assertion, run teardown normally, and write a healthy `direct-live` capture whose
dispatch-consequent chain fields are all `False`. Keep raising
`structured-monitor-idle-not-observed` when dispatch *did* occur but arming/idle did not follow.

**Latch the classification (P1).** The trace is written by separate hook processes and polled every
0.2s, so a tick that sees `Stop` flushed but `Skill` not yet would misclassify a real dispatch as a
decline — laundering the exact case this exists to catch, one layer down. So: treat "dispatch ever
seen after the prompt" as a one-way latch, and re-read the trace once after a short settle before
committing to the declined branch. Cheap, and removes the dependency on hook write ordering.

`injected_at` is safe on this branch: with no `Monitor` event `monitor_at` is `None`, and the
`isinstance` guard in `stop_after_monitor` (`:244-251`) makes it `False` regardless of the
`float("inf")` default. Verified; rev 1 carried this as an open worry and it is closed.

### 2b. A fourth blocker, found while implementing

`silent_monitor_teardown_verified` is `bool(silent_pids) and all(not alive)`. A decline never
invokes the skill, so `on-skill-invoke` never fires, so no plugin monitor spawns and the pid list
is empty — the field would be `False` and `:2396-2400` would still reject the row. I had
attributed that reason entirely to the abort; it is *also* structurally true of every honest
decline. The `bool(silent_pids)` conjunct exists so a *dispatching* trial cannot claim teardown
proof it never earned, so it becomes vacuous **only** on the declined branch. A dispatching trial
with an empty list stays unproven, and is separately a hard failure via `skill_dispatched`.

The count of independent blockers on one declined row is now four, and only one was the schema.
Each was found by a different means: three by reading the gate's own output, this one by reading
the teardown computation while writing the code. The lesson for the PR body: "the capture aborts"
was the root cause but not the whole repair surface.

### 3. Re-home the three chain-dependent preconditions
`turn_idle_after_monitor`, `subscriber_growth_proven`, `autonomous_turn_seen` sit in
`PRECONDITION_FIELDS` (`:63-65`) but are consequences of arming, not facts about host control.
`missing_precondition` (`:2294`) applies them unconditionally and `continue`s past the chain logic,
so they are provably false on any legitimate decline. Move them into `CHAIN_FIELDS`.

`OBSERVATION_FIELDS` is the union, so the `set(...) != set(...)` check at `:2055` and
`machine_derived` at `:1977` are unaffected, and `_attestation_payload` uses `sort_keys=True`
(`:1911-1913`) so signatures are order-independent. **No new fields.**

While here (P2): make `transcript_health={... for field in PRECONDITION_FIELDS[:3]}` (`:1232`)
name-based. The slice survives this edit only because the moved fields sit at the tuple's end.

### Verdict deltas

| row shape | before | after |
|---|---|---|
| natural, declined, turn completed | INCONCLUSIVE (×3 reasons) | benign; counts in the `observed_dispatches` denominator only |
| natural, dispatched, chain incomplete | INCONCLUSIVE ("preconditions") | **FAIL** ("declined or failed after dispatch") |
| control (`/tandem`), chain incomplete | INCONCLUSIVE | INCONCLUSIVE (unchanged) |
| natural, dispatched, full chain | pass | pass (unchanged) |

Row 2 is a deliberate tightening: a run that read the skill and then failed to arm is a product
failure, and reporting it as "host preconditions not established" is laundering.

## Verification

**Rev 1's "decisive" step is deleted (P0, found independently by both reviewers).** It claimed
re-`evaluate`ing the four existing rows would reach PASS with no re-capture. False:
`produce_trial` (`:1707-1719`) bakes `capture_healthy=False` and
`eligibility=FAILED_LIVE_CAPTURE` into the row **and signs it** on any failure code, and
`_evaluate_shape:2206-2207` rejects non-`direct-live` unconditionally. `evaluate` never recomputes
observations from traces. `plugin-natural-1` and `-2` must be **re-captured** under the new capture
code. Corrected cost: **8 live sessions, not 6** — the two plugin declines plus the six `managed-*`.

1. Offline tests, before any live burn:
   - a completed turn with no dispatch signal yields a healthy `direct-live` row whose
     dispatch-consequent chain fields are all `False`, and the gate appends **no** reason for it —
     *including* when `status_succeeded` is `True` (Correction 2's regression test);
   - a `Skill` event with no `Monitor` still raises `structured-monitor-idle-not-observed`;
   - no `Stop` and no dispatch still fails (crash/hang is not laundered);
   - `skill_dispatched` is `True` from the marker alone with no `Skill` event (Correction 1's
     regression test — this is the control arm);
   - `skill_dispatched` is `True` from a `Skill` event alone with no marker;
   - a `Stop`-then-late-`Skill` ordering does not classify as a decline (the latch);
   - `set(PRECONDITION_FIELDS + CHAIN_FIELDS)` is unchanged by the re-homing.
2. A synthetic four-row gate test proving PASS is reachable at `natural_successes: 1 / 3` — this
   replaces rev 1's step 2 and needs no live session.
3. Re-capture `plugin-natural-1` and `-2`. Expect healthy `direct-live` rows and the plugin shape
   at **PASS**.
4. Then the six `managed-*` trials, which additionally need the seed/restore refresh-before-ready
   proof. **Residual empirical gap (P1):** every trace sample so far is plugin-shape. The union
   derivation in fix 1 makes the managed control safe via the marker, but the managed shape's
   `Skill`-event behaviour is unverified — check the first managed trace before spending the other
   five.

## Outcome (measured 2026-08-11)

Offline: 69 tests pass (55 pre-existing, 14 new).

Live, all `direct-live` and healthy:

| trial | dispatched | full chain | note |
|---|---|---|---|
| `plugin-control` | yes | yes | |
| `plugin-natural-1` | **no** | — | declined; recorded as a healthy negative, ~5 min not the full budget |
| `plugin-natural-2` | yes | yes | **declined on both prior attempts** |
| `plugin-natural-3` | yes | yes | |
| `managed-normal-control` | yes | yes | `refreshed_before_ready: true`; seeded `5e9d9b54` → candidate `5e6053dd` = ready |

**Plugin shape: PASS**, `natural_successes: 2/3`, `controls_pass: true`, zero reasons. The gate can
now reach its own PASS state on real evidence.

Two claims this revises:

1. **The natural rate is not stable, and not positional.** `plugin-natural-2` declined twice and
   then completed the whole chain on the third attempt with an identical prompt. Earlier rounds
   gave 1/3; this round gives 2/3. So the honest finding is a *variable* rate at small n, not a
   ratio — which is a stronger statement about the product than a fixed ratio would be, because
   resampling will not make it reliable.
2. **The managed shape's dispatch signal is confirmed**, closing the review's residual empirical
   gap: `managed-normal-control` shows `skill_dispatched: true` from the marker on a `/tandem`
   dispatch, so the union derivation holds outside the plugin shape it was measured in.

## To carry into PR #1393

1. Natural first-use dispatch is **unreliable and varies run to run**: across independent attempts
   with identical prompts, the same trial declined twice and then dispatched. Declining sessions
   answered the prose request straight from `tandem_status` and never read `SKILL.md`, so its
   arming instruction was never seen. #1391's instruction is correct where it runs; "arms on first
   ordinary use" overstates it. Report the variability and the sample size, not a single ratio.

1b. **A gate's synthetic fixture can encode an impossible row and hide the defect.**
   `passing_evidence` sets every precondition true on every row, so its "declining" naturals claim
   `turn_idle_after_monitor: true` — unreachable without an armed monitor. The suite's own 1-of-3
   PASS test therefore passed against a shape that cannot occur, which is precisely why a gate
   unable to pass on real evidence shipped unnoticed. Worth a lessons-learned entry: when a gate
   asserts it tolerates a partial outcome, the fixture for that outcome must be derived from a real
   captured row, not from the all-true row with a few fields flipped.
2. A declined trial is **materially cheaper** than burning the full budget, but the saving is not
   yet measured — do not quote a figure (rev 1 guessed ~30s; the wait alone has a 60s floor and
   server boot, PTY spawn, and teardown are all additive, so the real floor is minutes).
3. The gate reuses one authenticated identity for all trials, which is a poor instrument for
   separating normal latency from throttling. State as a limitation.
