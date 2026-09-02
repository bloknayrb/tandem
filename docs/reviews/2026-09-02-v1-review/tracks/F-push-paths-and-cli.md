# Track F — Push paths and the CLI

**Tier:** Sonnet builds, Opus reviews; Fable only for the bridge identity design. **Decisions
needed:** none. **Release relation:** #1759 and #1790 break during an upgrade but the breaking
code is the already-installed bridge, so fixing them smooths every upgrade after the next one.
Fix them in the next minor for that reason.

## Issues

| Issue | What | Area |
|---|---|---|
| [#1759](https://github.com/bloknayrb/tandem/issues/1759) | The bridge identity check compares the server *name* only, or accepts a version change with a re-initialize; the retry backs off instead of minting a session every 30 s; the test changes version alone. | [shared-cli](../areas/shared-cli.md) |
| [#1760](https://github.com/bloknayrb/tandem/issues/1760) | A `--without-channel-shim` flag (or `--remove-channel-shim`) that removes the entry; the desktop target's intent computed after the override so a hand-registered shim survives; the three docs say what actually removes it. | [shared-cli](../areas/shared-cli.md) |
| [#1790](https://github.com/bloknayrb/tandem/issues/1790) | `installSkill` compares versions like `refreshExistingSkillIfStale`; the plugin pin moves with the release skill (a release-skill step and a wiring test that fails when `plugin.json` lags `package.json`); the skill content test hashes the body, not only the version number. | [upgrade-path](../areas/upgrade-path.md), [skill-plugin](../areas/skill-plugin.md) |
| [#1794](https://github.com/bloknayrb/tandem/issues/1794) | Deliver the permission verdict over SSE or delete the stub and its doc section. | [security](../areas/security.md) |
| [#1801](https://github.com/bloknayrb/tandem/issues/1801) | Raise or remove `MAX_CONFIG_BYTES`; a specific error; the boot sweep reports the stale path. | [server-runtime](../areas/server-runtime.md) |
| [#1802](https://github.com/bloknayrb/tandem/issues/1802) | `applyConfig` refuses a malformed `~/.claude.json` the way `readConfigForMutation` does, and the wizard shows the refusal. | [server-runtime](../areas/server-runtime.md), [shared-cli](../areas/shared-cli.md) |
| [#1804](https://github.com/bloknayrb/tandem/issues/1804) | Monitor and shim retry indefinitely with backoff (Claude Code never respawns them); the monitor's remedy text says what a user can actually do. | [shared-cli](../areas/shared-cli.md) |
| [#1805](https://github.com/bloknayrb/tandem/issues/1805) | The bridge stays up on preflight failure and retries; the message names every step. | [shared-cli](../areas/shared-cli.md) |
| [#1806](https://github.com/bloknayrb/tandem/issues/1806) | The CLI wrapper passes `TANDEM_PORT` / `TANDEM_MCP_PORT` to `runDoctor`. | [shared-cli](../areas/shared-cli.md) |
| [#1807](https://github.com/bloknayrb/tandem/issues/1807) | Doctor validates the user-level entry's url and type as it does the project-level one. | [shared-cli](../areas/shared-cli.md) |
| [#1811](https://github.com/bloknayrb/tandem/issues/1811) | Doctor detects plugin plus `setup --apply` and names the remedy; `setup --apply` warns when the plugin is installed. | [skill-plugin](../areas/skill-plugin.md) |

## Rules that bite here

- **Never run `tandem setup --apply` against the real `HOME`.** Every test of the config writer
  uses a scratch `HOME`; the review did the same.
- The shipped skill's frontmatter `version` must bump with any content change (#1790 is the
  consequence of forgetting).
- `X-Claude-Session-Id` is optional; the bridge and doctor must not assume it.
- Mutating integration routes need `assertOriginAllowlisted` and `assertLoopbackForMutation` at
  handler top; `claude-cli-status` stays enum-only.
- stdout is reserved in stdio mode.

## Reviewer agents

`security-reviewer` on #1794 (a new delivery path for a permission verdict), #1802 and #1801 (both
write the user's Claude config). Sonnet's PRs get an Opus review pass before merge.

## Done when

- A bridge test that changes `serverInfo.version` alone passes; the identity-fail path does not
  create a second server session.
- `setup --apply` under a scratch `HOME` can add, keep and remove the shim on every target, pinned
  by tests.
- `tests/scripts/` has a wiring test that fails when `plugin.json`'s pin lags `package.json`.
- `doctor` under `TANDEM_PORT=4918` finds a server on 4918.
- `docs/mcp-tools.md` no longer documents a relay that does not run, or the relay runs.

## Status

_(empty)_
