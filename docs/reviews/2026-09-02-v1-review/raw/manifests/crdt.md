# Coverage manifest: crdt

Generated from the agent transcript. Zero model tokens.

## Files touched (88)
- .claude/agents/crdt-reviewer.md
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bnmo2ftyd.txt
- docs/architecture.md
- docs/decisions.md
- docs/gotchas.md
- src/client
- src/client/components/OutlinePanel.svelte
- src/client/editor/
- src/client/editor/editor-extensions.ts
- src/client/editor/extensions/
- src/client/editor/extensions/annotation.ts
- src/client/editor/extensions/authorship.ts
- src/client/editor/extensions/awareness.ts
- src/client/editor/extensions/find-replace.ts
- src/client/editor/find-replace/
- src/client/editor/toolbar/Toolbar.svelte
- src/client/editor/toolbar/highlight-toggle.ts
- src/client/hooks/
- src/client/panels/useAnnotationReview.svelte.ts
- src/client/positions.ts
- src/plugins/sync-plugin.js
- src/server
- src/server/annotations/
- src/server/annotations/doc-hash.ts
- src/server/annotations/lifecycle.ts
- src/server/annotations/migrations/
- src/server/annotations/schema.ts
- src/server/annotations/sync.ts
- src/server/documents/
- src/server/documents/populate.ts
- src/server/documents/reload-family.ts
- src/server/documents/tutorial
- src/server/documents/watcher.ts
- src/server/file-io/
- src/server/file-io/docx-apply.ts
- src/server/file-io/docx-comment-export.ts
- src/server/file-io/docx-comments.ts
- src/server/file-io/docx-html.ts
- src/server/file-io/docx-walker.ts
- src/server/file-io/docx.ts
- src/server/file-io/hardbreak-normalize.ts
- src/server/file-io/index.ts
- src/server/file-io/line-endings.ts
- src/server/file-io/markdown.ts
- src/server/file-io/mdast-ydoc.ts
- src/server/file-io/plaintext-flatten.ts
- src/server/local-model/tools.ts
- src/server/mcp/
- src/server/mcp/annotations.ts
- src/server/mcp/awareness.ts
- src/server/mcp/document-model.ts
- src/server/mcp/document-store.ts
- src/server/mcp/document.ts
- src/server/mcp/docx-apply.ts
- src/server/mcp/list-edit.ts
- src/server/mcp/navigation.ts
- src/server/mcp/routes/
- src/server/mcp/tutorial-annotations.ts
- src/server/positions.ts
- src/server/tutorial
- src/shared/offsets.ts
- src/shared/positions/
- src/shared/positions/index.ts
- src/shared/positions/types.ts
- src/shared/positions/ydoc.ts
- src/shared/sanitize.ts
- src/shared/snapshot.ts
- src/shared/types.ts
- tests/client/
- tests/client/authorship-split.test.ts
- tests/client/authorship-stamp.test.ts
- tests/client/editor-roundtrip-harness.js
- tests/client/editor-roundtrip-harness.ts
- tests/client/flat-offset-container-boundary.test.ts
- tests/client/flat-offset-correspondence.test.ts
- tests/client/flat-projection-equivalence.test.ts
- tests/helpers/
- tests/helpers/docx-corpus.ts
- tests/helpers/docx-fixtures.ts
- tests/helpers/positions.ts
- tests/helpers/ydoc-factory.ts
- tests/server/
- tests/server/document-offset.test.ts
- tests/server/docx-comments.test.ts
- tests/server/positions.test.ts
- tests/server/relative-position.test.ts
- tests/server/resolve-annotation.test.ts
- tests/shared/

## Commands run (79)
- `cat <scratchpad>/open-issues.txt 2>/dev/null | head -200; echo "---"; ls <scratchpad-path>`
- `sed -n 300,400p docs/architecture.md`
- `cat src/shared/offsets.ts && echo "=====AGENT BRIEF=====" && cat .claude/agents/crdt-reviewer.md`
- `ls src/shared/positions/ src/server/annotations/ src/client/hooks/ src/client/editor/ src/client/editor/extensions/ src/server/file-io/ 2>&1; echo "---"; wc -l `
- `grep -n "ADR-0\(1[0-9]\|2[0-9]\|3[0-9]\)" docs/decisions.md | head -60`
- `grep -n -i "coordinate\|RelativePosition\|flat text\|flat offset" docs/architecture.md | head -40`
- `sed -n 113,124p docs/decisions.md; echo "=====ADR-032====="; sed -n 510,546p docs/decisions.md; echo "=====ADR-021====="; sed -n 150,161p docs/decisions.md`
- `cat -n src/server/positions.ts`
- `cat -n src/shared/positions/types.ts src/shared/positions/index.ts`
- `cat -n src/shared/positions/ydoc.ts`
- `cat -n src/client/positions.ts`
- `sed -n 631,720p docs/architecture.md`
- `cat -n src/server/mcp/document-model.ts`
- `cat -n src/client/editor/extensions/annotation.ts`
- `grep -n "hardBreak\|XmlText\|insert(\|attach\|fragment.insert\|fragment.push\|new Y.Xml\|whitespace\|\\\\n\|CRLF\|\\\\r" src/server/file-io/mdast-ydoc.ts | head`
- `grep -n "headingPrefix\|separator\|\\\\n\|flatOffset\|anchoredRange\|extractText\|offset" src/server/file-io/docx-comments.ts | head -100`
- `sed -n 50,330p <transcript tool result, not kept>`
- `sed -n 330,620p <transcript tool result, not kept>`
- `sed -n 620,830p <transcript tool result, not kept>`
- `sed -n 1,200p src/server/file-io/mdast-ydoc.ts`
- `sed -n 200,520p src/server/file-io/mdast-ydoc.ts`
- `sed -n 520,720p src/server/file-io/mdast-ydoc.ts`
- `sed -n 400,500p src/server/file-io/docx-comments.ts; echo "======"; sed -n 500,600p src/server/file-io/docx-comments.ts`
- `cat -n src/server/file-io/docx-walker.ts`
- `cat -n src/server/file-io/hardbreak-normalize.ts; echo "=====LINE-ENDINGS====="; cat -n src/server/file-io/line-endings.ts; echo "=====PLAINTEXT====="; cat -n s`
- `cat -n src/server/file-io/markdown.ts | head -200; echo "=====DOCX.TS====="; grep -n "htmlToYDoc\|mdastToYDoc\|injectCommentsAsAnnotations\|calculateCommentRang`
- `ls tests/server/ | grep -i "position\|offset\|range\|refresh\|anchor\|extract\|docx-comment\|flat\|textblock\|collect-block\|hardbreak\|resolve"; echo "---clien`
- `sed -n 1,140p tests/client/flat-offset-correspondence.test.ts`
- `grep -n "captureSnapshot\|anchoredRange\|validateRange\|refreshRange\|refreshAllRanges\|textSnapshot\|extractText\|flatDocLength" src/server/mcp/annotations.ts `
- `ls src/server/mcp/; echo "---"; grep -rn "pmSelectionToFlat\|pmPosToFlatOffset\|flatOffsetToPmPos\|annotationToPmRange\|flatTextForPmRange\|pmDocFlatText\|ancho`
- `grep -n "REPLACES the doc" -A 40 docs/gotchas.md | head -80; echo "=====YJS VERSION====="; node -e "console.log(require('yjs/package.json').version)"; node -e "`
- `grep -n "interface Annotation\b" -A 60 src/shared/types.ts | head -120`
- `grep -rn "tutorial" src/server --include=*.ts -l; echo "---"; grep -rn "range:\s*{" src/server/tutorial* src/server/documents/tutorial* 2>/dev/null | head; find`
- `grep -n "Annotation\b" src/shared/types.ts | head -20; echo "----"; grep -n "relRange\|range\b\|textSnapshot\|textSnapshotBreaks\|textSnapshotTruncated" src/sha`
- `cat -n tests/client/editor-roundtrip-harness.ts 2>/dev/null || cat -n tests/client/editor-roundtrip-harness.js`
- `sed -n 90,230p src/server/mcp/annotations.ts`
- `sed -n 260,420p src/server/mcp/document.ts`
- `sed -n 480,860p src/server/mcp/document.ts`
- `sed -n 170,330p src/server/documents/watcher.ts`
- `cat -n src/server/mcp/tutorial-annotations.ts`
- `cat -n src/client/editor/extensions/awareness.ts`
- `sed -n 1,140p src/client/panels/useAnnotationReview.svelte.ts`
- `ls src/server/annotations/migrations/; grep -rn "content-hash\|contentHash\|docHash\|#313" src/server/annotations/*.ts src/server/annotations/migrations/*.ts | `
- `grep -rn "tandem_replace\|tandem_find\|findReplace\|find-replace\|replaceAll" src/server/mcp/*.ts src/server/mcp/routes/*.ts | head -20; echo "---client find---`
- `sed -n 240,330p src/server/file-io/docx-html.ts; echo "....."; grep -n "hardBreak\|<br\|\\\\n\|whitespace\|textContent\|nodeValue\|\\\\r" src/server/file-io/doc`
- `cat -n src/server/documents/reload-family.ts | sed -n 1,200p`
- `sed -n 400,640p src/server/file-io/docx-html.ts`
- `sed -n 150,320p src/server/mcp/document-store.ts`
- `sed -n 300,420p src/server/annotations/lifecycle.ts; echo "......"; sed -n 700,800p src/server/annotations/lifecycle.ts`
- `sed -n 1,120p src/server/mcp/docx-apply.ts; echo "....."; grep -n "range\|offset\|extractText\|flat" src/server/file-io/docx-apply.ts | head -60`
- `grep -n "range\|offset\|walkDocumentBody\|flat\|heading" src/server/file-io/docx-comment-export.ts | head -60`
- `grep -rn "range: {\|range:{" src/client --include=*.ts --include=*.svelte | grep -v "test" | head -30; echo "----"; grep -rn "relRange" src/client --include=*.t`
- `cat -n src/server/mcp/navigation.ts | sed -n 1,200p`
- `sed -n 140,260p src/server/documents/populate.ts`
- `sed -n 140,420p src/client/panels/useAnnotationReview.svelte.ts`
- `cat -n src/shared/snapshot.ts; echo "=====SANITIZE range handling====="; grep -n "range\|relRange" src/shared/sanitize.ts | head -20; echo "=====SCHEMA relpos==`
- `sed -n 130,170p src/client/components/OutlinePanel.svelte; echo "=====AWARENESS SERVER====="; grep -n "focusParagraph\|focusOffset\|resolveToElement\|elementInd`
- `sed -n 225,420p src/server/mcp/annotations.ts`
- `grep -n "flatSpanOfChildren\|flatOffsetWithinList\|stampClaude\|anchoredRange\|refreshRange\|from\b.*to\b" src/server/mcp/list-edit.ts | head -30; echo "=====EX`
- `cat vitest.config.ts 2>/dev/null || cat vitest.config.mts 2>/dev/null || ls vitest*; echo "=====WORKSPACE====="; cat vitest.workspace.ts 2>/dev/null | head -80`
- `sed -n 770,880p src/client/editor/toolbar/Toolbar.svelte; echo "=====HIGHLIGHT-TOGGLE====="; cat -n src/client/editor/toolbar/highlight-toggle.ts`
- `grep -rn "focusParagraph\|focusOffset" src/server --include=*.ts | grep -v test | head -20; echo "=====SCHEMA====="; sed -n 55,115p src/server/annotations/schem`
- `sed -n 570,700p src/server/mcp/annotations.ts`
- `grep -n "flatSpanOfChildren\|flatOffsetWithinList\|stampClaude\|anchoredRange\|containerStart\|from:\|to:" src/server/mcp/list-edit.ts | head -40; echo "=====ge`
- `sed -n 240,300p src/client/editor/extensions/authorship.ts; echo ".........."; sed -n 370,415p src/client/editor/extensions/authorship.ts; echo ".........."; se`
- `sed -n 1280,1400p src/client/editor/extensions/authorship.ts`
- `sed -n 1,80p tests/client/flat-projection-equivalence.test.ts; echo "=====CORR (rest)====="; sed -n 140,330p tests/client/flat-offset-correspondence.test.ts`
- `head -60 src/client/editor/editor-extensions.ts; grep -n "^import" src/client/editor/editor-extensions.ts | wc -l`
- `sed -n 1,120p tests/server/positions.test.ts | head -120; grep -c "it(" tests/server/positions.test.ts tests/server/relative-position.test.ts tests/server/resol`
- `grep -ln "Collaboration\|ySyncPlugin\|new Editor(" tests/client/*.ts | head; echo "----"; sed -n 1,120p tests/client/authorship-stamp.test.ts`
- `for n in 1693 1622 1632 1523 1696; do echo "=============== #$n"; gh issue view $n --json title,body -q '.title + "\n" + .body' 2>&1 | head -120; done`
- `grep -n "computeChildEqualityFactor\|const updateYFragment\|updateLeft\|updateRight\|foundMappedChild\|equalityFactor" node_modules/y-prosemirror/src/plugins/sy`
- `grep -rn "refreshAllRanges\|refreshRange(" src/server --include=*.ts | grep -v "^src/server/positions.ts" | grep -v "export {" ; echo "----kind readers----"; gr`
- `grep -n "int()\|nonnegative\|flatDocLength\|z.number()" src/server/mcp/annotations.ts src/server/mcp/document.ts src/server/local-model/tools.ts 2>/dev/null | h`
- `sed -n 1,80p tests/server/docx-comments.test.ts; ls tests/helpers/; grep -n "export function\|export const" tests/helpers/ydoc-factory.ts tests/helpers/position`
- `grep -rn "Collaboration" src/client --include=*.ts --include=*.svelte -l | head; echo "----tests----"; grep -rln "Collaboration.configure\|Collaboration\b" test`
- `sed -n 1000,1045p node_modules/y-prosemirror/src/plugins/sync-plugin.js; echo "......"; sed -n 1145,1300p node_modules/y-prosemirror/src/plugins/sync-plugin.js`
- `sed -n 1,80p tests/helpers/docx-fixtures.ts; grep -n "export" tests/helpers/docx-fixtures.ts tests/helpers/docx-corpus.ts | head -30`
- `grep -n "ignoreEmptyParagraphs\|isEmpty\|emptyParagraph" node_modules/mammoth/lib/document-to-html.js node_modules/mammoth/lib/index.js node_modules/mammoth/lib`

## Probe/executed outputs (2)

### grep -n "REPLACES the doc" -A 40 docs/gotchas.md | head -80; echo "=====YJS VERSION====="; node -e "console.log(require('yjs/package.json').version)"; node -e "console.log(require('y-prosemirror/packa
(output 2219 chars)
```
<persisted-output>
Output too large (29.9KB). Full output saved to: <transcript tool result, not kept>

Preview (first 2KB):
95:- **A remote sync REPLACES the doc, so every inline decoration maps to nothing (#1669).** y-prosemirror's `_typeChanged` does not patch the ProseMirror doc, it rebuilds it: one `ReplaceStep` spanning the whole document, tagged with `ySyncPluginKey` meta. `InlineType.map` maps `from` with assoc `+1` and `to` with assoc `-1`, so every inline decoration collapses to `from >= to` and is dropped — highlights, comment underlines, suggestion squiggles and the authorship overlay all vanish on any MCP write or remote keystroke. **A plugin that only `.map()`s its `DecorationSet` on `docChanged` therefore loses its decorations, and an identity-keyed recovery gate cannot catch it**: `mapChildren` always returns a fresh `DecorationSet` once there are children, so the first mapped result is never the `DecorationSet.empty` singleton — sync N wipes, N+1 still fails the gate, and only N+2 can fire. The fix is to REBUILD on the tagged transaction rather than map: `_typeChanged` runs during Yjs transaction cleanup, so the Y.Doc is already updated and the CRDT anchors resolve to the right text, which mapping cannot do. `annotation.ts`, `authorship.ts` and `awareness.ts` each carry that branch; a **new** decoration plugin needs its own, because nothing structural forces one. Two existing plugins deliberately do NOT: `find-replace.ts` re-runs `walkMatches` on every `docChanged`, so it is immune by construction, and `annotationPing.ts` is map-only and therefore still loses its ping to a concurrent write — accepted, because a ping is a sub-second flourish and its absence is indistinguishable from it having finished. Three facts worth not re-deriving, all checked against the pinned y-prosemirror 1.3.7: local PM->Y edits carry no ySync meta (its own `mux` mutex suppresses the re-entrant fire), no awareness- or cursor-only transaction is tagged, and the UndoManager replay IS tagged (`isUndoRedoOperation`). So the branch fires on every remote character, every MCP write, every watcher reload
...
</persisted-output>
```

### cat vitest.config.ts 2>/dev/null || cat vitest.config.mts 2>/dev/null || ls vitest*; echo "=====WORKSPACE====="; cat vitest.workspace.ts 2>/dev/null | head -80
(output 4977 chars)
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
