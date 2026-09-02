# Coverage manifest: server-data

Generated from the agent transcript. Zero model tokens.

## Files touched (101)
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/b551loejo.txt
- .claude/projects/-home-user-tandem/10b2005f-9798-55d6-8f09-2eba1cfdb6ab/tool-results/bavho2lkh.txt
- docs/architecture.md
- docs/decisions.md
- docs/gotchas.md
- docs/mcp-tools.md
- docs/positioning.md
- docs/troubleshooting.md
- skills/tandem/SKILL.md
- src/client
- src/client/editor/editor.css
- src/client/editor/extensions/markdown-html.ts
- src/client/hooks/useDocumentWorkspace.svelte.ts
- src/client/hooks/yjsSync.svelte.ts
- src/client/positions.ts
- src/server
- src/server/
- src/server/annotations
- src/server/annotations/
- src/server/annotations/doc-hash.ts
- src/server/annotations/lockfile.ts
- src/server/annotations/migrations/
- src/server/annotations/rename-recovery.ts
- src/server/annotations/schema.ts
- src/server/annotations/store.ts
- src/server/annotations/sync.ts
- src/server/documents
- src/server/documents/
- src/server/documents/annotation-wiring.ts
- src/server/documents/autosave.ts
- src/server/documents/conflict.ts
- src/server/documents/dirty.ts
- src/server/documents/open.ts
- src/server/documents/populate.ts
- src/server/documents/reload-family.ts
- src/server/documents/watcher.ts
- src/server/file-io
- src/server/file-io/
- src/server/file-io/doc-backup.ts
- src/server/file-io/docx-apply.ts
- src/server/file-io/docx-comment-export.ts
- src/server/file-io/docx-comments.ts
- src/server/file-io/docx-export.ts
- src/server/file-io/docx-html.ts
- src/server/file-io/docx-lost-features.ts
- src/server/file-io/docx-verify.ts
- src/server/file-io/docx-walker.ts
- src/server/file-io/docx.ts
- src/server/file-io/hardbreak-normalize.ts
- src/server/file-io/index.ts
- src/server/file-io/line-endings.ts
- src/server/file-io/markdown.ts
- src/server/file-io/mdast-ydoc.ts
- src/server/file-io/plaintext-flatten.ts
- src/server/file-io/reaper.ts
- src/server/file-io/types.ts
- src/server/file-watcher.ts
- src/server/index.ts
- src/server/mcp/
- src/server/mcp/annotations.ts
- src/server/mcp/document-model.ts
- src/server/mcp/document-service.ts
- src/server/mcp/document-store.ts
- src/server/mcp/document.ts
- src/server/mcp/docx-apply.ts
- src/server/mcp/navigation.ts
- src/server/mcp/routes/close.ts
- src/server/mcp/tutorial-annotations.ts
- src/server/positions.ts
- src/server/session
- src/server/session/
- src/server/session/manager.ts
- src/server/sessions
- src/server/sessions/
- src/server/sessions/context.ts
- src/server/yjs
- src/server/yjs/
- src/server/yjs/lifecycle.ts
- src/server/yjs/provider.ts
- src/shared
- src/shared/constants.ts
- src/shared/image-src-safety.ts
- src/shared/offsets.ts
- src/shared/positions
- src/shared/positions/
- src/shared/positions/index.ts
- src/shared/positions/types.ts
- src/shared/positions/ydoc.ts
- src/shared/snapshot.ts
- tests/fixtures/
- tests/fixtures/roundtrip
- tests/server
- tests/server/
- tests/server/docx
- tests/server/docx-roundtrip-fidelity.test.ts
- tests/server/file-io/
- tests/server/file-io/roundtrip-corpus.test.ts
- tests/server/file-watcher
- tests/server/file-watcher.test.ts
- tests/server/markdown-fidelity.test.ts
- tests/server/session

## Commands run (100)
- `wc -l <scratchpad>/open-issues.txt && ls <repo>/src/server/documents <repo>`
- `cat <scratchpad>/open-issues.txt`
- `wc -l <repo>/docs/architecture.md <repo>/docs/gotchas.md <repo>/docs/decisions.md; grep -n "^## \|^### " <repo>/docs`
- `grep -n "^## \|^### " <repo>/docs/gotchas.md; echo ----; grep -n "^## \|^### ADR" <repo>/docs/decisions.md | head -100`
- `wc -l src/server/documents/*.ts src/server/file-io/*.ts src/server/annotations/*.ts src/server/annotations/migrations/* src/server/positions.ts src/shared/posit`
- `sed -n 101,235p <repo>/docs/architecture.md`
- `sed -n 583,710p <repo>/docs/architecture.md`
- `sed -n 86,178p <repo>/docs/gotchas.md`
- `sed -n 38,45p <repo>/docs/decisions.md; echo ----; sed -n 113,123p <repo>/docs/decisions.md; echo ----; sed -n 150,171p <repo>/`
- `sed -n 640,803p <repo>/docs/decisions.md`
- `sed -n 804,1035p <repo>/docs/decisions.md`
- `sed -n 86,178p <repo>/docs/gotchas.md | cut -c1-1200`
- `cat <repo>/src/server/file-io/markdown.ts`
- `cat <repo>/src/server/file-io/line-endings.ts <repo>/src/server/file-io/hardbreak-normalize.ts <repo>/src/server/file-io/types.`
- `cat <repo>/src/server/file-io/index.ts`
- `sed -n 1,420p <repo>/src/server/file-io/mdast-ydoc.ts`
- `sed -n 420,860p <repo>/src/server/file-io/mdast-ydoc.ts`
- `sed -n 860,1255p <repo>/src/server/file-io/mdast-ydoc.ts`
- `wc -l <repo>/src/server/mcp/document-model.ts; sed -n 1,400p <repo>/src/server/mcp/document-model.ts`
- `sed -n 400,900p <repo>/src/server/mcp/document-model.ts`
- `cat <repo>/src/server/positions.ts`
- `cat <repo>/src/shared/positions/ydoc.ts <repo>/src/shared/positions/types.ts <repo>/src/shared/positions/index.ts`
- `sed -n 1,330p <repo>/src/server/documents/open.ts`
- `sed -n 330,700p <repo>/src/server/documents/open.ts`
- `sed -n 700,996p <repo>/src/server/documents/open.ts`
- `cat <repo>/src/server/documents/populate.ts`
- `cat <repo>/src/server/documents/watcher.ts <repo>/src/server/documents/conflict.ts <repo>/src/server/documents/autosave.ts`
- `cat <repo>/src/server/documents/reload-family.ts`
- `cat <repo>/src/server/documents/dirty.ts <repo>/src/server/documents/annotation-wiring.ts`
- `ls <repo>/src/server/*.ts; wc -l <repo>/src/server/file-watcher.ts; cat <repo>/src/server/file-watcher.ts`
- `mkdir -p <scratchpad>/exp && cd <scratchpad-path>`
- `grep -rn "rename\|eventType\|'change'\|\"change\"" tests/server/file-watcher*.test.ts tests/server/*watcher* 2>/dev/null | head -40; ls tests/server | grep -i w`
- `grep -n "saveDocumentToDisk\|external\|mtimeMs\|lastSavedAt\|suppressNextChange\|recordSelfWrite\|snapshotBeforeFirstWrite\|atomicWrite" src/server/mcp/document`
- `cat src/server/file-io/doc-backup.ts`
- `sed -n 1,400p src/server/session/manager.ts`
- `sed -n 400,802p src/server/session/manager.ts; cat src/server/sessions/context.ts`
- `cat src/server/yjs/provider.ts src/server/yjs/lifecycle.ts`
- `cat src/server/mcp/tutorial-annotations.ts; grep -rn "surrogate\|\\\\uD800\|0xD800\|codePointAt" src/server src/shared src/client --include=*.ts --include=*.sve`
- `sed -n 240,560p src/server/mcp/document-service.ts`
- `sed -n 1280,1560p src/server/mcp/document-service.ts`
- `cat src/server/annotations/store.ts`
- `cat src/server/annotations/sync.ts`
- `cat src/server/annotations/schema.ts src/server/annotations/migrations/*.ts`
- `cat src/server/annotations/rename-recovery.ts src/server/annotations/doc-hash.ts src/server/annotations/lockfile.ts`
- `cat src/shared/offsets.ts src/shared/snapshot.ts; grep -n "FFFD\|surrogate" src/server/mcp/*.ts src/shared/constants.ts | head; ls src/server/mcp/`
- `sed -n 1,200p src/client/positions.ts; grep -rn "markdownRaw\|data-markdown-raw\|markdown-raw" src/client --include=*.ts --include=*.svelte --include=*.css -l`
- `ls tests/server/file-io/ tests/fixtures/ | head -80; grep -n "it(\|describe(\|test(" tests/server/file-io/roundtrip-corpus.test.ts | head -40`
- `cd <scratchpad>/exp && cat > rt.ts <<'EOF' import * as Y from "yjs"; import { loadMarkdown, s`
- `sed -n 1,200p src/server/file-io/docx-comments.ts`
- `sed -n 200,520p src/server/file-io/docx-comments.ts`
- `sed -n 520,834p src/server/file-io/docx-comments.ts`
- `cat src/server/file-io/docx.ts && sed -n 1,120p src/server/file-io/docx-html.ts`
- `cat src/server/file-io/plaintext-flatten.ts src/server/file-io/reaper.ts`
- `grep -n "tandem_edit\|replaceFlatRange\|resolveToTextblock\|surrogate\|FFFD" src/server/mcp/document.ts | head -30; grep -rn "captureSnapshot" src/server --incl`
- `cat src/client/editor/extensions/markdown-html.ts; grep -n "raw-md\|markdown-raw\|hide-raw" src/client/editor/editor.css | head`
- `cd <scratchpad>/exp && head -40 rt-out.md`
- `cat <transcript tool result, not kept>`
- `cat <transcript tool result, not kept>`
- `sed -n 540,760p <repo>/src/server/mcp/document.ts`
- `grep -n "captureSnapshot" -A 60 <repo>/src/server/mcp/document-model.ts | head -5; grep -n "export function captureSnapshot\|function captureSnapshot`
- `sed -n 560,830p <repo>/src/server/mcp/document-service.ts`
- `grep -n "restoreOpenDocuments" -A 80 <repo>/src/server/mcp/document-service.ts | sed -n 1,120p; grep -rn "reapOrphanedTemps" <repo>/src --`
- `sed -n 1,140p <repo>/src/server/file-io/docx-apply.ts`
- `sed -n 140,520p <repo>/src/server/file-io/docx-apply.ts`
- `cat <repo>/src/server/file-io/docx-walker.ts; sed -n 120,400p <repo>/src/server/file-io/docx-html.ts`
- `sed -n 1,62p <repo>/tests/server/file-io/roundtrip-corpus.test.ts; ls <repo>/tests/fixtures/roundtrip; grep -n "982\|gap\|degrade\|it.skip`
- `cd <scratchpad>/exp && ln -sfn <repo>/node_modules node_modules && echo '{"type":"`
- `cd <scratchpad>/exp && cat > exp2.ts <<'EOF' import * as Y from "yjs"; import { loadMarkdown,`
- `sed -n 30,330p <repo>/src/server/annotations/sync.ts`
- `sed -n 330,768p <repo>/src/server/annotations/sync.ts`
- `sed -n 40,400p <repo>/src/server/file-io/doc-backup.ts`
- `sed -n 400,732p <repo>/src/server/file-io/doc-backup.ts`
- `cat <repo>/src/server/file-io/docx-comment-export.ts | sed -n 1,200p`
- `sed -n 200,465p <repo>/src/server/file-io/docx-comment-export.ts; sed -n 520,700p <repo>/src/server/file-io/docx-apply.ts`
- `cat <repo>/src/server/mcp/routes/close.ts 2>/dev/null | head -80; grep -rn "api/close" <repo>/src/client --include=*.ts --include=*.svelte`
- `gh issue view 1708 --json title,body -q '.body' | head -120; echo ======; gh issue view 1663 --json body -q '.body' | head -40; echo =====; gh issue view 1696 -`
- `cd <scratchpad>/exp && awk '/^### /{name=$0} /byte-identical: false/{p=1; print name} /byte-i`
- `cd <scratchpad>/exp && cat > exp3.ts <<'EOF' import * as Y from "yjs"; import { loadMarkdown,`
- `grep -rn "api/close\|closeTab\|closeDocument" src/client --include=*.ts --include=*.svelte | grep -v test | head -20`
- `grep -n "docx\|BINARY_SAVE_FORMATS\|AUTO_SAVE_FORMATS\|SUPPORTED_EXTENSIONS" src/shared/constants.ts | head; grep -rn "unwatchFile\|watchFile(" src/server --inc`
- `sed -n 400,634p src/server/file-io/docx-html.ts`
- `grep -n "sanitizeImageSrc" -A 40 src/shared/image-src-safety.ts | head -80`
- `cd <scratchpad>/exp && awk '/^### /{name=$0} /byte-identical: false/{p=1; print name} /byte-i`
- `grep -n "handleTabClose" -A 60 <repo>/src/client/hooks/yjsSync.svelte.ts | sed -n 1,90p; grep -n "function closeTabAndRecord" -A 40 <repo>`
- `sed -n 1,86p <repo>/src/shared/image-src-safety.ts; grep -n "image\|img\|drawing" <repo>/src/server/file-io/docx-lost-features.ts | head -`
- `cd <scratchpad>/exp && cat > exp4.ts <<'EOF' import * as Y from "yjs"; import { htmlToYDoc } `
- `grep -n "commentRangeStart\|CommentRangeStart\|from\b.*to\b\|flatText\|extractText\|offset" <repo>/src/server/file-io/docx-export.ts | head -60`
- `grep -n "hardBreak\|image\|table\|codeBlock\|blockquote\|horizontalRule" <repo>/src/server/file-io/docx-export.ts | head -50`
- `cd <scratchpad>/exp && cat > exp5.ts <<'EOF' import * as Y from "yjs"; import { loadMarkdown,`
- `cd <scratchpad>/exp && cat > exp6.ts <<'EOF' import * as Y from "yjs"; import { Document, Pac`
- `sed -n 185,215p src/server/file-io/docx-lost-features.ts; sed -n 15,50p src/server/file-io/docx-export.ts; grep -n "detectExportFidelityIssues" -A 40 src/server`
- `grep -rn "changed on disk\|external edit\|externally\|fs.watch\|file watcher" README.md docs/architecture.md docs/gotchas.md docs/troubleshooting.md docs/mcp-to`
- `grep -n "emoji\|surrogate\|UTF-16\|code unit" docs/mcp-tools.md skills/tandem/SKILL.md docs/architecture.md | head; grep -n "wikilink\|wiki-link\|\[\[" docs/*.m`
- `cat <repo>/src/server/mcp/docx-apply.ts | sed -n 1,200p`
- `cd <scratchpad>/exp && cat > exp7.ts <<'EOF' import * as Y from "yjs"; import { Document, Pac`
- `grep -n "applyChanges" -A 25 <repo>/docs/mcp-tools.md | sed -n 1,60p; echo ----; grep -n "offset\|emoji\|character" <repo>/skills/tandem/S`
- `grep -n "long\|ENAMETOOLONG\|255" <repo>/tests/server/session*.test.ts | head -5; grep -n "saveCurrentSession\|autoSaveAllToDisk\|shutdown" /home/use`
- `grep -n 'eventType !== "change"\|fs.watch(filePath\|if (watched.has(filePath)) return' src/server/file-watcher.ts; grep -n "export async function atomicWrite\|a`
- `cd <scratchpad>/exp && cat > exp8.ts <<'EOF' import * as Y from "yjs"; import { loadMarkdown,`
- `grep -n "tandem_resolveRange" -A 30 src/server/mcp/navigation.ts | grep -n "indexOf\|surrogate\|codePoint" | head -5; grep -rn "image" src/server/file-io/docx-v`

## Probe/executed outputs (9)

### cd <scratchpad>/exp && cat > rt.ts <<'EOF' import * as Y from "yjs"; import { loadMarkdown, saveMarkdown } from "<repo>/sr
(output 10 chars)
```
exit=1
0
0
```

### cd <scratchpad>/exp && ln -sfn <repo>/node_modules node_modules && echo '{"type":"module"}' > package.json && npx tsx rt.t
(output 332 chars)
```
exit=0
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
55
52
```

### cd <scratchpad>/exp && cat > exp2.ts <<'EOF' import * as Y from "yjs"; import { loadMarkdown, saveMarkdown } from "<repo>/
(output 2782 chars)
```
=== marks in raw/code blocks ===
"<bold>---\nt</bold>itle: X\n---\n\n[^1]: <italic>A footno</italic>te def.\n\n```js\n<bold>let</bold> x = 1;\n```\n"
=== surrogate ===
flat length 14 "Hello 👋 world"
validateRange(7,8) inside pair: {"ok":true,"range":{"from":7,"to":8}}
after insert at 7: "Hello �X� world"
after delete [7,9): "Hello �world" "Hello �world\n"
anchoredRange(7,9): {"ok":true,"fullyAnchored":true,"range":{"from":7,"to":9},"relRange":{"fromRel":{"type":{"client":2547418712,"clock":2},"item":{"client":2547418712,"clock":10},"assoc":0},"toRel":{"type":{"client":2547418712,"clock":2},"item":{"client":2547418712,"clock":11},"assoc":-1}}}
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
Invalid access: Add Yjs type to a document before reading data.
=== offset roundtrip ===
"# Heading\nPara one\nwith break and em and code.\nitem one\nitem two\nnested\nquote\n\n\na\nb\n1\n2\ncode\nblock\nLast[^1] para.\n[^1]: note"
mismatches: 14
i=0 assoc=0 -> null (char="#")
i=0 assoc=-1 -> null (char="#")
i=1 assoc=0 -> null (char=" ")
i=1 assoc=-1 -> null (char=" ")
i=18 assoc=0 -> 19 (char="\n")
i=55 assoc=0 -> 56 (char="\n")
i=64 assoc=0 -> 65 (char="\n")
i=78 assoc=0 -> null (char="\n")
i=78 assoc=-1 -> null (char="\n")
i=79 assoc=0 -> null (char="\n")
i=79 assoc=-1 -> null (char="\n")
i=81 assoc=0 -> 82 (char="\n")
i=83 assoc=0 -> 84 (char="\n")
i=85 assoc=0 -> 86 (char="\n")
block heading path=0 [2,9) = "Heading"
block paragraph path=1 [10,46) = "Para one\nwith break and em and code."
block paragraph path=2,0,0 [47,55) = "item one"
block paragraph path=2,1,0 [56,64) = "item two"
block paragraph path=2,1,1,0,0 [65,71) = "nested"
block paragraph path=3,0 [72,77) = "quote"
block paragraph path=6,0,0,0 [80,81) = "a"
block paragraph path=6,0,1,0 [82,83) = "b"
block paragraph path=6,1,0,0 [84,85) = "1"
block paragraph path=6,1,1,0 [86,87) = "2"
block codeBlock path=7 [88,98) = "code\nblock"
block paragraph path=8 [99,113) = "Last[^1] para."
block paragraph path=9 [114,124) = "[^1]: note"
=== corrupt session: no throw, fragment len 0
=== missing ydocState throws: TypeError [ERR_INVALID_ARG_TYPE]: The first argument must be of type string or an instance of Buffer
=== hardbreak ann === "a b\nc d"
{"ok":true,"fullyAnchored":true,"range":{"from":2,"to":7},"relRange":{"fromRel":{"type":{"client":1060321260,"clock":14},"item":{"client":1060321260,"clock":18},"assoc":0},"toRel":{"type":{"client":1060321260,"clock":21},"item":{"client":1060321260,"clock":26},"assoc":-1}}}
refresh: "ok"
```

### cd <scratchpad>/exp && cat > exp3.ts <<'EOF' import * as Y from "yjs"; import { loadMarkdown, saveMarkdown } from "<repo>/
(output 238 chars)
```
cut=405/406: THROWS Error: Unexpected end of array
cut=203/406: THROWS RangeError: Invalid typed array length: 9
cut=10/406: THROWS Error: Unexpected end of array
bitflip THROWS TypeError: The encoded data was not valid for encoding utf-8
```

### cd <scratchpad>/exp && cat > exp4.ts <<'EOF' import * as Y from "yjs"; import { htmlToYDoc } from "<repo>/src/server/file-
(output 517 chars)
```
=== docx inline img ===
paragraph:"<paragraph>Before  after</paragraph>"
paragraph:"<paragraph></paragraph>"
"Before  after\n"
=== sessionKey === path chars: 48 key bytes: 234 %2FUsers%2F%E5%BC%A0%E4%BC%9F%2FDocuments%2F%E9%A1%B9%E7%9B%...
write OK
cyrillic path chars: 75 key bytes: 295
write FAILS: ENAMETOOLONG
=== image src rejection ===
"Architecture diagram\n\nsvg\n\n![rel](../img/a.png)\n\n![space]\\(my image.png)\n\n![](x.png)\n"
=== raw mark inheritance === "Text[^1] *emph* <b>x</b> here.\n\n[^1]: note\n"
```

### cd <scratchpad>/exp && cat > exp5.ts <<'EOF' import * as Y from "yjs"; import { loadMarkdown, saveMarkdown } from "<repo>/
(output 473 chars)
```
"# a\n## b\n### c\n#### d\n##### e\n###### f\n" -> "# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f\n" DIFF
"See [[Other Note]] and [[Note|alias]] and ![[image.png]]\n" -> "See \\[[Other Note]] and \\[[Note|alias]] and !\\[[image.png]]\n" DIFF
"Price is \\$5 and \\$10 total; math \\(x\\).\n" -> "Price is $5 and $10 total; math (x).\n" DIFF
"Obsidian: ==hl== #tag %comment% > [!NOTE]\n> callout\n" -> "Obsidian: ==hl== #tag %%comment%% > [!NOTE]\n\n> callout\n" DIFF
```

### cd <scratchpad>/exp && cat > exp6.ts <<'EOF' import * as Y from "yjs"; import { Document, Packer, Paragraph, TextRun, HeadingLevel, T
(output 1272 chars)
```
=== heading in table cell ===
html: "<p>Intro para.</p><table><tr><td><h2>Cell Heading</h2></td><td><p>plain cell</p></td></tr></table><p>After the table target end.</p>"
ydoc : "Intro para.\nCell Heading\nplain cell\nAfter the table target end."
walk : "Intro para.\n## Cell Heading\nplain cell\nAfter the table target end."
MISMATCH
comment 0 [55,61) walker-text="target" ydoc-text="get en" body="note on target"
=== footnote ref before comment ===
html: "<p>Claim<sup><a href=\"#footnote-1\" id=\"footnote-ref-1\">[1]</a></sup> then target end.</p><ol><li id=\"footnote-1\"><p>The footnote body. <a href=\"#footnote-ref-1\">↑</a></p></li></ol>"
ydoc : "Claim[1] then target end."
walk : "Claim then target end."
MISMATCH
comment 0 [11,17) walker-text="target" ydoc-text="en tar" body="note"
=== w:sym before comment ===
html: "<p>✓ then target</p>"
ydoc : "✓ then target"
walk : "  then target"
MISMATCH
comment 0 [7,13) walker-text="target" ydoc-text="target" body="note"
=== bullet list + heading ===
html: "<ul><li>Item one</li><li>Item two</li></ul><h3>Sub Heading</h3><p>target</p>"
ydoc : "Item one\nItem two\n### Sub Heading\ntarget"
walk : "Item one\nItem two\n### Sub Heading\ntarget"
MATCH
comment 0 [34,40) walker-text="target" ydoc-text="target" body="note"
```

### cd <scratchpad>/exp && cat > exp7.ts <<'EOF' import * as Y from "yjs"; import { Document, Packer, Paragraph, TextRun, Tab, CommentRan
(output 646 chars)
```
=== plain paragraph (control) ===
ydoc : "Hello target world."
walk : "Hello target world." MATCH
applyTrackedChanges: applied 1 rejected 0 []
=== tab in paragraph ===
ydoc : "Name:\ttarget here"
walk : "Name: target here" MISMATCH
applyTrackedChanges THROWS: Error: Flat text mismatch: the .docx content does not match the Y.Doc flat text. The file may have changed since it was 
=== manual line break (Shift+Enter) ===
ydoc : "Line one\ntarget line two"
walk : "Line one target line two" MISMATCH
applyTrackedChanges THROWS: Error: Flat text mismatch: the .docx content does not match the Y.Doc flat text. The file may have changed since it was
```

### cd <scratchpad>/exp && cat > exp8.ts <<'EOF' import * as Y from "yjs"; import { loadMarkdown, saveMarkdown } from "<repo>/
(output 171 chars)
```
"let x = 1;\nbold tail here"
flat after: "let x X tail here"
saved: "```\nlet x X<bold> tail</bold> here\n```\n"
link inherit: "See [the docs (updated)](https://x) now.\n"
```
