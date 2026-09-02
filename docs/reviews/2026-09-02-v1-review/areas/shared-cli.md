# Area: Shared code and CLI (stdio bridge, setup, doctor, monitor, channel shim)

**Raw:** [`../raw/findings-shared-cli.txt`](../raw/findings-shared-cli.txt) (Fable, resumed, 3 calls)
and [`../raw/gapfill-A.txt`](../raw/gapfill-A.txt) (Sonnet).
**Manifest:** [`../raw/manifests/shared-cli.md`](../raw/manifests/shared-cli.md).
**Track:** [F push paths and CLI](../tracks/F-push-paths-and-cli.md); Lows in [K](../tracks/K-tests-and-lows.md).
**Spot-check:** both Highs and the two `doctor` Mediums read at the cited lines. The shim-removal
claim was also run by the agent under a scratch `HOME`.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src/cli/mcp-stdio.ts:269,1095-1109`; `server.ts:242-245` | The bridge identity check compares `serverInfo` `tandem@APP_VERSION`, so every Tandem upgrade reads as "upstream identity changed" and the bridge answers `-32000` until Claude Desktop restarts (the #1588 outage, now once per release). The test at `:1947` changes name and version together, so it cannot see this. The identity-fail retry replays `initialize` every 30 s, minting a new server session each time (LRU churn). | [read] | Source-confirmed | [#1759](https://github.com/bloknayrb/tandem/issues/1759) |
| H | `setup.ts:193-202`; `apply.ts:2267-2275`; `README.md:230`; `CHANGELOG.md:328`; `architecture.md:577` | "Re-run `setup --apply` without the flag to remove the shim" is false: an absent flag preserves (`targetHasChannelEntry`). No CLI path removes the shim except uninstall. And `apply.ts:2272` makes `targetPushSupport === "none"` set intent false for `claude-desktop` before the override, so `--target=claude-desktop` deletes a hand-registered shim entry. | [ran] | Agent-ran (scratch HOME); source-confirmed | [#1760](https://github.com/bloknayrb/tandem/issues/1760) |
| M | `src/shared/sse-consumer.ts:167-223`; `monitor/run.ts:174-177` | Monitor and shim exit after five retries (~30 s); the monitor's "restart Tandem" remedy cannot work because Claude Code never respawns it (spike F9). | [read] | Agent-reported | [#1804](https://github.com/bloknayrb/tandem/issues/1804) |
| M | `mcp-stdio.ts:725,1233-1247` | The bridge exits on preflight failure although Desktop never respawns it; the message names only step one. | [read] | Agent-reported | [#1805](https://github.com/bloknayrb/tandem/issues/1805) |
| M | `src/cli/doctor.ts:2948` vs `:2819` | The CLI wrapper calls `runDoctor()` with no port options, so `TANDEM_PORT` / `TANDEM_MCP_PORT` are ignored: false "not running" and a remedy that starts a second instance. | [read] | Source-confirmed | [#1806](https://github.com/bloknayrb/tandem/issues/1806) |
| M | `doctor.ts:1163-1167` vs `:1017` | A user-level `~/.claude.json` entry passes on key presence with no url/type validation (false green on the wrong port or path). | [read] | Source-confirmed | [#1807](https://github.com/bloknayrb/tandem/issues/1807) |
| M | `integrations/api-routes.ts:~915-975` | The wizard surfaces nothing when `applyConfig` replaces a malformed config (the wizard-silence delta of #1802). | [read] | Agent-reported | [#1802](https://github.com/bloknayrb/tandem/issues/1802) |
| L | `src/channel/event-bridge.ts:19-33`; `run.ts:60-61` | The bridge forwards every event type but the instructions omit `annotation:edited`, the one carrying the user's rewrite. | [read] | Source-confirmed | [#1821](https://github.com/bloknayrb/tandem/issues/1821) |
| L | `setup.ts:198`; `cli/index.ts:52,58-59` | Symlinked `~/.claude.json` refusal says "check permissions"; `setup --apply` after `rotate-token` drops the token from entries; `--help` drift. | [read] | Agent-reported | [#1823](https://github.com/bloknayrb/tandem/issues/1823) |

## Leads not run

- `everConnected` latch is silent on first-connect failure.
- Windows EXDEV fallback in the atomic-write path.
- Does the channel forward `annotation:edited` end to end? (The bridge does; the consumer's
  instructions do not mention it.)

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

Shim removal (three docs); `cli.md:147` rotate-token rollback; `cli.md:140-146` exit code 2 missing;
`monitor/run.ts:279-282` "fail-closed to solo" stale; `architecture.md:454-466` event payload
table (reply/edited/highlight); `.env.example` missing three vars; `configuration.md` omits
`CLAUDE_PLUGIN_OPTION_*` precedence; `troubleshooting.md:54,94`; `CHANGELOG.md:84` #1588 claim
false across upgrades.

## Verified fine

stdout hygiene; channel meta keys use underscores; backpressure; SSE framing; both audits clean;
version constants; event union complete; `setup --apply` preservation, idempotency and backups;
rotate-token rollback; uninstall allowlist; `doctor --json` leaks nothing.
