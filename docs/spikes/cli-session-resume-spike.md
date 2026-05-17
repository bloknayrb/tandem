# Claude Code Session Resume Spike (#477 Phase 0 / Spike A)

**Status:** Spike complete — **GO** (with named caveats).
**Date:** 2026-05-17
**Claude Code version tested:** 2.1.143
**Refs:** [#477](https://github.com/bloknayrb/tandem/issues/477) PR 4 (auto-launch supervisor), [#640](https://github.com/bloknayrb/tandem/pull/640) Spike C (precedent), `docs/roadmap.md:412–447`, anthropics/claude-code#44607.

**Scope of validation:** validates the **Claude default integration** per [ADR-038](../decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration). Equivalent session-resume validation against other MCP-capable clients is best-effort and tracked separately.

## Goal

Empirically validate that the auto-launch supervisor (#477 PR 4) can spawn Claude Code with a stable session identifier, kill and respawn, and have Claude recover prior conversation transcript. The *flag name* and contract semantics had to be probed against the installed binary; the multi-angle plan review surfaced conflicting assumptions about what flags actually exist in v2.1.143.

## Non-goals

- Designing PR 4's session-ID persistence model (per-server-startup vs durable per-user under `env-paths`). Spike records constraints; PR 4 decides.
- Cross-platform parity. Probe ran on Linux only; macOS / Windows verification deferred to PR 4 with platform-specific follow-up issues to be filed if a platform-specific gotcha surfaces.
- Multi-Tandem-window concurrent-launcher semantics. PR-4 design question.
- Modifying `src/server/mcp/launcher.ts` to consume a session ID. Spike A's manual smoke would have used a `TANDEM_CLAUDE_SESSION_ID` env-var read; that one-line change is deferred to PR 4 because the probe already establishes the contract empirically without needing the launcher in the loop.

## Pre-flight (the methodology corrections)

Pre-flight against the installed binary corrected two assumption errors from the planning phase:

1. **`claude --session-id <uuid>` IS a documented public flag** in v2.1.143 (the multi-angle reviewer was citing older docs). `claude --help` reveals it: `--session-id <uuid>  Use a specific session ID for the conversation (must be a valid UUID)`. The original plan's harness contract is buildable as written.
2. **`--dangerously-load-development-channels` is hidden from `claude --help` output** but still functional (Scenario 5 below). The locked decision to "drop the flag" (`docs/roadmap.md:442`) is a choice, not a forced migration.

Pre-flight also surfaced a methodology constraint that itself becomes a PR-4 finding (caveat C1 below): without isolating `cwd` and overriding the system prompt, Claude auto-loads CLAUDE.md from the parent directory and reinterprets prompts. The probe uses `mkdtempSync` + `--system-prompt` to neutralise this.

## Acceptance criteria & results

All scenarios produce structured `{ name, pass, evidence, repro }` records. Probe at `scripts/spikes/probe-session-resume.ts`. Full output appended below.

| # | Scenario | Result | Key evidence |
|---|---|---|---|
| 1 | `--session-id <fresh-uuid>` creates a session and echoes the UUID in JSON output | **PASS** | `requested == returned` session_id; exit 0 |
| 2 | `--resume <id>` re-attaches and the transcript is preserved | **PASS** | Seeded `SUNFLOWER-<rand>`; recall returned the literal token |
| 3 | Invalid UUID rejected with clear error | **PASS** | exit 1, stderr: `Error: Invalid session ID. Must be a valid UUID.` |
| 4 | `--resume <nonexistent-uuid>` — what actually happens | **PASS** (observational) | exit 1, stderr: `No conversation found with session ID: <id>` — clean failure, **not silent fresh-start** |
| 5 | `--dangerously-load-development-channels` still accepted in v2.1.143 | **PASS** | exit 0; flag is hidden from `--help` but functional |
| 6 | ENOENT pathway clean for missing binary | **PASS** | `err.code === "ENOENT"` |

**6/6 pass.**

### Scenario 4 detail — the gotcha that wasn't

An earlier manual test of `--resume <uuid-never-created>` from a *non-bare*, *empty-cwd* run appeared to silently create a fresh session (exit 0, fresh response). The probe could not reproduce that outcome under any condition tested. v2.1.143's `--resume` returns exit 1 with `No conversation found with session ID: <id>` on stderr. **PR 4 implication:** catch non-zero exit, parse stderr for `No conversation found`, fall back to a fresh `--session-id <new-uuid>` spawn. No pre-validation against `~/.claude/projects/...` filesystem is required — the CLI itself errors cleanly.

## What this spike validated

- **The CLI contract is buildable and stable in v2.1.143.** All four primitives PR 4 needs work: generate UUID v4 → spawn with `--session-id <uuid>` → kill → respawn with `--resume <uuid>` → transcript preserved.
- **Both `--print` / headless and interactive modes accept the flags.** The probe used `claude -p` for automation; interactive mode (no `-p`) accepts the same flags per `--help`. PR 4's interactive supervisor can pass the same args.
- **Hidden-but-functional dev-channels flag.** PR 4 retains the option to keep `--dangerously-load-development-channels server:tandem-channel` if Spike B's plugin path NO-GOs, since the flag is still accepted in v2.1.143.

## What this spike did NOT validate

- **Cross-platform parity** (Linux only). macOS / Windows verification is a follow-up. The `~/.claude/projects/<project>/<session-id>.jsonl` path is per-OS in Claude Code; PR 4 must not assume the Linux path layout.
- **`TANDEM_CLAUDE_SESSION_ID` env-var injection into `src/server/mcp/launcher.ts`.** The plan envisioned this as a separate one-line micro-PR landed before the spike to enable manual smoke against `dev:standalone`. The probe established the contract empirically without that hook; PR 4 will own the launcher change.
- **Interactive (non-`-p`) session-ID behavior.** Per `--help`, the flag works in both modes, but interactive mode's TTY requirement was not exercised. PR 4's interactive supervisor will exercise this in its own integration test.
- **Concurrent launchers with the same `--session-id`.** This is a PR-4 design question (per-Tandem-instance vs per-user lifetime). Cut from spike scope.

## PR 4 caveats (to file as follow-up issues)

| # | Caveat | Required handling in PR 4 |
|---|---|---|
| C1 | **`cwd` matters.** Claude auto-loads CLAUDE.md from the parent directory and incorporates it into every reply. Spawning the same `--resume <id>` from different cwds produces different model behavior even though the transcript is the same. | PR 4 must pin the launcher's cwd deterministically (likely the active Tandem document's directory, or `os.homedir()` for ephemeral sessions). Document the choice in the launcher's comment. |
| C2 | **`--resume <nonexistent>` failure must be caught.** Exit 1 + `No conversation found with session ID:` on stderr. | PR 4 wraps `--resume` in a try-catch; on failure regenerates a fresh UUID and retries with `--session-id <new>`. Surface a user-visible toast: "Previous Claude session expired — starting fresh." |
| C3 | **UUID validation is strict.** Invalid UUIDs exit 1 with `Error: Invalid session ID. Must be a valid UUID.` PR 4 must use `crypto.randomUUID()` (which produces RFC 4122 v4) — not any other format. | Already correct per security review (M1 — v4 random, not v7 time-ordered). Encode as a unit test: "session ID must validate as RFC 4122 v4." |
| C4 | **Session ID is a non-secret identifier.** It appears in `ps aux`, in JSON output, in stderr error messages. PR 4 must not rely on its unguessability for any security boundary. | Documented in launcher comment. No `SetSecurityInfo`-style hardening on the session ID itself; just the auth token (see #643). |
| C5 | **Hidden-but-functional `--dangerously-load-development-channels`.** If Spike B's plugin path NO-GOs, PR 4 can keep this flag; the spike empirically confirms it still works in v2.1.143 despite being absent from `--help`. | Cross-link Spike B's verdict; do not pre-commit to dropping the flag until Spike B is settled. |
| C6 | **`anthropics/claude-code#44607` is about the OPPOSITE problem.** The referenced issue asks for a way to read the session ID from *within* a running session (for in-session automation). That's not what PR 4 needs — PR 4 controls the session ID externally via `--session-id`. | Update `docs/roadmap.md:421–424` to remove the misleading reference; cite this spike instead. |

## Verdict

**GO with caveats.** Recommended PR-4 implementation contract:

```
const sessionId = randomUUID();          // v4
const args = [
  "--session-id", sessionId,             // first spawn only
  // (omit on respawn; use --resume instead)
  // ... other launcher args, possibly including
  // --dangerously-load-development-channels server:tandem-channel (pending Spike B)
];

// On respawn after Claude exit:
const respawnArgs = ["--resume", sessionId, /* ...same other args */];
// On exit code 1 with "No conversation found" stderr → regenerate sessionId and re-spawn fresh.
```

### NO-GO fallback (not triggered; documented for completeness)

The plan defined two fallbacks if Spike A had NO-GO'd. Neither is needed:

- **Fallback 1** (PR 4 spawns Claude fresh every time, no `--resume`): unnecessary — `--resume` works.
- **Fallback 2** (PR 4 hides the launcher; manual `claude` invocation): unnecessary — auto-launch is viable.

## Artifacts

- `scripts/spikes/probe-session-resume.ts` — executable TypeScript probe; six scenarios; PID-tracked cleanup; UUID-redacted output; minimal-env spawn (no `TANDEM_AUTH_TOKEN` forwarded).
- This spike report.

Run: `npx tsx scripts/spikes/probe-session-resume.ts` (exits 0 on full pass).

## Security validation performed during the spike

- `git diff origin/master..HEAD | grep -E 'sk-ant-|OAUTH|sess-|Bearer '` returned no real-credential matches.
- Probe spawns construct env from an explicit allowlist (`PATH`, `HOME`/`USERPROFILE`, locale, `TERM`); `TANDEM_AUTH_TOKEN` is explicitly excluded with a stderr warning if set in the parent env.
- Probe captured stdout/stderr is redacted (`<SESSION_UUID>`, `<HOME>`, `<TANDEM_TOKEN>`) before printing or writing.
- All spawned children are tracked in a `Set<ChildProcess>`; `SIGINT` / `SIGTERM` / `uncaughtException` handlers SIGTERM-then-SIGKILL them.
- Process kills are by recorded PID, never `pkill -f` regex.
- Probe `cwd` is a fresh `mkdtempSync(joinPath(tmpdir(), "tandem-spike-A-"))` per run; auto-deleted on `process.on("exit")`.

## Appendix — probe output (redacted)

```json
{
  "claudeVersion": "2.1.143 (Claude Code)",
  "scenarios": [
    {
      "name": "fresh-session-with-explicit-uuid",
      "pass": true,
      "evidence": {
        "requestedSessionId": "<SESSION_UUID>",
        "returnedSessionId": "<SESSION_UUID>",
        "result": "READY",
        "exitCode": 0
      }
    },
    {
      "name": "resume-carries-context",
      "pass": true,
      "evidence": {
        "seededToken": "SUNFLOWER-<rand>",
        "seedResult": "OK",
        "recallResult": "SUNFLOWER-<rand>",
        "modelEchoedToken": true
      }
    },
    {
      "name": "bad-uuid-rejected",
      "pass": true,
      "evidence": {
        "exitStatus": 1,
        "stderrSnippet": "Error: Invalid session ID. Must be a valid UUID."
      }
    },
    {
      "name": "resume-nonexistent-behavior",
      "pass": true,
      "evidence": {
        "observedBehavior": "rejected-non-zero-exit",
        "pr4Implication": "PR 4 must catch the non-zero exit, parse stderr for the error class, and fall back to fresh-spawn.",
        "exitCode": 1,
        "stderrSnippet": "No conversation found with session ID: <SESSION_UUID>"
      }
    },
    {
      "name": "dev-channels-flag-still-accepted-v2.1.143",
      "pass": true,
      "evidence": {
        "exitCode": 0,
        "result": "READY.",
        "note": "Hidden from --help; still functional."
      }
    },
    {
      "name": "enoent-pathway-clean",
      "pass": true,
      "evidence": {
        "errCode": "ENOENT"
      }
    }
  ],
  "passed": 6,
  "failed": 0
}
```
