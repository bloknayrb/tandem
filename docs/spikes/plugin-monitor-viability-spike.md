# Plugin Monitor Viability Spike (#477 Phase 0 / Spike B)

**Status:** Spike complete — **NO-GO on dropping `--dangerously-load-development-channels` in v1.0.**
**Date:** 2026-05-17
**Claude Code version tested:** 2.1.143
**Refs:** [#477](https://github.com/bloknayrb/tandem/issues/477) PR 4 (auto-launch supervisor), [Spike A](./cli-session-resume-spike.md), `docs/roadmap.md:421–447` (locked decision: "Plugin monitor is canonical; launcher drops `--dangerously-load-development-channels`").

## Goal

Validate two propositions:

- **B1 (parity)**: the plugin monitor (`src/monitor/index.ts`) and the channel shim (`src/channel/event-bridge.ts`) emit semantically equivalent payloads for the 9 channel event types.
- **B2 (distribution viability)**: Claude Code can be configured to invoke the plugin monitor *without* `--dangerously-load-development-channels`. This is the locked-decision gate in `docs/roadmap.md:442`.

B1 is resolvable from code-reading because both consumers share `parseTandemEvent` / `formatEventContent` / `formatEventMeta` from `src/shared/events/types.ts`. B2 is the load-bearing unknown — the question this spike actually had to answer.

## Non-goals

- Designing replacements for `--dangerously-load-development-channels` should the flag eventually be removed by Claude Code. Spike B's NO-GO verdict means the flag stays for v1.0; tracking follow-up is filed separately.
- Solo-mode filtering / replay / reconnect parity — covered by existing tests in `tests/monitor/sse-parsing.test.ts` and `tests/monitor/retry.test.ts`. Spike B cites these rather than re-proving them.

## Pre-flight findings

`claude --help` on v2.1.143:

- `--plugin-dir <path>` exists and is documented: "Load a plugin from a directory or .zip for this session only (repeatable: --plugin-dir A --plugin-dir B.zip)".
- `claude plugin install <plugin>` requires a marketplace, and v2.1.143 returns `× Failed to install plugin: This plugin uses a source type your Claude Code version does not support. Update Claude Code and try again.` for `path`-source plugins. Only `github`-source marketplace plugins install in v2.1.143.
- `--dangerously-load-development-channels` is **hidden from `--help` output** but **still functional** (Scenario 5 of Spike A; check 5 of this spike). The locked decision to drop it is a *choice*, not a *forced migration*.
- Tandem's existing `.claude-plugin/plugin.json` already declares `experimental.monitors[]` (see lines 27–35) pointing at `node ${CLAUDE_PLUGIN_ROOT}/dist/monitor/index.js`.

## B1 — Parity matrix (code-reading)

Both consumers connect to `GET /api/events` (the same SSE endpoint), share the same parsers and formatters, and have symmetric awareness / error postbacks. The transport differs — and that is the only material asymmetry.

| Property | Channel shim (`src/channel/event-bridge.ts`) | Plugin monitor (`src/monitor/index.ts`) |
|---|---|---|
| SSE endpoint | `${TANDEM_URL}${API_EVENTS}` | `${TANDEM_URL}${API_EVENTS}` |
| Reconnect / replay | `Last-Event-ID` header | `Last-Event-ID` header |
| Event parser | `parseTandemEvent` from `shared/events/types.ts` | `parseTandemEvent` from `shared/events/types.ts` |
| Per-event payload formatter | `formatEventContent` (+ `formatEventMeta` for MCP meta) | `formatEventContent` |
| 9 event types covered | `annotation:created|accepted|dismissed|reply|edited`, `chat:message`, `document:opened|closed|switched` | identical |
| Awareness postback | POSTs to `/api/channel-awareness` (debounced) | POSTs to `/api/channel-awareness` (debounced) |
| Error postback on exhaustion | POSTs to `/api/channel-error` | POSTs to `/api/channel-error` |
| Solo-mode filtering | Server-side via Y.Map `mode`; consumer reads `/api/mode` | Server-side via Y.Map `mode`; consumer reads `/api/mode` |
| **Transport (asymmetry)** | MCP `notifications/claude/channel` via `Server` handle | **stdout line per event** (plugin-host parses each `\n`-terminated line as a notification) |
| **Process model (asymmetry)** | Spawned by Claude as MCP child of `tandem-channel` | Declared in plugin manifest's `experimental.monitors[]`, spawned by Claude's plugin host |

### Correction to plan v1

Plan v1 (in `/root/.claude/plans/plan-out-both-spikes-wondrous-neumann.md`) and the original multi-angle review asserted that "the plugin monitor does NOT POST awareness/error." This is wrong. Both consumers POST. The transport difference is purely stdout-vs-MCP-notification — *not* a side-effect asymmetry. The probe's `side-effect-asymmetry-cataloged` check verifies this by grepping both source files.

### Existing test coverage cited (not re-proven)

- `tests/monitor/sse-parsing.test.ts` — covers the parser path used by both consumers via shared formatters.
- `tests/monitor/retry.test.ts` — covers reconnect / `Last-Event-ID` semantics.

## B2 — Distribution viability test

### Probe method

`scripts/spikes/probe-monitor-viability.ts` creates a stub plugin in a temp directory with an `experimental.monitors[]` command that writes a marker file on invoke:

```jsonc
{
  "name": "spike-b-stub",
  "experimental": {
    "monitors": [
      { "name": "spike-b-stub-monitor",
        "command": "sh -c 'echo MONITOR_INVOKED_$$ > <marker>; sleep 30'" }
    ]
  }
}
```

The probe spawns `claude -p` with `--plugin-dir <stub>` and checks for the marker.

### Result

**Marker file not created. Plugin monitor NOT activated.**

Three additional configurations were tested manually (not in the probe to keep runtime bounded):

| Configuration | Marker created? |
|---|---|
| `claude -p "..." --plugin-dir <stub>` | No |
| `claude -p "..." --plugin-dir <stub> --dangerously-load-development-channels noop:none` | No |
| `claude --plugin-dir <stub>` (interactive, faked TTY via `script(1)`, killed after 12s during welcome screen) | No |
| `claude plugin install spike-b-stub@<path-marketplace>` | Fails: "This plugin uses a source type your Claude Code version does not support." Path-source not in v2.1.143. |

`claude plugin marketplace add <github-url>` plus `claude plugin install <name>@<marketplace>` would be the production path. The path-source error confirms that **`--plugin-dir` is the *only* local-development path for Tandem in v2.1.143**, and that path does not activate `experimental.monitors[]`.

### Implication for PR 4

The locked decision in `docs/roadmap.md:442` ("Plugin monitor is canonical; launcher drops `--dangerously-load-development-channels`") is **not implementable in v2.1.143**. Spike A's Scenario 5 + this spike's Check 5 confirm that `--dangerously-load-development-channels` itself remains functional. PR 4's launcher should:

1. **Keep `--dangerously-load-development-channels server:tandem-channel`** in the spawn args for v1.0.
2. **Drop the bare `experimental.monitors[]` block from `.claude-plugin/plugin.json`** OR keep it as a forward-looking declaration (it's harmless; Claude Code just doesn't invoke it). Recommend keep — when Claude Code surfaces a `--plugin-dir`-compatible monitor activation, the manifest is already ready.
3. **File a follow-up issue** to revisit dropping the flag once Claude Code lifts one of:
   - `experimental.monitors[]` auto-activation under `--plugin-dir`
   - `path`-source plugin install (currently `github` only)
   - A new explicit flag (e.g. `--monitor-dir`) that supersedes `--dangerously-load-development-channels`

## What this spike validated

- **B1 parity is structural, not coincidental.** Both consumers import the same formatters from `shared/events/types.ts`. The probe's `shared-formatters-imported-by-both-consumers` check is a regression gate; if a future refactor breaks the shared-import invariant, this probe fails.
- **B2 distribution path is currently broken for Tandem.** `--plugin-dir` does not invoke `experimental.monitors[].command` in v2.1.143 under `--print` mode or during interactive startup (tested up to 12s past welcome screen).
- **The fallback is still alive.** `--dangerously-load-development-channels server:tandem-channel` still works in v2.1.143 despite the flag being hidden from `--help`.

## What this spike did NOT validate

- **Full interactive-session monitor activation.** The 12s-into-welcome-screen test killed Claude before any user interaction completed. It is conceivable that monitors activate later in the interactive session (e.g. after the workspace-trust dialog or a `/plugin` slash command). PR 4 should not depend on this; the conservative reading is that monitor activation requires the marketplace-install path.
- **GitHub-source marketplace install.** `claude plugin marketplace add github:bloknayrb/tandem` was not exercised. If that path activates monitors, dropping the flag could be revisited once Tandem is published as an installable marketplace plugin (separate v1.1+ work).
- **macOS / Windows parity.** Linux-only verification. Tandem ships on all three; PR 4 should reverify on at least macOS before relying on any of this spike's transport-layer findings.

## Security findings

- **Trust-boundary reframing (from security review N2):** the plugin monitor path is the *tighter* trust boundary in principle. Channel shim runs as Claude Code's child (inherits Claude's env); plugin monitor runs as Tandem's child (Tandem controls its env). This is a strong security argument for eventually adopting the plugin path — but only when distribution actually works. For now, the channel shim path is what works and is what PR 4 ships with.
- **Awareness/error postback gaps** raised in the planning phase do **not** apply: both consumers POST symmetrically. The follow-up issues planned for those gaps (`/api/plugin-awareness`, `/api/plugin-error`) are not needed.
- **Probe security hygiene** matches Spike A: minimal-env spawn (no `TANDEM_AUTH_TOKEN` forwarded), redaction of `$HOME` and UUIDs, PID-tracked cleanup, fresh `mkdtempSync` per run.

## Follow-up issues to file

| # | Concern | Tracked |
|---|---|---|
| F1 | Revisit dropping `--dangerously-load-development-channels` when Claude Code surfaces monitor activation from `--plugin-dir` (or any other zero-marketplace path) | New issue, v1.1+ |
| F2 | Publish Tandem to a GitHub-source marketplace and verify `claude plugin install tandem@tandem-editor` activates `experimental.monitors[].command` | New issue, v1.1+ |
| F3 | Update `docs/roadmap.md:442` to reflect that the "plugin monitor canonical / drop the flag" decision is conditional on Claude Code distribution changes, not a v1.0 invariant | Roadmap edit (small) |
| F4 | Cross-platform reverification (macOS, Windows) before PR 4 commits to either path | PR 4 own follow-up |

## Verdict

**NO-GO** on the locked decision. PR 4 retains `--dangerously-load-development-channels server:tandem-channel` for v1.0. The flag is functional in v2.1.143 and the locked decision was based on the assumption that `--plugin-dir` would activate `experimental.monitors[]` — that assumption does not hold empirically.

### NO-GO fallback (now active)

Per the plan, NO-GO fallbacks were defined upfront:

- **Fallback 1**: PR 4 keeps the flag (active path).
- **Fallback 2**: PR 4 ships with the channel shim path; plugin monitor stays opt-in / experimental (not relevant; the plugin monitor already exists, just isn't auto-activated).

## Artifacts

- `scripts/spikes/probe-monitor-viability.ts` — executable TypeScript probe; 3 code-reading checks + 1 distribution test + 1 fallback verification.
- This spike report.

Run: `npx tsx scripts/spikes/probe-monitor-viability.ts` (exits 0 when all checks pass; the B2 check passes by observing the no-activation behavior).

## Appendix — probe output (redacted)

```json
{
  "claudeVersion": "2.1.143 (Claude Code)",
  "checks": [
    { "name": "shared-formatters-imported-by-both-consumers", "pass": true },
    { "name": "both-consume-same-sse-endpoint-with-last-event-id", "pass": true },
    { "name": "side-effect-asymmetry-cataloged", "pass": true,
      "evidence": { "monitorPostsAwareness": true, "monitorPostsError": true,
                    "channelPostsAwareness": true, "channelPostsError": true,
                    "monitorWritesStdout": true, "channelEmitsMcpNotification": true } },
    { "name": "experimental.monitors-NOT-activated-by-plugin-dir-in-print-mode", "pass": true,
      "evidence": { "observedBehavior": "monitor-NOT-activated",
                    "pr4Implication": "PR 4 CANNOT drop --dangerously-load-development-channels in v2.1.143. Keep the flag; file follow-up for Claude Code support to activate experimental.monitors via --plugin-dir." } },
    { "name": "dev-channels-flag-still-functional-as-fallback", "pass": true }
  ],
  "passed": 5,
  "failed": 0,
  "verdict": "NO-GO on dropping --dangerously-load-development-channels in v1.0; fallback (the flag itself) is intact."
}
```
