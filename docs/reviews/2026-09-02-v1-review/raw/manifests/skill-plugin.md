# Coverage manifest: skill-plugin

Generated from the agent transcript. Zero model tokens.

## Files touched (70)
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/blav3wwb8.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/mcp-github-list_commits-1788356309486.txt
- <scratchpad>/open-issues.txt
- docs/architecture.md
- docs/decisions.md
- docs/integrations.md
- docs/mcp-tools.md
- docs/spikes/
- docs/spikes/plugin-delivery.md
- docs/spikes/plugin-monitor-tty-activation.md
- docs/troubleshooting.md
- docs/user-guide.md
- docs/workflows.md
- skills/tandem/SKILL.md
- src/channel/run.ts
- src/cli/index.ts
- src/cli/mcp-stdio.ts
- src/cli/skill-content.ts
- src/client
- src/client/actions/keybindings.ts
- src/client/components/OnboardingTutorial.svelte
- src/client/hooks/useTutorial.svelte.ts
- src/client/keybindings
- src/client/panels/useAnnotationReview.svelte.ts
- src/client/shortcuts
- src/client/utils/keybind
- src/monitor/
- src/monitor/index.ts
- src/monitor/run.ts
- src/server
- src/server/
- src/server/annotations/
- src/server/annotations/lifecycle.ts
- src/server/documents/open.ts
- src/server/events/sse.ts
- src/server/file-io/
- src/server/file-io/tutorial.ts
- src/server/integrations/apply.ts
- src/server/launcher/
- src/server/launcher/supervisor.ts
- src/server/mcp/
- src/server/mcp/annotations.ts
- src/server/mcp/awareness.ts
- src/server/mcp/channel-routes.ts
- src/server/mcp/convert.ts
- src/server/mcp/diagnostics.ts
- src/server/mcp/document-model.ts
- src/server/mcp/document.ts
- src/server/mcp/docx-apply.ts
- src/server/mcp/navigation.ts
- src/server/mcp/output-schemas.ts
- src/server/mcp/routes
- src/server/mcp/routes/
- src/server/mcp/server.ts
- src/server/mcp/tools
- src/server/mcp/tutorial-annotations.ts
- src/server/mcp/wake-advisory.ts
- src/shared/
- src/shared/constants.ts
- src/shared/events/types.ts
- src/shared/events/wake-scope.ts
- src/shared/launcher/
- src/shared/launcher/contract.ts
- src/shared/types.ts
- tests/plugin
- tests/plugin-manifest.test.ts
- tests/plugin-version-pin.test.ts
- tests/plugin/
- tests/plugin/plugin-version-pin.test.ts
- tests/skill-instruction-contract.test.ts

## Commands run (74)
- `cat -n skills/tandem/SKILL.md`
- `find .claude-plugin -type f | sort && echo "-----" && for f in $(find .claude-plugin -type f | sort); do echo "=== $f ==="; cat -n "$f"; echo; done`
- `ls -la src/monitor/ && echo ---- && wc -l src/monitor/* && echo ---- && ls tests/plugin/ 2>/dev/null; ls tests/ | head -80; echo ----; ls src/server/mcp/; echo `
- `cat -n src/monitor/index.ts src/monitor/run.ts`
- `cat -n sample/welcome.md; echo "=== tutorial.ts ==="; cat -n src/server/file-io/tutorial.ts; echo "=== tutorial-annotations.ts ==="; cat -n src/server/mcp/tutor`
- `cat -n tests/skill-instruction-contract.test.ts`
- `cat -n tests/plugin-manifest.test.ts; echo "=== version-pin ==="; cat -n tests/plugin-version-pin.test.ts; echo "=== tests/plugin ==="; ls -la tests/plugin; for`
- `git log --follow --format='%h %ad %s' --date=short -- skills/tandem/SKILL.md | head -80; echo "=== version per commit ==="; for c in $(git log --follow --format`
- `git rev-list --count HEAD; test -f .git/shallow && echo "SHALLOW CLONE" || echo "not shallow"; git log --oneline | wc -l; git log -1 --format='%h %ad %s' --date`
- `gh api "repos/bloknayrb/tandem/commits?path=skills/tandem/SKILL.md&per_page=100" --jq '.[] | "\(.sha[0:9]) \(.commit.author.date[0:10]) \(.commit.message | spli`
- `cat -n docs/workflows.md`
- `wc -l docs/mcp-tools.md docs/user-guide.md docs/decisions.md docs/spikes/plugin-monitor-tty-activation.md src/server/mcp/server.ts src/server/integrations/apply`
- `cat -n docs/spikes/plugin-monitor-tty-activation.md`
- `grep -rn -i "tutorial" src/client --include=*.svelte --include=*.ts -l | sort; echo "=== constants ==="; grep -n -E 'CLAUDE_PLUGIN_INSTALL_COMMANDS|TUTORIAL_ANN`
- `python3 - <<'EOF' import json p="<transcript-path>`
- `sed -n '40,560p' <transcript tool result, not kept>`
- `sed -n '1,700p' docs/mcp-tools.md`
- `sed -n '700,1422p' docs/mcp-tools.md`
- `sed -n '302,320p' docs/decisions.md; echo "=== ADR-038 ==="; sed -n '1185,1240p' docs/decisions.md; echo "=== ADR-049 ==="; sed -n '1788,1858p' docs/decisions.m`
- `grep -rn -E '\.(tool|registerTool)\(|registerTool\b|name: "tandem_' src/server/mcp/*.ts | grep -v test | head -80; echo "=== files defining tools ==="; grep -rl`
- `cat -n src/client/components/OnboardingTutorial.svelte; echo "=== useTutorial ==="; cat -n src/client/hooks/useTutorial.svelte.ts`
- `grep -n -E 'mcpServers|"type"|type: "http"|"url"|url:|/mcp|headers|X-Tandem|Authorization|SKILL|skills|version' src/server/integrations/apply.ts | head -120`
- `cat -n src/cli/index.ts`
- `for sha in 73d9041e3 fcade54a4 1818f2595 e71b75feb 33b3fb56f e3f120d23 d3e8cba6f 4ad567c5f ac517f0a7 3c92732d7 6261ea460 1c9a9306a c47aed758 4cf2544aa 0c8978a8d`
- `sed -n '1,300p' <repo>/docs/mcp-tools.md`
- `sed -n '300,600p' <repo>/docs/mcp-tools.md`
- `sed -n '600,900p' <repo>/docs/mcp-tools.md`
- `sed -n '900,1180p' <repo>/docs/mcp-tools.md`
- `sed -n '1180,1422p' <repo>/docs/mcp-tools.md`
- `sed -n '1,270p' <repo>/docs/user-guide.md`
- `sed -n '270,527p' <repo>/docs/user-guide.md`
- `sed -n '302,320p' <repo>/docs/decisions.md | cut -c1-3000; echo "=== ADR-049 ==="; sed -n '1788,1858p' <repo>/docs/decisions.md`
- `sed -n '1185,1215p' <repo>/docs/decisions.md | cut -c1-2500`
- `sed -n '95,330p' <repo>/docs/spikes/plugin-monitor-tty-activation.md`
- `sed -n '330,560p' <repo>/docs/spikes/plugin-monitor-tty-activation.md`
- `sed -n '220,470p' <repo>/src/server/mcp/annotations.ts`
- `sed -n '470,900p' <repo>/src/server/mcp/annotations.ts`
- `sed -n '230,520p' <repo>/src/server/mcp/awareness.ts`
- `sed -n '380,620p' <repo>/src/server/mcp/document.ts`
- `sed -n '620,1000p' <repo>/src/server/mcp/document.ts`
- `sed -n '1000,1340p' <repo>/src/server/mcp/document.ts`
- `sed -n '115,200p' <repo>/src/server/mcp/navigation.ts; echo "=== docx-apply ==="; sed -n '430,540p' <repo>/src/server/mcp/docx-apply.ts; e`
- `cat -n src/cli/skill-content.ts 2>/dev/null | head -60; echo "=== tsup skill ==="; grep -n -i 'skill' tsup.config.ts | head -20; echo "=== wake-scope ==="; cat `
- `ls src/client/keybindings* src/client/utils/keybind* src/client/shortcuts* 2>/dev/null; grep -rln -i 'keybinding\|shortcut' src/client --include=*.ts | head -20`
- `grep -rn -E 'Relaunch Claude|AI Assistant|Working directory|New Scratchpad|Annotate' src/client --include=*.svelte --include=*.ts | grep -v -i '\.test\.' | grep`
- `cd <scratchpad> && for sha in c47aed758 1c9a9306a 6261ea460 3c92732d7 4ad567c5f d3e8cba6f 73d`
- `git tag -l | tail -20; echo "=== CHANGELOG headings ==="; grep -n -E '^## \[' CHANGELOG.md | head -20`
- `grep -n -B3 -A40 'SERVER_INSTRUCTIONS' src/server/mcp/server.ts | head -120; echo "=== getWakeEndpoint ==="; grep -rn -A12 'export function getWakeEndpoint' src`
- `cat -n src/server/mcp/wake-advisory.ts | head -150`
- `grep -rn 'injectTutorialAnnotations' src --include=*.ts | grep -v test; echo "=== alreadyOpen in open.ts ==="; grep -n -B5 -A25 'alreadyOpen' src/server/documen`
- `grep -rn 'author: "import"' src/server --include=*.ts | grep -v test | head -20; echo "=== type note for imports ==="; grep -rn -B3 -A3 'type: "note"' src/serve`
- `grep -n -E 'type: "|"selection|anchor' src/shared/events/types.ts | head -60; echo "=== ChatMessage type ==="; grep -n -B2 -A25 'export interface ChatMessage' s`
- `grep -n -E 'filter|wake' src/server/mcp/channel-routes.ts | head -40; echo "=== supervisor bootstrap text ==="; grep -n -E 'woken|Tandem launched|launcher|boots`
- `ls -la | grep -E '^d' ; echo "=== hooks/commands/agents at root? ==="; ls -d hooks commands agents skills 2>&1; echo "=== README plugin section ==="; grep -n -i`
- `grep -n -i -E 'double-installed|plugin-only|tandem-channel|inert' docs/troubleshooting.md | head -30; echo "=== index in getOutline ==="; grep -n -B3 -A20 'expo`
- `grep -rn 'focusParagraph' src/client --include=*.ts --include=*.svelte | grep -v test | head -15; echo "=== Monitor invocation in spikes ==="; grep -rn -E 'pers`
- `grep -rn -i -E 'tandem-channel|inert' docs/spikes/plugin-delivery.md docs/architecture.md docs/integrations.md 2>/dev/null | head -30; echo "=== channel run: ne`
- `for tag in v0.16.0 v0.17.0 v0.18.0 v0.19.0 v0.20.0 v0.20.1 v0.21.0 v0.22.0 v0.22.1 v0.23.0 v0.24.0 v0.24.1; do out=$(curl -sS --max-time 30 "https://raw.githubu`
- `sed -n '560,580p' docs/architecture.md | cut -c1-1500`
- `grep -rn -E 'function getOutline|function getSection' src/server | head; echo "=== api/events route & filter ==="; grep -rn -E '"/api/events"|filter.*wake|query`
- `grep -rn -i -E 'BOOTSTRAP|woken|Tandem launched' src/server/launcher/*.ts src/shared/launcher/*.ts | grep -v test | head -20`
- `grep -n -E '#1460|#1486|#1622|#1463|INVALID_ARGUMENT' CHANGELOG.md | head -20; echo "=== open.ts welcome gate ==="; sed -n '440,465p' src/server/documents/open.`
- `timeout 300 npx vitest run tests/skill-instruction-contract.test.ts tests/plugin-manifest.test.ts tests/plugin/plugin-version-pin.test.ts 2>&1 | tail -25`
- `grep -n -B2 -A12 'function getOutline' src/server/mcp/document-model.ts src/shared/*.ts src/server/*.ts 2>/dev/null | head -60; echo "=== getSection ==="; grep `
- `sed -n '190,262p' src/server/mcp/document.ts`
- `sed -n '255,330p' src/shared/launcher/contract.ts`
- `sed -n '1,60p' src/server/events/sse.ts; echo "=== channel startEventBridge ==="; grep -n -B3 -A10 'startEventBridge' src/channel/run.ts | head -60`
- `grep -rn 'read-only (.docx)' src tests | head; echo "=== stdio bridge message ==="; grep -n -B2 -A6 'not running' src/cli/mcp-stdio.ts | head -40; echo "=== out`
- `grep -n -i -E 'both the plugin|two copies|duplicate|twice|plugin.*setup --apply|setup --apply.*plugin' docs/troubleshooting.md README.md docs/integrations.md 2>`
- `sed -n '195,214p' README.md`
- `grep -n -B3 -A30 'acceptAnnotation(id' src/server/annotations/lifecycle.ts | head -80; echo "=== does MCP accept apply suggestedText? ==="; grep -rn -i 'suggest`
- `grep -rn -i -E 'applySuggestion|apply.*suggestedText|suggestedText.*replace' src/server --include=*.ts | grep -v test | head -10; echo "=== client side accept a`
- `grep -n -i -E 'suggestedText|replaceText|insertContent|applyAccept' src/client/panels/useAnnotationReview.svelte.ts | head -12; echo "=== server lifecycle accep`
- `sed -n '505,545p' src/client/panels/useAnnotationReview.svelte.ts; echo "=== 575-600 ==="; sed -n '575,600p' src/client/panels/useAnnotationReview.svelte.ts`

## Probe/executed outputs (4)

### for sha in 73d9041e3 fcade54a4 1818f2595 e71b75feb 33b3fb56f e3f120d23 d3e8cba6f 4ad567c5f ac517f0a7 3c92732d7 6261ea460 1c9a9306a c47aed758 4cf2544aa 0c8978a8d 6f0941030 3deae339d f82800560 ddef4620d
(output 2518 chars)
```
73d9041e3 exit=0 lines=196 md5=9a200caf version: 12 :: --- name: tandem version: 12 description: >   Use before the
fcade54a4 exit=0 lines=153 md5=73b09759 version: 11 :: --- name: tandem version: 11 description: >   Use before the
1818f2595 exit=0 lines=152 md5=af246a0d version: 10 :: --- name: tandem version: 10 description: >   Use when tande
e71b75feb exit=0 lines=152 md5=46d35ce1 version: 9 :: --- name: tandem version: 9 description: >   Use when tandem
33b3fb56f exit=0 lines=151 md5=ce13e36b version: 8 :: --- name: tandem version: 8 description: >   Use when tandem
e3f120d23 exit=0 lines=151 md5=0718f23a version: 7 :: --- name: tandem version: 7 description: >   Use when tandem
d3e8cba6f exit=0 lines=149 md5=d9d04789 version: 6 :: --- name: tandem version: 6 description: >   Use when tandem
4ad567c5f exit=0 lines=147 md5=397333d7 version: 6 :: --- name: tandem version: 6 description: >   Use when tandem
ac517f0a7 exit=0 lines=129 md5=74dff54e version: 5 :: --- name: tandem version: 5 description: >   Use when tandem
3c92732d7 exit=0 lines=121 md5=68fa0ce0 version: 4 :: --- name: tandem version: 4 description: >   Use when tandem
6261ea460 exit=0 lines=121 md5=a1cb90a6 version: 4 :: --- name: tandem version: 4 description: >   Use when tandem
1c9a9306a exit=0 lines=119 md5=af239ecc version: 4 :: --- name: tandem version: 4 description: >   Use when tandem
c47aed758 exit=0 lines=117 md5=55d1e8ea version: 4 :: --- name: tandem version: 4 description: >   Use when tandem
4cf2544aa exit=0 lines=117 md5=901ffa84 version: 3 :: --- name: tandem version: 3 description: >   Use when tandem
0c8978a8d exit=0 lines=107 md5=c009e0c1 version: 2 :: --- name: tandem version: 2 description: >   Use when tandem
6f0941030 exit=0 lines=94 md5=e1d9700d NOVERSION :: --- name: tandem description: >   Use when tandem_* MCP tool
3deae339d exit=0 lines=92 md5=8f453b2e NOVERSION :: --- name: tandem description: >   Use when tandem_* MCP tool
f82800560 exit=0 lines=92 md5=a5773d12 NOVERSION :: --- name: tandem description: >   Use when tandem_* MCP tool
ddef4620d exit=0 lines=92 md5=e5e75d9b NOVERSION :: --- name: tandem description: >   Use when tandem_* MCP tool
a1dee5b90 exit=0 lines=92 md5=a92a3148 NOVERSION :: --- name: tandem description: >   Use when tandem_* MCP tool
bc43a5c58 exit=0 lines=92 md5=6b92e388 NOVERSION :: --- name: tandem description: >   Use when tandem_* MCP tool
5e7c412fd exit=0 lines=92 md5=15e29fb5 NOVERSION :: --- name: tandem description: >   Use when tandem_* MCP tool
```

### cd <scratchpad> && for sha in c47aed758 1c9a9306a 6261ea460 3c92732d7 4ad567c5f d3e8cba6f 73d9041e3; do curl -sS --max-time 30 "https
(output 3968 chars)
```
=== v4 first (c47aed758) -> v4 last (3c92732d7) ===
60a61,64
> **Before responding, check whether you already did.** Neither `tandem_reply` nor `tandem_comment` is idempotent — replying twice leaves two chat bubbles or two annotation cards on the same text, which the user sees. Your own memory of the conversation is the primary check: if you recognize the comment's text, you have probably already answered it.
> 
> `alreadyPushed: true` is a weak secondary hint, not a verdict. It means the server handed the item to a real-time consumer — not that the consumer's host showed it to you, and not that you saw it. It is also dropped once the event leaves the channel buffer, so its absence proves nothing either. Never skip a comment on the strength of this flag alone. To check for a prior *annotation* reply, read the thread via `tandem_getAnnotations`; a prior `tandem_reply` is a chat message and won't appear there.
> 
76c80
< - **Call `tandem_checkInbox` every 2-3 tool calls**, not just at the end of a task. You cannot tell from your side whether real-time push is reaching you — the channel is often not connected, and there is no signal that tells you it's off — so steady polling is the reliable path, always. It's cheap: if push *is* live, `tandem_checkInbox` de-duplicates items you've already seen, so frequent calls don't double-report or double-act (at worst a long-idle item re-surfaces once, harmlessly). When in doubt, poll.
---
> - **Call `tandem_checkInbox` every 2-3 tool calls**, not just at the end of a task. You cannot tell from your side whether real-time push is reaching you — the channel is often not connected, and there is no signal that tells you it's off — so steady polling is the reliable path, always. It's cheap: repeat polls de-duplicate against what you've already been shown, so frequent calls don't double-report. An item that also went out as a real-time push carries `alreadyPushed: true` and still appears — the server can't confirm a push reached you, so it shows you everything rather than risk dropping it. See "User comments" above before acting on a flagged item twice. When in doubt, poll.
=== v6 first (4ad567c5f) -> v6 last (d3e8cba6f) ===
87c87,89
< If your host offers a `Monitor` tool, you can arm a watch on Tandem's wake stream so idle time doesn't swallow the user's messages. **Arm it at most once per session**, and only if Tandem's tool output has told you nothing is subscribed:
---
> If your host offers a `Monitor` tool, you can arm a watch on Tandem's wake stream so idle time doesn't swallow the user's messages. **Arm it at most once per session**, and only if Tandem's tool output has told you nothing is subscribed.
> 
> **Read the URL from `tandem_status`, don't assume it.** Read mode returns `wakeUrl` — the live address of the wake stream, reported by the server that is running it. It is usually `ws://127.0.0.1:3479/api/wake`, but the port is configurable and guessing it is a *silent* failure: you would open a socket to w
```

### for tag in v0.16.0 v0.17.0 v0.18.0 v0.19.0 v0.20.0 v0.20.1 v0.21.0 v0.22.0 v0.22.1 v0.23.0 v0.24.0 v0.24.1; do out=$(curl -sS --max-time 30 "https://raw.githubusercontent.com/bloknayrb/tandem/$tag/ski
(output 388 chars)
```
v0.16.0 md5=901ffa84 version: 3
v0.17.0 md5=901ffa84 version: 3
v0.18.0 md5=55d1e8ea version: 4
v0.19.0 md5=55d1e8ea version: 4
v0.20.0 md5=68fa0ce0 version: 4
v0.20.1 md5=68fa0ce0 version: 4
v0.21.0 md5=46d35ce1 version: 9
v0.22.0 md5=73b09759 version: 11
v0.22.1 md5=73b09759 version: 11
v0.23.0 md5=73b09759 version: 11
v0.24.0 md5=9a200caf version: 12
v0.24.1 md5=9a200caf version: 12
```

### timeout 300 npx vitest run tests/skill-instruction-contract.test.ts tests/plugin-manifest.test.ts tests/plugin/plugin-version-pin.test.ts 2>&1 | tail -25
(output 387 chars)
```
1:44:09 PM [vite-plugin-svelte] invalid plugin options "hot" in inline config
{ hot: false }
1:44:09 PM [vite-plugin-svelte] invalid plugin options "hot" in inline config
{ hot: false }

 RUN  v4.1.11 <repo>


 Test Files  3 passed (3)
      Tests  25 passed (25)
   Start at  13:44:11
   Duration  245ms (transform 155ms, setup 0ms, import 211ms, tests 29ms, environment 0ms)
```
