import ast
import importlib.util
import hashlib
import inspect
import json
import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("session_monitor_acceptance.py")
TEST_ATTESTATION_KEY = b"test-only-attestation-key-32-byte"
TEST_SKILL_HASHES = {
    "v9": "a" * 64,
    "candidate": "b" * 64,
    "plugin_candidate": "9" * 64,
}


def load_subject():
    spec = importlib.util.spec_from_file_location("session_monitor_acceptance", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AcceptanceMatrixTests(unittest.TestCase):
    def test_transcript_parser_requires_dispatch_marker_monitor_args_and_post_event_inbox(self):
        subject = load_subject()
        event_text = "acceptance-event-123"
        transcript = (
            "Claude Code ready in trusted workspace\n"
            "tool: tandem_status {}\n"
            "result: {wakeUrl: ws://127.0.0.1:43079/api/wake}\n"
            "tool: Monitor {ws: {url: ws://127.0.0.1:43079/api/wake}, persistent: true}\n"
            + ("working safely\n" * 20)
            + f"wake turn\nmessage: {event_text}\ntool: tandem_checkInbox\n"
        )

        display = subject.parse_trial_transcript(
            transcript,
            dispatch_marker_seen=True,
            event_text=event_text,
        )
        events = [
            {"harness_at": 1, "hook_event_name": "UserPromptSubmit", "prompt": "neutral"},
            {"harness_at": 2, "hook_event_name": "PostToolUse", "tool_name": "mcp__tandem__tandem_status", "tool_response": {"wakeUrl": "ws://127.0.0.1:43079/api/wake"}},
            {"harness_at": 3, "hook_event_name": "PreToolUse", "tool_name": "Monitor", "tool_input": {"ws": {"url": "ws://127.0.0.1:43079/api/wake"}, "persistent": True}},
            {"harness_at": 4, "hook_event_name": "Stop"},
            {"harness_at": 6, "hook_event_name": "PostToolUse", "tool_name": "mcp__tandem__tandem_checkInbox", "tool_response": {"text": event_text}},
        ]
        observed = subject.derive_structured_observations(
            events,
            dispatch_marker_seen=True,
            event_text=event_text,
            injected_at=5,
            transcript_health={field: display[field] for field in subject.PRECONDITION_FIELDS[:3]},
            decoy_count=1,
            armed_count=2,
        )
        self.assertTrue(all(observed.values()))
        without_marker = subject.parse_trial_transcript(
            transcript,
            dispatch_marker_seen=False,
            event_text=event_text,
        )
        self.assertFalse(without_marker["skill_dispatched"])

    def test_transcript_parser_does_not_treat_prose_as_tool_evidence(self):
        subject = load_subject()
        event_text = "acceptance-event-123"
        transcript = (
            "Claude Code ready in trusted workspace\n"
            "I will call tandem_status, then Monitor with persistent: true using "
            "ws://127.0.0.1:43079/api/wake.\n"
            "I should use tandem_checkInbox when an event arrives.\n"
            f"message: {event_text}\n"
        )

        observed = subject.parse_trial_transcript(
            transcript,
            dispatch_marker_seen=True,
            event_text=event_text,
        )

        self.assertFalse(observed["status_succeeded"])
        self.assertFalse(observed["monitor_attempted"])
        self.assertFalse(observed["monitor_persistent"])
        self.assertFalse(observed["inbox_checked"])
    def test_unsigned_observations_cannot_claim_live_host_coverage(self):
        subject = load_subject()

        result = subject.evaluate_gate(passing_evidence(subject), TEST_ATTESTATION_KEY)

        self.assertEqual(result["verdict"], "INCONCLUSIVE")
        self.assertIn("machine capture attestation", " ".join(result["reasons"]))

    def test_signed_capture_without_pre_status_decoy_is_inconclusive(self):
        subject = load_subject()
        evidence = passing_evidence(subject, with_decoy=False)

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "INCONCLUSIVE")
        self.assertIn("decoy subscriber", " ".join(result["reasons"]))

    def test_managed_refresh_requires_hash_and_ready_ordering_proof(self):
        subject = load_subject()
        evidence = passing_evidence(subject, with_refresh_proof=False)

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "INCONCLUSIVE")
        self.assertIn("managed refresh artifact proof", " ".join(result["reasons"]))

    def test_plugin_only_requires_the_instrumented_candidate_hash(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        for item in evidence:
            if item["install_shape"] == "plugin-only":
                item["candidate_skill_sha256"] = None
                item["ready_skill_sha256"] = None

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "INCONCLUSIVE")
        self.assertIn("plugin candidate artifact proof", " ".join(result["reasons"]))

    def test_capture_must_verify_claude_and_silent_monitor_teardown(self):
        subject = load_subject()
        evidence = passing_evidence(subject, with_teardown=False)

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "INCONCLUSIVE")
        self.assertIn("process-tree teardown", " ".join(result["reasons"]))

    def test_capture_requires_hashed_machine_artifacts(self):
        subject = load_subject()
        evidence = passing_evidence(subject, with_artifacts=False)

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "INCONCLUSIVE")
        self.assertIn("hashed capture artifacts", " ".join(result["reasons"]))

    def test_matrix_splits_managed_refresh_from_plugin_only_behavior(self):
        subject = load_subject()

        matrix = subject.build_trial_matrix()

        managed = [trial for trial in matrix if trial["install_shape"] == "managed-double"]
        plugin = [trial for trial in matrix if trial["install_shape"] == "plugin-only"]
        self.assertEqual(len(matrix), 10)
        self.assertEqual(
            {
                (trial["startup_mode"], trial["prompt_kind"])
                for trial in managed
            },
            {
                ("normal", "natural"),
                ("normal", "control"),
                ("launcher-disabled", "natural"),
                ("launcher-disabled", "control"),
                ("deferred-autostart", "natural"),
                ("deferred-autostart", "control"),
            },
        )
        self.assertEqual(
            [trial["prompt_kind"] for trial in plugin].count("natural"),
            3,
        )
        self.assertEqual(
            [trial["prompt_kind"] for trial in plugin].count("control"),
            1,
        )
        self.assertTrue(all(trial["requires_refresh"] for trial in managed))
        self.assertTrue(all(not trial["requires_refresh"] for trial in plugin))

    def test_plugin_only_evidence_cannot_claim_a_refresh(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        plugin = next(item for item in evidence if item["install_shape"] == "plugin-only")
        plugin["refreshed_before_ready"] = True

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "INCONCLUSIVE")
        self.assertIn("must not claim PR2 refresh", " ".join(result["reasons"]))

    def test_gate_passes_with_controls_and_one_natural_success_per_shape(self):
        subject = load_subject()

        result = evaluate(subject, passing_evidence(subject))

        self.assertEqual(result["verdict"], "PASS")
        self.assertEqual(result["managed_double"]["verdict"], "PASS")
        self.assertEqual(result["plugin_only"]["verdict"], "PASS")

    def test_zero_natural_dispatches_with_passing_controls_is_a_product_failure(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        for item in evidence:
            if item["prompt_kind"] == "natural":
                for key in subject.CHAIN_FIELDS:
                    item[key] = False

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("zero natural dispatches", " ".join(result["reasons"]))

    def test_failed_control_makes_the_shape_inconclusive(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        control = next(
            item
            for item in evidence
            if item["install_shape"] == "plugin-only" and item["prompt_kind"] == "control"
        )
        control["capture_healthy"] = False

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "INCONCLUSIVE")
        self.assertEqual(result["plugin_only"]["verdict"], "INCONCLUSIVE")

    def test_dispatched_natural_prompt_that_declines_to_arm_is_a_failure(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        natural = next(
            item
            for item in evidence
            if item["install_shape"] == "managed-double"
            and item["prompt_kind"] == "natural"
        )
        natural["monitor_attempted"] = False
        natural["monitor_persistent"] = False
        natural["wake_seen"] = False
        natural["inbox_checked"] = False

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("declined or failed after dispatch", " ".join(result["reasons"]))

    def test_observed_hard_failure_outranks_an_incomplete_sibling_trial(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        failed = next(
            item
            for item in evidence
            if item["install_shape"] == "managed-double"
            and item["prompt_kind"] == "natural"
        )
        failed["monitor_attempted"] = False
        incomplete = next(
            item
            for item in evidence
            if item["install_shape"] == "managed-double"
            and item["id"] != failed["id"]
            and item["prompt_kind"] == "natural"
        )
        incomplete["capture_healthy"] = None

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "FAIL")
        self.assertEqual(result["managed_double"]["verdict"], "FAIL")
        self.assertIn("host control preconditions not established", " ".join(result["reasons"]))

    def test_missing_managed_refresh_is_a_failure(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        evidence[0]["refreshed_before_ready"] = False

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("v9 was not refreshed before ready", " ".join(result["reasons"]))


class FixtureSafetyTests(unittest.TestCase):
    def test_one_trial_producer_emits_an_ingestable_machine_bundle_with_a_fake_driver(self):
        subject = load_subject()

        class FakeDriver:
            def __init__(self):
                self.context = None

            def capture(self, context):
                self.context = context
                plugin_hash = json.loads(
                    (context.root / "fixtures" / "skill-hashes.json").read_text(encoding="utf-8")
                )["plugin_candidate"]
                chain = {key: True for key in subject.PRECONDITION_FIELDS + subject.CHAIN_FIELDS}
                return subject.MachineTrialCapture(
                    pty_capture="interactive transcript\n" * 20,
                    observations=chain,
                    decoy_log={
                        "subscriber_id": "decoy-fake",
                        "attached": True,
                        "attached_at": 100,
                        "status_observed_at": 200,
                    },
                    server_log={
                        "refreshed_before_ready": None,
                        "candidate_skill_sha256": plugin_hash,
                        "ready_skill_sha256": plugin_hash,
                    },
                    process_tree={
                        "claude_process_tree_teardown_verified": True,
                        "silent_monitor_teardown_verified": True,
                        "remaining_pids": [],
                    },
                )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = Path(__file__).resolve().parents[2]
            subject.prepare_fixture_root(root, repo)
            driver = FakeDriver()

            manifest_path = subject.produce_trial(
                root,
                repo,
                "plugin-control",
                timeout_seconds=30,
                driver=driver,
            )
            ingested = subject.ingest_capture(root, manifest_path)

            self.assertEqual(ingested["id"], "plugin-control")
            self.assertEqual(driver.context.claude_env["HOME"], str(root / "home"))
            self.assertEqual(
                driver.context.claude_env["CLAUDE_CONFIG_DIR"],
                str(root / "home" / ".claude"),
            )
            self.assertTrue(ingested["wake_seen"])
            self.assertEqual(ingested["capture_eligibility"], "diagnostic-import")

    def test_imported_capture_cannot_be_release_eligible_or_pass(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        for item in evidence:
            item["capture_eligibility"] = "diagnostic-import"
        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "INCONCLUSIVE")
        self.assertIn("direct live capture", " ".join(result["reasons"]))

    def test_direct_capture_writes_release_evidence_from_in_memory_result(self):
        subject = load_subject()

        class FakeConptyDriver:
            def capture(self, context):
                hashes = json.loads(
                    (context.root / "fixtures" / "skill-hashes.json").read_text(encoding="utf-8")
                )
                return subject.MachineTrialCapture(
                    pty_capture="Claude Code ready\n" * 20,
                    observations={key: True for key in subject.OBSERVATION_FIELDS},
                    decoy_log={
                        "subscriber_id": "decoy-direct",
                        "attached": True,
                        "attached_at": 100,
                        "status_observed_at": 200,
                    },
                    server_log={
                        "refreshed_before_ready": None,
                        "candidate_skill_sha256": hashes["plugin_candidate"],
                        "ready_skill_sha256": hashes["plugin_candidate"],
                    },
                    process_tree={
                        "claude_process_tree_teardown_verified": True,
                        "silent_monitor_teardown_verified": True,
                        "remaining_pids": [],
                    },
                )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = Path(__file__).resolve().parents[2]
            subject.prepare_fixture_root(root, repo)
            with patch.object(subject, "ConptyTrialDriver", return_value=FakeConptyDriver()):
                subject.produce_trial(root, repo, "plugin-control", timeout_seconds=30)

            evidence = json.loads((root / "evidence.json").read_text(encoding="utf-8"))
            row = next(item for item in evidence if item["id"] == "plugin-control")
            self.assertEqual(row["capture_eligibility"], "direct-live")
            self.assertTrue(
                subject.verify_evidence_row(
                    row,
                    (root / "backups" / subject.ATTESTATION_KEY_FILE).read_bytes(),
                )
            )

    def test_environment_does_not_forward_ambient_secrets(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            base = {
                "PATH": os.environ.get("PATH", ""),
                "SYSTEMROOT": os.environ.get("SYSTEMROOT", "C:\\Windows"),
                "ANTHROPIC_API_KEY": "secret",
                "AWS_SECRET_ACCESS_KEY": "secret",
                "UNRELATED_PRIVATE_VALUE": "secret",
            }

            claude = subject.claude_environment(root, base)
            server = subject.server_environment(root, "normal", base)

            for env in (claude, server):
                self.assertNotIn("ANTHROPIC_API_KEY", env)
                self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
                self.assertNotIn("UNRELATED_PRIVATE_VALUE", env)
                self.assertIn("PATH", env)

    def test_sensitive_capture_text_is_redacted_before_persistence(self):
        subject = load_subject()
        redacted = subject.redact_capture_value(
            {
                "line": "account bryan@example.com Bearer top-secret sk-ant-api03-secret",
                "nested": ["ANTHROPIC_API_KEY=very-secret"],
            }
        )

        serialized = json.dumps(redacted)
        self.assertNotIn("bryan@example.com", serialized)
        self.assertNotIn("top-secret", serialized)
        self.assertNotIn("sk-ant-api03-secret", serialized)
        self.assertNotIn("very-secret", serialized)

    def test_windows_process_tree_termination_uses_taskkill_tree_mode(self):
        subject = load_subject()
        completed = subprocess.CompletedProcess([], 0, "", "")
        with patch.object(subject.sys, "platform", "win32"), patch.object(
            subject.shutil, "which", return_value="C:\\Windows\\System32\\taskkill.exe"
        ), patch.object(subject.subprocess, "run", return_value=completed) as run:
            self.assertTrue(subject._terminate_pid_tree(4321))

        self.assertEqual(
            run.call_args.args[0],
            ["C:\\Windows\\System32\\taskkill.exe", "/PID", "4321", "/T", "/F"],
        )

    def test_live_producer_popen_keywords_match_the_python_runtime(self):
        tree = ast.parse(MODULE_PATH.read_text(encoding="utf-8"))
        supported = set(inspect.signature(subprocess.Popen).parameters)
        unsupported: set[str] = set()

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if (
                not isinstance(node.func.value, ast.Name)
                or node.func.value.id != "subprocess"
                or node.func.attr != "Popen"
            ):
                continue
            unsupported.update(
                keyword.arg
                for keyword in node.keywords
                if keyword.arg is not None and keyword.arg not in supported
            )

        self.assertEqual(unsupported, set())

    @unittest.skipUnless(os.name == "nt", "junction behavior is Windows-specific")
    def test_fixture_write_rejects_a_reparse_point_parent(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as outside_td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            fixtures = root / "fixtures"
            fixtures.rmdir()
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(fixtures), outside_td],
                check=True,
                capture_output=True,
            )

            with self.assertRaisesRegex(RuntimeError, "reparse|escapes"):
                subject._safe_mutation_path(root, fixtures / "escape.txt")

    def test_injector_rejects_non_loopback_endpoints(self):
        script = Path(__file__).with_name("session-monitor-user-event.mjs")
        proc = subprocess.run(
            ["node", str(script), "https://example.com", "wss://example.com", "id", "text"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )

        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("loopback", proc.stderr.lower())

    def test_prepare_creates_a_stable_harness_owned_attestation_key(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)

            subject.prepare_fixture_root(root)
            key_path = root / "backups" / subject.ATTESTATION_KEY_FILE
            first = key_path.read_bytes()
            subject.prepare_fixture_root(root)

            self.assertEqual(len(first), 32)
            self.assertEqual(key_path.read_bytes(), first)

    def test_prepare_seeds_onboarding_and_trust_in_effective_claude_config(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)

            subject.prepare_fixture_root(root)

            state_path = root / "home" / ".claude" / ".claude.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertTrue(state["hasCompletedOnboarding"])
            self.assertTrue(state["projects"][str(root / "workspace")]["hasTrustDialogAccepted"])
            self.assertFalse((root / "home" / ".claude.json").exists())

    def test_prepare_preserves_existing_fixture_claude_state(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            state_path = root / "home" / ".claude" / ".claude.json"
            state_path.write_text(
                json.dumps({"fixtureLoginState": "keep", "projects": {"other": {"trusted": True}}}),
                encoding="utf-8",
                newline="",
            )

            subject.prepare_fixture_root(root)

            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(state["fixtureLoginState"], "keep")
            self.assertIn("other", state["projects"])
            self.assertTrue(state["projects"][str(root / "workspace")]["hasTrustDialogAccepted"])

    def test_prepare_installs_structured_trace_hooks_in_effective_claude_settings(self):
        subject = load_subject()
        repo = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root, repo)

            hooks = json.loads(
                (root / "home" / ".claude" / "settings.json").read_text(encoding="utf-8")
            )
            helper = (
                root / "home" / ".claude" / "harness-hooks" / "capture-event.mjs"
            ).resolve()

            self.assertIn("SessionStart", hooks["hooks"])
            self.assertIn("UserPromptSubmit", hooks["hooks"])
            command = hooks["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            self.assertIn(str(helper), command)
            self.assertTrue(helper.is_file())
            self.assertFalse(
                (root / "fixtures" / "candidate-plugin-v10" / "hooks" / "hooks.json").exists()
            )

    def test_prepare_removes_stale_plugin_trace_hooks_to_avoid_duplicate_events(self):
        subject = load_subject()
        repo = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root, repo)
            stale_hooks = root / "fixtures" / "candidate-plugin-v10" / "hooks"
            stale_hooks.mkdir()
            (stale_hooks / "hooks.json").write_text("{}\n", encoding="utf-8", newline="")

            subject.prepare_fixture_root(root, repo)

            self.assertFalse(stale_hooks.exists())

    def test_auth_preflight_uses_exact_child_environment_and_rejects_logged_out(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            env = subject.claude_environment(root, {"PATH": os.environ.get("PATH", "")})
            completed = subprocess.CompletedProcess(
                ["claude", "auth", "status"], 0, stdout='{"loggedIn": false}', stderr=""
            )

            with patch.object(subject.subprocess, "run", return_value=completed) as run:
                with self.assertRaisesRegex(RuntimeError, "fixture-login"):
                    subject.ConptyTrialDriver._preflight_claude_auth("claude", root / "workspace", env)

            self.assertEqual(run.call_args.kwargs["env"], env)
            self.assertEqual(run.call_args.kwargs["cwd"], root / "workspace")

    def test_capture_source_runs_auth_preflight_before_server_or_pty_spawn(self):
        subject = load_subject()
        source = inspect.getsource(subject.ConptyTrialDriver.capture)

        self.assertLess(
            source.index("_preflight_claude_auth"), source.index("server = subprocess.Popen")
        )
        self.assertLess(source.index("_preflight_claude_auth"), source.index("PtyProcess.spawn"))

    def test_fixture_login_uses_supported_auth_flow_in_exact_isolated_environment(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            args = subject.make_parser().parse_args(["fixture-login", "--root", str(root)])
            completed = subprocess.CompletedProcess(["claude", "auth", "login"], 0)

            with patch.object(subject.shutil, "which", return_value="claude"), patch.object(
                subject.subprocess, "run", return_value=completed
            ) as run:
                self.assertEqual(args.handler(args), 0)

            self.assertEqual(run.call_args.args[0], ["claude", "auth", "login"])
            child_env = run.call_args.kwargs["env"]
            self.assertEqual(child_env["CLAUDE_CONFIG_DIR"], str(root / "home" / ".claude"))
            self.assertNotIn("ANTHROPIC_API_KEY", child_env)
            self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", child_env)

    def test_readiness_requires_session_start_and_prompt_ack_after_submission(self):
        subject = load_subject()
        driver = subject.ConptyTrialDriver()
        events = [
            {"harness_at": 1, "hook_event_name": "SessionStart"},
            {"harness_at": 2, "hook_event_name": "UserPromptSubmit"},
        ]

        self.assertTrue(driver._structured_event_after(events, "SessionStart", 0))
        self.assertFalse(driver._structured_event_after(events, "UserPromptSubmit", 2))
        self.assertTrue(driver._structured_event_after(events, "UserPromptSubmit", 1.5))

    def test_accepts_only_selected_workspace_trust_prompt_once(self):
        subject = load_subject()
        driver = subject.ConptyTrialDriver()

        class FakePty:
            def __init__(self):
                self.writes = []

            def write(self, value):
                self.writes.append(value)

        pty = FakePty()
        transcript = (
            "Accessing workspace C:\\fixture\\workspace\n"
            "Quick safety check: Is this a project you created or one you trust?\n"
            "  ❯ 1. Yes, I trust this folder\n"
            "    2. No, exit\n"
        )

        accepted = driver._accept_workspace_trust_prompt_if_selected(
            pty, transcript, already_accepted=False
        )
        accepted = driver._accept_workspace_trust_prompt_if_selected(
            pty, transcript, already_accepted=accepted
        )

        self.assertTrue(accepted)
        self.assertEqual(pty.writes, ["\r"])

    def test_does_not_accept_ambiguous_or_unselected_dialogs(self):
        subject = load_subject()
        driver = subject.ConptyTrialDriver()

        class FakePty:
            def __init__(self):
                self.writes = []

            def write(self, value):
                self.writes.append(value)

        transcripts = [
            "Quick safety check\n❯ 1. Yes, continue\n",
            "Accessing workspace C:\\fixture\\workspace\n❯ 1. Yes, I trust this folder\n",
            (
                "Accessing workspace C:\\fixture\\workspace\n"
                "Quick safety check\n"
                "  1. Yes, I trust this folder\n"
                "❯ 2. No, exit\n"
            ),
        ]

        for transcript in transcripts:
            with self.subTest(transcript=transcript):
                pty = FakePty()
                accepted = driver._accept_workspace_trust_prompt_if_selected(
                    pty, transcript, already_accepted=False
                )
                self.assertFalse(accepted)
                self.assertEqual(pty.writes, [])

    def test_existing_capture_is_rejected_without_driving_a_session(self):
        """The already-captured check must precede the live session, not follow it.

        Until 2026-08-11 this guard sat after the ConPTY run, so a re-attempt spent a
        full authenticated session and then discarded its artifacts.
        """

        subject = load_subject()

        class CountingDriver:
            def __init__(self):
                self.calls = 0

            def capture(self, _context):
                self.calls += 1
                return subject.MachineTrialCapture(
                    pty_capture="",
                    observations={key: True for key in subject.OBSERVATION_FIELDS},
                    decoy_log={},
                    server_log={},
                    process_tree={},
                )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = Path(__file__).resolve().parents[2]
            subject.prepare_fixture_root(root, repo)
            driver = CountingDriver()
            subject.produce_trial(
                root, repo, "plugin-control", timeout_seconds=30, driver=driver
            )
            self.assertEqual(driver.calls, 1)

            with self.assertRaisesRegex(RuntimeError, "capture already exists"):
                subject.produce_trial(
                    root, repo, "plugin-control", timeout_seconds=30, driver=driver
                )

            self.assertEqual(driver.calls, 1, "rejected re-attempt still drove a session")

    def test_overwrite_supersedes_prior_artifacts_and_evidence_row(self):
        subject = load_subject()

        def driver_returning(pty_text):
            class Driver:
                def capture(self, _context):
                    return subject.MachineTrialCapture(
                        pty_capture=pty_text,
                        observations={key: True for key in subject.OBSERVATION_FIELDS},
                        decoy_log={},
                        server_log={},
                        process_tree={},
                    )

            return Driver()

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = Path(__file__).resolve().parents[2]
            subject.prepare_fixture_root(root, repo)

            subject.produce_trial(
                root, repo, "plugin-control", timeout_seconds=30, driver=driver_returning("first")
            )
            subject.produce_trial(
                root,
                repo,
                "plugin-control",
                timeout_seconds=30,
                driver=driver_returning("second"),
                overwrite=True,
            )

            live = root / "artifacts" / "plugin-control" / "pty_capture.txt"
            superseded = root / "artifacts" / "plugin-control.superseded-1"
            self.assertIn("second", live.read_text(encoding="utf-8"))
            self.assertIn("first", (superseded / "pty_capture.txt").read_text(encoding="utf-8"))
            # The evidence row is what `evaluate` reads, so it is preserved too.
            self.assertTrue((superseded / "superseded-evidence-row.json").is_file())

            subject.produce_trial(
                root,
                repo,
                "plugin-control",
                timeout_seconds=30,
                driver=driver_returning("third"),
                overwrite=True,
            )
            self.assertTrue((root / "artifacts" / "plugin-control.superseded-2").is_dir())
            self.assertIn("first", (superseded / "pty_capture.txt").read_text(encoding="utf-8"))

    def test_a_superseded_bundle_resolves_to_its_own_bytes(self):
        """An archived capture must not resolve to the capture that replaced it.

        Both archived payloads record artifact paths relative to the fixture root, so
        carrying them into the supersede slot verbatim left them pointing at
        `artifacts/<trial_id>/` -- the live slot, which the *next* capture repopulates.
        Following an archived manifest then returned different bytes than the ones its
        sha256 was taken over: silently wrong, in a module whose contract is that a
        re-attempt supersedes evidence without erasing it.

        Asserting the paths merely exist would have passed against that bug, because the
        live slot exists too. Every payload here is varied per capture on purpose: with
        the default empty `decoy_log`/`server_log`/`process_tree`, two captures produce
        byte-identical artifacts for those roles, so a sha256 comparison cannot tell the
        archived bundle from the one that replaced it and only the path prefix would
        catch the bug.
        """

        subject = load_subject()

        def driver_returning(marker):
            class Driver:
                def capture(self, _context):
                    return subject.MachineTrialCapture(
                        pty_capture=marker,
                        observations={key: True for key in subject.OBSERVATION_FIELDS},
                        decoy_log={"marker": marker},
                        server_log={"marker": marker},
                        process_tree={"marker": marker},
                    )

            return Driver()

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = Path(__file__).resolve().parents[2]
            subject.prepare_fixture_root(root, repo)
            manifest_path = subject.produce_trial(
                root, repo, "plugin-control", timeout_seconds=30, driver=driver_returning("first")
            )

            # An injected driver is never release-eligible (`release_eligible = driver is
            # None`), so it leaves the evidence row empty and the row half of this
            # contract would go untested. Give the row the artifact list a real capture
            # would have written -- the manifest's, verbatim -- so both archived payloads
            # carry live-slot paths going into the supersede.
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            evidence_path = root / "evidence.json"
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            for entry in evidence:
                if entry["id"] == "plugin-control":
                    entry["artifacts"] = manifest["artifacts"]
            evidence_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")

            subject.produce_trial(
                root,
                repo,
                "plugin-control",
                timeout_seconds=30,
                driver=driver_returning("second"),
                overwrite=True,
            )

            superseded = root / "artifacts" / "plugin-control.superseded-1"
            archived = [
                json.loads((superseded / name).read_text(encoding="utf-8"))
                for name in ("capture-manifest.json", "superseded-evidence-row.json")
            ]
            for payload in archived:
                self.assertTrue(payload["artifacts"], "archived payload lists no artifacts")
                for entry in payload["artifacts"]:
                    resolved = root / entry["path"]
                    self.assertTrue(resolved.is_file(), f"{entry['path']} does not resolve")
                    self.assertEqual(
                        subject._sha256(resolved.read_bytes()),
                        entry["sha256"],
                        f"{entry['role']} resolves to bytes it was not hashed over",
                    )
                    self.assertTrue(
                        entry["path"].startswith("artifacts/plugin-control.superseded-1/"),
                        f"{entry['role']} still points at the live slot",
                    )

    def test_an_archived_row_does_not_carry_a_signature_that_must_fail(self):
        """Re-pointing the paths invalidates the row's own attestation and manifest hash.

        Both cover bytes the supersede rewrites, so the archived copy cannot verify. Left
        alone, `verify_evidence_row` fails on it identically to tampering -- the worst
        available outcome for a bundle whose whole purpose is being auditable later. The
        hash describes a file sitting right there and is restated; the signature is
        removed with a reason, because this session moved the capture and did not vouch
        for it.
        """

        subject = load_subject()

        class Driver:
            def capture(self, _context):
                return subject.MachineTrialCapture(
                    pty_capture="x",
                    observations={key: True for key in subject.OBSERVATION_FIELDS},
                    decoy_log={},
                    server_log={},
                    process_tree={},
                )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = Path(__file__).resolve().parents[2]
            subject.prepare_fixture_root(root, repo)
            manifest_path = subject.produce_trial(
                root, repo, "plugin-control", timeout_seconds=30, driver=Driver()
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            evidence_path = root / "evidence.json"
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            for entry in evidence:
                if entry["id"] == "plugin-control":
                    entry["artifacts"] = manifest["artifacts"]
                    entry["capture_manifest_sha256"] = subject._sha256(manifest_path.read_bytes())
                    entry[subject.ATTESTATION_FIELD] = "signature-over-the-live-slot"
            evidence_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")

            subject.produce_trial(
                root, repo, "plugin-control", timeout_seconds=30, driver=Driver(), overwrite=True
            )

            superseded = root / "artifacts" / "plugin-control.superseded-1"
            archived = json.loads(
                (superseded / "superseded-evidence-row.json").read_text(encoding="utf-8")
            )
            self.assertNotIn(
                subject.ATTESTATION_FIELD,
                archived,
                "archived row keeps a signature that can only ever fail",
            )
            self.assertEqual(
                archived[subject.ARCHIVED_ATTESTATION_REASON_FIELD], "repointed-on-supersede"
            )
            self.assertEqual(
                archived["capture_manifest_sha256"],
                subject._sha256((superseded / "capture-manifest.json").read_bytes()),
                "archived row's manifest hash does not describe the manifest beside it",
            )

    def test_a_rig_failure_survives_a_capture_that_also_failed(self):
        """The failure code was assigned over the note, erasing the reason.

        `notes` carries both segments, and the gate reads the rig one to say WHY a row is
        empty. On a row that recorded a rig failure and then raised, assignment dropped
        that segment -- on exactly the rows where the reason is most load-bearing. The
        extraction is equally at fault for matching only at position zero: it made the
        second segment invisible whichever order they were written in.
        """

        subject = load_subject()
        rig = f"{subject.RIG_NOTE_PREFIX}wake-injection-failed"

        class Driver:
            def capture(self, _context):
                raise subject.TrialCaptureFailure(
                    "turn-interrupted-usage-limit",
                    subject.MachineTrialCapture(
                        pty_capture="x",
                        observations={key: False for key in subject.OBSERVATION_FIELDS},
                        decoy_log={},
                        server_log={"failures": ["wake-injection-failed"]},
                        process_tree={},
                    ),
                )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = Path(__file__).resolve().parents[2]
            subject.prepare_fixture_root(root, repo)
            with self.assertRaises(RuntimeError):
                subject.produce_trial(
                    root, repo, "plugin-control", timeout_seconds=30, driver=Driver()
                )

            row = next(
                entry
                for entry in json.loads((root / "evidence.json").read_text(encoding="utf-8"))
                if entry["id"] == "plugin-control"
            )
            self.assertIn("capture failed: turn-interrupted-usage-limit", row["notes"])
            self.assertEqual(subject.rig_note_of(row), rig)

        # The extraction is order-independent on purpose: whichever segment lands first,
        # the other must stay findable. Matching at position zero alone made that a
        # coin flip.
        self.assertEqual(
            subject.rig_note_of({"notes": subject.append_note("capture failed: x", rig)}), rig
        )
        self.assertIsNone(subject.rig_note_of({"notes": "capture failed: something else"}))
        self.assertIsNone(subject.rig_note_of({"notes": None}))

    def test_an_archived_payload_without_artifacts_is_not_given_an_empty_list(self):
        """Absence and "produced none" are different claims about a capture."""

        subject = load_subject()
        root = Path("C:/fixture") if os.name == "nt" else Path("/fixture")
        repointed = subject._repoint_artifact_paths(
            {"trial_id": "plugin-control"},
            root,
            root / "artifacts" / "plugin-control",
            root / "artifacts" / "plugin-control.superseded-1",
        )

        self.assertNotIn("artifacts", repointed)
        with self.assertRaises(TypeError):
            subject._repoint_artifact_paths(
                {"artifacts": "artifacts/plugin-control/pty.txt"},
                root,
                root / "artifacts" / "plugin-control",
                root / "artifacts" / "plugin-control.superseded-1",
            )

    def test_ingest_preserves_direct_live_eligibility_but_only_for_its_own_manifest(self):
        """Ingesting a directly-captured trial must not downgrade it.

        `ingest-capture` stamped DIAGNOSTIC_IMPORT unconditionally, so running the
        sequence the tool itself prints turned passing live trials into an
        INCONCLUSIVE verdict. The hash match is what keeps this honest: a substituted
        bundle must not inherit eligibility it never earned.
        """

        subject = load_subject()

        class PassingDriver:
            def capture(self, _context):
                return subject.MachineTrialCapture(
                    # Ingest requires a plausibly-sized transcript (>=200 bytes).
                    pty_capture="interactive session transcript line\n" * 20,
                    observations={key: True for key in subject.OBSERVATION_FIELDS},
                    decoy_log={},
                    server_log={},
                    process_tree={
                        "claude_process_tree_teardown_verified": True,
                        "silent_monitor_teardown_verified": True,
                        "remaining_pids": [],
                    },
                )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = Path(__file__).resolve().parents[2]
            subject.prepare_fixture_root(root, repo)
            manifest = subject.produce_trial(
                root, repo, "plugin-control", timeout_seconds=30, driver=PassingDriver()
            )

            def eligibility():
                evidence = json.loads((root / "evidence.json").read_text(encoding="utf-8"))
                row = next(item for item in evidence if item["id"] == "plugin-control")
                return row[subject.CAPTURE_ELIGIBILITY_FIELD]

            # Only a real ConPTY run is release-eligible, so stand in for what one
            # leaves behind: the row `capture` writes for a trial it drove itself.
            evidence_path = root / "evidence.json"
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            for entry in evidence:
                if entry["id"] == "plugin-control":
                    entry[subject.CAPTURE_ELIGIBILITY_FIELD] = subject.DIRECT_LIVE_CAPTURE
                    entry["capture_manifest_sha256"] = subject._sha256(manifest.read_bytes())
            evidence_path.write_text(
                json.dumps(evidence, indent=2) + "\n", encoding="utf-8", newline=""
            )
            self.assertEqual(eligibility(), subject.DIRECT_LIVE_CAPTURE)
            subject.ingest_capture(root, manifest)
            self.assertEqual(
                eligibility(),
                subject.DIRECT_LIVE_CAPTURE,
                "ingest downgraded a directly-captured trial",
            )

            # A manifest that is not the one the row was built from must not inherit.
            tampered = json.loads(manifest.read_text(encoding="utf-8"))
            tampered["trial_id"] = "plugin-control"
            tampered["artifacts"] = sorted(
                tampered["artifacts"], key=lambda item: item["role"], reverse=True
            )
            manifest.write_text(json.dumps(tampered, indent=2) + "\n", encoding="utf-8", newline="")
            subject.ingest_capture(root, manifest)
            self.assertEqual(eligibility(), subject.DIAGNOSTIC_IMPORT)

    def test_pid_alive_observes_without_killing_the_process(self):
        """The liveness probe must not be an observer effect.

        `os.kill(pid, 0)` terminates on Windows (CPython routes os.kill through
        TerminateProcess), so the original probe killed every pid it was asked about
        and the teardown proof described the probe instead of the teardown.
        """

        subject = load_subject()
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            self.assertTrue(subject._pid_alive(child.pid))
            # The second call is the real assertion: if probing kills, this is False.
            self.assertTrue(subject._pid_alive(child.pid))
            self.assertIsNone(child.poll(), "probing the pid terminated the process")
        finally:
            child.kill()
            child.wait(timeout=10)

        self.assertFalse(subject._pid_alive(child.pid))
        self.assertFalse(subject._pid_alive(None))
        self.assertFalse(subject._pid_alive(0))

    def test_permission_dialog_is_named_not_mistaken_for_host_latency(self):
        """A blocked turn must be reported, never left to look like a slow host.

        Verbatim from the live transcript that cost seven sessions to read: Claude
        renders the dialog with cursor-column jumps, so ANSI-stripping collapses the
        spaces out of "Do you want to proceed?".
        """

        subject = load_subject()
        driver = subject.ConptyTrialDriver()

        blocked = (
            "Monitor\n\n  OpenWebSocketws://127.0.0.1:56602/api/wake\n"
            "   Tandem wake events (comments, chat, document activity)\n\n"
            "Doyouwanttoproceed?\n❯1.Yes\n2.No\n"
        )
        self.assertTrue(driver._permission_dialog_blocking(blocked))
        # Same screen with the spaces intact, as a plain terminal would render it.
        self.assertTrue(
            driver._permission_dialog_blocking("Monitor\n\nDo you want to proceed?\n1. Yes\n")
        )
        self.assertFalse(driver._permission_dialog_blocking("Clauding... 12s\n❯ \n"))
        self.assertFalse(driver._permission_dialog_blocking(""))

    def test_each_trial_has_exactly_one_dispatch_distinguishing_the_two_arms(self):
        """Control dispatches explicitly, natural dispatches in prose -- never both.

        Sending both conflated the arms of the matrix and raced the second write
        against the turn the first one had just occupied with a blocking Monitor call.
        """

        subject = load_subject()
        driver = subject.ConptyTrialDriver()
        prompts = {
            trial["id"]: driver._dispatch_prompt(trial) for trial in subject.build_trial_matrix()
        }

        for trial in subject.build_trial_matrix():
            with self.subTest(trial=trial["id"]):
                prompt = prompts[trial["id"]]
                if trial["prompt_kind"] == "control":
                    self.assertEqual(prompt, "/tandem")
                else:
                    self.assertNotIn("/tandem", prompt)
                    self.assertIn("Tandem", prompt)

        self.assertEqual(len(set(prompts.values())), 2, "expected one prompt per matrix arm")

    def test_monitor_idle_wait_scales_with_the_timeout_not_a_90_second_constant(self):
        """`min(90, timeout * 0.55)` was always exactly 90 above a 164s timeout.

        An armed Monitor call blocks the turn for minutes, so a fixed 90s wait could
        never observe the idle it looks for -- and it was the *only* wait a natural
        trial ever got.
        """

        subject = load_subject()

        # Calls the real computation. The previous version of this test re-implemented
        # the formula, so it verified its own copy -- and the copy had already drifted,
        # approximating `deadline - now` as the whole timeout.
        def budget(timeout_seconds):
            return subject.injection_budget(deadline=timeout_seconds, now=0.0)

        self.assertGreater(budget(900), 664, "cannot out-wait a measured 664s arm")
        self.assertGreater(budget(1800), budget(900), "budget must track the timeout")
        self.assertNotEqual(budget(900), 90)
        # The reserve is genuinely held back, and the floor genuinely floors.
        self.assertEqual(
            budget(900), 900 - subject.INJECTION_RESERVE_SECONDS, "reserve not withheld"
        )
        self.assertEqual(
            subject.injection_budget(deadline=10.0, now=0.0),
            subject.MIN_ARMING_WAIT_SECONDS,
            "an exhausted deadline must still leave a usable window",
        )

    def test_monitor_timing_measures_the_blocking_arm_without_gating_on_it(self):
        subject = load_subject()
        driver = subject.ConptyTrialDriver()

        timing = driver._monitor_timing(
            [
                {"hook_event_name": "PreToolUse", "tool_name": "Monitor", "harness_at": 100.0},
                {"hook_event_name": "PostToolUse", "tool_name": "Monitor", "harness_at": 764.0},
            ]
        )
        self.assertEqual(timing["monitor_resolution_seconds"], 664.0)

        # Still blocking when the trial ended: that is the observation, so it must not
        # be coerced into a number.
        unresolved = driver._monitor_timing(
            [{"hook_event_name": "PreToolUse", "tool_name": "Monitor", "harness_at": 100.0}]
        )
        self.assertIsNone(unresolved["monitor_resolved_at"])
        self.assertIsNone(unresolved["monitor_resolution_seconds"])

        # Duration must never become a gate criterion.
        self.assertNotIn("monitor_resolution_seconds", subject.OBSERVATION_FIELDS)

    def test_runtime_failure_persists_redacted_five_artifact_inconclusive_bundle(self):
        subject = load_subject()

        class FailingDriver:
            def capture(self, _context):
                capture = subject.MachineTrialCapture(
                    pty_capture="login screen bryan@example.com\n" * 20,
                    observations={key: False for key in subject.OBSERVATION_FIELDS},
                    decoy_log={"attached": False, "error": "Bearer secret-value"},
                    server_log={"failure_code": "claude-auth-required"},
                    process_tree={
                        "claude_process_tree_teardown_verified": True,
                        "silent_monitor_teardown_verified": False,
                        "remaining_pids": [],
                    },
                )
                raise subject.TrialCaptureFailure("claude-auth-required", capture)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = Path(__file__).resolve().parents[2]
            subject.prepare_fixture_root(root, repo)

            with self.assertRaisesRegex(RuntimeError, "claude-auth-required"):
                subject.produce_trial(
                    root, repo, "plugin-control", timeout_seconds=30, driver=FailingDriver()
                )

            artifact_dir = root / "artifacts" / "plugin-control"
            manifest = json.loads((artifact_dir / "capture-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual({item["role"] for item in manifest["artifacts"]}, subject.CAPTURE_ARTIFACT_ROLES)
            persisted = "".join(
                path.read_text(encoding="utf-8") for path in artifact_dir.glob("*.txt")
            )
            self.assertNotIn("bryan@example.com", persisted)
            self.assertNotIn("secret-value", persisted)
            evidence = json.loads((root / "evidence.json").read_text(encoding="utf-8"))
            row = next(item for item in evidence if item["id"] == "plugin-control")
            self.assertEqual(row["capture_eligibility"], subject.FAILED_LIVE_CAPTURE)
            self.assertFalse(row["capture_healthy"])
            self.assertEqual(subject.evaluate_gate(evidence)["verdict"], "INCONCLUSIVE")

    def test_ingest_capture_hashes_artifacts_and_attests_the_observation(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            trial = subject.build_trial_matrix()[0]
            observed = passing_evidence(subject)[0]
            artifact_dir = root / "artifacts" / trial["id"]
            artifact_dir.mkdir(parents=True)
            artifacts = []
            roles = set(subject.CAPTURE_ARTIFACT_ROLES) | {"observation_trace"}
            machine_payloads = {
                "pty_capture": b"captured interactive Claude session\n" * 16,
                "observation_trace": json.dumps(
                    {
                        "schema_version": subject.CAPTURE_SCHEMA_VERSION,
                        "trial_id": trial["id"],
                        "observations": {
                            key: observed[key]
                            for key in subject.PRECONDITION_FIELDS + subject.CHAIN_FIELDS
                        },
                    }
                ).encode(),
                "decoy_log": json.dumps(
                    {
                        "subscriber_id": observed["decoy_subscriber_id"],
                        "attached": True,
                        "attached_at": observed["decoy_attached_at"],
                        "status_observed_at": observed["status_observed_at"],
                    }
                ).encode(),
                "process_tree": json.dumps(
                    {
                        "claude_process_tree_teardown_verified": True,
                        "silent_monitor_teardown_verified": True,
                        "remaining_pids": [],
                    }
                ).encode(),
                "server_log": json.dumps(
                    {
                        "refreshed_before_ready": True,
                        "seeded_skill_sha256": observed["seeded_skill_sha256"],
                        "candidate_skill_sha256": observed["candidate_skill_sha256"],
                        "ready_skill_sha256": observed["ready_skill_sha256"],
                        "ready_skill_observed_at": observed["ready_skill_observed_at"],
                        "server_ready_at": observed["server_ready_at"],
                    }
                ).encode(),
            }
            for role in sorted(roles):
                artifact = artifact_dir / f"{role}.txt"
                content = machine_payloads[role]
                artifact.write_bytes(content)
                artifacts.append(
                    {
                        "role": role,
                        "path": str(artifact.relative_to(root)),
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
                )
            manifest = {
                "schema_version": subject.CAPTURE_SCHEMA_VERSION,
                "producer": subject.CAPTURE_PRODUCER,
                "trial_id": trial["id"],
                "observations": {},
                "artifacts": artifacts,
            }
            manifest_path = artifact_dir / "capture-manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8", newline="")

            ingested = subject.ingest_capture(root, manifest_path)
            key = (root / "backups" / subject.ATTESTATION_KEY_FILE).read_bytes()

            self.assertTrue(subject.verify_evidence_row(ingested, key))
            self.assertTrue(ingested["skill_dispatched"])
            self.assertTrue(ingested["decoy_subscriber_attached"])
            self.assertTrue(ingested["silent_monitor_teardown_verified"])
            self.assertEqual(ingested["ready_skill_sha256"], observed["ready_skill_sha256"])
            self.assertRegex(ingested["capture_manifest_sha256"], r"^[0-9a-f]{64}$")
            self.assertEqual({item["role"] for item in ingested["artifacts"]}, subject.CAPTURE_ARTIFACT_ROLES)

    def test_evaluate_command_accepts_attested_evidence_now_that_producer_exists(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            (root / "fixtures" / "skill-hashes.json").write_text(
                json.dumps(TEST_SKILL_HASHES), encoding="utf-8", newline=""
            )
            evidence = passing_evidence(subject)
            key = (root / "backups" / subject.ATTESTATION_KEY_FILE).read_bytes()
            for item in evidence:
                item[subject.ATTESTATION_FIELD] = subject.sign_evidence_row(item, key)
            (root / "evidence.json").write_text(
                json.dumps(evidence), encoding="utf-8", newline=""
            )
            args = subject.make_parser().parse_args(["evaluate", "--root", str(root)])

            self.assertTrue(subject.LIVE_CAPTURE_PRODUCER_AVAILABLE)
            self.assertEqual(args.handler(args), 0)

    def test_runbook_prints_the_exact_bounded_powershell_sequence(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            args = subject.make_parser().parse_args(
                [
                    "runbook",
                    "--root",
                    td,
                    "--trial",
                    "plugin-control",
                    "--timeout-seconds",
                    "90",
                ]
            )
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(args.handler(args), 0)
            text = output.getvalue()

            self.assertIn("uv run --with pywinpty python", text)
            self.assertIn("fixture-login --root", text)
            self.assertLess(text.index("fixture-login --root"), text.index("capture --root"))
            self.assertIn("capture --root", text)
            self.assertIn('--trial "plugin-control" --timeout-seconds 90', text)
            self.assertIn("Structured evidence hooks: $Fixture\\home\\.claude\\settings.json", text)
            self.assertIn("ingest-capture --root", text)
            self.assertIn("evaluate --root", text)

    def test_prepare_snapshots_immutable_v9_and_candidate_plugin(self):
        subject = load_subject()
        repo = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)

            subject.prepare_fixture_root(root, repo)

            self.assertIn("version: 9", (root / "fixtures" / "managed-v9-SKILL.md").read_text(encoding="utf-8"))
            self.assertIn("version: 10", (root / "fixtures" / "candidate-v10-SKILL.md").read_text(encoding="utf-8"))
            plugin_skill = root / "fixtures" / "candidate-plugin-v10" / "skills" / "tandem" / "SKILL.md"
            self.assertIn("acceptance-source: plugin-only-candidate-v10", plugin_skill.read_text(encoding="utf-8"))
            hashes = json.loads((root / "fixtures" / "skill-hashes.json").read_text(encoding="utf-8"))
            self.assertEqual(
                hashes["plugin_candidate"],
                hashlib.sha256(plugin_skill.read_bytes()).hexdigest(),
            )
            manifest = json.loads(
                (
                    root
                    / "fixtures"
                    / "candidate-plugin-v10"
                    / ".claude-plugin"
                    / "plugin.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(list(manifest["mcpServers"]), ["tandem"])
            self.assertNotIn("tandem-channel", manifest["mcpServers"])

    def test_prepare_refuses_nonempty_unowned_directory(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "somebody-elses-file.txt").write_text("keep", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "refusing non-owned fixture root"):
                subject.prepare_fixture_root(root)

            self.assertEqual(
                (root / "somebody-elses-file.txt").read_text(encoding="utf-8"),
                "keep",
            )

    def test_skill_backup_restores_existing_fixture_bytes(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            skill = root / "home" / ".claude" / "skills" / "tandem" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("existing fixture bytes\n", encoding="utf-8", newline="")

            with subject.SkillBackup(root, skill):
                skill.write_text("seeded v9\n", encoding="utf-8", newline="")

            self.assertEqual(skill.read_text(encoding="utf-8"), "existing fixture bytes\n")

    def test_skill_backup_removes_seed_when_no_fixture_skill_existed(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            skill = root / "home" / ".claude" / "skills" / "tandem" / "SKILL.md"

            with subject.SkillBackup(root, skill):
                skill.parent.mkdir(parents=True)
                skill.write_text("seeded v9\n", encoding="utf-8", newline="")

            self.assertFalse(skill.exists())

    def test_claude_environment_isolates_every_home_scoped_config_path(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)

            env = subject.claude_environment(root, {"HOME": "real-home", "USERPROFILE": "real-profile"})

            self.assertEqual(Path(env["HOME"]), root / "home")
            self.assertEqual(Path(env["USERPROFILE"]), root / "home")
            self.assertEqual(Path(env["CLAUDE_CONFIG_DIR"]), root / "home" / ".claude")

    def test_persistent_seed_and_restore_preserve_existing_fixture_skill(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            fixture = root / "fixtures" / "managed-v9-SKILL.md"
            fixture.write_text("version: 9\n", encoding="utf-8", newline="")
            skill = root / "home" / ".claude" / "skills" / "tandem" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("existing\n", encoding="utf-8", newline="")

            subject.seed_managed_skill(root)
            self.assertEqual(skill.read_text(encoding="utf-8"), "version: 9\n")
            subject.restore_managed_skill(root)

            self.assertEqual(skill.read_text(encoding="utf-8"), "existing\n")
            self.assertFalse((root / "backups" / "managed-skill-state.json").exists())

    def test_persistent_restore_removes_seed_when_fixture_started_absent(self):
        subject = load_subject()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root)
            fixture = root / "fixtures" / "managed-v9-SKILL.md"
            fixture.write_text("version: 9\n", encoding="utf-8", newline="")
            skill = root / "home" / ".claude" / "skills" / "tandem" / "SKILL.md"

            subject.seed_managed_skill(root)
            subject.restore_managed_skill(root)

            self.assertFalse(skill.exists())


def passing_evidence(
    subject,
    *,
    with_decoy=True,
    with_refresh_proof=True,
    with_teardown=True,
    with_artifacts=True,
):
    evidence = []
    for trial in subject.build_trial_matrix():
        item = {
            **trial,
            "capture_healthy": True,
            "host_authenticated": True,
            "workspace_trusted": True,
            "refreshed_before_ready": True if trial["requires_refresh"] else None,
            "decoy_subscriber_attached": True if with_decoy else None,
            "decoy_subscriber_id": f"decoy-{trial['id']}" if with_decoy else None,
            "decoy_attached_at": 100 if with_decoy else None,
            "status_observed_at": 200 if with_decoy else None,
            "seeded_skill_sha256": (
                TEST_SKILL_HASHES["v9"]
                if trial["requires_refresh"] and with_refresh_proof
                else None
            ),
            "candidate_skill_sha256": (
                (
                    TEST_SKILL_HASHES["candidate"]
                    if trial["requires_refresh"]
                    else TEST_SKILL_HASHES["plugin_candidate"]
                )
                if with_refresh_proof
                else None
            ),
            "ready_skill_sha256": (
                (
                    TEST_SKILL_HASHES["candidate"]
                    if trial["requires_refresh"]
                    else TEST_SKILL_HASHES["plugin_candidate"]
                )
                if with_refresh_proof
                else None
            ),
            "ready_skill_observed_at": (
                120 if trial["requires_refresh"] and with_refresh_proof else None
            ),
            "server_ready_at": (
                150 if trial["requires_refresh"] and with_refresh_proof else None
            ),
            "claude_process_tree_teardown_verified": True if with_teardown else None,
            "silent_monitor_teardown_verified": True if with_teardown else None,
            "capture_manifest_sha256": "c" * 64 if with_artifacts else None,
            "capture_eligibility": subject.DIRECT_LIVE_CAPTURE,
            "observed_launcher_mode": (
                trial["startup_mode"]
                if trial["install_shape"] == "managed-double"
                else "launcher-disabled"
            ),
            "artifacts": (
                [
                    {
                        "role": role,
                        "path": f"artifacts/{trial['id']}/{role}.txt",
                        "sha256": ("d", "e", "f", "a", "b")[index] * 64,
                    }
                    for index, role in enumerate(sorted(subject.CAPTURE_ARTIFACT_ROLES))
                ]
                if with_artifacts
                else []
            ),
        }
        for key in subject.PRECONDITION_FIELDS:
            item[key] = True
        for key in subject.CHAIN_FIELDS:
            item[key] = trial["prompt_kind"] == "control"
        # A declining natural still calls `tandem_status` and still gets a wakeUrl back
        # (present whenever a wake transport is running, as it is in every trial) --
        # both real stored declines show this true, and the gate now reads a decline with
        # `status_succeeded` false as unattributable rather than as a model choice. Left
        # false, every fixture decline was a shape the harness cannot actually produce.
        item["status_succeeded"] = True
        evidence.append(item)

    for shape in ("managed-double", "plugin-only"):
        natural = next(
            item
            for item in evidence
            if item["install_shape"] == shape and item["prompt_kind"] == "natural"
        )
        for key in subject.CHAIN_FIELDS:
            natural[key] = True
    for item in evidence:
        _assert_plausible_row(subject, item)
    return evidence


def _assert_plausible_row(subject, row):
    """Reject a fixture row the harness itself could never produce.

    Scoped deliberately to `passing_evidence`'s own output and never applied to a row a
    test has since modified: two tests build the forbidden shape on purpose, to prove
    `evaluate`'s contradiction check fires on it. A guard that rejected those would delete
    coverage of the check rather than add any.
    """

    if row.get("skill_dispatched"):
        return
    impossible = [
        field for field in subject.DISPATCH_CONSEQUENT_FIELDS if row.get(field) is True
    ]
    if impossible:
        raise AssertionError(
            f"{row['id']}: fixture claims {impossible} without a dispatch, which no capture can produce"
        )


class NaturalDeclineTests(unittest.TestCase):
    """A bounded n=3 sample must be able to contain a decline and still pass.

    Until 2026-08-11 it could not: a natural trial that never invoked the skill never
    armed a monitor, so the monitor-idle wait burned the whole budget and aborted the
    capture -- forcing `capture_healthy: false` and `FAILED_LIVE_CAPTURE`, both of which
    the gate rejects outright. The gate reported `natural_successes: 1, controls_pass:
    true` (literally its own PASS predicate) and still returned INCONCLUSIVE.
    """

    @staticmethod
    def _events(*, prompt_at=100.0, skill_at=None, stop_at=None, monitor_at=None):
        events = [{"hook_event_name": "UserPromptSubmit", "harness_at": prompt_at}]
        if skill_at is not None:
            events.append({"hook_event_name": "PreToolUse", "tool_name": "Skill", "harness_at": skill_at})
        if monitor_at is not None:
            events.append(
                {"hook_event_name": "PreToolUse", "tool_name": "Monitor", "harness_at": monitor_at}
            )
        if stop_at is not None:
            events.append({"hook_event_name": "Stop", "harness_at": stop_at})
        return events

    def test_declined_turn_needs_positive_proof_it_completed_not_merely_no_skill_event(self):
        subject = load_subject()

        declined = subject.classify_dispatch(
            self._events(stop_at=140.0), prompt_submitted_at=100.0, dispatch_marker_seen=False
        )
        hung = subject.classify_dispatch(
            self._events(), prompt_submitted_at=100.0, dispatch_marker_seen=False
        )

        self.assertEqual(declined, subject.DISPATCH_DECLINED)
        # No Stop: a crash, a hang, a skill that never became invocable, or an unanswered
        # dialog. Absence of a dispatch signal alone must never read as a benign decline.
        self.assertEqual(hung, subject.DISPATCH_PENDING)

    def test_slash_dispatch_is_observed_through_the_marker_with_no_skill_tool_event(self):
        subject = load_subject()

        # Measured from the real plugin-control trace: `/tandem` emits no `Skill` event,
        # yet the skill demonstrably ran (the same trace contains a `Monitor` call).
        # Deriving dispatch from the `Skill` event alone would pin every control row
        # false and make `controls_pass` unreachable forever.
        self.assertEqual(
            subject.classify_dispatch(
                self._events(stop_at=140.0, monitor_at=120.0),
                prompt_submitted_at=100.0,
                dispatch_marker_seen=True,
            ),
            subject.DISPATCH_OBSERVED,
        )

    def test_skill_event_without_the_marker_is_dispatch_not_decline(self):
        subject = load_subject()

        # The marker also requires the plugin's on-skill-invoke trigger to fire and its
        # process to spawn. If that breaks (#1354) while the model did invoke the skill,
        # the marker alone would call it a decline and launder the regression.
        self.assertEqual(
            subject.classify_dispatch(
                self._events(skill_at=112.0, stop_at=140.0),
                prompt_submitted_at=100.0,
                dispatch_marker_seen=False,
            ),
            subject.DISPATCH_OBSERVED,
        )

    def test_a_typed_control_is_observed_through_prompt_expansion(self):
        """The control arm gets a host-reported signal, not just a spawned process.

        A typed `/tandem` emits `UserPromptExpansion`, never `PreToolUse Skill`, so before
        this the only proof a control ran was the marker file -- which needs the plugin's
        on-skill-invoke trigger to fire and its process to spawn. Purely additive: a
        natural prompt names Tandem in prose but never in the slash form, so prose cannot
        be misread as an explicit dispatch.
        """

        subject = load_subject()

        def dispatched(event):
            return subject.dispatch_signals_seen(
                [event], prompt_submitted_at=100.0, dispatch_marker_seen=False
            )

        self.assertTrue(
            dispatched(
                {
                    "hook_event_name": "UserPromptExpansion",
                    "command": "tandem",
                    "prompt": "/tandem",
                    subject.HOOK_EVENT_TIME_KEY: 105.0,
                }
            )
        )
        # Prose that merely mentions Tandem is not a dispatch.
        self.assertFalse(
            dispatched(
                {
                    "hook_event_name": "UserPromptExpansion",
                    "prompt": "Open the Tandem document and summarise it",
                    subject.HOOK_EVENT_TIME_KEY: 105.0,
                }
            )
        )
        # Nor is an expansion of some other command.
        self.assertFalse(
            dispatched(
                {
                    "hook_event_name": "UserPromptExpansion",
                    "prompt": "/simplify",
                    subject.HOOK_EVENT_TIME_KEY: 105.0,
                }
            )
        )
        # A path that merely ends in `/tandem` is not a dispatch. Which field carries the
        # command is undocumented, so every string value is examined -- and this repository
        # is checked out at a path ending in `/tandem`, which a substring search over the
        # serialized payload would have read as a control dispatch in every prose trial.
        self.assertFalse(
            dispatched(
                {
                    "hook_event_name": "UserPromptExpansion",
                    "cwd": "/home/runner/work/tandem/tandem",
                    "transcript_path": "/home/u/.claude/skills/tandem/SKILL.md",
                    "prompt": "Use Tandem to report the current collaboration state.",
                    subject.HOOK_EVENT_TIME_KEY: 105.0,
                }
            )
        )
        # And the fixture must actually subscribe to the hook, or the signal never arrives.
        self.assertIn(
            '"UserPromptExpansion"',
            inspect.getsource(subject._install_structured_trace_hooks),
        )

    def test_a_host_interrupted_turn_is_not_a_model_decline(self):
        """A turn the host cut short produces the same row as a considered decline.

        A usage limit, an API error or a compaction ends the turn with a normal `Stop`
        after `tandem_status` already succeeded, so `status_succeeded` -- the attribution
        signal -- reads true and the row counts as the model choosing not to arm. It never
        got to choose. Named at capture time so the trial fails loudly instead of
        contributing a negative to the sample.

        The steady-state context readout is deliberately not a marker: it is printed by
        every healthy long turn, and matching it would fail all of them.
        """

        subject = load_subject()
        interrupted = subject.ConptyTrialDriver._turn_interrupted

        self.assertEqual(interrupted("Claude usage limit reached, resets at 9pm"), "usage-limit")
        self.assertEqual(interrupted("API Error: 500 internal"), "api-error")
        self.assertEqual(interrupted('{"type":"rate_limit_error"}'), "rate-limited")
        self.assertEqual(interrupted("Compacting conversation..."), "compacted")
        self.assertIsNone(interrupted("Context left until auto-compact: 24%"))
        self.assertIsNone(interrupted("Tandem is in tandem mode with 1 subscriber."))

    def test_every_stored_capture_ran_to_its_own_end(self):
        """The interruption markers must not fire on the bundle the gate's PASS rests on.

        A detector added after the measurement can retroactively invalidate it, so this
        pins the negative control: if any of the ten stored transcripts matched, the PASS
        would have been resting on a turn the host cut short, and the fix would be the
        measurement rather than the code. Skipped rather than failed when the bundle is
        absent -- it lives outside the repository, and its absence is not a defect.
        """

        subject = load_subject()
        bundle = os.environ.get("TANDEM_ACCEPTANCE_BUNDLE")
        if not bundle or not Path(bundle, "artifacts").is_dir():
            self.skipTest("no evidence bundle available; set TANDEM_ACCEPTANCE_BUNDLE")

        captures = sorted(Path(bundle, "artifacts").glob("*/pty_capture.txt"))
        self.assertTrue(captures, "bundle has no pty captures to check")
        for capture in captures:
            reason = subject.ConptyTrialDriver._turn_interrupted(
                capture.read_text(encoding="utf-8", errors="replace")
            )
            self.assertIsNone(reason, f"{capture.parent.name} was interrupted: {reason}")

    def test_only_the_tandem_skill_counts_as_a_tandem_dispatch(self):
        """`tool_name` alone made any skill invocation a Tandem dispatch.

        Ground truth from the ten-trial bundle: host tool names are bare (`Skill` x3,
        `Monitor` x7, `ToolSearch` x20) while MCP tools are prefixed
        (`mcp__plugin_tandem_tandem__*` x38), so the exact `tool_name` match is right --
        but the skill's identity lives in `tool_input.skill`, and nothing was reading it.
        """

        subject = load_subject()

        def dispatched(tool_input):
            return subject.dispatch_signals_seen(
                [
                    {
                        "hook_event_name": "PreToolUse",
                        "tool_name": "Skill",
                        "tool_input": tool_input,
                        "harness_at": 112.0,
                    }
                ],
                prompt_submitted_at=100.0,
                dispatch_marker_seen=False,
            )

        self.assertTrue(dispatched({"skill": "tandem"}), "the observed real value")
        self.assertTrue(dispatched({"skill": "tandem:tandem"}), "plugin-qualified form")
        self.assertFalse(dispatched({"skill": "superpowers:brainstorming"}))
        self.assertFalse(dispatched({"skill": "simplify"}))
        # Fails open, deliberately: closed would make a dispatch invisible if the host
        # dropped the field, and an invisible dispatch becomes a laundered decline.
        self.assertTrue(dispatched(None), "a missing tool_input must not hide a dispatch")

    def test_a_host_payload_cannot_shadow_the_harness_timestamp(self):
        """The trace writer spreads the host payload second, so its keys win.

        `at` was the harness's own key. No documented `PreToolUse`/`Stop` field is named
        that, so it was never exploitable -- but the real traces carry `background_tasks`,
        `session_crons`, `model` and `duration_ms`, none of them documented either, so the
        schemas are still growing into whatever name the harness claims.
        """

        subject = load_subject()
        hostile = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Skill",
            "tool_input": {"skill": "tandem"},
            subject.HOOK_EVENT_TIME_KEY: 112.0,
            # A host field named like the old key must be inert now.
            "at": 10**12,
        }

        self.assertEqual(subject.event_at(hostile), 112.0)
        self.assertTrue(
            subject.dispatch_signals_seen(
                [hostile], prompt_submitted_at=100.0, dispatch_marker_seen=False
            )
        )
        # And the writer the fixture actually installs emits the namespaced key, so a
        # capture and its readers cannot disagree about which key carries the time.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / subject.FIXTURE_MARKER).write_text(
                json.dumps(
                    {
                        "kind": "tandem-session-monitor-acceptance",
                        "version": subject.FIXTURE_VERSION,
                    }
                ),
                encoding="utf-8",
            )
            subject._install_structured_trace_hooks(root)
            writer = (
                root / "home" / ".claude" / "harness-hooks" / "capture-event.mjs"
            ).read_text(encoding="utf-8")

        self.assertIn(f"{subject.HOOK_EVENT_TIME_KEY}: Date.now() / 1000", writer)
        self.assertNotIn("{ at:", writer)
        # The spread stays last -- the payload is copied verbatim, host keys and all.
        self.assertLess(writer.index(subject.HOOK_EVENT_TIME_KEY), writer.index("...payload"))

    def test_host_tool_names_are_matched_bare_and_mcp_tools_by_suffix(self):
        subject = load_subject()
        source = inspect.getsource(subject)

        # Both exact matches are load-bearing and both are correct per the bundle; pinned
        # together so a well-meant "make it consistent with the endswith calls" rewrite
        # has to confront the evidence.
        self.assertIn('str(event.get("tool_name", "")).lower() == "skill"', source)
        self.assertIn('str(event.get("tool_name", "")).lower() == "monitor"', source)
        # And the MCP side stays suffix-matched, because those names are prefixed.
        self.assertIn('.endswith("tandem_status")', source)

    def test_a_dispatch_signal_arriving_after_stop_still_wins(self):
        subject = load_subject()

        # Trace lines are appended by per-event hook subprocesses, so a poll that reads
        # `Stop` before the `Skill` line has flushed must not lock in "declined".
        self.assertEqual(
            subject.classify_dispatch(
                self._events(stop_at=140.0, skill_at=112.0),
                prompt_submitted_at=100.0,
                dispatch_marker_seen=False,
            ),
            subject.DISPATCH_OBSERVED,
        )

    def test_a_turn_that_never_completed_is_a_failure_not_a_decline(self):
        """The invariant the whole decline path rests on, tested through real code.

        A hung or crashed session is indistinguishable from a decline except that it never
        emits a `Stop`. If that case were classified as declined, a rig failure would be
        recorded as a measured negative -- the exact laundering this harness exists to
        prevent, one layer below the behaviour it measures.

        This could not be tested before the decision was extracted from `capture`: every
        driver stand-in in this suite replaces `ConptyTrialDriver` wholesale, so none of
        them reaches the branch. A test written against a stand-in would only re-prove
        that a raised failure becomes a failed-live row, and an inverted comparator in the
        branch would still pass it.
        """

        subject = load_subject()
        settles = []

        def outcome(classification, *, monitor_idle=False):
            return subject.settle_and_classify(
                lambda: classification,
                monitor_idle=monitor_idle,
                settle=lambda: settles.append(classification),
            )

        self.assertEqual(outcome(subject.DISPATCH_PENDING), subject.SETTLE_UNOBSERVED)
        self.assertEqual(outcome(subject.DISPATCH_DECLINED), subject.DISPATCH_DECLINED)
        self.assertEqual(outcome(subject.DISPATCH_OBSERVED), subject.SETTLE_UNOBSERVED)
        # Arming already observed: no settle needed, and no classification consulted.
        self.assertEqual(
            subject.settle_and_classify(
                lambda: self.fail("classified despite an observed arm"),
                monitor_idle=True,
                settle=lambda: self.fail("settled despite an observed arm"),
            ),
            subject.DISPATCH_OBSERVED,
        )
        # The settle runs before the classification is read, every time it runs at all.
        self.assertEqual(len(settles), 3)

    def test_only_the_unobserved_outcome_aborts_the_capture(self):
        subject = load_subject()
        source = inspect.getsource(subject.ConptyTrialDriver.capture)

        # `SETTLE_UNOBSERVED` is the one outcome that must raise; a decline continues into
        # the row it is entitled to. Kept as a source check because the surrounding branch
        # lives inside the 470-line PTY method, with no seam of its own.
        self.assertIn("if outcome == SETTLE_UNOBSERVED:", source)
        self.assertIn("declined = outcome == DISPATCH_DECLINED", source)
        self.assertIn('raise RuntimeError("structured-monitor-idle-not-observed")', source)
        self.assertIn("marker_path.is_file()", source)

    def test_decline_skips_injection_so_it_cannot_fail_on_an_unarmed_monitor(self):
        subject = load_subject()
        source = inspect.getsource(subject.ConptyTrialDriver.capture)

        injector = source.index("session-monitor-user-event.mjs")
        subscriber = source.index("monitor-subscriber-not-observed")
        declined = source.index("if declined:")
        self.assertLess(declined, injector)
        self.assertLess(source.index("if not declined:"), subscriber)
        # Substring *order* is unchanged by inverting either comparator, so pin the
        # comparators themselves. The behavioural half is
        # test_a_turn_that_never_completed_is_a_failure_not_a_decline.
        self.assertIn("declined = outcome == DISPATCH_DECLINED", source)

    @staticmethod
    def _make_realistic_decline(subject, row):
        """Shape a row the way a real declined trial actually reads.

        `passing_evidence` marks every precondition true on every row, so its
        non-dispatching naturals claim `turn_idle_after_monitor: True` -- impossible for a
        trial that armed no monitor, since that field requires a Stop strictly after a
        `Monitor` call. The suite's own 1-of-3 PASS test therefore passed against a row
        shape that cannot occur, which is how a gate unable to pass on real evidence
        shipped unnoticed.
        """

        row["skill_dispatched"] = False
        # a read-mode tandem_status response carries a wakeUrl whenever a wake transport
        # is running -- true in every trial here, absent under stdio -- regardless of arming,
        # and a declining model still calls tandem_status to answer the prose prompt --
        # both real stored decline rows show this true.
        row["status_succeeded"] = True
        for field in subject.DISPATCH_CONSEQUENT_FIELDS:
            row[field] = False
        return row

    def test_status_succeeded_does_not_make_an_honest_decline_self_contradictory(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        self._make_realistic_decline(
            subject, next(item for item in evidence if item["id"] == "plugin-natural-2")
        )

        result = evaluate(subject, evidence)

        self.assertEqual(result["plugin_only"]["verdict"], "PASS")
        self.assertNotIn("without observed dispatch", " ".join(result["plugin_only"]["reasons"]))

    def test_pass_is_reachable_with_two_of_three_naturals_declining(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        for trial_id in ("plugin-natural-2", "plugin-natural-3"):
            self._make_realistic_decline(
                subject, next(item for item in evidence if item["id"] == trial_id)
            )

        result = evaluate(subject, evidence)

        self.assertEqual(result["plugin_only"]["verdict"], "PASS")
        self.assertEqual(result["plugin_only"]["natural_successes"], 1)
        self.assertEqual(result["plugin_only"]["natural_sample_size"], 3)
        self.assertEqual(result["plugin_only"]["reasons"], [])

    def test_a_decline_claiming_post_arming_evidence_is_still_contradictory(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        row = self._make_realistic_decline(
            subject, next(item for item in evidence if item["id"] == "plugin-natural-2")
        )
        # The physically impossible shape `passing_evidence` produces by default: no
        # dispatch, yet a Stop after a monitor that was never armed.
        row["turn_idle_after_monitor"] = True

        result = evaluate(subject, evidence)

        self.assertEqual(result["plugin_only"]["verdict"], "INCONCLUSIVE")
        self.assertIn(
            "later chain evidence exists without observed dispatch",
            " ".join(result["plugin_only"]["reasons"]),
        )

    def test_control_that_armed_without_an_observed_dispatch_is_a_hard_failure(self):
        subject = load_subject()
        evidence = passing_evidence(subject)
        control = next(
            item
            for item in evidence
            if item["install_shape"] == "plugin-only" and item["prompt_kind"] == "control"
        )
        # A control's only dispatch signal is the marker, which needs the on-skill-invoke
        # trigger AND its process spawn. Arming a monitor proves the skill ran, so this
        # combination is a broken trigger -- not the same thing as a control that was
        # never dispatched, which is a rig failure. They used to share one bucket.
        control["skill_dispatched"] = False

        result = evaluate(subject, evidence)

        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("armed a monitor without an observed dispatch", " ".join(result["reasons"]))

    def test_rehoming_preserves_the_attested_observation_set(self):
        subject = load_subject()

        # The union is what `ingest_capture` and `machine_derived` compare against, and
        # `_attestation_payload` sorts keys -- so moving a field between the two tuples
        # must not invalidate already-signed rows.
        self.assertEqual(
            set(subject.PRECONDITION_FIELDS + subject.CHAIN_FIELDS),
            set(subject.OBSERVATION_FIELDS),
        )
        for field in ("turn_idle_after_monitor", "subscriber_growth_proven", "autonomous_turn_seen"):
            self.assertIn(field, subject.CHAIN_FIELDS)
            self.assertNotIn(field, subject.PRECONDITION_FIELDS)
        # status_succeeded stays in CHAIN_FIELDS (the control-completeness and
        # natural-full-chain checks require it) but must not gate the contradiction check.
        self.assertIn("status_succeeded", subject.CHAIN_FIELDS)
        self.assertNotIn("status_succeeded", subject.DISPATCH_CONSEQUENT_FIELDS)

    def test_a_declined_capture_produces_a_release_eligible_row_end_to_end(self):
        """The whole point: a decline must be recordable, not a capture failure.

        This walks the real `produce_trial` writer with a declined capture and asserts the
        row the gate will actually read. Four separate things had to be true at once and
        only one of them was the schema -- eligibility, capture_healthy, the process-tree
        teardown proof, and the precondition set. Each was found the expensive way.
        """

        subject = load_subject()
        observations = {key: False for key in subject.OBSERVATION_FIELDS}
        observations.update(
            {field: True for field in subject.PRECONDITION_FIELDS},
            # True on a real decline: the status response carries a wakeUrl whenever a
            # wake transport is running, which it is in every trial.
            status_succeeded=True,
        )

        class DecliningDriver:
            def capture(self, context):
                hashes = json.loads(
                    (context.root / "fixtures" / "skill-hashes.json").read_text(encoding="utf-8")
                )
                return subject.MachineTrialCapture(
                    pty_capture="Claude Code ready\n" * 20,
                    observations=observations,
                    decoy_log={
                        "subscriber_id": "decoy-declined",
                        "attached": True,
                        "attached_at": 100,
                        "status_observed_at": 200,
                    },
                    server_log={
                        "refreshed_before_ready": None,
                        "candidate_skill_sha256": hashes["plugin_candidate"],
                        "ready_skill_sha256": hashes["plugin_candidate"],
                        "dispatch_classification": subject.DISPATCH_DECLINED,
                    },
                    process_tree={
                        "claude_process_tree_teardown_verified": True,
                        # No skill invocation means no on-skill-invoke monitor to reap.
                        "silent_monitor_teardown_verified": True,
                        "remaining_pids": [],
                    },
                )

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = Path(__file__).resolve().parents[2]
            subject.prepare_fixture_root(root, repo)
            with patch.object(subject, "ConptyTrialDriver", return_value=DecliningDriver()):
                subject.produce_trial(root, repo, "plugin-natural-2", timeout_seconds=30)

            evidence = json.loads((root / "evidence.json").read_text(encoding="utf-8"))
            row = next(item for item in evidence if item["id"] == "plugin-natural-2")

        self.assertEqual(row["capture_eligibility"], subject.DIRECT_LIVE_CAPTURE)
        self.assertTrue(row["capture_healthy"])
        self.assertFalse(row["skill_dispatched"])
        # None of the four blockers that made a decline unrecordable may survive.
        # Re-signed with the suite key via `evaluate`; the producer signed with the
        # fixture's own generated key, which this assertion is not about. Asserting on
        # these four rather than an empty reason list keeps the test off the fake
        # driver's unrelated launcher-mode and skill-hash plumbing.
        merged = [
            row if item["id"] == "plugin-natural-2" else item
            for item in passing_evidence(subject)
        ]
        reasons = " ".join(evaluate(subject, merged)["plugin_only"]["reasons"])
        for blocker in (
            "release evidence requires direct live capture",
            "process-tree teardown proof is absent",
            "host control preconditions not established",
            "later chain evidence exists without observed dispatch",
        ):
            self.assertNotIn(blocker, reasons)

    def test_silent_monitor_teardown_is_vacuous_only_when_the_skill_was_declined(self):
        subject = load_subject()

        def proven(pids, classification, alive=()):
            return subject.silent_monitor_teardown_proven(
                pids,
                dispatch_classification=classification,
                pid_alive=lambda pid: pid in alive,
            )

        # A decline spawns no plugin monitor, so an empty list is the honest observation.
        self.assertTrue(proven([], subject.DISPATCH_DECLINED))
        # A dispatching trial with no observed pid stays unproven -- that is the case the
        # non-empty requirement exists for, and the vacuity must not reach it.
        self.assertFalse(proven([], subject.DISPATCH_OBSERVED))
        self.assertFalse(proven([], None))
        # Observed pids must actually be gone, on either branch.
        self.assertTrue(proven([4321], subject.DISPATCH_OBSERVED))
        self.assertFalse(proven([4321], subject.DISPATCH_OBSERVED, alive={4321}))
        self.assertFalse(proven([4321], subject.DISPATCH_DECLINED, alive={4321}))

    def test_a_rig_failure_is_named_beside_the_verdict_without_changing_it(self):
        """A broken injector and a model that never polled produced the same row.

        Both leave `inbox_checked` false, and the reason lived only in a `server_log` blob
        nothing reads. Naming it must not make it a gate input, though: a rig failure that
        could veto a shape would be a worse defect than the anonymity.
        """

        subject = load_subject()
        evidence = passing_evidence(subject)
        clean = evaluate(subject, evidence)

        for row in evidence:
            if row["id"] == "plugin-natural-1":
                row["notes"] = "rig: wake-injection-failed (exit 1)"
        named = evaluate(subject, evidence)

        self.assertEqual(named["verdict"], clean["verdict"])
        self.assertEqual(named["plugin_only"]["reasons"], clean["plugin_only"]["reasons"])
        self.assertIn(
            "plugin-natural-1: rig: wake-injection-failed (exit 1)",
            named["plugin_only"]["rig_failures"],
        )
        self.assertEqual(clean["plugin_only"]["rig_failures"], [])

    def test_the_settle_window_is_long_enough_to_absorb_a_hook_write(self):
        subject = load_subject()

        # Pinned by value, not just by name: the previous assertion was
        # `assertIn("DISPATCH_SETTLE_SECONDS", source)`, which passes at 0.15 -- short
        # enough that a hook subprocess's write would lose the race and a real dispatch
        # would be recorded as a decline.
        self.assertGreaterEqual(subject.DISPATCH_SETTLE_SECONDS, 15.0)

    def test_transcript_health_fields_are_named_not_positionally_sliced(self):
        subject = load_subject()

        self.assertNotIn(
            "PRECONDITION_FIELDS[:3]", inspect.getsource(subject.ConptyTrialDriver.capture)
        )
        for field in subject.TRANSCRIPT_HEALTH_FIELDS:
            self.assertIn(field, subject.PRECONDITION_FIELDS)


def evaluate(subject, evidence):
    for item in evidence:
        item[subject.ATTESTATION_FIELD] = subject.sign_evidence_row(
            item,
            TEST_ATTESTATION_KEY,
        )
    return subject.evaluate_gate(
        evidence,
        TEST_ATTESTATION_KEY,
        TEST_SKILL_HASHES,
    )


if __name__ == "__main__":
    unittest.main()
