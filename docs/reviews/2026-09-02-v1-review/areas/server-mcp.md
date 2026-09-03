# Area: MCP tool surface and `/api` routes

**Raw:** [`../raw/report-A-server-mcp.md`](../raw/report-A-server-mcp.md) (Fable, one of the two
fan-out reviewers that finished; every finding marked `[verified by execution]` was run by the
agent against an in-memory MCP client). Probe: [`../experiments/probe-tools.mts`](../experiments/probe-tools.mts),
[`probe-redos.mts`](../experiments/probe-redos.mts).
**Tracks:** [A stop the bleeding](../tracks/A-stop-the-bleeding.md); the audience-guard item is in
[C](../tracks/C-privacy-and-authority.md); Lows in [K](../tracks/K-tests-and-lows.md).
**Spot-check:** both Highs and the four Mediums re-run by the orchestrator through the probes.

`security-reviewer` on anything that changes a route's gate; `crdt-reviewer` on `validateRange`.
Critical Rule 9: a new mutating tool or route joins the license-gated set in both halves.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `src/server/positions.ts:110,189` (`validateRange`, `anchoredRange`); tool schemas | No bounds check: `tandem_edit(6, 99999)` deletes to end of document, a negative `from` clamps to 0, both report `edited: true`. Mid-surrogate offsets accepted (U+FFFD written both sides); zero-length and fractional values accepted. | [ran] | Reproduced (`probe-tools.mts`, `exp2.ts`, `exp8.ts`) | [#1752](https://github.com/bloknayrb/tandem/issues/1752) |
| H | `tandem_restoreBackup` handler; `.backup.docx` sidecar path | With no `backup` argument (the documented "list" call) on a `.docx` with no snapshot from this run, the tool overwrites the `.docx` from the sidecar: ignores `readOnly`, no conflict check, no self-write fingerprint, reports "Restored". | [ran] | Reproduced (`probe-tools.mts`) | [#1768](https://github.com/bloknayrb/tandem/issues/1768), [decision 1](../decisions.md) |
| M | `src/server/mcp/navigation.ts:45,145` | `tandem_search` with `regex: true` blocks the event loop on catastrophic backtracking; the 2 s guard runs only between matches. `(a+)+$` on 29 chars: 20.3 s. When the 10,000-match cap or the guard trips, matches are discarded with `FORMAT_ERROR`. | [ran] | Reproduced (`probe-redos.mts`) | [#1795](https://github.com/bloknayrb/tandem/issues/1795) |
| M | `convert.ts:151`; `document.ts:1341` | A missing output directory throws `FILE_NOT_FOUND`, which the tool maps to `noDocumentError()`: "No document is open. Call tandem_open first." | [ran] | Reproduced | [#1796](https://github.com/bloknayrb/tandem/issues/1796) |
| M | `document-service.ts:1418` vs `:1482,1493` | `closeDocumentById` looks up by `basename(id)` but clears, unwatches and closes by the raw id, so `POST /api/close {"documentId": "x/<id>"}` deletes the session, unwatches and closes the durable store while leaving the document registered. | [ran] | Reproduced | [#1797](https://github.com/bloknayrb/tandem/issues/1797) |
| M | `document.ts:1067-1104`; `AUTO_SAVE_FORMATS`, `BINARY_SAVE_FORMATS` | `.html` opens editable via MCP, `tandem_edit` succeeds, `tandem_save` answers `saved: true, sessionOnly: true` (`.html` is in neither save set — a policy exclusion, not a missing adapter), and tab close deletes the session: edits lost. The same `saved: true` shape covers `FILE_MODIFIED` and `SOURCE_MISSING` skips. | [ran] | Fixed on `fix/html-read-only-1798` | [#1798](https://github.com/bloknayrb/tandem/issues/1798), [decision 2](../decisions.md) |
| M | `lifecycle.ts:1279-1306` vs `:844,905,1327` | ADR-027 write guards disagree on audience: `replyForClaude` refuses `{comment, audience: private}`; `editPendingAnnotation`, `transitionPending` and `removeForClaude` accept it. Defence in depth; no first-party writer produces the record today. | [ran] | Reproduced | [#1803](https://github.com/bloknayrb/tandem/issues/1803) |
| M | `docs/mcp-tools.md:1050,1062,1066,1067` | Says "nine" one-layer routes and marks save/convert/apply-changes as calling neither gate; all three call `assertOriginAllowlisted`. Real count six; CLAUDE.md and `security.md` are right. | [read] | Source-confirmed | [#1821](https://github.com/bloknayrb/tandem/issues/1821) |
| L | ten items | `tandem_comment` accepts a range entirely past end; `tandem_getContext` accepts inverted/negative ranges; `getTextContent({section})` has no base offset; inconsistent wire codes for one condition (`ANNOTATION_NOT_PENDING` vs `ANNOTATION_RESOLVED`, `FORMAT_ERROR` vs `READ_ONLY`, `PERMISSION_DENIED` vs `FILE_LOCKED`, three codes for UNC, `INTERNAL_ERROR` for a missing backup dir); `tandem_open` takes a relative path with no sidecar cwd; `tandem_status` with an unknown id says "No document open"; read-only refusals say "(.docx)" for every read-only open; `tandem_search` description says "supports regex". | [ran] | Reproduced (`probe-tools.mts`) | [#1823](https://github.com/bloknayrb/tandem/issues/1823) |

## Verified fine

The 33 registrations (30 active, 3 deprecated stubs) match the docs; `getTextContent` uses
`extractText`; `tandem_open` `force: true` semantics as documented; the six-route one-layer
inventory; `tests/docs/loopback-gate-claims.test.ts` pins CLAUDE.md's list against source.
