# Coverage manifest: shared-cli

Generated from the agent transcript. Zero model tokens.

## Files touched (118)
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bcbl85txo.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bi1j5nxxc.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bis9yecav.txt
- .claude/skills/tandem/
- docs/architecture.md
- docs/cli.md
- docs/configuration.md
- docs/decisions.md
- docs/mcp-tools.md
- docs/spikes/plugin-monitor-tty-activation.md
- docs/troubleshooting.md
- scripts/doctor.mjs
- skills/tandem/SKILL.md
- src-tauri/src
- src-tauri/src/
- src-tauri/src/token_store.rs
- src-tauri/src/updater.rs
- src-tauri/tauri.conf.json
- src/channel
- src/channel/event-bridge.ts
- src/channel/index.ts
- src/channel/run.ts
- src/cli
- src/cli/
- src/cli/annotation-store-scan.ts
- src/cli/channel.ts
- src/cli/doctor.ts
- src/cli/index.ts
- src/cli/license.ts
- src/cli/mcp-stdio.ts
- src/cli/node-version.ts
- src/cli/preflight.ts
- src/cli/rotate-token.ts
- src/cli/setup.ts
- src/cli/skill-content.ts
- src/cli/start.ts
- src/cli/uninstall-scrub.ts
- src/cli/win-path-guard.ts
- src/monitor
- src/monitor/index.ts
- src/monitor/run.ts
- src/server
- src/server/auth/
- src/server/auth/middleware.ts
- src/server/auth/token-store.ts
- src/server/events/
- src/server/events/observers/
- src/server/events/observers/annotations.ts
- src/server/events/observers/ctrl-chat.ts
- src/server/events/observers/ctrl-meta.ts
- src/server/events/observers/replies.ts
- src/server/events/queue.ts
- src/server/events/sse.ts
- src/server/events/types.ts
- src/server/events/wake-socket.ts
- src/server/index.ts
- src/server/integrations/
- src/server/integrations/api-routes.ts
- src/server/integrations/apply.ts
- src/server/integrations/backup.ts
- src/server/integrations/existing-config.ts
- src/server/integrations/index.ts
- src/server/integrations/migrations.ts
- src/server/integrations/node-binary.ts
- src/server/integrations/schema.ts
- src/server/integrations/storage.ts
- src/server/mcp
- src/server/mcp/
- src/server/mcp/api-routes.ts
- src/server/mcp/channel-routes.ts
- src/server/mcp/middleware
- src/server/mcp/routes/
- src/server/mcp/routes/health.ts
- src/server/mcp/routes/mode.ts
- src/server/mcp/routes/rotate-token.ts
- src/server/mcp/server.ts
- src/shared
- src/shared/api-paths.ts
- src/shared/auth/token-file.ts
- src/shared/cli-runtime.ts
- src/shared/constants.ts
- src/shared/cross-basename.ts
- src/shared/diagnostics.ts
- src/shared/events/types.ts
- src/shared/events/wake-scope.ts
- src/shared/fetch-with-timeout.ts
- src/shared/integrations/app-translocation.ts
- src/shared/integrations/client-config-paths.ts
- src/shared/integrations/contract.ts
- src/shared/integrations/detect-claude-cli.ts
- src/shared/integrations/node-binary-name.ts
- src/shared/integrations/npx-entry-spec.ts
- src/shared/integrations/path-lookup.ts
- src/shared/launcher/contract.ts
- src/shared/origins.ts
- src/shared/paths.ts
- src/shared/redact-user-paths.ts
- src/shared/scrub-text.ts
- src/shared/sse-consumer.ts
- src/shared/types.ts
- src/shared/utils.ts
- src/shared/windows-path-safety.ts
- src/stdio-bridge
- src/stdio-bridge/index.ts
- tests/channel
- tests/cli
- tests/cli/doctor.test.ts
- tests/cli/mcp-stdio.test.ts
- tests/cli/monitor.test.ts
- tests/cli/rotate-token.test.ts
- tests/cli/run-setup-apply.test.ts
- tests/cli/setup.test.ts
- tests/monitor
- tests/monitor/
- tests/monitor/index.test.ts
- tests/monitor/retry.test.ts
- tests/shared
- tests/stdio-bridge

## Commands run (136)
- `cat <scratchpad>/open-issues.txt`
- `wc -l docs/cli.md docs/configuration.md docs/architecture.md docs/troubleshooting.md docs/decisions.md docs/spikes/plugin-monitor-tty-activation.md && find src/`
- `cat docs/cli.md`
- `cat docs/configuration.md`
- `grep -n "ADR-028\|ADR-045\|ADR-049\|^## \|^### " docs/decisions.md | head -150`
- `grep -n "^## \|^### \|push path\|Push path\|channel shim\|monitor" docs/architecture.md | head -120`
- `cat docs/troubleshooting.md`
- `cat docs/spikes/plugin-monitor-tty-activation.md`
- `cat <transcript tool result, not kept>`
- `cat <transcript tool result, not kept>`
- `sed -n '320,424p' docs/decisions.md`
- `sed -n '1512,1641p' docs/decisions.md`
- `sed -n '1788,1858p' docs/decisions.md`
- `sed -n '384,583p' docs/architecture.md`
- `for f in src/cli/index.ts src/cli/start.ts src/cli/channel.ts src/cli/preflight.ts src/cli/node-version.ts src/cli/skill-content.ts; do echo "=== $f ==="; cat -`
- `cat -n src/cli/setup.ts`
- `ls -la src/server/integrations/ && wc -l src/server/integrations/*.ts`
- `cat -n src/cli/rotate-token.ts`
- `cat -n src/cli/uninstall-scrub.ts`
- `cat -n src/cli/mcp-stdio.ts`
- `cat -n src/stdio-bridge/index.ts src/channel/index.ts src/channel/event-bridge.ts src/channel/run.ts src/monitor/index.ts src/monitor/run.ts`
- `cat -n src/shared/cli-runtime.ts src/shared/sse-consumer.ts src/shared/fetch-with-timeout.ts`
- `cat -n src/shared/origins.ts src/shared/events/types.ts src/shared/events/wake-scope.ts src/shared/auth/token-file.ts`
- `cat -n src/shared/constants.ts`
- `sed -n '1,360p' src/cli/uninstall-scrub.ts`
- `sed -n '360,704p' src/cli/uninstall-scrub.ts`
- `sed -n '1,330p' src/cli/mcp-stdio.ts`
- `sed -n '330,660p' src/cli/mcp-stdio.ts`
- `sed -n '660,990p' src/cli/mcp-stdio.ts`
- `sed -n '990,1288p' src/cli/mcp-stdio.ts`
- `cat -n src/stdio-bridge/index.ts src/channel/index.ts src/channel/event-bridge.ts src/monitor/index.ts`
- `cat -n src/channel/run.ts`
- `cat -n src/monitor/run.ts`
- `cat -n src/shared/cli-runtime.ts src/shared/fetch-with-timeout.ts`
- `sed -n '1,360p' src/shared/sse-consumer.ts`
- `sed -n '360,710p' src/shared/sse-consumer.ts`
- `sed -n '1,280p' src/shared/constants.ts`
- `sed -n '280,539p' src/shared/constants.ts`
- `sed -n '1,340p' src/server/integrations/apply.ts`
- `sed -n '340,680p' src/server/integrations/apply.ts`
- `sed -n '680,1020p' src/server/integrations/apply.ts`
- `sed -n '1020,1360p' src/server/integrations/apply.ts`
- `sed -n '1360,1700p' src/server/integrations/apply.ts`
- `sed -n '1700,2040p' src/server/integrations/apply.ts`
- `sed -n '2040,2331p' src/server/integrations/apply.ts`
- `cat -n src/server/integrations/storage.ts`
- `cat -n src/server/integrations/backup.ts src/server/integrations/migrations.ts`
- `cat -n src/server/integrations/schema.ts src/server/integrations/node-binary.ts`
- `cat -n src/server/integrations/existing-config.ts src/server/integrations/index.ts`
- `cat -n src/shared/integrations/contract.ts src/shared/integrations/client-config-paths.ts`
- `cat -n src/shared/integrations/detect-claude-cli.ts src/shared/integrations/path-lookup.ts src/shared/integrations/npx-entry-spec.ts src/shared/integrations/app`
- `sed -n '1,340p' src/cli/doctor.ts`
- `sed -n '340,680p' src/cli/doctor.ts`
- `sed -n '680,1020p' src/cli/doctor.ts`
- `sed -n '1020,1360p' src/cli/doctor.ts`
- `sed -n '1360,1700p' src/cli/doctor.ts`
- `sed -n '1700,2040p' src/cli/doctor.ts`
- `sed -n '2040,2380p' src/cli/doctor.ts`
- `sed -n '2380,2720p' src/cli/doctor.ts`
- `sed -n '2720,3003p' src/cli/doctor.ts`
- `cat -n src/shared/launcher/contract.ts`
- `sed -n '1,330p' src/shared/types.ts`
- `sed -n '330,647p' src/shared/types.ts`
- `cat -n src/shared/api-paths.ts src/shared/diagnostics.ts src/shared/paths.ts src/shared/utils.ts src/shared/cross-basename.ts src/shared/windows-path-safety.ts`
- `cat -n src/shared/redact-user-paths.ts src/shared/scrub-text.ts`
- `cat -n src/cli/license.ts src/cli/win-path-guard.ts`
- `cat -n src/cli/annotation-store-scan.ts`
- `cat .claude-plugin/plugin.json; echo ---; cat .claude-plugin/marketplace.json 2>/dev/null; echo ---; head -60 skills/tandem/SKILL.md; echo ---; cat package.json`
- `cat tsup.config.ts; echo ---; cat .env.example`
- `ls src/server/events/ src/server/mcp/ src/server/mcp/routes/ 2>/dev/null; grep -rn "serverInfo\|name: \"tandem\"\|new McpServer(" src/server/mcp/server.ts | hea`
- `grep -rn "process.stdout.write\|console\.log\|console\.info\|console\.warn\|process.stdout" src/cli src/channel src/monitor src/shared src/stdio-bridge --includ`
- `npm run audit:origins 2>&1 | tail -60`
- `npm run audit:ymap-keys 2>&1 | tail -40`
- `ls tests/cli tests/monitor tests/channel tests/shared tests/stdio-bridge 2>/dev/null; ls tests | head -80`
- `sed -n '1,120p' node_modules/update-notifier/index.js; grep -n "stderr\|stdout\|console" node_modules/update-notifier/index.js node_modules/update-notifier/*.js`
- `sed -n '225,275p' src/server/mcp/server.ts; echo ---APP_VERSION---; grep -n "APP_VERSION\s*=" src/server/mcp/server.ts | head`
- `wc -l src/server/events/*.ts src/server/events/observers/*.ts src/server/mcp/channel-routes.ts src/server/mcp/routes/mode.ts src/server/mcp/routes/health.ts src`
- `cat -n src/server/events/sse.ts`
- `cat -n src/server/events/types.ts src/server/events/wake-socket.ts`
- `grep -rn "pushEvent(\|type: \"annotation:\|type: \"chat:\|type: \"document:" src/server --include=*.ts | grep -v "test" | head -60`
- `cat -n src/server/mcp/channel-routes.ts`
- `cat -n src/server/mcp/routes/mode.ts src/server/mcp/routes/health.ts`
- `grep -n "TANDEM_TRANSPORT\|stdio\|redirectConsole\|console.log = \|console.warn = " src/server/index.ts | head -40`
- `ls src/server/auth/; cat -n src/server/auth/token-store.ts 2>/dev/null | head -150; echo ---TAURI---; grep -rn "TANDEM_AUTH_TOKEN\|auth-token\|auth_token" src-t`
- `grep -n "resources\|externalBin" -A12 src-tauri/tauri.conf.json | head -50`
- `grep -rn "without the flag\|removes the entry\|no-channel-shim\|--no-channel" docs/*.md CHANGELOG.md README.md skills/tandem/SKILL.md src/cli/*.ts src/server/in`
- `grep -n "preserve\|remove\|withChannelShim" tests/cli/setup.test.ts tests/cli/run-setup-apply.test.ts | head -50`
- `grep -rn "console\.log\|process\.stdout\.write" node_modules/@modelcontextprotocol/sdk/dist/esm --include=*.js -l | head; echo ---; grep -rn "console\.log\|proc`
- `grep -rn "localhost" src/server/mcp/middleware*.ts src/server/mcp/*.ts 2>/dev/null | grep -i "host" | head -20; ls src/server/mcp | grep -i middle; grep -rln "a`
- `grep -n "identity changed\|serverInfo\|version" tests/cli/mcp-stdio.test.ts | head -30`
- `grep -n "rotate-token\|rotate token\|identity\|re-initializ" CHANGELOG.md | head -20`
- `sed -n '1,120p' src/server/events/queue.ts`
- `grep -n "emitModeReleaseWake" -A40 src/server/events/queue.ts | head -80`
- `ls src/server/events/observers/; grep -n "type: \"\|payload: {" -A8 src/server/events/observers/annotations.ts 2>/dev/null | head -120`
- `grep -rn "annotation:reply\|annotation:edited\|document:switched\|document:opened\|document:closed\|chat:message" src/server --include=*.ts | grep -v "\.test\."`
- `grep -rn "X-Claude-Session-Id\|CLAUDE_SESSION_HEADER\|normalizeSessionId" src/server --include=*.ts | grep -v test | head`
- `grep -n "1588\|re-initialize\|reinit\|Claude Desktop child\|keeps this child" CHANGELOG.md | head; echo ---F9---; grep -n "F9" -A12 <transcript-path>`
- `grep -n "restart Tandem to restore\|Claude Desktop.*before\|before.*Claude Desktop\|start Tandem first\|TANDEM_MCP_PORT\|custom port\|non-default port" docs/tro`
- `sed -n '60,110p' src/server/index.ts; echo ----; sed -n '175,200p' src/server/index.ts`
- `cat -n src-tauri/src/token_store.rs | head -120; echo ----; cat -n src/server/mcp/routes/rotate-token.ts`
- `cat node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js; echo ----; cat node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js`
- `sed -n '1,110p' src/server/events/observers/annotations.ts; echo ----REPLIES----; sed -n '40,78p' src/server/events/observers/replies.ts; echo ----CHAT----; sed`
- `npx tsx src/cli/index.ts --help 2>&1 | head -50; echo "exit=$?"; ls -la dist/channel/index.js dist/stdio-bridge/index.js 2>&1`
- `S=<scratchpad> && FH=$S/fakehome && rm -rf "$FH" && mkdir -p "$FH/.claude" && cat > "$FH/.cla`
- `S=<scratchpad> && FH=$S/fakehome2 && rm -rf "$FH" && mkdir -p "$FH/.claude" && printf '{\n  /`
- `S=<scratchpad> && FH=$S/fakehome3 && rm -rf "$FH" && mkdir -p "$FH/real" && echo '{"mcpServer`
- `grep -n "restart Tandem\|disconnected\|onExhaustion" tests/monitor/retry.test.ts tests/monitor/*.test.ts tests/cli/monitor.test.ts 2>/dev/null | head -10; echo `
- `sed -n '1,60p' tests/cli/run-setup-apply.test.ts`
- `grep -n "onBackup\|broken\|malformed\|applyConfig(" src/server/integrations/api-routes.ts | head -20`
- `cat scripts/doctor.mjs | head -60; echo ---; grep -n "mcpPort\|TANDEM_MCP_PORT\|wsPort" tests/cli/doctor.test.ts | head -10`
- `sed -n '70,135p' src/server/mcp/api-routes.ts; echo ---MCP-ROUTE---; grep -n "app.post(\"/mcp\"\|app.all(\"/mcp\"\|\"/mcp\"" src/server/mcp/server.ts | head -5;`
- `grep -n "Claude Desktop" docs/troubleshooting.md | head -20; echo ---; grep -n "wake\|Monitor\|ws://\|TaskStop" skills/tandem/SKILL.md | head -30`
- `grep -n "express.json\|limit:" src/server/mcp/server.ts src/server/mcp/api-routes.ts | head -10; echo ---; grep -rn "history\|maxHistory\|pastedContents" docs/*`
- `grep -n "Event Types" -A14 docs/architecture.md | sed -n '1,20p'; echo ---INSTR---; grep -n "annotation:edited" src/channel/run.ts docs/mcp-tools.md | head`
- `grep -n "exit\|Exit code\|exit code" docs/cli.md | head; echo ---; grep -rn "runDoctorCli\|return 2\|exit(2)\|crashed" src/cli/doctor.ts | grep -n "2" | head -5`
- `S=<scratchpad> && FH=$S/fakehome4 && rm -rf "$FH" && mkdir -p "$FH/.claude" && echo '{"mcpSer`
- `cd /tmp && TANDEM_MCP_PORT=4479 NO_UPDATE_NOTIFIER=1 npx tsx <repo>/src/cli/index.ts doctor 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -i "port\|`
- `grep -n "setup --apply\|rotate-token\|exit 1\|exits 1\|exit code" docs/cli.md | sed -n '1,30p'; echo ---rotate-docs---; sed -n '/^### tandem rotate-token/,/^#`
- `grep -n "CLAUDE_PLUGIN_OPTION" docs/configuration.md docs/cli.md docs/troubleshooting.md README.md | head; echo ---env-example-vs-doc---; grep -o "TANDEM_[A-Z_]`
- `grep -rn "TANDEM_SESSIONS_DIR\|TANDEM_COVERAGE\|TANDEM_LOCAL_MODEL\|TANDEM_BYO\|TANDEM_LAUNCHER" src --include=*.ts -l | head; echo ---; grep -rn "process.env.T`
- `sed -n '1,60p' tests/cli/rotate-token.test.ts | head -60; grep -n "serverRejected\|403\|restore\|configs" tests/cli/rotate-token.test.ts | head -10`
- `sed -n '440,460p;515,560p;575,615p' src/server/mcp/server.ts`
- `grep -n "dispatchToSession" -A40 src/server/mcp/server.ts | sed -n '1,80p'`
- `sed -n '895,975p' src/server/integrations/api-routes.ts`
- `sed -n '85,100p' docs/troubleshooting.md; echo ....; sed -n '299,350p' docs/troubleshooting.md`
- `grep -n "assertNotificationCapability" -A25 node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js | head -45`
- `grep -n "localhost\|url\b.*validat\|invalid-url\|wrong port\|9999" tests/cli/doctor.test.ts | head -10; echo ---; grep -n "checkUserMcpConfig\|user-mcp-config" `
- `grep -n "restart Tandem\|CHANNEL_MAX_RETRIES\|exhaust" docs/architecture.md docs/troubleshooting.md | head -10`
- `grep -n "relaunch\|restart\|sidecar" src-tauri/src/updater.rs 2>/dev/null | head -10; ls src-tauri/src | grep -i updat; grep -rn "app.restart()\|\.restart()\|re`
- `sed -n '60,110p' src/server/auth/middleware.ts`
- `grep -n "allowedHosts\|hostHeaderValidation\|localhost" node_modules/@modelcontextprotocol/sdk/dist/esm/server/express.js 2>/dev/null | head -20; ls node_module`
- `sed -n '187,205p' node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js`
- `sed -n '495,535p' tests/monitor/index.test.ts`
- `sed -n '276,292p' src/monitor/run.ts`
- `grep -n "restart Claude Desktop\|Claude Desktop.*restart\|start Tandem\|Tandem server not running" src/cli/mcp-stdio.ts | head; echo ---; grep -rn "respawn" src`
- `grep -n "upstream identity changed\|no handshake baseline\|function describeServerInfo\|function captureNegotiated\|deferredShutdown(\|const probe = await probe`

## Probe/executed outputs (8)

### npm run audit:origins 2>&1 | tail -60
(output 124 chars)
```
> tandem-editor@0.24.1 audit:origins
> tsx scripts/audit-origins.ts

audit-origins: clean (79 tagged sites across 528 files)
```

### npm run audit:ymap-keys 2>&1 | tail -40
(output 95 chars)
```
> tandem-editor@0.24.1 audit:ymap-keys
> tsx scripts/audit-ymap-keys.ts

audit-ymap-keys: clean
```

### npx tsx src/cli/index.ts --help 2>&1 | head -50; echo "exit=$?"; ls -la dist/channel/index.js dist/stdio-bridge/index.js 2>&1
(output 2447 chars)
```
tandem v0.0.0-dev

Usage:
  tandem                            Start Tandem server and open the editor
  tandem setup                      Print first-run setup guidance (setup is wizard-driven)
  tandem setup --apply              Write MCP config to detected AI clients non-interactively
  tandem setup --apply --force      Apply to default paths regardless of detection
  tandem setup --apply --target=claude-code|claude-desktop
                                    Restrict --apply to specific client(s)
  tandem setup --apply --with-channel-shim
                                    Also register the stdio channel shim (legacy opt-in)
  tandem doctor                     Diagnose setup issues (Node version, MCP config,
                                    ports, server health, push path, annotation
                                    store)
  tandem doctor --json              Same checks, emit a single JSON report on stdout
  tandem rotate-token               Rotate the auth token with a 60-second grace window
  tandem activate <license|path>    Activate a signed license (string or file path)
  tandem license                    Show the current license / trial status
  tandem --uninstall-scrub          Remove Tandem's MCP entries, skill, and Cowork
                                    registration from Claude configs (run before
                                    uninstalling; the Windows uninstaller runs it)
  tandem mcp-stdio                  Run as a stdio MCP server proxying to local HTTP
                                    (used by the plugin's Cowork bridge; requires
                                    tandem server running on the host)
  tandem channel                    Run the Tandem channel shim (stdio MCP)
                                    (used by the plugin's tandem-channel entry)
  tandem monitor                    Run the Tandem plugin monitor: stream wake
                                    lines to stdout for Claude Code to surface as
                                    notifications (used by the plugin's
                                    experimental.monitors entry, which starts it
                                    when the tandem skill is first used in a
                                    session; needs no flag)
  tandem --version
  tandem --help

exit=0
-rwxr-xr-x 1 root root 649391 Sep  2 13:41 dist/channel/index.js
-rwxr-xr-x 1 root root 255772 Sep  2 13:41 dist/stdio-bridge/index.js
```

### S=<scratchpad> && FH=$S/fakehome && rm -rf "$FH" && mkdir -p "$FH/.claude" && cat > "$FH/.claude.json" <<'EOF' {   "numStartups": 12,
(output 2529 chars)
```
Tandem Setup (--apply)

Detecting Claude installations...
  Found: Claude Code (<scratchpad>/fakehome/.claude.json)

Writing MCP configuration...
  ✓ Claude Code

Setup complete! Start Tandem with: tandem
Then in Claude, your tandem_* tools will be available.

Installing Claude Code skill...
  ✓ ~/.claude/skills/tandem/SKILL.md

Real-time push notifications:
  Simplest first: ask Claude to watch for updates. It can arm a watch on
  Tandem's wake stream itself — nothing to install, no flag — where Claude
  Code offers a Monitor tool. That tool is enabled per account rather than
  per version, so upgrading may not add it, and on Windows it also needs Git
  Bash. If Claude says it has none, the channel shim below is the option that
  never needs it.

  Registered for: Claude Code
  Registered is not delivering. To receive events, a session you start
  yourself needs the channel flag:

    claude --dangerously-load-development-channels server:tandem-channel

  Without it, your edits and comments still reach Claude — on its next
  tandem_checkInbox rather than immediately. Sessions Tandem launches for
  you are woken directly and need neither the flag nor this shim.

  A Tandem plugin is also published (skill + MCP + a real-time monitor that
  needs no flag on Claude Code 2.1.212+ interactive sessions). The monitor
  starts when Claude first uses the Tandem skill in a session, not at session
  start — so ask for Tandem by name rather than expecting it to be listening.
  It also needs Node on the PATH Claude Code itself started with (start
  `claude` from a terminal), and it shares the built-in Monitor tool's
  per-account gate — so it cannot stand in when that gate is off.
=== after run WITHOUT flag ===
{
  "numStartups": 12,
  "customKey": {
    "nested": true
  },
  "mcpServers": {
    "other-server": {
      "command": "foo",
      "args": [
        "bar"
      ],
      "env": {
        "SECRET": "x"
      }
    },
    "tandem": {
      "type": "http",
      "url": "http://127.0.0.1:3479/mcp"
    },
    "tandem-channel": {
      "command": "/opt/node22/bin/node",
      "args": [
        "<repo>/dist/channel/index.js"
      ],
      "env": {
        "TANDEM_URL": "http://127.0.0.1:3479"
      }
    }
  },
  "projects": {
    "/x": {
      "history": []
    }
  }
}

total 28
drwxr-xr-x 2 root root  4096 Sep  2 13:41 .
drwxr-xr-x 3 root root  4096 Sep  2 13:41 ..
-rw------- 1 root root 19070 Sep  2 13:41 SKILL.md
```

### S=<scratchpad> && FH=$S/fakehome2 && rm -rf "$FH" && mkdir -p "$FH/.claude" && printf '{\n  // a comment\n  "mcpServers": {"other": {
(output 2244 chars)
```
Tandem Setup (--apply)

Detecting Claude installations...
  Found: Claude Code (<scratchpad>/fakehome2/.claude.json)

Writing MCP configuration...
  Warning: <scratchpad>/fakehome2/.claude.json contains malformed JSON — backed up to <scratchpad>/fakehome2/.local/share/tandem/.broken-backups/.claude.json.broken-1788356523444-c6434e8a-d720-4753-b35f-e28d5cdc4fc2, replacing with fresh config
  ✓ Claude Code

Setup complete! Start Tandem with: tandem
Then in Claude, your tandem_* tools will be available.

Installing Claude Code skill...
  ✓ ~/.claude/skills/tandem/SKILL.md

Real-time push notifications:
  Simplest first: ask Claude to watch for updates. It can arm a watch on
  Tandem's wake stream itself — nothing to install, no flag — where Claude
  Code offers a Monitor tool. That tool is enabled per account rather than
  per version, so upgrading may not add it, and on Windows it also needs Git
  Bash. If Claude says it has none, the channel shim below is the option that
  never needs it.

  Not registered — no target in this run takes the channel shim.
  Claude will see your work on its next tandem_checkInbox.

  A Tandem plugin is also published (skill + MCP + a real-time monitor that
  needs no flag on Claude Code 2.1.212+ interactive sessions). The monitor
  starts when Claude first uses the Tandem skill in a session, not at session
=== after (JSONC input) ===
{
  "mcpServers": {
    "tandem": {
      "type": "http",
      "url": "http://127.0.0.1:3479/mcp"
    }
  }
}

<scratchpad>/fakehome2/.local/share/tandem/.broken-backups
<scratchpad>/fakehome2/.local/share/tandem/.broken-backups/.claude.json.broken-1788356523444-c6434e8a-d720-4753-b35f-e28d5cdc4fc2
XDG_DATA_HOME=
total 12
drwx------ 2 root root 4096 Sep  2 13:42 .
drwx------ 3 root root 4096 Sep  2 13:42 ..
-rw------- 1 root root   81 Sep  2 13:42 .claude.json.broken-1788356523444-c6434e8a-d720-4753-b35f-e28d5cdc4fc2
```

### S=<scratchpad> && FH=$S/fakehome3 && rm -rf "$FH" && mkdir -p "$FH/real" && echo '{"mcpServers":{}}' > "$FH/real/.claude.json" && ln 
(output 779 chars)
```
Tandem Setup (--apply)

Detecting Claude installations...
  Found: Claude Code (<scratchpad>/fakehome3/.claude.json)

Writing MCP configuration...
  ✗ Claude Code: Refusing to operate on symlinked path: <scratchpad>/fakehome3/.claude.json

Setup failed — could not write any configuration. Check file permissions.

Installing Claude Code skill...
  ✓ ~/.claude/skills/tandem/SKILL.md
npm notice
npm notice New major version of npm available! 10.9.7 -> 12.0.2
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
npm notice To update run: npm install -g npm@12.0.2
npm notice
exit=1
=== symlink target after ===
{"mcpServers":{}}
```

### S=<scratchpad> && FH=$S/fakehome4 && rm -rf "$FH" && mkdir -p "$FH/.claude" && echo '{"mcpServers":{"tandem":{"type":"http","url":"ht
(output 722 chars)
```
  [PASS] skipped — no project-local .mcp.json in this directory — optional; Claude Code reads its global MCP servers from ~/.claude.json, checked next
  [PASS] tandem registered in ~/.claude.json
  [PASS] ~/.claude.json has no tandem-channel entry, which is expected — the channel shim is opt-in. Real-time delivery comes from a self-armed watch (nothing to install, on a Claude Code that offers a Monitor tool) or the plugin monitor. Both need that tool; the shim does not, so it is the fallback when Claude has none — `tandem setup --apply --with-channel-shim` (that flag is the only way to register the shim: there is deliberately no wizard checkbox, so it needs the npm package, which the desktop app does not install)
```

### cd /tmp && TANDEM_MCP_PORT=4479 NO_UPDATE_NOTIFIER=1 npx tsx <repo>/src/cli/index.ts doctor 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -i "port\|3479\|4479" | head -5
(output 61 chars)
```
  [FAIL] Ports 3478 + 3479 not listening — server not running
```
