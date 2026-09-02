# Coverage manifest: server-runtime

Generated from the agent transcript. Zero model tokens.

## Files touched (131)
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <transcript tool result, not kept>
- <scratchpad>/adr-045-049.md
- docs/architecture.md
- docs/cli.md
- docs/configuration.md
- docs/data-locations.md
- docs/decisions.md
- docs/gotchas.md
- docs/integrations.md
- docs/licensing-explained.md
- docs/security.md
- docs/troubleshooting.md
- docs/user-guide.md
- skills/tandem/SKILL.md
- src-tauri/src/
- src-tauri/src/lib.rs
- src-tauri/src/sidecar.rs
- src-tauri/src/sidecar_job.rs
- src/cli/
- src/cli/doctor.ts
- src/cli/rotate-token.ts
- src/client
- src/common.rs
- src/linux.rs
- src/macos.rs
- src/main.rs
- src/server
- src/server/
- src/server/annotations/store.ts
- src/server/auth
- src/server/auth/middleware.ts
- src/server/auth/token-store.ts
- src/server/bind-check.ts
- src/server/chat-stream-staleness.ts
- src/server/documents/autosave.ts
- src/server/error-filter.ts
- src/server/events
- src/server/events/delivery-state.ts
- src/server/events/file-sync-registry.ts
- src/server/events/observers/
- src/server/events/push-liveness.ts
- src/server/events/queue.ts
- src/server/events/sse.ts
- src/server/events/types.ts
- src/server/events/wake-socket.ts
- src/server/file-watcher.ts
- src/server/index.ts
- src/server/integrations
- src/server/integrations/acl-win.ts
- src/server/integrations/api-routes.ts
- src/server/integrations/apply.ts
- src/server/integrations/backup.ts
- src/server/integrations/existing-config.ts
- src/server/integrations/index.ts
- src/server/integrations/install-claude-cli.ts
- src/server/integrations/keychain.ts
- src/server/integrations/migrations.ts
- src/server/integrations/node-binary.ts
- src/server/integrations/schema.ts
- src/server/integrations/storage.ts
- src/server/launcher
- src/server/launcher/api-routes.ts
- src/server/launcher/cwd-preview.ts
- src/server/launcher/initial-reason.ts
- src/server/launcher/supervisor.ts
- src/server/license
- src/server/license/
- src/server/local-model
- src/server/local-model/collaborator.ts
- src/server/local-model/config-source.ts
- src/server/local-model/config.ts
- src/server/local-model/index.ts
- src/server/local-model/loop.ts
- src/server/local-model/ollama-client.ts
- src/server/local-model/prompts.ts
- src/server/local-model/tools.ts
- src/server/mcp/
- src/server/mcp/api-routes.ts
- src/server/mcp/awareness.ts
- src/server/mcp/channel-routes.ts
- src/server/mcp/document.ts
- src/server/mcp/license-gate.ts
- src/server/mcp/routes/license.ts
- src/server/mcp/routes/rotate-token.ts
- src/server/mcp/routes/shutdown.ts
- src/server/mcp/server.ts
- src/server/mode.ts
- src/server/models
- src/server/models/api-routes.ts
- src/server/models/registry.ts
- src/server/models/schema.ts
- src/server/models/store.ts
- src/server/notifications.ts
- src/server/platform.ts
- src/server/sentry.ts
- src/server/session/
- src/server/session/manager.ts
- src/server/session/persist.ts
- src/server/startup-file.ts
- src/server/version-check.ts
- src/server/yjs/provider.ts
- src/shared/auth/token-file.ts
- src/shared/constants.ts
- src/shared/events/
- src/shared/events/wake-scope.ts
- src/shared/integrations/detect-claude-cli.ts
- src/shared/integrations/path-lookup.ts
- src/shared/launcher/contract.ts
- src/shared/scrub-text.ts
- src/windows.rs
- tests/server
- tests/server/
- tests/server/launcher/
- tests/server/sentry

## Commands run (77)
- `wc -l <scratchpad>/open-issues.txt; ls <repo>/src/server/; echo ---; find /home/us`
- `cat <scratchpad>/open-issues.txt`
- `wc -l docs/architecture.md docs/security.md docs/licensing-explained.md docs/integrations.md docs/decisions.md docs/gotchas.md 2>&1; grep -n "^## ADR-0\(28\|31\`
- `cat <repo>/docs/security.md`
- `cat <repo>/docs/integrations.md; echo "=====LICENSING====="; cat <repo>/docs/licensing-explained.md`
- `grep -n "^## ADR-" docs/decisions.md | awk -F: '{print $1": "$2}' | sed -n '25,55p'`
- `sed -n '320,423p;460,509p' <repo>/docs/decisions.md`
- `sed -n '1185,1409p' <repo>/docs/decisions.md`
- `sed -n '1512,1640p;1788,1857p' <repo>/docs/decisions.md > <scratchpad>/adr-045-049`
- `cat -n <repo>/src/server/index.ts`
- `cat -n src/server/bind-check.ts src/server/auth/token-store.ts src/server/auth/middleware.ts`
- `cat -n src/server/events/queue.ts src/server/events/types.ts`
- `cat -n src/server/events/sse.ts src/server/events/wake-socket.ts src/server/events/push-liveness.ts; ls src/shared/events/ 2>/dev/null; find src -name "wake-sco`
- `cat -n src/server/events/observers/*.ts src/server/events/file-sync-registry.ts`
- `cat -n src/shared/auth/token-file.ts; grep -n "startMcpServerStdio" -A 40 src/server/mcp/server.ts | head -80`
- `cat -n src/shared/events/wake-scope.ts src/server/events/delivery-state.ts`
- `grep -rn "TANDEM_TRANSPORT" src/ src-tauri/src/ scripts/ docs/*.md README.md 2>/dev/null | grep -v "\.test\." | head -30`
- `sed -n '1,400p' src/server/launcher/supervisor.ts | cat -n`
- `sed -n '400,800p' src/server/launcher/supervisor.ts | cat -n | sed 's/^\s*\([0-9]*\)/\1+399/' `
- `awk 'NR>=800 && NR<=1200 {printf "%d\t%s\n", NR, $0}' src/server/launcher/supervisor.ts`
- `awk 'NR>=1200 {printf "%d\t%s\n", NR, $0}' src/server/launcher/supervisor.ts`
- `cat -n src/shared/launcher/contract.ts`
- `for f in src/server/license/*.ts; do echo "=== $f ==="; cat -n "$f"; done; echo; echo "=== GATE_ENABLED / gate-flag importers ==="; grep -rn "gate-flag\|GATE_EN`
- `cat -n src/server/launcher/api-routes.ts`
- `cat -n src/server/launcher/cwd-preview.ts src/server/launcher/initial-reason.ts src/server/platform.ts src/server/notifications.ts src/server/startup-file.ts sr`
- `cat -n src/server/sentry.ts src/server/error-filter.ts src/server/mode.ts src/server/chat-stream-staleness.ts; grep -rn "stdio\|TANDEM_TRANSPORT" src/cli/*.ts |`
- `cat -n src/server/integrations/backup.ts src/server/integrations/storage.ts src/server/integrations/index.ts src/server/integrations/migrations.ts`
- `awk 'NR>=1 && NR<=560 {printf "%d\t%s\n", NR, $0}' src/server/integrations/apply.ts`
- `awk 'NR>=560 && NR<=1120 {printf "%d\t%s\n", NR, $0}' src/server/integrations/apply.ts`
- `cat -n src/server/local-model/collaborator.ts src/server/local-model/index.ts`
- `awk 'NR>=1120 && NR<=1720 {printf "%d\t%s\n", NR, $0}' src/server/integrations/apply.ts`
- `awk 'NR>=1720 {printf "%d\t%s\n", NR, $0}' src/server/integrations/apply.ts`
- `awk 'NR>=1 && NR<=600 {printf "%d\t%s\n", NR, $0}' src/server/integrations/api-routes.ts`
- `awk 'NR>=600 {printf "%d\t%s\n", NR, $0}' src/server/integrations/api-routes.ts`
- `cat -n src/server/integrations/existing-config.ts src/server/integrations/keychain.ts src/server/integrations/node-binary.ts src/server/integrations/schema.ts`
- `cat -n src/server/integrations/install-claude-cli.ts src/server/integrations/acl-win.ts`
- `cat -n src/server/local-model/loop.ts src/server/local-model/tools.ts src/server/local-model/config.ts src/server/local-model/config-source.ts src/server/local-`
- `cat -n src/server/local-model/ollama-client.ts src/server/models/api-routes.ts src/server/models/registry.ts src/server/models/schema.ts src/server/models/store`
- `wc -l src/server/mcp/server.ts src/server/file-watcher.ts src/shared/integrations/detect-claude-cli.ts src/shared/integrations/path-lookup.ts reaper/src/main.rs`
- `awk 'NR>=1 && NR<=430 {printf "%d\t%s\n", NR, $0}' src/server/mcp/server.ts`
- `awk 'NR>=430 {printf "%d\t%s\n", NR, $0}' src/server/mcp/server.ts`
- `cat -n src/server/file-watcher.ts src/shared/integrations/detect-claude-cli.ts src/shared/integrations/path-lookup.ts`
- `cat -n reaper/src/main.rs src/server/mcp/routes/shutdown.ts; echo "=== tauri lib.rs sidecar/shutdown greps ==="; grep -n "shutdown\|SIGTERM\|kill_sidecar\|fn st`
- `sed -n '285,384p;384,470p' docs/architecture.md`
- `sed -n '787,830p;919,960p' docs/architecture.md; echo "=== api-routes.ts key functions ==="; grep -n "export function isLocalhostOrigin\|export function isHostA`
- `grep -n "acquireStoreLock\|releaseStoreLock\|isStoreReadOnly\|function.*[Ll]ock\|pid\b\|process.kill\|liveness\|stale" src/server/annotations/store.ts | head -6`
- `cat -n reaper/src/common.rs reaper/src/linux.rs; echo ======; cat -n reaper/src/windows.rs | head -150`
- `grep -n "HEALTH_TIMEOUT\|pub fn kill_sidecar\|pub fn restart_sidecar\|pub async fn restart_sidecar\|fn wait_for_health\|MAX_RESTARTS\|api/shutdown\|Job\|job_obj`
- `cat -n src/server/mcp/license-gate.ts; echo =====; cat -n src/server/mcp/routes/license.ts; echo =====; cat -n src/server/mcp/routes/rotate-token.ts`
- `sed -n '80,135p;195,300p' src/server/mcp/api-routes.ts`
- `sed -n '1,135p' tsup.config.ts`
- `grep -n "alreadyPushed\|wasEmittedViaChannel" src/server/mcp/awareness.ts skills/tandem/SKILL.md src/server/mcp/*.ts | head -30; echo ---; grep -n "stdin.on\|st`
- `ls node_modules/@sentry/node/package.json 2>/dev/null && node -e "console.log(require('@sentry/node/package.json').version)"; grep -rn "server_name\|hostname()"`
- `mkdir -p <scratchpad> && cat > <scratchpad-path>`
- `cd <scratchpad> && cat > epipe2.mjs <<'EOF' // Child ALIVE but has closed its stdin read end.`
- `sed -n '125,260p;350,385p' src/server/annotations/store.ts`
- `sed -n '95,140p;170,330p' src-tauri/src/sidecar.rs`
- `sed -n '330,600p' src-tauri/src/sidecar.rs`
- `ls src-tauri/src/ | head -50; grep -rn "TANDEM_AUTH_TOKEN\|PDEATHSIG\|kqueue\|sidecar_job" src-tauri/src/sidecar.rs src-tauri/src/lib.rs src-tauri/src/sidecar_j`
- `sed -n '590,640p' src/server/mcp/awareness.ts; echo ---; sed -n '139,175p' docs/troubleshooting.md; echo ---; grep -n "CHANNEL_EVENT_BUFFER_SIZE\|CHANNEL_EVENT_`
- `grep -rn "includeServerName\|server_name\|serverName" src/server/sentry.ts tests/server/sentry*.test.ts tests/server/*sentry* 2>/dev/null | head; ls tests/serve`
- `cat -n reaper/src/macos.rs | sed -n '1,60p'; echo ---; grep -n "SIGTERM\|forward\|alarm\|SIGKILL" reaper/src/macos.rs | head -20; echo "--- session save content`
- `cd <scratchpad> && cat > epipe4.mjs <<'EOF' // Does a ChildProcess-level 'error' listener (wh`
- `sed -n '1,60p' src-tauri/src/sidecar_job.rs; echo ---; grep -n "'end'\|\"end\"\|onclose\|close()" node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.j`
- `head -30 skills/tandem/SKILL.md; echo ---; grep -rn "5 MiB\|oversize\|MAX_CONFIG_BYTES\|refusing to read" docs/*.md README.md | head; echo ---; grep -n "writeTo`
- `node -e 'const f=(...a)=>a.map(String).join(" "); const e=new Error("boom"); console.log(JSON.stringify(f("[FileWatcher] Failed to watch %s:", "/x/y.md", e)));'`
- `grep -rn "subscribe(" src/server --include=*.ts | grep -v "test\|notifications\|\.subscribe(\|subscribeToEvents\|function subscribe\|// \|\* " | head; echo "---`
- `sed -n '60,110p' src/server/session/manager.ts | head -5; grep -n "export async function saveCurrentSession" src/server/session/manager.ts src/server/mcp/docume`
- `sed -n '8,30p' node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js; echo "--- index.ts server.onclose?"; grep -n "onclose\|process.exit" src/server/`
- `grep -n "ExitRequested\|RunEvent::Exit\|CloseRequested\|stop_sidecar_gracefully\|on_window_event\|WindowEvent::" src-tauri/src/lib.rs | head -30; echo ---; sed `
- `grep -rn "beforeunload\|pagehide\|visibilitychange.*save\|api/shutdown\|API_SHUTDOWN" src/client --include=*.ts --include=*.svelte | head -10; echo ---; grep -n`
- `grep -n "AUTO_SAVE_INTERVAL\|autoSaveIntervalMs\|60_000\|60000\|setInterval" src/server/session/manager.ts src/server/documents/autosave.ts src/shared/constants`
- `sed -n '1395,1412p;1549,1592p' src-tauri/src/lib.rs`
- `sed -n '1,60p' src/server/documents/autosave.ts; grep -n "AUTOSAVE\|setInterval\|debounce\|_MS" src/server/documents/autosave.ts | head`
- `grep -rn "api/save\|API_SAVE\b" src/client --include=*.ts --include=*.svelte | grep -v test | head -8; echo ---; grep -n "1088" CHANGELOG.md | head -5; echo ---`
- `grep -n "oversize\|MAX_CONFIG_BYTES\|5 \* 1024" src/cli/doctor.ts | head -5; echo ---; grep -rn "stdio-mode" src/client --include=*.ts --include=*.svelte | head`
- `grep -rn "app.exit\|\.exit(0)" src-tauri/src/lib.rs | head; echo ---; grep -n "fn show_main_window\|Cmd+Q\|CmdOrCtrl+Q\|accelerator" src-tauri/src/lib.rs | head`

## Probe/executed outputs (4)

### ls node_modules/@sentry/node/package.json 2>/dev/null && node -e "console.log(require('@sentry/node/package.json').version)"; grep -rn "server_name\|hostname()" node_modules/@sentry/node/build/cjs/sdk
(output 245 chars)
```
node_modules/@sentry/node/package.json
10.56.0
node_modules/@sentry/node-core/build/cjs/sdk/client.js:14:    const serverName = options.includeServerName === false ? void 0 : options.serverName || global.process.env.SENTRY_NAME || os.hostname();
```

### mkdir -p <scratchpad> && cat > <scratchpad>/epipe.mjs <<'EOF' // D
(output 302 chars)
```
writable before write: false destroyed: true
cb err: ERR_STREAM_DESTROYED
no uncaught after 500ms; writable now: false destroyed: true
--- second: small write
writable before write: false destroyed: true
cb err: ERR_STREAM_DESTROYED
no uncaught after 500ms; writable now: false destroyed: true
v22.22.2
```

### cd <scratchpad> && cat > epipe4.mjs <<'EOF' // Does a ChildProcess-level 'error' listener (which supervisor.ts has) swallow a stdin E
(output 592 chars)
```
cb err: EPIPE
UNCAUGHT: EPIPE
--- sentry event shape test
server_name: vm
contexts keys: [ 'trace', 'runtime' ]
frames filename sample: [
  [
    '<scratchpad>/sentry-probe.mjs',
    undefined,
    'sentry-probe'
  ],
  [
    '<scratchpad>/sentry-probe.mjs',
    undefined,
    'sentry-probe'
  ]
]
sdk/env keys: [
  'exception', 'event_id',
  'level',     'platform',
  'contexts',  'server_name',
  'timestamp', 'environment',
  'release',   'breadcrumbs',
```

### node -e 'const f=(...a)=>a.map(String).join(" "); const e=new Error("boom"); console.log(JSON.stringify(f("[FileWatcher] Failed to watch %s:", "/x/y.md", e)));'; echo ---; grep -rn "console.error(\"\[
(output 2295 chars)
```
"[FileWatcher] Failed to watch %s: /x/y.md Error: boom"
---
48
src/server/yjs/provider.ts:92:    console.error("[Hocuspocus] Rejected connection: unparseable origin: %s", origin);
src/server/file-io/doc-backup.ts:569:        .catch((err) => console.error("[DocBackup] prune failed for %s:", name, err));
src/server/file-io/doc-backup.ts:582:    console.error("[DocBackup] Snapshot failed for %s (save proceeds):", filePath, err);
src/server/file-io/docx-verify.ts:238:    console.error("[docx-verify %s] degenerate reimport (blocking save):", ctx.docId, metrics);
src/server/file-io/docx-verify.ts:244:    console.error("[docx-verify %s] gross text loss (blocking save):", ctx.docId, metrics);
---
src/server/sentry.ts:6: * Disabled unless `TANDEM_SENTRY_DSN` is set. The Tauri shell forwards this env
src/server/sentry.ts:28:const SENTRY_DSN_ENV = "TANDEM_SENTRY_DSN";
src/server/sentry.ts:77: * Initialise sidecar crash reporting if `TANDEM_SENTRY_DSN` is set. Idempotent,
src/server/sentry.ts:107:    console.error("[Tandem] Sidecar crash reporting enabled (TANDEM_SENTRY_DSN set)");
docs/security.md:170:Crash reporting is available but **strictly opt-in**: it activates only when you set the `TANDEM_SENTRY_DSN` environment variable to a [Sentry](https://sentry.io) or self-hosted [GlitchTip](https://glitchtip.com) DSN that you control. With the variable unset (the default), no Sentry client is initialized in the desktop shell, the Tauri Sentry plugin is never registered, the WebView is never instrumented, and `@sentry/node` is never even loaded in the sidecar — there is no crash-reporting code path on the wire. When you do opt in, Tandem reports Rust panics + native minidumps (shell), JavaScript errors / unhandled rejections (WebView, bridged over Tauri IPC), and Node uncaught exceptions (sidecar) to *your* endpoint, scrubbing home-directory paths to `~`/`[user]`, redacting Anthropic/bearer-style secrets, and dropping request/document payloads and content breadcrumbs before egress. Document content and annotation bodies are never attached to events. Self-hosting GlitchTip keeps all crash data under your control. Settings → About shows the current on/off status. Implemented in `src-tauri/src/sentry_reporting.rs`, `src/client/sentry.ts`, and `src/server/sentry.ts` (#921).
```
