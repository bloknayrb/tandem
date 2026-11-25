# What the launched Claude Code inherits, and what it needs (#2479)

Status: facts for a decision that is still Bryan's. Written 2026-11-24. Nothing here changes
which third-party variables reach the launched session; the only code change made with it
removes two of Tandem's own start-up signals (below).

#2479 asks whether the launcher should keep passing its environment through (today), strip
variables Claude Code does not need, or pass an allow-list. Bryan's decision so far
(2026-11-19): file the issue, no change in 0.32, no fix chosen. This page lands the facts the
issue asked to be established, so the choice can be made from tracked files.

## Where the child's environment is built

One function, `childEnv()` in `src/server/launcher/supervisor.ts`. Both uses go through it:
the `spawn` of the reaper that execs `claude`, and `collectTandemPluginKeys` (which reads the
same environment to find the user's settings). It copies `process.env` and deletes:

| Group | Keys | Why |
|---|---|---|
| `DESKTOP_ONLY_ENV_KEYS` | `TANDEM_APP_DATA_DIR`, `TANDEM_DATA_DIR` | #1787: a nested `tandem` must not claim the desktop's app-data root |
| `TANDEM_SECRET_ENV_KEYS` | `TANDEM_AUTH_TOKEN`, `CLAUDE_PLUGIN_OPTION_AUTH_TOKEN`, `TANDEM_SENTRY_DSN`, `TANDEM_OWNER_HANDLE`, `TANDEM_OWNER_HANDLE_URL` | #1822 item 4, #2358 PR 3a |
| `SIDECAR_SIGNAL_ENV_KEYS` (new) | `TANDEM_OPEN_FILE`, `TANDEM_DEFER_LAUNCHER` | #2479: one-shot start-up signals for this server only |
| sidecar only (argv) | `NODE_ENV` | #1822 item 6 |

Everything else is inherited, and every command the session runs inherits it in turn.

## What the desktop sidecar adds

`sidecar.rs` (`sidecar_env_pairs` and the spawn chain) sets, on top of the shell's own
environment (`tauri-plugin-shell` never calls `env_clear()`): `TANDEM_TAURI_SIDECAR`,
`TANDEM_DATA_DIR`, `TANDEM_APP_DATA_DIR`, `TANDEM_PORT`, `TANDEM_MCP_PORT`, `TANDEM_BIND_HOST`,
`NODE_ENV=production` (release builds), `TANDEM_AUTH_TOKEN`, `TANDEM_CHANNEL_DIST`,
`TANDEM_STDIO_BRIDGE_DIST`, `TANDEM_SENTRY_DSN` (opt-in), `TANDEM_DEFER_LAUNCHER`
(start-at-login) and `TANDEM_OPEN_FILE` (cold-start file open, first spawn only).

The two newly stripped are read only at this server's start (`src/server/index.ts`,
`launcher/initial-reason.ts`). Kept, a `tandem` started from the session's shell would reopen
the cold-start document, and — because `TANDEM_TAURI_SIDECAR=1` is deliberately still inherited —
hold its own launcher on the start-at-login deferral. The remaining `TANDEM_*` keys are left
alone: the port and bind keys tell a nested `tandem doctor` or CLI where the running server is,
and the two `*_DIST` keys feed `tandem setup --apply` (`integrations/apply.ts`).

So on the desktop, the third-party variables #2479 is about come from the environment the
desktop app itself was started with: on Windows that includes the user's environment variables
set in System Properties; on macOS a Finder or login launch gets launchd's environment, not a
shell's exports. For `tandem` from npm it is the shell that ran it — the same environment a
`claude` typed in that shell would get.

## What Claude Code reads from its environment

Verified statically against the Claude Code 2.1.331 Linux binary (the one installed in the
cloud container this was written in), by listing the string literals of the form
`process.env.NAME`:
`strings -n 8 "$(readlink -f "$(command -v claude)")" | grep -oE 'process\.env\.[A-Za-z_][A-Za-z0-9_]*' | sort -u`.

- 423 distinct names from that command, 147 of them starting `ANTHROPIC_` or `CLAUDE_`, plus
  210 occurrences of a computed `process.env[...]` read whose name a static scan cannot see.
  The exact counts move with the extraction method (an earlier pass counted 409 and 148); the
  order of magnitude is what matters here.
- Among the rest are names any allow-list would have to carry: `PATH`, `PATHEXT`, `HOME`,
  `APPDATA`, `LOCALAPPDATA`, `SYSTEMROOT`, `COMSPEC`, `SHELL`, `TERM`, `TZ`, `USER`,
  `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`,
  `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`, `NODE_USE_ENV_PROXY`, `SSL_CERT_FILE`,
  `NODE_OPTIONS`, `DISABLE_TELEMETRY`, `DISABLE_AUTOUPDATER`, `DISABLE_ERROR_REPORTING`,
  `MAX_THINKING_TOKENS`, `BASH_MAX_OUTPUT_LENGTH`.
- **Credential-shaped names Claude Code reads for its own sake**: `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_REGION` (Bedrock),
  `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUD_ML_REGION`, `GOOGLE_CLOUD_PROJECT` (Vertex),
  `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` and more (Foundry),
  `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `MCP_CLIENT_SECRET`.

Not verified here (assumed from Claude Code's documented behaviour, not re-checked against a
build): that MCP server configs expand `${VAR}` from Claude Code's environment, and that the
Bash tool's commands run with Claude Code's environment. Both mean that the variables a user's
own tools need — an MCP server's API key, `JAVA_HOME`, `VIRTUAL_ENV`, `SSH_AUTH_SOCK`,
`KUBECONFIG` — are needed by the launched session even though Claude Code never names them.

A static scan of one build is a lower bound for that build and says nothing about the next one.

## The options and what each costs

1. **Pass through (today).** The launched session sees what a `claude` started by hand from the
   same environment would see. Cost: the issue as filed — every variable, a third-party API key
   included, reaches the session and every command it runs.
2. **Allow-list.** Smallest exposure. Cost: the list has to name every variable Claude Code reads
   (400+ in one build, some computed, changing per release) and every variable the user's MCP
   servers and toolchains need, which Tandem cannot know. A miss fails silently: a Bedrock or
   Vertex user cannot authenticate, a proxy or CA setting vanishes, an MCP server starts without
   its key. The existing spec (`docs/reviews/2026-09-02-v1-review/tracks/specs/K-sec-launcher-1822.md`
   4b) and `docs/security.md` rejected this for that reason, and `supervisor.test.ts` pins a
   surviving `SOME_USER_TOOL_CONFIG` against it.
3. **Name-pattern denylist** (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, …, minus Claude Code's own).
   Cost: the same silent failures for exactly the variables a user exported so their tools
   would see them (an MCP server's key, `GH_TOKEN` for `gh`), while a secret under any other
   name still passes. The exception list is option 2's problem again for the names Claude Code
   reads (the credential-shaped list above).
4. **A user setting** (for example an opt-in "launch Claude with a minimal environment", or a
   user-written pass-through list in `launcher-settings.json`). Cost: a new setting, UI and
   copy; the default is still one of the above.

Whichever is chosen, the decision is about the world (what users keep in their environment and
what their tools need), so per #1606 it is Bryan's, and its evidence should be added here.
