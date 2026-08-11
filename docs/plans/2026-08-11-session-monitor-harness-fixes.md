# Plan: unblock the session-monitor acceptance harness (PR #1393)

**Date:** 2026-08-11 (revised after adversarial review)
**Branch:** `codex/test/session-monitor-acceptance`
**Scope:** `scripts/spikes/session_monitor_acceptance.py` and its test file. No product code.

Agent feedback incorporated — two adversarial reviewers examined the first draft; both found
P0s, and both are addressed below. The first draft would have spread a latent bug rather than
fixing it (Defect C), and overstated what one measurement proved (see "What is still
unexplained").

## What the evidence actually says

A `Monitor` call armed by the skill looks like this (captured from a live trial's
`PreToolUse` hook payload):

```json
{"description":"Tandem wake events (comments, chat messages)",
 "timeout_ms":300000,"persistent":true,"ws":{"url":"ws://127.0.0.1:50807/api/wake"}}
```

It is a **blocking wait on the wake socket**. Confirmed server-side: `/api/wake` is push-only
and sends nothing but protocol pings until a wake-worthy event arrives
(`src/server/events/wake-socket.ts:229-250`). The harness's own injector runs only *after* the
monitor-idle check (`session_monitor_acceptance.py:1062-1084`), so during the entire block
nothing was sent on the socket the call was watching. Today's trial:
`PreToolUse Monitor` at t+21.4s, `PostToolUse` at t+685.0s — 664s blocked, past its own 300s
`timeout_ms` — one `Bash` call, then `Stop` at t+692.6s.

The remedy I was applying yesterday (raise a fixed wait cap) was wrong because it treated the
duration as latency to be out-waited by a constant. What replaces it is a *deadline-derived*
budget, not a bigger constant.

## What is still unexplained (and must not be assumed away)

Across six consecutive runs the block has grown monotonically: 45, 137, 235, 292, 437, 664s.
One reviewer correctly objects that the captured `tool_input` establishes only *what kind* of
call this is, not why this instance took 664s — a throttled call and an inherently
long-blocking call produce identical JSON. I claimed too much yesterday and too much in the
first draft of this plan.

One counter-datum I have that the reviewer did not: the 664s sample was taken **after** an
overnight usage-limit reset, and it was still the longest of the six. A reset that does not
reset the duration argues against simple accumulating backoff, but it does not identify the
cause either.

So the honest position is: **the duration is unexplained.** Consequences for this plan:

- Do not bake ~660s into anything as a constant. Every wait derives from the caller's
  `--timeout-seconds`, so a longer block costs budget rather than breaking the harness.
- Record the measured duration in the evidence bundle (below), so the ten trials produce a
  distribution instead of one anecdote plus prose.
- Do not claim in PR #1393 that 664s is representative. Claim what is measured.

## Defect A — the capture-exists guard runs after the live session

`:1449` raises `capture already exists for <trial>`, but it sits *after* the try/finally that
drives the ConPTY session (`:1433-1444`). Today that cost a full 12-minute authenticated
session whose artifacts were then never written, destroying the PTY transcript needed to
diagnose the run — and discarding the `TrialCaptureFailure` record the harness otherwise
preserves for failed live trials.

**Fix:**

1. Hoist the `manifest_path.exists()` check above `try:`, before `seed_managed_skill` and any
   process spawn. Without `--overwrite` it now fails in well under a second.
2. Add `--overwrite` to `capture`. Reviewer P2: the rename must **not** run as the first
   hoisted step — if `seed_managed_skill` then throws on its own
   `"managed skill backup is already active"` guard (`:1576-1577`), the prior valid capture
   has been moved out from under the `evidence.json` row that references it, with no new row
   written. So: validate early that overwriting is permitted and that a supersede slot is
   free; perform the rename **late**, immediately before writing the new artifacts, once a
   capture is actually in hand.
3. Supersede rather than delete: `artifacts/<trial>/` moves to
   `artifacts/<trial>.superseded-<n>/`, `n` being the lowest free positive integer.
4. Reviewer P2: `_replace_evidence_row` (`:1555-1564`) overwrites the `evidence.json` row —
   the thing `evaluate` actually reads — unconditionally and without history. Carry the
   superseded row into the superseded directory so the artifact protection and the row
   protection agree.
5. Thread `--overwrite` through the `runbook` command generator (`:2159-2172`) so the printed
   operator sequence does not drift from what the tool supports.

## Defect B — a control trial dispatches twice and races itself

`:1011-1047` sends `/tandem`, waits, then *also* types
`"Use Tandem to report the current collaboration state."`. That second write is what has
failed every attempt with `user-prompt-submit-not-observed`: it is typed into a turn that is
still occupied by the blocking Monitor call.

The second dispatch is not required by the evidence model. `prompt_submitted` reads *any*
`UserPromptSubmit` (`:258`), and `/tandem` produces one at t+6.3s in every trace;
`skill_dispatched` comes from the marker file; `wake_seen`/`inbox_checked` come from the
autonomous post-injection turn. Both reviewers independently confirmed no field in
`PRECONDITION_FIELDS` or `CHAIN_FIELDS` needs the prose prompt's text. The natural trials use
the prose prompt *as* their dispatch; the control trial's dispatch is `/tandem`. Sending both
conflates the two arms of the matrix.

**Fix:** dispatch exactly once per trial — `/tandem` when `prompt_kind == "control"`, the
prose prompt otherwise — then wait for that dispatch's own `UserPromptSubmit`.

## Defect C — the monitor-idle wait is capped at 90s for every trial (found in review)

This is the finding that makes the first draft of this plan wrong, and it is the reason no
natural trial has ever been able to pass.

`:1054-1057` waits for monitor-idle with `min(90, context.timeout_seconds * 0.55)`. For any
`--timeout-seconds >= 164` that expression is **always exactly 90**, regardless of budget.
`:1062-1063` then re-checks the predicate and raises `structured-monitor-idle-not-observed`.

For control trials this cap is currently dead code: the wait I added yesterday
(`CONTROL_FOLLOW_UP_RESERVE_SECONDS`, `:1026-1032`) already absorbed the block, and
`_structured_monitor_is_idle` (`:1342-1355`) is not time-scoped — any `Stop` after the first
`Monitor` `PreToolUse` satisfies it globally. **Natural trials never had that wait at all**, so
they have always had only 90 seconds to observe an idle that takes minutes.

Defect B deletes the control-trial wait. Doing that alone would leave the 90s cap as the only
thing between *any* trial and the block — converting a control-trial pass into a
`structured-monitor-idle-not-observed` failure. The reviewer's falsifiable prediction was that
verification would fail at ~90-110s; I accept it rather than test it the expensive way.

**Fix:** the monitor-idle wait becomes the budget-derived one. Spend the remaining deadline
minus a reserve for the injection and inbox steps that follow:

```python
INJECTION_RESERVE_SECONDS = 120.0   # wake injection + tandem_checkInbox observation
...
self._wait_until(
    lambda: self._structured_monitor_is_idle(self._read_hook_events(trace_path)),
    deadline,
    max(60.0, deadline - time.monotonic() - INJECTION_RESERVE_SECONDS),
)
```

`CONTROL_FOLLOW_UP_RESERVE_SECONDS` is deleted; this single wait replaces both. One wait, one
knob (`--timeout-seconds`), applied identically to control and natural trials.

## Defect D — the measured block is not in the evidence bundle

Reviewer P1: `CHAIN_FIELDS`/`PRECONDITION_FIELDS` are all booleans, so a trial can pass while
blocking for 11 minutes and nothing in the signed evidence records it. Given how much
machinery exists here specifically so nobody has to trust prose, the most user-visible fact
these sessions produce should not live only in raw artifacts.

**Fix:** derive `monitor_resolution_seconds` (and the raw `monitor_armed_at` /
`monitor_resolved_at`) from the `Monitor` `PreToolUse`/`PostToolUse` pair and record them in
`server_log`, which is already redacted, hashed, and attested as an artifact.

**Deliberately not** a new entry in `OBSERVATION_FIELDS`: that tuple is the gate's boolean
criteria set (`:67`), and duration must not become pass/fail — the product invariant promises
an *attempt*, not a speed. This records the measurement without inventing a threshold nobody
has justified, and without touching the attestation schema.

## What this plan deliberately does NOT do

It does not move wake injection to before the monitor call resolves. That is the tempting way
to avoid the block, and it would be wrong: `turn_idle_after_monitor` (`:241-248`, `:266`)
requires a `Stop` strictly between `monitor_at` and `injected_at` — the criterion that
separates "armed *and* idle, therefore wakeable" from "armed while still occupied". Injecting
earlier would delete the criterion rather than satisfy it. Both reviewers agreed.

Known limitation, per reviewer P1, so it is not mistaken for a guarantee: on a *failed*
capture `injected_at` defaults to `float("inf")` (`:1136`), so `stop_after_monitor` compares
against an unbounded upper edge and `turn_idle_after_monitor` can read `True` on a row that is
explicitly `FAILED_LIVE_CAPTURE`. `evaluate_gate` is safe — it gates on
`capture_eligibility != DIRECT_LIVE_CAPTURE` first (`:1932-1933`) — but the field is not a
trustworthy *diagnostic* on failed rows. Verification step 4 below therefore reads it only
from a successful capture.

## Verification

1. `uv run --with pytest python -m pytest scripts/spikes/test_session_monitor_acceptance.py`
   — 47 tests + 3 subtests pass today and must still pass.
2. New offline tests, written before the next live burn (each live mistake costs ~12 minutes):
   - capture-exists rejection drives **no** session (fake driver's `capture` never called);
   - `--overwrite` supersedes both the artifact directory and the `evidence.json` row, and
     picks the lowest free `superseded-<n>`;
   - a control trial writes exactly one dispatch;
   - the monitor-idle wait budget is deadline-derived, not 90s.
3. One live `capture --trial plugin-control --overwrite`. Expect the full chain and a
   `monitor_resolution_seconds` value in `server_log`.
4. **Then one live natural trial** (`plugin-natural-1`) before committing to the rest.
   Reviewer P0: every diagnostic sample so far is a control trial, and the natural trials are
   what the product plan's §12 acceptance actually rests on. A control pass does not license
   the other nine.
5. Compare the two `monitor_resolution_seconds` values against the six-sample sequence. If the
   duration is still climbing, stop and investigate the cause before spending eight more live
   sessions — do not raise the ceiling again.
6. Only then the remaining trials, `ingest-capture`, and `evaluate`.

## Findings to carry into PR #1393 regardless of verdict

1. A `persistent: true` Monitor call did not background: it held the turn for 664s, past its
   own `timeout_ms`. If representative, "arm on first use and go idle" understates what a user
   experiences — the session is occupied first. Report the measured distribution, not this one
   number.
2. The block's growth across six runs is unexplained. The harness re-uses one authenticated
   identity for every trial, which is structurally the worst instrument for separating "normal
   latency" from "this identity is being throttled". A real first-time user does not arm six
   monitors in a row from one device. State this as a limitation of the gate.
3. Natural trials have never had a monitor-idle budget large enough to observe an idle
   (Defect C). Any earlier natural-trial null result is uninformative and must not be cited as
   evidence about the product.
