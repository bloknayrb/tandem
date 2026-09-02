# Coverage manifest: product

Generated from the agent transcript. Zero model tokens.

## Files touched (185)
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/b9sdoqwj6.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bhvwco2ux.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bji3uzdg4.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bw76sklr7.txt
- CHANGELOG.md
- docs/licensing-explained.md
- docs/long-report.md
- docs/positioning.md
- docs/release-smoke-checklist.md
- docs/troubleshooting.md
- docs/user-guide.md
- scripts/e2e-server.mjs
- scripts/test-ports.ts
- skills/tandem/SKILL.md
- src-tauri/Cargo.toml
- src-tauri/src
- src-tauri/src/lib.rs
- src-tauri/src/sidecar.rs
- src/cli
- src/cli/index.ts
- src/cli/start.ts
- src/client
- src/client/App.svelte
- src/client/actions/builtin.svelte.ts
- src/client/components/AccessibilitySettings.svelte
- src/client/components/ActivityTray.svelte
- src/client/components/AppearanceSettings.svelte
- src/client/components/CommandPalette.svelte
- src/client/components/ConnectionBanner.svelte
- src/client/components/CoworkAdminDeclinedModal.svelte
- src/client/components/EditorSettings.svelte
- src/client/components/EmptyState.svelte
- src/client/components/ErrorBoundary.svelte
- src/client/components/ExternalConflictBanner.svelte
- src/client/components/FidelityReportBanner.svelte
- src/client/components/FileOpenDialog.svelte
- src/client/components/HelpModal.svelte
- src/client/components/IntegrationTargetCard.svelte
- src/client/components/IntegrationWizardModal.svelte
- src/client/components/LicenseActivateForm.svelte
- src/client/components/LicenseBanner.svelte
- src/client/components/LicenseWall.svelte
- src/client/components/NetworkSettings.svelte
- src/client/components/OnboardingTutorial.svelte
- src/client/components/PendingUpdateBanner.svelte
- src/client/components/PushRoutesInfo.svelte
- src/client/components/ReviewOnlyBanner.svelte
- src/client/components/SettingsModal.svelte
- src/client/components/SettingsReadonlyBanner.svelte
- src/client/components/ToastContainer.svelte
- src/client/components/UpdaterBanner.svelte
- src/client/components/WakeStallBanner.svelte
- src/client/components/errorBoundaryConstants.ts
- src/client/components/integration-target-card-reason.ts
- src/client/components/integration-wizard-helpers.ts
- src/client/components/settings-tabs/SettingsAboutTab.svelte
- src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte
- src/client/components/settings-tabs/SettingsCollaborationTab.svelte
- src/client/components/settings-tabs/SettingsLicenseTab.svelte
- src/client/editor/
- src/client/editor/Editor.svelte
- src/client/editor/context-menu/
- src/client/editor/context-menu/detect.ts
- src/client/editor/context-menu/dispatch.ts
- src/client/editor/editor-extensions.ts
- src/client/editor/toolbar/ModeToggle.svelte
- src/client/editor/toolbar/Toolbar.svelte
- src/client/editor/toolbar/selection-toolbar.ts
- src/client/editor/utils/anchor-intercept.ts
- src/client/editor/utils/url-safety.ts
- src/client/hooks/useAiReadiness.svelte.ts
- src/client/hooks/useClaudeCliStatus.svelte.ts
- src/client/hooks/useConnectionBanner.svelte.ts
- src/client/hooks/useDocumentWorkspace.svelte.ts
- src/client/hooks/useFileDrop.svelte.ts
- src/client/hooks/useFirstRunNeeded.svelte.ts
- src/client/hooks/useIntegrationWizard.svelte.ts
- src/client/hooks/useNotifications.svelte.ts
- src/client/hooks/usePendingUpdateBanner.svelte.ts
- src/client/hooks/useTauriFileDrop.svelte.ts
- src/client/hooks/useTutorial.svelte.ts
- src/client/hooks/useUpdateAvailable.svelte.ts
- src/client/hooks/useUpdaterBanner.svelte.ts
- src/client/hooks/yjsSync.svelte.ts
- src/client/panels/
- src/client/panels/AnnotationBody.svelte
- src/client/panels/AnnotationCardActions.svelte
- src/client/panels/AnnotationCardHeader.svelte
- src/client/panels/AnnotationEditForm.svelte
- src/client/panels/BatchPromoteBar.svelte
- src/client/panels/BulkActions.svelte
- src/client/panels/ChatPanel.svelte
- src/client/panels/CommentCard.svelte
- src/client/panels/DocumentHealth.svelte
- src/client/panels/FilterBar.svelte
- src/client/panels/HighlightCard.svelte
- src/client/panels/ImportedCard.svelte
- src/client/panels/NoteCard.svelte
- src/client/panels/ReplyThread.svelte
- src/client/panels/SidePanel.svelte
- src/client/panels/SuggestionCard.svelte
- src/client/panels/annotation-actions.ts
- src/client/panels/annotation-card-helpers.ts
- src/client/panels/annotation-context-menu.ts
- src/client/shell/TitleBar.svelte
- src/client/status/StatusBar.svelte
- src/client/status/addressed-ai-notice.ts
- src/client/status/delivery-stall.ts
- src/client/status/status-ai-view.ts
- src/client/stores
- src/client/tabs/DocumentTabs.svelte
- src/client/tabs/NewTabMenu.svelte
- src/client/tabs/TabItem.svelte
- src/client/tabs/tab-context-menu.ts
- src/client/utils/backend-ports.ts
- src/client/utils/browse-file.ts
- src/client/utils/fileUpload.ts
- src/client/utils/license-ui.ts
- src/client/utils/pending-update-hint.ts
- src/client/utils/server-paths.ts
- src/client/utils/startup-rejection.ts
- src/server
- src/server/annotations
- src/server/annotations/lifecycle.ts
- src/server/annotations/store.ts
- src/server/bind-check.ts
- src/server/documents
- src/server/documents/
- src/server/documents/autosave.ts
- src/server/documents/conflict.ts
- src/server/documents/open.ts
- src/server/documents/populate.ts
- src/server/documents/watcher.ts
- src/server/events
- src/server/events/
- src/server/events/observers
- src/server/events/observers/
- src/server/events/observers/annotations.ts
- src/server/events/queue.ts
- src/server/file-io
- src/server/file-io/
- src/server/file-io/doc-backup.ts
- src/server/file-io/docx-size-gate.ts
- src/server/file-watcher.ts
- src/server/index.ts
- src/server/integrations
- src/server/integrations/
- src/server/integrations/api-routes.ts
- src/server/integrations/first-run.ts
- src/server/integrations/install-claude-cli.ts
- src/server/integrations/install-claude-code.ts
- src/server/launcher
- src/server/launcher/
- src/server/launcher/supervisor.ts
- src/server/license
- src/server/license/activation.ts
- src/server/license/kv-store.ts
- src/server/license/license-state.ts
- src/server/license/paths.ts
- src/server/mcp
- src/server/mcp/annotations.ts
- src/server/mcp/awareness.ts
- src/server/mcp/diagnostics.ts
- src/server/mcp/document-service.ts
- src/server/mcp/document.ts
- src/server/mcp/routes
- src/server/mcp/routes/_shared.ts
- src/server/mcp/routes/license.ts
- src/server/mcp/routes/open.ts
- src/server/mcp/routes/save.ts
- src/server/mcp/routes/send-open-result.ts
- src/server/mcp/routes/upload.ts
- src/server/mcp/server.ts
- src/server/mcp/tools
- src/server/mcp/tutorial-annotations.ts
- src/server/mode.ts
- src/server/notifications.ts
- src/server/platform.ts
- src/server/session
- src/server/sessions
- src/shared
- src/shared/constants.ts
- src/shared/launcher/
- src/shared/license-copy.ts
- src/shared/sanitize.ts

## Commands run (121)
- `wc -l README.md docs/user-guide.md docs/troubleshooting.md docs/positioning.md docs/licensing-explained.md docs/release-smoke-checklist.md sample/welcome.md CHA`
- `cat <repo>/README.md`
- `cat <repo>/docs/user-guide.md`
- `cat <repo>/docs/troubleshooting.md`
- `cat <repo>/docs/positioning.md <repo>/sample/welcome.md`
- `cat <repo>/docs/licensing-explained.md`
- `cat <repo>/docs/release-smoke-checklist.md`
- `cat <scratchpad>/open-issues.txt`
- `sed -n '1,260p' <repo>/CHANGELOG.md`
- `cat <transcript tool result, not kept>`
- `cat <transcript tool result, not kept>`
- `head -c 40000 <transcript tool result, not kept>`
- `find src/client -type f \( -name "*.svelte" -o -name "*.ts" \) | sort | head -400 && echo "---COUNT---" && find src/client -type f \( -name "*.svelte" -o -name `
- `ls src/ src/server src/server/mcp src/server/license src/shared src/cli src-tauri 2>/dev/null; echo "---"; ls src-tauri/src 2>/dev/null`
- `cat scripts/test-ports.ts && echo "---PLAYWRIGHT---" && cat playwright.config.ts`
- `grep -rn "showToast\|toast(" src/client --include=*.svelte --include=*.ts -l | sort; echo "---toast helper---"; ls src/client/stores 2>/dev/null; find src/clien`
- `ls dist 2>/dev/null | head; echo "---node_modules?---"; ls node_modules 2>/dev/null | wc -l; echo "---node version---"; node --version; echo "--- playwright bro`
- `cat src/client/hooks/useNotifications.svelte.ts; echo "=====TOAST====="; cat src/client/components/ToastContainer.svelte`
- `cat src/client/components/IntegrationWizardModal.svelte`
- `cat src/client/components/integration-wizard-helpers.ts src/client/components/integration-target-card-reason.ts src/client/components/IntegrationTargetCard.svel`
- `cat src/client/components/EmptyState.svelte src/client/components/ConnectionBanner.svelte src/client/hooks/useConnectionBanner.svelte.ts`
- `cat src/shared/license-copy.ts src/client/utils/license-ui.ts src/client/components/settings-tabs/SettingsLicenseTab.svelte src/client/components/LicenseActivat`
- `cat src/client/status/StatusBar.svelte src/client/status/status-ai-view.ts src/client/status/addressed-ai-notice.ts src/client/status/delivery-stall.ts`
- `cat src/client/components/OnboardingTutorial.svelte src/client/hooks/useTutorial.svelte.ts src/server/mcp/tutorial-annotations.ts`
- `cat src/client/components/UpdaterBanner.svelte src/client/components/PendingUpdateBanner.svelte src/client/hooks/useUpdaterBanner.svelte.ts src/client/hooks/use`
- `cat src/client/status/status-ai-view.ts src/client/status/addressed-ai-notice.ts src/client/status/delivery-stall.ts`
- `cat src/client/hooks/useAiReadiness.svelte.ts`
- `cat src/client/hooks/useIntegrationWizard.svelte.ts src/client/hooks/useFirstRunNeeded.svelte.ts`
- `cat src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte src/client/components/PushRoutesInfo.svelte`
- `cat src/client/components/settings-tabs/SettingsAboutTab.svelte src/client/components/NetworkSettings.svelte src/client/components/settings-tabs/SettingsCollabo`
- `cat src/client/components/ExternalConflictBanner.svelte src/client/components/FidelityReportBanner.svelte src/client/components/ReviewOnlyBanner.svelte src/clie`
- `grep -n "TANDEM_PURCHASE_URL\|TANDEM_SUPPORT_EMAIL\|TRIAL_DAYS\|DISCONNECT_DEBOUNCE_MS\|PROLONGED_DISCONNECT_MS\|TOAST_DISMISS_MS\|ACTIVITY_INFO_TTL_MS\|MAX_VIS`
- `cat src/server/notifications.ts; echo "=====FILE-WATCHER====="; grep -n "notify\|message:\|severity" src/server/file-watcher.ts | head -60; echo "=====documents`
- `grep -rn "notify(\|pushNotification(\|broadcastNotification(\|emitNotification(" src/server --include=*.ts | grep -v test | head -80`
- `grep -rn "notify(\"\|notify('\|notify(\|ctx.notify(\|notifications.push(\|onNotify(" src/client --include=*.svelte --include=*.ts | grep -v svelte-harness | he`
- `grep -rn "message:" src/client --include=*.svelte --include=*.ts | grep -v svelte-harness | grep -v "^\s*//" | head -150`
- `cat src/cli/start.ts | head -200; echo "=====SIDECAR (rust) dialogs====="; grep -n "dialog\|message(\|title(\|\"Server Error\"\|Retry Server\|blocking\|MessageD`
- `cat skills/tandem/SKILL.md | head -400`
- `ls src/server/events src/server/annotations src/server/mcp/routes src/server/sessions src/server/session 2>/dev/null; echo "---"; grep -n "shouldForwardExternal`
- `grep -n "AI_CTA\|title:\|ariaLabel:\|label:\|action:" <transcript tool result, not kept> |`
- `sed -n '270,360p;425,460p;600,720p' src/client/App.svelte`
- `sed -n '1570,1625p;1975,2030p;2580,2630p' src/client/App.svelte`
- `grep -n "shouldShowWizard\|firstRun\|isAutoOpenFirstRun\|WIZARD_DISMISS\|wizardDismiss\|closeIntegrationWizard\|openIntegrationWizard\|restartTutorial\|replayTu`
- `sed -n '370,500p' src/client/hooks/useDocumentWorkspace.svelte.ts`
- `grep -n "pushSaveNotification\|notify(\|confirm(\|\"error\"\|\"warning\"\|\"info\"" src/client/hooks/useDocumentWorkspace.svelte.ts | head -80`
- `grep -rn -E "notify\((\"|')" src/client --include=*.svelte --include=*.ts | grep -v svelte-harness | head -120`
- `cat src/server/mcp/routes/save.ts | head -220`
- `grep -n "message\|code:\|status(4\|status(5\|EACCES\|ENOSPC\|EPERM\|ENOENT\|EROFS" src/server/mcp/routes/open.ts src/server/mcp/routes/upload.ts src/server/mcp/`
- `grep -n "message\|EACCES\|ENOSPC\|EPERM\|ENOENT\|EROFS\|throw new\|SaveError\|reason" src/server/file-io/*.ts | grep -v "^.*://" | head -100; ls src/server/file`
- `sed -n '300,420p' src/server/documents/watcher.ts; echo "=====unlink/rename handling====="; grep -n "rename\|unlink\|deleted\|ENOENT\|existsSync\|missing" src/s`
- `sed -n '130,260p' src/server/events/queue.ts`
- `grep -rn "hideFromAI\|heldInSolo\|isHeldFromAI\|withheldCount\|withheld" src/server --include=*.ts -l | grep -v test; echo "---"; grep -n "hideFromAI\|heldInSol`
- `ls src/server/mcp/tools 2>/dev/null; grep -rln "tandem_checkInbox\|tandem_getAnnotations\|tandem_exportAnnotations" src/server/mcp --include=*.ts | grep -v test`
- `grep -n "note\|audience\|private\|isNote\|type ===\|type !==" src/shared/sanitize.ts | head -60`
- `sed -n '1655,1835p' src-tauri/src/lib.rs`
- `sed -n '755,830p' src-tauri/src/sidecar.rs; echo "=====UPDATE DIALOGS====="; grep -n "fn show_update_available_dialog\|fn show_up_to_date\|\.message(\|\.title(\`
- `grep -n "MenuItem::with_id\|\.text(\|tray\|\"Quit\"\|\"Show\"\|Setup AI\|Open Tandem\|Check for Updates\|About" src-tauri/src/lib.rs | head -50`
- `cat src/server/license/license-state.ts | head -260`
- `cat src/server/license/activation.ts | head -200; echo "=====ROUTE====="; grep -n "message\|status(\|code" src/server/mcp/routes/license.ts | head -50`
- `grep -n "trial\|Date.now\|clock\|firstLaunch\|startedAt\|daysRemaining\|rollback" src/server/license/license-state.ts src/server/license/kv-store.ts src/server/`
- `cat src/client/components/FileOpenDialog.svelte | grep -n -E "placeholder|>[A-Z][^<{]{6,}<|error =|Error|\"[A-Z][a-z].{10,}\"" | head -60`
- `grep -n -E "placeholder=|title=|aria-label=|>[A-Z][^<{]{8,}<|\"[A-Z][a-z][^\"]{12,}\"" src/client/panels/ChatPanel.svelte src/client/panels/SidePanel.svelte src`
- `grep -n -E "message|notify|Failed|Couldn|Could not|error" src/client/panels/annotation-actions.ts | head -60`
- `grep -n -E "title=|aria-label=|>[A-Z][^<{]{6,}<|\"[A-Z][a-z][^\"]{10,}\"" src/client/shell/TitleBar.svelte src/client/editor/toolbar/ModeToggle.svelte src/clien`
- `grep -n -E "notify\(|confirm\(|label: \"|description: \"|message" src/client/actions/builtin.svelte.ts | head -150`
- `grep -n -E "generation|auth|Stale|stale|reload|refresh the page|onAuthenticationFailed|onAuthenticat" src/client/hooks/yjsSync.svelte.ts | head -40`
- `timeout 120 npx playwright install chromium 2>&1 | tail -5; ls ~/.cache/ms-playwright 2>/dev/null`
- `ls /opt/pw-browsers; echo "PW=$PLAYWRIGHT_BROWSERS_PATH"; grep -n "TANDEM_PORT\|TANDEM_MCP_PORT\|TANDEM_APP_DATA_DIR\|TANDEM_NO_SAMPLE\|TANDEM_DISABLE_FIRST_RUN`
- `sed -n '200,275p' src/client/hooks/useAiReadiness.svelte.ts`
- `grep -n -E "label: \"|>[A-Z][^<{]{6,}<|title=\"|aria-label=\"|\"[A-Z][a-z][^\"]{14,}\"" src/client/components/SettingsModal.svelte | head -80`
- `grep -n -E "settings-section-label\">|settings-hint\">|<span>[A-Z][^<{]{4,}</span>|>[A-Z][^<{]{10,}<|label: \"" src/client/components/AppearanceSettings.svelte `
- `grep -n -E ">[A-Z][^<{]{6,}<|title=\"|aria-label=\"|label: \"|\"[A-Z][a-z][^\"]{14,}\"" src/client/panels/AnnotationCardActions.svelte src/client/panels/Annotat`
- `grep -n -E "label: \"|text: \"|title: \"|\"[A-Z][a-z][^\"]{10,}\"" src/client/panels/annotation-context-menu.ts src/client/tabs/tab-context-menu.ts src/client/e`
- `sed -n '290,370p' src/client/editor/Editor.svelte; echo "=====url-safety messages====="; grep -n -E "message|\"[A-Z][a-z][^\"]{12,}\"" src/client/editor/utils/u`
- `grep -n -E "message:|toast\(|\"[A-Z][a-z][^\"]{12,}\"" src/client/hooks/useFileDrop.svelte.ts src/client/hooks/useTauriFileDrop.svelte.ts src/client/utils/fileU`
- `sed -n '625,700p;770,840p;905,930p' src/client/actions/builtin.svelte.ts`
- `grep -n -E ">[A-Z][^<{]{6,}<|title=\"|placeholder=\"|\"[A-Z][a-z][^\"]{12,}\"" src/client/components/HelpModal.svelte src/client/components/CommandPalette.svelt`
- `ls src/server/launcher; grep -n -i "login\|logged\|auth\|not authenticated\|cli-unusable\|circuit\|MAX_RESTART\|crash\|lastError" src/server/launcher/supervisor`
- `grep -rn -i "login\|logged in\|/login\|OAuth\|not authenticated\|Please run" src/server/launcher/*.ts src/shared/launcher/*.ts src/client/hooks/useAiReadiness.s`
- `ls src/server/integrations; grep -n -E "message|curl|irm|iwr|powershell|sh -c|bash|timeout|TIMEOUT|\"[A-Z][a-z][^\"]{12,}\"" src/server/integrations/install-cla`
- `cat src/server/documents/autosave.ts | head -150`
- `grep -n -A30 "export async function freePort\|export function freePort" src/server/platform.ts | head -80; echo "=====bind-check====="; sed -n '1,80p' src/serve`
- `grep -n "freePort\|waitForPort\|EADDRINUSE\|still not available\|process.exit\|lock\|another instance\|already running" src/server/index.ts | head -40; echo "==`
- `sed -n '540,560p;875,895p;1380,1395p' src/server/mcp/document-service.ts; echo "=====doc-backup====="; sed -n '505,530p;588,600p' src/server/file-io/doc-backup.`
- `sed -n '120,280p' src/server/mcp/routes/_shared.ts`
- `grep -n "reason\|status: \"error\"\|EACCES\|ENOSPC\|catch" src/server/mcp/document-service.ts | sed -n '1,80p'`
- `grep -rn "TOO_LARGE\|MAX_FILE\|maxFileSize\|MAX_DOC\|MAX_UPLOAD\|fileSizeLimit\|bytes >" src/server/documents/open.ts src/server/mcp/routes/upload.ts src/shared`
- `grep -n "checkInbox\|note\|hideFromAI\|audience\|solo\|Solo" src/server/mcp/awareness.ts | head -60`
- `ls src/server/events/observers; grep -n "note\|author\|audience\|type ===\|shouldAnnounce\|announce" src/server/events/observers/annotations.ts | head -40; echo`
- `grep -n "solo\|Solo\|mode\|selectedText\|selection" src/server/mcp/awareness.ts | sed -n '1,50p'; echo "=====typing-presence/selection in solo====="; grep -rn "`
- `sed -n '2130,2195p' src-tauri/src/lib.rs; echo "=====ABOUT====="; sed -n '1390,1402p' src-tauri/src/lib.rs`
- `grep -n "single_instance\|single-instance" src-tauri/Cargo.toml src-tauri/src/lib.rs | head -5; echo "=====sidecar crash restart====="; grep -n "MAX_RESTARTS\|s`
- `grep -rn "first-run-needed\|firstRunNeeded\|needed:" src/server/integrations/api-routes.ts src/server/integrations/first-run.ts 2>/dev/null | head -20; ls src/s`
- `grep -rn -i "undo\|UndoManager\|history" src/client/editor/editor-extensions.ts src/client/editor/Editor.svelte | head -15; echo "=====path input in FileOpenDia`
- `grep -n "startup-rejection\|code ===\|case \"" src/client/utils/startup-rejection.ts | head -30; sed -n '20,80p' src/client/utils/startup-rejection.ts | grep -n`
- `grep -n -E "annotations|note|content|scrub|redact" src/server/mcp/diagnostics.ts | head -30`
- `which claude node; id -u; ls node_modules | grep -i "^playwright"; cat src/client/utils/backend-ports.ts | head -60; grep -n "server:\|host\|port\|strictPort" v`
- `S=<scratchpad>; mkdir -p $S/home $S/appdata $S/docs $S/shots; cp sample/welcome.md $S/docs/ 2`
- `S=<scratchpad>; VITE_TANDEM_WS_PORT=4728 VITE_TANDEM_MCP_PORT=4729 nohup npm run dev -- --por`
- `sed -n '595,650p' src/server/integrations/api-routes.ts; echo "=====computeFirstRunNeeded====="; grep -rn "function computeFirstRunNeeded\|firstRunNeeded(" src/`
- `grep -n -E "curl|irm|iwr|powershell|bash|sh -c|timeout|TIMEOUT|https://|message|\"[A-Z][a-z][^\"]{12,}\"" src/server/integrations/install-claude-cli.ts | head -`
- `sed -n '1200,1260p' src/server/launcher/supervisor.ts; echo "=====spawn args====="; grep -n "args\b\|\"-p\"\|--print\|--resume\|--continue\|spawn(\|reaper" src/`
- `sed -n '560,600p' src/server/index.ts`
- `sed -n '280,300p' src/server/mcp/routes/_shared.ts; echo "=====server-paths====="; grep -n -E "error:|notFoundMessage|failureMessage|message|\"[A-Z][a-z][^\"]{1`
- `sed -n '495,520p;645,672p' src/server/documents/open.ts; echo "=====populate====="; sed -n '95,145p' src/server/documents/populate.ts`
- `sed -n '195,300p' src/client/components/FileOpenDialog.svelte | grep -v "^\s*style=\|^\s*$" | head -90`
- `sed -n '150,185p;740,770p' src/client/panels/SidePanel.svelte; echo "=====Reject vs Dismiss====="; grep -rn -E ">\s*(Reject|Dismiss|Accept)\s*<|\"(Reject|Dismis`
- `grep -n "update_window_current\|updateWindowCurrent\|license_id\|X-Tandem-License-Id\|fn check_for_update" src-tauri/src/lib.rs | head -20; echo "====="; grep -`
- `sed -n '385,405p' src/client/panels/ChatPanel.svelte; echo "=====yjsSync rename====="; sed -n '745,800p' src/client/hooks/yjsSync.svelte.ts | grep -n "revert(\|`
- `sed -n '85,125p' src/client/hooks/useTauriFileDrop.svelte.ts; echo "=====SettingsModal 530-600====="; sed -n '535,600p' src/client/components/SettingsModal.svel`
- `grep -n -E "Report a bug|View Changelog|Replay tutorial|Replay Tutorial|Open log|Copy Diagnostics|changelog|tutorial" src/client/components/SettingsModal.svelte`
- `sed -n '680,720p' src/client/hooks/useAiReadiness.svelte.ts`
- `grep -n -E "confirm\(|Accept all|Dismiss all|Reject all|of [0-9]|pending\?" src/client/panels/BulkActions.svelte src/client/panels/BatchPromoteBar.svelte | head`
- `S=<scratchpad>; kill 11898 2>/dev/null; sleep 2; mkdir -p $S/bin; ln -sf /opt/node22/bin/node`
- `grep -n "data-testid=\"settings-modal-tab\|data-testid={\settings-modal-tab\|settings-modal-tab-" src/client/components/SettingsModal.svelte | head -5; grep -n`
- `grep -rn "absolute\|type=\"text\"\|Open by path\|pathInput" src/client/components/FileOpenDialog.svelte src/client/tabs/NewTabMenu.svelte | head; echo "=====pre`
- `grep -n "Collaboration\b\|CollaborationCursor\|undo\|Undo" src/client/editor/editor-extensions.ts | head -10; grep -rn "Mod-z\|undo()" src/client/editor/*.ts sr`
- `cat > <scratchpad>/mcp.mjs <<'EOF' // Minimal MCP HTTP client for probing the scratch backend`
- `sed -n '115,180p' src/client/components/SettingsModal.svelte | grep -n "id: \"\|label: \"" ; echo "=====popup testids====="; grep -n "data-testid=\"popup-" src/`
- `S=<scratchpad>; node -e ' const fs=require("fs"); let out="# The Long Report\n\n"; const word`
- `cd <scratchpad> && cat > probe-search.mjs <<'EOF' import { init, call } from "./mcp.mjs"; awa`

## Probe/executed outputs (8)

### cat scripts/test-ports.ts && echo "---PLAYWRIGHT---" && cat playwright.config.ts
(output 9426 chars)
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
---PLAYWRIGHT---
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { E2E_APP_DATA_DIR } from "./scripts/e2e-paths";
import { E2E_MCP_PORT, E2E_VITE_PORT, E2E_WS_PORT } from "./scripts/test-ports";
import { TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV } from "./src/shared/constants";

/**
 * This config's own directory, for `globalSetup` below.
 *
 * Playwright resolves `globalSetup` against the LOADED config file's directory
 * (`resolveScript` in `node_modules/playwright/lib/common/config.js`), and
 * `scripts/screenshots/playwright.config.ts` spreads this whole object — so a
 * relative `"./scripts/e2e-guard.ts"` would resolve
```

### ls dist 2>/dev/null | head; echo "---node_modules?---"; ls node_modules 2>/dev/null | wc -l; echo "---node version---"; node --version; echo "--- playwright browsers ---"; ls ~/.cache/ms-playwright 2>
(output 91 chars)
```
Exit code 2
---node_modules?---
498
---node version---
v22.22.2
--- playwright browsers ---
```

### timeout 120 npx playwright install chromium 2>&1 | tail -5; ls ~/.cache/ms-playwright 2>/dev/null
(output 553 chars)
```
Exit code 2
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                        |  70% of 110.9 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                |  80% of 110.9 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■        |  90% of 110.9 MiB
|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■| 100% of 110.9 MiB
Chrome Headless Shell 145.0.7632.6 (playwright chromium-headless-shell v1208) downloaded to /opt/pw-browsers/chromium_headless_shell-1208
```

### which claude node; id -u; ls node_modules | grep -i "^playwright"; cat src/client/utils/backend-ports.ts | head -60; grep -n "server:\|host\|port\|strictPort" vite.config.ts | head -20
(output 3426 chars)
```
/opt/node22/bin/claude
/opt/node22/bin/node
0
playwright
playwright-core
/// <reference types="vite/client" />
// ^ This file reads `import.meta.env`, so it declares the types for it rather
// than inheriting them from whichever sibling happens to share its program.
// Until the test tree gained tsconfigs, the only programs containing this file
// were the root one and `tsconfig.client.json` (which `svelte-check` runs), and
// both also contain `hooks/useTauriTheme.svelte.ts` and its identical
// reference -- so this file typechecked on a neighbour's declaration. Those two
// are the only such references in `src/`.
// Any narrower program (a test config that pulls it in transitively) got
// `Property 'env' does not exist on type 'ImportMeta'` instead.

import { DEFAULT_MCP_PORT, DEFAULT_WS_PORT } from "../../shared/constants";

/**
 * The client's backend ports, resolved once at module load (#1492).
 *
 * The server has honoured `TANDEM_PORT`/`TANDEM_MCP_PORT` forever, but the
 * browser client baked `DEFAULT_*` into literal URLs at build time, so no test
 * harness could move its backend without stranding the client it serves — and
 * every harness therefore ran on the product ports, colliding with the user's
 * real Tandem (#1483). This module is the client half of the fix: every
 * client→backend URL derives from here, and here alone.
 *
 * `VITE_TANDEM_MCP_PORT` / `VITE_TANDEM_WS_PORT` are read via
 * `import.meta.env`, which Vite substitutes statically — at transform time in
 * dev, at build time for `vite build`. **Production is byte-identical in
 * effect:** with the vars unset (every non-harness build and every dev serve),
 * the substitution yields `undefined`, `resolvePort` falls back to
 * `DEFAULT_*`, and the URLs come out exactly as the old literals did. Only the
 * Playwright harnesses set these vars (`playwright.config.ts`,
 * `scripts/perf-build.ts`), sourced from `scripts/test-ports.ts`.
 *
 * Access the full dotted form only (`import.meta.env.VITE_X`) — optional
 * chaining or destructuring would defeat Vite's static replacement.
 */
function resolvePort(raw: unknown, fallback: number): number {
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw)) return fallback;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : fallback;
}

export const MCP_PORT = resolvePort(import.meta.env.VITE_TANDEM_MCP_PORT, DEFAULT_MCP_PORT);
export const WS_PORT = resolvePort(import.meta.env.VITE_TANDEM_WS_PORT, DEFAULT_WS_PORT);

/** Base origin for every `/api`, `/mcp` and SSE fetch. */
export const MCP_BASE_URL = `http://127.0.0.1:${MCP_PORT}`;

/** Hocuspocus WebSocket endpoint. */
export const WS_URL = `ws://127.0.0.1:${WS_PORT}`;

declare global {
  interface Window {
    /** Which backend this served client actually targets. Read by the perf harness before any destructive step — a stale build baked to the wrong pair must fail loudly, not drive a real Tandem through the UI. */
    __TANDEM_PORTS__?: { ws: number; mcp: nu
```

### S=<scratchpad>; mkdir -p $S/home $S/appdata $S/docs $S/shots; cp sample/welcome.md $S/docs/ 2>/dev/null; NODEDIR=$(dirname $(which no
(output 1074 chars)
```
server pid 11898
[Tandem] Starting server (transport: http)...
[Tandem] Server generationId: 1fdc340b-ce29-4ce1-a039-7f9ff1beea87
[EventQueue] Attached CTRL_ROOM observers (chat + documentMeta)
[Tandem] auth token written to file
[FileWatcher] Watching <repo>/sample/welcome.md
[tutorial] Injected 4/4 tutorial annotations
[Tandem] Hocuspocus WebSocket server running on ws://127.0.0.1:4728
[Tandem] No client dist at <repo>/src/server/client — run 'npm run build' first
[Tandem] MCP HTTP server on http://127.0.0.1:4729/mcp

  Tandem v0.24.1

  MCP HTTP:    http://127.0.0.1:4729/mcp
  WebSocket:   ws://127.0.0.1:4728
  Health:      http://127.0.0.1:4729/health

  Open your AI client (Claude by default) and ask it to review a document.

[Launcher] No claude-code integration with apply != skip — skipping
{"status":"ok","version":"0.24.1","transport":"http","hasSession":false,"push":{"subscribers":0,"lastEventAt":null,"eventCount":0},"delivery":{"pollCount":0,"forwardCount":0,"state":"idle","latencyMs":null,"waitingMs":null,"sincePollMs":null}}
```

### S=<scratchpad>; VITE_TANDEM_WS_PORT=4728 VITE_TANDEM_MCP_PORT=4729 nohup npm run dev -- --port 4573 --strictPort > $S/vite.log 2>&1 &
(output 342 chars)
```
vite pid 12893

> tandem-editor@0.24.1 dev
> vite --port 4573 --strictPort

1:44:26 PM [vite] (client) Forced re-optimization of dependencies
1:44:27 PM [vite] (client) [optimizer] scanning dependencies...
1:44:28 PM [vite] (ssr) [optimizer] bundling dependencies...

  VITE v8.0.16  ready in 2511 ms

  ➜  Local:   http://127.0.0.1:4573/
200
```

### S=<scratchpad>; kill 11898 2>/dev/null; sleep 2; mkdir -p $S/bin; ln -sf /opt/node22/bin/node $S/bin/node; rm -rf $S/appdata $S/home;
(output 551 chars)
```
  Health:      http://127.0.0.1:4729/health

  Open your AI client (Claude by default) and ask it to review a document.

[Launcher] No claude-code integration with apply != skip — skipping
{"status":"ok","version":"0.24.1","transport":"http","hasSession":false,"push":{"subscribers":0,"lastEventAt":null,"eventCount":0},"delivery":{"pollCount":0,"forwardCount":0,"state":"idle","latencyMs"
{"needed":true,"serverVersion":"0.24.1","confirmationNonce":"n_ZqZ5t3WJsDe67I6s9-j-qVZGrlWPLhYJ9xCw1HaTU"}
{"presence":"NOT_INSTALLED","bareNameLaunchable":true}
```

### S=<scratchpad>; node -e ' const fs=require("fs"); let out="# The Long Report\n\n"; const words=["analysis","framework","quarterly","s
(output 249 chars)
```
bytes 1449361 words≈ 157255
total 1428
drwxr-xr-x  2 root root    4096 Sep  2 13:46 .
drwx------ 13 root root    4096 Sep  2 13:46 ..
-rw-r--r--  1 root root 1449361 Sep  2 13:46 long-report.md
-rw-r--r--  1 root root    3596 Sep  2 13:44 welcome.md
```
