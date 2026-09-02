# Report A — MCP tool surface and HTTP API (persisted by orchestrator from agent's inline return)

## HIGH
H-1. tandem_edit has no bounds check: out-of-range `to` deletes to end-of-document, negative `from` clamps to 0, both report edited:true. [verified by execution]
  Where: src/server/mcp/document.ts:621 -> src/server/positions.ts:110-160 (validateRange checks only from>to, textSnapshot, endpoint heading clamp) -> src/shared/positions/ydoc.ts resolveToElement clamps.
  editList (document.ts:837) already fixed the same class ("resolveToElement clamps... must fail loudly"); tandem_edit/comment/getContext not carried.
  Fix: add doc-length bounds to validateRange; comment/getContext inherit (L-2, L-3).
H-2. tandem_restoreBackup with no `backup` (documented "list" call) on a .docx with no snapshots this run overwrites the .docx from the .backup.docx sidecar, ignores readOnly, no conflict check, no self-write fingerprint, reports "Restored". [verified]
  Where: src/server/mcp/docx-apply.ts:540-612 (atomicWriteBuffer at :603). Named-snapshot path (reload-family.ts:241) and applyChangesCore (docx-apply.ts:165) both refuse readOnly; this branch does not.
  tests/server/restore-backup.test.ts:619 "keeps the .docx sidecar restore unchanged" pins the destructive behaviour.

## MEDIUM
M-1. tandem_search regex:true blocks the server on catastrophic backtracking; the "bail after 2s" guard (navigation.ts:45) runs only between matches. (a+)+$ on 29 chars = 20.3s. [verified]
M-2. tandem_convertToMarkdown: missing output dir -> convert.ts:151 throws FILE_NOT_FOUND -> document.ts:1341 maps every FILE_NOT_FOUND to noDocumentError() ("No document is open. Call tandem_open first"). [verified]
M-3. tandem_save answers saved:true, sessionOnly:true for .html (no save adapter; AUTO_SAVE_FORMATS={md,txt}, BINARY_SAVE_FORMATS={docx}); .html opens editable via MCP, tandem_edit succeeds, tab close deletes session -> edits lost. Same saved:true shape for FILE_MODIFIED and SOURCE_MISSING skips. document.ts:1067-1104. [verified]
M-4. ADR-027 write guards disagree on audience: replyForClaude (lifecycle.ts:1279-1306) refuses {comment, audience:private}; editPendingAnnotation (:905), transitionPending (:844), removeForClaude (:1327) accept it. [verified] Defence-in-depth; no first-party writer produces the record today.
M-5. docs/mcp-tools.md:1050,1062,1066,1067 says "nine" one-layer routes and marks save/convert/apply-changes as calling neither gate; all three call assertOriginAllowlisted. Real count six (CLAUDE.md/security.md correct; loopback-gate-claims.test pins only those two).

## LOW
L-1. closeDocumentById (document-service.ts:1418 vs :1482,:1493) looks up by basename(id) but clears/unwatches/closes by raw id -> POST /api/close {"documentId":"x/<id>"} deletes session, unwatches, closes durable store, leaves doc registered. [verified]
L-2. tandem_comment accepts a range entirely past end (stored {40,60} on 22-char doc, textSnapshot ""). Same root as H-1.
L-3. tandem_getContext accepts inverted/negative ranges -> selection "" echoing raw offsets.
L-4. Critical Rule 6 is endpoint-only: a range whose interior contains a heading prefix is accepted; edit(4,13,"X") on "Para one\n## Head\nTail" -> "ParaXead\nTail". [verified]
L-5. tandem_search returns FORMAT_ERROR and discards matches when 10,000-match cap or 2s guard trips (navigation.ts:145).
L-6. tandem_getTextContent({section}) returns text with no base offset while description says offsets match the annotation coordinate system (document.ts:498).
L-7. Same condition, different wire codes across tools (ANNOTATION_NOT_PENDING vs ANNOTATION_RESOLVED; FORMAT_ERROR vs READ_ONLY for read-only; PERMISSION_DENIED vs FILE_LOCKED for EACCES; FILE_NOT_FOUND vs INVALID_PATH vs FORMAT_ERROR for UNC; applyChanges nonexistent backup dir -> INTERNAL_ERROR).
L-8. tandem_open does not require an absolute path (documents/open.ts:634 path.resolve, no isAbsolute); sidecar spawn sets no cwd.
L-9. tandem_status write with unknown documentId says "No document open" while documents are open.
L-10. tandem_search `query` description says "(supports regex)" while regex is opt-in (navigation.ts:129).

## Doc drift
1. mcp-tools.md "nine one-layer" (M-5). 2. licensing-explained.md:255 "12 gatedTool, 1 conditional, 16 ungated" -> 13/1/19 (editList added). 3. tandem_rename and tandem_convertToMarkdown in neither gated set nor "Deliberately ungated" list. 4. mcp-tools.md:1094,1106 toolCount 32 and schema-dialect.ts:48 "all 32" -> 33. 5. mcp-tools.md:963 chatMessages "author" -> stripped (awareness.ts:356). 6. mcp-tools.md:713 annotationReply errors omit INVALID_ARGUMENT; highlight message names "notes". 7. convertToMarkdown error codes (M-2; EMPTY_CONVERSION/OPEN_FAILED/INVALID_PATH flatten to FORMAT_ERROR). 8. Error-code table: READ_ONLY definition false for main mutators; omits NOT_FOUND, ANNOTATION_NOT_PENDING, ANNOTATION_RESOLVED, INVALID_ARGUMENT, INTERNAL_ERROR, FILE_MODIFIED, SOURCE_MISSING, BAD_REQUEST, RENAME_FAILED. 9. Rule 6 endpoint-only (L-4). 10. getTextContent section offsets (L-6). 11. tandem_open "Absolute path" not enforced. 12. navigation.ts:45 comment "bail after 2s" cannot fire. 13. listDocuments example omits `source`. 14. restoreBackup "call without backup to list" (H-2).

## Verified fine
33 registrations (14 doc, 10 annotation, 3 nav, 3 awareness, 2 apply, 1 diagnostics), 3 stubs gated. getTextContent uses extractText. Heading endpoint rejection works. ADR-045 multi-session, 404 -32001, reaper pin (#1588), ALS wrap, Solo pull filtering (hideFromAI, heldFromExport), six one-layer routes derivation, text/plain CSRF (each requires parsed JSON field), enforceLoopbackMutation order, NON_LOOPBACK_ALLOWED method+path, /api/wake rejects Origin null, CORS absence-not-null + Vary + SSE merge, license gate pairing both halves, no await between validate and mutate in edit/comment.

## Questions for Bryan
Q1 (H-2): restoreBackup() no-arg on .docx with no snapshots — make it always list (sidecar as named entry) and honour readOnly?
Q2 (M-3): .html opens editable but has no save path — refuse tandem_edit / open read-only, or add a save adapter?
Q3 (H-1): does anything rely on clamping (e.g. to: MAX_SAFE_INTEGER as append idiom)?
