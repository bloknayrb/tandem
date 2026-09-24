# Compatibility probes — merged Claude desktop app and Codex CLI (2026-09-17)

**Status:** working note, landed as-is on 2026-09-24. No other doc was updated from its findings.

**Executor:** a Claude **Cowork** session (cloud container linked to Bryan's desktop), *not* a
Claude Code terminal session. That is a deviation from the plan's ground rule 2 and it is why §2
was not run — see "What was not run and why".

**Plan:** `.claude/plans/2026-09-17-compat-probes-computer-use.md`.
**Fixture:** a temp directory on the probe machine (`$D`), documentId
`probe-atksar`. All JSONL evidence is there.

---

## 1. Environment

| Item | Value |
|---|---|
| Tandem | 0.25.0, HTTP transport, `/health` 200 |
| Claude desktop app | appVersion 2.110.1; **MSIX package present**: `Claude_2.2553.0.0_x64__pzs8sxrjxfjjc`, publisher `Anthropic, PBC` |
| codex-cli | 0.154.0 |
| opencode | 1.18.27 |
| ollama | 0.33.2 — only `gemma4:latest` (9.6 GB) and `qwen3-embedding:0.6b` |
| node | v24.2.0 · git 2.50.1 · jq present · git-bash present |
| Free disk (C:) | 84 GB |

**Note on the MSIX row.** Project memory recorded Bryan's Claude Desktop as a direct install, not
MSIX. `Get-AppxPackage *Claude*` now returns a real MSIX package. The package version
(2.2553.0.0) and the running app version (2.110.1) do not match, so there may be two installs.
Not chased — recorded because the matrix's install-type row depends on it.

### §1.4 pre-state snapshot

- Branch `master`, `git status --short` **empty**.
- `codex mcp list` → **no servers configured**.
- Exactly one `installed_plugins.json`, under
  `…\Claude\local-agent-mode-sessions\<a>\<b>\cowork_plugins\`, with **no `tandem` key**.
  Matrix Test A step 1 is therefore un-confounded (had §2 run).
- `push.subscribers` = **5** at start.
- Token **not rotated** (§1.5 went unanswered; not rotating is the non-destructive default).

### §1.6 preconditions

- **§1.6a met, after a correction.** One non-fixture tab was open at §1.7 —
  `scratchpad-uvh7jq` → `upload://scratchpad/…/Scratchpad.md`. Reported to Bryan; he chose to
  close it. Closed before any Codex call, so nothing of his was disclosed to OpenAI.
- **§1.6b NOT met.** Bryan did not confirm idling his other Claude sessions.
  `push.subscribers` stayed at 5–6 for the whole run. This is the direct cause of the §3c result
  below.

---

## 2. Action 3 — NOT RUN

The plan's ground rule 2 forbids running from inside the app under test, and §2b step 4 requires
a process snapshot with **Claude Desktop closed**. This session reaches the machine *through* the
Claude desktop app, so closing it ends the session. §2a is likewise self-measurement: this session
is a cloud session of the merged app.

Bryan was asked and chose "run everything except §2".

**Matrix Test A verdict: NOT RUN.** Nothing here bears on whether #316 stays a v1.0 blocker. One
observation that is *not* a substitute: this Cowork session does reach Tandem's MCP tools through
the desktop bridge (`localMcpServers` reports `tandem` and plugin `tandem` / `tandem-channel` as
`announced`), but that is the bridge, not a local session's own MCP stack, and it says nothing
about the local-vs-cloud chooser.

---

## 3. Two surfaces died mid-run; both are findings

**Screen capture is broken on the box.** `computer_screenshot` failed twice with
`desktopCapturer returned no screen sources` after computer use was granted for Tandem. Rule 0.6
stop. Every GUI step in the plan was blocked by this.

**The browser-served client cannot sync from the Claude in-app browser pane.** The page at
`http://127.0.0.1:3479/` loads and renders ("Nothing open yet"), but its Hocuspocus WebSocket to
`ws://127.0.0.1:3478/` fails repeatedly; a raw `new WebSocket()` from the same page also errors.
The **server is fine**: the identical upgrade from curl on the same machine with
`Origin: http://127.0.0.1:3479` returns `HTTP/1.1 101 Switching Protocols`. So the block is
browser-side, in the Claude desktop app's browser pane. Rule 0.6 stop; not chased further.

**Workaround used, and it worked.** The same URL in Bryan's real Chrome (via the Claude in Chrome
extension) loaded, synced, and served as the "user" surface for every GUI step below. All GUI
results in this document were produced there, not in the Tauri window. Tauri-specific paths (the
native File→Open dialog, tray quit) were therefore not exercised.

Document open/close/save used `POST /api/open` / `/api/close` / `/api/save` — the same handlers
the GUI calls — rather than the Tauri file dialog.

---

## 4. §1.10 — markdown save fidelity

Method: open in Tandem, save, diff against a pristine copy. Full diff at `$D/fidelity.diff`.

**Two LOSSY hunks, both Obsidian syntax:**

| Before | After |
|---|---|
| `[[Some Note\|alias]]` | `\[[Some Note\|alias]]` |
| `![[img.png]]` | `!\[[img.png]]` |

`remark-stringify` escapes the leading bracket, so a wikilink and an embed both stop resolving in
Obsidian. **VAULT-01 flips to a loss.**

**Four COSMETIC hunks (content intact):** table alignment row restyled `|:-----|:------:|------:|`
→ `| :- | :-: | -: |` with cell padding collapsed (alignment preserved); `_underscores_` →
`*underscores*`; `* ` bullets → `- `; two-space hard break → trailing `\`.

**Survived byte-clean:** YAML frontmatter including its list value, `> [!note]` callout, pandoc
citation `[@smith2020, p. 4]`, footnote reference *and* definition, GFM task list, fenced code
block with language, `**strong**`, HTML comment.

**So GRAD-01, DOCS-03 and LONG-01 do not flip** — frontmatter, citations and footnotes are safe.

Separately, `probe.orig.md` → `probe.normalised.md` (§1.9) was a **zero-byte diff**: plain prose
with ATX headings round-trips exactly.

---

## 5. Action 4 — Codex CLI as a second MCP client

### 5a. Connect

`codex mcp add tandem-probe --url http://127.0.0.1:3479/mcp` succeeded; `codex mcp list` shows
`enabled`, transport `streamable_http`, **Auth: `Unsupported`**.

**`Auth: Unsupported` is cosmetic, not a failure.** The debug log shows the MCP handshake
completing cleanly:

```
rmcp::service: Service initialized as client peer_info=Some(ServerPeerInfo {
  protocol_version: ProtocolVersion("2025-06-18"), …
  server_info: Some(Implementation { name: "tandem", version: "0.25.0" … }) })
```

Tandem does advertise OAuth protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp` (`authorization_servers: ["http://127.0.0.1:3479"]`),
which is the likely source of that label. It did not block anything.

### 5b. THE finding for action 4 — tool deferral

**A first, naive prompt made Codex report zero `tandem_` tools.** Its answer: *"Tools available to
me whose names start with `tandem_`: none. Count: 0."*

Cause: codex-cli 0.154.0 runs with the feature flag **`ToolSearchAlwaysDeferMcpTools`**. MCP tools
are not in the model's tool list; the model has to search for them first. The MCP connection was
healthy the entire time.

Adding one sentence — *"Its tools may be deferred behind tool search; search for tools named
`tandem_` and load them"* — produced the full set immediately.

**This is the single most likely reason a real user would conclude "Tandem doesn't work with
Codex."** It is a client behaviour, not a Tandem defect, but it is the first thing a user meets.

### 5c. Approval wall

Predicted obstacle hit verbatim:

```
MCP tool call requires approval, but approval policy is never
```

`-c 'mcp_servers.tandem-probe.default_tools_approval_mode="approve"'` passed `--strict-config` and
resolved it. **Record as a Tandem finding**: Tandem's tools carry no `readOnlyHint` /
`destructiveHint`, so a non-interactive client has no basis to auto-approve even a pure read.
`--dangerously-bypass-approvals-and-sandbox` was never used.

### 5d. Capability checklist

| # | Result | Evidence |
|---|---|---|
| 1 | **PASS** (after the deferral prompt). 33 tools listed, names exactly the expected set. Protocol-level `tools/list` independently returned 33. | `codex-1.jsonl` |
| 2 | **PASS.** `tandem_open` returned the same `documentId` (`alreadyOpen: true`); `tandem_getTextContent` returned the text with the marker. | `codex-2.jsonl` |
| 3 | **PASS.** Range found via `tandem_search` (regex), comment created `ann_…ds60qg`, visible in the editor on the right sentence. | `codex-3.jsonl` |
| 4 | **PASS.** Suggestion `ann_…4r0bs9` with `suggestedText`, rendered as a tracked-change card. | `codex-4.jsonl` |
| 5 | **PASS with a caveat** (below). Body edit applied; heading edit refused with `INVALID_RANGE — Edit range overlaps with heading markup (e.g., "## "). Target the text content only.` Codex reported the error and stopped. | `codex-5.jsonl` |
| 6 | **PASS.** `tandem_reply` → `{"sent":true,"messageId":…}`, message appeared in the chat panel as ASSISTANT. | `codex-6.jsonl` |
| 7 | **PASS.** Third comment `ann_…ezht62` left pending. | `codex-7.jsonl` |
| 8 | **PASS on the stated criterion.** After `tandem_save`, exactly one hunk differs from `probe.normalised.md`, and it is the step-5 edit. | `codex-8.jsonl` |

**Rule 0.4 scan: clean.** Across 14 JSONL logs, every `tandem_` call carried
`documentId: "probe-atksar"`. No un-pinned call, no call outside the named tool set. Codex also
volunteered `textSnapshot` on every mutating call without being asked.

### 5e. The row-5 caveat — a real hazard, caused by a bad fixture

The fixture contained the word `replacement` in paragraph 4, which contains the substring
`replaceme`. `tandem_resolveRange("replaceme")` returned the **first** occurrence — inside
`replacement` — and the `textSnapshot` Codex supplied (`"replaceme"`) matched that substring, so
the staleness guard could not object. The edit landed in the wrong paragraph:

```
a suggested replacement is for   →   a suggested REPLACEDnt is for
```

Every component behaved to spec. **The hazard is nonetheless real and worth its own issue:** a
substring anchor plus a snapshot that matches the substring silently corrupts a different word,
and nothing in the result tells the caller it hit occurrence 1 of N. `tandem_resolveRange` has an
`occurrence` parameter but no "this pattern is ambiguous" signal.

### 5f. Consequence — and an unplanned positive result

Because that edit landed *inside* suggestion B's span, accepting B in the editor failed:

> **"Couldn't apply the suggestion — the text has changed. The annotation was left pending."**

That is the snapshot-contradiction guard doing exactly the right thing: refusing to write a stale
suggestion over changed text, and leaving the annotation pending rather than half-applying.

To exercise Accept properly, a clean suggestion (D) was created on an untouched sentence and
accepted: it applied correctly. A second clean suggestion (F) was accepted later, also correctly.

**Control labels are `Accept` / `Reject`** — the plan's guess of "Dismiss" is wrong.

### 5g. §3c inbox round-trip — CONFOUNDED

User actions performed in the editor (Tandem mode confirmed, `mode: "tandem"` in every result):
accept a suggestion, reject a comment, reply in a thread, send a chat message. Done twice, the
second time on a **freshly restarted server** with a clean ledger.

Codex's `tandem_checkInbox` returned **`"No new actions."` on all three attempts**, with every
collection empty.

The events exist. Across the second attempt `/health` went from `eventCount: 0` to `40`, and
`pollCount` reached **5 while only one of those polls was ours**, with `forwardCount: 2`. The
`surfacedIds` ledger is server-wide, `push.subscribers` was 5–6 throughout, and Bryan's other
Claude sessions reattached within seconds of the restart. The four polls that were not ours
drained the ledger before Codex asked.

**Verdict: CONFOUNDED, not FAIL.** §1.6b was never met and the measurement cannot be isolated
while other clients are attached. Re-running this needs Bryan to idle those sessions; it is then
about two minutes of work. Until then, *"a second AI client can see the user's actions"* is
**unproven in either direction**.

Note also what this says about the ledger design independent of the probe: a server-wide
`surfacedIds` means **any** additional attached client silently starves every other client's
inbox. That is a product property, not a test artifact.

### 5h. §3d reconnect — server half PASS, client half NOT RUN

Interactive Codex cannot run here: `codex` exits with `Error: stdin is not a terminal`, and the
plan's route (drive a terminal with computer use) is blocked by the dead screen capture. So
*whether Codex re-initialises* was not measured.

The server half was measured directly. An MCP session was opened by hand
(`Mcp-Session-Id: 47276cb3-…`), `tools/list` returned 33 tools, Tandem was restarted, and the same
session id was reused:

```
HTTP/1.1 404 Not Found
{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":4}
```

Exactly the documented contract. Tandem came back and answered `/health` 200 within the first
2-second poll after relaunch.

### 5i. §3e review state across a client switch — PASS on every point

1. **Visibility.** From the Claude session, `tandem_getAnnotations` returned all of Codex's
   annotations with status and replies intact: A `dismissed`, B `pending`, C `pending` carrying
   the user's `probe-reply-1`, D `accepted`.
2. **Reverse visibility.** Codex then listed all five annotations including the one created by the
   Claude session, with authors and statuses.
   **Attribution gap confirmed:** every annotation reads `author: "claude"` regardless of which
   client created it (`src/server/annotations/lifecycle.ts`, hard-coded). Codex's work is
   indistinguishable from Claude's in the record.
3. **Continue, not just see (VENDOR-03).** Codex was pointed at the Claude session's annotation,
   **replied in its thread and resolved it** — both returned success, **no ownership guard, no
   refusal text**. The reverse also worked: the Claude session replied to and dismissed Codex's
   still-pending comment C. Cross-client continuation of an open review works in both directions.
5. **Durability.** The fixture tab was closed and reopened: all five annotations, both statuses
   and both reply threads came back, re-anchored, with no `degraded` anchor reported.

### 5j. §3e.4 — the export report is worse than predicted

`tandem_exportAnnotations` (markdown) on a document with 5 annotations, 2 dismissed, 1 accepted,
1 pending, 3 replies and 1 direct `tandem_edit`. Four problems:

1. **The direct `tandem_edit` is absent.** As predicted. The report records *proposals*, not what
   the AI changed. **AUDIT-01 and GRAD-04 stand.**
2. **Status is missing entirely.** Accepted, dismissed and pending items are rendered
   identically. A reader cannot tell what was agreed from what was rejected. This was not
   predicted and is arguably worse than (1).
3. **Replies are missing.** The user's reply and both cross-client replies appear nowhere.
4. **The quoted anchors are sliced at wrong offsets.** Verbatim from the output:
   `"be needs a sentence that can be found by an exact string search, so here it i..."` for a quote
   that starts *"A pro**be needs**"*; also `"ery sentence here is deliberately plain..."`,
   `"ntains a sentence that could plausibly..."`, `"third distinct annotation target..."`, and
   `" says nothing of consequence.\nF"`. The excerpt window is reading offsets that no longer
   describe the text. **This looks like a straight bug and deserves an issue.**

Every annotation is attributed `(Assistant)`, consistent with the hard-coded author.

---

## 6. §3O — opencode as a third client

Config: project-level `$D/opencode.json` only. Nothing written to `~/.config/opencode`;
`opencode mcp list` was empty before and shows only `tandem-probe` when run from `$D`. The remote
MCP shape was taken from the live schema at `https://opencode.ai/config.json`
(`McpRemoteConfig`), not from memory. `oauth: false` was set to stop OAuth auto-detection from
prompting against Tandem's protected-resource metadata.

```
✓ tandem-probe  connected   http://127.0.0.1:3479/mcp
```

**opencode does NOT defer MCP tools.** All 33 arrive in the model's tool list directly, namespaced
`tandem-probe_tandem_*`. That is the opposite of Codex's behaviour and it is the cleaner
experience.

### 6a. Pass A (hosted model) — BLOCKED, not run

Bryan's only opencode credential is **OpenCode Zen**, and he chose `opencode/gpt-5.2`. The run
failed at the provider:

```
401 CreditsError: No payment method. Add a payment method here: …/billing
```

Adding a payment method is a purchase prompt — rule 0.5 stop. **Pass A not run.** It needs either
billing on that account or a different provider Bryan is already signed in to.

### 6b. Pass B (local model through opencode) — the interesting result

Model: `gemma4:latest` (9.6 GB) served by the local Ollama daemon at `http://localhost:11434/v1`
through an `@ai-sdk/openai-compatible` provider entry. CPU-only. **Nothing left the machine.**

| Row | Result |
|---|---|
| 1 — list tools, `tandem_status` | **PASS.** All 33 tools listed correctly; `tandem_status` called with the pinned `documentId`, raw result returned. |
| 2 — `tandem_getTextContent`, find marker | **PASS with one retry.** First attempt called `tandem-probe-tandem-getTextContent` (hyphens for underscores); opencode's `invalid` tool returned the available-tool list and the model self-corrected on the next call. Marker found. |
| 3 — resolve a range, comment on it | **PARTIAL.** `tandem_resolveRange` and `tandem_comment` both called correctly and the annotation was created (`ann_…9kcbe4`), but the range was **wrong**: asked for the sentence containing the marker, the model anchored to `PROBE-MARKER-7431` itself (`[559,576]`). It also supplied **no `textSnapshot`** — Codex volunteered one on every call. |

Latency: ~250 s for the three rows on CPU, roughly 50–60 s per row.

**Rule 0.4 scan: clean.** Every `tandem_` call carried `documentId: probe-atksar`.

**What this is worth.** A 9.6 GB local model driving Tandem's *generic, offset-based* MCP tools
got two of three rows right and failed the third on range selection — exactly the failure mode the
dark `BYO_MODELS_ENABLED` loop's quote-anchored tools exist to prevent. That is a meaningful data
point for Wave 5M: the zero-code path (opencode + Ollama + Tandem's MCP endpoint) is not a
non-starter, but raw offsets are where it breaks, and it needs no part of the dark loop to try.

One caveat that limits how far this generalises: it is one model, one scenario each, no seeds, and
no scoring rubric. It is **not** a substitute for the M0 harness.

### 6c. Pi

`pi 0.85.0` is installed and has no MCP client. **Out of scope**, as the plan says. Not probed.

---

## 7. §3L — local-model capability re-run: BLOCKED

`npx tsx probe/local-model-spike/smoke.ts` fails at import:

```
SyntaxError: The requested module '../../src/server/mcp/annotations.js'
does not provide an export named 'addReplyToAnnotation'
```

Both symbols the harness imports from `src/server/mcp/annotations.js` —
`createAnnotation` and `addReplyToAnnotation` — **no longer exist**. The reply path was moved onto
the guarded `AnnotationLifecycle` class ("Unit 8f"); the surviving free function `addUserReply`
writes as author `user` with origin `browser`, which is not what the harness needs (author
`claude`, `withMcp`).

Every runner — `batch.ts`, `batch-fallback.ts`, `run.ts`, `loop.ts`, `fallback.ts` — routes
through `tools.ts`, so **Tier A and Tier B are both unrunnable**. Porting means choosing which
replier and which origin helper the harness should use, which is a semantic migration, not the
trivial import-path fix §3L.1 permits. **Stopped and reported, per §3L.1.** Bryan confirmed that
choice.

The three tracked jsonl logs were backed up to `$D/spike-backup/` and are **byte-identical** to
their originals — nothing was run, nothing was appended.

**Consequence for the priority call:** Bryan's objection to the M0 spike — *that was a statement
about one old laptop, not about local models* — **remains unanswered and is currently
unmeasurable**. Re-opening it requires porting the harness first. None of §3L.5's branches can be
selected on this evidence. The §3O.b result above is the only local-model data this run produced,
and it is anecdotal by comparison.

---

## 8. §4 Cleanup — verified

- `codex mcp remove tandem-probe` done; `codex mcp list` → **no servers configured**, matching the
  §1.4 snapshot exactly.
- Fixture tab closed via `POST /api/close`.
- Tandem mode restored to **Solo**, which is what it was at the start of the run.
- No config file was moved, renamed or backed up — §2b.1 and §2b.7 never ran, and the token was
  never rotated.
- Branch `master`. `git status --short` shows **one** entry: `?? docs/spikes/2026-09-17-…md`,
  this file. Nothing else changed.
- The three `probe/local-model-spike/*.jsonl` logs are **byte-identical** (SHA-256) to the
  backups in `$D/spike-backup/`.
- `installed_plugins.json` re-listed: same single file, still **no `tandem` key**. Nothing was
  written per-workspace.
- No Ollama model was pulled. `ollama list` is unchanged (`gemma4:latest`,
  `qwen3-embedding:0.6b`).

### Residue this run leaves behind

- `$D` = a temp directory on the probe machine — all JSONL evidence, the
  fidelity diff, `opencode.json`, `spike-backup/`. Left in place deliberately.
- Codex keeps its own rollout transcripts under `~\.codex\sessions\2026\09\17\`.
- opencode keeps its own session transcripts (three `ses_…` sessions).
- Helper scripts in a scratch directory on the probe machine (`codex-*.sh`, `oc-*.sh`, `scan.py`, `sess.ps1`).
- The fixture remains in Tandem's session, annotation and recent-files stores.
- This file sits in the working tree, which the pre-push hook tests.

---

## 9. Verdicts

**1. Matrix Test A / #316.** **NOT RUN.** Nothing in this run bears on whether #316 stays a v1.0
blocker. It needs a Claude Code terminal session with working screen capture. Note the framing the
corpus imposes: even a PASS would not recover the non-technical audience, because cloud sessions
are the app default.

**2. Is "works with a second AI (Codex CLI)" sayable today?** **Yes, with two caveats that must be
said out loud.**

What works: all 33 tools reachable; open, read, search, resolve-range, comment, suggestion, edit,
chat reply, save; the heading guard; annotation state, statuses and reply threads surviving a
client switch in **both** directions, including one AI continuing and resolving another AI's open
review; durability across close/reopen. Zero un-pinned calls across 14 logs.

The caveats:
- **Codex hides MCP tools behind tool search** (`ToolSearchAlwaysDeferMcpTools`). Out of the box a
  user asking "what Tandem tools do you have?" is told **none**. Tandem's docs must say this, or
  users will file "Codex can't see Tandem".
- **Tandem's tools carry no `readOnlyHint` / `destructiveHint`**, so non-interactive Codex refuses
  every call until a per-invocation approval override is passed. That is Tandem's to fix and it is
  cheap.

What is **not** sayable: that a second client sees the user's actions. `tandem_checkInbox`
returned nothing three times, and the cause could not be isolated from the §1.6b confound.

**3. Local models.** **No verdict available.** The M0 harness no longer builds against `src/`, so
the June table cannot be re-run and none of §3L.5's branches can be selected. The one data point
produced — gemma4 through opencode against the live MCP endpoint, 2 of 3 rows correct, failing on
range selection — suggests the wall is where the dark loop's quote anchoring says it is, but it is
one model and one scenario each and should not be reported as a capability measurement.

**4. Needs Bryan.**
- Idle the other Tandem-attached sessions so §3c can be measured (~2 minutes of work).
- Fix or accept the dead screen capture if §2 is to run at all.
- Decide whether porting `probe/local-model-spike/tools.ts` to the current annotation API is worth
  a task; nothing about local models moves until it is.
- Billing or a different provider if §3O pass A matters.

---

## 10. What this does and does not show

**Does:** that Tandem's MCP contract holds for a non-Claude client on Windows, including the
cross-client review continuity the corpus's VENDOR-03 depends on; that markdown round-trips
cleanly except for Obsidian wikilinks and embeds; that the review export is materially incomplete;
that the snapshot guards refuse stale writes rather than clobbering.

**Does not:** say anything about the merged Claude desktop app (§2 not run); about macOS or Linux;
about a second Claude plan or build; about event *delivery* to a second client (§3c confounded);
about whether Codex recovers from a server restart (no TTY); about local-model capability (§3L
blocked). A tuned Codex integration was not measured either — Codex had no Tandem skill, so this
measures the raw MCP contract.

**Deviations from the plan, in full:** run from a Cowork session rather than Claude Code (§2
dropped as a result); screen capture dead, so every GUI step ran in Bryan's real Chrome against
the browser-served client rather than the Tauri window; document open/close/save driven through
`/api` rather than the native file dialog; §3b row 5's first edit landed on an unintended
substring because of a fixture defect, which then blocked the row-4 Accept and forced two
substitute suggestions; §3c re-run twice beyond the rule-0.6 limit because a server restart
appeared to clear the confound (it did not); §3d client half not run; §3L blocked; §3O pass A
blocked at billing, pass B substituted as the only local-model evidence.
