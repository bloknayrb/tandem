# Coverage manifest: docs

Generated from the agent transcript. Zero model tokens.

## Files touched (209)
- .claude/agents/
- .claude/commands/
- .claude/hooks/
- .claude/hooks/README.md
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bb8jpu46h.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bc4mkrikw.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bxz0eip0j.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bzq66u1hz.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bzrdtiajv.txt
- .claude/skills/
- .env.example
- .github/workflows/
- .github/workflows/tauri-release.yml
- .mcp.json.example
- AGENTS.md
- CONTRIBUTING.md
- LICENSE
- docs/architecture.md
- docs/assets/
- docs/cli.md
- docs/configuration.md
- docs/data-locations.md
- docs/decisions.md
- docs/design-system-impl/testid-manifest.md
- docs/gotchas.md
- docs/integrations.md
- docs/lessons-learned.md
- docs/licensing-explained.md
- docs/licensing-operations.md
- docs/licensing-terms.md
- docs/mcp-tools.md
- docs/positioning.md
- docs/release-smoke-checklist.md
- docs/roadmap.md
- docs/screenshots/
- docs/security.md
- docs/semantic-tokens.md
- docs/spikes/plugin-monitor-tty-activation.md
- docs/stacked-prs.md
- docs/troubleshooting.md
- docs/user-guide.md
- docs/workflows.md
- infra/license-issuance-worker/src/
- sample/welcome.md
- scripts/build-client.mjs
- scripts/check-doc-links.mjs
- scripts/check-semantic-tokens.ts
- scripts/ci/coverage-gate.mjs
- scripts/ci/coverage-policy.json
- scripts/ci/stdio-smoke.mjs
- scripts/ci/windows-acl-proof.mjs
- scripts/dev-standalone.mjs
- scripts/e2e-guard.ts
- scripts/engines/version
- scripts/normalize-eol.mjs
- scripts/sign-license.ts
- scripts/spikes/run-acceptance-harness.mjs
- scripts/spikes/run_acceptance_tests.py
- scripts/test-ports.ts
- skills/tandem/SKILL.md
- src-tauri/Cargo.toml
- src-tauri/capabilities/
- src-tauri/src/
- src-tauri/src/autostart.rs
- src-tauri/src/context_menu.rs
- src-tauri/src/lib.rs
- src-tauri/src/open_candidate.rs
- src-tauri/src/sidecar.rs
- src-tauri/src/uninstall_scrub.rs
- src-tauri/tauri.conf.json
- src-tauri/windows/installer-hook.nsi
- src/cli/
- src/cli/doctor
- src/cli/doctor.ts
- src/cli/doctor/
- src/cli/index.ts
- src/cli/mcp-stdio.ts
- src/cli/node-version.ts
- src/cli/rotate-token.ts
- src/cli/start.ts
- src/cli/uninstall-scrub.ts
- src/client
- src/client/
- src/client/App.svelte
- src/client/actions/builtin.svelte.ts
- src/client/actions/keybindings.ts
- src/client/annotations/
- src/client/components
- src/client/components/
- src/client/components/AccessibilitySettings.svelte
- src/client/components/AppearanceSettings.svelte
- src/client/components/EditorSettings.svelte
- src/client/components/EmptyState.svelte
- src/client/components/Find
- src/client/components/FindReplace
- src/client/components/NetworkSettings.svelte
- src/client/components/OnboardingTutorial.svelte
- src/client/components/OutlinePanel.svelte
- src/client/components/SettingsModal.svelte
- src/client/components/StatusBar.svelte
- src/client/components/ToastContainer.svelte
- src/client/components/settings-tabs/
- src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte
- src/client/components/settings-tabs/SettingsCollaborationTab.svelte
- src/client/editor/
- src/client/editor/Editor.svelte
- src/client/editor/editor-extensions.ts
- src/client/editor/extensions/
- src/client/editor/extensions/awareness.ts
- src/client/editor/extensions/index.ts
- src/client/editor/find
- src/client/editor/schema
- src/client/editor/slash-menu/
- src/client/editor/toolbar/
- src/client/editor/toolbar/FormattingBar.svelte
- src/client/editor/toolbar/FormattingToolbar.svelte
- src/client/editor/toolbar/HighlightColorPicker.svelte
- src/client/hooks/
- src/client/hooks/useAppShortcuts.ts
- src/client/hooks/useConnectionBanner.svelte.ts
- src/client/hooks/useDragResize.svelte.ts
- src/client/hooks/useNotifications
- src/client/hooks/useTheme
- src/client/hooks/useTutorial
- src/client/hooks/useTutorial.svelte.ts
- src/client/hooks/yjsSync.svelte.ts
- src/client/keyboard
- src/client/layout/
- src/client/panels/
- src/client/panels/useAnnotationReview.svelte.ts
- src/client/shortcuts
- src/client/status/
- src/client/tabs/DocumentTabs.svelte
- src/client/utils/colors.ts
- src/client/utils/theme
- src/server/
- src/server/annotations/
- src/server/app-data
- src/server/auth/
- src/server/documents/open.ts
- src/server/events/observers/ctrl-meta.ts
- src/server/events/queue.ts
- src/server/events/sse.ts
- src/server/events/types.ts
- src/server/file-io/
- src/server/file-io/doc-backup.ts
- src/server/file-io/docx-comments.ts
- src/server/file-io/index.ts
- src/server/file-io/registry.ts
- src/server/index.ts
- src/server/integrations/
- src/server/integrations/apply.ts
- src/server/integrations/backup.ts
- src/server/integrations/install-claude-cli.ts
- src/server/integrations/install-claude-code.ts
- src/server/launcher/
- src/server/launcher/api-routes.ts
- src/server/license/
- src/server/license/types.ts
- src/server/mcp/
- src/server/mcp/annotations.ts
- src/server/mcp/api-routes.ts
- src/server/mcp/awareness.ts
- src/server/mcp/channel-routes.ts
- src/server/mcp/document.ts
- src/server/mcp/docx-apply.ts
- src/server/mcp/list-edit.ts
- src/server/mcp/navigation.ts
- src/server/mcp/routes/
- src/server/mcp/routes/info.ts
- src/server/mcp/routes/open.ts
- src/server/mcp/routes/rotate-token.ts
- src/server/mcp/server.ts
- src/server/mcp/tools/
- src/server/mcp/tutorial-annotations.ts
- src/server/mode.ts
- src/server/models/api-routes.ts
- src/server/notifications.ts
- src/server/platform.ts
- src/server/session/manager.ts
- src/shared/
- src/shared/app-data
- src/shared/constants.ts
- src/shared/license
- src/shared/notifications
- src/shared/origins.ts
- tests/build/file-association-alignment.test.ts
- tests/cli/check-semantic-tokens.test.ts
- tests/design-system-impl/__snapshots__/testid-set.snap.txt
- tests/design-system-impl/testid-coverage.test.ts
- tests/docs/ai-surface-inventory-claims.test.ts
- tests/docs/config-writer-set-claims.test.ts
- tests/docs/documents-boundary.test.ts
- tests/docs/loopback-gate-claims.test.ts
- tests/monitor/integration.test.ts
- tests/monitor/mode-cache.test.ts
- tests/scripts/acceptance-harness-wiring.test.ts
- tests/scripts/audit-origins.test.ts
- tests/scripts/coverage-gate-wiring.test.ts
- tests/scripts/e2e-guard-wiring.test.ts
- tests/scripts/typecheck-tests-wiring.test.ts
- tests/scripts/windows-acl-proof-wiring.test.ts
- tests/server/annotation-remove-seam.test.ts
- tests/server/annotation-reply-seam.test.ts
- tests/server/documents-open.test.ts
- tests/server/event-queue.test.ts
- tests/server/license-gate-coverage.test.ts
- tests/server/mcp-output-schemas.test.ts
- tests/server/mcp-schema-dialect.test.ts

## Commands run (89)
- `cat <scratchpad>/open-issues.txt`
- `wc -l README.md docs/user-guide.md docs/troubleshooting.md docs/configuration.md docs/cli.md docs/data-locations.md docs/integrations.md docs/licensing-explaine`
- `sed -n '/CHECK LINKS/,$p' <scratchpad>/baseline-static.txt | head -100; echo ====; grep -n "^`
- `cat -n <repo>/README.md`
- `cat -n <repo>/docs/user-guide.md`
- `cat -n <repo>/docs/troubleshooting.md`
- `cat -n <repo>/docs/configuration.md <repo>/docs/cli.md <repo>/docs/data-locations.md <repo>/docs/integrations.md`
- `cat -n <repo>/docs/licensing-explained.md <repo>/docs/licensing-terms.md <repo>/LICENSE`
- `cat -n <repo>/docs/positioning.md <repo>/docs/workflows.md <repo>/docs/semantic-tokens.md <repo>/AGENTS.md /home/use`
- `cat -n docs/mcp-tools.md`
- `cat -n docs/architecture.md`
- `awk '/^## \[/{c++} c<=2' CHANGELOG.md | cat -n | head -400`
- `timeout 60 npx tsx src/cli/index.ts --help 2>&1; echo "=== exit $?"; timeout 60 npx tsx src/cli/index.ts --version 2>&1`
- `cat <transcript tool result, not kept>`
- `cat <transcript tool result, not kept>`
- `cat <transcript tool result, not kept>`
- `cat <transcript tool result, not kept>`
- `cat <transcript tool result, not kept>`
- `cat <repo>/scripts/check-doc-links.mjs | head -150`
- `grep -rhoE "TANDEM_[A-Z0-9_]+" src/ scripts/ src-tauri/src/ 2>/dev/null | sort | uniq -c | sort -rn`
- `for sub in setup doctor rotate-token activate license monitor channel mcp-stdio start; do echo "=== tandem $sub --help"; timeout 30 npx tsx src/cli/index.ts $su`
- `sed -n 1,200p src/cli/index.ts`
- `grep -rn "process.env.TANDEM_[A-Z_]*\|env\[\"TANDEM_\|env\.TANDEM_" src/ src-tauri/src/ | grep -oE "TANDEM_[A-Z0-9_]+" | sort | uniq -c | sort -rn; echo "=== ru`
- `ls src/server/mcp/ src/server/mcp/tools/ 2>/dev/null; echo ===; grep -rn "registerTool\|server\.tool(\|\.tool(\s*$" src/server/mcp/ --include=*.ts | grep -v tes`
- `grep -rhoE "\"tandem_[a-zA-Z]+\"" src/server/mcp/ | sort | uniq -c | sort -rn`
- `cat scripts/test-ports.ts | head -60; echo "=== package.json scripts/engines/version"; node -e 'const p=require("./package.json"); console.log(p.version, JSON.s`
- `grep -c "^### \?[0-9]\+\.\|^## \?[0-9]\+\." docs/lessons-learned.md; grep -oE "^#{2,3} [0-9]+\." docs/lessons-learned.md | tail -3; echo "=== ADRs"; grep -oE "^`
- `grep -rn "assertOriginAllowlisted\|assertLoopbackForMutation" src/server/mcp/api-routes.ts src/server/mcp/routes/*.ts | grep -v "^.*://" | grep -v "import" | he`
- `grep -rnE "app\.(get|post|delete|put|use)\(\s*\"/api|registerRoute\(|\"/api/[a-z-]+" src/server/mcp/api-routes.ts src/server/mcp/routes/ src/server/mcp/channel-`
- `ls src/client/ src/client/shortcuts* src/client/keyboard* 2>/dev/null; grep -rln "Ctrl+Shift+P\|mod+shift+p\|Mod-Shift-p\|\"command-palette\"" src/client | head`
- `cat src/server/mcp/tutorial-annotations.ts | head -150`
- `grep -n "SUPPORTED_EXTENSIONS\|SUPPORTED_FILE_ASSOC\|fileAssociations" -A8 src/shared/constants.ts src-tauri/tauri.conf.json src-tauri/src/open_candidate.rs 2>/`
- `cat src/cli/start.ts | head -80; echo "=== node-version"; cat src/cli/node-version.ts | head -40`
- `grep -rn "TRIAL_DAYS\|14 \* 24\|trialDays\|TRIAL_LENGTH" src/server/license/*.ts | head; echo "=== update window"; grep -rn "expiresAt\|updateWindow\|365\|setFu`
- `grep -rn "longer than a license key\|doesn't look like a license key\|wasn't issued for this build\|needs a newer version of Tandem\|couldn't save it\|trial has`
- `grep -rn "export const API_" src/shared/*.ts | grep -oE "API_[A-Z_]+ = \"[^\"]+\"" | sort -u; echo "=== other route strings"; grep -rhoE "\"/api/[a-zA-Z0-9/_:-]`
- `sed -n 140,200p .github/workflows/tauri-release.yml; echo "=== tauri.conf bundle"; sed -n 55,120p src-tauri/tauri.conf.json; grep -n "minimumSystemVersion" -r s`
- `grep -n "TRIAL_DAYS\|DEFAULT_MCP_PORT\|DEFAULT_WS_PORT\|TANDEM_MODE_DEFAULT\|HIGHLIGHT_COLORS\b\|DWELL\|SELECTION_DWELL\|TANDEM_SITE_URL\|TANDEM_PURCHASE_URL\|T`
- `cat src/client/actions/keybindings.ts | head -200`
- `grep -n "id:\s*\"\|label:\s*\"\|remappable\|defaultBinding\|binding:" src/client/actions/builtin.svelte.ts | head -120`
- `ls src/client/editor/slash-menu/; grep -n "label:\|alias\|aliases\|keywords" src/client/editor/slash-menu/*.ts | head -60`
- `ls src/client/hooks/ | grep -i tutorial; grep -n "title\|description\|label\|step" src/client/components/OnboardingTutorial.svelte | head -40; echo "=== useTuto`
- `grep -n "hideFromAI\|heldInSolo\|heldFromExport" src/server/mode.ts src/server/mcp/annotations.ts src/server/mcp/awareness.ts | head -30; echo "=== context menu`
- `ls src/client/components/settings-tabs/ src/client/components/ | head -80; grep -n "label:\|id:\s*\"" src/client/components/SettingsModal.svelte | head -30`
- `grep -oE "check: \"[a-z-]+\"" src/cli/doctor.ts src/cli/doctor/*.ts 2>/dev/null | sort -u; ls src/cli/doctor* 2>/dev/null; grep -n "exitCode\|process.exit\|retu`
- `grep -n "MAX_BACKUPS\|MAX_SNAPSHOTS\|30\b\|500\|DAYS\|MB\|_MS\b" src/server/file-io/doc-backup.ts | head -20; echo "=== sse/queue"; grep -rn "KEEPALIVE\|15_000\`
- `grep -rn "8000\|6000\|4000\|8_000\|6_000\|4_000\|AUTO_DISMISS\|DISMISS" src/client/hooks/useNotifications*.ts src/client/components/ToastContainer.svelte src/sh`
- `grep -n "envPaths\|env-paths\|TANDEM_APP_DATA_DIR\|TANDEM_DATA_DIR\|suffix" src/server/platform.ts src/server/app-data*.ts src/shared/app-data*.ts 2>/dev/null |`
- `grep -rn "tandem-integrations\|tandem-models" src/ src-tauri/src/ --include=*.ts --include=*.rs | grep -v test | head -6; echo "=== desktop config paths"; grep `
- `grep -rn "sentences\|paragraphs" src/client/status/*.svelte src/client/components/StatusBar.svelte 2>/dev/null | head -5; echo "=== find scope"; grep -rln "allT`
- `grep -rn "undo\b\|Undo\|UndoManager\|history" src/client/editor/extensions/index.ts src/client/editor/Editor.svelte src/client/editor/schema*.ts 2>/dev/null | h`
- `grep -rn "58\|68\|82" src/client/components/settings-tabs/*Editor*.svelte src/client/components/EditorSettings.svelte 2>/dev/null | grep -i "measure\|ch\b\|narr`
- `head -40 skills/tandem/SKILL.md; grep -n "Monitor\|wakeUrl\|TaskStop" skills/tandem/SKILL.md | head -20; echo "=== plugin.json"; cat .claude-plugin/plugin.json;`
- `grep -n "Open Editor\|Setup AI Assistant\|Check for Updates\|About Tandem\|\"Quit\"\|MenuItem::with_id" src-tauri/src/lib.rs | head -12; grep -rn "8 \* 60 \* 60`
- `ls src/server/file-io/ | head -40; grep -n "html\|txt\|plaintext" src/server/file-io/registry.ts 2>/dev/null | head -20; grep -rn "TANDEM_AUTH_TOKEN" src/cli/ro`
- `grep -rhoE "https://github.com/bloknayrb/tandem/(blob|tree)/[a-z]+/[A-Za-z0-9_./#-]+" src/ skills/ sample/ src-tauri/src/ README.md docs/*.md 2>/dev/null | sort`
- `grep -rn "randomBytes(32)\|base64url\|timingSafeEqual\|sha256\|GRACE\|60_000\|60000" src/server/auth/*.ts src/cli/rotate-token.ts src/server/mcp/routes/rotate-t`
- `grep -rn "TANDEM_WS_PORT\|TANDEM_STDIO_NPX_ARGS\|TANDEM_TOKEN\b\|TANDEM_PROBE_SKIP\|TANDEM_COWORK_ROOT_OVERRIDE" src/ src-tauri/src/ scripts/ --include=*.ts --i`
- `grep -rn "collapse\|collapsed" src/client/components/OutlinePanel.svelte | head -5; echo "=== 30s banner / 3s"; grep -rn "30_000\|30000\|3_000\|3000" src/client`
- `timeout 120 node <scratchpad>/dump-tools.mjs > <scratchpad-path>`
- `cd <scratchpad> && sed -i 's#from "@modelcontextprotocol/sdk/client/index.js"#from "/home/use`
- `grep -n "CHANNEL_SSE_KEEPALIVE_MS\|CHANNEL_EVENT_BUFFER_SIZE\|CHANNEL_EVENT_BUFFER_AGE_MS\|TOAST_DISMISS_MS\|TYPING_DEBOUNCE\|MAX_NOTIFICATIONS\|NOTIFICATION_BU`
- `sed -n 1,80p src/server/events/types.ts | grep -n "type\|:" | head -40`
- `grep -n "history\|undoRedo\|UndoManager\|StarterKit.configure" src/client/editor/editor-extensions.ts src/client/editor/Editor.svelte | head -10; echo "=== past`
- `sed -n 128,136p src/client/components/EditorSettings.svelte; echo "=== cowork mount"; grep -n "CoworkSettings" src/client/components/SettingsModal.svelte src/cl`
- `grep -n "html\|htm\|txt\|plaintext\|PlainText\|case \"" src/server/file-io/index.ts | head -30; echo "=== detectFormat"; grep -rn "export function detectFormat"`
- `grep -rn "BACKUP_DIR\|backupDir\|tandem_backups\|tandem-backups" src/server/integrations/backup.ts | head -6; echo "=== uninstall log rust"; grep -rn "uninstall`
- `grep -n "check: \"\|check:\s*\"" src/cli/doctor.ts | grep -oE "\"[a-z-]+\"" | sort -u | tr '\n' ' '; echo; grep -n "CTRL_ROOM\b" src/shared/constants.ts | head `
- `grep -rn "corrupt.json\|\.corrupt" src/server/annotations/*.ts | head -3; grep -rn "autostart-seen\|last-seen-version" src/server/platform.ts src-tauri/src/auto`
- `grep -rn "import open\|from \"open\"\|openBrowser\|open(" src/server/index.ts src/server/mcp/document.ts src/server/documents/open.ts 2>/dev/null | grep -v "ope`
- `ls tests/; echo "=== test files"; ls tests/scripts/audit-origins.test.ts tests/docs/loopback-gate-claims.test.ts tests/docs/config-writer-set-claims.test.ts tes`
- `grep -n "export function with\|export const with\|installUntaggedWriteWarning" src/shared/origins.ts | head -10; grep -rn "check:links\|check-doc-links" .github`
- `grep -n "reuseExistingServer\|E2E_MCP_PORT\|E2E_WS_PORT\|3479\|3478" playwright.config.ts scripts/e2e-guard.ts | head -12; echo "=== TANDEM_DATA_DIR server"; gr`
- `grep -n "PROLONGED\|30_000\|30000" src/client/hooks/useConnectionBanner.svelte.ts | head -3; grep -rn "Cannot reach the Tandem server" src/client --include=*.sv`
- `grep -n "F2\|dblclick\|ondblclick" src/client/tabs/DocumentTabs.svelte | head -4; grep -rn "altKey && e.key === \"Enter\"\|altKey\b.*Enter\|Alt+Enter" src/clien`
- `grep -n "label\|value:" src/client/components/AppearanceSettings.svelte | grep -i "theme\|warm\|hue\|density\|uniform\|hover\|pill\|motion\|order\|size\|decor" `
- `grep -n "<h\|label=\|label:\|Replay\|margin\|Working directory\|Real-time" src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte | head -14; echo "==`
- `grep -n "\"none\"\|clear\|no highlight" src/client/editor/toolbar/HighlightColorPicker.svelte | head -4; grep -rn "Send to Claude\|assistantName\|send_to_label"`
- `grep -n "tandem-accent-bg\|tandem-info-bg\|tandem-claude-focus-bg\|tandem-claude-focus-border" index.html | head -8; grep -n "export const warningStateColors\|e`
- `grep -n "allowedOrigins\|isOriginAllowed\|tauri://localhost\|tauri.localhost" src/server/mcp/server.ts | head -8; echo "=== channel-permission GET / eviction"; `
- `grep -rhoE "\"/api/(integrations|models|settings|cowork)[a-zA-Z0-9/_:-]*\"" src/server/ | sort -u; grep -n "step\b.*text\|text:" src/client/components/Onboardin`
- `cd <scratchpad> && node -e ' const t=JSON.parse(require("fs").readFileSync("tools.json")); co`
- `cd <repo>; grep -rn "\"open\":" package.json | head -2; grep -n "\"open\"" package.json | head -3; sed -n 385,400p src-tauri/src/context_menu.rs; ech`
- `grep -rn "tandem_backups" --include=*.ts --include=*.rs --include=*.nsi --include=*.mjs src/ src-tauri/ scripts/ | head -3; sed -n 30,60p src/server/integration`
- `grep -n "claudeDesktopConfigPath" -A25 src/server/integrations/apply.ts | grep -n "darwin\|linux\|win32\|Claude\|config\|join(" | head -14`
- `grep -n "data-testid=\"settings-modal-[a-z-]*\"" src/client/components/AppearanceSettings.svelte | grep -oE "settings-modal-[a-z-]+" | sort -u | tr '\n' ' '; ec`
- `grep -oE "(title|aria-label)=\"[^\"]+\"" src/client/editor/toolbar/FormattingToolbar.svelte | sort -u | head -30`
- `sed -n 240,300p src/client/hooks/useAppShortcuts.ts`
- `sed -n 355,395p src/client/editor/editor-extensions.ts`

## Probe/executed outputs (8)

### timeout 60 npx tsx src/cli/index.ts --help 2>&1; echo "=== exit $?"; timeout 60 npx tsx src/cli/index.ts --version 2>&1
(output 2326 chars)
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

=== exit 0
0.0.0-dev
```

### for sub in setup doctor rotate-token activate license monitor channel mcp-stdio start; do echo "=== tandem $sub --help"; timeout 30 npx tsx src/cli/index.ts $sub --help 2>&1 | head -30; echo "exit=$?"
(output 19496 chars)
```
=== tandem setup --help
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
exit=0
=== tandem doctor --help
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
         
```

### cat scripts/test-ports.ts | head -60; echo "=== package.json scripts/engines/version"; node -e 'const p=require("./package.json"); console.log(p.version, JSON.stringify(p.engines)); console.log(Object
(output 5936 chars)
```
/**
 * Reserved backend/client ports for the repo's test harnesses (#1492).
 *
 * One home on purpose: the Playwright configs, the e2e guard, the specs that
 * hit `/api` directly, the perf build wrapper and the wiring test all need the
 * same numbers, and a drifted copy is exactly the desynchronization
 * `tests/scripts/e2e-guard-wiring.test.ts` exists to fail.
 *
 * Every number here is chosen, not arbitrary — the harness's own server boot
 * calls `freePort()` (SIGKILL) on whatever holds its pair, and Playwright
 * never probes the WS port at all, so a collision is not an error message, it
 * is a killed process. The constraints:
 *
 * - **Never the product pair (3478/3479) or dev Vite (5173).** Removing that
 *   collision is the whole point of #1492/#1483.
 * - **Never 4478/4479.** `docs/troubleshooting.md` ("Port already in use")
 *   tells users to move their REAL Tandem to exactly that pair — a harness
 *   there would SIGKILL the relocated desktop app of anyone who followed the
 *   product's own advice. The wiring test pins troubleshooting.md against
 *   every constant in this file so the collision cannot silently return.
 * - **Never 5174** — Vite's auto-increment parks a second `npm run dev` there.
 * - **E2E and perf get separate pairs**, so a stale server left by one harness
 *   can never answer the other's identity probe.
 * - No other in-repo port usage and no user-facing doc names these numbers
 *   (verified by grep at introduction; the wiring test keeps the doc half true).
 *
 * The perf *preview* (client) port, 4318, predates this file and stays defined
 * in `tests/perf/playwright.config.ts` (`PREVIEW_PORT`).
 */

/** Vite dev server for the E2E suite. Deliberately not 5173/5174 — a developer's `npm run dev` must never be adopted, nor its auto-increment neighbour. */
export const E2E_VITE_PORT = 4573;

/** Hocuspocus (ws) port for the E2E backend. x8/x9 pairing mirrors the product's 3478/3479. */
export const E2E_WS_PORT = 4728;

/** MCP HTTP port for the E2E backend — the port `scripts/e2e-guard.ts` probes. */
export const E2E_MCP_PORT = 4729;

/** Hocuspocus (ws) port for the perf-gate backend. */
export const PERF_WS_PORT = 4378;

/** MCP HTTP port for the perf-gate backend. */
export const PERF_MCP_PORT = 4379;
=== package.json scripts/engines/version
0.24.1 {"node":">=22.12.0"}
dev
dev:standalone
dev:client
dev:server
build
build:server
check:fonts
typecheck
typecheck:tests
server
start:server
channel
start:channel
test
test:coverage
test:e2e
test:e2e:ui
perf:gate
test:tauri-driver
test:acceptance-harness
capture:screenshots
capture:design-baselines
preview
lint
format
doctor
build:reaper
dev:tauri
build:tauri
check:tokens
check:links
audit:dead-code
audit:origins
audit:ymap-keys
prepare
prepublishOnly
lint-staged: {
 "**/*.{ts,tsx}": [
  "eslint --fix",
  "biome check --write --no-errors-on-unmatched"
 ],
 "src/**/*.{svelte,css,html}": [
  "biome check --write --no-errors-on-unmatched"
 ],
 "**/*.mjs": [
  "eslint --
```

### ls src/server/file-io/ | head -40; grep -n "html\|txt\|plaintext" src/server/file-io/registry.ts 2>/dev/null | head -20; grep -rn "TANDEM_AUTH_TOKEN" src/cli/rotate-token.ts | head -3; grep -n "proces
(output 696 chars)
```
doc-backup.ts
docx-apply.ts
docx-capture.ts
docx-comment-export.ts
docx-comment-id.ts
docx-comments.ts
docx-export.ts
docx-footnotes.ts
docx-html.ts
docx-lost-features.ts
docx-size-gate.ts
docx-verify.ts
docx-walker.ts
docx.ts
filename-safety.ts
hardbreak-normalize.ts
index.ts
line-endings.ts
markdown.ts
mdast-ydoc.ts
plaintext-flatten.ts
reaper.ts
spike-docx-export.ts
types.ts
21:  // Refuse to rotate when token comes from env — Tauri injects TANDEM_AUTH_TOKEN
28:    envAuthSource === "TANDEM_AUTH_TOKEN" ||
162:  // env.TANDEM_AUTH_TOKEN so post-rotation Cowork sessions don't 401
37:    process.exit(1);
45:    process.exit(1);
144:      process.exit(1);
eslint . | vite | playwright test
```

### timeout 120 node <scratchpad>/dump-tools.mjs > <scratchpad>/tools.
(output 636 chars)
```
Exit code 1
exit=1
    at ModuleJob._link (node:internal/modules/esm/module_job:182:49) {
  code: 'ERR_MODULE_NOT_FOUND'
}

Node.js v22.22.2
<anonymous_script>:1


SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at [eval]:1:14
    at runScriptInThisContext (node:internal/vm:209:10)
    at node:internal/process/execution:446:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:444:60)
    at evalFunction (node:internal/process/execution:279:30)
    at evalTypeScript (node:internal/process/execution:291:3)
    at node:internal/main/eval_string:74:3

Node.js v22.22.2
```

### cd <scratchpad> && sed -i 's#from "@modelcontextprotocol/sdk/client/index.js"#from "<repo>/node_modules/@modelcontextproto
(output 3036 chars)
```
auth-extensions.d.ts
auth-extensions.d.ts.map
auth-extensions.js
auth-extensions.js.map
auth.d.ts
exit=0
HEALTH: {"status":"ok","version":"0.24.1","transport":"http","hasSession":false,"push":{"subscribers":0,"lastEventAt":null,"eventCount":0},"delivery":{"pollCount":0,"forwardCount":0,"state":"idle","latencyMs":null,"waitingMs":null,"sincePollMs":null}}
INFO: {"version":"0.24.1","toolCount":33,"mcpSdkVersion":"0.0.0-unknown","transport":"http","bindHost":"127.0.0.1","bindPort":3979,"changelogPath":"<repo>/CHANGELOG.md","workflowsPath":"<repo>/docs/workflows.md","welcomePath":"<repo>/sample/welcome.md","storagePath":"<scratchpad>/appdata/sessions","tokenRotatedAt":1788356721695.7966,"generationId":"23c53e11-212b-4889-bdde-8cfd08ce5838"}
count 33
tandem_open | params: filePath,force,authoredBy | out: false
tandem_scratchpad | params: content | out: false
tandem_getTextContent | params: section,documentId | out: true
tandem_getOutline | params: includeBlocks,documentId | out: false
tandem_edit | params: from,to,newText,documentId,textSnapshot | out: false
tandem_editList | params: at,op,markdown,checked,documentId | out: false
tandem_appendContent | params: content,documentId | out: false
tandem_save | params: documentId | out: false
tandem_status | params: text,focusParagraph,focusOffset,documentId | out: true
tandem_close | params: documentId | out: false
tandem_rename | params: newName,documentId | out: false
tandem_listDocuments | params:  | out: true
tandem_switchDocument | params: documentId | out: false
tandem_convertToMarkdown | params: documentId,outputPath | out: false
tandem_highlight | params: from,to,color,note,documentId,textSnapshot | out: false
tandem_comment | params: from,to,text,suggestedText,directedAt,documentId,textSnapshot | out: false
tandem_suggest | params: from,to,newText,reason,documentId,textSnapshot | out: false
tandem_flag | params: from,to,note,documentId,textSnapshot | out: false
tandem_getAnnotations | params: author,type,status,documentId | out: true
tandem_resolveAnnotation | params: id,action,documentId | out: false
tandem_removeAnnotation | params: id,documentId | out: false
tandem_editAnnotation | params: id,content,newText,reason,documentId | out: false
tandem_exportAnnotations | params: format,documentId,writeToDisk,outputPath | out: false
tandem_annotationReply | params: annotationId,text,documentId | out: false
tandem_search | params: query,regex,documentId | out: true
tandem_resolveRange | params: pattern,occurrence,documentId | out: false
tandem_getContext | params: from,to,windowSize,documentId | out: false
tandem_getActivity | params: documentId | out: false
tandem_checkInbox | params: documentId | out: true
tandem_reply | params: text,replyTo,documentId | out: false
tandem_applyChanges | params: documentId,author,backupPath | out: false
tandem_restoreBackup | params: documentId,backup | out: false
tande
```

### grep -n "reuseExistingServer\|E2E_MCP_PORT\|E2E_WS_PORT\|3479\|3478" playwright.config.ts scripts/e2e-guard.ts | head -12; echo "=== TANDEM_DATA_DIR server"; grep -rn "TANDEM_DATA_DIR" src/server/*.ts
(output 1510 chars)
```
playwright.config.ts:5:import { E2E_MCP_PORT, E2E_VITE_PORT, E2E_WS_PORT } from "./scripts/test-ports";
playwright.config.ts:38:process.env.VITE_TANDEM_WS_PORT = String(E2E_WS_PORT);
playwright.config.ts:39:process.env.VITE_TANDEM_MCP_PORT = String(E2E_MCP_PORT);
playwright.config.ts:47:  // pair with `reuseExistingServer: false`, so the desktop app can no longer
playwright.config.ts:51:  // env (a client baked to :3479 would drive the user's REAL backend through
playwright.config.ts:87:      reuseExistingServer: !process.env.CI,
playwright.config.ts:94:      url: `http://127.0.0.1:${E2E_MCP_PORT}/health`,
playwright.config.ts:103:      reuseExistingServer: false,
playwright.config.ts:120:        TANDEM_PORT: String(E2E_WS_PORT),
playwright.config.ts:121:        TANDEM_MCP_PORT: String(E2E_MCP_PORT),
scripts/e2e-guard.ts:4:import { E2E_MCP_PORT, E2E_VITE_PORT, E2E_WS_PORT } from "./test-ports";
scripts/e2e-guard.ts:176:export const GUARD_PROBE_PORT = E2E_MCP_PORT;
=== TANDEM_DATA_DIR server
src/server/index.ts:624:      const sampleBase = process.env.TANDEM_DATA_DIR || projectRoot;
src/server/mcp/server.ts:135: * *resource* dir. But `index.ts` opens `path.join(process.env.TANDEM_DATA_DIR ||
src/server/mcp/server.ts:137: * `TANDEM_DATA_DIR` to the app-data dir and copies `sample/*` into it. So on a
src/server/mcp/server.ts:146: * Invisible in dev and in every test: `TANDEM_DATA_DIR` is unset there, which
src/server/mcp/server.ts:152:  const dataDir = process.env.TANDEM_DATA_DIR?.trim();
```

### cd <scratchpad> && node -e ' const t=JSON.parse(require("fs").readFileSync("tools.json")); const want=["tandem_getAnnotations","tande
(output 5150 chars)
```
## tandem_open
   filePath {"type":"string","desc":"Absolute path to the file to open"}
   force {"type":"boolean","desc":"Force reload from disk even if already open. Clears annotations and session."}
   authoredBy {"type":"string","desc":"Pass 'claude' when you wrote this file wholesale before opening, to stamp Claude authorship across its content. Idempotent."}
## tandem_getOutline
   includeBlocks {"type":"boolean","desc":"Also return every block, not just headings: node type, flat [from,to) range, nesting path, position within its list, and checkbox state. Fla"}
   documentId {"type":"string","desc":"Target document ID (defaults to active document)"}
## tandem_editList
   at {"type":"number","desc":"A flat character offset anywhere inside the target list item. Take it from a blocks[] entry in tandem_getOutline({ includeBlocks: true }) — "}
   op {"type":"string","enum":["insertAfter","insertBefore","remove","setChecked"],"desc":"insertAfter / insertBefore add new item(s) next to the target and need `markdown`. remove deletes the target item and everything nested unde"}
   markdown {"type":"string","desc":"insertAfter / insertBefore only. One item per line as markdown (`- text`); indent two spaces to nest under the line above. A block that is n"}
   checked {"type":["boolean","null"],"desc":"setChecked only. true ticks the box, false unticks it, null removes the checkbox and leaves an ordinary bullet. Markdown only — Word lists h"}
   documentId {"type":"string","desc":"Target document ID (defaults to active document)"}
## tandem_comment
   from {"type":"number","desc":"Start position"}
   to {"type":"number","desc":"End position"}
   text {"type":"string","desc":"Comment text"}
   suggestedText {"type":"string","desc":"Optional replacement text — turns this into a tracked-change suggestion"}
   directedAt {"type":"string","enum":["claude"],"desc":"Deprecated — pass omitted; including this field returns DEPRECATED."}
   documentId {"type":"string","desc":"Target document ID (defaults to active document)"}
   textSnapshot {"type":"string","desc":"Expected text at [from, to] — returns RANGE_MOVED with relocated range on mismatch, or RANGE_GONE if text was deleted"}
## tandem_getAnnotations
   author {"type":"string","enum":["user","claude","import"],"desc":"Filter by author"}
   type {"type":"string","enum":["highlight","comment"],"desc":"Filter by type"}
   status {"type":"string","enum":["pending","accepted","dismissed"],"desc":"Filter by status"}
   documentId {"type":"string","desc":"Target document ID (defaults to active document)"}
## tandem_resolveAnnotation
   id {"type":"string","desc":"Annotation ID"}
   action {"type":"string","enum":["accept","dismiss"],"desc":"Action to take"}
   documentId {"type":"string","desc":"Target document ID (defaults to active document)"}
## tandem_editAnnotation
   id {"type":"string","desc":"Annotation ID"}
   content {"type":"string","desc":"New comment text"}
   newText {"type":"string","desc":"New re
```
