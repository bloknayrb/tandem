# Area: Documentation

**Raw:** [`../raw/findings-docs.txt`](../raw/findings-docs.txt) (Fable, resumed, 4 calls);
[`../raw/gapfill-B.txt`](../raw/gapfill-B.txt) (Sonnet, 111 calls against a 45 cap; accepted).
**Manifest:** [`../raw/manifests/docs.md`](../raw/manifests/docs.md).
**Track:** [J words](../tracks/J-words.md).
**Spot-check:** the `CTRL_ROOM.json` High confirmed; the README Cowork-tab High **refuted** by the
orchestrator (see [refuted.md](../refuted.md)); the relay stub confirmed and moved to the security
area (#1794).

Everything not listed here that the other areas tagged "doc drift" is collected in
[#1821](https://github.com/bloknayrb/tandem/issues/1821), forty verified items. That issue is the
work list; this file records what the docs reviewer found on its own.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `docs/troubleshooting.md:451,465`; `docs/configuration.md:109`; `constants.ts:245`; `manager.ts:361` | The recovery step says delete `sessions/CTRL_ROOM.json`; the real file is `__tandem_ctrl__.json`. Also `.markdown` omitted from the list and the quarantine name is `.corrupt.<ts>`, not `.corrupt.json`. | [read] | Source-confirmed | [#1782](https://github.com/bloknayrb/tandem/issues/1782) |
| — | `README.md:191` | "Cowork toggle is in Settings → Network" was the claim; the README says AI Assistant and that is where `CoworkSettings` mounts. | [read] | **Refuted** | — |
| M | `docs/mcp-tools.md:1334-1367`; `channel-routes.ts:152-160` | Documents a permission relay whose verdict is discarded. Filed as the code finding. | [read] | Source-confirmed | [#1794](https://github.com/bloknayrb/tandem/issues/1794) |
| M | twelve items | `data-locations.md:29` backup dir name; tutorial step 2 "chat completes it"; `mcp-tools.md:90,125` and `workflows.md:46` "auto-opens editor / :5173" stale; LICENSE 30-day evaluation vs README "free during beta"; `architecture.md:905` "ADR-001–050" (51) and `:1084` "six" skills (7); `architecture.md:452` shows raw `doc.transact` as canonical; `semantic-tokens.md:41` hex vs oklch; `user-guide.md:349` motion control absent; `user-guide.md:150` HTML "read support" vs plaintext adapter read+edit+save; `architecture.md:756-773` tutorial 3 vs 4 annotations; `cli.md:19` skill refresh claim. | [read] | Agent-reported, two spot-checked | [#1821](https://github.com/bloknayrb/tandem/issues/1821) |
| M | `README.md:51` vs `tauri-release.yml:148-175` | Linux floor "glibc 2.31 / Ubuntu 20.04" while CI builds on ubuntu-22.04 with webkit2gtk-4.1. Needs a 20.04 run: a [smoke line](../smoke-lines.md). | [inferred] | Lead | [#1821](https://github.com/bloknayrb/tandem/issues/1821) |
| L | eight items | `.env.example:16` wrong consumer; AGENTS.md omits `typecheck:tests`, the ADR-027 write guards and the stdio bridge; `user-guide.md:82` "Send to your AI" vs hardcoded "Send to Claude"; `mcp-tools.md:1050` route table markings; `integrations.md:21` "(Windows today)" (darwin too); `architecture.md:24,279,951,1025` drift; the "10-second undo window" is 3000 ms (`useAnnotationReview.svelte.ts:557`); `welcome.md:44` "customize any shortcut" (6 of 25 fixed); FormattingToolbar list omits Strikethrough; `troubleshooting.md:10` two vs three `.mcp.json` entries. | [read] | Agent-reported | [#1821](https://github.com/bloknayrb/tandem/issues/1821) |

## Verified fine

Ports and constants; the tool count (33) reproduced live; lessons 99; hooks 19+1; agents 11; the
"six" one-layer routes; `gatedTool` 13 + 2 direct; keybindings; Settings tabs including the hidden
Models tab; tray and update interval; file associations; token params; the licensing three-way
(`reason` enum matches the worker 5/5); `check:links` baseline; heading collapse exists
(`heading-collapse.ts`); the panel divider has keyboard support; the uninstall log path is exact.
