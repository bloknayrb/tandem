"""Isolated evidence harness for Tandem's Claude session-monitor acceptance gate.

This module deliberately separates two claims that cannot share a setup:

* ``managed-double`` proves a setup-managed v9 skill was byte-for-byte refreshed
  to the candidate skill before the server reported ready, then exercises the
  first-use behavior with the plugin also present.
* ``plugin-only`` loads an explicit candidate-skill plugin fixture and exercises
  behavior only. Tandem cannot refresh Claude Code's plugin cache, so plugin-only
  evidence is rejected if it claims PR2 performed a refresh.

The ``capture`` command launches one bounded authenticated Claude session through
the repository's existing pywinpty/ConPTY machinery and emits a versioned capture
manifest plus five redacted artifacts. Only evidence derived directly inside that
producer is release-eligible; ``ingest-capture`` accepts external bundles for
diagnostics but cannot produce a release PASS. HOME, USERPROFILE, and
CLAUDE_CONFIG_DIR all point inside the owned fixture; authentication relies on
the OS keychain rather than the operator's real Claude files.

``--root`` must be a durable path you chose, never a session-scoped scratchpad. The
signed bundle is the only thing that makes a PASS auditable after the run, and an agent
scratchpad is deleted without warning when its session ends -- a ten-trial bundle was
briefly believed lost for exactly that reason.

Run ``uv run python scripts/spikes/session_monitor_acceptance.py --help`` for commands.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable, NamedTuple


FIXTURE_MARKER = ".tandem-session-monitor-acceptance"
FIXTURE_VERSION = 1
MANAGED_SHAPE = "managed-double"
PLUGIN_SHAPE = "plugin-only"
MANAGED_MODES = ("normal", "launcher-disabled", "deferred-autostart")
CHAIN_FIELDS = (
    "skill_dispatched",
    "status_succeeded",
    "monitor_attempted",
    "monitor_persistent",
    "wake_seen",
    "inbox_checked",
    # These three were in PRECONDITION_FIELDS until 2026-08-11, which made the gate
    # unable to reach its own PASS state. They are consequences of the model arming a
    # monitor, not facts about whether the harness had control of the host, but
    # `missing_precondition` applies preconditions to EVERY row and then skips the
    # chain logic -- so on a legitimate natural decline (no dispatch, so nothing to
    # arm, so no idle/growth/autonomous turn) they were unconditionally false and every
    # such row was inconclusive. That vetoed PASS even at `natural_successes: 1`, which
    # is the exact ratio the bounded n=3 sample exists to permit.
    "turn_idle_after_monitor",
    "subscriber_growth_proven",
    "autonomous_turn_seen",
)
PRECONDITION_FIELDS = (
    "capture_healthy",
    "host_authenticated",
    "workspace_trusted",
    "fixture_onboarded",
    "prompt_submitted",
)
# Chain fields that can only be true as a CONSEQUENCE of the skill being dispatched.
# Deliberately NOT `CHAIN_FIELDS - skill_dispatched`: `status_succeeded` merely records
# that a `tandem_status` response carried a wakeUrl, which a read-mode status response
# includes whenever a wake transport is running -- always true here, since every trial
# drives the HTTP server; it is spread in conditionally and absent under stdio
# (src/server/mcp/document.ts). Carrying one is independent of arming. A model
# that declines the skill still calls `tandem_status` to answer the prose prompt -- both
# stored decline rows show `status_succeeded: true` -- so including it here would make
# every honest decline look self-contradictory. `status_succeeded` stays in
# `CHAIN_FIELDS` because the control-completeness and natural-full-chain checks do
# require it.
DISPATCH_CONSEQUENT_FIELDS = (
    "monitor_attempted",
    "monitor_persistent",
    "wake_seen",
    "inbox_checked",
    "turn_idle_after_monitor",
    "subscriber_growth_proven",
    "autonomous_turn_seen",
)
# The first three preconditions are the PTY-derived health signals; the rest come from
# the structured trace. Named rather than sliced -- this was `PRECONDITION_FIELDS[:3]`,
# which happened to stay correct across the re-homing above only because the moved
# fields sat at the tuple's end.
TRANSCRIPT_HEALTH_FIELDS = (
    "capture_healthy",
    "host_authenticated",
    "workspace_trusted",
)
OBSERVATION_FIELDS = PRECONDITION_FIELDS + CHAIN_FIELDS
CAPTURE_ELIGIBILITY_FIELD = "capture_eligibility"
DIRECT_LIVE_CAPTURE = "direct-live"
FAILED_LIVE_CAPTURE = "failed-live"
DIAGNOSTIC_IMPORT = "diagnostic-import"
ATTESTATION_FIELD = "capture_attestation"
# Rig failures travel in the row's free-text `notes`, which also carries the capture's
# own failure code. Both are segments of one `"; "`-joined string, so neither may be
# written by assignment and neither may be read with `startswith` -- doing either makes
# the other invisible, which is the anonymity this field exists to remove.
NOTE_SEPARATOR = "; "
RIG_NOTE_PREFIX = "rig: "
ARCHIVED_ATTESTATION_REASON_FIELD = "attestation_void_reason"
# The managed skill the fixture seeds, taken from tag v0.21.0: the last shipped version
# that lacked the auto-arm instruction, which is what makes a refresh to the candidate
# observable. Pinned; the candidate is only required to be newer.
SEEDED_SKILL_VERSION = 9
SEEDED_SKILL_TAG = "v0.21.0"
ATTESTATION_KEY_FILE = "capture-attestation.key"
AUTH_TOKEN_FILE = "acceptance-auth-token.txt"
CAPTURE_ARTIFACT_ROLES = frozenset(
    {"pty_capture", "observation_trace", "server_log", "decoy_log", "process_tree"}
)
CAPTURE_SCHEMA_VERSION = 1
CAPTURE_PRODUCER = "tandem-session-monitor-conpty-v1"
# The producer exists, but the release gate remains unproven until all ten
# authenticated trials have been captured and evaluated successfully.
LIVE_CAPTURE_PRODUCER_AVAILABLE = True
LIVE_CAPTURE_PRODUCER_BLOCKER = (
    "release-incomplete: the authenticated ten-session ConPTY matrix has not passed"
)
# Held back from the monitor-idle wait for the wake injection and the
# tandem_checkInbox observation that follow it. Everything else in the caller's
# --timeout-seconds is available to out-wait the armed Monitor call, whose duration is
# host-side and not ours to predict: 45s to 664s across the ten-trial bundle, per each
# row's server_log.monitor_timing, with the growth across runs still unexplained.
INJECTION_RESERVE_SECONDS = 120.0
# Floor for that wait, so a nearly-exhausted deadline still gives the turn a usable
# window instead of zero.
MIN_ARMING_WAIT_SECONDS = 60.0
# Grace period before a turn with no dispatch signal is committed to as a decline.
# Both signals lag their cause -- trace lines come from per-event hook subprocesses and
# the marker from a spawned plugin monitor -- so this absorbs write latency rather than
# model latency, which the monitor-idle wait above already covers.
DISPATCH_SETTLE_SECONDS = 15.0
# The harness's own arrival timestamp on each captured hook event. Namespaced so a host
# payload key can never shadow it -- see `event_at`.
HOOK_EVENT_TIME_KEY = "harness_at"
# Opened before each trial so the document-scoped inbox poll has something to report.
ACCEPTANCE_DOCUMENT = "acceptance.md"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
STRUCTURED_TOOL_RE = re.compile(r"^\s*tool:\s*([A-Za-z0-9_:]+)\b(.*)$", re.IGNORECASE)
EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])")
BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*")
KNOWN_TOKEN_RE = re.compile(r"\b(?:sk-ant|sk-proj|gh[pousr])-[A-Za-z0-9_-]{6,}\b", re.IGNORECASE)
SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY))\s*=\s*([^\s,;]+)"
)
SAFE_ENV_KEYS = frozenset(
    {
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "TERM",
        "COLORTERM",
        "LANG",
        "LC_ALL",
        "NO_COLOR",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
    }
)


def build_trial_matrix() -> list[dict[str, Any]]:
    """Return the bounded ten-session acceptance sample.

    Managed/double-installed has one natural and one explicit control session
    for each startup mode (six sessions). Plugin-only has three fresh natural
    sessions and one fresh explicit control (four sessions). Thus each install
    shape has n=3 natural prompts and a positive control; managed startup modes
    cannot hide behind one another.
    """

    trials: list[dict[str, Any]] = []
    for mode in MANAGED_MODES:
        for prompt_kind in ("natural", "control"):
            trials.append(
                {
                    "id": f"managed-{mode}-{prompt_kind}",
                    "install_shape": MANAGED_SHAPE,
                    "startup_mode": mode,
                    "prompt_kind": prompt_kind,
                    "requires_refresh": True,
                }
            )
    for sample in range(1, 4):
        trials.append(
            {
                "id": f"plugin-natural-{sample}",
                "install_shape": PLUGIN_SHAPE,
                "startup_mode": "behavior-only",
                "prompt_kind": "natural",
                "requires_refresh": False,
            }
        )
    trials.append(
        {
            "id": "plugin-control",
            "install_shape": PLUGIN_SHAPE,
            "startup_mode": "behavior-only",
            "prompt_kind": "control",
            "requires_refresh": False,
        }
    )
    return trials


DISPATCH_OBSERVED = "dispatched"
DISPATCH_DECLINED = "declined"
DISPATCH_PENDING = "pending"
# Neither arming nor a completed non-dispatching turn could be proven. Deliberately a
# distinct value from DISPATCH_PENDING: pending is a classification of the trace, this is
# the settled verdict that the capture must fail rather than record a negative.
SETTLE_UNOBSERVED = "unobserved"


def event_at(event: dict[str, Any]) -> float | None:
    """Read the harness's own arrival timestamp off a hook event, or None.

    The key is `harness_at`, not `at`: the trace writer emits
    `JSON.stringify({ harness_at: ..., ...payload })` with the host payload spread
    *second*, so any key the harness picks can be overwritten by a host field of the same
    name -- silently, and every ordering comparison downstream would then be reading host
    data in unknown units. No `at` appears in the documented `PreToolUse`/`Stop` schemas,
    so this was never exploitable, but the real traces carry `background_tasks`,
    `session_crons`, `model` and `duration_ms`, none of them documented either. The
    schemas are visibly still growing, so the harness keeps a name of its own.
    """

    value = event.get(HOOK_EVENT_TIME_KEY)
    return float(value) if isinstance(value, (int, float)) else None


def dispatched_skill_is_tandem(tool_input: Any) -> bool:
    """Report whether a `Skill` tool event invoked *our* skill.

    Without this the check read `tool_name` alone, so any skill the model happened to
    invoke counted as a Tandem dispatch. Measured from the ten-trial bundle: `tool_name`
    is bare `Skill` and the skill's identity lives in `tool_input.skill`, whose observed
    value is bare `tandem` even with the plugin fixture installed. Matching the final
    `:`-delimited segment also covers the plugin-qualified `tandem:tandem` form that
    `.claude-plugin/plugin.json` uses in its own `on-skill-invoke` triggers, so this does
    not depend on which form the host emits.

    A missing or malformed `tool_input` is treated as ours on purpose. The alternative
    fails closed, which would make every dispatch invisible if the host ever stopped
    sending the field -- and an invisible dispatch is laundered into a decline, the one
    failure direction this module refuses. Counting a foreign skill instead produces a
    loud hard failure ("declined or failed after dispatch"), which is the survivable way
    to be wrong here.
    """

    if not isinstance(tool_input, dict) or "skill" not in tool_input:
        return True
    name = str(tool_input.get("skill", "")).strip().lower()
    return name.rsplit(":", 1)[-1] == "tandem"


def dispatch_signals_seen(
    events: list[dict[str, Any]],
    *,
    prompt_submitted_at: float,
    dispatch_marker_seen: bool,
) -> bool:
    """Report whether the skill was dispatched, by either observable route.

    The two routes are not redundant, and neither alone is sufficient:

    * ``PreToolUse Skill`` fires when the *model* invokes the skill. A typed ``/tandem``
      slash dispatch does not produce one -- measured from the plugin-control trace,
      which contains a `Monitor` call and no `Skill` event -- so this signal alone is
      blind to the entire control arm.
    * The marker file is written by the plugin fixture's ``experimental.monitors``
      command, which arms on ``on-skill-invoke``. It is therefore the plugin runtime
      observing an invocation however it was reached, but it additionally requires that
      trigger to fire and the process to spawn.

    * ``UserPromptExpansion`` is what the host emits when a typed command expands into a
      prompt. It is the control arm's only first-class signal -- evidence from the host
      that ``/tandem`` ran, rather than an inference from a process having spawned. Added
      2026-08-11 and NOT yet seen in a capture: the fixture did not subscribe to this hook
      when the stored bundle was taken, so the ten traces contain none. Because the field
      is unknown, every string value is examined -- see ``typed_tandem_command`` for why
      that is a prefix test on the value rather than a substring search over the payload.

    Taking the union is what makes a broken ``on-skill-invoke`` trigger (#1354) visible:
    marker absent while a `Skill` event exists means the model did invoke the skill and
    the trigger did not fire. Under the marker alone that reads as a model decline and
    is laundered into a benign negative.
    """

    if dispatch_marker_seen:
        return True
    if any(
        str(event.get("hook_event_name", "")) == "UserPromptExpansion"
        and typed_tandem_command(event)
        and (at := event_at(event)) is not None
        and at >= prompt_submitted_at
        for event in events
    ):
        return True
    return any(
        str(event.get("hook_event_name", "")) == "PreToolUse"
        and str(event.get("tool_name", "")).lower() == "skill"
        and dispatched_skill_is_tandem(event.get("tool_input"))
        and event_at(event) is not None
        and event_at(event) >= prompt_submitted_at
        for event in events
    )


def classify_dispatch(
    events: list[dict[str, Any]],
    *,
    prompt_submitted_at: float,
    dispatch_marker_seen: bool,
) -> str:
    """Classify a turn as dispatched, declined, or still pending.

    ``declined`` requires POSITIVE proof the turn completed -- a ``Stop`` after the
    prompt -- not merely the absence of a dispatch signal. Absence alone also matches a
    crash, a hang, a skill that never became invocable, and an unanswered permission
    dialog, and recording any of those as a benign negative would launder exactly the
    regression class this harness exists to detect. A hung turn stays ``pending`` and
    times out with a named failure instead.

    Extracted as a pure function so the decline branch is testable without driving a
    real PTY session; ``capture`` had no seam at which this decision could be observed.
    """

    if dispatch_signals_seen(
        events,
        prompt_submitted_at=prompt_submitted_at,
        dispatch_marker_seen=dispatch_marker_seen,
    ):
        return DISPATCH_OBSERVED
    turn_completed = any(
        str(event.get("hook_event_name", "")) == "Stop"
        and event_at(event) is not None
        and event_at(event) > prompt_submitted_at
        for event in events
    )
    return DISPATCH_DECLINED if turn_completed else DISPATCH_PENDING


def settle_and_classify(
    classify_turn: Callable[[], str],
    *,
    monitor_idle: bool,
    settle: Callable[[], Any],
) -> str:
    """Decide what a finished wait means: armed, declined, or not provable either way.

    Returns ``DISPATCH_OBSERVED`` when arming was seen, ``DISPATCH_DECLINED`` for a turn
    that provably completed without dispatching, and ``SETTLE_UNOBSERVED`` when neither
    is provable -- which the caller must treat as a capture failure and never as a
    decline. That third outcome is the whole point: a hung or crashed session looks
    identical to a decline except that it never emits a ``Stop``, so collapsing the two
    would launder a rig failure into a measured negative.

    ``settle`` runs before the classification because both dispatch signals lag their
    cause -- trace lines are appended by per-event hook subprocesses, the marker by a
    spawned plugin monitor process. A tick that sees ``Stop`` flushed but the ``Skill``
    line not yet would read a real dispatch as a decline. The caller's ``settle`` polls,
    so a signal arriving anywhere in the window wins; only a window that stays empty
    throughout becomes a decline.

    Extracted from ``capture`` so this control flow is testable. Every driver stand-in in
    the suite replaces ``ConptyTrialDriver`` wholesale and so cannot reach the branch in
    place -- a test written against a stand-in would only re-prove that a raised
    ``TrialCaptureFailure`` becomes a failed-live row, and an inverted comparator here
    would pass it.
    """

    if monitor_idle:
        return DISPATCH_OBSERVED
    settle()
    if classify_turn() == DISPATCH_DECLINED:
        return DISPATCH_DECLINED
    return SETTLE_UNOBSERVED


def _record_rig_failure(server_log: dict[str, Any], reason: str) -> None:
    """Name a harness-side failure so it survives into the gate's own output.

    These failures all degrade in the safe direction -- an observation goes false rather
    than fabricated true -- so none of them can manufacture a pass. What they *can* do is
    become indistinguishable from the thing being measured: a failed wake injection and a
    model that never polled its inbox produce the same row. `evaluate` reads this list and
    names it, instead of leaving the reason in a raw artifact nobody opens.
    """

    failures = server_log.setdefault("failures", [])
    if reason not in failures:
        failures.append(reason)


def typed_tandem_command(event: Any) -> bool:
    """True when some value in the event is the typed command `/tandem` itself.

    Which field carries the command is not documented, so every string value is examined
    -- but a value must *begin* with the slash form to count. A substring search over the
    serialized payload would match this repository's own posix path (`.../GitHub/tandem`)
    in any incidental `cwd` or `transcript_path`, turning a prose trial into a false
    control dispatch. That is the direction this module cannot afford: a natural prompt
    names Tandem in prose and must never read as an explicit dispatch.
    """

    if isinstance(event, str):
        head = event.strip().lower()
        return head == "/tandem" or head.startswith("/tandem ") or head.startswith("/tandem\t")
    if isinstance(event, dict):
        return any(typed_tandem_command(value) for value in event.values())
    if isinstance(event, (list, tuple)):
        return any(typed_tandem_command(value) for value in event)
    return False


def append_note(existing: Any, addition: str) -> str:
    """Add one segment to a row's `notes` without displacing what is already there."""

    return NOTE_SEPARATOR.join(part for part in [str(existing or ""), addition] if part)


def rig_note_of(row: dict[str, Any]) -> str | None:
    """The row's rig-failure segment, wherever it sits in the joined note."""

    notes = row.get("notes")
    if not isinstance(notes, str):
        return None
    for segment in notes.split(NOTE_SEPARATOR):
        if segment.startswith(RIG_NOTE_PREFIX):
            return segment
    return None


def silent_monitor_teardown_proven(
    silent_pids: Iterable[int],
    *,
    dispatch_classification: str | None,
    pid_alive: Callable[[int], bool],
) -> bool:
    """Whether the plugin monitor's processes are proven gone.

    Requiring a non-empty pid list is what stops a trial that DID dispatch from claiming
    teardown proof it never earned. But a trial where the model declined the skill spawns
    no plugin monitor at all -- the marker and the process both come from the
    on-skill-invoke command -- so on that branch the requirement would fail every honest
    decline over a process that was never supposed to exist. Hence vacuous on the declined
    branch only: a dispatching trial with an empty list stays unproven, and is separately a
    hard failure via `skill_dispatched`.
    """

    pids = list(silent_pids)
    expected = bool(pids) or dispatch_classification == DISPATCH_DECLINED
    return expected and all(not pid_alive(pid) for pid in pids)


def injection_budget(
    deadline: float, now: float, reserve: float = INJECTION_RESERVE_SECONDS
) -> float:
    """Seconds to spend waiting for the arming turn, keeping ``reserve`` for injection.

    Floored so a nearly-exhausted deadline still gives the turn a usable window rather
    than zero. Extracted because the test that pinned this arithmetic re-implemented it
    instead of calling it, and its copy had already drifted -- it approximated
    ``deadline - now`` as the whole ``--timeout-seconds`` value.
    """

    return max(MIN_ARMING_WAIT_SECONDS, deadline - now - reserve)


def parse_trial_transcript(
    transcript: str,
    *,
    dispatch_marker_seen: bool,
    event_text: str,
) -> dict[str, bool]:
    """Derive display-only health signals; PTY prose is never release tool evidence."""

    clean = ANSI_RE.sub("", transcript)
    lowered = clean.lower()
    return {
        "capture_healthy": len(clean) >= 200 and "claude code" in lowered,
        "host_authenticated": not bool(
            re.search(r"not authenticated|please (?:log|sign) in|authentication required", lowered)
        ),
        "workspace_trusted": not bool(
            re.search(r"trust (?:this|the) (?:folder|workspace)|untrusted workspace", lowered)
        ),
        "skill_dispatched": dispatch_marker_seen,
        "status_succeeded": False,
        "monitor_attempted": False,
        "monitor_persistent": False,
        "wake_seen": False,
        "inbox_checked": False,
        "fixture_onboarded": False,
        "prompt_submitted": False,
        "turn_idle_after_monitor": False,
        "subscriber_growth_proven": False,
        "autonomous_turn_seen": False,
    }


def derive_structured_observations(
    events: list[dict[str, Any]],
    *,
    dispatch_marker_seen: bool,
    event_text: str,
    injected_at: float,
    transcript_health: dict[str, bool],
    decoy_count: int,
    armed_count: int,
    prompt_submitted_at: float = 0.0,
) -> dict[str, bool]:
    """Derive release observations only from Claude hook events and server counts."""

    def event_name(event: dict[str, Any]) -> str:
        return str(event.get("hook_event_name", ""))

    def tool_name(event: dict[str, Any]) -> str:
        return str(event.get("tool_name", "")).lower()

    def serialized(value: Any) -> str:
        return json.dumps(value, sort_keys=True, separators=(",", ":"))

    prompt_events = [event for event in events if event_name(event) == "UserPromptSubmit"]
    status_events = [
        event
        for event in events
        if event_name(event) == "PostToolUse" and tool_name(event).endswith("tandem_status")
    ]
    wake_url: str | None = None
    status_at: float | None = None
    for event in status_events:
        match = re.search(r"ws://127\.0\.0\.1:\d+/api/wake", serialized(event.get("tool_response")))
        if match:
            wake_url = match.group(0)
            status_at = event_at(event)
            break
    monitor_events = [
        event
        for event in events
        if event_name(event) == "PreToolUse"
        and tool_name(event) == "monitor"
        and wake_url is not None
        and wake_url in serialized(event.get("tool_input"))
    ]
    monitor = monitor_events[0] if monitor_events else None
    monitor_at = event_at(monitor) if isinstance(monitor, dict) else None
    monitor_input = serialized(monitor.get("tool_input")) if isinstance(monitor, dict) else ""
    stop_after_monitor = any(
        event_name(event) == "Stop"
        and event_at(event) is not None
        and isinstance(monitor_at, (int, float))
        and event_at(event) > monitor_at
        and event_at(event) < injected_at
        for event in events
    )
    inbox_events = [
        event
        for event in events
        if event_name(event) == "PostToolUse"
        and tool_name(event).endswith("tandem_checkinbox")
        and event_at(event) is not None
        and event_at(event) > injected_at
        and event_text in serialized(event.get("tool_response"))
    ]
    prompt_submitted = bool(prompt_events)
    monitor_persistent = '"persistent":true' in monitor_input.replace(" ", "").lower()
    return {
        **transcript_health,
        "fixture_onboarded": prompt_submitted
        and transcript_health.get("host_authenticated") is True
        and transcript_health.get("workspace_trusted") is True,
        "prompt_submitted": prompt_submitted,
        "turn_idle_after_monitor": stop_after_monitor,
        "subscriber_growth_proven": decoy_count >= 1 and armed_count >= decoy_count + 1,
        "autonomous_turn_seen": bool(inbox_events),
        "skill_dispatched": dispatch_signals_seen(
            events,
            prompt_submitted_at=prompt_submitted_at,
            dispatch_marker_seen=dispatch_marker_seen,
        ),
        "status_succeeded": wake_url is not None and status_at is not None,
        "monitor_attempted": monitor is not None,
        "monitor_persistent": monitor_persistent,
        "wake_seen": bool(inbox_events),
        "inbox_checked": bool(inbox_events),
    }


def _resolved(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def _is_within(path: Path, root: Path) -> bool:
    try:
        _resolved(path).relative_to(_resolved(root))
        return True
    except ValueError:
        return False


def _is_reparse_point(path: Path) -> bool:
    try:
        stat_result = path.lstat()
    except OSError:
        return False
    return path.is_symlink() or bool(getattr(stat_result, "st_file_attributes", 0) & 0x400)


def _safe_mutation_path(root: Path, path: Path) -> Path:
    """Resolve one fixture mutation and reject symlink/junction traversal."""

    root = assert_owned_fixture_root(root)
    lexical = Path(os.path.abspath(path))
    try:
        relative = lexical.relative_to(root)
    except ValueError as exc:
        raise RuntimeError(f"mutation target escapes fixture root: {path}") from exc
    cursor = root
    for part in relative.parts:
        cursor = cursor / part
        if cursor.exists() and _is_reparse_point(cursor):
            raise RuntimeError(f"refusing fixture mutation through reparse point: {cursor}")
    resolved = _resolved(lexical)
    if not _is_within(resolved, root):
        raise RuntimeError(f"mutation target escapes fixture root: {path}")
    return resolved


def redact_capture_text(value: str) -> str:
    value = EMAIL_RE.sub("[REDACTED_EMAIL]", value)
    value = BEARER_RE.sub("Bearer [REDACTED]", value)
    value = KNOWN_TOKEN_RE.sub("[REDACTED_TOKEN]", value)
    return SECRET_ASSIGNMENT_RE.sub(lambda match: f"{match.group(1)}=[REDACTED]", value)


def redact_capture_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact_capture_text(value)
    if isinstance(value, list):
        return [redact_capture_value(item) for item in value]
    if isinstance(value, dict):
        return {key: redact_capture_value(item) for key, item in value.items()}
    return value


def _minimal_environment(base: dict[str, str] | None) -> dict[str, str]:
    source = os.environ if base is None else base
    return {key: value for key, value in source.items() if key.upper() in SAFE_ENV_KEYS}


def _assert_safe_fixture_root(root: Path) -> Path:
    root = _resolved(root)
    home = _resolved(Path.home())
    real_claude = home / ".claude"
    if (
        root == Path(root.anchor)
        or root in (home, real_claude)
        or _is_within(home, root)
        or _is_within(root, real_claude)
    ):
        raise RuntimeError(f"refusing unsafe fixture root {root}")
    return root


def _marker_path(root: Path) -> Path:
    return root / FIXTURE_MARKER


def assert_owned_fixture_root(root: Path) -> Path:
    root = _assert_safe_fixture_root(root)
    marker = _marker_path(root)
    if not marker.is_file():
        raise RuntimeError(f"refusing non-owned fixture root {root}: {FIXTURE_MARKER} is absent")
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"invalid fixture ownership marker at {marker}: {exc}") from exc
    if payload != {"kind": "tandem-session-monitor-acceptance", "version": FIXTURE_VERSION}:
        raise RuntimeError(f"unrecognized fixture ownership marker at {marker}")
    return root


def _empty_evidence(trial: dict[str, Any]) -> dict[str, Any]:
    evidence = {
        **trial,
        "capture_healthy": None,
        "host_authenticated": None,
        "workspace_trusted": None,
        "refreshed_before_ready": None,
        "seeded_skill_sha256": None,
        "candidate_skill_sha256": None,
        "ready_skill_sha256": None,
        "ready_skill_observed_at": None,
        "server_ready_at": None,
        "observed_launcher_mode": None,
        "decoy_subscriber_attached": None,
        "decoy_subscriber_id": None,
        "decoy_attached_at": None,
        "status_observed_at": None,
        "claude_process_tree_teardown_verified": None,
        "silent_monitor_teardown_verified": None,
        "capture_manifest_sha256": None,
        CAPTURE_ELIGIBILITY_FIELD: None,
        "artifacts": [],
        ATTESTATION_FIELD: None,
        "notes": "",
    }
    for field in CHAIN_FIELDS:
        evidence[field] = None
    return evidence


def prepare_fixture_root(root: Path, repo: Path | None = None) -> Path:
    """Create or re-open a harness-owned root without clobbering other data."""

    root = _assert_safe_fixture_root(root)
    marker = _marker_path(root)
    if root.exists() and any(root.iterdir()) and not marker.is_file():
        raise RuntimeError(f"refusing non-owned fixture root {root}: directory is not empty")
    root.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps(
            {"kind": "tandem-session-monitor-acceptance", "version": FIXTURE_VERSION},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
        newline="",
    )
    for directory in (
        root / "home" / ".claude",
        root / "workspace",
        root / "artifacts",
        root / "fixtures",
        root / "backups",
    ):
        _safe_mutation_path(root, directory).mkdir(parents=True, exist_ok=True)

    # A trial needs an open document, because `tandem_checkInbox` bails out with
    # `noDocumentError()` when there is no active one -- and that bail-out is why the
    # wake half of the chain read as a failure for a while: `tandem_status` needs no
    # document and succeeded, so only the inbox call failed, and it failed without
    # completing. A user doing ordinary Tandem work always has a document open, so a
    # fixture with an empty workspace is not modelling the case under test.
    document_path = _safe_mutation_path(root, root / "workspace" / ACCEPTANCE_DOCUMENT)
    if not document_path.exists():
        document_path.write_text(
            "# Session monitor acceptance\n\n"
            "This document exists so a trial has an active document: the inbox poll is\n"
            "document-scoped, and a wake is only observable once it can report one.\n",
            encoding="utf-8",
            newline="",
        )

    attestation_key_path = root / "backups" / ATTESTATION_KEY_FILE
    if not attestation_key_path.exists():
        _safe_mutation_path(root, attestation_key_path).write_bytes(secrets.token_bytes(32))
        try:
            attestation_key_path.chmod(0o600)
        except OSError:
            # Windows enforces this directory through the fixture boundary;
            # chmod is advisory there and can fail on some filesystems.
            pass

    auth_token_path = root / "backups" / AUTH_TOKEN_FILE
    if not auth_token_path.exists():
        _safe_mutation_path(root, auth_token_path).write_text(
            secrets.token_urlsafe(32), encoding="utf-8", newline=""
        )
    claude_state_path = _safe_mutation_path(
        root, root / "home" / ".claude" / ".claude.json"
    )
    claude_state: dict[str, Any] = {}
    if claude_state_path.is_file():
        try:
            existing_state = json.loads(claude_state_path.read_text(encoding="utf-8"))
            if isinstance(existing_state, dict):
                claude_state.update(existing_state)
        except json.JSONDecodeError:
            pass
    projects = claude_state.get("projects")
    if not isinstance(projects, dict):
        projects = {}
    projects[str(root / "workspace")] = {"hasTrustDialogAccepted": True}
    claude_state.update({"hasCompletedOnboarding": True, "projects": projects})
    _write_json(claude_state_path, claude_state)
    _install_structured_trace_hooks(root)

    matrix_path = root / "matrix.json"
    evidence_path = root / "evidence.json"
    matrix = build_trial_matrix()
    _safe_mutation_path(root, matrix_path).write_text(
        json.dumps(matrix, indent=2) + "\n", encoding="utf-8", newline=""
    )
    if not evidence_path.exists():
        _safe_mutation_path(root, evidence_path).write_text(
            json.dumps([_empty_evidence(trial) for trial in matrix], indent=2) + "\n",
            encoding="utf-8",
            newline="",
        )
    if repo is not None:
        snapshot_skill_fixtures(root, repo)
        build_plugin_fixture(root, repo)
    return root


def _read_skill_version(content: str) -> int | None:
    match = re.search(r"(?m)^version:\s*(\d+)\s*$", content)
    return int(match.group(1)) if match else None


def _install_structured_trace_hooks(root: Path) -> None:
    """Install fixture instrumentation in Claude's effective user settings.

    Claude can discover plugin hook declarations without executing them in some
    launch modes. User settings live directly under ``CLAUDE_CONFIG_DIR``, so
    they provide the deterministic evidence boundary while ``--plugin-dir``
    remains responsible only for the candidate plugin behavior under test.
    """

    root = assert_owned_fixture_root(root)
    helper = _safe_mutation_path(
        root, root / "home" / ".claude" / "harness-hooks" / "capture-event.mjs"
    )
    helper.parent.mkdir(parents=True, exist_ok=True)
    helper.write_text(
        'import { appendFileSync } from "node:fs";\n'
        "if (!process.env.TANDEM_ACCEPTANCE_TRACE) process.exit(0);\n"
        "const chunks = [];\nfor await (const chunk of process.stdin) chunks.push(chunk);\n"
        'const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));\n'
        "appendFileSync(process.env.TANDEM_ACCEPTANCE_TRACE, "
        "`${JSON.stringify({ "
        + HOOK_EVENT_TIME_KEY
        + ": Date.now() / 1000, ...payload })}\\n`);\n",
        encoding="utf-8",
        newline="",
    )

    settings_path = _safe_mutation_path(root, root / "home" / ".claude" / "settings.json")
    settings: dict[str, Any] = {}
    if settings_path.is_file():
        try:
            existing = json.loads(settings_path.read_text(encoding="utf-8"))
            if isinstance(existing, dict):
                settings.update(existing)
        except json.JSONDecodeError:
            pass
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
    command = f'node "{helper.resolve()}"'
    # `UserPromptExpansion` is what the host emits when a typed command expands into a
    # prompt -- the control arm's only first-class evidence that `/tandem` ran. Without it
    # a control's dispatch is provable solely through the marker file, which requires the
    # plugin's on-skill-invoke trigger to fire AND its process to spawn, so control
    # evidence rested on a process side effect rather than on the host reporting the
    # command.
    for event in (
        "SessionStart",
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "UserPromptSubmit",
        "UserPromptExpansion",
    ):
        hooks[event] = [
            {"hooks": [{"type": "command", "command": command, "timeout": 10}]}
        ]
    settings["hooks"] = hooks
    # A fresh fixture HOME has approved nothing, so an un-approved tool call stalls on a
    # "Do you want to proceed?" dialog nothing here answers. This list is an enumeration of
    # consumers and has already failed by omission once: `Monitor`, the tool the gate
    # exists to observe, was missing, and its arming call sat on the dialog for 22 minutes
    # across seven sessions, misread as host latency. `_permission_dialog_blocking` is what
    # breaks that cycle -- it turns the next omission into a named failure in seconds --
    # not a longer list. `defaultMode: "bypassPermissions"` is not the way out: it raises
    # its own acceptance screen that defaults to exit, and it is documented for a sandboxed
    # container, not an isolated HOME on a networked workstation.
    permissions = settings.get("permissions")
    if not isinstance(permissions, dict):
        permissions = {}
    # A previous revision set this; leaving it behind would strand the fixture on the
    # bypass acceptance screen with no way to answer it.
    permissions.pop("defaultMode", None)
    allow = permissions.get("allow")
    if not isinstance(allow, list):
        allow = []
    for pattern in ("mcp__tandem__*", "mcp__plugin_tandem_tandem__*", "Monitor"):
        if pattern not in allow:
            allow.append(pattern)
    permissions["allow"] = allow
    settings["permissions"] = permissions
    _write_json(settings_path, settings)


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def snapshot_skill_fixtures(root: Path, repo: Path) -> dict[str, str]:
    root = assert_owned_fixture_root(root)
    repo = _resolved(repo)
    candidate_path = repo / "skills" / "tandem" / "SKILL.md"
    candidate = candidate_path.read_bytes()
    candidate_text = candidate.decode("utf-8")
    # Newer than the seeded baseline, not one exact number. The claim this fixture
    # supports is "the managed copy was refreshed from v9 to the candidate before the
    # server reported ready", which needs the candidate to be *newer* -- pinning the
    # literal 10 made every future bump of the shipped skill fail the harness instead,
    # and #1397 bumping it to 11 is what surfaced that.
    candidate_version = _read_skill_version(candidate_text)
    if candidate_version is None or candidate_version <= SEEDED_SKILL_VERSION:
        raise RuntimeError(
            f"candidate skill must be newer than v{SEEDED_SKILL_VERSION}, "
            f"got {candidate_version}: {candidate_path}"
        )
    proc = subprocess.run(
        ["git", "show", f"{SEEDED_SKILL_TAG}:skills/tandem/SKILL.md"],
        cwd=repo,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"cannot read immutable v{SEEDED_SKILL_VERSION} fixture from tag "
            f"{SEEDED_SKILL_TAG}: " + proc.stderr.decode("utf-8", errors="replace")
        )
    v9 = proc.stdout
    if _read_skill_version(v9.decode("utf-8")) != SEEDED_SKILL_VERSION:
        raise RuntimeError(
            f"{SEEDED_SKILL_TAG} skill fixture is not version {SEEDED_SKILL_VERSION}"
        )
    fixture_dir = root / "fixtures"
    _safe_mutation_path(root, fixture_dir / "managed-v9-SKILL.md").write_bytes(v9)
    _safe_mutation_path(root, fixture_dir / "candidate-SKILL.md").write_bytes(candidate)
    hashes = {"v9": _sha256(v9), "candidate": _sha256(candidate)}
    _safe_mutation_path(root, fixture_dir / "skill-hashes.json").write_text(
        json.dumps(hashes, indent=2) + "\n", encoding="utf-8", newline=""
    )
    return hashes


def build_plugin_fixture(root: Path, repo: Path) -> Path:
    """Build a plugin-only candidate fixture with exactly one Tandem MCP route.

    The shipped monitor trigger names remain intact, but commands are replaced
    by a silent process. That keeps trigger/task behavior present without letting
    the packaged monitor satisfy the wake assertion intended for the built-in
    Monitor. The channel MCP entry is removed so it cannot add a competing push
    consumer; the Tandem MCP entry remains so plugin-only can call ``tandem_status``.
    The fixture is instrumentation, never a distributable manifest.
    """

    root = assert_owned_fixture_root(root)
    repo = _resolved(repo)
    plugin = root / "fixtures" / "candidate-plugin-v10"
    _safe_mutation_path(root, plugin / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    _safe_mutation_path(root, plugin / "skills" / "tandem").mkdir(parents=True, exist_ok=True)
    stale_plugin_hooks = _safe_mutation_path(root, plugin / "hooks")
    if stale_plugin_hooks.exists():
        shutil.rmtree(stale_plugin_hooks)
    manifest = json.loads((repo / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    mcp_servers = manifest.get("mcpServers", {})
    tandem_mcp = mcp_servers.get("tandem")
    if not isinstance(tandem_mcp, dict):
        raise RuntimeError("shipped plugin has no Tandem MCP route to retain in the fixture")
    manifest["mcpServers"] = {"tandem": tandem_mcp}
    for monitor in manifest.get("experimental", {}).get("monitors", []):
        monitor["command"] = 'node "${CLAUDE_PLUGIN_ROOT}/silent-monitor.mjs"'
    _safe_mutation_path(root, plugin / ".claude-plugin" / "plugin.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline=""
    )
    candidate = (repo / "skills" / "tandem" / "SKILL.md").read_text(encoding="utf-8")
    instrumented = (
        candidate.rstrip()
        + "\n\n<!-- acceptance-source: plugin-only-candidate; fixture only -->\n"
    )
    _safe_mutation_path(root, plugin / "skills" / "tandem" / "SKILL.md").write_text(
        instrumented + "\n", encoding="utf-8", newline=""
    )
    hashes_path = root / "fixtures" / "skill-hashes.json"
    if hashes_path.is_file():
        hashes = json.loads(hashes_path.read_text(encoding="utf-8"))
        hashes["plugin_candidate"] = _sha256(
            (plugin / "skills" / "tandem" / "SKILL.md").read_bytes()
        )
        _write_json(hashes_path, hashes)
    _safe_mutation_path(root, plugin / "silent-monitor.mjs").write_text(
        "// Fixture-only: preserve monitor arming without producing a competing wake.\n"
        'import { appendFileSync } from "node:fs";\n'
        'appendFileSync(new URL("./silent-monitor-pids.log", import.meta.url), `${process.pid}\\n`);\n'
        "setInterval(() => {}, 60_000);\n",
        encoding="utf-8",
        newline="",
    )
    return plugin


class SkillBackup:
    """Recover an existing skill inside an owned fixture after a seeded trial."""

    def __init__(self, root: Path, skill_path: Path):
        self.root = assert_owned_fixture_root(root)
        self.skill_path = _resolved(skill_path)
        if not _is_within(self.skill_path, self.root):
            raise RuntimeError(f"skill path escapes fixture root: {self.skill_path}")
        self.existed = False
        self.content: bytes | None = None

    def __enter__(self) -> "SkillBackup":
        self.existed = self.skill_path.is_file()
        self.content = self.skill_path.read_bytes() if self.existed else None
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        if self.existed:
            self.skill_path.parent.mkdir(parents=True, exist_ok=True)
            self.skill_path.write_bytes(self.content or b"")
        else:
            self.skill_path.unlink(missing_ok=True)
            parent = self.skill_path.parent
            while parent != self.root and _is_within(parent, self.root):
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent


class MachineTrialContext(NamedTuple):
    root: Path
    repo: Path
    trial: dict[str, Any]
    timeout_seconds: int
    claude_env: dict[str, str]
    server_env: dict[str, str]
    plugin_dir: Path


class MachineTrialCapture(NamedTuple):
    pty_capture: str
    observations: dict[str, bool]
    decoy_log: dict[str, Any]
    server_log: dict[str, Any]
    process_tree: dict[str, Any]


class TrialCaptureFailure(RuntimeError):
    """A safe public failure code paired with redacted-at-write partial evidence."""

    def __init__(self, failure_code: str, capture: MachineTrialCapture):
        super().__init__(failure_code)
        self.failure_code = failure_code
        self.capture = capture


def _reserve_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _pid_alive(pid: int | None) -> bool:
    """Report whether a pid is running, WITHOUT disturbing it.

    `os.kill(pid, 0)` is the POSIX idiom for this and is wrong on Windows: CPython
    implements `os.kill` there via `TerminateProcess`, so signal 0 does not probe the
    process -- it *terminates* it with exit code 0. Used as a liveness check it
    destroys what it measures, which is how the teardown proof came to report a clean
    trial as dirty: every pid it asked about was killed by the asking, so the answer
    described the probe rather than the teardown.
    """

    if not isinstance(pid, int) or pid <= 0:
        return False
    if sys.platform != "win32":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    # SYNCHRONIZE is required to wait on the handle; querying alone yields WAIT_FAILED,
    # which would make every running process read as dead.
    SYNCHRONIZE = 0x00100000
    STILL_ACTIVE = 259
    WAIT_TIMEOUT = 0x102
    WAIT_FAILED = 0xFFFFFFFF

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # Declare the signatures: without a HANDLE restype ctypes assumes c_int and
    # truncates the 64-bit handle, so every subsequent call fails and a running
    # process reports as dead.
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid
    )
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        if code.value != STILL_ACTIVE:
            return False
        # A process that genuinely exited with code 259 is indistinguishable from a
        # running one by exit code alone, so confirm against the wait state: only a
        # still-running process fails to signal its handle. If the wait itself cannot
        # be performed, fall back to STILL_ACTIVE rather than reporting a live process
        # dead -- this check exists to catch survivors, so it must err toward "alive".
        waited = kernel32.WaitForSingleObject(handle, 0)
        return waited in (WAIT_TIMEOUT, WAIT_FAILED)
    finally:
        kernel32.CloseHandle(handle)


def _descendant_pids(root_pid: int | None) -> tuple[list[int], bool]:
    """Snapshot an explicit Windows process tree before terminating its root."""

    if sys.platform != "win32" or not isinstance(root_pid, int):
        return [], False
    powershell = shutil.which("powershell.exe") or shutil.which("pwsh.exe")
    if powershell is None:
        return [], False
    command = (
        "Get-CimInstance Win32_Process | "
        "Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"
    )
    try:
        proc = subprocess.run(
            [powershell, "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return [], False
    if proc.returncode != 0 or not proc.stdout.strip():
        return [], False
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return [], False
    rows = parsed if isinstance(parsed, list) else [parsed]
    children: dict[int, list[int]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        pid = row.get("ProcessId")
        parent = row.get("ParentProcessId")
        if isinstance(pid, int) and isinstance(parent, int):
            children.setdefault(parent, []).append(pid)
    descendants: list[int] = []
    pending = list(children.get(root_pid, []))
    while pending:
        pid = pending.pop()
        if pid in descendants:
            continue
        descendants.append(pid)
        pending.extend(children.get(pid, []))
    return descendants, True


def _terminate_subprocess(proc: subprocess.Popen[Any] | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def _terminate_pid_tree(pid: int | None) -> bool:
    """Terminate a captured Windows PID and its descendants as one bounded tree."""

    if not isinstance(pid, int) or pid <= 0:
        return False
    if sys.platform != "win32":
        try:
            os.kill(pid, 15)
            return True
        except OSError:
            return False
    taskkill = shutil.which("taskkill.exe") or shutil.which("taskkill")
    if taskkill is None:
        return False
    try:
        proc = subprocess.run(
            [taskkill, "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    # taskkill reports 128 when the process exited between snapshot and kill;
    # the caller performs the authoritative liveness check afterward.
    return proc.returncode in (0, 128)


class ConptyTrialDriver:
    """One bounded authenticated Claude trial, using the existing pywinpty pattern."""

    def capture(self, context: MachineTrialContext) -> MachineTrialCapture:
        try:
            from winpty import PtyProcess
        except ImportError as exc:
            raise RuntimeError(
                "pywinpty is required: uv run --with pywinpty python "
                "scripts/spikes/session_monitor_acceptance.py capture ..."
            ) from exc

        deadline = time.monotonic() + context.timeout_seconds
        mcp_port = _reserve_local_port()
        ws_port = _reserve_local_port()
        while ws_port == mcp_port:
            ws_port = _reserve_local_port()
        base_url = f"http://127.0.0.1:{mcp_port}"
        wake_url = f"ws://127.0.0.1:{mcp_port}/api/wake"
        ws_url = f"ws://127.0.0.1:{ws_port}"
        node = shutil.which("node")
        claude = shutil.which(os.environ.get("TANDEM_ACCEPTANCE_CLAUDE", "claude"))
        tsx_cli = context.repo / "node_modules" / "tsx" / "dist" / "cli.mjs"
        if node is None or claude is None or not tsx_cli.is_file():
            raise RuntimeError("node, claude, and the repository tsx dependency are required")

        marker_path = context.plugin_dir / "silent-monitor-pids.log"
        trace_path = context.root / "artifacts" / context.trial["id"] / "claude-hook-events.jsonl"
        _safe_mutation_path(context.root, trace_path.parent).mkdir(parents=True, exist_ok=True)
        marker_path.unlink(missing_ok=True)
        trace_path.unlink(missing_ok=True)
        context.claude_env["TANDEM_ACCEPTANCE_TRACE"] = str(trace_path)
        server_env = dict(context.server_env)
        server_env["TANDEM_MCP_PORT"] = str(mcp_port)
        server_env["TANDEM_PORT"] = str(ws_port)
        server_env["TANDEM_URL"] = base_url
        server_lines: list[dict[str, Any]] = []
        transcript_chunks: list[str] = []
        server: subprocess.Popen[str] | None = None
        pty: Any | None = None
        decoy_response: Any | None = None
        decoy_thread: threading.Thread | None = None
        decoy_stop = threading.Event()
        server_ready_at: float | None = None
        decoy_attached_at: float | None = None
        status_observed_at: float | None = None
        event_text = f"tandem acceptance event {uuid.uuid4()}"
        event_id = f"acceptance-{uuid.uuid4()}"
        server_log: dict[str, Any] = {}
        claude_pid: int | None = None
        claude_descendants: list[int] = []
        process_tree_snapshot_healthy = False
        silent_pids: list[int] = []
        before_count = -1
        after_count = -1
        decoy_attached = False
        decoy_state: dict[str, Any] = {}
        capture_failure: Exception | None = None

        def remaining() -> float:
            return max(0.1, deadline - time.monotonic())

        def capture_stream(stream: Any, source: str) -> None:
            for line in iter(stream.readline, ""):
                server_lines.append({"at": time.time(), "source": source, "line": line.rstrip()})

        try:
            self._preflight_claude_auth(claude, context.root / "workspace", context.claude_env)
            self._patch_runtime_plugin(context, node, tsx_cli, base_url)
            server = subprocess.Popen(
                [node, str(tsx_cli), str(context.repo / "src" / "server" / "index.ts")],
                cwd=context.repo,
                env=server_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            assert server.stdout is not None and server.stderr is not None
            threading.Thread(
                target=capture_stream, args=(server.stdout, "stdout"), daemon=True
            ).start()
            threading.Thread(
                target=capture_stream, args=(server.stderr, "stderr"), daemon=True
            ).start()
            health_before = self._wait_health(base_url, server, deadline)
            server_ready_at = time.time()
            server_log["opened_document"] = self._open_acceptance_document(
                base_url, context.root / "workspace" / ACCEPTANCE_DOCUMENT
            )
            if isinstance(server_log["opened_document"], dict) and server_log[
                "opened_document"
            ].get("error"):
                # Degrades safely -- the inbox poll simply has nothing to report, so the
                # observations go false rather than true. Named anyway: without this the
                # reason sits in a JSON blob that nothing reads, and a broken /api/open
                # is indistinguishable from a model that never polled.
                _record_rig_failure(
                    server_log, f"acceptance-document-open-failed ({ACCEPTANCE_DOCUMENT})"
                )
            launcher_status = self._read_json(f"{base_url}/api/launcher/status")
            server_log["observed_launcher_mode"] = self._launcher_mode(launcher_status)

            hashes = json.loads(
                (context.root / "fixtures" / "skill-hashes.json").read_text(encoding="utf-8")
            )
            if context.trial["requires_refresh"]:
                managed_skill = context.root / "home" / ".claude" / "skills" / "tandem" / "SKILL.md"
                ready_hash = _sha256(managed_skill.read_bytes())
                server_log.update(
                    {
                        "refreshed_before_ready": ready_hash == hashes["candidate"],
                        "seeded_skill_sha256": hashes["v9"],
                        "candidate_skill_sha256": hashes["candidate"],
                        "ready_skill_sha256": ready_hash,
                        "ready_skill_observed_at": managed_skill.stat().st_mtime_ns / 1_000_000_000,
                        "server_ready_at": server_ready_at,
                    }
                )
            else:
                server_log.update(
                    {
                        "refreshed_before_ready": None,
                        "candidate_skill_sha256": hashes["plugin_candidate"],
                        "ready_skill_sha256": _sha256(
                            (
                                context.plugin_dir
                                / "skills"
                                / "tandem"
                                / "SKILL.md"
                            ).read_bytes()
                        ),
                    }
                )
            server_log["server_process"] = server_lines

            decoy_ready = threading.Event()
            def run_decoy() -> None:
                nonlocal decoy_response, decoy_attached_at
                try:
                    decoy_response = urllib.request.urlopen(
                        f"{base_url}/api/events?filter=wake", timeout=min(10, remaining())
                    )
                    decoy_attached_at = time.time()
                    decoy_state["connected"] = True
                    decoy_ready.set()
                    while not decoy_stop.is_set():
                        chunk = decoy_response.readline()
                        if not chunk:
                            break
                except Exception as exc:  # recorded as INCONCLUSIVE evidence
                    decoy_state["error"] = str(exc)
                    decoy_ready.set()

            decoy_thread = threading.Thread(target=run_decoy, daemon=True)
            decoy_thread.start()
            if not decoy_ready.wait(timeout=min(10, remaining())):
                decoy_state["error"] = "decoy connection timed out"
            health_after = self._wait_health(base_url, server, deadline)
            before_count = self._subscriber_count(health_before)
            after_count = self._subscriber_count(health_after)
            decoy_attached = decoy_state.get("connected") is True and after_count > before_count

            claude_started_at = time.time()
            pty = PtyProcess.spawn(
                [claude, "--plugin-dir", str(context.plugin_dir)],
                cwd=str(context.root / "workspace"),
                env=context.claude_env,
                dimensions=(45, 140),
            )
            claude_pid = getattr(pty, "pid", None)

            def read_pty() -> None:
                while True:
                    try:
                        transcript_chunks.append(pty.read(4096))
                    except UnicodeDecodeError:
                        time.sleep(0.01)
                    except Exception:
                        return

            threading.Thread(target=read_pty, daemon=True).start()
            trust_prompt_accepted = False

            def session_started() -> bool:
                nonlocal trust_prompt_accepted
                if self._structured_event_after(
                    self._read_hook_events(trace_path), "SessionStart", claude_started_at
                ):
                    return True
                trust_prompt_accepted = self._accept_workspace_trust_prompt_if_selected(
                    pty,
                    "".join(transcript_chunks),
                    already_accepted=trust_prompt_accepted,
                )
                return False

            if not self._wait_until(
                session_started,
                deadline,
                30,
            ):
                raise RuntimeError("plugin-session-start-not-observed")
            # SessionStart fires on process start, independent of TTY rendering, so it
            # can be observed while a first-run interstitial (e.g. the fullscreen
            # renderer opt-in) is still on screen and would otherwise swallow the
            # command keystrokes below. Dismiss it without opting in.
            interstitial_dismissed = False

            def interstitial_clear() -> bool:
                nonlocal interstitial_dismissed
                interstitial_dismissed = self._dismiss_interstitial_prompt_if_shown(
                    pty,
                    "".join(transcript_chunks),
                    already_dismissed=interstitial_dismissed,
                )
                return interstitial_dismissed

            self._wait_until(interstitial_clear, deadline, 5)
            # Exactly one dispatch per trial. The control arm dispatches the skill
            # explicitly; the natural arm dispatches it by asking for Tandem work in
            # prose. Sending both -- as this did until 2026-08-11 -- conflates the two
            # arms of the matrix and races the second write against the first turn,
            # which is still occupied by the blocking Monitor call it just armed.
            # Nothing in the evidence model needs the prose text on a control trial:
            # `prompt_submitted` reads any UserPromptSubmit, `skill_dispatched` reads
            # the marker file, and the wake fields read the autonomous turn that the
            # injected event provokes.
            prompt = self._dispatch_prompt(context.trial)
            prompt_submitted_at = time.time()
            pty.write(prompt)
            time.sleep(1)
            pty.write("\r")
            if not self._wait_until(
                lambda: self._structured_event_after(
                    self._read_hook_events(trace_path),
                    "UserPromptSubmit",
                    prompt_submitted_at,
                ),
                deadline,
                15,
            ):
                raise RuntimeError("user-prompt-submit-not-observed")
            # `min(90, timeout * 0.55)` used to cap this, which is always exactly 90
            # for any --timeout-seconds >= 164 -- so this wait never scaled with the
            # budget at all. Derive it from the deadline instead, so one knob
            # (--timeout-seconds) governs how long a trial may take.
            def classify_turn() -> str:
                return classify_dispatch(
                    self._read_hook_events(trace_path),
                    prompt_submitted_at=prompt_submitted_at,
                    dispatch_marker_seen=marker_path.is_file(),
                )

            def monitor_idle_or_blocked() -> bool:
                # An unanswered permission dialog stalls the turn with no event and no
                # error, which reads identically to a slow host: it cost seven live
                # sessions and a wrong latency diagnosis before the transcript was
                # read. `bypassPermissions` should prevent it, but a config that
                # silently stops working must not be able to masquerade as latency
                # again -- so name it the moment it appears.
                transcript = "".join(transcript_chunks)
                if self._permission_dialog_blocking(transcript):
                    raise RuntimeError("permission-dialog-blocked-turn")
                interrupted = self._turn_interrupted(transcript)
                if interrupted is not None:
                    raise RuntimeError(f"turn-interrupted-{interrupted}")
                if self._structured_monitor_is_idle(self._read_hook_events(trace_path)):
                    return True
                # A turn that completed without dispatching the skill has nothing left
                # to wait for: no monitor was armed, so monitor-idle can never become
                # true and this wait would burn the entire remaining budget before
                # aborting the capture. That abort is what made a legitimate model
                # decline unrecordable -- it forced capture_healthy false and
                # FAILED_LIVE_CAPTURE, which the gate rejects unconditionally, so a
                # bounded n=3 sample could never contain a decline and still pass.
                return classify_turn() == DISPATCH_DECLINED

            self._wait_until(
                monitor_idle_or_blocked,
                deadline,
                injection_budget(deadline, time.monotonic()),
            )
            status_observed_at = time.time()
            health_armed = self._wait_health(base_url, server, deadline)
            armed_count = self._subscriber_count(health_armed)
            monitor_idle = self._structured_monitor_is_idle(self._read_hook_events(trace_path))
            outcome = settle_and_classify(
                classify_turn,
                monitor_idle=monitor_idle,
                settle=lambda: self._wait_until(
                    lambda: classify_turn() == DISPATCH_OBSERVED,
                    deadline,
                    DISPATCH_SETTLE_SECONDS,
                ),
            )
            if outcome == SETTLE_UNOBSERVED:
                raise RuntimeError("structured-monitor-idle-not-observed")
            # Re-checked after the settle window, which is where a decline is finalised: an
            # interruption printed during those seconds would otherwise be the one that
            # gets recorded as the model's choice.
            interrupted = self._turn_interrupted("".join(transcript_chunks))
            if interrupted is not None:
                raise RuntimeError(f"turn-interrupted-{interrupted}")
            declined = outcome == DISPATCH_DECLINED
            if not declined:
                if armed_count < after_count + 1:
                    raise RuntimeError("monitor-subscriber-not-observed")
            if declined:
                # Skip injection and the subscriber assertion: there is no armed monitor
                # to wake, and asserting on one would fail a trial for an outcome the
                # sample size exists to measure. `injected_at` stays unset, so the
                # dispatch-consequent observations derive false -- `stop_after_monitor`
                # is guarded on a real `monitor_at`, so the float("inf") default cannot
                # read true here. Teardown and artifact writing proceed normally, which
                # is what makes this a healthy direct-live row carrying a negative
                # rather than a failed capture.
                server_log["dispatch_classification"] = DISPATCH_DECLINED
            else:
                server_log["dispatch_classification"] = DISPATCH_OBSERVED
                injected_at = time.time()
                injector = subprocess.run(
                    [
                        node,
                        str(context.repo / "scripts" / "spikes" / "session-monitor-user-event.mjs"),
                        base_url,
                        ws_url,
                        event_id,
                        event_text,
                    ],
                    cwd=context.repo,
                    env=server_env,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=min(20, remaining()),
                    check=False,
                )
                server_log["injector"] = {
                    "returncode": injector.returncode,
                    "stdout": injector.stdout,
                    "stderr": injector.stderr,
                }
                if injector.returncode != 0:
                    # The injector's failure cannot fabricate a pass -- `wake_seen` and
                    # `inbox_checked` come from server truth, so a failed injection just
                    # degrades them to false. But it lands in the same bucket as "the
                    # model never checked its inbox", and only this list distinguishes
                    # the two without someone thinking to open a raw artifact.
                    _record_rig_failure(
                        server_log, f"wake-injection-failed (exit {injector.returncode})"
                    )
                self._wait_until(
                    lambda: self._structured_inbox_saw(
                        self._read_hook_events(trace_path), event_text, injected_at
                    ),
                    deadline,
                    remaining(),
                )
        except Exception as exc:
            capture_failure = exc
        finally:
            if marker_path.is_file():
                for value in marker_path.read_text(encoding="utf-8").splitlines():
                    try:
                        silent_pids.append(int(value.strip()))
                    except ValueError:
                        pass
            claude_descendants, process_tree_snapshot_healthy = _descendant_pids(claude_pid)
            _terminate_pid_tree(claude_pid)
            if pty is not None:
                try:
                    pty.terminate(force=True)
                except Exception:
                    pass
            decoy_stop.set()
            if decoy_response is not None:
                try:
                    decoy_response.close()
                except Exception:
                    pass
            if decoy_thread is not None:
                decoy_thread.join(timeout=2)
            if server is not None:
                _terminate_pid_tree(server.pid)
            _terminate_subprocess(server)
            time.sleep(0.5)

        transcript = "".join(transcript_chunks)
        transcript_health = parse_trial_transcript(
            transcript,
            dispatch_marker_seen=marker_path.is_file(),
            event_text=event_text,
        )
        observations = derive_structured_observations(
            self._read_hook_events(trace_path),
            dispatch_marker_seen=marker_path.is_file(),
            event_text=event_text,
            injected_at=locals().get("injected_at", float("inf")),
            transcript_health={
                field: transcript_health[field] for field in TRANSCRIPT_HEALTH_FIELDS
            },
            decoy_count=after_count,
            armed_count=locals().get("armed_count", -1),
            prompt_submitted_at=locals().get("prompt_submitted_at", 0.0),
        )
        observed_pids = list(
            dict.fromkeys(
                pid
                for pid in [
                    claude_pid,
                    *claude_descendants,
                    *silent_pids,
                    server.pid if server else None,
                ]
                if isinstance(pid, int)
            )
        )
        # Killing a process tree is not synchronous on Windows: a terminated pid stays
        # visible briefly after the kill returns. Reading liveness once, right after a
        # flat 0.5s sleep, therefore reported a perfectly clean teardown as dirty --
        # both "surviving" pids were already gone by the time they were investigated.
        # Poll for exit instead, so this stays a real check (a process that genuinely
        # survives still fails it) without failing on reap latency.
        for _ in range(50):
            remaining_pids = [pid for pid in observed_pids if _pid_alive(pid)]
            if not remaining_pids:
                break
            time.sleep(0.2)
        process_tree = {
            "claude_process_tree_teardown_verified": (
                process_tree_snapshot_healthy
                and isinstance(claude_pid, int)
                and all(not _pid_alive(pid) for pid in [claude_pid, *claude_descendants])
            ),
            "silent_monitor_teardown_verified": silent_monitor_teardown_proven(
                silent_pids,
                dispatch_classification=server_log.get("dispatch_classification"),
                pid_alive=_pid_alive,
            ),
            "process_tree_snapshot_healthy": process_tree_snapshot_healthy,
            "observed_claude_pids": [claude_pid, *claude_descendants],
            "observed_silent_monitor_pids": silent_pids,
            "remaining_pids": remaining_pids,
        }
        decoy_log = {
            "subscriber_id": f"decoy-{uuid.uuid4()}",
            "attached": decoy_attached,
            "attached_at": decoy_attached_at,
            "status_observed_at": status_observed_at,
            "subscriber_count_before": before_count,
            "subscriber_count_after": after_count,
            **decoy_state,
        }
        # How long the armed Monitor call held the turn. Deliberately recorded here
        # and NOT added to OBSERVATION_FIELDS: that tuple is the gate's boolean
        # criteria set, and the product invariant promises an arming *attempt*, not a
        # speed, so a duration threshold nobody has justified must not decide
        # PASS/FAIL. But it is the most user-visible fact these sessions produce --
        # measured between 45s and 664s, with the growth across runs still
        # unexplained -- so it belongs in the redacted, hashed, attested bundle
        # rather than only in a raw artifact somebody has to think to open.
        server_log["monitor_timing"] = self._monitor_timing(self._read_hook_events(trace_path))
        capture = MachineTrialCapture(
            pty_capture=transcript,
            observations=observations,
            decoy_log=decoy_log,
            server_log=server_log,
            process_tree=process_tree,
        )
        if capture_failure is not None:
            public_code = (
                str(capture_failure)
                if isinstance(capture_failure, RuntimeError)
                and str(capture_failure)
                in {
                    "claude-auth-required-run-fixture-login",
                    "plugin-session-start-not-observed",
                    "user-prompt-submit-not-observed",
                    "structured-monitor-idle-not-observed",
                    "monitor-subscriber-not-observed",
                    "permission-dialog-blocked-turn",
                }
                else "capture-runtime-failure"
            )
            server_log["failure_code"] = public_code
            raise TrialCaptureFailure(public_code, capture) from capture_failure
        return capture

    @staticmethod
    def _wait_until(predicate: Any, deadline: float, cap_seconds: float) -> bool:
        local_deadline = min(deadline, time.monotonic() + max(0.1, cap_seconds))
        while time.monotonic() < local_deadline:
            if predicate():
                return True
            time.sleep(0.2)
        return bool(predicate())

    @staticmethod
    def _accept_workspace_trust_prompt_if_selected(
        pty: Any, transcript: str, *, already_accepted: bool
    ) -> bool:
        """Accept only Claude's unmistakable, positively selected trust prompt."""

        if already_accepted:
            return True
        # Claude renders this screen with absolute cursor-column jumps (\x1b[<n>G)
        # between words instead of literal spaces; stripping ANSI codes collapses
        # "Accessing workspace" into "Accessingworkspace", so matching must be
        # whitespace-insensitive on both sides.
        clean = ANSI_RE.sub("", transcript)
        squashed = re.sub(r"\s+", "", clean)
        if "Accessingworkspace" not in squashed or "Quicksafetycheck" not in squashed:
            return False
        selected_yes = re.search(r"(?:❯|>)1\.?Yes,?Itrustthisfolder", squashed)
        if selected_yes is None:
            return False
        pty.write("\r")
        return True

    @staticmethod
    def _dismiss_interstitial_prompt_if_shown(
        pty: Any, transcript: str, *, already_dismissed: bool
    ) -> bool:
        """Dismiss known first-run tip dialogs without opting into anything.

        These are unrelated to the workspace-trust prompt and appear only once per
        fresh HOME. Escape declines without recording acceptance, so the fixture's
        behavior stays independent of whichever option happens to be pre-selected.
        The accumulated transcript never loses this text once shown (a screen clear
        does not erase earlier bytes from the log), so dismissal must be tracked by
        the caller rather than re-derived from the transcript on every poll.
        """

        if already_dismissed:
            return True
        squashed = re.sub(r"\s+", "", ANSI_RE.sub("", transcript))
        if "Trythenewfullscreenrenderer" not in squashed:
            return False
        pty.write("\x1b")
        return True

    @staticmethod
    def _preflight_claude_auth(
        claude: str, workspace: Path, child_env: dict[str, str]
    ) -> None:
        """Require authentication under the exact environment used by the PTY."""

        completed = subprocess.run(
            [claude, "auth", "status"],
            cwd=workspace,
            env=child_env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )
        combined = "\n".join((completed.stdout, completed.stderr))
        logged_in = False
        try:
            status = json.loads(completed.stdout)
            logged_in = isinstance(status, dict) and status.get("loggedIn") is True
        except json.JSONDecodeError:
            logged_in = bool(re.search(r'(?i)"?loggedIn"?\s*[:=]\s*true', combined))
        if completed.returncode != 0 or not logged_in:
            raise RuntimeError("claude-auth-required-run-fixture-login")

    @staticmethod
    def _wait_health(
        base_url: str, server: subprocess.Popen[str], deadline: float
    ) -> dict[str, Any]:
        last_error = "server did not answer"
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError(f"candidate server exited early with {server.returncode}")
            try:
                with urllib.request.urlopen(f"{base_url}/health", timeout=1) as response:
                    return json.loads(response.read().decode("utf-8"))
            except Exception as exc:
                last_error = str(exc)
                time.sleep(0.2)
        raise RuntimeError(f"candidate server readiness timed out: {last_error}")

    @staticmethod
    def _subscriber_count(health: dict[str, Any]) -> int:
        push = health.get("push")
        count = push.get("subscribers") if isinstance(push, dict) else None
        return int(count) if isinstance(count, int) else -1

    @staticmethod
    def _read_json(url: str) -> dict[str, Any]:
        with urllib.request.urlopen(url, timeout=3) as response:
            value = json.loads(response.read().decode("utf-8"))
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _launcher_mode(status: dict[str, Any]) -> str:
        if status.get("available") is True:
            return "normal"
        return {
            "disabled-by-env": "launcher-disabled",
            "deferred-autostart": "deferred-autostart",
        }.get(str(status.get("reason")), "unknown")

    @staticmethod
    def _read_hook_events(path: Path) -> list[dict[str, Any]]:
        if not path.is_file():
            return []
        events: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                events.append(value)
        return events

    @staticmethod
    def _structured_event_after(events: list[dict[str, Any]], name: str, after: float) -> bool:
        return any(
            event.get("hook_event_name") == name
            and event_at(event) is not None
            and event_at(event) > after
            for event in events
        )

    @staticmethod
    def _structured_monitor_is_idle(events: list[dict[str, Any]]) -> bool:
        monitor_times = [
            event_at(event)
            for event in events
            if event.get("hook_event_name") == "PreToolUse"
            and str(event.get("tool_name", "")).lower() == "monitor"
            and event_at(event) is not None
        ]
        return bool(monitor_times) and any(
            event.get("hook_event_name") == "Stop"
            and event_at(event) is not None
            and event_at(event) > monitor_times[0]
            for event in events
        )

    @staticmethod
    def _open_acceptance_document(base_url: str, path: Path) -> dict[str, Any]:
        """Open the fixture document so the document-scoped inbox poll can report.

        Loopback POST, which `/api/open` requires. Recorded rather than raised: a
        failure here should surface as a false `inbox_checked` with a visible reason,
        not as a capture crash that hides which half of the chain broke.
        """

        request = urllib.request.Request(
            f"{base_url}/api/open",
            # `filePath`, not `path` -- the route 400s on anything else
            # (src/server/mcp/routes/open.ts).
            data=json.dumps({"filePath": str(path)}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return {"status": response.status, "path": str(path)}
        except Exception as exc:
            return {"error": str(exc), "path": str(path)}

    @staticmethod
    def _permission_dialog_blocking(transcript: str) -> bool:
        """True when a tool-approval dialog is on screen awaiting an answer.

        Matches whitespace-insensitively: Claude renders these screens with absolute
        cursor-column jumps rather than literal spaces, so ANSI-stripped text collapses
        "Do you want to proceed?" into "Doyouwanttoproceed?".
        """

        squashed = re.sub(r"\s+", "", ANSI_RE.sub("", transcript))
        return "Doyouwanttoproceed?" in squashed

    @staticmethod
    def _turn_interrupted(transcript: str) -> str | None:
        """The host-side reason this turn ended early, or None if it ran to its own end.

        A turn cut short by the host -- a usage limit, an API error, a compaction -- ends
        with a normal `Stop` event after `tandem_status` has already succeeded, so it is
        indistinguishable at the row level from a model that read the skill's description
        and chose not to arm. That is the one thing a decline must never be confused with:
        the sample exists to measure the model's choice, and this turn never got to make
        one. Named here so the capture fails loudly instead of contributing a negative.

        Matched on squashed lowercase text for the same reason as the dialog check above.
        A false positive costs one re-run; a false negative is a fabricated measurement.
        """

        squashed = re.sub(r"\s+", "", ANSI_RE.sub("", transcript)).lower()
        for marker, reason in (
            ("claudeusagelimitreached", "usage-limit"),
            ("apierror:", "api-error"),
            ("rate_limit_error", "rate-limited"),
            ("overloaded_error", "overloaded"),
            # The steady-state "context left until auto-compact" hint is deliberately not
            # matched -- it is a budget readout, not an interruption.
            ("compactingconversation", "compacted"),
            ("reachedmaximumturns", "max-turns"),
        ):
            if marker in squashed:
                return reason
        return None

    @staticmethod
    def _dispatch_prompt(trial: dict[str, Any]) -> str:
        """The single dispatch for one trial: explicit for control, prose for natural."""

        return (
            "/tandem"
            if trial["prompt_kind"] == "control"
            else "Use Tandem to report the current collaboration state."
        )

    @staticmethod
    def _monitor_timing(events: list[dict[str, Any]]) -> dict[str, Any]:
        """Measure how long the first armed Monitor call held the turn."""

        def first_at(hook: str) -> float | None:
            for event in events:
                if (
                    event.get("hook_event_name") == hook
                    and str(event.get("tool_name", "")).lower() == "monitor"
                    and event_at(event) is not None
                ):
                    return float(event_at(event))
            return None

        armed_at = first_at("PreToolUse")
        resolved_at = first_at("PostToolUse")
        resolution_seconds: float | None = None
        if armed_at is not None and resolved_at is not None and resolved_at >= armed_at:
            resolution_seconds = round(resolved_at - armed_at, 3)
        return {
            "monitor_armed_at": armed_at,
            # None means the call was still blocking when the trial ended, which is
            # itself the observation -- do not coerce it to a number.
            "monitor_resolved_at": resolved_at,
            "monitor_resolution_seconds": resolution_seconds,
        }

    @staticmethod
    def _structured_inbox_saw(events: list[dict[str, Any]], text: str, after: float) -> bool:
        return any(
            event.get("hook_event_name") == "PostToolUse"
            and str(event.get("tool_name", "")).lower().endswith("tandem_checkinbox")
            and event_at(event) is not None
            and event_at(event) > after
            and text in json.dumps(event.get("tool_response"))
            for event in events
        )

    @staticmethod
    def _patch_runtime_plugin(
        context: MachineTrialContext, node: str, tsx_cli: Path, base_url: str
    ) -> None:
        manifest_path = context.plugin_dir / ".claude-plugin" / "plugin.json"
        manifest_path = _safe_mutation_path(context.root, manifest_path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["mcpServers"]["tandem"] = {
            "command": node,
            "args": [
                str(tsx_cli),
                str(context.repo / "src" / "cli" / "index.ts"),
                "mcp-stdio",
            ],
            "env": {
                "TANDEM_URL": base_url,
                "TANDEM_AUTH_TOKEN": context.server_env["TANDEM_AUTH_TOKEN"],
            },
        }
        quoted_node = f'"{node}"' if " " in node else node
        for monitor in manifest.get("experimental", {}).get("monitors", []):
            monitor["command"] = f'{quoted_node} "${{CLAUDE_PLUGIN_ROOT}}/silent-monitor.mjs"'
        _write_json(manifest_path, manifest)


def produce_trial(
    root: Path,
    repo: Path,
    trial_id: str,
    *,
    timeout_seconds: int,
    driver: Any | None = None,
    overwrite: bool = False,
) -> Path:
    """Run exactly one bounded trial and emit the five-artifact capture contract."""

    root = assert_owned_fixture_root(root)
    repo = _resolved(repo)
    trials = {trial["id"]: trial for trial in build_trial_matrix()}
    trial = trials.get(trial_id)
    if trial is None:
        raise RuntimeError(f"unknown trial id {trial_id!r}")
    # The ceiling exists to keep a hung trial from running forever, not to bound
    # normal duration: a single control dispatch has been measured taking over
    # seven minutes to resolve its Monitor call, so 600s was itself the failure.
    if timeout_seconds < 10 or timeout_seconds > 1800:
        raise RuntimeError("trial timeout must be between 10 and 1800 seconds")
    plugin_dir = root / "fixtures" / "candidate-plugin-v10"
    if not plugin_dir.is_dir():
        raise RuntimeError("candidate plugin fixture is absent; run prepare with --repo first")
    # Decide the already-captured question BEFORE driving a live session. This check
    # used to sit after the capture, which on 2026-08-11 spent a full twelve-minute
    # authenticated session and then refused to write its artifacts -- destroying the
    # transcript needed to diagnose the run, and discarding the failure row the
    # harness otherwise preserves for failed live trials.
    artifact_dir = _safe_mutation_path(root, root / "artifacts" / trial_id)
    manifest_path = artifact_dir / "capture-manifest.json"
    supersede_dir: Path | None = None
    if manifest_path.exists():
        if not overwrite:
            raise RuntimeError(
                f"capture already exists for {trial_id}; "
                "pass --overwrite to supersede it, or use a fresh fixture root"
            )
        # Reserve the slot now so the live session is not spent only to find the
        # supersede target unavailable, but do not move anything yet: the rename
        # happens once a capture is actually in hand (see below). Renaming here would
        # leave evidence.json's existing row pointing at a path that no longer exists
        # if the managed-skill seed then failed on its own backup guard.
        supersede_dir = _reserve_supersede_dir(root, trial_id)
    startup_mode = (
        trial["startup_mode"] if trial["install_shape"] == MANAGED_SHAPE else "launcher-disabled"
    )
    context = MachineTrialContext(
        root=root,
        repo=repo,
        trial=trial,
        timeout_seconds=timeout_seconds,
        claude_env=claude_environment(root),
        server_env=server_environment(root, startup_mode),
        plugin_dir=plugin_dir,
    )
    release_eligible = driver is None
    capture_driver = driver if driver is not None else ConptyTrialDriver()
    seeded = False
    failure_code: str | None = None
    try:
        if trial["requires_refresh"]:
            seed_managed_skill(root)
            seeded = True
        try:
            capture = capture_driver.capture(context)
        except TrialCaptureFailure as exc:
            capture = exc.capture
            failure_code = exc.failure_code
    finally:
        if seeded:
            restore_managed_skill(root)

    artifact_dir = _safe_mutation_path(root, root / "artifacts" / trial_id)
    if supersede_dir is not None:
        _supersede_prior_capture(root, trial_id, artifact_dir, supersede_dir)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    if supersede_dir is not None:
        # The live hook trace is written *inside* the artifact directory, so the
        # supersede rename above just carried this run's own trace into the
        # superseded slot alongside the previous run's artifacts. Put it back with
        # the capture it belongs to -- it is the highest-value diagnostic here, and
        # filing it under "superseded" is exactly the evidence loss Defect A fixed.
        moved_trace = supersede_dir / "claude-hook-events.jsonl"
        if moved_trace.is_file():
            moved_trace.replace(artifact_dir / "claude-hook-events.jsonl")
    redacted_observations = redact_capture_value(capture.observations)
    redacted_decoy = redact_capture_value(capture.decoy_log)
    redacted_server = redact_capture_value(capture.server_log)
    redacted_process_tree = redact_capture_value(capture.process_tree)
    payloads = {
        "pty_capture": redact_capture_text(capture.pty_capture).encode("utf-8"),
        "observation_trace": (
            json.dumps(
                {
                    "schema_version": CAPTURE_SCHEMA_VERSION,
                    "trial_id": trial_id,
                    "observations": redacted_observations,
                },
                indent=2,
            )
            + "\n"
        ).encode("utf-8"),
        "decoy_log": (json.dumps(redacted_decoy, indent=2) + "\n").encode("utf-8"),
        "server_log": (json.dumps(redacted_server, indent=2) + "\n").encode("utf-8"),
        "process_tree": (json.dumps(redacted_process_tree, indent=2) + "\n").encode("utf-8"),
    }
    artifacts: list[dict[str, str]] = []
    for role, payload in payloads.items():
        artifact_path = artifact_dir / f"{role}.txt"
        _safe_mutation_path(root, artifact_path).write_bytes(payload)
        artifacts.append(
            {
                "role": role,
                "path": artifact_path.relative_to(root).as_posix(),
                "sha256": _sha256(payload),
            }
        )
    manifest = {
        "schema_version": CAPTURE_SCHEMA_VERSION,
        "producer": CAPTURE_PRODUCER,
        "trial_id": trial_id,
        "observations": {},
        "artifacts": sorted(artifacts, key=lambda item: item["role"]),
    }
    _write_json(manifest_path, manifest)
    if release_eligible or failure_code is not None:
        row = _row_from_capture(
            root,
            trial,
            capture,
            _sha256(manifest_path.read_bytes()),
            artifacts,
            FAILED_LIVE_CAPTURE if failure_code is not None else DIRECT_LIVE_CAPTURE,
        )
        if failure_code is not None:
            row["capture_healthy"] = False
            # Appended, not assigned: a rig failure recorded before the raise has already
            # written its own segment here, and overwriting it would erase the one thing
            # that says WHY this capture failed -- on exactly the rows where that answer
            # matters most.
            row["notes"] = append_note(row.get("notes"), f"capture failed: {failure_code}")
            row[ATTESTATION_FIELD] = sign_evidence_row(row, _load_attestation_key(root))
        _replace_evidence_row(root, row)
    if failure_code is not None:
        raise RuntimeError(failure_code)
    return manifest_path


def _row_from_capture(
    root: Path,
    trial: dict[str, Any],
    capture: MachineTrialCapture,
    manifest_hash: str,
    artifacts: list[dict[str, str]],
    eligibility: str,
) -> dict[str, Any]:
    """Create an evidence row from the producer's in-memory observations."""

    row = _empty_evidence(trial)
    row.update(capture.observations)
    row.update(
        {
            "decoy_subscriber_attached": capture.decoy_log.get("attached"),
            "decoy_subscriber_id": capture.decoy_log.get("subscriber_id"),
            "decoy_attached_at": capture.decoy_log.get("attached_at"),
            "status_observed_at": capture.decoy_log.get("status_observed_at"),
            "claude_process_tree_teardown_verified": capture.process_tree.get(
                "claude_process_tree_teardown_verified"
            ),
            "silent_monitor_teardown_verified": capture.process_tree.get(
                "silent_monitor_teardown_verified"
            ),
            "capture_manifest_sha256": manifest_hash,
            "artifacts": sorted(artifacts, key=lambda item: item["role"]),
            CAPTURE_ELIGIBILITY_FIELD: eligibility,
        }
    )
    # Rig failures ride into the row's notes so `evaluate` can name them. Deliberately
    # NOT a gate field: they degrade observations toward false, never toward a fabricated
    # true, so they cannot manufacture a pass -- and making them a precondition would let
    # one flaky trial veto an otherwise clean shape, which is a worse failure than the
    # anonymity being fixed.
    rig_failures = capture.server_log.get("failures")
    if isinstance(rig_failures, list) and rig_failures:
        row["notes"] = append_note(
            row.get("notes"), f"{RIG_NOTE_PREFIX}{', '.join(rig_failures)}"
        )
    for field in (
        "refreshed_before_ready",
        "seeded_skill_sha256",
        "candidate_skill_sha256",
        "ready_skill_sha256",
        "ready_skill_observed_at",
        "server_ready_at",
        "observed_launcher_mode",
        "observed_launcher_mode",
    ):
        if field in capture.server_log:
            row[field] = capture.server_log[field]
    row[ATTESTATION_FIELD] = sign_evidence_row(row, _load_attestation_key(root))
    return row


def _reserve_supersede_dir(root: Path, trial_id: str) -> Path:
    """Pick the lowest free `artifacts/<trial>.superseded-<n>` slot."""

    for index in range(1, 1000):
        candidate = _safe_mutation_path(root, root / "artifacts" / f"{trial_id}.superseded-{index}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"too many superseded captures for {trial_id}; use a fresh fixture root")


def _repoint_artifact_paths(
    payload: dict[str, Any], root: Path, artifact_dir: Path, supersede_dir: Path
) -> dict[str, Any]:
    """Rewrite an archived payload's artifact paths to the superseded location.

    Paths are recorded relative to the fixture root (`artifacts/<trial_id>/role.txt`),
    so a payload carried into the supersede slot verbatim still points at the *live*
    slot -- which the next capture repopulates. Following the archived manifest would
    then return a different capture's bytes while its recorded sha256 still matches
    nothing, i.e. silently wrong rather than absent. Rewrite so an archived bundle
    resolves to the bytes it was actually signed over.
    """

    old_prefix = artifact_dir.relative_to(root).as_posix()
    new_prefix = supersede_dir.relative_to(root).as_posix()
    repointed = dict(payload)
    if "artifacts" not in payload:
        # Absence is preserved rather than normalised to []. Writing an empty list would
        # claim this capture produced no artifacts, which is a different statement from
        # "this payload never recorded any" -- and the same silent-substitution the
        # prefix rewrite above exists to prevent.
        return repointed
    if not isinstance(payload["artifacts"], list):
        raise TypeError(f"archived payload's artifacts is {type(payload['artifacts']).__name__}")
    artifacts = []
    for entry in payload["artifacts"]:
        moved = dict(entry)
        path = str(entry.get("path", ""))
        if path == old_prefix or path.startswith(f"{old_prefix}/"):
            moved["path"] = new_prefix + path[len(old_prefix) :]
        artifacts.append(moved)
    repointed["artifacts"] = artifacts
    return repointed


def _void_archived_attestation(row: dict[str, Any], manifest_sha: str | None) -> dict[str, Any]:
    """Make an archived row internally honest about being a rewritten copy.

    Re-pointing the paths changes bytes covered by both the attestation and the row's
    recorded manifest hash. The hash can be restated truthfully -- it describes a file
    sitting right there -- so it is recomputed. The signature cannot: leaving it makes
    every verification of the archive fail identically to tampering, which is the exact
    misreading that costs an auditor their trust in the whole bundle.
    """

    voided = dict(row)
    if manifest_sha is not None and "capture_manifest_sha256" in voided:
        voided["capture_manifest_sha256"] = manifest_sha
    voided.pop(ATTESTATION_FIELD, None)
    voided[ARCHIVED_ATTESTATION_REASON_FIELD] = "repointed-on-supersede"
    return voided


def _supersede_prior_capture(
    root: Path, trial_id: str, artifact_dir: Path, supersede_dir: Path
) -> None:
    """Move a prior capture aside, carrying its evidence row with it.

    Never deletes. A re-attempt supersedes evidence; it does not erase it -- and the
    `evidence.json` row is what `evaluate` actually reads, so protecting only the
    artifact directory would leave the load-bearing half unprotected.

    Both archived payloads are re-pointed at the supersede slot (see
    `_repoint_artifact_paths`), which changes bytes the row was signed over, so the
    archived row cannot carry a valid attestation and is not re-signed either -- a
    re-signature would assert that this session vouched for a capture it only moved.
    Instead the dead signature is removed and replaced with a reason (see
    `_void_archived_attestation`), because a signature that always fails verification
    reads as tampering rather than as a knowingly-rewritten diagnostic copy.
    """

    if supersede_dir.exists():
        raise RuntimeError(f"supersede slot {supersede_dir.name} is no longer free")
    artifact_dir.rename(supersede_dir)
    manifest_path = supersede_dir / "capture-manifest.json"
    manifest_sha: str | None = None
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        _write_json(
            manifest_path, _repoint_artifact_paths(manifest, root, artifact_dir, supersede_dir)
        )
        manifest_sha = _sha256(manifest_path.read_bytes())
    evidence_path = _safe_mutation_path(root, root / "evidence.json")
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    prior = next((entry for entry in evidence if entry.get("id") == trial_id), None)
    if prior is not None:
        _write_json(
            supersede_dir / "superseded-evidence-row.json",
            _void_archived_attestation(
                _repoint_artifact_paths(prior, root, artifact_dir, supersede_dir), manifest_sha
            ),
        )


def _replace_evidence_row(root: Path, row: dict[str, Any]) -> None:
    evidence_path = _safe_mutation_path(root, root / "evidence.json")
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    for index, existing in enumerate(evidence):
        if existing.get("id") == row["id"]:
            evidence[index] = row
            break
    else:
        raise RuntimeError(f"evidence matrix has no row for {row['id']}")
    _write_json(evidence_path, evidence)


def seed_managed_skill(root: Path) -> Path:
    """Seed immutable v9 into the fixture, persisting enough state to restore it."""

    root = assert_owned_fixture_root(root)
    source = root / "fixtures" / "managed-v9-SKILL.md"
    if not source.is_file():
        raise RuntimeError(f"missing v9 fixture: {source}; run prepare with --repo first")
    state_path = _safe_mutation_path(root, root / "backups" / "managed-skill-state.json")
    backup_path = _safe_mutation_path(root, root / "backups" / "managed-skill-before.bin")
    if state_path.exists() or backup_path.exists():
        raise RuntimeError("managed skill backup is already active; restore it before reseeding")
    skill = _safe_mutation_path(
        root, root / "home" / ".claude" / "skills" / "tandem" / "SKILL.md"
    )
    if not _is_within(skill, root):
        raise RuntimeError(f"managed skill path escapes fixture root: {skill}")
    existed = skill.is_file()
    if existed:
        backup_path.write_bytes(skill.read_bytes())
    _write_json(state_path, {"existed": existed, "target": str(skill.relative_to(root))})
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_bytes(source.read_bytes())
    return skill


def restore_managed_skill(root: Path) -> Path:
    """Restore the fixture skill saved by :func:`seed_managed_skill`."""

    root = assert_owned_fixture_root(root)
    state_path = _safe_mutation_path(root, root / "backups" / "managed-skill-state.json")
    backup_path = _safe_mutation_path(root, root / "backups" / "managed-skill-before.bin")
    if not state_path.is_file():
        raise RuntimeError("no active managed skill backup to restore")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    skill = _resolved(root / str(state.get("target", "")))
    if not _is_within(skill, root):
        raise RuntimeError(f"backup target escapes fixture root: {skill}")
    if state.get("existed") is True:
        if not backup_path.is_file():
            raise RuntimeError("managed skill backup bytes are missing; refusing a lossy restore")
        skill.parent.mkdir(parents=True, exist_ok=True)
        skill.write_bytes(backup_path.read_bytes())
    else:
        skill.unlink(missing_ok=True)
    state_path.unlink()
    backup_path.unlink(missing_ok=True)
    return skill


def claude_environment(root: Path, base: dict[str, str] | None = None) -> dict[str, str]:
    """Isolate every home-scoped Claude path; OS-keychain auth remains available."""

    root = assert_owned_fixture_root(root)
    env = _minimal_environment(base)
    fixture_home = str(root / "home")
    env["HOME"] = fixture_home
    env["USERPROFILE"] = fixture_home
    env["CLAUDE_CONFIG_DIR"] = str(root / "home" / ".claude")
    return env


def server_environment(root: Path, startup_mode: str, base: dict[str, str] | None = None) -> dict[str, str]:
    """Point Tandem's homedir and app data at the fixture for refresh proof."""

    root = assert_owned_fixture_root(root)
    if startup_mode not in MANAGED_MODES:
        raise RuntimeError(f"unsupported managed startup mode: {startup_mode}")
    env = _minimal_environment(base)
    fixture_home = str(root / "home")
    env.update(
        {
            "HOME": fixture_home,
            "USERPROFILE": fixture_home,
            "TANDEM_APP_DATA_DIR": str(root / "server-data" / startup_mode),
            "TANDEM_DATA_DIR": str(root / "workspace"),
            "TANDEM_NO_SAMPLE": "1",
            "TANDEM_AUTH_TOKEN": _fixture_auth_token(root),
        }
    )
    env.pop("TANDEM_DISABLE_LAUNCHER", None)
    env.pop("TANDEM_DEFER_LAUNCHER", None)
    env.pop("TANDEM_TAURI_SIDECAR", None)
    if startup_mode == "launcher-disabled":
        env["TANDEM_DISABLE_LAUNCHER"] = "1"
    elif startup_mode == "deferred-autostart":
        env["TANDEM_DEFER_LAUNCHER"] = "1"
        env["TANDEM_TAURI_SIDECAR"] = "1"
    return env


def _fixture_auth_token(root: Path) -> str:
    root = assert_owned_fixture_root(root)
    token = (root / "backups" / AUTH_TOKEN_FILE).read_text(encoding="utf-8").strip()
    if len(token) < 32 or re.fullmatch(r"[A-Za-z0-9_-]+", token) is None:
        raise RuntimeError("fixture auth token is absent or invalid")
    return token


def _attestation_payload(row: dict[str, Any]) -> bytes:
    payload = {key: value for key, value in row.items() if key != ATTESTATION_FIELD}
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sign_evidence_row(row: dict[str, Any], key: bytes) -> str:
    """Bind every evidence field to a harness-owned capture attestation."""

    return hmac.new(key, _attestation_payload(row), hashlib.sha256).hexdigest()


def verify_evidence_row(row: dict[str, Any], key: bytes | None) -> bool:
    signature = row.get(ATTESTATION_FIELD)
    if key is None or not isinstance(signature, str):
        return False
    return hmac.compare_digest(signature, sign_evidence_row(row, key))


def _load_attestation_key(root: Path) -> bytes:
    root = assert_owned_fixture_root(root)
    key = (root / "backups" / ATTESTATION_KEY_FILE).read_bytes()
    if len(key) != 32:
        raise RuntimeError("invalid capture attestation key")
    return key


def ingest_capture(root: Path, manifest_path: Path) -> dict[str, Any]:
    """Verify a machine capture bundle, then bind it into ``evidence.json``.

    This is deliberately a diagnostic adapter, not a trusted Claude runner. It
    accepts only a versioned manifest whose raw artifacts live inside the owned
    fixture, and the resulting row is never eligible for a release PASS.
    """

    root = assert_owned_fixture_root(root)
    manifest_path = _resolved(manifest_path)
    if not _is_within(manifest_path, root / "artifacts"):
        raise RuntimeError("capture manifest must be inside the fixture artifacts directory")
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    if manifest.get("schema_version") != CAPTURE_SCHEMA_VERSION:
        raise RuntimeError("unsupported capture manifest schema")
    if manifest.get("producer") != CAPTURE_PRODUCER:
        raise RuntimeError("capture manifest was not produced by the ConPTY adapter")
    trial_id = manifest.get("trial_id")
    expected = {trial["id"]: trial for trial in build_trial_matrix()}
    if not isinstance(trial_id, str) or trial_id not in expected:
        raise RuntimeError(f"unknown capture trial id {trial_id!r}")
    trial_artifact_root = root / "artifacts" / trial_id
    if not _is_within(manifest_path, trial_artifact_root):
        raise RuntimeError("capture manifest is not inside its trial artifact directory")

    observations = manifest.get("observations")
    if not isinstance(observations, dict):
        raise RuntimeError("capture manifest observations must be an object")
    protected = {
        "id",
        "install_shape",
        "startup_mode",
        "prompt_kind",
        "requires_refresh",
        ATTESTATION_FIELD,
        "capture_manifest_sha256",
        "artifacts",
        CAPTURE_ELIGIBILITY_FIELD,
    }
    machine_derived = set(PRECONDITION_FIELDS + CHAIN_FIELDS) | {
        "refreshed_before_ready",
        "seeded_skill_sha256",
        "candidate_skill_sha256",
        "ready_skill_sha256",
        "ready_skill_observed_at",
        "server_ready_at",
        "decoy_subscriber_attached",
        "decoy_subscriber_id",
        "decoy_attached_at",
        "status_observed_at",
        "claude_process_tree_teardown_verified",
        "silent_monitor_teardown_verified",
    }
    forbidden = set(observations) & machine_derived
    if forbidden:
        raise RuntimeError(
            "machine-derived observations cannot be supplied by hand: "
            + ", ".join(sorted(forbidden))
        )
    template = _empty_evidence(expected[trial_id])
    unknown = set(observations) - (set(template) - protected)
    if unknown:
        raise RuntimeError("capture manifest has unknown observations: " + ", ".join(sorted(unknown)))

    raw_artifacts = manifest.get("artifacts")
    if not isinstance(raw_artifacts, list):
        raise RuntimeError("capture manifest artifacts must be an array")
    normalized_artifacts: list[dict[str, str]] = []
    artifact_bytes_by_role: dict[str, bytes] = {}
    roles: set[str] = set()
    for artifact in raw_artifacts:
        if not isinstance(artifact, dict):
            raise RuntimeError("capture artifact entries must be objects")
        role = artifact.get("role")
        relative = artifact.get("path")
        claimed_hash = artifact.get("sha256")
        if not isinstance(role, str) or role in roles or role not in CAPTURE_ARTIFACT_ROLES:
            raise RuntimeError(f"invalid or duplicate capture artifact role {role!r}")
        if not isinstance(relative, str) or not relative:
            raise RuntimeError(f"capture artifact {role} has no path")
        artifact_path = _resolved(root / relative)
        if not _is_within(artifact_path, trial_artifact_root):
            raise RuntimeError(f"capture artifact {role} escapes its trial directory")
        artifact_bytes = artifact_path.read_bytes()
        actual_hash = _sha256(artifact_bytes)
        if not isinstance(claimed_hash, str) or not hmac.compare_digest(actual_hash, claimed_hash):
            raise RuntimeError(f"capture artifact hash mismatch for {role}")
        roles.add(role)
        artifact_bytes_by_role[role] = artifact_bytes
        normalized_artifacts.append(
            {
                "role": role,
                "path": artifact_path.relative_to(root).as_posix(),
                "sha256": actual_hash,
            }
        )
    if roles != CAPTURE_ARTIFACT_ROLES:
        missing = sorted(CAPTURE_ARTIFACT_ROLES - roles)
        raise RuntimeError("capture manifest is missing artifacts: " + ", ".join(missing))
    if len(artifact_bytes_by_role["pty_capture"]) < 200:
        raise RuntimeError("PTY capture is too small to establish a healthy interactive session")

    row = {**template, **observations}
    try:
        trace = json.loads(artifact_bytes_by_role["observation_trace"].decode("utf-8"))
        decoy = json.loads(artifact_bytes_by_role["decoy_log"].decode("utf-8"))
        process_tree = json.loads(artifact_bytes_by_role["process_tree"].decode("utf-8"))
        server_log = json.loads(artifact_bytes_by_role["server_log"].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"machine capture artifact is not valid JSON: {exc}") from exc

    traced_observations = trace.get("observations") if isinstance(trace, dict) else None
    if (
        not isinstance(trace, dict)
        or trace.get("schema_version") != CAPTURE_SCHEMA_VERSION
        or trace.get("trial_id") != trial_id
        or not isinstance(traced_observations, dict)
        or set(traced_observations) != set(PRECONDITION_FIELDS + CHAIN_FIELDS)
        or any(value not in (True, False) for value in traced_observations.values())
    ):
        raise RuntimeError("observation trace is incomplete or belongs to another trial")
    row.update(traced_observations)

    if not isinstance(decoy, dict):
        raise RuntimeError("decoy log must be an object")
    row.update(
        {
            "decoy_subscriber_attached": decoy.get("attached"),
            "decoy_subscriber_id": decoy.get("subscriber_id"),
            "decoy_attached_at": decoy.get("attached_at"),
            "status_observed_at": decoy.get("status_observed_at"),
        }
    )

    if not isinstance(process_tree, dict) or process_tree.get("remaining_pids") != []:
        raise RuntimeError("process-tree artifact does not prove a clean teardown")
    row.update(
        {
            "claude_process_tree_teardown_verified": process_tree.get(
                "claude_process_tree_teardown_verified"
            ),
            "silent_monitor_teardown_verified": process_tree.get(
                "silent_monitor_teardown_verified"
            ),
        }
    )

    if not isinstance(server_log, dict):
        raise RuntimeError("server log must be an object")
    for field in (
        "refreshed_before_ready",
        "seeded_skill_sha256",
        "candidate_skill_sha256",
        "ready_skill_sha256",
        "ready_skill_observed_at",
        "server_ready_at",
        "observed_launcher_mode",
    ):
        if field in server_log:
            row[field] = server_log[field]
    row["artifacts"] = sorted(normalized_artifacts, key=lambda item: item["role"])
    manifest_hash = _sha256(manifest_bytes)
    row["capture_manifest_sha256"] = manifest_hash
    # Importing a manifest cannot earn release eligibility -- this adapter is not a
    # trusted Claude runner, so a hand-supplied bundle stays diagnostic. But `capture`
    # writes its own direct-live row for a trial it drove itself, and stamping
    # unconditionally here DOWNGRADED that row: following the sequence the tool
    # prints ("Next: ... ingest-capture") destroyed the very eligibility the live run
    # had just earned, turning four passing trials into an INCONCLUSIVE verdict.
    #
    # Preserve direct-live only when this exact manifest is the one that row was
    # built from. Both conditions are load-bearing: without the hash match, swapping
    # a different bundle in would inherit an eligibility it never earned.
    prior = next(
        (
            entry
            for entry in json.loads(
                _safe_mutation_path(root, root / "evidence.json").read_text(encoding="utf-8")
            )
            if entry.get("id") == trial_id
        ),
        None,
    )
    inherits_direct_live = (
        isinstance(prior, dict)
        and prior.get(CAPTURE_ELIGIBILITY_FIELD) == DIRECT_LIVE_CAPTURE
        and prior.get("capture_manifest_sha256") == manifest_hash
    )
    row[CAPTURE_ELIGIBILITY_FIELD] = (
        DIRECT_LIVE_CAPTURE if inherits_direct_live else DIAGNOSTIC_IMPORT
    )
    row[ATTESTATION_FIELD] = sign_evidence_row(row, _load_attestation_key(root))
    _replace_evidence_row(root, row)
    return row


def evaluate_gate(
    evidence: Iterable[dict[str, Any]],
    attestation_key: bytes | None = None,
    expected_hashes: dict[str, str] | None = None,
) -> dict[str, Any]:
    rows = list(evidence)
    expected = {trial["id"]: trial for trial in build_trial_matrix()}
    by_id: dict[str, dict[str, Any]] = {}
    schema_reasons: list[str] = []
    for row in rows:
        trial_id = row.get("id")
        if not isinstance(trial_id, str) or trial_id not in expected:
            schema_reasons.append(f"unknown trial id {trial_id!r}")
            continue
        if trial_id in by_id:
            schema_reasons.append(f"duplicate trial id {trial_id}")
            continue
        for key in ("install_shape", "startup_mode", "prompt_kind", "requires_refresh"):
            if row.get(key) != expected[trial_id][key]:
                schema_reasons.append(f"{trial_id}: matrix field {key} was changed")
        by_id[trial_id] = row
    missing = sorted(set(expected) - set(by_id))
    if missing:
        schema_reasons.append("missing trials: " + ", ".join(missing))

    shape_results = {
        "managed_double": _evaluate_shape(
            [by_id[t["id"]] for t in expected.values() if t["id"] in by_id and t["install_shape"] == MANAGED_SHAPE],
            MANAGED_SHAPE,
            attestation_key,
            expected_hashes,
        ),
        "plugin_only": _evaluate_shape(
            [by_id[t["id"]] for t in expected.values() if t["id"] in by_id and t["install_shape"] == PLUGIN_SHAPE],
            PLUGIN_SHAPE,
            attestation_key,
            expected_hashes,
        ),
    }
    reasons = schema_reasons + shape_results["managed_double"]["reasons"] + shape_results["plugin_only"]["reasons"]
    if "FAIL" in (
        shape_results["managed_double"]["verdict"],
        shape_results["plugin_only"]["verdict"],
    ):
        verdict = "FAIL"
    elif schema_reasons or "INCONCLUSIVE" in (
        shape_results["managed_double"]["verdict"],
        shape_results["plugin_only"]["verdict"],
    ):
        verdict = "INCONCLUSIVE"
    else:
        verdict = "PASS"
    return {"verdict": verdict, **shape_results, "reasons": reasons}


def _evaluate_shape(
    rows: list[dict[str, Any]],
    shape: str,
    attestation_key: bytes | None,
    expected_hashes: dict[str, str] | None,
) -> dict[str, Any]:
    reasons: list[str] = []
    hard_failures: list[str] = []
    inconclusive: list[str] = []
    if not rows:
        return {"verdict": "INCONCLUSIVE", "reasons": [f"{shape}: no evidence"]}

    for row in rows:
        trial_id = row["id"]
        if not verify_evidence_row(row, attestation_key):
            inconclusive.append(f"{trial_id}: valid machine capture attestation is absent")
            continue
        if row.get(CAPTURE_ELIGIBILITY_FIELD) != DIRECT_LIVE_CAPTURE:
            inconclusive.append(f"{trial_id}: release evidence requires direct live capture")
        expected_launcher_mode = (
            row["startup_mode"] if shape == MANAGED_SHAPE else "launcher-disabled"
        )
        if row.get("observed_launcher_mode") != expected_launcher_mode:
            inconclusive.append(
                f"{trial_id}: authoritative launcher mode was not observed as {expected_launcher_mode}"
            )
        decoy_id = row.get("decoy_subscriber_id")
        decoy_at = row.get("decoy_attached_at")
        status_at = row.get("status_observed_at")
        if (
            row.get("decoy_subscriber_attached") is not True
            or not isinstance(decoy_id, str)
            or not decoy_id.strip()
            or not isinstance(decoy_at, (int, float))
            or not isinstance(status_at, (int, float))
            or decoy_at > status_at
        ):
            inconclusive.append(f"{trial_id}: pre-status decoy subscriber proof is absent")
        if (
            row.get("claude_process_tree_teardown_verified") is not True
            or row.get("silent_monitor_teardown_verified") is not True
        ):
            inconclusive.append(f"{trial_id}: process-tree teardown proof is absent")
        artifacts = row.get("artifacts")
        artifact_roles: set[str] = set()
        artifacts_valid = isinstance(artifacts, list)
        if isinstance(artifacts, list):
            for artifact in artifacts:
                if not isinstance(artifact, dict):
                    artifacts_valid = False
                    continue
                role = artifact.get("role")
                artifact_path = artifact.get("path")
                artifact_hash = artifact.get("sha256")
                if (
                    not isinstance(role, str)
                    or role in artifact_roles
                    or not isinstance(artifact_path, str)
                    or not artifact_path
                    or not isinstance(artifact_hash, str)
                    or SHA256_RE.fullmatch(artifact_hash) is None
                ):
                    artifacts_valid = False
                    continue
                artifact_roles.add(role)
        if (
            not artifacts_valid
            or artifact_roles != CAPTURE_ARTIFACT_ROLES
            or not isinstance(row.get("capture_manifest_sha256"), str)
            or SHA256_RE.fullmatch(row["capture_manifest_sha256"]) is None
        ):
            inconclusive.append(f"{trial_id}: required hashed capture artifacts are absent")
        refresh = row.get("refreshed_before_ready")
        if shape == PLUGIN_SHAPE and refresh is not None:
            inconclusive.append(f"{trial_id}: plugin-only evidence must not claim PR2 refresh")
        if shape == PLUGIN_SHAPE:
            expected_plugin = expected_hashes.get("plugin_candidate") if expected_hashes else None
            if (
                row.get("candidate_skill_sha256") != expected_plugin
                or row.get("ready_skill_sha256") != expected_plugin
            ):
                inconclusive.append(
                    f"{trial_id}: plugin candidate artifact proof is absent or inconsistent"
                )
        if shape == MANAGED_SHAPE:
            if refresh is False:
                hard_failures.append(f"{trial_id}: v9 was not refreshed before ready")
            elif refresh is not True:
                inconclusive.append(f"{trial_id}: managed refresh proof is absent")
            expected_v9 = expected_hashes.get("v9") if expected_hashes else None
            expected_candidate = expected_hashes.get("candidate") if expected_hashes else None
            ready_at = row.get("ready_skill_observed_at")
            server_ready_at = row.get("server_ready_at")
            if (
                row.get("seeded_skill_sha256") != expected_v9
                or row.get("candidate_skill_sha256") != expected_candidate
                or row.get("ready_skill_sha256") != expected_candidate
                or not isinstance(ready_at, (int, float))
                or not isinstance(server_ready_at, (int, float))
                or ready_at > server_ready_at
            ):
                inconclusive.append(
                    f"{trial_id}: managed refresh artifact proof is absent or inconsistent"
                )

        missing_precondition = [field for field in PRECONDITION_FIELDS if row.get(field) is not True]
        if missing_precondition:
            inconclusive.append(
                f"{trial_id}: host control preconditions not established ({', '.join(missing_precondition)})"
            )
            continue
        chain = {field: row.get(field) for field in CHAIN_FIELDS}
        if any(value not in (True, False) for value in chain.values()):
            inconclusive.append(f"{trial_id}: chain observations are incomplete")
            continue
        if row["prompt_kind"] == "control":
            # A control dispatches via `/tandem`, which emits no `Skill` tool event, so
            # its only dispatch signal is the marker -- and the marker requires the
            # plugin's on-skill-invoke trigger to have fired AND its process to have
            # spawned. Without this branch, "the skill ran and instructed a Monitor call
            # but the trigger broke" is indistinguishable from "the harness never sent
            # /tandem at all", and both land in the generic bucket below. A `Monitor`
            # call carrying the wake URL is only ever made on the skill's instruction,
            # so it is independent proof the dispatch happened.
            if chain["monitor_attempted"] and not chain["skill_dispatched"]:
                hard_failures.append(
                    f"{trial_id}: control armed a monitor without an observed dispatch signal"
                )
            elif not all(chain.values()):
                inconclusive.append(f"{trial_id}: explicit /tandem control did not complete the chain")
            continue
        if chain["skill_dispatched"] and not all(chain.values()):
            hard_failures.append(f"{trial_id}: natural run declined or failed after dispatch")
        elif not chain["skill_dispatched"] and any(
            # Ranges over DISPATCH_CONSEQUENT_FIELDS, not all of CHAIN_FIELDS: a
            # declining model still calls `tandem_status`, whose response carries a
            # wakeUrl whenever a wake transport is running (so: in every trial here), so
            # `status_succeeded` is true on an honest decline and would make every one of
            # them look self-contradictory here.
            chain[field]
            for field in DISPATCH_CONSEQUENT_FIELDS
        ):
            inconclusive.append(f"{trial_id}: later chain evidence exists without observed dispatch")
        elif not chain["skill_dispatched"] and not chain["status_succeeded"]:
            # A decline is only evidence about the model if the model actually reached
            # Tandem. `status_succeeded` means a read-mode `tandem_status` returned a
            # wakeUrl (present whenever a wake transport is running, as it is in every
            # trial here), so the session had everything it needed and still did not arm --
            # attributable, and exactly the measurement. Without it the session never got
            # a usable status response, so its negative says nothing about arming and
            # must not be counted as a model choice. (Broken installs and failed
            # refreshes are already caught above by the skill-hash proofs; this covers
            # the remaining case, a session that reached the tool and got nothing back.)
            inconclusive.append(
                f"{trial_id}: decline is not attributable -- no successful tandem_status in this session"
            )

    controls = [row for row in rows if row["prompt_kind"] == "control"]
    naturals = [row for row in rows if row["prompt_kind"] == "natural"]
    if not controls:
        inconclusive.append(f"{shape}: explicit control is absent")
    if len(naturals) != 3:
        inconclusive.append(f"{shape}: expected exactly three natural sessions, found {len(naturals)}")
    natural_successes = sum(
        1
        for row in naturals
        if all(row.get(field) is True for field in PRECONDITION_FIELDS + CHAIN_FIELDS)
    )
    observed_dispatches = sum(1 for row in naturals if row.get("skill_dispatched") is True)
    controls_pass = bool(controls) and all(
        all(row.get(field) is True for field in PRECONDITION_FIELDS + CHAIN_FIELDS)
        for row in controls
    )
    if controls_pass and observed_dispatches == 0:
        hard_failures.append(f"{shape}: zero natural dispatches across bounded n=3 sample")
    elif controls_pass and natural_successes == 0 and observed_dispatches > 0:
        hard_failures.append(f"{shape}: no natural dispatch completed the whole chain")

    reasons.extend(hard_failures)
    reasons.extend(inconclusive)
    if hard_failures:
        verdict = "FAIL"
    elif inconclusive:
        verdict = "INCONCLUSIVE"
    elif natural_successes >= 1 and controls_pass:
        verdict = "PASS"
    else:
        verdict = "INCONCLUSIVE"
        reasons.append(f"{shape}: acceptance conditions are not fully observed")
    return {
        "verdict": verdict,
        "natural_successes": natural_successes,
        "natural_sample_size": len(naturals),
        "controls_pass": controls_pass,
        "reasons": reasons,
        # Named harness-side failures, reported beside the verdict but never an input to
        # it. A rig failure makes a row's observations false, so it already shows up as a
        # missing chain link; what it could not do before was say WHY, which is the
        # difference between "the model never polled" and "our injector never ran".
        "rig_failures": [
            f"{row['id']}: {note}" for row in rows if (note := rig_note_of(row)) is not None
        ],
    }


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8", newline="")


def _command_prepare(args: argparse.Namespace) -> int:
    root = prepare_fixture_root(Path(args.root), Path(args.repo))
    print(f"Prepared isolated fixture: {root}")
    print(f"Matrix: {root / 'matrix.json'}")
    print(f"Evidence template: {root / 'evidence.json'}")
    return 0


def _command_evaluate(args: argparse.Namespace) -> int:
    root = assert_owned_fixture_root(Path(args.root))
    hashes_path = root / "fixtures" / "skill-hashes.json"
    if not hashes_path.is_file():
        raise RuntimeError("missing skill-hashes.json; run prepare with --repo first")
    expected_hashes = json.loads(hashes_path.read_text(encoding="utf-8"))
    result = evaluate_gate(
        json.loads((root / "evidence.json").read_text(encoding="utf-8")),
        _load_attestation_key(root),
        expected_hashes,
    )
    if result["verdict"] == "PASS" and not LIVE_CAPTURE_PRODUCER_AVAILABLE:
        result["verdict"] = "INCONCLUSIVE"
        result["reasons"].append(LIVE_CAPTURE_PRODUCER_BLOCKER)
    print(json.dumps(result, indent=2))
    return {"PASS": 0, "FAIL": 1, "INCONCLUSIVE": 2}[result["verdict"]]


def _command_ingest_capture(args: argparse.Namespace) -> int:
    row = ingest_capture(Path(args.root), Path(args.manifest))
    print(f"Ingested and attested machine capture for {row['id']}")
    if not LIVE_CAPTURE_PRODUCER_AVAILABLE:
        print(LIVE_CAPTURE_PRODUCER_BLOCKER)
    return 0


def _command_capture(args: argparse.Namespace) -> int:
    manifest = produce_trial(
        Path(args.root),
        Path(args.repo),
        args.trial,
        timeout_seconds=args.timeout_seconds,
        overwrite=args.overwrite,
    )
    print(f"Machine capture manifest: {manifest}")
    print(
        "Next: uv run python scripts/spikes/session_monitor_acceptance.py "
        f'ingest-capture --root "{args.root}" --manifest "{manifest}"'
    )
    return 0


def _command_fixture_login(args: argparse.Namespace) -> int:
    """Run Claude's supported login flow against only the isolated fixture config."""

    root = assert_owned_fixture_root(Path(args.root))
    claude = shutil.which(os.environ.get("TANDEM_ACCEPTANCE_CLAUDE", "claude"))
    if claude is None:
        raise RuntimeError("claude executable is required")
    completed = subprocess.run(
        [claude, "auth", "login"],
        cwd=root / "workspace",
        env=claude_environment(root),
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("fixture Claude login did not complete")
    print("Fixture authentication completed; capture will verify it before starting Tandem.")
    return 0


def _command_runbook(args: argparse.Namespace) -> int:
    script = Path(__file__).resolve()
    manifest = Path(args.root) / "artifacts" / args.trial / "capture-manifest.json"
    print(f"$Repo = '{Path(args.repo).resolve()}'")
    print(f"$Fixture = '{Path(args.root).resolve()}'")
    print(
        f'uv run python "{script}" prepare --root "$Fixture" --repo "$Repo"'
    )
    print(r"# Structured evidence hooks: $Fixture\home\.claude\settings.json")
    print(f'uv run python "{script}" fixture-login --root "$Fixture"')
    print(
        f'uv run --with pywinpty python "{script}" capture --root "$Fixture" '
        f'--repo "$Repo" --trial "{args.trial}" --timeout-seconds {args.timeout_seconds}'
        f'{" --overwrite" if args.overwrite else ""}'
    )
    print(
        f'uv run python "{script}" ingest-capture --root "$Fixture" '
        f'--manifest "{manifest}"'
    )
    print(f'uv run python "{script}" evaluate --root "$Fixture"')
    return 0


def _command_print_env(args: argparse.Namespace) -> int:
    root = assert_owned_fixture_root(Path(args.root))
    if args.target == "claude":
        env = claude_environment(root, {})
    else:
        env = server_environment(root, args.startup_mode, {})
    print(json.dumps(env, indent=2))
    return 0


def _command_seed_managed(args: argparse.Namespace) -> int:
    skill = seed_managed_skill(Path(args.root))
    print(f"Seeded immutable v9 at fixture path: {skill}")
    print("Run restore-managed after the startup-mode evidence is captured.")
    return 0


def _command_restore_managed(args: argparse.Namespace) -> int:
    skill = restore_managed_skill(Path(args.root))
    print(f"Restored fixture skill state: {skill}")
    return 0


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog=None if LIVE_CAPTURE_PRODUCER_AVAILABLE else LIVE_CAPTURE_PRODUCER_BLOCKER,
    )
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare", help="create isolated fixtures and the ten-trial matrix")
    prepare.add_argument("--root", required=True)
    prepare.add_argument("--repo", default=str(Path(__file__).resolve().parents[2]))
    prepare.set_defaults(handler=_command_prepare)
    fixture_login = sub.add_parser(
        "fixture-login",
        help="authenticate Claude through its supported login flow inside the isolated fixture",
    )
    fixture_login.add_argument("--root", required=True)
    fixture_login.set_defaults(handler=_command_fixture_login)
    evaluate = sub.add_parser("evaluate", help="evaluate a completed evidence.json")
    evaluate.add_argument("--root", required=True)
    evaluate.set_defaults(handler=_command_evaluate)
    ingest = sub.add_parser(
        "ingest-capture",
        help="verify and attest one ConPTY capture manifest into evidence.json",
    )
    ingest.add_argument("--root", required=True)
    ingest.add_argument("--manifest", required=True)
    ingest.set_defaults(handler=_command_ingest_capture)
    capture = sub.add_parser(
        "capture",
        help="run one bounded authenticated ConPTY trial and emit its machine artifacts",
    )
    capture.add_argument("--root", required=True)
    capture.add_argument("--repo", default=str(Path(__file__).resolve().parents[2]))
    capture.add_argument("--trial", choices=tuple(trial["id"] for trial in build_trial_matrix()), required=True)
    capture.add_argument("--timeout-seconds", type=int, default=900)
    capture.add_argument(
        "--overwrite",
        action="store_true",
        help="re-attempt a trial, moving its prior capture to artifacts/<trial>.superseded-<n>",
    )
    capture.set_defaults(handler=_command_capture)
    runbook = sub.add_parser("runbook", help="print the exact PowerShell commands for one trial")
    runbook.add_argument("--root", required=True)
    runbook.add_argument("--repo", default=str(Path(__file__).resolve().parents[2]))
    runbook.add_argument("--trial", choices=tuple(trial["id"] for trial in build_trial_matrix()), required=True)
    runbook.add_argument("--timeout-seconds", type=int, default=900)
    runbook.add_argument(
        "--overwrite",
        action="store_true",
        help="print the capture step as a re-attempt that supersedes a prior capture",
    )
    runbook.set_defaults(handler=_command_runbook)
    env = sub.add_parser("print-env", help="print the isolated environment for a live run")
    env.add_argument("--root", required=True)
    env.add_argument("--target", choices=("claude", "server"), required=True)
    env.add_argument("--startup-mode", choices=MANAGED_MODES, default="launcher-disabled")
    env.set_defaults(handler=_command_print_env)
    seed = sub.add_parser("seed-managed", help="backup the fixture skill and seed immutable v9")
    seed.add_argument("--root", required=True)
    seed.set_defaults(handler=_command_seed_managed)
    restore = sub.add_parser("restore-managed", help="restore the fixture skill after a seeded run")
    restore.add_argument("--root", required=True)
    restore.set_defaults(handler=_command_restore_managed)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    try:
        return args.handler(args)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
