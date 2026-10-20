# Prompt audit — 2026-10-13

A `/claude-api prompt-audit` of Tandem's prompt text, run on 2026-10-13 against the Claude
5-generation prompting guidance. It covered `CLAUDE.md` and `AGENTS.md`, the shipped
`skills/tandem/SKILL.md`, the seven `.claude/skills`, the reviewer agents and `/diverge`, every
MCP tool description, the channel shim's instructions and the local-model tools. The previous
audit of the same kind is [2026-09-03-prompt-audit-diff.md](2026-09-03-prompt-audit-diff.md).

It found three kinds of problem:

- **Stale facts the code contradicts.** Reviewer agents carried wrong rules, several tool
  descriptions contradicted their handlers, and the shipped skill described tools that only
  returned an error.
- **Accretion.** `CLAUDE.md` had grown to 77.7 KB at `b9b3d062` (73 KB at the audited commit),
  mostly issue history wrapped around rules that were still valid. After #2220 it is 64 KB.
- **Structural waste.** Three deprecated tool stubs were still registered, and six `diverge-*`
  agents were copies of one prompt.

## What the audit produced

Four stacked PRs, one per surface (decision D9), merged in stack order, plus the PR that adds
this file:

| PR | Surface | Review record |
|---|---|---|
| #2218 | `.claude/` reviewer agents and skills; the six `diverge-*` generators merged into one | [comment](https://github.com/bloknayrb/tandem/pull/2218#issuecomment-6169287224) |
| #2220 | `CLAUDE.md` history trimmed with every rule kept; `AGENTS.md`; the release skill's step 9 | [comment](https://github.com/bloknayrb/tandem/pull/2220#issuecomment-6174390039) |
| #2223 | MCP tool descriptions match the code; `tandem_highlight`, `tandem_suggest`, `tandem_flag` and `directedAt` removed | [comment](https://github.com/bloknayrb/tandem/pull/2223#issuecomment-6175590044) |
| #2224 | Shipped `/tandem` skill fact fixes (version 35) | [comment](https://github.com/bloknayrb/tandem/pull/2224#issuecomment-6176295027) |

Follow-ups filed rather than fixed:

- **#2215** — the skill's polling cadence and workflow prose (sk:F5, F6, F8–F10). It needs a
  hardware `/tandem` arming and polling acceptance run, so it is labelled `needs-human-evidence`.
- **#2216** — `describeReplyWriteRefusal` names MCP tools to the local model, which has none.
- **#2217** — two code comments contradict `refreshRange`'s collapse polarity and the `.docx`
  export snap.
- **#2219** — a source-view commit on a scratchpad permanently drops its personal notes. Found
  while reviewing #2220.

## How to read this record

**Everything from "Decisions" to the end is the record as written, not open work.** Decisions,
the corrections and Appendices A–B are the implementation plan as handed to the implementer, so
they speak in orders ("Use:", "Skip it", "run that test"); those orders were carried out in the
PRs above. The two issues the corrections ask to be filed are #2216 and #2217.

The appendix audited a local `master` 35 commits stale; every hunk was re-verified against
`origin/master` `b9b3d062` before any code was written, and the corrections **supersede** Appendix C
wherever they disagree. Where the corrections cite `10-claudemd.md`, `20-tools.md`,
`30-skill.md` or `40-dotclaude.md`, those are the four slices of Appendix C, in that order. Hunk
IDs repeat across slices, so they are qualified: `md:` (CLAUDE.md/AGENTS.md), `tool:` (tool
descriptions), `sk:` (the shipped skill), `dc:` (`.claude/`). Line numbers are as of those
commits and are not maintained.

### Deviations during execution

- **`origin/master` moved again** (`b9b3d062` → `0bc213ed`) before PR 1. Upstream had rewritten
  the skill's absent-tools section for the licence refusal and bumped it to version 34, so D4's
  bump shipped as 34 → 35, not 32 → 33. sk:F11/F12 were adapted to the new text: the `-32003`
  licence distinction stays, the maintainer note naming `src/cli/mcp-stdio.ts` does not.
- **The CHANGELOG's skill sentence moved from #2223 to #2224**, so that #2223 does not claim a
  skill fix it does not contain.
- **Skipped in `/simplify`, by judgment:** trimming rules repeated between tool descriptions and
  their parameter text, a check on error-code vocabulary in descriptions, shared constants for the
  heading rule and the inbox-authority rule, and shortening the skill's new force-open reason.
  `docs/decisions.md` is history and was not edited.
- **Reviews of the PRs raised blocking findings on #2220 and #2223**; all were fixed in the PR
  (see each review record). Two review fixes changed the note-loss windows the corrections below
  describe ("The one loss window is a failed envelope flush"): #2220's review found a scratchpad's
  source-view commit (#2219), and #2224's added a store that never wired, editing `CLAUDE.md` and
  `docs/security.md` from the skill PR. Both now name three windows, two of them in
  `clearAndReload` (a failed envelope flush, a store that never wired).

## Decisions (Bryan, 2026-10-13)

**Baseline correction.** The audit ran on local master 2331a28e, which was 35 commits behind origin/master (b9b3d062). Every hunk must be re-verified and rebased onto origin/master before it is applied.

| # | Decision | Outcome |
|---|---|---|
| D1 | Security register (#1906, #1952) | **Moot.** Already reconciled upstream: both accepted under ADR-056, and CLAUDE.md now lists only #1884 as open. Drop F8/H20's open-set change; re-check H20 against the new text before trimming. |
| D2 | Deprecated stubs | **Remove** the 3 stubs, `notifyDeprecatedTool` and `directedAt` (tools H10 + H17), along with every pin listed for them. |
| D3 | CLAUDE.md "Shipped" stamp | **Drop it** (CLAUDE.md H24) and take the release-skill companion edits to step 9 and the line-116 parenthetical. Do **not** take `.claude` H17. |
| D4 | SKILL.md | **Facts now:** F1, F2, F7, F11, F12, F13, F14, F15, plus version 32→33 and the bodyHash. **Later PR, gated on the hardware acceptance run:** F5, F6, F8, F9, F10. |
| D5 | diverge generators | **Merge** into `diverge-generator` (M1), moving the frames verbatim. |
| D6 | CLAUDE.md depth | **Trim history, keep rules:** H1–H26 (minus H20's open set per D1), plus the H15 diverge count. |
| D7 | Tool descriptions | **All** contract fixes H1–H21 and output-schema H20, with the docs/mcp-tools.md mirrors updated by hand. |
| D8 | `.claude` fixes | **All High + Medium:** H1–H16, H18, M2–M10. H17 is excluded per D3. |
| D9 | Delivery | **Stacked PRs, one per surface:** (1) `.claude` agents, skills and diverge merge; (2) CLAUDE.md, AGENTS.md and release step 9; (3) MCP tool text and stub removal; (4) SKILL.md fact fixes; (5) audit report at docs/reviews/2026-10-13-prompt-audit.md. The SKILL.md behaviour PR follows after the acceptance run. |

Also on the way through: the channel shim F3 (`annotation:edited`) and F4 (authority wording) go in PR 3, re-checked against origin, since `run.ts` and `event-bridge.ts` changed upstream.

## Corrections from re-verification against b9b3d062

**CLAUDE.md / AGENTS.md (10-claudemd.md).** 21 hunks apply unchanged. Lines after 293 shift by +1, because upstream added a Status bullet.
- **md:H5: OBSOLETE.** Rule 9 was rewritten for #1521 (`aiRefusal()`). Skip it.
- **md:H28: OBSOLETE.** AGENTS.md:31 was rewritten. Skip it.
- **md:H9: keep** the "`directedAt` is deprecated and stripped on read" sentence. It describes stored data handled by `src/shared/sanitize.ts` and `src/server/annotations/schema.ts`, which D2 does not touch. Annotation review corrections:
  - **(B2, blocking)** Replace the "Bulk clears (`tandem_open force`, restore, applyChanges) still take notes with everything else …" sentence. It is false, and it contradicts tool:H16 in PR 3. Use: "Content-replacing reloads keep notes. Restore, the external-conflict Reload and the watcher reload that `applyChanges` relies on never clear the annotation map. `tandem_open force` and the source-view commit clear it in memory only, then re-merge the durable envelope and re-anchor. The one loss window is a failed envelope flush in `clearAndReload`, which is logged and lets the reload continue." Evidence: `reload-family.ts:322-326`, `documents/watcher.ts:160-169`, `mcp/docx-apply.ts:466-474`, `open.ts:387-403`.
  - **(S10)** "a highlight falls to its own `invalid-suggestion-target` / `not-repliable` arm" becomes "a highlight passes this guard and is answered by the later arms (`not-owned` in practice, since every highlight is the user's)". `lifecycle.ts:1116-1120, 1615`.
  - **(nit)** Write "`accept`/`dismiss` (via `transitionPending`)". `transitionPending` is module-private. Describe `"comment"` as "(Claude's, the user's or imported; may carry `suggestedText`)".
- **md:H12 (annotation S8):** "a moved span comes back `degraded`" becomes "an annotation whose text was edited or deleted comes back `degraded`, and the session is gone". `reanchorAnnotations` relocates a moved span through `RANGE_MOVED`.
- **md:H13: REPLACE. Blocking for both the annotation review (B1) and the CRDT review (B1).** The hunk and the current CLAUDE.md both misdescribe two of the three `refreshRange` arms (`positions.ts:831-918`):
  - the repair arm *writes* the stripped record on a mismatch;
  - the collapse arm has the opposite polarity.

  A maintainer who "aligned" the code to the old text would keep a deleted span's stale range, and `docx-comment-export.ts:427` would write it into the user's file. Use:
  > `- **Strip dead \`relRange\` RelativePositions, never preserve them** — a stale one resolving to null blocks the lazy re-attachment recovery path. Three arms of \`refreshRange\` are gated on \`storedRangeStillMatches\` (does the stored flat range still hold its \`textSnapshot\`?). The two mint arms — lazy-attach (no \`relRange\`) and repair (dead \`relRange\`) — mint a fresh anchor only when it holds; otherwise they answer \`degraded\` and mint nothing (repair still strips the dead \`relRange\` and writes that), so the stored flat range survives for relocation. The spurious-collapse arm has the opposite polarity: when live anchors collapse to \`{n, n}\` over a non-empty stored range that still holds a present snapshot, it answers \`degraded\` and writes nothing, so the flat range and the live \`relRange\` both survive for relocation and undo; otherwise the span really was deleted and \`{n, n}\` is written. \`tandem_getAnnotations\` shows \`anchor: "degraded"\`. A record with no \`textSnapshot\` (e.g. a Word comment imported on the drift path) is minted unverified by the mint arms and never preserved by the collapse arm, because \`.docx\` export writes the refreshed range into the user's file.`
- **md:H4 (Rule 6), CRDT review S7 and N1:**
  - Replace "(`refreshRange` first, stored range only when the anchor is dead)" with "(the `refreshRange` result, or the stored range when that refresh answers `degraded` or `failed`)". Source: `lifecycle.ts:1544-1548`.
  - Write `YDocStore.anchorRange(from, to, "suggestion", …)`. The parameter is positional, not `{purpose: …}`.
- **md:H15:** 23 test files mock `file-watcher`, not 18, so keep the hunk's "many".
- **`docs/architecture.md:726-728` (PR 2, CRDT B2/S6):**
  - The "grows on insert at boundary" assoc claim is wrong. `from` uses assoc 0 and `to` uses assoc -1, so text inserted at either boundary lands outside (`src/shared/positions/ydoc.ts:486-487`).
  - The "Reading: refreshRange … correcting any drift" paragraph omits the #1764 gating. Point it at the md:H13 text.
- **md:H16:** origin has three `if (transportMode === "http")` blocks (375, 465, 729). Describe the target as "the `if (transportMode === "http")` block in `src/server/index.ts` that opens with the bundled-skill refresh", with no line number.
- **md:H20: RE-DERIVED.** The bullet is now 8.2 KB and opens "**One security finding is open … eight are accepted rather than fixed**". Use the replacement text in **Appendix A**, which passed an offline run of `tests/docs/security-findings-claims.test.ts`'s parser. The security review revised it to restore the void conditions that a "hardening" change would trip (#1654, #1666, #2027, #1952/#1906), #1609's UNC guard, and the reason exploit detail stays out of CLAUDE.md. **After applying, run that test, and confirm that no rewritten line *above* the bullet matches `security findings? (?:are|is) open`**, because `claimBullet()` takes the first match.
- **md:H21 (security S3):** replace "reachable by any page in a local browser" with "reachable from any web page open in a browser on this machine, whatever its origin". The rest of md:H21 is verified as-is.
- **md:H22: RE-DERIVED.** Line 268 now opens with a "behaviour-identical" sentence and still cites `lib.rs:178` (the real line is 179). Use **Appendix B**.
- **md:H24:** the release companion edits are now at `.claude/skills/release/SKILL.md:115-116` (the parenthetical) and step 9 at **274-276**. A new step 10 follows step 9 and is left untouched.
- **md:H26** is now at line 323.
- **New upstream text, included in PR 2:**
  - (a) Status bullet ~294 says "Two systems are merged but runtime-inert", but five flags ship dark: licensing, BYO models, `.docx` (ADR-053), Cowork (ADR-055), `LAN_BIND_ENABLED` (ADR-056). The exact statement is under "More corrections from the executability review" below. Do **not** describe `LAN_BIND_ENABLED` or `COWORK_ENABLED` as v1.0 flips; ADR-055 and ADR-056 keep both out of v1.0.
  - (b) Line ~270, "(decision D4 split its retirement out of #1521)", is ambiguous: "D4" already means roadmap D4 in decisions.md. Drop the parenthetical.
  - (c) Lines 269-270 are migration-relative ("are **deleted**", "the old gate refused … are open"). Restate as rules: no per-tool or per-route gates, because the api-coverage sweep fails if they return.
  - (d) Cowork bullet ~293: drop "since #2136" and drop "(verified at v0.7.1; #1598 measured…)"; ADR-055 already carries it (`decisions.md:2672`), so do not edit decisions.md. **Keep** "`tandem rotate-token` does not retire the token those entries hold", which is a credential-remanence rule.

**Tool text (20-tools.md).** The licence refactor removed `gatedTool` and `license-gate.ts`, and every stub now uses `withErrorBoundary`.
- **tool:H1 (security review N4):** instead of "must be absolute", say "filePath must be fully qualified (on Windows, starting with a drive letter)". On win32, `\docs\a.md` is also refused with INVALID_PATH (`isFullyQualifiedPath`, `document.ts:87-93`).
- **tool:H4 (tandem_edit), CRDT S1: REPLACE the description.** The hunk misreads the list cases and omits the rule that a `to` at the start of a prefix is refused. Use:
  > `"Replace the text in [from, to) with newText. Offsets are flat offsets from tandem_getTextContent, tandem_search, tandem_resolveRange or tandem_getOutline (includeBlocks). from === to inserts newText at that point — the only way to insert mid-document; omit textSnapshot there (it is refused with INVALID_ARGUMENT). A range inside one block (including one list item, table cell or quoted paragraph) edits that block. A range whose ends are in different top-level blocks merges them into one and deletes every block wholly inside it; if either end is inside a list, blockquote or table it returns INVALID_RANGE naming the two ranges to edit separately. A range whose start, end or interior overlaps heading markup such as \"## \" returns INVALID_RANGE — a to at the first character of that markup counts, so end the range before the newline preceding a heading — split the edit at the heading. newText is inserted literally, never parsed as Markdown (use tandem_appendContent or tandem_editList for new block structure); a newline in it is refused with INVALID_ARGUMENT in a plain-text (.txt) document and otherwise stays a literal line break inside the same block. Returns READ_ONLY on a read-only document and EMPTY_DOCUMENT on an empty one."`

  `to` param: `"End offset (flat text, exclusive — but a to at the start of heading markup is refused); equal to from for a point insertion"`. Re-check that `tests/server/docx-ship-dark.test.ts` stays green: the text contains no "docx" and no standalone "word".
- **tool:H5 (search), CRDT N2:** append "Regex flags are fixed at `gi`: `^`/`$` anchor to the whole document, `.` does not match the newline between blocks, and a zero-length match returns an empty range."
- **tool:H6:** the fallback normalises every Unicode space separator, not only NBSP. Final text (CRDT S2), which also drops the "ready to pass" overclaim:
  > `"Return the flat [from, to) range and text of the Nth occurrence of a literal string. Matching is literal and case-sensitive; only if there is no exact match at all does it retry treating other Unicode spaces (e.g. non-breaking) as ordinary spaces. The returned text is the document's actual characters. A miss returns INVALID_RANGE; the error message reports how many occurrences exist. The range can be passed to tandem_edit or tandem_comment unless it includes heading markup such as \"## \", which they refuse. It describes the document at call time — pass the returned text as textSnapshot on the follow-up call to detect concurrent edits."`
- **tool:H9 (comment), CRDT S3:**
  - The heading sentence becomes: `"Attach a comment to the non-empty flat range [from, to) … A range whose start or end falls inside heading markup such as \"## \" — including a to at the first character of that markup — returns INVALID_RANGE. A plain comment may span headings, but a range carrying suggestedText may not contain heading markup anywhere, because accepting it would delete the heading."`
  - Change textSnapshot's `"[from, to]"` to `"[from, to)"`.
- **`tandem_appendContent` (CRDT N3, PR 3):** at `document.ts:1246`, "(unlike tandem_edit, which is single-paragraph with literal newlines)" becomes "(unlike tandem_edit, which inserts text literally into existing blocks)".
- **tool:H13:** a user highlight returns `NOT_OWNED` (`lifecycle.ts:1117-1120`). Say "a private note or private comment, or a newText whose live range overlaps heading markup or no longer resolves, returns INVALID_ARGUMENT" (`screenSuggestionSpan` → `"unresolvable"`, `lifecycle.ts:1543-1556`).
- **tool:H7 (annotation review S5):** notes are left out of the counts (`mcp/annotations.ts:746-755`). Replace the counts clause with "privateExcluded counts the withheld non-note records and heldFromExport the solo-held ones; notes are left out without a count."
- **tool:H15 (annotation review S7):** "(each carries its documentId)" becomes "(with its documentId when it was sent from a document)" (`mcp/awareness.ts:670-676`).
- **tool:H15:** keep upstream's new sentence "Works with no document open: chat and `mode` are still returned, and the document fields are empty." (from 5f4f32ff). The hunk's three edits still apply around it.
- **tool:H18:** upstream (#2179) now says "…set your status text (pass text), which may be shown in the editor's status bar." In the replacement, the With-`text` clause becomes "sets your status text for the target document, which the editor's status bar may show".
- **tool:H19:** append "(unless an external-change conflict is pending, whose session is kept)".
- **sk:F3 (channel):** add `license_refused` to the event list (PR 3). `event-bridge.ts:42` emits it.
- **sk:F4:** keep the `instructions: [...].join` array shape, because `tests/channel/ack-rule-carriers.test.ts` parses it.

**tool:H17 / tool:H10 pin inventory (replaces the audit's list).**
- **Code:** `src/server/mcp/annotations.ts`.
  - Remove the `HighlightColorSchema` import. It becomes unused here, but the schema stays in `shared/types.ts` because `annotations/schema.ts:134` and `output-schemas.ts:106` use it. Also remove `notifyDeprecatedTool`, the three stubs and `directedAt` (param, destructure and refusal).
  - Keep `pushNotification` and `generateNotificationId`; `notifyRangeFailure` uses them.
- **`src/shared/types.ts:76`:** remove `"DEPRECATED"`, **and** remove the matching row from `docs/mcp-tools.md:62` in the same commit. `tests/docs/tool-error-codes-claims.test.ts` checks both directions.
- **Tests:**
  - `tests/docs/tool-count-drift.test.ts`: drop `DEPRECATED_STUBS` and its test. The sentence becomes "All 30 MCP tools (28 active, 2 shipped dark)" in source, with 28 exposed.
  - `tests/server/mcp-schema-dialect.test.ts:191`: `toBe(33)` becomes `toBe(30)`.
  - `tests/server/mcp-tool-integration.test.ts`: delete the stub `it.each` (~690-718). **Convert, do not delete,** the `directedAt` case (~720-733) into "an extra `directedAt` is ignored and the comment is created". That keeps the zod strip-unknown behaviour pinned: SDK 1.31 with zod 3.25, and no `.strict()` in `src/server/mcp`. A future switch to strict then fails CI, not just the manual check.
  - `tests/e2e/activity-tray.spec.ts:89-102`: change the fixture message "Your AI tried a deprecated tool." to something neutral. The test does not depend on it, but the message implies the path still exists.
  - `tests/server/edit-annotation.test.ts`: delete the `directedAt` case (~290-302) and fix the comment at ~306-307.
  - `tests/server/license-gate-coverage.test.ts` has **no** stub rows any more; nothing to do there.
- **Docs:**
  - `CLAUDE.md:50`: the count string.
  - `docs/mcp-tools.md`: :5 count and stub sentence, :62 row, stub sections ~614-618 and ~655-666, the `directedAt` row ~632, and the prose at :88, :310 and :678.
  - `docs/security.md:456`: say "Claude has no highlight-creating tool" instead of "deprecated stub".
- **Comment-only rewording:**
  - `lifecycle.ts:297`
  - `mcp/document.ts:845`
  - `tests/server/range-bounds-validation.test.ts:16`
  - `tests/server/events/channel-projection-characterization.test.ts:239`
  - `tests/server/mcp-tool-integration.test.ts:549`
  - `tests/client/suggestion-accept-drift-guard.test.ts:173`
- **Must stay** (the strip-on-read / migration path for stored `directedAt`):
  - `src/shared/sanitize.ts`
  - `src/server/annotations/{schema,sync,migration-log,lifecycle}.ts` references
  - their tests
  - `src/server/mcp/output-schemas.ts:15`
- **Historical docs: leave alone.** That is decisions.md, archive/, reviews/, spikes/ and lessons-learned.

**SKILL.md (30-skill.md).** Origin is **version 32**. F1, F7, F13 and F14 apply in place; F2→204, F11→159-163, F12→196-198, F15→152-153. None of them conflicts with upstream's new ack bullet (:92) or the Re-arming block.
- **sk:F1 (annotation S8):** replace "any annotation whose text moved comes back degraded" with "any annotation whose text the disk version changed or removed comes back degraded". A moved span is relocated, not degraded. Re-check the :462-464 regex pin afterwards.
- **One more stub line moves into the SKILL PR:** `:65` ("`tandem_highlight` is deprecated and returns an error"); reword it as "there is no tool for creating highlights; they are the user's". (`:204` is sk:F2.)
- **CHANGELOG:** the skill entry is already in PR 3; do not add another in PR 4.
- **Test (`tests/skill-instruction-contract.test.ts`):**
  - line 139: `32` becomes `33`.
  - Add a comment after line 138: "33 is the prompt-audit group: Hard Rule 6's force-open reason, the User comments paragraph, the stub references, the absent-tools intro and its maintainer note, the Scope note, the Hard Rules booster and the Review Workflow autosave. All outside the wake section." Do **not** use the audit's draft comment, which describes deferred sk:F5/F6.
  - line 514 bodyHash: recompute it as `node -e "const c=require('crypto'),f=require('fs');const s=f.readFileSync('skills/tandem/SKILL.md','utf8').replace(/\r\n/g,'\n');const m=/^---\n[\s\S]*?\n---\n/.exec(s);console.log(c.createHash('sha256').update(s.slice(m[0].length),'utf8').digest('hex').slice(0,12))"`, or run the test and copy the received value.
- **Pins checked:** :462-464 (force:true within 250 chars of "ask the user"/"the user resolves") still matches after F1; :470-472 (idempotent) still matches after F7. `tests/cli/setup.test.ts:1089-1098` headings are kept.
- **Also (PR 4):** `docs/troubleshooting.md:67` repeats sk:F11's "over direct HTTP".

**`.claude` (40-dotclaude.md).** Everything applies except the following:
- **dc:H7: REPLACE** with:
  > `- Express HTTP server on :3479 (MCP + REST API), loopback only in a release build: a non-loopback \`TANDEM_BIND_HOST\` is refused at the top of \`main()\` in HTTP mode and ignored in stdio mode while \`LAN_BIND_ENABLED\` is \`false\`, and \`startMcpServerHttp\` refuses one as a backstop (ADR-056; \`src/server/bind-check.ts\`, \`src/shared/constants.ts\`). The LAN code (Host allowlist, \`NON_LOOPBACK_ALLOWED\`, token-on-LAN checks) stays merged and is unreachable from another machine — but \`isLoopback\` accepts only \`127.0.0.1\`, so a same-machine peer on another 127/8 source address still takes those non-loopback paths, and a defect there is in scope rather than dead code. A change that flips the flag, adds an override, removes either guard, or opens a listener outside both is the finding.`

  (Security review B2: the earlier draft read the LAN paths as dead code. Evidence: `src/server/auth/middleware.ts:137-140`, `server.ts:733`.)
- **dc:H10 (security N5):** the replacement is correct for the root `playwright.config.ts` (`:130` sets `TANDEM_APP_DATA_DIR`; `e2e-server.mjs` wipes it) and for the perf harness. Scope the text to those, and add: "a design-baselines run (`scripts/design-baselines/playwright.config.ts`) uses `/tmp/tandem-baselines-data`, which is not wiped; delete that directory, never the per-OS `sessions/`."
- **dc:M3:** `AnnotationLifecycle` members are `create, editPending, accept, dismiss, remove, reply`. `transitionPending` is internal, not a member. Also replace `crdt-reviewer.md:21`'s identical stale "annotation CRUD" claim with:
  > ``- `src/server/mcp/annotations.ts` — MCP annotation tools, `captureSnapshot`, `rangeFailureToError`; creation anchors via `YDocStore.anchorRange` (`src/server/mcp/document-store.ts`). `src/server/annotations/lifecycle.ts` — `screenSuggestionSpan` (Rule 6 interior screen for reply/edit). `src/shared/snapshot.ts` — `snapshotContradicts`.``
- **annotation-model-reviewer.md, from the annotation review.** These add to dc:H1–H4. A wrong rule in a reviewer agent produces false blockers.
  - **S1 (dc:H2a, H2b, H4):** append to the dc:H4 Rule line: "The skip set is a **denylist**. A browser edit arrives on the server with Hocuspocus's `Connection` object as origin (client tags never cross the wire), and a restore or doc swap arrives with `null`. `withBrowser` is only for server-executed user actions (Archive, `addUserReply`). An allowlist such as `origin === BROWSER_ORIGIN` would silence every real user edit, and is the finding." Also list `observers/replies.ts` next to annotations as a factory-built observer.
  - **S2 (Focus Area 4 check line, ~:52; not touched by the audit):** replace it with "Verify the annotations observer narrows every add/update through `narrowForChannel` (`annotations/projection.ts`) before building a payload; the payload builders take `ChannelEligible`, so skipping the narrow is a compile error. Replies go through `narrowReplyForChannel`. The `ann.type !== "comment"` test on the user-add branch is a product rule, not the privacy guard; its absence on the Claude accept/dismiss branch is intentional." Line ~22's event list becomes `annotation:created`, `annotation:edited`, `annotation:accepted`, `annotation:dismissed`, plus `annotation:reply` from `replies.ts`.
  - **S3:** after the reply-guard sentence (~:53), add: "Edit and reply use `isPrivateForClaude` (note, or comment with non-outbound audience). Resolve (`transitionPending`) and remove use `isWithheldFromClaude` = `!isClaudeFacing`, which also refuses a user's private highlight, because those two families have no highlight arm. Flagging that difference as inconsistent is a regression." (`lifecycle.ts:276-306`)
  - **S4 (dc:H2a):** replace "(only `type: "comment"` events reach the channel)" with "…and every add/update is narrowed through `narrowForChannel` (`projection.ts`), which refuses notes and non-outbound records against the sanitized value."
  - **Nits:**
    - Focus 2 (~:38) names a `message` field that does not exist; the field is `content`. `editPending` never updates `range`.
    - ~:16 should list `tandem_checkInbox` (`mcp/awareness.ts`, `collectDocumentInbox`) as a third Claude-facing read surface.
    - Bundle the fix to `src/server/events/observers/factory.ts:7-8`'s doc comment, whose skip list omits `mode-release`.
- **crdt-reviewer.md, from the CRDT review:**
  - **B2 (blocking; not touched by the audit), :29:**
    - Replace with: "**RelativePosition association:** `from` MUST use `assoc: 0` (associates with the first annotated character, so text inserted at the start lands outside). `to` MUST use `assoc: -1` (associates with the last annotated character, so text inserted at the end lands outside). Neither boundary grows. Verify in `anchoredRange()`, `anchorFlatRange()` and any direct `flatOffsetToRelPos()` call."
    - The :61 proof example becomes "Insert text at annotation start boundary; the inserted text becomes part of the annotation."
    - Evidence: Yjs `RelativePosition.js:163-176`; `src/shared/positions/ydoc.ts:486-487`.
  - **dc:H6: REPLACE (S4)** with the two bullets below. The audit's draft leaves the no-snapshot case ambiguous and hides the repair arm's write.
    > `- **Range staleness detection:** \`refreshRange()\` resolves \`relRange\` back to flat offsets and, when a \`map\` is passed, writes a changed flat \`range\` (\`updated\`). Two outcomes write nothing: an inverted resolution (\`from > to\`) answers \`failed\`; and a collapse — live anchors resolving to \`from === to\` over a non-empty stored range — answers \`degraded\` when the record carries a \`textSnapshot\` AND its stored range still holds it. A collapse with no snapshot, or a non-matching one, is a real deletion and writes \`{n, n}\` — deliberately, since \`.docx\` export writes the refreshed range into the user's file. Check that \`storedRangeStillMatches\` → \`snapshotContradicts\` (which prefix-matches a truncated snapshot) detects drift correctly.`
    > `- **Lazy relRange attachment and repair:** a missing (lazy-attach) or dead (repair) \`relRange\` is minted from the stored flat range only when \`storedRangeStillMatches()\` holds — also true for a record with no \`textSnapshot\` (an unverified mint, by design). Otherwise the result is \`degraded\` and no anchor is minted — correct, not a bug; the repair arm still strips the dead \`relRange\` and writes the stripped record. Verify writes run inside \`withMcp\` (\`refreshAllRanges\` default) or the caller's own tagged transaction (\`skipTransact: true\`, e.g. \`withReload\` in \`documents/watcher.ts\` \`reanchorAnnotations\`) (ADR-031).`
  - **dc:H5: REPLACE (S5).** The export lives in `docx-comment-export.ts`, and browser-created annotations arrive without a relRange:
    > ``- **Import/export round-trip:** Every server-side annotation creation path goes through `anchoredRange()` (browser-created annotations arrive with a flat range only and are lazily attached). Check `tandem_exportAnnotations` (exports `listAnnotationsRefreshed` ranges), `.docx` comment import (`src/server/file-io/docx-comments.ts`, `surrogates: "ignore"`) and `.docx` comment export (`src/server/file-io/docx-comment-export.ts`, which snaps a mid-pair offset outward).``
  - **S6:**
    - :40: add "Creation paths pass `rejectHeadingOverlap`; relocation of an EXISTING annotation deliberately does not (refusing would drop the record). Only top-level headings carry a prefix." Make HEADING_OVERLAP conditional on `rejectHeadingOverlap`.
    - :41: replace `findXmlText()` with `findXmlTextAtOffset` (`ydoc.ts:110`), which walks multiple XmlTexts and hardBreaks.
    - dc:M2: add `findXmlTextAtOffset`, `rangeOverlapsHeadingPrefix` and `anchorFlatRange` to the `ydoc.ts` line.
  - **N5, :12:** element text can contain `\n` (separators between nested blocks), and a hardBreak counts as 1 character.
- **dc:M6:** release lines 12-13 now say "**SEVEN surfaces**". The replacement line is `The version bump has **SEVEN surfaces**, none of which bump automatically. Surfaces 1–4 are`; leave lines 14-18 untouched.
- **dc:M7** has moved to release:148-151.
- **dc:M8:** also reword the heading at svelte-migration-reviewer.md:65 ("### 4. @keyframes Needs :global Wrapper") to "### 4. Global @keyframes need the `-global-` prefix".
- **dc:M1 (diverge merge):**
  - Move each file's frame body and output-shape sentence **verbatim**:

    | File | Frame body | Shape sentence |
    |---|---|---|
    | regulator | 20-28 | 32 |
    | speedrunner | 19-27 | 31 |
    | biology | 19-29 | 33 |
    | on-call | 19-29 | 33 |
    | deletionist | 19-30 | 34 |
    | future-self | 19-30 | 34 |

    Deletionist's first sentence is `Delete <X>.`.
  - Update `diverge.md` at :29, :31, :32, :33 and :146.
  - Update `docs/architecture.md:1235` to "5 specialized reviewers (annotation-model, svelte-migration, crdt, security, license) plus the `/diverge` generator (run once per frame) and its critic".
  - Leave the historical manifest in `docs/reviews/2026-09-02-v1-review/` alone.
- **New: `.claude/agents/license-reviewer.md:83-85`.** "must be 14" becomes "must equal `TRIAL_DAYS` (`src/shared/constants.ts`) in the three files `tests/docs/trial-length-claims.test.ts` scans".

**`docs/architecture.md:657` (PR 2).** The bullet's lead sentence contradicts its own body and Rule 6, and the body predates #1626.
- Replace the bold lead `**A range's INTERIOR is checked against heading prefixes for \`tandem_edit\` only, and the endpoint rule is what the other callers keep.**` with `**A range's INTERIOR is checked against heading prefixes by every caller that eventually rewrites the span; only the plain-comment arm keeps the endpoint-only rule.**`
- Append to the bullet: `Since #1626 the reply seam's \`{kind: "replacement"}\` arm (\`replyForClaude\`) and the edit path (\`editPendingAnnotation\`, reached by \`tandem_editAnnotation\`'s \`newText\`) screen it too, through one shared \`screenSuggestionSpan\` over the record's live span (the \`refreshRange\` result, or the stored range when that refresh answers \`degraded\` or \`failed\`), and its refusal names a \`cause\` (\`"heading" | "unresolvable"\`).`

**More corrections from the executability review:**
- **`document.ts:732-745` comment (PR 3):** it quotes the old tandem_edit description ("'newlines in newText are inserted as literal text' is accurate") and calls the tool "a single-paragraph replacement". Rewrite it to match the new tool:H4 text.
- **The textSnapshot description "Expected text at [from, to]" appears twice,** at `annotations.ts:306` (tandem_comment) and `document.ts:710` (tandem_edit). Change **both** to `[from, to)`.
- **md:H9:** "guards live in `AnnotationLifecycle` — `editPending`, `transitionPending`, …" becomes "guards live in `lifecycle.ts` — …". `transitionPending` is module-private (`lifecycle.ts:981`).
- **New-upstream item (a), stated exactly:**
  - Five systems ship dark: licensing (`LICENSE_GATE_ENABLED` + `LICENSE_UPDATE_ENDPOINT`), the local model (`BYO_MODELS_ENABLED`), `.docx` (`DOCX_ENABLED`, ADR-053), Cowork (`COWORK_ENABLED`, ADR-055) and the non-loopback bind (`LAN_BIND_ENABLED`, ADR-056).
  - Only licensing and `BYO_MODELS_ENABLED` flip at v1.0 (roadmap.md:41-47).
  - Do **not** call all five "runtime-inert": the Cowork bullet says "It is not runtime-inert".
  - Keep this distinct from the licensing section's "Two consts flip at v1.0", which means the two licensing consts.
- **New-upstream item (d):** ADR-055 already carries the v0.7.1 / #1598 text (`decisions.md:2672`). Drop it from CLAUDE.md and do not edit `decisions.md`.
- **Release-skill companion (md:H24) after dc:M6:** dc:M6 removes the header version history, so the companion's "(this skill's header)" category becomes false. Drop that category ("three kinds" becomes "two").
- **`skill-instruction-contract.test.ts:514`:** the `toEqual` object also needs `version: "32"` → `"33"`, not just the bodyHash.
- **`docs/stacked-prs.md:139`** has the same stale pre-push description as dc:H8's target. Fix it in PR 1.
- **`10-claudemd.md:43` is wrong:** `stateless-transport-claims` scans all of `docs/**/*.md`, not only CLAUDE.md and AGENTS.md. Correct this in the report (PR 5).

**Bundled tangential fixes beyond D1–D9.** Each is fixed under CLAUDE.md's "if you find something broken while working, fix it" rule and must be listed under that heading in its PR body:
- new-upstream (a)-(d);
- `docs/architecture.md:657` (a bold bullet, not a heading, contradicting Rule 6) and `:726-728`;
- the license-reviewer `TRIAL_DAYS` fix;
- `architecture.md:1235` adding "license";
- `crdt-reviewer.md` :21, :29, :40, :41, :61;
- annotation-model-reviewer S2/S3;
- the `factory.ts` doc comment;
- the svelte heading;
- `docs/stacked-prs.md:139`;
- the activity-tray fixture string.

The formerly optional items are now **in**: tool:H19's conflict clause, `license_refused` in the channel event list, and `docs/troubleshooting.md:67`.

**Out of scope (verified, not doing):** md:F31-F33 low flags; tool:L items; the untracked `.claude/worktrees/wt-triage/CLAUDE.md`; the comments at `docx-comments.ts:839-842` and `watcher.ts:300-303` (both are code comments that contradict the snap-is-total and collapse-polarity facts — **file one issue covering both**). `describeReplyWriteRefusal`'s message, which names MCP tools to the local model that has none of them, is a code change — **file an issue** for it rather than dropping it.

## Adversarial review record (2026-10-13)

Four reviewers ran against b9b3d062: executability, annotation-model, crdt and security. This review ran on the implementation plan, before any code. Every blocking finding was resolved in the plan, and the corrections above carry the result:
- **Security B1:** Appendix A had dropped void conditions.
- **Security B2:** dc:H7 read reachable 127/8 paths as dead code.
- **Annotation B1 / CRDT B1:** md:H13's refreshRange arms.
- **Annotation B2:** "bulk clears take notes".
- **CRDT B2:** the crdt-reviewer assoc direction.
- **Executability B1:** source files missing at handoff; the plan made them a precondition.
- **Executability B2:** `commit-push-pr` breaks the stack; the plan publishes with `gh stack submit` instead.
- **Executability B3:** the deferred SKILL cadence work (sk:F5/F6/F8-F10) was an untracked deferral; now #2215.

Should-fix items and nits are folded in where they apply.

## Appendix A — md:H20 replacement for the CLAUDE.md security bullet (~line 261)

Appendix A is the plan's text. The bullet that shipped in `CLAUDE.md` also carries two void conditions added in #2220's review: #1488 is acceptable only while `/health` leaks the same fact, and #2027 is void if the cross-platform origin matrix becomes verifiable.

```
- **One security finding is open, one is fixed-but-unverified, and eight are accepted rather than fixed.** Each is a live code condition, and several are voided by a change that looks like hardening, so read its bound in [docs/security.md](docs/security.md#open-findings) before assuming it covers what you are about to change. That register holds the bounds and exploit detail, kept out of this file on purpose because it is auto-loaded into sessions that read text from outside the project, and new findings are filed there as well as in the tracker — open: #1884 (the channel permission relay serves an approval prompt's `description` to any local caller; its LAN half is unreachable from another machine while the non-loopback bind ships dark). **Fixed but unverified:** #1420 (the middle-click half was smoked on Windows only; its closed issue does not mean macOS or Linux were checked). Verified or closed, not counted: #1745/#1746 (executed on the v0.25.0 tag build; tracker #1829; one green run says nothing about certificate expiry) and #1292. **Accepted (bounded):** #1654 caller-named write destinations (revisit 2027-02-28 via #1671; void if `tandem_open`'s resolver gains root containment or any tool or route takes a caller-named write leaf rather than a directory; CodeQL alert 16 stays open and must not be dismissed), #1599 the boot-sweep / `setup --apply` config race (revisit 2027-02-24; `tests/docs/config-writer-set-claims.test.ts` pins its scope, so adding a config writer widens it), #1609 the `runDoctor` path reads (bounded by its input, process environment, so UNC rejection is still required on document- and LLM-supplied paths), #1488 the `/.well-known/oauth-protected-resource/mcp` presence oracle (an exception to the DNS-rebinding rule above: its two handlers sit before `authMiddleware` with no Host check; its `Access-Control-Allow-Origin: *` is not the mechanism, so removing it closes nothing), #1666 `tandem_open`'s resolver has no root containment (it cannot create files; void if it gains that ability or Tandem gains an opened-workspace notion), #2027 `POST /api/save`'s `allowImageLoss` carries no proof of user intent (void if `/api/save` gains another destructive flag behind the same origin gate or the flag reaches beyond image-bearing `.docx`), and the two bind-level findings #1952 (`wakeUrl` hardcodes `127.0.0.1` under a non-loopback bind) and #1906 (`enforceLoopbackMutation` covers `/api` only, so a token-holding LAN peer could reach mutating MCP tools through `POST /mcp`), both bounded by ADR-056's `LAN_BIND_ENABLED = false` rather than a date and void if it flips or anything else makes the server listen beyond this computer — #1906's hole-or-intended decision is still owed as ADR-056's re-enable item 2. `tests/docs/security-findings-claims.test.ts` pins this bullet against the register but cannot see the tracker, so reconciling against GitHub is human review.
```

## Appendix B — md:H22 replacement for the licensing-gate bullet (~line 268)

```
- **It must stay behaviour-identical while dark.** `aiRefusal()` returns `null` on its first line while dark, and `tests/server/license-ai-refusal.test.ts` pins that the MCP, SSE, WS, chat, fan-out and stdio admission points admit over a trial that would refuse when armed; the launcher and local model are covered only by calling the same `aiRefusal()`. `const LICENSE_GATE_ENABLED = false` in `tsup.config.ts` → `__LICENSE_GATE_ENABLED__` define, read by `gate-flag.ts#GATE_ENABLED` (env fallback `TANDEM_LICENSE_GATE=1` for tsx/vitest). Two consts flip together at v1.0, in two languages, and `tests/docs/license-flip-consts.test.ts` turns `check` red on a half-flip. The second is `const LICENSE_UPDATE_ENDPOINT: &str = ""` in `src-tauri/src/lib.rs`: while it is empty, `resolve_update_route` returns `UpdateRoute::Public` before probing anything, and `build_updater`'s `Public` arm is `app.updater()` — the public manifest from `tauri.conf.json`. Keep `Public` working through the flip: it serves every trialing device. `NoUpdates` serves no manifest at all.
```

---

## Appendix C — the audit report as written (against `2331a28e`)

This is the audit as first written, before re-verification, and it is **not** current guidance. Its proposed hunks are labelled without the `md:`/`tool:`/`sk:`/`dc:` prefixes, and their "+" text must never be quoted as a rule: the corrections above decide what was applied. Three hunks are marked inline because their text contradicts current rules: md:H5 and md:H28 (the pre-#1521 licence rule) and md:H20 (the old open set; see F8 in the findings table). One fact is corrected in place: the `stateless-transport-claims` row in the CLAUDE.md slice's test table said that test scans only `CLAUDE.md` and `AGENTS.md`; it scans every `docs/**/*.md` too.

### Prompt audit — tandem @ 2331a28e (2026-10-13)

#### Assumptions

- **Scope:** the whole working directory's prompt surface:
  - `CLAUDE.md`, `AGENTS.md`
  - `skills/tandem/SKILL.md` (shipped to users)
  - the 7 `.claude/skills`, 11 `.claude/agents`, and `.claude/commands/diverge.md`
  - every MCP tool description, param `.describe()`, and output-schema description under `src/server/mcp/`
  - `SERVER_INSTRUCTIONS`, the wake advisory, the supervisor turns, and the channel-shim instructions
  - the local-model prompt and tools

  **Not read (may hold secrets):** `.claude/settings*.json`, hooks config, `.mcp.json`.

  **Out of scope:** user-level `~/.claude/`, and the untracked `.claude/worktrees/wt-triage/CLAUDE.md` (flagged below).
- **Target model:** Claude Opus 5.5 for all of it. That is the agent reading the config files, and the current flagship for the shipped skill and the tool text. No file pins its own model.
- **Non-Anthropic provider:** `src/server/local-model/` calls Ollama / an OpenAI-compatible endpoint, with an unknown local model, and it ships dark.
  - Its `SYSTEM_PROMPT` is documented as frozen against measured spike pass rates, so its caps are left alone.
  - Only contract-accuracy issues in its tools are reported.
  - No SDK switch is proposed.
- **Applied guidance:** `shared/prompt-audit.md`, plus the blog post the user linked ("The new rules of context engineering for Claude 5-generation models"). Its rules are:
  - a lightweight CLAUDE.md made of gotchas, with progressive disclosure;
  - no examples in tool descriptions, with expressive parameters instead;
  - usage rules belong in tool descriptions, not system prompts;
  - remove conflicting directives;
  - replace rules with judgement.
- **Mode:** read-only audit. Nothing in the repo was edited, and `git status` is clean after the reviewers ran.

#### Highest-impact findings

1. **Stale instructions in the adversarial-review agents produce false blockers, and in one case approve a design the project rejected.** CLAUDE.md says a reviewer's blocking finding stops the change, so these errors cost the most.
   - `annotation-model-reviewer` says the tombstone observer skips file-sync. Verified wrong: `sync.ts:268` records tombstones for every origin, by design.
   - It also describes a `wrap` callable that `lifecycle.ts` explicitly rejected.
   - `crdt-reviewer` predates the #1764 gating and would flag the correct no-write on the degraded path as a bug.
   - `security-reviewer` says the server is bound to 127.0.0.1 only, which ignores `TANDEM_BIND_HOST`.
2. **Tool contracts contradict their handlers.**
   - `tandem_open`'s `force` says it "Clears annotations". Since #1813 annotations survive and are re-anchored; what is lost is unsaved edits.
   - `tandem_save` says a modified file makes the save "REFUSED". It actually returns success with `saved:false`, so a model that only checks for errors thinks the file was written.
   - `tandem_edit` says newlines are inserted literally, but its own parameter says "no newlines", and `.txt` refuses them.
   - `tandem_search` is case-insensitive and `tandem_resolveRange` is case-sensitive. Neither description says so.
   - The stale `force` wording also appears in the shipped SKILL.md Hard Rule 6.
3. **CLAUDE.md is stale and has re-accreted.** It went from 35 KB on 2026-08-18 to 73 KB now, and has 242 bold spans in 331 lines. Seven facts are contradicted by the repo; all verified:
   - `dev:standalone` does not start the monitor;
   - the line citation `index.ts:655` is now 707;
   - the line citation `lib.rs:178` is now 179;
   - "eighteen" files `vi.mock` the watcher; the real count is 23;
   - the `surrogates` grep count is wrong;
   - the pre-push hook also runs `typecheck:tests`;
   - two security findings it lists as open, #1906 and #1952, are CLOSED on GitHub.

   Most of the growth is issue lineage and "now / no longer / until #NNNN" phrasing wrapped around rules that should stay. The hunks below cut about 25% (roughly 18–20 KB) without dropping or renumbering a rule and without breaking a pinned assertion.

One destructive item: `e2e-debug` tells you to delete `%LOCALAPPDATA%\tandem\Data\sessions\` to fix E2E "phantom tabs". That is the user's real session store. E2E uses an isolated `tandem-e2e-data` directory that is wiped on every run (verified), so the deletion destroys real data and fixes nothing.

#### Counts per group

| Slice | G1 dated text | G2 config files | G3 tool descriptions | G4 request/arch |
|---|---|---|---|---|
| CLAUDE.md + AGENTS.md | 2 | 27 (8 stale facts, 3 conflicts, 13 history, 1 stamp, 2 flags) | not applicable | not applicable |
| skills/tandem/SKILL.md + server/wake/channel text | 9 | 8 | 0 actionable | not applicable |
| `.claude/` skills, agents, commands | 4 | 23 | not applicable | 1 (redundant `diverge-*` roster) |
| MCP tool descriptions + local-model tools | 7 (history) | — | 16 (6 contract mismatches, 9 under-described, 1 structural) | not applicable |

**Group 4, request config:** the only model-calling code is the dark Ollama loop. It has no Anthropic request config and no prefill, thinking, or caching fossils. No token accounting exists for it, which is moot while it ships dark.

#### Cross-slice interactions — read before taking hunks

- **The stale `force: true` claim appears in four places.** Fix all four or none: tools H1 (param) and H3 (save error text), skill F1 (Hard Rule 6), and CLAUDE.md's notes bullet (H9 in that slice already words it correctly).
- **Release skill step 9 has two competing rewrites.**
  - Take CLAUDE.md H24's companion if you remove the version stamp from CLAUDE.md.
  - Otherwise take `.claude` H17.
  - Never take both.
- **Removing the deprecated stubs (tools H17)** changes the pinned count string in CLAUDE.md, `All 33 MCP tools (28 active, 2 shipped dark, 3 deprecated stubs)`, which `tests/docs/tool-count-drift.test.ts` pins. It also makes skill F2 partly redundant. The stubs registration and SKILL.md should change in the same PR.
- **The diverge count fix (`.claude` H15)** also edits CLAUDE.md:83, from "~16" to 10 Agent calls.
- **CLAUDE.md F1 and `.claude` finding X are the same `dev:standalone` monitor fix.** Take it once.
- **Every SKILL.md body hunk needs `version: 27 → 28`.** It also needs the two test literals in `tests/skill-instruction-contract.test.ts` and a recomputed `bodyHash`. Without them, `refreshExistingSkillIfStale` never pushes the change to users.

#### Flags (no edit proposed)

- **F8: reconcile `docs/security.md` against the tracker before touching the CLAUDE.md security bullet.** #1906 was CLOSED/COMPLETED on 2026-09-17 and #1952 CLOSED/NOT_PLANNED on 2026-10-05. Both are still listed as open in the register and in CLAUDE.md. `security-findings-claims.test.ts` stays green because it cannot see GitHub. This is a security-posture decision, so it is yours to make.
- **The `docs/architecture.md:657` heading** ("INTERIOR is checked … for `tandem_edit` only") contradicts Critical Rule 6. It is outside this slice.
- **The untracked `.claude/worktrees/wt-triage/CLAUDE.md` is a stale copy.** It loads as nested memory for any session inside that worktree.
- **Going further toward "lightweight CLAUDE.md"** would mean moving the Gotchas subsections into `docs/gotchas.md` behind pointers. That conflicts with the file's stated design of keeping silent-failure rules inline, so it is your call, not an audit fix.
- **The rest are per-slice Low items, listed in each section.**

#### Verification (Step 7)

- **Group 2 fact fixes:** already re-checked against the repo, the first-hand checks listed above.
- **Reviewer-agent hunks:** low risk. They only correct facts.
- **SKILL.md hunks F5, F6 and F8** (polling cadence and workflow prose) change what dispatched user sessions read. The lexical tests are updated in the hunks, but the real check is the live `/tandem` arming and polling acceptance run, which needs your hardware.
- **Tool-description hunks:** no test pins description text except the `.docx`-dark scan (`/docx|\bWord\b/i`), which every replacement avoids. `docs/mcp-tools.md` mirrors several descriptions and is unpinned, so update it by hand.
- **CLAUDE.md H20 security bullet:** checked offline against the parser in `security-findings-claims.test.ts`.
- **Before deleting anything,** run `npm test` once per batch of hunks you take. A removal is a hypothesis.

---


---

#### Prompt audit: CLAUDE.md and AGENTS.md

**Scope:** `CLAUDE.md` (331 lines, 73,289 bytes) and `AGENTS.md` (47 lines). Running `git ls-files` finds no other tracked CLAUDE.md or AGENTS.md. There is an untracked copy at `.claude/worktrees/wt-triage/CLAUDE.md`. It is out of scope and is flagged at the end.

**Target model:** Claude Opus 5.5, the coding agent that reads these files.

**Method:** I checked facts with Read, Grep and git, and ran read-only `gh issue view` calls. I did not create, edit or run anything else.

**Highest-impact findings:**
1. **Three facts in CLAUDE.md are wrong against the code.**
   - Quick Reference says `npm run dev:standalone` starts the monitor. `scripts/dev-standalone.mjs:203` says it deliberately does not.
   - `src/server/index.ts:655` should be about line 707.
   - "eighteen" test files `vi.mock` the file watcher; the real count is 23.
   - `src-tauri/src/lib.rs:178` should be line 179.
   - The `grep 'surrogates: "ignore"'` aside claims three literals. There are two in code, plus four comment hits.
   - The pre-push hook is listed as three steps. It also runs `npm run typecheck:tests`.
2. **AGENTS.md contradicts CLAUDE.md Critical Rule 9.** AGENTS.md line 31 says the `/api` half of the license gate is "review-only against the enumeration in CLAUDE.md → Licensing gate". In fact `tests/server/license-gate-api-coverage.test.ts` has enforced it since 2026-09-08, and that list now lives in `docs/licensing-explained.md`.
3. **The security-findings paragraph is stale against GitHub.** It is 7.9 KB, the biggest single passage. It lists #1906 and #1952 as open. GitHub shows #1906 closed as *completed* on 2026-09-17 and #1952 closed as *not planned* on 2026-10-05. `docs/security.md` has the same drift, and the pinning test cannot see it, which the test says itself. Most of the passage repeats the register.
4. **The file has accreted.** It shrank to 35 KB on 2026-08-18 and has grown back to 73 KB in five weeks, with 100 commits. That growth is mostly issue-by-issue archaeology wrapped around rules that should stay. It also has 242 bold spans in 331 lines.

**Counts:**
- Group 1 has 2 findings: one about pressure language, one about migration-relative phrasing.
- Group 2 has 27 findings:
  - 8 contradicted volatile facts
  - 3 conflicts between files
  - 13 history-narrative or archaeology passages
  - 1 stale version stamp
  - 2 low-confidence flags
- Groups 3 and 4 are not applicable: there are no tool definitions or request code in this slice.

##### Tests that read CLAUDE.md

Every proposed hunk below was written to keep these green.

| Test | What it pins in CLAUDE.md |
|---|---|
| `tests/docs/security-findings-claims.test.ts` | It reads the single line containing `security findings are open`. That line must contain `**<Word> security findings are open` and `— open:`. The open set is the `#refs` at paren-depth 0 between `— open:` and the first top-level `**Fixed but unverified:**` / `**Accepted`. It must say `<word> are accepted rather than fixed`, with a count equal to the register's Accepted bullets (currently six). It must also mention every register entry's issue number: 1292 1420 1488 1599 1609 1654 1666 1671 1829 1884 1906 1952 2027. |
| `tests/docs/loopback-gate-claims.test.ts` | Text from `governs the routes that` to the next blank line must name `` `open` `upload` `close` `annotation-reply` `remove-annotation` `rotate-token` `` and contain `**Six**`. The file must contain `/api/channel-` and `/api/chat`, and must not contain `/api/channel/*`. Any line naming `assertLoopbackForMutation` must not call it a no-op or inert. |
| `tests/docs/tool-count-drift.test.ts` | Exact strings `All 33 MCP tools (28 active, 2 shipped dark, 3 deprecated stubs)` and `28 active MCP tools`. These counts are CI-verified, so they are **not** findings. |
| `tests/scripts/acceptance-harness-wiring.test.ts` | Must match `/acceptance harness[^.]*\`check\` job/i`. Must not match `/acceptance harness is not run by CI/i`. |
| `tests/scripts/windows-acl-proof-wiring.test.ts` | Must contain `windows-acl-proof`. |
| `tests/scripts/typecheck-tests-wiring.test.ts` | Must contain `typecheck:tests` and `typecheck-tests-wiring`. |
| `tests/docs/stateless-transport-claims.test.ts` | Scans CLAUDE.md, AGENTS.md and every `docs/**/*.md` (plus source and test comments) for a *false* claim. Nothing here is affected. |
| `scripts/check-doc-links.mjs` (`npm run check:links`) | Anchors in links must resolve. All anchors used below already exist. |

Critical Rule numbers are cited about 500 times across `src/`, `docs/`, `.claude/` and `tests/`. The rewrites keep every rule's number. `docs/architecture.md:655` and `src/server/mcp/document.ts:1034` cite "Critical Rule 4 enumerates four" `ignore` callers, so the Rule 4 rewrite keeps that list.

#### 1. Findings

| # | Location | Evidence | Pattern | Why obsolete | Conf. | Action | Pins |
|---|---|---|---|---|---|---|---|
| F1 | CLAUDE.md:35 | "Vite (:5173) + server watcher (:3478/:3479) + monitor" | G2 Volatile specifics / conflict with AGENTS.md:9 | `scripts/dev-standalone.mjs:203-223` says "The monitor is deliberately NOT spawned here" and prints that at startup. AGENTS.md:9 is correct. | High | rewrite | none |
| F2 | AGENTS.md:31 | "Only the MCP half is CI-enforced … the `/api` half is review-only against the enumeration in [`CLAUDE.md` → Licensing gate]" | G2 Conflict (AGENTS 2026-08-13 vs CLAUDE Rule 9 2026-09-08) | `tests/server/license-gate-api-coverage.test.ts` was added 2026-09-08. The CLAUDE.md Licensing section no longer holds the list; it points to `docs/licensing-explained.md#the-gated-set`. | High | rewrite (older file) | none |
| F3 | CLAUDE.md:224 | "`src/server/index.ts:655`" | G2 Volatile | The `if (transportMode === "http")` branch that holds the skill refresh and the CHANGELOG open now starts at line 707. Line 655 is TANDEM_BIND_HOST validation. | High | rewrite (drop the line number) | none |
| F4 | CLAUDE.md:268 | "`src-tauri/src/lib.rs:178`" | G2 Volatile | The const is at lib.rs:179. | High | rewrite (drop the line number) | none (license-flip-consts reads lib.rs, not CLAUDE.md) |
| F5 | CLAUDE.md:140, :227 | "eighteen mocking test files" / "eighteen test files `vi.mock` it" | G2 Volatile | `grep vi.mock(...file-watcher` finds 23 files under tests/. The "four `src` importers" claim is correct. | High | rewrite (no count) | none |
| F6 | CLAUDE.md:26 | "`grep 'surrogates: \"ignore\"' src/` returns only three literals" | G2 Volatile | It returns 6 lines: 2 code literals (docx-capture.ts:204, docx-comments.ts:845) and 4 comments. The list of four exempt callers is still correct. | High | rewrite | none |
| F7 | CLAUDE.md:322, :291; AGENTS.md:17 | "The pre-push hook runs biome + the full vitest suite + `cargo test`" / "pre-push hook is biome + vitest + `cargo test`" | G2 Volatile | `.husky/pre-push` also runs `npm run typecheck:tests`, which has been there since about 2026-08-25. AGENTS.md:17 was written 2026-09-10 and still omits it. | High | rewrite | none |
| F8 | CLAUDE.md:261 (and docs/security.md register) | "Three security findings are open … open: #1952 … #1906" | G2 Volatile (tracker contradicts) | `gh` shows #1906 CLOSED/COMPLETED on 2026-09-17 and #1952 CLOSED/NOT_PLANNED on 2026-10-05. The register agrees with CLAUDE.md, so the pinning test is green. Re-deciding security posture is Bryan's call. | High | **flag**: reconcile `docs/security.md`, then change the count word. **Resolved by D1:** #1906 and #1952 stay in the register as accepted (bounded) under ADR-056; a closed issue does not mean the hole is fixed. | security-findings-claims (the count word must follow the register) |
| F9 | CLAUDE.md:261 | 7,864-byte single line, e.g. "**#1745/#1746 … are NO LONGER unverified: they EXECUTED on the v0.25.0 tag build** (run `34005276975` …", "recorded in no document at all until 2026-09-11", "Two of these were listed here as OPEN until 2026-09-11" | G2 History narrative + duplicated content (Time-sensitive row) | Everything is in `docs/security.md#open-findings`. CLAUDE.md even says "The exploit detail deliberately lives there". Keeping two copies is exactly how F8 happened. | Medium | rewrite to a ~2 KB bullet that satisfies every pin (Hunk H20). Optional stronger fix: replace it with a pointer and drop the CLAUDE.md half of the test (see note under H20). | security-findings-claims. H20 was checked offline against the test's own parsing logic and passes all six specs. |
| F10 | CLAUDE.md:258 | "It was nine until `save`, `convert` and `apply-changes` gained … `/api/save` was reachable unconditionally …" | G2 History narrative | The rules worth keeping: the six ungated routes, the `rotate-token` second layer, no origin gate on `open`/`rotate-token`, and the simple-request CSRF hazard. The rest is incident history. | Medium | rewrite | loopback-gate-claims (passage marker, six route names, `**Six**`; kept) |
| F11 | CLAUDE.md:21 and file-wide | "These WILL break things if violated:"; 242 `**bold**` spans in 331 lines | G1a Pressure language | When almost everything is bold, the bold stops marking anything. Current models follow plain statements closely, so the shouted register leads to over-application. | Medium | rewrite the header; the hunks below use normal emphasis | none |
| F12 | CLAUDE.md:24 (Rule 2) | "(#1482) … which is how three raw client `.transact(` calls survived for months. `audit:origins` now walks …" | G2 History narrative / G1d migration-relative | Rule, helpers and enforcement gaps stay. The incident story goes. | Medium | rewrite | none |
| F13 | CLAUDE.md:26 (Rule 4) | "(#1752) … Two placements are load-bearing and easy to 'tidy' into a bug … do not describe the validation after it as a second layer …" | G2 History narrative / G1c padding | The order contract is documented at `validateRange` in `src/server/positions.ts:536-555`. The four-caller list must stay because other files cite it. | Medium | rewrite | none |
| F14 | CLAUDE.md:28 (Rule 6) | "#1766 first read the term as `tandem_edit`'s alone … The edit path is the carrier #1626's review found open … a flat arm asserted a heading for all of them" | G2 History narrative | The carrier list and the plain-comment exception are the rule. The rest is review archaeology, already in `docs/architecture.md:657-658`, `lifecycle.ts:340/384` and `document-store.ts:297`. | Medium | rewrite | none |
| F15 | CLAUDE.md:31 (Rule 9) | "added after `POST /api/mode/release` was found mutating … The prose list … is now a readable mirror rather than the review itself" | G2 History / G1d migration-relative | Rule and enforcement stay; the backstory goes. | Medium | rewrite | none |
| F16 | CLAUDE.md:90-98 | "#1345 is the current instance." / "(`/diverge` was once deleted as \"never invoked\" when it had been used twice …)" | G2 History narrative / Volatile | "Current instance" will rot (#1345 is open, with a 2026-11-01 date). The anecdote illustrates the rule but carries no instruction of its own. | Medium | rewrite | none |
| F17 | CLAUDE.md:152 | 2,788-byte bullet: "stating only the read half is what let three write paths disagree until #1680 … the write-side twin of #1619 … Since #1803 …" | G2 History narrative | The guard placements and the two "never guard" rules are silent-failure rules and stay. The incident lineage lives in `lifecycle.ts:268-304` and the seam tests. | Medium | rewrite (split into two bullets) | none |
| F18 | CLAUDE.md:159 | "`mcp/file-opener.ts` is **gone** (ADR-034 Unit 7c);" | G1d Migration-relative phrasing | It describes a file that no longer exists. Nothing tells the reader to look for it. | Medium | remove the clause | none |
| F19 | CLAUDE.md:193 | "(#1813, decided) … used to call `store.clear()` … Before #1813 the unlink hid that … and `clearOne` was the only canceller before this …" | G2 History narrative / move | `docs/gotchas.md` "Force-reload clears in-place" has the core. The ordering contract is commented at the call site in `documents/populate.ts:390-426`. | Medium | rewrite to rule + pointer | none |
| F20 | CLAUDE.md:195 | "That half is unchanged and is still the rule. … a new spurious-collapse arm" | G1d Migration-relative | It is written as a diff against an earlier version the reader never saw. | Medium | rewrite | none |
| F21 | CLAUDE.md:206 | "that reaped Claude Desktop's bridge after 30 minutes and broke it for the rest of the day … no longer relies on being respawned" | G2 History / G1d | Mechanism stays; incident and "no longer" go. `docs/gotchas.md` MCP / Server already has both bullets. | Medium | rewrite | none |
| F22 | CLAUDE.md:227 | "and the write triple is now a THREE-call sequence in an inner `finally` (#1749)" | G1d / G2 | Same rule without the "now". Folds in the F5 fix. | Medium | rewrite | none |
| F23 | CLAUDE.md:235 | "(#1492) … the old #1483 adoption hazard is gone by construction. Two truths to not oversell:" | G2 History | — | Medium | rewrite | none |
| F24 | CLAUDE.md:237 | "That shipped: ~40 fixtures, 162 of 175 annotation files and 4,469 doc-backup dirs accumulated …" | G2 History narrative | Incident statistics; the rule stands without them. | Medium | rewrite | app-data-isolation-wiring reads only config files |
| F25 | CLAUDE.md:240 | "Until #1616 no tsconfig `include` reached the test tree at all, so ~900 type errors sat there … It is green rather than unchecked-and-broken — the TS2353 it held is fixed" | G2 History narrative | Rules stay: the only runner, the whole-directory includes, the tauri-driver carve-out. The wiring test's own comments carry the mechanism. | Medium | rewrite | typecheck-tests-wiring (`typecheck:tests`, `typecheck-tests-wiring`; kept) |
| F26 | CLAUDE.md:241-242 | "(#1728 carries that decision, dated)"; "(#1529) … vitest exited 0" | G2 History (light) | Can be tightened. | Medium | rewrite | windows-acl-proof-wiring (`windows-acl-proof`; kept) |
| F27 | CLAUDE.md:271 | "Since #1786 the update Worker **retains** … merged but inert until Bryan redeploys both Workers" | G2 Volatile/ops status, duplicated | Already in `docs/licensing-explained.md:537-540` and `docs/licensing-operations.md:277-282`. | Medium | move (destination already has it) | none |
| F28 | CLAUDE.md:275-285 | "**Shipped: v0.28.0** (2026-09-25) … **§1's updater row finally ran** (2026-09-09 …), closing #1596 …" | G2 Volatile version stamp + duplicated history | The repo has the version (`package.json`, CHANGELOG). The updater-log facts are in `docs/release-smoke-checklist.md:32, 156-185`. The section says "Do not re-narrate", then re-narrates. Each release spends a commit on it (#2121). | Medium | rewrite. Also change `.claude/skills/release/SKILL.md` step 9 and line 90, which tell the release to update this stamp. | none |
| F29 | CLAUDE.md:291 | "First-use arming is measured, not argued: v0.22.0 took natural arming from 3 of 6 to 6 of 6." | G2 History | Trim, and split the required-checks facts into their own bullet. | Medium | rewrite | acceptance-harness-wiring (keep "The acceptance harness runs in CI's `check` job") |
| F30 | CLAUDE.md:173 vs AGENTS.md:16 | "`cargo tauri dev` / `cargo tauri build`" | G2 Conflict / Volatile | `package.json` `dev:tauri`/`build:tauri` run `download-node-sidecar.mjs` and `build-reaper.mjs` first. Bare `cargo tauri dev` on a fresh clone lacks the sidecar (see the "sidecar download is version-aware" bullet in docs/gotchas.md). | Medium | rewrite | none |
| F31 | CLAUDE.md:57-58 | "99 numbered lessons", "ADR-001–053" | G2 Volatile | True today (99 and ADR-053 confirmed). They rot with every new lesson or ADR and add little. | Low | flag | none |
| F32 | CLAUDE.md:260 | "`/issue-pipeline`, `triage` and `to-issues` read issues autonomously" | G2 Volatile | None of these exist in `.claude/skills`, which line 306 says is "the complete set". They may be user-level skills, so absence is not proof. | Low | flag | none |
| F33 | CLAUDE.md:308 | `<!-- autoskills:end -->` | Orphan generator marker | There is no start marker and no in-repo tool uses it. An external tool might. | Low | flag | none |

**Out-of-slice flags:**
- `docs/architecture.md:657` has the heading "A range's INTERIOR is checked against heading prefixes for `tandem_edit` only". That contradicts Rule 6 and its own body, and it omits the reply and edit carriers added under #1626.
- The untracked `.claude/worktrees/wt-triage/CLAUDE.md` is a stale copy. It would load as nested memory for any session working inside that worktree.

#### 2. Proposed hunks

One finding per hunk. Each `-` line is shortened to its opening words and the hunk replaces the **whole** numbered line or range. The `+` text is exact.

**H1 (F11), CLAUDE.md:21**
```diff
@@ -21 +21 @@
-These WILL break things if violated:
+Each of these breaks something when violated, usually without a type error:
```

**H2 (F12), CLAUDE.md:24**
```diff
@@ -24 +24 @@
-2. **Origin-tag every Y.Doc write via the wrapper helpers.** Raw `doc.transact(...)` is forbidden anywhere in `src/` — **client included; ...
+2. **Origin-tag every Y.Doc write via the wrapper helpers.** Raw `doc.transact(...)` is forbidden anywhere in `src/`, client included. Enforcement is warn-only: the `check-raw-transact.sh` PostToolUse hook only sees code an agent edits, and `npm run audit:origins` exits 0 (the CI gate is `tests/scripts/audit-origins.test.ts`). A bare `map.set(...)` is invisible to both; the DEV-only `installUntaggedWriteWarning` covers it. Client tags never cross the wire, so this is hygiene, not a privacy control. Six helpers in `src/shared/origins.ts`: `withMcp`, `withFileSync`, `withInternal`, `withReload`, `withModeRelease`, `withBrowser`. Picking the wrong one is a silent bug — the helper choice is the contract. Only `browser` writes generate channel events. Which-helper-when table and the full skip lists: [docs/gotchas.md](docs/gotchas.md#origin-tagging--which-helper-to-use-critical-rule-2). See ADR-031.
```

**H3 (F13 + F6), CLAUDE.md:26**
```diff
@@ -26 +26 @@
-4. **Ranges use `validateRange()` + `anchoredRange()`, not raw offsets.** `anchoredRange()` creates the flat offset ...
+4. **Ranges use `validateRange()` + `anchoredRange()`, not raw offsets.** `anchoredRange()` creates the flat offset and the Yjs RelativePosition in one call. The check order is a contract, documented at `validateRange` in `src/server/positions.ts`: integer → ordering → lower bound → snapshot staleness → upper bound → non-empty → surrogate-safe → heading overlap. The lower bound runs before staleness because `slice` wraps a negative start; the upper bound runs after it because the watcher's relocation probe passes stale offsets past the new end with a snapshot and relies on `RANGE_MOVED` — so a mismatched `textSnapshot` wins over `out-of-bounds`. A rejection's `reason` (`"non-integer" | "inverted" | "out-of-bounds" | "empty" | "surrogate" | "unresolvable"`) reaches the wire as `details.reason`. `validateFlatRange(text, from, to)` is the pure form for callers holding flat text but no `Y.Doc`. The surrogate check is the paired predicate (a one-sided test rejects the legal boundary between two astral characters). Exactly four stored/derived-offset callers pass `surrogates: "ignore"`, because they score or re-derive rather than write a file: the watcher's relocation probe and relocation anchor (which share one `const surrogates = "ignore"` binding, so a grep for the literal misses them), `.docx` capture, and `.docx` comment import. The `.docx` comment export resolver writes bytes into the user's file, so it snaps a stored offset outward off the pair instead; the snap is total, and the validation after it is there for `out-of-bounds` / `inverted` / `non-integer`. Point ranges (`from === to`) need `allowEmpty`; `tandem_edit` passes it because `tandem_edit(n, n, "X")` is the only mid-document insert path.
```

**H4 (F14), CLAUDE.md:28**
```diff
@@ -28 +28 @@
-6. **`tandem_edit` rejects heading markup ranges.** A range whose **start, end or interior** overlaps ...
+6. **`tandem_edit` rejects heading markup ranges.** A range whose start, end or interior overlaps a heading prefix (e.g. `## `) returns INVALID_RANGE — target text content only, or split the edit at the heading boundary. The exclusive end is not exclusive here: a `to` equal to the first character of a prefix is refused, because it resolves into the heading block. The interior check (`rejectHeadingInterior`) applies to every caller whose span is eventually rewritten, because a stored `suggestedText` is a rewrite deferred to Accept that replaces the stored flat span verbatim — a suggestion stepping over a prefix deletes the heading, and `snapshotContradicts` cannot object. The carriers: `tandem_edit`; the suggestion arm of both annotation creators (`YDocStore.anchorRange({purpose: "suggestion"})` for a `tandem_comment` with `suggestedText`, and `local-model/tools.ts`'s `"replacement"` kind); and the reply seam's `{kind: "replacement"}` arm (`replyForClaude`) plus `editPendingAnnotation` (`tandem_editAnnotation`'s `newText`), which share `screenSuggestionSpan` over the record's live span (`refreshRange` first, the stored range only when the anchor is dead). That screen's refusal names a `cause` (`"heading" | "unresolvable"`) because `anchoredRange` fails in more ways than a heading. Plain comments keep the endpoint-only rule — a `tandem_comment` may span a heading — and both creators take the arm as a required discriminant, so a new caller cannot default into the wrong half. See [docs/architecture.md](docs/architecture.md).
```

> **Not applied (md:H5, obsolete).** This is the pre-#1521 Rule 9. The current rule is the
> opposite: the licence is one AI-surface refusal, never a per-tool or per-route gate.

**H5 (F15), CLAUDE.md:31**
```diff
@@ -31 +31 @@
-9. **A new mutating MCP tool or `/api` route joins the license gated set in BOTH halves.** ...
+9. **A new mutating MCP tool or `/api` route joins the license gated set in both halves.** An MCP write bypasses the Hocuspocus read-only surface, so a gated route whose MCP twin is ungated is a hole. Both halves are CI-enforced by tables with one row per surface (`gated` or `ungated`, each with a written reason): `tests/server/license-gate-coverage.test.ts` (MCP tools) and `tests/server/license-gate-api-coverage.test.ts` (`/api` routes). Each fails closed on a new surface with no row; the `/api` one also sweeps `src/server` for a registrar file outside its five and for a `licenseGate()` call in a module it does not know — the in-handler shape a `licenseGateMiddleware` grep cannot find. [docs/licensing-explained.md](docs/licensing-explained.md#the-gated-set) mirrors the tables in prose.
```

**H6 (F1), CLAUDE.md:35**
```diff
@@ -35 +35 @@
-- `npm run dev:standalone` -- Vite (:5173) + server watcher (:3478/:3479) + monitor, via `scripts/dev-standalone.mjs`
+- `npm run dev:standalone` -- Vite (:5173) + server watcher (:3478/:3479), via `scripts/dev-standalone.mjs`. It deliberately does not start the monitor (an always-on consumer masks `subscribers === 0`); run `npx tsx src/monitor/index.ts` by hand when testing push delivery.
```

**H7 (F16), CLAUDE.md:90-98**
```diff
@@ -90,9 +90,7 @@
-**Dated gates need a tracked home and a tracked criterion** (#1308). Anything shipped with a
-kill date, review date or "revisit if" condition obeys two rules, because breaking either has
-already produced a wrong verdict:
-
-1. **File a dated issue with the date in its title.** A date living only in a doc comment or commit message never surfaces in `gh issue list`, so nothing puts it in front of a human. #1345 is the current instance.
-2. **The criterion must be answerable from tracked files** — one whose evidence lives where the judge cannot look fails silently, and **it fails toward deletion**. (`/diverge` was once deleted as "never invoked" when it had been used twice; the evidence sat in gitignored `.claude/plans/`.)
-
-At review time the outcome must be keep, replace or retire. "Wait and see again" is not one of
-them: a gate that can be deferred indefinitely is not a gate.
+**Dated gates need a tracked home and a tracked criterion.** Anything shipped with a kill date,
+review date or "revisit if" condition gets (1) an issue with the date in its title — a date in a
+doc comment or commit message never surfaces in `gh issue list` — and (2) a criterion answerable
+from tracked files: evidence in gitignored places such as `.claude/plans/` is invisible to whoever
+judges it, and the gate then fails toward deletion. At review time the outcome is keep, replace
+or retire; "wait and see again" is not an outcome.
```

**H8 (F5), CLAUDE.md:139-140**
```diff
@@ -139,2 +139,2 @@
 gate), `src/server/file-watcher.ts` (the `watchFile` / `suppressNextChange` / `recordSelfWrite` /
-`rearmWatch` seam — four `src` importers, eighteen mocking test files), `src/server/launcher/`
+`rearmWatch` seam — four `src` importers, and widely `vi.mock`ed in tests), `src/server/launcher/`
```

**H9 (F17), CLAUDE.md:152** (one bullet becomes two)
```diff
@@ -152 +152,2 @@
-- **Annotations live in `Y.Map('annotations')`, not in document content.** `author` is ...
+- **Annotations live in `Y.Map('annotations')`, not in document content.** `author` is `"user" | "claude" | "import"` (import = Word comments from `.docx`). Types: `"highlight"` (user-only), `"comment"` (Claude-created, may carry `suggestedText`), `"note"` (personal, below). `directedAt` is deprecated and stripped on read.
+- **Notes are personal (ADR-027): Claude never reads, edits, resolves, removes or replies to one.** A read filter is not a write guard, so each write family carries its own guard in `AnnotationLifecycle` — `editPending`, `transitionPending`, `remove`, `reply` — always after `sanitizeAnnotation`, because a legacy `flag` is a note only once normalized. The same guards refuse a `{comment, audience: private}` record: `isPrivateForClaude` for edit and reply (a highlight falls to its own `invalid-suggestion-target` / `not-repliable` arm), and `isWithheldFromClaude` (`!isClaudeFacing`, the read filter's predicate) for resolve and remove. The reply guard tests `type === "note"` or `type === "comment" && audience !== "outbound"` — not `type !== "comment"`, which would answer a highlight parent with `invalid-note`. Never guard the user-side mechanisms: `addUserReply` (replying inside one's own note thread is allowed) and `removeAnnotationRecord` (the browser's Archive calls it directly); `tests/server/annotation-remove-seam.test.ts` and `annotation-reply-seam.test.ts` pin both as unguarded. Bulk clears (`tandem_open force`, restore, applyChanges) take notes with everything else, though force-open restores them from the durable envelope on the same open.
```

**H10 (F18), CLAUDE.md:159**
```diff
@@ -159 +159 @@
-- File open converges in `documents/open.ts` (ADR-034 Unit 7a), ... `mcp/file-opener.ts` is **gone** (ADR-034 Unit 7c); which four modules ...
+- File open converges in `documents/open.ts` (ADR-034 Unit 7a), close in `document-service.ts`; tab close goes through `POST /api/close`. **The reload family is `documents/reload-family.ts`** — `reloadDocumentFromMarkdown`, `restoreDocumentFromBackup`, `resolveExternalConflict`, each replacing an already-open document's content. Which four modules may import the family, and the symbols each may take, is pinned in `tests/server/documents-open.test.ts`. The four named entries are `openFromDisk` / `openFromUpload` / `openScratchpad` / `openFromRestore`; the first takes an optional `readOnly` flag (used by View Changelog), and `openFromRestore` exists so the restore path cannot forget to carry it.
```

**H11 (F30), CLAUDE.md:173**
```diff
@@ -173 +173 @@
-`cargo tauri dev` / `cargo tauri build`. Plugin-registration order, the Cowork ACL rules, the
+`npm run dev:tauri` / `npm run build:tauri` (they fetch the node sidecar and build the reaper before `cargo tauri`). Plugin-registration order, the Cowork ACL rules, the
```

**H12 (F19), CLAUDE.md:193.** The destination already has the content: `docs/gotchas.md` "Force-reload clears in-place" plus the ordering comments at `src/server/documents/populate.ts:390-426`.
```diff
@@ -193 +193 @@
-- **`tandem_open` with `force: true` clears annotations, awareness and content in one transaction — and the clear is IN-MEMORY ONLY (#1813, decided).** ...
+- **`tandem_open` with `force: true` clears annotations, awareness and content in one transaction, in memory only.** `clearAndReload` (`documents/populate.ts`) flushes the durable annotation envelope instead of deleting it, so personal notes survive, and the caller must then run `reanchorAnnotations` (`documents/watcher.ts`): `loadAndMerge` re-inserts each record verbatim with its pre-reload range and dead relRange, and the durable observer persists exactly that. The flush → `clearFileSyncContext` → `cancelPendingWrite()` order is a contract commented at `clearAndReload`; each reordering loses data differently, so read it before touching that function. Still not something to do mid-review: a moved span comes back `degraded` and the session is gone.
```

**H13 (F20), CLAUDE.md:195**
```diff
@@ -195 +195 @@
-- **Strip dead `relRange` RelativePositions, never preserve them** — ... That half is unchanged and is still the rule. ...
+- **Strip dead `relRange` RelativePositions, never preserve them** — a stale one resolving to null blocks the lazy re-attachment recovery path. The three arms that would mint or overwrite an anchor (repaired, lazy-attach, spurious-collapse) first check `storedRangeStillMatches` against the `textSnapshot`; on a mismatch they answer `degraded` and write nothing, so the flat range and relRange both survive for relocation and undo (`tandem_getAnnotations` shows `anchor: "degraded"`). A record with no `textSnapshot`, such as an imported Word comment, is minted unverified, and the collapse arm does not preserve it, because `.docx` export writes the refreshed range into the user's file.
```

**H14 (F21), CLAUDE.md:206**
```diff
@@ -206 +206 @@
-- **An open `GET /mcp` stream pins its session against the idle reaper, and the stdio bridge re-initializes on a 404 (#1588).** ...
+- **An open `GET /mcp` stream pins its session against the idle reaper, and the stdio bridge re-initializes on a 404.** `lastSeenAt` moves only in `dispatchToSession`, so idleness alone would read an attached-but-quiet client (such as Claude Desktop's bridge) as crashed. LRU eviction stays pin-blind on purpose: `openStreams` is evidence of attachment, `lastSeenAt` of use, and the bridge's reconnect is what makes eviction recoverable. `src/cli/mcp-stdio.ts` replays the captured handshake under a private id and fails closed only if the server *name* changed — a changed server version or `protocolVersion` is a Tandem upgrade, adopted and logged — and never exits on failure.
```

**H15 (F22 + F5), CLAUDE.md:227**
```diff
@@ -227 +227 @@
-- **File-watcher self-write filtering is two-layer, and the write triple is now a THREE-call sequence in an inner `finally` (#1749).** ...
+- **File-watcher self-write filtering is two-layer.** The seam is `src/server/file-watcher.ts` (not `documents/watcher.ts`, which only imports `watchFile` from it); four `src` modules import it and many tests `vi.mock` it, so a change there is felt everywhere. Layer 1 is an arrival counter: `suppressNextChange()`, consumed in the `fs.watch` callback, not the debounce timer. Layer 2: after every `atomicWrite`/`atomicWriteBuffer` self-write (save, save-as, restore) call `recordSelfWrite(path, content)`, then `rearmWatch(path)` in an inner `finally` wrapping exactly that suppress/write/record triple — never the function-level lock-release `finally`. `recordSelfWrite` must precede `rearmWatch`, because the re-arm clears the counter and on POSIX the fingerprint is then the only layer. The fingerprint must be a content hash, not size+mtime, or a false match silently drops a real external edit. `tandem_applyChanges` is deliberately not fingerprinted and takes no `rearmWatch` (re-arming would discard the pending inotify event and its reload would never land); `docx-apply.ts` must not reference `rearmWatch` at all. `tests/server/document-write-rearm.test.ts` pins the site table.
```

**H16 (F3), CLAUDE.md:224**
```diff
@@ -224 +224 @@
-... **Both live inside `if (transportMode === "http")` (`src/server/index.ts:655`), and so does the bundled-skill refresh** ...
+- **Auto-open `sample/welcome.md`** on first run; on upgrade `CHANGELOG.md` opens instead, **read-only** — otherwise autosave round-trips it through `remark-stringify` and rewrites the file. Both open **before** Hocuspocus/MCP start. Both live inside the `if (transportMode === "http")` startup branch of `src/server/index.ts`, and so does the bundled-skill refresh — a stdio-mode start opens no startup document and refreshes no skill. (Session restore is outside the branch and runs in both modes.)
```

**H17 (F23), CLAUDE.md:235**
```diff
@@ -235 +235 @@
-- **E2E and perf run on reserved port pairs (`scripts/test-ports.ts`), never the product's 3478/3479 (#1492), ...
+- **E2E and perf run on the reserved port pairs in `scripts/test-ports.ts`, never the product's 3478/3479, with `reuseExistingServer: false`**, so a running Tandem or `dev:server` coexists with a test run. The pair is reserved, not guarded: anything holding it that fails Playwright's health check (wedged, non-HTTP, or on the never-probed ws port) is SIGKILLed by the harness's boot `freePort()`. The load-bearing check is the served-client half of `scripts/e2e-guard.ts`, which fails closed if the Vite serving the suite lacks the harness `VITE_TANDEM_*` env (a client baked to :3479 would drive the destructive suite into the real backend). Never renumber the pairs onto ports any doc tells users to occupy — the wiring test pins `docs/troubleshooting.md` against every harness constant.
```

**H18 (F24), CLAUDE.md:237**
```diff
@@ -237 +237 @@
-- **The vitest run writes to a throwaway app-data dir, and that isolation lives in `vitest.config.ts`, not in the tests.** ...
+- **The vitest run writes to a throwaway app-data dir, and that isolation lives in `vitest.config.ts`, not in the tests.** `src/server/platform.ts` freezes `SESSION_DIR` and `LAST_SEEN_VERSION_FILE` at module load, so a `beforeEach` env override (`tests/helpers/annotation-store-env.ts`) cannot reach them and would leave sessions pointed at the developer's real app data. Isolation is a root `test.env` (it cascades into `projects`, beats a shell variable, and lands before any import) plus `tests/setup/app-data-isolation.ts` registered in both project blocks — `setupFiles` does not cascade from the root, so an entry hoisted there silently never runs. `tests/scripts/app-data-isolation-wiring.test.ts` pins both halves.
```

**H19 (F25), CLAUDE.md:240.** The pinned strings `typecheck:tests` and `typecheck-tests-wiring` are kept.
```diff
@@ -240 +240 @@
-- **`tests/` is typechecked, and `typecheck:tests` is the only thing that does it.** Until #1616 ...
+- **`tests/` is typechecked only by `npm run typecheck:tests`** (run by pre-push and CI's `check`; `npm run typecheck` does not chain it). Three configs own it — `tsconfig.tests.{node,client,e2e}.json` — and they include whole directories, never a suffix glob such as `*.test.ts` (the one sanctioned exception is `tests/*.test.ts`), because `tsc` fails closed only on a totally empty input set and a partial glob silently checks less. The node config excludes `**/*.svelte.ts`, which the client config owns because rune cells need a program that imports svelte. `tests/scripts/typecheck-tests-wiring.test.ts` pins the CI step, the exact package.json script, the `strict` family and the include shapes. `tests/tauri-driver/` is deliberately typechecked by nothing (its workflow is `workflow_dispatch`-only); re-check it by hand with `npm ci --prefix tests/tauri-driver && npx tsc -p tests/tauri-driver/tsconfig.json --noEmit`.
```

> **Superseded by Appendix A (md:H20).** Its open set is wrong: see F8 in the findings table.

**H20 (F9), CLAUDE.md:261.** I replicated the test's parsing logic in memory and ran it on this text: the open set is {1952, 1884, 1906}, nothing overlaps, every register ref is present, the count words match, and nothing open is filed as Accepted. It is about 2.0 KB instead of 7.9 KB. It still asserts #1952 and #1906 as open; per F8, reconcile `docs/security.md` first and then move the count word.
```diff
@@ -261 +261 @@
-- **Three security findings are open, one is fixed-but-unverified, and six are accepted rather than fixed** — open: #1952 ...
+- **Three security findings are open, one is fixed-but-unverified, and six are accepted rather than fixed.** Each is a live code condition: before changing auth, path, CORS or loopback code, read its entry in [docs/security.md](docs/security.md#open-findings), which holds the bounds and exploit detail (kept out of this auto-loaded file on purpose) and is the place to file new findings as well as the tracker — open: #1952 (`wakeUrl` hardcodes `127.0.0.1` under a non-loopback Cowork bind), #1884 (the channel permission relay serves an approval prompt's `description` to any local caller, and under Cowork its `POST` carve-out crosses the LAN), and #1906 (`enforceLoopbackMutation` covers `/api` only, so under Cowork a token-holding LAN peer reaches mutating MCP tools through `POST /mcp`). **Fixed but unverified:** #1420 (the middle-click half was smoked on Windows only; its closed issue does not mean macOS or Linux were checked). Verified or closed, not counted: #1745/#1746 (executed on the v0.25.0 tag build; tracker #1829) and #1292. **Accepted (bounded):** #1654 caller-named write destinations (revisit 2027-02-28 via #1671; CodeQL alert 16 stays open and must not be dismissed), #1599 the boot-sweep / `setup --apply` config race (revisit 2027-02-24; `tests/docs/config-writer-set-claims.test.ts` pins its scope, so adding a config writer widens it), #1609 the `runDoctor` path reads, #1488 the `/.well-known/oauth-protected-resource/mcp` presence oracle (the one exception to the DNS-rebinding rule above; its `Access-Control-Allow-Origin: *` is not the mechanism, so removing it closes nothing), #1666 `tandem_open`'s resolver has no root containment (it cannot create files, and #1654's acceptance depends on that staying true), and #2027 `POST /api/save`'s `allowImageLoss` carries no proof of user intent. `tests/docs/security-findings-claims.test.ts` pins this bullet against the register but cannot see the tracker, so reconciling against GitHub is human review.
```
*Stronger alternative (the user's choice, so not a separate hunk):* replace this bullet with a one-line pointer. Then in `tests/docs/security-findings-claims.test.ts`:
- Delete `claimBullet`, `segments`, `CLOSED_NOT_IN_CLAUDE_MD` (lines 124-160 and 285-313).
- Delete the five CLAUDE.md-dependent `it()`s at 163, 176, 208, 227 and 242.
- Delete the `describe` at 344-362.
- Keep the reconciliation-date spec (234) and the #2037 specs (319-342).
- Add `expect(CLAUDE_MD).not.toMatch(/security findings are open/)` so the second copy cannot grow back.

**H21 (F10), CLAUDE.md:258.** Pins are kept: the `governs the routes that` marker, all six backticked names, and `**Six**`. No inert-claim words appear on the `assertLoopbackForMutation` line.
```diff
@@ -258 +258 @@
-- **The per-handler gate governs the routes that call it, which is still not all of `/api`.** **Six** mutating routes ...
+- **The per-handler gate governs the routes that call it, which is not all of `/api`.** **Six** mutating routes in `src/server/mcp/api-routes.ts` call neither `assertLoopbackForMutation` nor `assertOriginAllowlisted`: `open` and `upload` (which take a caller-supplied filesystem path), plus `close`, `annotation-reply`, `remove-annotation` and `rotate-token`. Five rely solely on the path-wide loopback invariant; `rotate-token` also requires a parsed JSON body, which proves the request passed a CORS preflight. Do not give `open` or `rotate-token` the origin gate: the Tauri sidecar (reqwest) and the CLI (Node `fetch`) send no `Origin`, the gate fails closed on a missing one, and for `rotate-token` the CLI then rolls the new token back off disk. A `text/plain` POST is a simple request — no preflight fires and `express.json` leaves `req.body` undefined — so a handler that tolerates a missing body is reachable by any page in a local browser; that is why `save`, `convert` and `apply-changes` carry `assertOriginAllowlisted`. `tests/docs/loopback-gate-claims.test.ts` pins this enumeration against the source.
```

**H22 (F4), CLAUDE.md:268**
```diff
@@ -268 +268 @@
-- **It must stay byte-identical to today while dark.** ... `src-tauri/src/lib.rs:178` ...
+- **It must stay byte-identical to today while dark.** `const LICENSE_GATE_ENABLED = false` in `tsup.config.ts` → `__LICENSE_GATE_ENABLED__` define, read by `gate-flag.ts#GATE_ENABLED` (env fallback `TANDEM_LICENSE_GATE=1` for tsx/vitest). Two consts flip together at v1.0, in two languages, and `tests/docs/license-flip-consts.test.ts` turns `check` red on a half-flip. The second is `const LICENSE_UPDATE_ENDPOINT: &str = ""` in `src-tauri/src/lib.rs`: while it is empty, `resolve_update_route` returns `UpdateRoute::Public` before probing anything, and `build_updater`'s `Public` arm is `app.updater()` — the public manifest from `tauri.conf.json`. Keep `Public` working through the flip: it serves every trialing device. `NoUpdates` serves no manifest at all.
```

**H23 (F27), CLAUDE.md:271.** The destination already has the content: `docs/licensing-explained.md:537-540`.
```diff
@@ -271 +271 @@
-- A paid license runs **forever** — ... Since #1786 the update Worker **retains** ... until Bryan redeploys both Workers ...
+- A paid license runs **forever** — the run gate checks the signature only; `expiresAt` governs the update window alone. The update endpoint's `.endpoints()` **replaces** the manifest list rather than falling back, so a missing entitlement means the app says "You're up to date" forever, silently. The Worker-side detection for that, and whether it is deployed, is in [docs/licensing-explained.md](docs/licensing-explained.md); do not assume it is live.
```

**H24 (F28 + F29 + F7), CLAUDE.md:275-291.** Pins are kept: `28 active MCP tools`, the "acceptance harness … `check` job" sentence, and `windows-acl-proof`.
```diff
@@ -275,17 +275,10 @@
-**Shipped: v0.28.0** (2026-09-25). Release history is [CHANGELOG.md](CHANGELOG.md); remaining
-v1.0 work is [docs/roadmap.md](docs/roadmap.md#active--toward-v10); what the last smoke run
-settled is in [docs/release-smoke-checklist.md](docs/release-smoke-checklist.md#what-the-v0250-run-settled).
-**Do not re-narrate any of them here.** **§1's updater row finally ran** (2026-09-09,
-... (lines 279-285) ...
-is still untested.**
+Release history is [CHANGELOG.md](CHANGELOG.md); remaining v1.0 work is
+[docs/roadmap.md](docs/roadmap.md#active--toward-v10); what release smoke runs have settled —
+including why a successful update leaves nothing in `tandem.log` — is in
+[docs/release-smoke-checklist.md](docs/release-smoke-checklist.md#what-the-v0250-run-settled).
 
 Core is complete — 28 active MCP tools (2 more ship dark), multi-doc tabs, CRDT-anchored annotations, chat, four
 push paths (self-armed wake, plugin monitor, opt-in channel shim, supervisor stdin),
 `.md`/`.txt`/`.html` (`.docx` ships dark), npm global install, Tauri desktop app.
 
-- **The acceptance harness runs in CI's `check` job (#1399).** `npm test` is vitest and the pre-push hook is biome + vitest + `cargo test`, ...
+- **The acceptance harness runs in CI's `check` job**; `npm run test:acceptance-harness` is the only other runner (neither `npm test` nor pre-push runs it). The step is deliberately unconditional — no `if:`, no `continue-on-error` on step or job, no `|| true` — and is preceded by `git fetch --no-tags --depth=1 origin tag v0.21.0`, because the harness reads its v9 skill baseline via `git show` and `actions/checkout` is shallow and tagless. `tests/scripts/acceptance-harness-wiring.test.ts` pins all of that, and `scripts/spikes/run_acceptance_tests.py` refuses `unittest`'s exit 0 on zero-collected or all-skipped. If you build an arming/dispatch check: the plugin arm reports its skill as `tandem:tandem` (an exact-name match scores every plugin session a decline), and a typed `/tandem` emits no `PreToolUse Skill` event (read `UserPromptExpansion` too).
+- **Required checks on `master`** (measured 2026-08-28; re-measure with `gh api repos/bloknayrb/tandem/branches/master/protection` if it decides something): `check`, the three `rust-test` legs and `windows-acl-proof`, with `strict: true` and `enforce_admins: true` — a red required check blocks everyone, Bryan included. `coverage` and CodeQL are advisory.
```
This needs a companion edit in `.claude/skills/release/SKILL.md`. Without it, the next release re-adds the stamp:
```diff
@@ -89,2 +89,2 @@
    deliberate prose naming the outgoing version as history (this skill's
-   header, CLAUDE.md's Status); and source comments, which the exclusions do
+   header); and source comments, which the exclusions do
@@ -246,3 +246,4 @@
-9. Update project memory: the CLAUDE.md **Status** section (what shipped in
-   this version) and the project memory SHIPPED entry (per the archive
-   rotation discipline).
+9. Update the project memory SHIPPED entry (per the archive rotation
+   discipline). CLAUDE.md carries no version stamp; edit its **Status**
+   section only if a flag flip, a dark system or a v1.0 blocker changed in
+   this release.
```

**H25 (F26), CLAUDE.md:241-242.** The pinned string `windows-acl-proof` is kept.
```diff
@@ -241,2 +241,2 @@
-- **Per-module coverage floors exist, and they are ADVISORY** — ...
-- **A Windows-gated spec that no Windows job runs is green forever, and reads exactly like a pass** (#1529). ...
+- **Per-module coverage floors are advisory.** `scripts/ci/coverage-policy.json` + `scripts/ci/coverage-gate.mjs` run in the `coverage` job, which is not a required check (#1728 holds the dated decision); what blocks is `tests/scripts/coverage-gate-wiring.test.ts` inside `check` — the [ADR-051](docs/decisions.md#adr-051-an-advisory-ci-jobs-guarantees-are-enforced-by-a-wiring-test-inside-check) pattern; read it before adding a gate. A `v8 ignore` comment shrinks the denominator, so one line clears a floor with no test written. A floor also does not detect deleted behaviour — removing a covered branch drops numerator and denominator together; the per-module `suite` path is what detects deletion.
+- **A Windows-gated spec that no Windows job runs is green forever and reads like a pass.** `check` is ubuntu-only, so `describe.skipIf(!WIN_ONLY)` blocks skip and vitest exits 0. The real-`icacls` specs run in the `windows-acl-proof` CI job, whose runner (`scripts/ci/windows-acl-proof.mjs`) refuses off Windows or without `icacls.exe` and requires each named Windows-gated `describe` to report ≥1 passed / 0 skipped / 0 failed (a whole-file check is defeated by a file that also holds a cross-platform describe). `tests/scripts/windows-acl-proof-wiring.test.ts` pins the job and makes any new real-`icacls` spec join the list.
```

**H26 (F7), CLAUDE.md:322**
```diff
@@ -322 +322 @@
-- **The pre-push hook runs biome + the full vitest suite + `cargo test`.** A fresh clone cannot push ...
+- **The pre-push hook runs biome, `npm run typecheck:tests`, the full vitest suite and `cargo test`.** A fresh clone cannot push until the Rust prerequisites are installed, and **any working-tree edit made while it runs is what gets tested.**
```

**H27 (F7), AGENTS.md:17**
```diff
@@ -17 +17 @@
-- Git hooks: `pre-commit` runs lint-staged (ESLint + Biome + a semantic-token scan); `pre-push` runs `biome check .`, the **full** Vitest suite, and `cargo test`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the one-time setup `cargo test` needs — a fresh clone cannot push without it.
+- Git hooks: `pre-commit` runs lint-staged (ESLint + Biome + a semantic-token scan); `pre-push` runs `biome check .`, `npm run typecheck:tests`, the **full** Vitest suite, and `cargo test`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the one-time setup `cargo test` needs — a fresh clone cannot push without it.
```

> **Not applied (md:H28, obsolete).** Same pre-#1521 rule as md:H5.

**H28 (F2), AGENTS.md:31**
```diff
@@ -31 +31 @@
-- **A new mutating MCP tool or `/api` route must join the license-gated set in both halves.** An MCP write bypasses the Hocuspocus read-only surface, so gating a route while leaving its MCP twin ungated is a hole. Only the MCP half is CI-enforced (`tests/server/license-gate-coverage.test.ts`); the `/api` half is review-only against the enumeration in [`CLAUDE.md` → Licensing gate](CLAUDE.md). Note the gate ...
+- **A new mutating MCP tool or `/api` route must join the license-gated set in both halves.** An MCP write bypasses the Hocuspocus read-only surface, so gating a route while leaving its MCP twin ungated is a hole. Both halves are CI-enforced by coverage tables — `tests/server/license-gate-coverage.test.ts` (MCP tools) and `tests/server/license-gate-api-coverage.test.ts` (`/api` routes) — and the prose list lives in [docs/licensing-explained.md](docs/licensing-explained.md#the-gated-set). Note the gate is applied two ways — a `licenseGateMiddleware` mount *and* direct in-handler `licenseGate()` calls — so grepping the middleware name alone under-reports it.
```

No hunks are proposed for F8 (needs Bryan's reconciliation of the register) or the low-confidence flags F31-F33.

#### 3. Overall assessment

The rules in CLAUDE.md are sound and should stay inline. They are the silent-failure kind its header describes, and the six tests that read the file mostly enforce agreement with the code rather than freezing wording. The defects are of two kinds:
- **Stale facts.** Seven claims are contradicted by the repo, and two "open" security findings have since been closed on GitHub.
- **Accretion.** After a 35 KB rewrite on 2026-08-18 the file grew back to 73 KB in five weeks, mostly as issue lineage, migration-relative phrasing ("now", "no longer", "until #NNNN") and heavy emphasis around rules that are unchanged.

AGENTS.md has one real conflict: it says the `/api` half of the license gate is review-only, which has been false since 2026-09-08. It also has one omission: the pre-push typecheck.

Applying H1-H26 shrinks CLAUDE.md by about 18-20 KB (to roughly 53-55 KB, a 25-27% cut) without dropping any rule, renumbering any Critical Rule, or breaking any pinned assertion. Taking the stronger option on H20 (pointer plus test change) saves about 1.6 KB more. Going further, toward the "lightweight CLAUDE.md" target, would mean moving the Gotchas subsections into `docs/gotchas.md` behind one-line pointers. That conflicts with the file's own design choice to keep silent-failure rules inline, so it is the owner's decision rather than an audit fix.

Three things need attention whichever hunks are taken:
- `docs/security.md` must be reconciled against the tracker (F8).
- The release skill's step 9 must change along with H24.
- The out-of-slice `docs/architecture.md:657` heading contradicts Rule 6.


---

### Slice: MCP tool descriptions (Group 3) and local-model tools

#### Inventory and size

- **33 tools in source:**
  - `document.ts`: 14
  - `annotations.ts`: 10
  - `awareness.ts`: 3
  - `navigation.ts`: 3
  - `diagnostics.ts`: 1
  - `docx-apply.ts`: 2
- **Dark tools:** `tandem_convertToMarkdown` and `tandem_applyChanges` are registered only when `docxEnabled()` is true. That is correct.
- **Deprecated stubs:** the three stubs are registered unconditionally.
- **Size:** about 10.2k characters of tool descriptions, 5.6k of parameter descriptions and 3.8k of output-schema text. That is about 5k tokens in total.
- **Deferred loading:**
  - Claude Code already defers MCP tools behind tool search, so no server change is needed there.
  - Claude Desktop loads every tool definition up front, which makes trimming the stubs (H17) the lever on the server side.
- **Earlier audit:** `docs/reviews/2026-09-03-prompt-audit-diff.md` M2–M6 is already applied, and nothing here conflicts with it.

#### Findings

| # | Location | Tool | Evidence | Pattern | Why | Conf. | Action | Test pins |
|---|---|---|---|---|---|---|---|---|
| H1 | document.ts:505, 508-511 | tandem_open | "Clears annotations and session." / "#477 removed browser auto-open… `show_main_window`" | G3 contract mismatch; G1d history; under-described | Since #1813, annotations are re-merged and re-anchored, and what is lost is unsaved edits. The model cannot act on "#477" or `show_main_window`. The description omits the absolute-path requirement (`INVALID_PATH`), that the file must exist, that an already-open file just switches tabs, and that `.html` opens read-only. | High | rewrite | none |
| H2 | document.ts:1327-1329 | tandem_save | "the save is REFUSED and a conflict is reported instead" | G3 contract mismatch | `FILE_MODIFIED`, `SOURCE_MISSING`, `SAVE_IN_PROGRESS`, read-only and `.html` all return success with `saved:false` and a `reason`. That is pinned in html-read-only.test.ts:283-299. Only `EXTERNAL_CONFLICT` is an error. | High | rewrite | none |
| H3 | document.ts:1460 | tandem_save (error text) | "discards the unsaved edits (and annotations)" | G3 contract mismatch | The same stale `force` claim. | Medium | rewrite | none |
| H4 | document.ts:705, 711-713, 718-723 | tandem_edit | "newlines in newText are inserted as literal text" vs newText "(single paragraph — no newlines)" | G3 contract mismatch; under-described | `.txt` refuses a newline with `INVALID_ARGUMENT`, and the description contradicts its own parameter. Undocumented: point insert, heading start/end/interior, nested-block refusal, the multi-block merge, a `textSnapshot` refused on a point insert, `READ_ONLY`, `EMPTY_DOCUMENT`. | High | rewrite | none |
| H5 | navigation.ts:222-225 | tandem_search | "Search for text in the document. Returns matching positions." | G3 under-described | Search is case-insensitive (the `gi` flag) in both modes. Also undocumented: the 10,000-match cap, the ~2 s regex deadline with `truncated`, `FORMAT_ERROR`, `SEARCH_BUSY`. | High | rewrite | docs/mcp-tools.md:972 mirror (unpinned) |
| H6 | navigation.ts:286-289 | tandem_resolveRange | "Safer than raw character offsets under concurrent editing." | G3 under-described or misleading | Matching is literal and **case-sensitive**, with an NBSP-normalised fallback, and a miss returns `INVALID_RANGE` with a count. The returned range is point-in-time; the safety comes from `textSnapshot`. | High | rewrite | none |
| H7 | annotations.ts:715 | tandem_exportAnnotations | "Export all annotations as a review summary" | G3 contract mismatch | It filters with `isClaudeFacing` and the Solo `hideFromAI`, reports `privateExcluded` and `heldFromExport`, and refuses upload and scratchpad documents. | High | rewrite | docs/mcp-tools.md:859 mirror |
| H8 | annotations.ts:591-594 | tandem_removeAnnotation | "Refuses to remove user notes … private per ADR-027." | G3 understatement; G1d | The guard is `isWithheldFromClaude`, so it also refuses private comments and user highlights. "ADR-027" means nothing to the model. | Medium | rewrite | none |
| H9 | annotations.ts:286-290 | tandem_comment | "Add a comment to a text range…"; from "Start position" | G3 under-described | It does not name the coordinate system, the heading-endpoint rule, the suggestion-only interior rule, or the return value. | High | rewrite | none |
| H10 | annotations.ts:295-298, 317, 325-329 | tandem_comment `directedAt` | "Deprecated — pass omitted; including this field returns DEPRECATED." | G3 "don't expose what is invalid" | The parameter is advertised only so that it can be refused. | Medium | remove | delete edit-annotation.test.ts:290-301 |
| H11 | annotations.ts:425 | tandem_getAnnotations | "(ADR-027)… (#1619/#1710)…" | G1d; under-described | Issue numbers are archaeology. Missing: the Solo hold of the user's own records, and the `anchor` field (`degraded` or `failed`). | Medium | rewrite | none |
| H12 | annotations.ts:518 | tandem_resolveAnnotation | "cannot be transitioned at all (ADR-027)" | G1d | Also refuses user highlights. | Medium | rewrite | none |
| H13 | annotations.ts:640, 645 | tandem_editAnnotation | "NOT_OWNED (#1770)… (ADR-027)"; reason "Alias for content (legacy compat)" | G1d; migration-relative | Omits `ANNOTATION_RESOLVED` and the `newText` heading refusal. | Medium | rewrite | none |
| H14 | annotations.ts:1002-1006 | tandem_annotationReply | "NOT_OWNED (#1770)… (ADR-027)" | G1d | Issue numbers. The private-record refusal code is not stated. | Medium | rewrite | none |
| H15 | awareness.ts:412 | tandem_checkInbox | "(#1619/#1710)… (#1997)" | G1d; under-described | The scope is undocumented. The annotation buckets cover the target document only, but `chatMessages` is every unread chat message across all documents, and returning it marks those messages read. The Solo hold is not stated. | Medium | rewrite | none |
| H16 | docx-apply.ts:602-603 | tandem_restoreBackup | "reloads the open document in place — annotations are preserved" | G3 under-described (destructive) | Restore also overwrites the file on disk and discards unsaved edits. It is refused for read-only, upload and scratchpad documents. | Medium | rewrite | docs/mcp-tools.md mirror |
| H17 | annotations.ts:150-162, 258-282, 373-419 | highlight / suggest / flag stubs | "DEPRECATED…" | G3 structural: invalid tools exposed | They are registered and license-gated, can only fail, and cost tokens on every request in clients that load everything up front. Trade-off: an old installed skill gets "unknown tool" instead of a toast. | Medium | remove | tool-count-drift.test.ts (`DEPRECATED_STUBS`, count sentence); docs/mcp-tools.md count + stub sections; the CLAUDE.md "33 MCP tools (28 active, 2 shipped dark, 3 deprecated stubs)"; license-gate-coverage.test.ts:59-61; mcp-tool-integration.test.ts:662-667; comments in range-bounds-validation.test.ts:16 and channel-projection-characterization.test.ts:239; with H10, check whether the `DEPRECATED` code becomes unused (ToolErrorCodeSchema, mcp-tools.md Error Codes, tool-error-codes-claims.test.ts) |
| H18 | document.ts:1491-1494 | tandem_status | "Read editor status (no params) or set your visible status text" | G3 under-described | Read mode returns `mode`, open documents with `readOnly`, and `wakeUrl`. The server instructions depend on that `wakeUrl`. | Medium | rewrite | none |
| H19 | document.ts:1592 | tandem_close | "Close a document." | G3 under-described (data loss) | Close does not save, and a scratchpad's content is lost. | Medium | rewrite | docs/mcp-tools.md:510 mirror |
| H20 | output-schemas.ts:50, 181, 232, 237, 303, 324 | output text | "(#1733)", "(ADR-027, #1619/#1710)", "(#1997)" | G1d history | Issue numbers reach the model through `outputSchema`. | Medium | rewrite | none |
| H21 | local-model/tools.ts:140-150 | reply_to_annotation (Ollama) | "Reply to an existing pending comment thread by its annotation id." | Contract mismatch | User-authored parents are refused with `NOT_OWNED`. The shared refusal text names tools the local model does not have. | Medium | rewrite the description; **flag** `describeReplyWriteRefusal` (a code change) | none |
| L | local-model/tools.ts:86-95, 118-121, 82 | read_section / propose_replacement / get_outline | "exact heading text" / "Single paragraph only." / "Use this first on long documents." | Contract nits; unknown model | Matching is case-insensitive; one rule is unenforced; one line is strategy coaching. | Low | flag | — |
| L | awareness.ts:349-367 | tandem_getActivity | "Call it before annotating or editing near the user's cursor — … disruptive" | Steering | It states a reason and is a when-to-use, so it is acceptable. | Low | flag | — |
| L | document.ts:1323-1325; docx-apply.ts:527; navigation.ts:310-311; awareness.ts:597 | save (dark), applyChanges (dark), getContext params, reply | behavior smuggling / "EXPERIMENTAL." / "Start position" / brief | — | Minor. For getContext, add "(flat offset, as from tandem_getTextContent)". | Low | flag | — |

**`.docx`-dark constraint:** `tests/server/docx-ship-dark.test.ts:149-155` runs `/docx|\bWord\b/i` over every tool's JSON, so the standalone word "word" also fails. Every replacement below avoids it.

#### Proposed hunks (one finding per hunk)

**H1 — document.ts (tandem_open)**
```diff
-    "Open a file in the Tandem editor as a new tab; returns a documentId. Does NOT launch or focus the editor — #477 removed browser auto-open, and nothing here reaches the desktop window's `show_main_window`; the user sees the tab when they next look at an editor that is already running. force=true reloads from disk if the file changed externally.",
+    "Open an existing file in the Tandem editor as a tab and make it the active document; returns a documentId. filePath must be absolute (a relative path returns INVALID_PATH) and the file must already exist — this tool never creates one. Opening a file that is already open switches to its existing tab without reloading it; pass force=true to reload from disk. .html files open read-only (annotate them, don't edit). This does not launch, show or focus the editor window: the user sees the tab the next time they look at a running editor.",
@@
-        .describe("Force reload from disk even if already open. Clears annotations and session."),
+        .describe(
+          "Reload from disk even if already open, discarding unsaved in-memory edits and the session. Annotations are kept and re-anchored to the reloaded text; any whose text changed may be reported with anchor: \"degraded\" by tandem_getAnnotations.",
+        ),
```

**H2 — document.ts (tandem_save)**
```diff
-      "If the file changed on disk since it was opened " +
-      "the save is REFUSED and a conflict is reported instead; it is never silently overwritten. " +
-      "Uploaded (upload://) documents have no path, so the save is session-only.",
+      "Check `saved` in the result: it is true only when the file on disk was written. When the " +
+      "disk write is skipped the call still succeeds, with saved: false, a machine-readable " +
+      "`reason` and only the session saved — for example upload (an uploaded document has no " +
+      "path), read-only, UNSUPPORTED_FORMAT (e.g. .html), FILE_MODIFIED (the file changed on disk " +
+      "since Tandem last wrote it) or SAVE_IN_PROGRESS. A document with an unresolved external-change " +
+      "conflict returns an EXTERNAL_CONFLICT error instead. The file on disk is never silently overwritten.",
```

**H3 — document.ts:1460**
```diff
-… tandem_open with force: true reloads from disk and discards the unsaved edits (and annotations).`,
+… tandem_open with force: true reloads from disk and discards the unsaved edits (annotations are kept and re-anchored).`,
```

**H4 — document.ts (tandem_edit)**
```diff
-    "Edit text in the document at a specific range. For single-paragraph replacements only — newlines in newText are inserted as literal text.",
+    "Replace the text in [from, to) with newText. Offsets are flat offsets from tandem_getTextContent, " +
+      "tandem_search or tandem_resolveRange. from === to inserts newText at that point — the only way to " +
+      "insert mid-document. A range inside one block edits that block; a range spanning several top-level " +
+      "blocks merges them into one; a range crossing into a list, blockquote or table returns INVALID_RANGE " +
+      "naming the two ranges to edit separately. A range whose start, end or interior overlaps heading " +
+      "markup such as \"## \" returns INVALID_RANGE — split the edit at the heading. newText is inserted " +
+      "literally, never parsed as Markdown (use tandem_appendContent or tandem_editList for new block " +
+      "structure); a newline in it is refused with INVALID_ARGUMENT in a plain-text (.txt) document and " +
+      "otherwise becomes a line break inside the same paragraph. Returns READ_ONLY on a read-only document " +
+      "and EMPTY_DOCUMENT on an empty one.",
@@
-      from: z.number().int().describe("Start position (character offset)"),
-      to: z.number().int().describe("End position (character offset)"),
-      newText: z.string().describe("Replacement text (single paragraph — no newlines)"),
+      from: z.number().int().describe("Start offset (flat text, inclusive)"),
+      to: z.number().int().describe("End offset (flat text, exclusive); equal to from for a point insertion"),
+      newText: z.string().describe("Replacement text, inserted literally"),
@@
-          "Expected text at [from, to] — returns RANGE_MOVED with relocated range on mismatch, or RANGE_GONE if text was deleted",
+          "Expected text at [from, to) — returns RANGE_MOVED with relocated range on mismatch, or RANGE_GONE if text was deleted. Omit for a point insertion (from === to); it is refused there.",
```

**H5 — navigation.ts (tandem_search)**
```diff
-      description: "Search for text in the document. Returns matching positions.",
+      description:
+        "Find every occurrence of query in the document's flat text (the tandem_getTextContent " +
+        "coordinate system) and return each match's [from, to) range and matched text. Matching is " +
+        "case-insensitive in both literal and regex mode; use tandem_resolveRange for an exact-case " +
+        "match. Results stop at 10,000 matches, and a regex search stops after about two seconds; " +
+        "either way the result carries truncated: true with the matches found so far, so do not treat " +
+        "it as complete. An invalid or oversized query returns FORMAT_ERROR; SEARCH_BUSY means too " +
+        "many regex searches are running — retry shortly.",
@@
-        regex: z.boolean().default(false).describe("Treat query as regex"),
+        regex: z.boolean().default(false).describe("Treat query as a JavaScript regular expression (matched case-insensitively)"),
```

**H6 — navigation.ts (tandem_resolveRange)**
```diff
-    "Find text and return a valid range. Safer than raw character offsets under concurrent editing.",
+    "Return the flat [from, to) range and text of the Nth occurrence of a literal string, ready to " +
+      "pass to tandem_edit or tandem_comment. Matching is literal and case-sensitive; if nothing " +
+      "matches exactly, it retries treating non-breaking spaces as ordinary spaces. A miss returns " +
+      "INVALID_RANGE with the total number of occurrences found. The range describes the document at " +
+      "call time — pass the returned text as textSnapshot on the follow-up call to detect concurrent edits.",
     {
-      pattern: z.string().describe("Text to find"),
-      occurrence: z.number().optional().describe("Which occurrence (1-based, default 1)"),
+      pattern: z.string().describe("Literal text to find (not a regex; case-sensitive)"),
+      occurrence: z.number().optional().describe("Which occurrence to return, 1-based (default 1)"),
```

**H7 — annotations.ts:715 (tandem_exportAnnotations)**
```diff
-    "Export all annotations as a review summary (markdown or json). writeToDisk:true also writes a sharable sidecar file (e.g. `<doc>.annotations.json`) next to the document.",
+    "Export the annotations you can see as a review summary (markdown by default, or json) — the same records tandem_getAnnotations returns. User notes and other private records are left out, as are the user's annotations held back in solo mode; privateExcluded and heldFromExport report how many were withheld. writeToDisk: true also writes the export to a sidecar file next to the document (`<file>.annotations.md|json` by default), overwriting any existing one; uploaded and scratchpad documents have no location for it and return INVALID_PATH.",
```

**H8 — annotations.ts:593-594 (tandem_removeAnnotation)**
```diff
-      "prefer resolve unless the annotation should leave no trace. Refuses to remove user notes " +
-      '(type: "note"), which are private per ADR-027. There is no undo.',
+      "prefer resolve unless the annotation should leave no trace. Records private to the user — " +
+      "notes, private comments and the user's highlights — are refused with INVALID_ARGUMENT. " +
+      "There is no undo.",
```

**H9 — annotations.ts (tandem_comment)**
```diff
-    "Add a comment to a text range. Optionally include suggestedText for a replacement proposal.",
+    "Attach a comment to the flat range [from, to) (offsets from tandem_getTextContent, tandem_search " +
+      "or tandem_resolveRange); returns the annotationId. The user sees it as a card in the editor and " +
+      "accepts or dismisses it. Add suggestedText to make it a replacement proposal the user can accept. " +
+      "A range whose start or end falls inside heading markup such as \"## \" returns INVALID_RANGE. A " +
+      "plain comment may span headings, but a range carrying suggestedText may not contain heading " +
+      "markup anywhere, because accepting it would delete the heading.",
     {
-      from: z.number().int().describe("Start position"),
-      to: z.number().int().describe("End position"),
+      from: z.number().int().describe("Start offset (flat text, inclusive)"),
+      to: z.number().int().describe("End offset (flat text, exclusive)"),
```

**H10 — annotations.ts (remove `directedAt`)**
```diff
-      directedAt: z
-        .enum(["claude"])
-        .optional()
-        .describe("Deprecated — pass omitted; including this field returns DEPRECATED."),
@@
-        directedAt,
@@
-          if (directedAt !== undefined)
-            return mcpError(
-              "DEPRECATED",
-              "directedAt is no longer supported — comments now always reach the connected AI client. Drop the field from your call.",
-            );
```
Also delete tests/server/edit-annotation.test.ts:290-301. Zod's default strip mode then silently ignores a stale field.

**H11 — annotations.ts:425 (tandem_getAnnotations)**
```diff
-        'Read annotations, optionally filtered by author/type/status. User notes are always excluded — they are private (ADR-027); notesExcluded reports how many were filtered, including imported comments awaiting user promotion (promoted ones surface as user comments). Every record whose stored audience is not outbound is excluded too and counted in privateExcluded (#1619/#1710) — user highlights are always private, so type: "highlight" returns nothing. For new user actions, prefer tandem_checkInbox.',
+        'Read the annotations on a document, optionally filtered by author/type/status, each comment with its visible replies. Only records shared with you are returned. User notes are private and excluded, counted in notesExcluded (including imported comments awaiting user promotion; promoted ones surface as user comments). Every other record the user has not shared is excluded too and counted in privateExcluded — user highlights are always private, so type: "highlight" returns nothing. In solo mode the user\'s own annotations and replies are also held back. A record whose anchor no longer matches its text carries anchor: "degraded" or "failed". For only what is new since your last poll, use tandem_checkInbox.',
```

**H12 — annotations.ts:517-518 (tandem_resolveAnnotation)**
```diff
-      "Only pending annotations can transition, and private notes and comments cannot be " +
-      "transitioned at all (ADR-027). The record is kept either way — use " +
+      "Only pending annotations can transition, and records private to the user (notes, private " +
+      "comments, user highlights) cannot be transitioned at all. The record is kept either way — use " +
```

**H13 — annotations.ts:640, 645 (tandem_editAnnotation)**
```diff
-    "Edit the content of an annotation Claude authored. Use newText to update replacement text, reason/content for the comment body. Only pending annotations can be edited, and a user-authored or imported record is refused with NOT_OWNED (#1770) — private notes and private comments are refused ahead of that (ADR-027).",
+    "Edit a pending annotation Claude authored: content replaces the comment body, newText sets or replaces its suggestedText. A user-authored or imported record returns NOT_OWNED; an accepted or dismissed one returns ANNOTATION_RESOLVED; a private record, or a newText whose range overlaps heading markup, returns INVALID_ARGUMENT.",
@@
-      reason: z.string().optional().describe("Alias for content (legacy compat)"),
+      reason: z.string().optional().describe("Same as content; content wins if both are passed"),
```

**H14 — annotations.ts:1002-1006 (tandem_annotationReply)**
```diff
-    "Reply to a thread on an annotation Claude authored. Only works on pending annotations. " +
-      "A user-authored or imported record — including a promoted note or imported comment, which is " +
-      "stored as a user comment — is refused with NOT_OWNED (#1770); answer in chat with " +
-      "tandem_reply, or leave a fresh tandem_comment. Private notes and private comments are " +
-      "refused ahead of that (ADR-027).",
+    "Reply in the thread of a pending annotation Claude authored (ANNOTATION_RESOLVED once it is " +
+      "accepted or dismissed). A user-authored or imported record — including a promoted note or " +
+      "imported comment, which is stored as a user comment — returns NOT_OWNED; answer it in chat with " +
+      "tandem_reply, or leave a fresh tandem_comment. Private notes and private comments return " +
+      "INVALID_ARGUMENT.",
```

**H15 — awareness.ts:412 (tandem_checkInbox).** Change two clauses and add one sentence. The text shown as "…" is unchanged.
```diff
-…Does not return user notes (`type: "note"`), nor any record whose stored `audience` is not outbound (#1619/#1710) — user highlights are always private, so they never appear here at all. `activity.selectedText`…For a document not shown in an editor nothing updates the record, so after an edit `selectedText` can be sliced from stale offsets (#1997).',
+…Does not return user notes or any other record the user has kept private — user highlights never appear here at all. Comments, replies and accept/dismiss responses cover the target document only; `chatMessages` holds every unread user chat message across all documents (each carries its documentId), and returning them marks them read. In solo mode the user\'s comments and replies are held back until the mode returns to tandem. `activity.selectedText`…For a document not shown in an editor nothing updates the record, so after an edit `selectedText` can be sliced from stale offsets.',
```

**H16 — docx-apply.ts:602-603 (tandem_restoreBackup)**
```diff
-      "Restoring " +
-      "reloads the open document in place — annotations are preserved and re-anchored.",
+      "Restoring overwrites the file on disk with the snapshot and reloads the open document in " +
+      "place, discarding unsaved in-memory edits; annotations are preserved and re-anchored. Refused " +
+      "for read-only, uploaded and scratchpad documents.",
```

**H17 — annotations.ts: remove the deprecated stubs.**
- Delete `tandem_highlight` (:258-282), `tandem_suggest` (:373-397) and `tandem_flag` (:399-419).
- Delete `notifyDeprecatedTool` (:150-162) once nothing calls it.
- In tool-count-drift.test.ts, set `DEPRECATED_STUBS = []` and drop the "every named deprecated stub" test.
- Change the count sentence in docs/mcp-tools.md and CLAUDE.md to say 30 in source: 28 active and 2 shipped dark.
- Remove the stub rows from license-gate-coverage.test.ts:59-61 and the stub cases from mcp-tool-integration.test.ts:662-667.

**H18 — document.ts:1491-1492 (tandem_status)**
```diff
-        "Read editor status (no params) or set your visible status text (pass text), shown in the editor's status bar.",
+        "Read or set editor status. Without `text`: returns the collaboration mode (\"solo\" means hold annotations, \"tandem\" means surface them), the active document, every open document with its readOnly flag, and wakeUrl (absent when no wake transport is running). With `text`: shows it as your status in the editor's status bar for the target document; focusParagraph/focusOffset optionally place your presence marker. A status is not a chat message — use tandem_reply to talk to the user.",
```

**H19 — document.ts:1592 (tandem_close)**
```diff
-    "Close a document. Closes the active document if no documentId specified.",
+    "Close a document's tab (the active document when documentId is omitted); another open document becomes active. Closing does not save: edits not yet written by tandem_save or autosave are discarded, and a scratchpad's content is gone. Annotations on an on-disk file are kept and return when it is reopened.",
```

**H20 — output-schemas.ts**
```diff
-    .describe("Read mode: who last wrote the mode key, when, and what it read then (#1733)"),
+    .describe("Read mode: who last wrote the mode key, when, and what it read then"),
@@
-      "How many non-note records were filtered out because their stored audience is not outbound — user highlights included (ADR-027, #1619/#1710); omitted when zero",
+      "How many non-note records were filtered out because the user has not shared them — user highlights included; omitted when zero",
@@
-    "Who last wrote the mode key, when, and what it read then; null before any write is observed (#1733)",
+    "Who last wrote the mode key, when, and what it read then; null before any write is observed",
@@
-…so after an edit it can be sliced from stale offsets: text the user never selected (#1997).",
+…so after an edit it can be sliced from stale offsets: text the user never selected.",
```
Also drop "(ADR-027)" at :50 and :232.

**H21 — local-model/tools.ts:142**
```diff
-    description: "Reply to an existing pending comment thread by its annotation id.",
+    description:
+      "Reply to a pending comment thread you or another AI authored, by its annotation id. Comments written by the user cannot be replied to (NOT_OWNED); leave a new comment_on_quote instead.",
```


---

### Slice: shipped `skills/tandem/SKILL.md`, server instructions, wake text, supervisor turns and channel shim

`SERVER_INSTRUCTIONS` (server.ts:233-243), `WAKE_ADVISORY_TEXT`, and `SUPERVISOR_INITIAL_PROMPT` / `SUPERVISOR_WAKE_PROMPT` (`src/shared/launcher/contract.ts`) are clean: lean, reasoned and pinned contracts. I left the frontmatter `description` alone because it is calibrated trigger text that a test pins and acceptance runs measure (Group 3 split).

#### Findings

| # | Location | Evidence | Pattern | Why | Conf. | Action | Test pins |
|---|---|---|---|---|---|---|---|
| F1 | SKILL.md:27 | "destructively, wiping the whole document's annotations including private notes you cannot see, ADR-027" | G2 stale fact | Since #1813 the envelope is flushed, re-merged and re-anchored. What is actually lost is unsaved edits. The prohibition stays and only its reason changes. | High | rewrite (proposed only; the edit is to a prohibition's reason) | skill-instruction-contract.test.ts:339-341 still passes |
| F2 | SKILL.md:182 | "For `tandem_comment` / `tandem_suggest` / `tandem_flag`, `from === to` is `empty`" | G2 stale; G3 dangling tool name | Both stubs always return `DEPRECATED` and never validate a range. | High | rewrite | none |
| F3 | src/channel/run.ts:62-63 | "Event types: annotation:created, … document:switched." | G2 stale | `annotation:edited` is missing, though it is in the `TandemEvent` union and is forwarded by event-bridge. | High | rewrite | none |
| F4 | src/channel/run.ts:68 | "call tandem_checkInbox as a fallback" | G2 conflict | Contradicts server.ts:235 ("the authority") and SKILL.md:90/95. The server.ts text is newer (fcade54a4, 2026-08-11). | Medium | rewrite | none |
| F5 | SKILL.md:90 | "**Call `tandem_checkInbox` every 2-3 tool calls** … When in doubt, poll." | 1b/1f fixed cadence; 1a "if in doubt" | A numeric cadence gets followed literally. The real contract is the editor's ~2-minute stall banner (`DELIVERY_STALL_MS`). Polling itself is load-bearing and stays. | Medium | rewrite | none directly; rationale comments in delivery-stall.ts:28-30, wake-advisory.ts:30-31 and wake-url.ts:17 cite "2–3 tool calls" |
| F6 | SKILL.md:115 | "Keep polling every 2-3 tool calls regardless" | 1f second instance | Must change together with F5. | Medium | rewrite | skill-instruction-contract.test.ts:173 |
| F7 | SKILL.md:67 | User-comment paragraph sends the model to `tandem_annotationReply`, then says that call refuses user-authored parents | 1d patch accretion / internal contradiction | The refusal half was spliced in later without rewriting the opening. | Medium | rewrite | the "idempotent" regex (:347-349) still matches |
| F8 | SKILL.md:33-42 | "Standard workflow: 1. … 7. Repeat steps 3-6 …" | 1c step choreography | Only one ordering is real: know `mode` before annotating. | Medium | rewrite as prose that keeps the order constraint | :196-199 pins kept verbatim |
| F9 | SKILL.md:189-197 | Session Handoff five-step list | 1c | Orientation judgement written as a script. | Medium | rewrite | setup.test.ts:1097 needs the "Session Handoff" heading (kept) |
| F10 | SKILL.md:203-213 | Project-context three-step script with fixed user wording | 1c | The author-only facts are kept. | Medium | rewrite | none |
| F11 | SKILL.md:137-141 | "over direct HTTP … which is why this needs saying rather than being obvious (#1463)" | G2 history; stale | The plugin route uses a stdio bridge. | Medium | rewrite | none |
| F12 | SKILL.md:175-176 | "matches what the stdio bridge (`src/cli/mcp-stdio.ts`) already returns…" | G2 maintainer note in a shipped skill | Users have no source tree, and the claim is inexact anyway. | Medium | remove | none |
| F13 | SKILL.md:14 | "> **Scope:** … **Claude is the default integration** per ADR-038…" | G2 maintainer meta | Nothing in it is actionable for the model reading it. | Medium | remove | none |
| F14 | SKILL.md:20 | "Follow them always." | 1a booster | Adds register, not content. | Medium | rewrite | heading kept |
| F15 | SKILL.md:130-131 | "the file is untouched until someone saves" | G2 stale | `.md` and `.txt` autosave every 60 s. | Medium | rewrite | none |
| L | SKILL.md:26, 105, 113, 103, 168, 29, 182 | Rule 5 repeats Rule 4; example URL in the "don't guess" paragraph; meta sentence; external Claude Code claims; "the whole set" of failure causes; "this version"; duplicate textSnapshot rule | various | The copies agree (keep-list item 8), the external claims need human evidence, and one is a prohibition. | Low | flag | — |
| L | contract.ts:310-312 | "do NOT arm a Monitor watch … it would double every wake" | 1a caps; re-insertion | Reasoned and load-bearing: it must survive compaction. Keep. | Low | flag | stream-json-protocol.test.ts:1380-1402 |
| L | server.ts:235; run.ts:65 | "Always treat … as the authority"; tool names in channel instructions | 1a; G3 | A factual contract, kept within the 2 KB budget. | Low | flag | mcp-server-instructions.test.ts |

#### Proposed hunks

**Version bump (required with any SKILL.md body hunk)**
```diff
--- a/skills/tandem/SKILL.md
-version: 27
+version: 28
--- a/tests/skill-instruction-contract.test.ts
-  expect(skill).toMatch(/^version:\s*27$/m);
+  // 28 is the prompt-audit group: the polling cadence became "between steps" here and in
+  // Collaboration Etiquette; the rest is outside the wake section.
+  expect(skill).toMatch(/^version:\s*28$/m);
@@
-    ).toEqual({ version: "27", bodyHash: "d43a4b79ffe5" });
+    ).toEqual({ version: "28", bodyHash: "<recompute after choosing hunks: run the test, copy the reported hash>" });
```

**F1 (proposed only; the prohibition is unchanged).** Replace the parenthetical inside Hard Rule 6:
```diff
-… `tandem_open({ force: true })` also clears it, but destructively, wiping the whole document's annotations including private notes you cannot see, ADR-027 — so never call it on your own initiative, ask the user first); …
+… `tandem_open({ force: true })` also clears it, but destructively: it throws away the session's unsaved edits and reloads from disk, and any annotation whose text moved comes back degraded — so never call it on your own initiative, ask the user first); …
```

**F2**
```diff
-… For `tandem_comment` / `tandem_suggest` / `tandem_flag`, `from === to` is `empty` on its own, since an annotation needs a span to anchor to. …
+… For `tandem_comment`, `from === to` is `empty` on its own, since an annotation needs a span to anchor to. …
```

**F3 — src/channel/run.ts**
```diff
-        "Event types: annotation:created, annotation:accepted, annotation:dismissed, annotation:reply,",
-        "chat:message, document:opened, document:closed, document:switched.",
+        "Event types: annotation:created, annotation:accepted, annotation:dismissed, annotation:edited,",
+        "annotation:reply, chat:message, document:opened, document:closed, document:switched.",
```

**F4 — src/channel/run.ts:68**
```diff
-        "If you haven't received channel notifications recently, call tandem_checkInbox as a fallback.",
+        "Push is best-effort and can drop events; tandem_checkInbox is the authority on user activity, so keep polling it between steps.",
```

**F5 — SKILL.md:90**
```diff
-- **Call `tandem_checkInbox` every 2-3 tool calls** (orchestrator only in a multi-agent workflow), not just at the end of a task. You cannot tell from your side whether real-time push is reaching you — the channel is often not connected, and Tandem can only tell you when *nothing at all* is subscribed, not whether the thing that is subscribed reaches you — so steady polling is the reliable path, always. It's cheap: repeat polls de-duplicate against what you've already been shown, so frequent calls don't double-report. An item that also went out as a real-time push carries `alreadyPushed: true` and still appears — the server can't confirm a push reached you, so it shows you everything rather than risk dropping it. See "User comments" above before acting on a flagged item twice. When in doubt, poll.
+- **Check `tandem_checkInbox` between steps while you work** (orchestrator only in a multi-agent workflow), not just at the end of a task. You cannot tell from your side whether real-time push is reaching you — the channel is often not connected, and Tandem can only tell you when *nothing at all* is subscribed, not whether the thing that is subscribed reaches you — so polling is the reliable path. If a user's message sits unpolled for about two minutes, the editor tells them it is still waiting. Polls are cheap: repeat polls de-duplicate against what you've already been shown, so frequent calls don't double-report. An item that also went out as a real-time push carries `alreadyPushed: true` and still appears — the server can't confirm a push reached you, so it shows you everything rather than risk dropping it. See "User comments" above before acting on a flagged item twice.
```

**F6 — SKILL.md:115 and its pin**
```diff
-… Keep polling every 2-3 tool calls regardless (orchestrator only in a multi-agent workflow).
+… Keep polling between steps regardless (orchestrator only in a multi-agent workflow).
--- a/tests/skill-instruction-contract.test.ts
-  expect(wake).toMatch(/Keep polling every 2-3 tool calls regardless/i);
+  expect(wake).toMatch(/Keep polling between steps regardless/i);
```

**F7 — SKILL.md:67**
```diff
-**User comments.** When scanning `tandem_checkInbox` or `tandem_getAnnotations`, user-authored `type: "comment"` annotations are the ones you should respond to. A reply **on the annotation thread itself** goes through `tandem_annotationReply` — that's what keeps the reply visible on the thread rather than only in chat. Reserve `tandem_reply` for chat messages, and a fresh `tandem_comment` for a new textual annotation on different text. `tandem_annotationReply` refuses a resolved, note (ADR-027), highlight, private (non-outbound), or **user-authored** parent — fall back to `tandem_reply` for those. So the reply tool is for continuing *your own* threads; a user comment is answered in chat or with a new comment of your own. A reply may also carry `suggestedText`: …
+**User comments.** When scanning `tandem_checkInbox` or `tandem_getAnnotations`, user-authored `type: "comment"` annotations are the ones you should respond to. Answer one in chat with `tandem_reply`, or with a fresh `tandem_comment` of your own on the text you mean. `tandem_annotationReply` is for continuing *your own* threads — it keeps the reply on the thread rather than only in chat — and it refuses a resolved, note (ADR-027), highlight, private (non-outbound), or **user-authored** parent; fall back to `tandem_reply` for those. A reply may also carry `suggestedText`: …
```
The text after "A reply may also carry `suggestedText`:" is unchanged.

**F8 — SKILL.md:33-42**
```diff
-Standard workflow:
-
-1. `tandem_status` — check for already-open documents (sessions restore automatically) and read `mode` (see "Collaboration Mode"). Opening or creating one instead — `tandem_open`, or `tandem_scratchpad` for an ephemeral draft tab — reaches the same `wakeUrl` (see "Getting Woken While Idle"), so a task that starts by creating a document does not need a separate status call *to arm a watch*. It substitutes for nothing else in this step: neither response carries `mode`, and neither tells you what else is already open.
-2. `tandem_getOutline` — understand document structure
-3. `tandem_status({ text: "Working on [section]...", focusParagraph: N })` — show progress (use `index` from outline)
-4. `tandem_getTextContent({ section: "..." })` — read one section at a time
-5. Annotate or edit as needed (see annotation guide below) — **not before you know `mode`.** If no response this session has carried `mode`, call `tandem_checkInbox` now and read it from there.
-6. `tandem_checkInbox` — check for user messages and actions (orchestrator only in a multi-agent workflow)
-7. Repeat steps 3-6 for each section
-8. `tandem_save` — persist edits to disk when done
+Your first step is a read-mode `tandem_status`: it lists already-open documents (sessions restore automatically) and carries `mode` (see "Collaboration Mode"). Opening or creating a document instead — `tandem_open`, or `tandem_scratchpad` for an ephemeral draft tab — reaches the same `wakeUrl` (see "Getting Woken While Idle"), so a task that starts by creating a document does not need a separate status call *to arm a watch*. It substitutes for nothing else in this step: neither response carries `mode`, and neither tells you what else is already open.
+
+From there, work the way the task needs. `tandem_getOutline` gives the structure, `tandem_getTextContent({ section: "..." })` reads one section at a time, and `tandem_status({ text: "Working on [section]...", focusParagraph: N })` shows the user where you are (`N` is the outline's `index`). Annotate or edit as needed (see the Annotation Guide) — **not before you know `mode`.** If no response this session has carried `mode`, call `tandem_checkInbox` now and read it from there. Check the inbox between steps (orchestrator only in a multi-agent workflow), and `tandem_save` when your edits are done.
```

**F9 — SKILL.md:191-197**
```diff
-When starting a new Claude session with Tandem already running:
-
-1. `tandem_status()` — check `openDocuments` array for restored sessions
-2. `tandem_listDocuments()` — see all open docs with details
-3. `tandem_getOutline()` — orient on the active document
-4. `tandem_getAnnotations()` — see what was already reviewed
-5. Continue where the previous session left off
+When a new Claude session starts with Tandem already running, documents from earlier sessions are usually still open — sessions restore automatically. `tandem_status` lists them in `openDocuments` (`tandem_listDocuments` gives more detail), and `tandem_getAnnotations` shows what was already reviewed, so you can continue where the previous session left off rather than starting over.
```

**F10 — SKILL.md:205-213**
```diff
-Tandem auto-launches you in a single working directory (the user's home by default, or whatever they configured under Settings → AI Assistant → Working directory). The document the user opens may live elsewhere — a different project, a different repo. When you're working on a file outside your launch cwd:
-
-1. **Read `<docDir>/CLAUDE.md`** if it exists — it's the project's own playbook.
-2. **Walk up** the directory tree from `<docDir>` looking for `CLAUDE.md`, `.claude/`, `README.md`, or `package.json`/`Cargo.toml`/`pyproject.toml` to identify the project root.
-3. **Surface a relaunch nudge** when you detect project-scoped Claude tools you can't load mid-session:
-   - `.claude/skills/`, `.claude/agents/`, `.claude/hooks/`, or a `.mcp.json` you haven't loaded
-   - Tell the user: *"I see project-specific Claude tools at `<path>`. I can't load them in this session — open the command palette and run `Relaunch Claude in this folder` if you'd like me to pick them up."*
-
-The user is in control: relaunch ends the current conversation, so only suggest it when the project-scoped tools materially change what you can help with.
+Tandem auto-launches you in a single working directory (the user's home by default, or whatever they configured under Settings → AI Assistant → Working directory), and the document the user opens may belong to a different project. When it does, read that project's own `CLAUDE.md` and identify its root before working. Project-scoped Claude tooling there — `.claude/skills/`, `.claude/agents/`, `.claude/hooks/`, or a `.mcp.json` — cannot be loaded mid-session; if it would materially change what you can help with, tell the user they can pick it up by running **Relaunch Claude in this folder** from the command palette. Relaunching ends the current conversation, so the choice is theirs.
```

**F11 — SKILL.md:137-141**
```diff
-**If this session has no `tandem_*` tools at all, do not work around it — read this.** Claude Code
-resolves `mcpServers.tandem` once at session start over direct HTTP, so the whole toolset is
-missing whenever that resolution did not produce a live connection. There is no failing tool call
-to read, because there is no tool — which is why this needs saying rather than being obvious
-(#1463).
+**If this session has no `tandem_*` tools at all, do not work around it — read this.** Claude Code
+connects to Tandem's MCP server once, at session start, so the whole toolset is missing whenever
+that connection was not made. There is no failing tool call to read, because there is no tool.
```

**F12 — SKILL.md:174-176**
```diff
-
-The wording above matches what the stdio bridge (`src/cli/mcp-stdio.ts`) already returns as JSON-RPC
-`-32000` for Claude Desktop and Cowork, so every integration says the same thing.
-
 ## Error Recovery
```

**F13 — SKILL.md:14**
```diff
-> **Scope:** This skill teaches Claude Code how to use Tandem effectively. Tandem's integration contract is MCP, and **Claude is the default integration** per [ADR-038](…). This skill is a Claude-Code-specific resource shipped via the npm `skills/` folder; other MCP clients receive the tool descriptions directly through MCP and don't need this file.
-
```

**F14 — SKILL.md:20**
```diff
-These prevent the most common failures. Follow them always.
+These prevent the most common failures.
```

**F15 — SKILL.md:130-131**
```diff
-- **Leave it to the user.** Annotations stay in the session; the file is untouched until someone saves.
-- **`tandem_save`** — writes your edits back to the file. On a read-only document it answers `saved: false` with a `reason` instead.
+- **Leave it to the user.** Annotations stay in the session and never reach the file.
+- **`tandem_save`** — writes your edits back to the file now (`.md` and `.txt` documents also auto-save periodically, so edits reach disk without it). On a read-only document it answers `saved: false` with a `reason` instead.
```

**Pins checked:** setup.test.ts:1093-1097 (the required headings are kept); wake-availability-claims, channel-shim-optin-claims and src-control-characters are unaffected.

**Live verification:** F5, F6 and F8 change text that dispatched sessions read, so the `/tandem` arming and polling acceptance run needs your hardware.


---

### Slice: `.claude/skills/*`, `.claude/agents/*`, `.claude/commands/diverge.md`

No file pins `model:`, `effort:` or `tools:`. Every finding is against Opus 5.5.

Git history is shallow: many lines blame to boundary commit `^41a6c5e0` (2026-08-10). For those, the direction of each conflict was taken from the code or from CLAUDE.md.

#### Findings

| # | Location | Evidence | Pattern | Why | Conf. | Action | Test pins |
|---|---|---|---|---|---|---|---|
| H1 | annotation-model-reviewer.md:23-24 | "`src/server/events/origins.ts` — canonical definition…"; "queue.ts … re-exports origin constants" | G2 volatile | That file does not exist. The constants and helpers live in `src/shared/origins.ts`, and queue.ts does not re-export them. | High | rewrite | none |
| H2a | annotation-model-reviewer.md:15 | "skips transactions with `MCP_ORIGIN` and `FILE_SYNC_ORIGIN`" | G2 volatile | `CHANNEL_SKIP` also skips internal, reload and mode-release, via `makePerKeyChangeObserver`. | High | rewrite | none |
| H2b | annotation-model-reviewer.md:45 | "Tombstone observer skips `file-sync / internal`" | G2 contradiction | sync.ts:268 records tombstones for ALL origins and calls that load-bearing (verified). Following the reviewer line would flag correct code. | High | rewrite | none |
| H3 | annotation-model-reviewer.md:46 | "accept a `wrap: (doc, fn) => void` parameter" | G2 contradiction | lifecycle.ts:1242-1256 rejected that shape in favour of a closed `actor` union. The current line approves the rejected design. | High | rewrite | none |
| H4 | annotation-model-reviewer.md:56-57 | "Each observer callback should `import { shouldSkipChannel }`" | G2 volatile | The annotations observer gets the check through `observers/factory.ts`. As written, the reviewer would raise a false flag. | High | rewrite | none |
| H5 | crdt-reviewer.md:32 | "`tandem_importAnnotations`" | G2 volatile | No such tool exists. | High | rewrite | none |
| H6 | crdt-reviewer.md:30-31 | "the stored range must be updated"; "must get it attached on first read" | G2 conflict with CLAUDE.md (#1764) | Gated on `storedRangeStillMatches`. The correct degraded no-write would be called a bug. | High | rewrite | none |
| H7 | security-reviewer.md:9 | "bound to 127.0.0.1 only" | G2 conflict | `TANDEM_BIND_HOST` can move the bind, and the open findings exist only under that bind. | High | rewrite | none |
| H8 | dev-server/SKILL.md:13 | "`freePort()` kills any existing process on :3478/:3479" | G2 volatile | Since #1758, a live Tandem makes startup **refuse** instead of being killed. | High | rewrite | none |
| H9 | e2e-debug/SKILL.md:21-47 | "Server bundle exists (E2E uses pre-built server, not tsx) / ls dist/client/index.html" | G2 volatile | Locally the server runs through tsx from source; `dist/server` is used only under CI, and the client is always Vite on :4573 (verified in playwright.config.ts). | High | rewrite | scripts/build-client.mjs:10 cites a section that is kept |
| H10 | e2e-debug/SKILL.md:59-65 | "Delete session directory: `%LOCALAPPDATA%\tandem\Data\sessions\`" | G2 contradiction, **destructive** | E2E uses an isolated `tandem-e2e-data` directory that is wiped on every run (verified). The named directory is the user's real store. | High | rewrite | none |
| H11 | e2e-debug/SKILL.md:70 | "Check CLAUDE.md Critical Rule #7 for the current testid list" | G2 conflict | Rule 7 contains no list; it points to the snapshot. | High | rewrite | none |
| H12 | e2e/SKILL.md:43 | "`accept-btn`, `dismiss-btn`" | G2 volatile | The snapshot has `accept-btn-{*}` and `dismiss-btn-{*}`. | High | rewrite | none |
| H13 | screenshots/SKILL.md:47-48 | "in `.agents/skills/screenshots/`" | G2 volatile | `.agents/` does not exist. | High | rewrite | none |
| H14 | ui-inspector/SKILL.md:122-123 | "compare the two element crops" | G2 conflict (same file) | Contradicts the newer "Pixels are OFF" (ffac22e7 is later than b0fd298d). | High | rewrite | none |
| H15 | diverge.md:2 + CLAUDE.md:83 | "~16 Agent calls" | G2 internal arithmetic | The steps spawn 6 + 1 + 3 = 10. | High | rewrite (paired) | none |
| H16 | diverge.md:132 | "counts against the 30-day kill gate" | G2 conflict | The same file (lines 149-180) and CLAUDE.md replaced it with the `via /diverge` review gate. | High | rewrite | none |
| H17 | release/SKILL.md:246-248 | "the CLAUDE.md **Status** section (what shipped in this version)" | G2 conflict | CLAUDE.md's "Do not re-narrate" is newer (e9e827ab vs e3b6eaff). **If you take CLAUDE.md H24, use its companion hunk instead.** | High | rewrite | none |
| H18 | changelog/SKILL.md:33-41 | "`chore` → **Maintenance**", "`docs` → **Documentation**", "`perf` → **Performance**" | G2 volatile | CHANGELOG.md uses `### Internal` 19 times and `Maintenance`/`Performance` 0 times. `Removed` is missing. | High | rewrite | none |
| M1 | agents/diverge-{regulator,speedrunner,biology,on-call,deletionist,future-self}.md | Identical "Hard rules" block and output skeleton; only "Your frame" differs; the copies have already drifted | **G4 redundant specialist sub-agents**; 1a ("**DO NOT** critique…") | One task with near-duplicate prompts that differ only in payload, and six roster entries in every session. The rule "Do not read CLAUDE.md" cannot be followed, as diverge.md:146 itself admits. | Medium | merge into one `diverge-generator` | No tests. Change together: diverge.md Step 2 + :146 and docs/architecture.md:1235. Dispatch is by `subagent_type` only. |
| M2 | crdt-reviewer.md:18, 20 | Functions attributed to `positions.ts` / `document-model.ts` | G2 volatile | They are implemented in `src/shared/positions/ydoc.ts`, and `resolveOffset` is an alias in `mcp/document.ts`. | Medium | rewrite | none |
| M3 | annotation-model-reviewer.md:21 | "`src/server/mcp/annotations.ts` — annotation CRUD" | G2 volatile | CRUD and the write guards live in `annotations/lifecycle.ts`, and `isClaudeFacing` in `projection.ts`. | Medium | rewrite/add | none |
| M4 | screenshots/SKILL.md:50-51 | "Neither pipeline drives the Tauri WebView" | G1d migration-relative | Only one pipeline exists now. | Medium | rewrite | none |
| M5 | dev-server/SKILL.md:65-69 | "restart just the server: 1. Stop… 2. Run… again" | G2 volatile | `tsx watch` restarts the server itself; only `/mcp` is needed. | Medium | rewrite | none |
| M6 | release/SKILL.md:9-12 | "Codifies the release sequence used from v0.14.3 onward…" | G2 history | — | Medium | remove | none |
| M7 | release/SKILL.md:122-125 | "This has now fired at three cuts…" | G2 history | The mechanism stays. | Medium | remove sentence | none |
| M8 | svelte-migration-reviewer.md:66, 77, 80 | "`:global(@keyframes fadeIn)`" | G2 API claim | Not valid Svelte syntax. The documented form is `@keyframes -global-name`. | Medium | rewrite | none |
| M9 | svelte-migration-reviewer.md:141 | "Start by reading the most recently modified `.svelte` files" | G1c choreography / scope | Overrides the scope the caller gives the agent. | Medium | rewrite | none |
| M10 | changelog/SKILL.md:51, 80-82 | "3–6 bullets … (≤20 words)"; "120 words is a runaway backstop" | G1f numeric ceilings | The format rule already exists. | Medium | rewrite | none |
| L1–L12 | e2e `fuser` on Windows; security-reviewer Host-header tension; "work through each focus area systematically"; release history paragraphs (they justify fragile steps); npm stage-publish date claim; svelte "destroyed component" claim; changelog "Going forward"; e2e phantom-tab line; diverge-critic paraphrase of Rule 3; annotation reviewer missing #1803 half; generators' unenforced no-read rule; gitignored `.claude/plans/` reference | various | — | Low | flag | release-ci-hygiene.test.ts:308-330 pins release step 7 (untouched) |

#### Proposed hunks

**H1 — annotation-model-reviewer.md:23-24**
```diff
-- `src/server/events/origins.ts` — canonical definition of `MCP_ORIGIN` and `FILE_SYNC_ORIGIN` constants (extracted to break circular dep)
-- `src/server/events/queue.ts` — wires observers, manages event queue; re-exports origin constants
+- `src/shared/origins.ts` — the origin constants, the six `withX` wrapper helpers, and the `shouldSkipChannel` / `shouldSkipDurableSync` skip-set predicates
+- `src/server/events/queue.ts` — wires observers, manages event queue
```

**H2a — :15**
```diff
-- The annotations observer in `src/server/events/observers/annotations.ts` skips transactions with `MCP_ORIGIN` and `FILE_SYNC_ORIGIN`, and filters notes structurally (only `type: "comment"` events reach the channel)
+- The annotations observer in `src/server/events/observers/annotations.ts` is built on `makePerKeyChangeObserver` (`observers/factory.ts`), which drops every origin in `shouldSkipChannel` — everything except `browser` — and it filters notes structurally (only `type: "comment"` events reach the channel)
```

**H2b — :45**
```diff
-- **Skip-set matrix:** channel event queue skips `mcp / file-sync / internal / reload` (only `browser` emits). Durable-sync observer skips `file-sync / internal`. Tombstone observer skips `file-sync / internal`. Picking the wrong helper is a silent bug.
+- **Skip-set matrix:** channel event queue skips `mcp / file-sync / internal / reload / mode-release` (only `browser` emits). Durable-sync observer skips `file-sync / internal`. The tombstone observer (`registerAnnotationObserver` in `src/server/annotations/sync.ts`) records deletes for **every** origin, file-sync included — a delete that misses the ledger is lost on the next snapshot, so an origin filter there is the bug. Picking the wrong helper is a silent bug.
```

**H3 — :46**
```diff
-- **Shared helpers** (e.g. `addReplyToAnnotation`) accept a `wrap: (doc, fn) => void` parameter — caller supplies `withMcp` or `withBrowser`. Verify the helper signature passes the wrapper through to the actual `transact`.
+- **Shared write helpers** in `src/server/annotations/lifecycle.ts` take a closed `actor` union (`"browser" | "mcp"`) and call `withBrowser` / `withMcp` by name — never a `(doc, fn) => void` wrapper callable. A helper that accepts a wrapper callable is the finding: `(_d, fn) => fn()` is an untagged write that `npm run audit:origins` cannot see.
```

**H4 — :56-57**
```diff
-- **Rule:** Channel-event observers (in `src/server/events/observers/`) must call `shouldSkipChannel(txn.origin)` and early-return when true. This skips mcp / file-sync / internal / reload, leaving only browser-origin writes to project to channel events.
-- **Check:** Each observer callback should `import { shouldSkipChannel } from "../../../shared/origins.js"` and use the predicate, not inline origin equality.
+- **Rule:** Channel-event observers (in `src/server/events/observers/`) must drop every origin in `shouldSkipChannel(txn.origin)` — mcp / file-sync / internal / reload / mode-release — leaving only browser-origin writes to project to channel events.
+- **Check:** An observer either is built on `makePerKeyChangeObserver` (`observers/factory.ts`, which applies `shouldSkipChannel` for it — the annotations observer does this) or calls `shouldSkipChannel` itself (awareness, ctrl-chat, ctrl-meta). Flag inline origin equality, or a `shouldSkip` override that narrows rather than widens the skip set.
```

**M3 — :21**
```diff
-- `src/server/mcp/annotations.ts` — annotation CRUD (create, resolve, edit, delete, reply); note filtering for MCP responses
+- `src/server/mcp/annotations.ts` — the MCP annotation tools; note filtering for MCP responses (`isClaudeFacing`)
+- `src/server/annotations/lifecycle.ts` — `AnnotationLifecycle` (create, editPending, transitionPending, remove, reply) and the ADR-027 write guards, plus the deliberately unguarded `removeAnnotationRecord` / `addUserReply`
+- `src/server/annotations/projection.ts` — `isClaudeFacing`, the read-side privacy predicate
```

**H5 — crdt-reviewer.md:32**
```diff
-- **Import/export round-trip:** All annotation creation paths must go through `anchoredRange()` to get both flat and CRDT ranges. Check `tandem_exportAnnotations`, `tandem_importAnnotations`, and `.docx` comment injection.
+- **Import/export round-trip:** All annotation creation paths must go through `anchoredRange()` to get both flat and CRDT ranges. Check `tandem_exportAnnotations` and `.docx` comment import/injection (`src/server/file-io/docx-comments.ts`).
```

**H6 — crdt-reviewer.md:30-31**
```diff
-- **Range staleness detection:** `refreshRange()` resolves `relRange` back to flat offsets. If the resolved range differs from stored flat `range`, the stored range must be updated on the Y.Map. Check that `textSnapshot` comparison detects drift correctly.
-- **Lazy relRange attachment:** Annotations without `relRange` (user-created, imported) must get it attached on first read via `refreshRange()`. Verify this writes to Y.Map inside a `withMcp` wrapper (ADR-031).
+- **Range staleness detection:** `refreshRange()` resolves `relRange` back to flat offsets and writes a changed flat `range` to the Y.Map — except a collapse (live anchors resolving to `from === to` over a non-empty stored range) whose stored range still matches its `textSnapshot`: that answers `degraded` and writes nothing, so relocation and undo keep the real span. Check that `textSnapshot` comparison detects drift correctly.
+- **Lazy relRange attachment and repair:** a missing or dead `relRange` is re-minted from the stored flat range only when `storedRangeStillMatches()` holds; otherwise the result is `degraded` and no anchor is written — that no-write is correct, not a bug. A dead `relRange` is stripped, never preserved. Verify writes run inside `withMcp` (`refreshAllRanges`) or the caller's tagged outer transaction (`skipTransact`) (ADR-031).
```

**M2 — crdt-reviewer.md:18, 20**
```diff
-- `src/server/positions.ts` — server-side: validateRange, anchoredRange, refreshRange, resolveToElement, flatOffsetToRelPos, relPosToFlatOffset
+- `src/server/positions.ts` — server-side: validateRange, anchoredRange, refreshRange, storedRangeStillMatches, relPosToFlatOffset (re-exports resolveToElement and flatOffsetToRelPos)
+- `src/shared/positions/ydoc.ts` — where `resolveToElement()` and `flatOffsetToRelPos()` are implemented (prefix clamping, separator math)
@@
-- `src/server/mcp/document-model.ts` — extractText, findXmlText, resolveOffset
+- `src/server/mcp/document-model.ts` — extractText, findXmlText (`resolveOffset` is only a back-compat alias of `resolveToElement`, exported from `src/server/mcp/document.ts`)
```

**H7 — security-reviewer.md:9**
```diff
-- Express HTTP server on :3479 (MCP + REST API), bound to 127.0.0.1 only
+- Express HTTP server on :3479 (MCP + REST API), bound to 127.0.0.1 by default; `TANDEM_BIND_HOST` (Cowork) can move it off loopback (`src/server/bind-check.ts`), and several open findings in `docs/security.md` exist only under that bind
```

**H8 — dev-server/SKILL.md:13**
```diff
-- `freePort()` kills any existing process on :3478/:3479 at startup — you cannot run two instances
+- At startup the server probes :3479 first. If a live Tandem already answers there — the desktop app included — the dev server **refuses to start** ("Tandem is already running") instead of killing it; quit that instance first. Only a holder that is not a live Tandem is SIGKILLed by `freePort()`. Either way, two instances cannot share 3478/3479
```

**M5 — dev-server/SKILL.md:65-69**
```diff
 ## Restarting After Server Code Changes
-If you changed server code, restart just the server:
-1. Stop the running `dev:standalone` process
-2. Run `npm run dev:standalone` again
-3. Run `/mcp` in Claude Code to reconnect
+`dev:standalone` runs the server under `tsx watch`, so it restarts itself when
+server code changes; Vite hot-reloads the client. The MCP session does not survive
+the server restart — run `/mcp` in Claude Code to reconnect.
```

**H9 — e2e-debug/SKILL.md:21-47**
````diff
 ## Pre-Flight Checklist
 
-Before running E2E tests, verify:
+The backend Playwright starts depends on `CI` (`playwright.config.ts` `webServer`): locally it runs the server **from source** through tsx (`scripts/e2e-server.mjs … src/server/index.ts`); under `CI` it runs the built `dist/server/index.js`. The client is always the Vite dev server on :4573, never `dist/client/`. So a local run needs no build — check only the reserved ports:
 
 ```bash
-# 1. Server bundle exists (E2E uses pre-built server, not tsx)
-ls dist/server/index.js
-
-# 2. Reserved ports are free (a holder is either refused or killed — see above)
 curl -sf http://127.0.0.1:4729/health && echo "⚠ Server on :4729 (stale E2E?)" || echo "✓ Port free"
 curl -sf http://127.0.0.1:4728 && echo "⚠ Something on :4728" || echo "✓ Port free"
-
-# 3. Client build exists (for webServer)
-ls dist/client/index.html
-```
-
-If `dist/server/index.js` is missing or stale:
-```bash
-npm run build:server
 ```
 
 ## Failure Categories
 
 ### Timeout waiting for health endpoint
 **Symptom**: `Timed out waiting for http://127.0.0.1:4729/health`
-**Cause**: `dist/server/` is stale or missing
-**Fix**: `npm run build:server` then retry
+**Cause**: locally, the source server failed to boot — read the webServer output above the timeout. Under `CI`, a stale or missing `dist/server/`.
+**Fix**: fix the boot error; for a `CI`-mode run, `npm run build:server` then retry.
````

**H10 — e2e-debug/SKILL.md:59-65**
```diff
 ### Stale openDocuments / phantom tabs
 **Symptom**: Tests find unexpected documents open or wrong tab state
-**Cause**: Prior test crash left session state on disk
-**Fix**: Delete session directory:
-- Windows: `%LOCALAPPDATA%\tandem\Data\sessions\`
-- macOS: `~/Library/Application Support/tandem/sessions/`
-- Linux: `~/.local/share/tandem/sessions/`
+**Cause**: not leftover session files — every run's backend uses an isolated `TANDEM_APP_DATA_DIR` (`tandem-e2e-data`) that `scripts/e2e-server.mjs` wipes at start. Look for state leaking between specs in the same run (a spec that opens documents and never closes them), or a hand-started Vite that Playwright reused instead of starting its own.
+**Fix**: never delete the per-OS `sessions/` directory for this — that is your real Tandem's session store, and the E2E backend does not read it.
```

**H11 — e2e-debug/SKILL.md:70**
```diff
-**Fix**: Check CLAUDE.md Critical Rule #7 for the current testid list. Use `[data-testid="..."]` selectors, not CSS classes.
+**Fix**: grep `tests/design-system-impl/__snapshots__/testid-set.snap.txt` for the current name — that snapshot is the authoritative set (CLAUDE.md Critical Rule 7). Use `[data-testid="..."]` selectors, not CSS classes.
```

**H12 — e2e/SKILL.md:43**
```diff
-- Use `data-testid` selectors (kebab-case): `accept-btn`, `dismiss-btn`, `annotation-card-{id}`
+- Use `data-testid` selectors (kebab-case), e.g. `accept-btn-{id}`, `dismiss-btn-{id}`, `annotation-card-{id}`; the authoritative set is `tests/design-system-impl/__snapshots__/testid-set.snap.txt`
```

**H13 — screenshots/SKILL.md:47-48**
```diff
-single copy on purpose; do not restate it here, in `.agents/skills/screenshots/`,
-or in the spec.
+single copy on purpose; do not restate it here or in the spec.
```

**M4 — screenshots/SKILL.md:50-51**
```diff
-One slot is not automatable: `14-desktop-window.png`. Neither pipeline drives the
-Tauri WebView, so the desktop-window shot is taken by hand.
+One slot is not automatable: `14-desktop-window.png`. The capture pipeline drives
+Chromium, not the Tauri WebView, so the desktop-window shot is taken by hand.
```

**H14 — ui-inspector/SKILL.md:122-123**
```diff
-For a visual before/after, ask Bryan to pick a fresh reference after the HMR
-reload and compare the two element crops.
+For a visual before/after, ask Bryan for screenshots — references carry no
+pixels (see "Pixels are OFF"). A fresh pick after the HMR reload still lets you
+compare the two references' metadata and locators.
```

**H15 — diverge.md:2 and CLAUDE.md:83**
```diff
--- a/.claude/commands/diverge.md
-description: Run parallel divergent ideation on an open-ended design problem before /plan. Spawns 6 frame generators + critic + deepen survivors. ~16 Agent calls, 60–180s. Use only when /plan would be premature.
+description: Run parallel divergent ideation on an open-ended design problem before /plan. Spawns 6 frame generators + critic + 3 deepen survivors. 10 Agent calls, 60–180s. Use only when /plan would be premature.
--- a/CLAUDE.md
-right shape isn't obvious (~16 `Agent` calls, 60–180s). Invoke only when the next artifact
+right shape isn't obvious (10 `Agent` calls, 60–180s). Invoke only when the next artifact
```

**H16 — diverge.md:132**
```diff
-- If "None of these — reframe": update **Outcome** to `"none — reframe"`. Tell the user this counts against the 30-day kill gate (per `.claude/plans/diverge-workflow.md`). Ask if they want to retry diverge with a reframed problem statement or abandon.
+- If "None of these — reframe": update **Outcome** to `"none — reframe"`. Tell the user this counts toward the review gate below — a second "reframe" within a review period is a retirement criterion. Ask if they want to retry diverge with a reframed problem statement or abandon.
```

**M1 — merge the six generators (Group 4 roster edit).**

1. Delete the six `diverge-{regulator,speedrunner,biology,on-call,deletionist,future-self}.md` files.
2. Add `.claude/agents/diverge-generator.md`:

````markdown
---
name: diverge-generator
description: Generator subagent for /diverge — produces two proposals through the frame given in its prompt. Only for use inside the /diverge pipeline.
---

You are a generator in a divergent-ideation pipeline. Your prompt holds a problem statement and one frame. Produce exactly two distinct proposals for the problem, seen through that frame.

Work from first principles and from the problem statement alone. The pipeline gets its diversity from generators reasoning without project context, so don't read files, search the codebase, or look anything up, and don't draw on any project detail that happens to be in your context. If the problem statement is ambiguous, commit to its most charitable reading rather than asking.

Evaluation happens in a later stage, so this is pure generation: no critique, comparison, pros and cons, ranking or recommendation, and no mention of alternatives you rejected or of other frames.

Output only the two proposals, numbered 1 and 2, each 4–7 sentences, in the shape the frame describes:

```
1. <first sentence as the frame specifies>. <3–6 sentences developing it within the frame>.

2. <first sentence as the frame specifies>. <3–6 sentences developing it within the frame>.
```
````

3. Replace diverge.md's Step 2 dispatch bullets with:

   > In **one assistant message**, spawn six parallel `Agent` calls with `subagent_type: diverge-generator`, one per frame below. Each call's `prompt` holds exactly two things: the problem statement from `$ARGUMENTS`, verbatim, and that frame's block, pasted verbatim. Nothing else — no codebase pointers, file paths, CLAUDE.md excerpts or other context, and no paraphrase of the frame. Generators are deliberately stripped of project context; that isolation is the property the method depends on. Run them in the foreground; all six must complete before step 3.

   Then add a `### Frames` subsection holding each deleted agent's "Your frame" body plus its output-shape sentence, **moved verbatim** under `**regulator**`, `**speedrunner**`, `**biology**`, `**on-call**`, `**deletionist**`, `**future-self**`.
4. In diverge.md:146, change "The 'Do not read CLAUDE.md or search the codebase' instruction in the frame-agent system prompts" to "The generator's 'no project context' instruction".
5. In docs/architecture.md:1235, change "plus the six `/diverge` frame generators and its critic" to "plus the `/diverge` generator (run once per frame) and its critic".

To weigh: the orchestrator now holds the frame text and could paraphrase it, which the "verbatim" wording covers. No test or hook references a `diverge-*` name. Dropping a frame later becomes a one-block delete.

**H17 — release/SKILL.md:246-248** (only if you do **not** take CLAUDE.md H24)
```diff
-9. Update project memory: the CLAUDE.md **Status** section (what shipped in
-   this version) and the project memory SHIPPED entry (per the archive
-   rotation discipline).
+9. Update project memory: bump the `**Shipped: v<version>** (<date>)` line in
+   CLAUDE.md's **Status** section — version and date only; release contents
+   live in CHANGELOG.md and Status says not to re-narrate them — and the
+   project memory SHIPPED entry (per the archive rotation discipline).
```

**M6 — release/SKILL.md:9-12**
```diff
-Codifies the release sequence used from v0.14.3 onward, and refined by every cut
-through v0.22.0 — including the global-install upgrade step, the two changelog
-gaps, the rebuild-before-retest step, and the duplicate-draft race described
-below. The version
-bump has **SIX surfaces**, none of which bump automatically. Surfaces 1–4 are
+The version bump has **SIX surfaces**, none of which bump automatically. Surfaces 1–4 are
```

**M7 — release/SKILL.md:122-125**
```diff
-   stale bundle. It reads as a real regression and is not one. This has now
-   fired at three cuts (v0.19.0→v0.20.0, and again at v0.22.0 despite being
-   recorded in project memory both times), which is why it is a step here rather
-   than a note someone is expected to remember:
+   stale bundle. It reads as a real regression and is not one:
```

**H18 — changelog/SKILL.md:33-41**
```diff
-4. Group into Keep a Changelog categories based on conventional commit prefixes:
+4. Group into the categories `CHANGELOG.md` actually uses, guided by the conventional commit prefix:
    - `feat(...)` → **Added** (new features) or **Changed** (enhancements to existing)
    - `fix(...)` → **Fixed**
-   - `refactor(...)` → **Changed**
-   - `docs(...)` → **Documentation**
-   - `test(...)` → **Tests**
-   - `chore(...)` → **Maintenance**
-   - `perf(...)` → **Performance**
+   - A removed feature, tool or option → **Removed**
    - Security-related commits → **Security**
+   - `refactor`, `test`, `docs`, `chore`, `ci`, `build`, `perf` with no user-visible effect → **Internal**
+   - Any of those a user will notice (a faster open, a behaviour change) → **Changed** or **Fixed**
```

**M10a — changelog/SKILL.md:51**
```diff
-   - 3–6 bullets, most impactful first, one line each (≤20 words).
+   - A handful of bullets — enough to carry the release's substance — most impactful first, one line each.
```

**M10b — changelog/SKILL.md:80-82**
```diff
-Nothing else. If a sentence is doing a fourth job, it belongs in the PR. **120 words is a
-runaway backstop, not a target**, and bounds do not count toward it — an entry that needs
-three honest bounds gets three sentences and is still correct. Draft the entry, then cut it to
+Nothing else. If a sentence is doing a fourth job, it belongs in the PR. Bounds are never cut
+for length — an entry that needs three honest bounds gets three sentences and is still
+correct. Draft the entry, then cut it to
```

**M8 — svelte-migration-reviewer.md:66, 77, 80**
```diff
-- **Rule:** Svelte 5 scopes all `<style>` content. If a `@keyframes` animation is referenced via an inline `style=` attribute or a dynamic class, Svelte's scoping hash won't match. The keyframes must be wrapped in `:global`.
+- **Rule:** Svelte 5 scopes all `<style>` content, keyframe names included. If a `@keyframes` animation is referenced via an inline `style=` attribute or from outside the component, Svelte's scoping hash won't match, so the name must be made global with the `-global-` prefix. Keyframes referenced only from the same `<style>` block stay scoped (see `src/client/tabs/NewTabMenu.svelte`).
@@
-    :global(@keyframes fadeIn) { ... }
+    @keyframes -global-fadeIn { ... }
@@
-- **Check:** Look for `@keyframes` in `<style>` blocks and verify they're wrapped in `:global()` if referenced from inline styles or dynamic attributes.
+- **Check:** Look for `@keyframes` in `<style>` blocks and verify they carry the `-global-` prefix when referenced from inline styles or outside the component.
```

**M9 — svelte-migration-reviewer.md:141**
```diff
-Start by reading the most recently modified `.svelte` and `.svelte.ts` files (check `git diff` or `git log` for recent changes), then systematically check each focus area.
+Review the files or diff your prompt names against each focus area. If none is named, review the `.svelte` / `.svelte.ts` files in the current branch's diff against `master`.
```


---
