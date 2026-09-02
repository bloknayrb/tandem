# Coverage manifest: client-ui

Generated from the agent transcript. Zero model tokens.

## Files touched (49)
- docs/user-guide.md
- src-tauri/tauri.conf.json
- src/client
- src/client/App.svelte
- src/client/components/AccessibilitySettings.svelte
- src/client/components/AppearanceSettings.svelte
- src/client/components/EmptyState.svelte
- src/client/components/FileOpenDialog.svelte
- src/client/components/IntegrationWizardModal.svelte
- src/client/components/NetworkSettings.svelte
- src/client/components/ReviewOnlyBanner.svelte
- src/client/components/SettingsModal.svelte
- src/client/components/settings-tabs/SettingsAboutTab.svelte
- src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte
- src/client/components/settings-tabs/SettingsCollaborationTab.svelte
- src/client/hooks/useClaudeCliStatus.svelte.ts
- src/client/hooks/useFileDrop.svelte.ts
- src/client/hooks/useFirstRunNeeded.svelte.ts
- src/client/hooks/useIntegrationWizard.svelte.ts
- src/client/panels/ChatPanel.svelte
- src/client/panels/ReplyThread.svelte
- src/client/panels/annotation-actions.ts
- src/client/status/word-count-cycle.ts
- src/client/tabs/DocumentTabs.svelte
- src/client/tabs/NewTabMenu.svelte
- src/client/tabs/TabItem.svelte
- src/client/utils/browse-file.ts
- src/client/utils/fileUpload.ts
- src/client/utils/recentFiles.ts
- src/server
- src/server/integrations
- src/server/integrations/
- src/server/integrations/api-routes.ts
- src/server/integrations/apply.ts
- src/server/integrations/existing-config.ts
- src/server/integrations/install-claude-cli.ts
- src/server/integrations/routes
- src/server/mcp
- src/server/mcp/routes/
- src/server/mcp/routes/integrations
- src/shared/constants.ts
- src/shared/integrations/contract.ts
- src/shared/integrations/detect-claude-cli.ts
- tests/client
- tests/client/integration-wizard-install.test.ts
- tests/e2e
- tests/e2e/
- tests/e2e/keyboard-a11y.spec.ts
- tests/e2e/keyboard-shortcuts.spec.ts

## Commands run (19)
- `echo "=== SettingsModal connected prop ===" && grep -n "connected" src/client/components/SettingsModal.svelte | head -20 && echo "=== App.svelte SettingsModal u`
- `echo "=== App.svelte wizard dismissal ===" && grep -n "WIZARD_DISMISSED_KEY\|function closeIntegrationWizard\|isAutoOpenFirstRun" src/client/App.svelte | head -`
- `echo "=== user-guide claims ===" && grep -n -i "path input\|upload mode\|Replay tutorial\|View Documentation\|reduce motion\|presence\|word count\|reading time\`
- `echo "=== detectTargets claude-code branch ===" && sed -n 715,790p src/server/integrations/apply.ts | grep -n "claude\|existsSync\|home" | head -20 && echo "===`
- `echo "=== useFileDrop 38-70 ===" && sed -n 38,70p src/client/hooks/useFileDrop.svelte.ts && echo "=== DocumentTabs 1325-1345 ===" && sed -n 1325,1345p src/clien`
- `echo "=== Wizard empty-state 855-885 ===" && sed -n 855,885p src/client/components/IntegrationWizardModal.svelte && echo "=== Wizard 1290-1305 ===" && sed -n 12`
- `echo "=== SettingsModal pointerdown 470-492 ===" && sed -n 470,492p src/client/components/SettingsModal.svelte && echo "=== e2e tab activation tests ===" && gre`
- `echo "=== keyboard-shortcuts.spec 90-130 ===" && sed -n 90,130p tests/e2e/keyboard-shortcuts.spec.ts && echo "=== DocumentTabs onBrowse 1345-1365 ===" && sed -n`
- `echo "=== About tab 170-180 ===" && sed -n 170,180p src/client/components/settings-tabs/SettingsAboutTab.svelte && echo "=== useClaudeCliStatus 66-92 ===" && se`
- `echo "=== onInstallClaude ===" && grep -n "onInstallClaude\|retryDetection\|async function installClaude\|justInstalled\|INSTALLED_ON_PATH\|force" src/client/co`
- `echo "=== detect route ===" && grep -rn "detectTargets(" src/server --include=*.ts | grep -v test | head && echo "=== integrations routes file ===" && ls src/se`
- `echo "=== existing-config 205-262 ===" && sed -n 205,262p src/server/integrations/existing-config.ts && echo "=== api-routes existing GET ===" && grep -n "API_I`
- `echo "=== install-claude-cli post-install ===" && grep -n "\.claude\b\|mkdir\|--version\|verify\|presence\|INSTALLED_ON_PATH\|INSTALLED_NOT_ON_PATH\|export asyn`
- `echo "=== client detect-claude-cli presence semantics ===" && grep -n "INSTALLED_ON_PATH\|INSTALLED_NOT_ON_PATH\|NOT_INSTALLED\|export function\|export async fu`
- `echo "=== Wizard 826-862 ===" && sed -n 826,862p src/client/components/IntegrationWizardModal.svelte && echo "=== tests referencing empty + presence ===" && gre`
- `echo "=== install test: post-install expectation ===" && grep -n "existing\|empty\|couldn't find\|INSTALLED_NOT_ON_PATH\|not-on-path\|Check again\|begin" tests/`
- `echo "=== wizard 886-912 ===" && sed -n 886,912p src/client/components/IntegrationWizardModal.svelte && echo "=== install test 130-175 ===" && sed -n 130,175p t`
- `echo "=== tauri externalBin / CLI on PATH ===" && grep -n "externalBin\|sidecar\|tandem-server\|\"tandem\"" src-tauri/tauri.conf.json | head && echo "=== reduce`
- `echo "=== FileOpenDialog 220-232 ===" && sed -n 220,232p src/client/components/FileOpenDialog.svelte && echo "=== SettingsModal 685-702 ===" && sed -n 685,702p `

## Probe/executed outputs (0)
