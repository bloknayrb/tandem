# Coverage manifest: client-editor

Generated from the agent transcript. Zero model tokens.

## Files touched (96)
- .claude/agents/svelte-migration-reviewer.md
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/b3331q9pi.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/b5qjk23qx.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/b7k3oljqb.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/b7vyuaa0u.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bb6e4q5nc.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bcbvz1iqd.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bgzetq4y6.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bi9wmpzq8.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bkbecn7zk.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bkqus9fs8.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bky3irw9q.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bm03tpczo.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bnmotnkmh.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bp1z2zymq.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/br41dw0gb.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bsgjymnf5.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bsgnom15h.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/buym7g7fu.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bwkdckrih.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bxd70mxjt.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/byhzpof7k.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bynk0hzmo.txt
- docs/architecture.md
- docs/gotchas.md
- docs/mcp-tools.md
- skills/tandem/SKILL.md
- src/channel
- src/client
- src/client/
- src/client/App.svelte
- src/client/components/CommandPalette.svelte
- src/client/components/HelpModal.svelte
- src/client/components/OutlinePanel.svelte
- src/client/editor
- src/client/editor/
- src/client/editor/Editor.svelte
- src/client/editor/ScrollPill.svelte
- src/client/editor/SourceView.svelte
- src/client/editor/context-menu
- src/client/editor/editor-extensions.ts
- src/client/editor/editor-props.ts
- src/client/editor/editor.css
- src/client/editor/extensions
- src/client/editor/extensions/
- src/client/editor/extensions/annotation.ts
- src/client/editor/extensions/annotationPing.ts
- src/client/editor/extensions/authorship.ts
- src/client/editor/extensions/awareness.ts
- src/client/editor/extensions/find-replace.ts
- src/client/editor/extensions/heading-collapse.ts
- src/client/editor/extensions/list-item-checkbox.ts
- src/client/editor/find-replace
- src/client/editor/find-replace/FindReplaceBar.svelte
- src/client/editor/scroll-pill-controller.ts
- src/client/editor/scroll-pill.ts
- src/client/editor/slash-menu
- src/client/editor/toolbar
- src/client/editor/toolbar/FormattingToolbar.svelte
- src/client/editor/toolbar/Toolbar.svelte
- src/client/editor/utils
- src/client/editor/utils/
- src/client/editor/utils/url-safety.ts
- src/client/hooks
- src/client/hooks/useAppShortcuts.ts
- src/client/hooks/useTandemSettings.ts
- src/client/hooks/yjsSync.svelte.ts
- src/client/panels/ChatPanel.svelte
- src/client/panels/useAnnotationReview.svelte.ts
- src/client/positions.ts
- src/client/tabs/TabRenameInput.svelte
- src/client/utils/coalescing-tick.ts
- src/monitor
- src/plugins/sync-plugin.js
- src/server
- src/server/events/observers/awareness.ts
- src/server/file-io/docx-html.ts
- src/server/file-io/hardbreak-normalize.ts
- src/server/file-io/mdast-ydoc.ts
- src/server/mcp/
- src/server/mcp/awareness.ts
- src/server/mcp/document-model.ts
- src/server/mcp/document-store.ts
- src/server/mcp/tools/
- src/server/positions.ts
- src/shared
- src/shared/constants.ts
- src/shared/offsets.ts
- src/shared/positions/
- src/shared/positions/ydoc.ts
- tests/client/
- tests/client/editor-roundtrip-harness.js
- tests/client/editor-roundtrip-harness.ts
- tests/client/flat-offset-correspondence.test.ts
- tests/client/flat-projection-equivalence.test.ts
- tests/setup

## Commands run (127)
- `wc -l docs/architecture.md docs/gotchas.md .claude/agents/svelte-migration-reviewer.md <scratchpad-path>`
- `cat <repo>/docs/gotchas.md`
- `cat <repo>/.claude/agents/svelte-migration-reviewer.md`
- `cat <scratchpad>/open-issues.txt`
- `sed -n 1,400p <repo>/docs/architecture.md`
- `sed -n 400,1084p <repo>/docs/architecture.md`
- `grep -n '^##\|^###' <repo>/docs/gotchas.md; echo ---; grep -n '^##\|^###' <repo>/docs/architecture.md`
- `awk '/^### Y.js/,/^### MCP/' <repo>/docs/gotchas.md`
- `awk '/^### Client/,/^### Files/' <repo>/docs/gotchas.md`
- `sed -n 583,711p <repo>/docs/architecture.md`
- `sed -n 985,1036p <repo>/docs/architecture.md`
- `cat -n <repo>/src/client/positions.ts`
- `cat -n <repo>/src/server/positions.ts`
- `ls -la <repo>/src/shared/positions/ && for f in <repo>/src/shared/positions/*.ts; do echo "=== $f"; cat -n "$f"; done`
- `cat -n <repo>/src/shared/positions/ydoc.ts`
- `cat -n <repo>/src/shared/offsets.ts; echo ======; grep -n "export function\|^function" <repo>/src/server/mcp/document-model.ts`
- `sed -n 1,260p <repo>/src/server/mcp/document-model.ts`
- `sed -n 260,400p <repo>/src/server/mcp/document-model.ts`
- `cat -n <repo>/src/client/editor/editor-extensions.ts`
- `ls <repo>/src/client/editor/extensions <repo>/src/client/editor/utils <repo>/src/client/editor/toolbar <repo>/src/cl`
- `ls <repo>/tests/client/ | grep -i "position\|offset\|correspond\|flat\|equiv"; echo ---; grep -rn "pmDocFlatText\|extractText" <repo>/test`
- `cat -n <repo>/tests/client/flat-projection-equivalence.test.ts`
- `sed -n 1,130p <repo>/tests/client/flat-offset-correspondence.test.ts`
- `cat -n <repo>/src/client/editor/Editor.svelte`
- `cat -n <repo>/src/client/editor/editor-props.ts`
- `cat -n <repo>/src/client/editor/extensions/annotation.ts`
- `cat -n <repo>/src/client/editor/extensions/awareness.ts`
- `grep -rn "Y_MAP_ACTIVITY\|\.cursor\b" src/server src/shared src/monitor src/channel --include=*.ts | grep -v "^.*test" | head -40; echo ---; grep -rn "TYPING_DE`
- `cat -n <repo>/src/client/editor/extensions/authorship.ts | sed -n 1,400p`
- `cat -n <repo>/src/client/editor/extensions/authorship.ts | sed -n 400,800p`
- `cat -n <repo>/src/client/editor/extensions/authorship.ts | sed -n 800,1200p`
- `cat -n <repo>/src/client/editor/extensions/authorship.ts | sed -n 1200,1518p`
- `cat -n <repo>/src/client/utils/coalescing-tick.ts; echo ======; cat -n <repo>/src/client/editor/extensions/annotationPing.ts`
- `sed -n 240,300p <repo>/src/server/mcp/awareness.ts; echo "....."; sed -n 415,460p <repo>/src/server/mcp/awareness.ts; echo "....."; sed -n`
- `ls <repo>/tests/client/ | head -100; echo ---; cat -n <repo>/tests/client/editor-roundtrip-harness.ts 2>/dev/null || cat -n <repo>n`
- `cat -n <repo>/src/client/editor/extensions/heading-collapse.ts`
- `cat -n <repo>/src/client/editor/extensions/find-replace.ts`
- `cat -n <repo>/src/client/editor/extensions/list-item-checkbox.ts`
- `cd <repo>/src/client/editor/extensions && for f in plaintext-breaks.ts list-spread.ts selection-decoration.ts markdown-html.ts raw-markdown.ts footno`
- `cat <transcript tool result, not kept>`
- `cd <repo>/src/client/editor && cat -n extensions/table-column-align.ts extensions/table-align-commands.ts`
- `cd <repo>/src/client/editor/slash-menu && for f in index.ts suppression.ts extension.ts commands.ts; do echo "=== $f"; cat -n $f; done`
- `cd <repo>/src/client/editor/context-menu && for f in types.ts detect.ts dispatch.ts install.ts; do echo "=== $f"; cat -n $f; done`
- `cd <repo>/src/client/editor/toolbar && for f in handlers.ts highlight-toggle.ts selection-toolbar.ts annotation-composer-intent.ts; do echo "=== $f";`
- `grep -rn "\"Mod-\|'Mod-\|Mod-Shift\|Mod-Alt\|Alt-\|ctrlKey\|metaKey\|altKey\|e\.key ===\|event\.key ===\|key === \"" src/client --include=*.ts --include=*.svelt`
- `grep -rn -i "cursor" skills/tandem/SKILL.md docs/mcp-tools.md | head -30`
- `sed -n 895,960p <repo>/docs/mcp-tools.md`
- `sed -n 30,330p <transcript tool result, not kept>`
- `sed -n 330,600p <transcript tool result, not kept>`
- `sed -n 30,420p <transcript tool result, not kept>`
- `sed -n 420,800p <transcript tool result, not kept>`
- `cat -n <repo>/src/client/hooks/useAppShortcuts.ts`
- `cd <repo>/src/client/hooks && for f in useTabKeyboardShortcuts.ts useFindShortcuts.ts useTabCycleKeyboard.svelte.ts useTabCycleKeyboard.ts; do echo "`
- `cat -n <repo>/src/client/panels/useAnnotationReview.svelte.ts`
- `sed -n 30,420p <transcript tool result, not kept>`
- `sed -n 420,900p <transcript tool result, not kept>`
- `cat -n <repo>/src/client/editor/toolbar/Toolbar.svelte`
- `cat -n <repo>/src/client/editor/toolbar/FormattingToolbar.svelte`
- `cd <repo>/src/client/editor/toolbar && for f in LinkEditor.svelte HighlightColorPicker.svelte ModeToggle.svelte ToolbarButton.svelte; do echo "=== $f`
- `cd <repo>/src/client/editor/utils && cat -n markdown-paste.ts`
- `cd <repo>/src/client/editor/utils && cat -n paste-breaks.ts plain-paste.ts`
- `cd <repo>/src/client/editor/utils && cat -n paste-whitespace.ts literal-content.ts anchor-intercept.ts`
- `cd <repo>/src/client/editor/utils && cat -n relative-link.ts; grep -n "export function\|export const" url-safety.ts`
- `cat -n <repo>/src/client/editor/find-replace/FindReplaceBar.svelte`
- `cat -n <repo>/src/client/editor/SourceView.svelte`
- `cat -n <repo>/src/client/editor/scroll-pill.ts <repo>/src/client/editor/ScrollPill.svelte`
- `cat -n <repo>/src/client/editor/scroll-pill-controller.ts`
- `cat -n <repo>/src/client/hooks/yjsSync.svelte.ts | sed -n 1,400p`
- `cat -n <repo>/src/client/hooks/yjsSync.svelte.ts | sed -n 400,900p`
- `cd <repo>/src/client/hooks && wc -l yjsSync.svelte.ts useYjsSync.ts rebuild-scheduler.ts tab-reconcile.ts; cat -n useYjsSync.ts rebuild-scheduler.ts `
- `grep -n "annotation-accept-or-dismiss\|select-block\|annotation-next\|annotation-prev\|isComposing\|matchShortcut(" <repo>/src/client/App.svelte | he`
- `grep -n "</script>" <repo>/src/client/editor/toolbar/Toolbar.svelte <repo>/src/client/editor/find-replace/FindReplaceBar.svelte; wc -l /ho`
- `sed -n 42,400p <transcript tool result, not kept>`
- `sed -n 400,800p <transcript tool result, not kept>`
- `sed -n 800,1100p <transcript tool result, not kept>`
- `sed -n 60,330p <transcript tool result, not kept>`
- `sed -n 1470,1700p <repo>/src/client/App.svelte`
- `cat <repo>/vitest.config.ts 2>/dev/null || cat <repo>/vitest.config.mts; ls <repo>/tests/setup* <repo>/tests/*.ts 2>`
- `cd <repo>/src/client/hooks && wc -l *.ts | sort -n`
- `cat -n <repo>/src/server/events/observers/awareness.ts`
- `cd <repo>/src/client/hooks && for f in useTheme.ts useAccentHue.ts useDensity.ts useAnnotationPatterns.ts useHighContrast.ts useEditorFont.svelte.ts `
- `cd <repo>/src/client/hooks && for f in useReviewCompletion.svelte.ts useRadioGroup.svelte.ts useAppInfo.svelte.ts useUpdateAvailable.svelte.ts useAnn`
- `cd <repo>/src/client/hooks && for f in useCoworkStatus.svelte.ts useDragResize.svelte.ts useCoworkPreflight.svelte.ts useBugReportUrl.svelte.ts useTa`
- `cd <repo>/src/client/hooks && for f in useTutorial.svelte.ts useTheme.svelte.ts useUpdaterChannel.svelte.ts useClaudeCliStatus.svelte.ts useMarginPos`
- `cd <repo>/src/client/hooks && for f in useCwdDrift.svelte.ts useReachabilityCheck.svelte.ts useChatState.svelte.ts useTandemModeBroadcast.svelte.ts; `
- `cd <repo>/src/client/hooks && cat -n useNotifications.svelte.ts useIntegrationWizard.svelte.ts`
- `cd <repo>/src/client/hooks && cat -n useDocumentWorkspace.svelte.ts`
- `cd <repo>/src/client/hooks && cat -n useModels.svelte.ts`
- `cd <repo>/src/client/hooks && cat -n useScratchpadPersistence.svelte.ts`
- `cd <repo>/src/client/hooks && cat -n useAiReadiness.svelte.ts`
- `cd <repo>/src/client/hooks && sed -n 1,520p useTandemSettings.ts | cat -n | sed -n 1,520p`
- `cd <repo>/src/client/hooks && cat -n useTandemSettings.ts | sed -n 520,1038p`
- `cd <repo>/src/client/hooks && cat -n useTauriTheme.svelte.ts | sed -n 1,620p`
- `cd <repo>/src/client/hooks && cat -n useTauriTheme.svelte.ts | sed -n 620,1224p`
- `grep -n "onSlashCommandMenuChange\|<Editor\b" src/client/App.svelte | head; echo ---; grep -rn "isComposing" src/client --include=*.svelte --include=*.ts | grep`
- `mkdir -p <scratchpad>/harness && ln -sfn <repo>/node_modules <scratchpad-path>`
- `cd <scratchpad>/harness && timeout 300 <repo>/node_modules/.bin/vitest run --confi`
- `sed -n 1,400p <transcript tool result, not kept>`
- `sed -n 400,900p <transcript tool result, not kept>`
- `sed -n 1,500p <transcript tool result, not kept>`
- `sed -n 500,1100p <transcript tool result, not kept>`
- `sed -n 1,520p <transcript tool result, not kept>`
- `sed -n 520,1100p <transcript tool result, not kept>`
- `sed -n 1,520p <transcript tool result, not kept>`
- `sed -n 520,1100p <transcript tool result, not kept>`
- `sed -n 1,540p <transcript tool result, not kept>`
- `sed -n 540,1100p <transcript tool result, not kept>`
- `sed -n 1,480p <transcript tool result, not kept>`
- `sed -n 480,900p <transcript tool result, not kept>`
- `sed -n 1,600p <transcript tool result, not kept>`
- `sed -n 1,700p <transcript tool result, not kept>`
- `sed -n 1,420p <transcript tool result, not kept>`
- `sed -n 420,800p <transcript tool result, not kept>`
- `sed -n 1,520p <transcript tool result, not kept>`
- `sed -n 1,620p <transcript tool result, not kept>`
- `sed -n 1,620p <transcript tool result, not kept>`
- `sed -n 170,200p <repo>/src/client/panels/ChatPanel.svelte; echo ----; cat -n <repo>/src/server/file-io/hardbreak-normalize.ts | head -80; `
- `cd <scratchpad>/harness && python3 - <<'EOF' import re p='a-bugs.test.ts' s=open(p).read() s=`
- `grep -n "tandem-annotation-active" src/client/editor/editor.css src/client/**/*.css src/client/**/*.svelte 2>/dev/null | head; echo ---; sed -n 50,62p src/clien`
- `sed -n 40,400p <transcript tool result, not kept>`
- `sed -n 400,700p <transcript tool result, not kept>`
- `sed -n 40,600p <transcript tool result, not kept> | grep -n "\$state\|\$effect\|\$derived\`
- `grep -n "\$state\|\$effect\|\$derived\|export function\|setTimeout\|setInterval\|addEventListener\|import.meta.hot" <transcript-path>`
- `sed -n 555,1038p <repo>/src/client/hooks/useTandemSettings.ts | grep -n "function \|localStorage\|_readOnly\|schemaVersion" | head -40`
- `cd <scratchpad>/harness && timeout 300 <repo>/node_modules/.bin/vitest run --confi`
- `cd <scratchpad>/harness && timeout 300 <repo>/node_modules/.bin/vitest run --confi`
- `grep -n "Enter\|Ctrl+W\|Ctrl+N\|Ctrl+T\b\|Alt+\[" src/client/components/HelpModal.svelte | head -30; echo ---; grep -n "Enter" node_modules/@tiptap/extension-ha`

## Probe/executed outputs (6)

### cat <repo>/vitest.config.ts 2>/dev/null || cat <repo>/vitest.config.mts; ls <repo>/tests/setup* <repo>/tests/*.ts 2>/dev/null | head
(output 5064 chars)
```
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@server": path.resolve(__dirname, "src/server"),
      "@client": path.resolve(__dirname, "src/client"),
    },
  },
  test: {
    projects: [
      {
        // Client tests: Svelte components need browser conditions + DOM environment
        plugins: [svelte({ hot: false })],
        resolve: {
          conditions: ["browser"],
          alias: {
            "@shared": path.resolve(__dirname, "src/shared"),
            "@server": path.resolve(__dirname, "src/server"),
            "@client": path.resolve(__dirname, "src/client"),
          },
        },
        test: {
          name: "client",
          environment: "happy-dom",
          include: ["tests/client/**/*.test.ts"],
          // Same reason the node project below carries 15s, and the same
          // number: under vitest's parallel pool this project's specs exceed
          // the 5s default while doing nothing unusual. `useTauriFileDrop`
          // runs 18 specs in 2.9s alone (~160ms each) and times out at 5s when
          // the machine is loaded -- a ~30x spread, so the ceiling was
          // measuring contention, not the code.
          //
          // The asymmetry was the bug: the node project was given headroom
          // when it hit this and the client project never was, so every
          // developer running the suite alongside anything else lost time to
          // a red run that reproduced nowhere. Tests that genuinely hang still
          // surface at 15s.
          testTimeout: 15_000,
        },
      },
      {
        // Server / CLI / other tests: Node environment, no browser conditions
        resolve: {
          alias: {
            "@shared": path.resolve(__dirname, "src/shared"),
            "@server": path.resolve(__dirname, "src/server"),
            "@client": path.resolve(__dirname, "src/client"),
          },
        },
        test: {
          name: "node",
          environment: "node",
          // `exclude`, NOT a negated `include` entry. `include: [..., "!tests/client/**"]`
          // selects exactly the same 324 files -- verified by diffing
          // `vitest list --project=node --filesOnly` across both spellings -- but it
          // silently collects NO V8 coverage for any of them. Measured: with the
          // negation, `vitest run --project=node <any test> --coverage` reports
          // `Unknown% ( 0/0 )` and exits 0; with this spelling the same command
          // reports real per-file numbers. Because a run spanning both projects
          // aggregates to the same 0/0, every coverage run of the whole suite was
          // reporting nothing while exiting successfully -- the #1229 shape, and it
          // would have seeded Uni
```

### mkdir -p <scratchpad>/harness && ln -sfn <repo>/node_modules <scratchpad-path>
(output 244 chars)
```
ok
total 12
drwxr-xr-x 2 root root 4096 Sep  2 13:40 .
drwx------ 4 root root 4096 Sep  2 13:40 ..
lrwxrwxrwx 1 root root   30 Sep  2 13:40 node_modules -> <repo>/node_modules
-rw-r--r-- 1 root root  522 Sep  2 13:40 vitest.config.ts
```

### cd <scratchpad>/harness && timeout 300 <repo>/node_modules/.bin/vitest run --config ./vitest.config.ts a-bugs.test.ts 2>&1
(output 5603 chars)
```
1:41:55 PM [vite-plugin-svelte] invalid plugin options "hot" in inline config
{ hot: false }
1:41:55 PM [vite-plugin-svelte] no Svelte config found at <scratchpad>/harness - using default configuration.

 RUN  v4.1.11 <scratchpad>/harness

stdout | a-bugs.test.ts > B: find-replace positions after a hardBreak > matches the wrong characters and replaces the wrong text
match: { from: 6, to: 11 } covers: "<hardBreak>brav"
after replaceActive: <p>alphaXXXXXo charlie</p>

stdout | a-bugs.test.ts > B: find-replace positions after a hardBreak > replaceAll with two breaks compounds the drift
after replaceAll cat->dog: <p>one<br>twdogat sat</p>

 × a-bugs.test.ts > A: activity.cursor is a PM position, not a flat offset > shows the drift on a heading + list document 4ms
   → Cannot access 'ydoc' before initialization
 ✓ a-bugs.test.ts > B: find-replace positions after a hardBreak > matches the wrong characters and replaces the wrong text 41ms
 ✓ a-bugs.test.ts > B: find-replace positions after a hardBreak > replaceAll with two breaks compounds the drift 11ms
 × a-bugs.test.ts > C: structural edits vs annotation anchors > Enter in the middle of an annotated range 1ms
   → Cannot access 'ydoc' before initialization
 × a-bugs.test.ts > C: structural edits vs annotation anchors > Backspace-join: annotation in the SECOND paragraph shifts by one 0ms
   → Cannot access 'ydoc' before initialization
 × a-bugs.test.ts > C: structural edits vs annotation anchors > Enter at START of an annotated paragraph (control, should survive) 0ms
   → Cannot access 'ydoc' before initialization
 × a-bugs.test.ts > C: structural edits vs annotation anchors > Heading toggle on an annotated paragraph 0ms
   → Cannot access 'ydoc' before initialization
 × a-bugs.test.ts > C: structural edits vs annotation anchors > Wrap annotated paragraph in a bullet list 0ms
   → Cannot access 'ydoc' before initialization

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 6 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  a-bugs.test.ts > A: activity.cursor is a PM position, not a flat offset > shows the drift on a heading + list document
ReferenceError: Cannot access 'ydoc' before initialization
 ❯ a-bugs.test.ts:50:38
     48|   it("shows the drift on a heading + list document", async () => {
     49|     const { ydoc, editor } = makeEditor("# Title\n\nSome text here\n\n…
     50|       AwarenessExtension.configure({ ydoc }),
       |                                      ^
     51|     ]);
     52|     const flat = extractText(ydoc);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/6]⎯

 FAIL  a-bugs.test.ts > C: structural edits vs annotation anchors > Enter in the middle of an annotated range
ReferenceError: Cannot access 'ydoc' before initialization
 ❯ a-bugs.test.ts:152:39
    150|   it("Enter in the middle of an annotated range", () => {
    151|     const { ydoc, editor } = makeEditor("The quick brown fox jumps.\n"…
    152|       AnnotationE
```

### cd <scratchpad>/harness && python3 - <<'EOF' import re p='a-bugs.test.ts' s=open(p).read() s=s.replace('''function makeEditor(md: str
(output 6252 chars)
```
50:      AwarenessExtension.configure({ ydoc: y }),
151:    const { ydoc, editor } = makeEditor("The quick brown fox jumps.\n", (y) => [AnnotationExtension.configure({ ydoc: y })]);
164:    const { ydoc, editor } = makeEditor("alpha\n\nbravo charlie delta\n", (y) => [AnnotationExtension.configure({ ydoc: y })]);
179:    const { ydoc, editor } = makeEditor("alpha\n\nbravo charlie delta\n", (y) => [AnnotationExtension.configure({ ydoc: y })]);
191:    const { ydoc, editor } = makeEditor("alpha\n\nbravo charlie delta\n", (y) => [AnnotationExtension.configure({ ydoc: y })]);
202:    const { ydoc, editor } = makeEditor("alpha\n\nbravo charlie delta\n", (y) => [AnnotationExtension.configure({ ydoc: y })]);
{ hot: false }

 RUN  v4.1.11 <scratchpad>/harness

stdout | a-bugs.test.ts > A: activity.cursor is a PM position, not a flat offset > shows the drift on a heading + list document
flat text: "# Title\nSome text here\none\ntwo Zthree"
activity: { isTyping: true, cursor: 38, lastEdit: 1788356573840 } selection: { from: 32, to: 32, timestamp: 1788356573640 }
PM selection.from: 38 flat of selection: 32
text at activity.cursor read as flat offset: "hree"

 ✓ a-bugs.test.ts > A: activity.cursor is a PM position, not a flat offset > shows the drift on a heading + list document 372ms
stdout | a-bugs.test.ts > B: find-replace positions after a hardBreak > matches the wrong characters and replaces the wrong text
match: { from: 6, to: 11 } covers: "<hardBreak>brav"
after replaceActive: <p>alphaXXXXXo charlie</p>

stdout | a-bugs.test.ts > B: find-replace positions after a hardBreak > replaceAll with two breaks compounds the drift
after replaceAll cat->dog: <p>one<br>twdogat sat</p>

stdout | a-bugs.test.ts > C: structural edits vs annotation anchors > Enter in the middle of an annotated range
doc after split: "The quick \nbrown fox jumps."
Enter mid-range {
  clientResolve: { from: 5, to: 11, method: 'rel' },
  clientText: 'quick ',
  serverKind: 'updated',
  serverRange: { from: 4, to: 10 },
  serverText: 'quick ',
  hasRelRangeAfter: true
}

stdout | a-bugs.test.ts > C: structural edits vs annotation anchors > Backspace-join: annotation in the SECOND paragraph shifts by one
joinBackward ok: true doc: "alphabravo charlie delta"
Backspace join {
  clientResolve: { from: 13, to: 20, method: 'flat' },
  clientText: 'harlie ',
  serverKind: 'repaired',
  serverRange: { from: 12, to: 19 },
  serverText: 'harlie ',
  hasRelRangeAfter: true
}
Backspace join (second refresh) {
  clientResolve: { from: 13, to: 20, method: 'rel' },
  clientText: 'harlie ',
  serverKind: 'ok',
  serverRange: { from: 12, to: 19 },
  serverText: 'harlie ',
  hasRelRangeAfter: true
}

stderr | a-bugs.test.ts > C: structural edits vs annotation anchors > Backspace-join: annotation in the SECOND paragraph shifts by one
[positions] annotationToPmRange: relRange resolved to null for a2, falling back to flat
[annotation] relRange
```

### cd <scratchpad>/harness && timeout 300 <repo>/node_modules/.bin/vitest run --config ./vitest.config.ts d-flat.test.ts 2>&1
(output 6706 chars)
```
{ hot: false }

 RUN  v4.1.11 <scratchpad>/harness

stdout | d-flat.test.ts > D: client and server flat projections agree on every corpus shape > emoji in list
[emoji in list] anchors
  f=6 -> pm 13/9 -> flat 7/6

stdout | d-flat.test.ts > D: client and server flat projections agree on every corpus shape > nested list 3 deep
[nested list 3 deep] anchors
  f=1 -> pm 8/4 -> flat 2/1
  f=3 -> pm 13/9 -> flat 4/3
  f=5 -> pm 20/14 -> flat 6/5
  f=7 -> pm 27/21 -> flat 8/7

stdout | d-flat.test.ts > D: client and server flat projections agree on every corpus shape > blockquote > list > code
[blockquote > list > code] anchors
  f=4 -> pm 10/8 -> flat 5/4
  f=9 -> pm 18/14 -> flat 10/9

stderr | d-flat.test.ts > D: client and server flat projections agree on every corpus shape > table with empty cell
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.

stdout | d-flat.test.ts > D: client and server flat projections agree on every corpus shape > table with emoji
[table with emoji] anchors
  f=2 -> pm 10/6 -> flat 3/2
  f=4 -> pm 17/11 -> flat 5/4
  f=6 -> pm 22/18 -> flat 7/6

stderr | d-flat.test.ts > D: client and server flat projections agree on every corpus shape > table with emoji
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.

stdout | d-flat.test.ts > D: client and server flat projections agree on every corpus shape > heading in list
[heading in list] anchors
  f=7 -> pm 14/10 -> flat 8/7

 ✓ d-flat.test.ts > D: client and server flat projections agree on every corpus shape > emoji in paragraph 27ms
 ✓ d-flat.test.ts > D: client and server flat projections agree on every corpus shape > emoji in heading 6ms
 × d-flat.test.ts > D: client and server flat projections agree on every corpus shape > emoji in list 13ms
   → expected [ 'f=6 -> pm 13/9 -> flat 7/6' ] to deeply equal []
 ✓ d-flat.test.ts > D: client and server flat projections agree on every corpus shape > family emoji ZWJ 4ms
 ✓ d-flat.test.ts > D: client and server flat projections agree on every corpus shape > image block 6ms
 ✓ d-flat.test.ts > D: client and server flat projections agree on every corpus shape > image in list 4ms
 ✓ d-flat.test.ts > D: client and server flat projections agree on every corpus shape > image then text in list item 4ms
 ✓ d-flat.test.ts 
```

### cd <scratchpad>/harness && timeout 300 <repo>/node_modules/.bin/vitest run --config ./vitest.config.ts e-keys.test.ts 2>&1
(output 2194 chars)
```
{ hot: false }

 RUN  v4.1.11 <scratchpad>/harness

stdout | e-keys.test.ts > E1: slash menu inside a code block > opens on '/' typed at the start of a code-block line and Enter runs a block command
slash active in codeBlock: { from: 9, to: 11, query: 'e', selectedIndex: 0 } parent: codeBlock
after Enter, doc: "<p>echo hi\n</p>" prevented: true

stdout | e-keys.test.ts > E1: slash menu inside a code block > opens on '/' after a space inside a code block too
slash active after 'cd /t': { from: 4, to: 6, query: 't', selectedIndex: 0 }
after Enter, doc: "<p>cd </p>"

stdout | e-keys.test.ts > E2: AltGr (Ctrl+Alt on Windows) letters match Ctrl shortcuts > Polish ś / ń / ó (AltGr+S/N/O) fire save / new-scratchpad / open-file
ś: { id: 'save' }
ń: { id: 'new-scratchpad' }
ó: { id: 'open-file' }
ą: { id: 'toggle-authorship' }
Romanian ț (AltGr+T): { id: 'reopen-closed-tab' }
German € (AltGr+E): null
German @ (AltGr+Q): null
German { (AltGr+7): { id: 'pick-tab', context: { tabIndex: 7 } }
German [ (AltGr+8): { id: 'pick-tab', context: { tabIndex: 8 } }

 ✓ e-keys.test.ts > E1: slash menu inside a code block > opens on '/' typed at the start of a code-block line and Enter runs a block command 74ms
 ✓ e-keys.test.ts > E1: slash menu inside a code block > opens on '/' after a space inside a code block too 23ms
 ✓ e-keys.test.ts > E2: AltGr (Ctrl+Alt on Windows) letters match Ctrl shortcuts > Polish ś / ń / ó (AltGr+S/N/O) fire save / new-scratchpad / open-file 2ms
stdout | e-keys.test.ts > E3: Ctrl+Enter is also Tiptap's hard-break chord > inserts a hardBreak in the editor on Ctrl+Enter (before App's accept handler sees it)
Ctrl+Enter -> html: <p>a<br>bc</p> defaultPrevented: true
App matcher for the same event: { id: 'annotation-accept-or-dismiss', context: { shift: false } }

 ✓ e-keys.test.ts > E3: Ctrl+Enter is also Tiptap's hard-break chord > inserts a hardBreak in the editor on Ctrl+Enter (before App's accept handler sees it) 23ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  13:46:09
   Duration  1.06s (transform 348ms, setup 0ms, import 500ms, tests 124ms, environment 263ms)
```
