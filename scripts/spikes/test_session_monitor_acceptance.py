import ast
import importlib.util
import hashlib
import inspect
import json
import io
import os
import subprocess
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
            {"at": 1, "hook_event_name": "UserPromptSubmit", "prompt": "neutral"},
            {"at": 2, "hook_event_name": "PostToolUse", "tool_name": "mcp__tandem__tandem_status", "tool_response": {"wakeUrl": "ws://127.0.0.1:43079/api/wake"}},
            {"at": 3, "hook_event_name": "PreToolUse", "tool_name": "Monitor", "tool_input": {"ws": {"url": "ws://127.0.0.1:43079/api/wake"}, "persistent": True}},
            {"at": 4, "hook_event_name": "Stop"},
            {"at": 6, "hook_event_name": "PostToolUse", "tool_name": "mcp__tandem__tandem_checkInbox", "tool_response": {"text": event_text}},
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

    def test_plugin_hook_fixture_includes_session_start_sentinel(self):
        subject = load_subject()
        repo = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subject.prepare_fixture_root(root, repo)

            hooks = json.loads(
                (root / "fixtures" / "candidate-plugin-v10" / "hooks" / "hooks.json").read_text(
                    encoding="utf-8"
                )
            )

            self.assertIn("SessionStart", hooks["hooks"])

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
            {"at": 1, "hook_event_name": "SessionStart"},
            {"at": 2, "hook_event_name": "UserPromptSubmit"},
        ]

        self.assertTrue(driver._structured_event_after(events, "SessionStart", 0))
        self.assertFalse(driver._structured_event_after(events, "UserPromptSubmit", 2))
        self.assertTrue(driver._structured_event_after(events, "UserPromptSubmit", 1.5))

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
        evidence.append(item)

    for shape in ("managed-double", "plugin-only"):
        natural = next(
            item
            for item in evidence
            if item["install_shape"] == shape and item["prompt_kind"] == "natural"
        )
        for key in subject.CHAIN_FIELDS:
            natural[key] = True
    return evidence


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
