# Context audit — #2481, baseline — 2026-11-27

The first run of the [context-audit skill](../../.claude/skills/context-audit/SKILL.md) (ADR-058's
plan, step 8). A fresh headless Claude Code session fixed a real, closed bug in a history-free
copy of the repo, and this records what it read, what that cost, how its fix compares with the
real one, and what it said it was missing.

**Read the caveat in section 2 first: this run did not have CLAUDE.md auto-loaded.**

## 1. Set-up

- **Bug:** #2481, "the indeterminate-mode hold fails open on a non-boolean reply marker"
  (owner-authored). Fixed by `4a4bff6` (PR #2544); the copy was built at its parent `f5bd986`.
- **Copy:** `git fetch --depth 1` of `f5bd986` into the scratchpad, `.git` removed, so no history,
  no fix commit and no remote were reachable. `node_modules` symlinked from the real checkout.
- **Instruction set:** the copy's own, as of `f5bd986`: root `CLAUDE.md` at 11,437 words, no
  colocated `CLAUDE.md` files.
- **Run:** `claude -p` (Claude Code 2.1.332) with the copy as its working directory,
  `--output-format stream-json --max-turns 80`, tools limited to Read, Grep, Glob, Edit, Write,
  `npx vitest run` and `npx tsc`. The prompt was the issue body verbatim plus the skill's audit
  instruction.

## 2. Caveat: CLAUDE.md was not auto-loaded

The copy's directory was not a trusted workspace, so Claude Code printed "Ignoring 8
permissions.allow entries from .claude/settings.json: this workspace has not been trusted" and,
judging by the numbers, did not load the project `CLAUDE.md` into context either:

- Startup context was **48,261** tokens. A control run in an empty scratch directory with no
  `CLAUDE.md` started at **46,092**. An 11,437-word `CLAUDE.md` would add roughly 15,000.
- The session's second command was `cat CLAUDE.md`, whose output was truncated; it then read
  lines 1–120 with Read. Its own audit says it saw "only its start".

So this baseline measures **a session that had to fetch its instructions by hand**, not the
normal auto-loaded case.

**Correction, same day: trust was not the cause; the location was.** With Bryan's approval the
copy was trusted and probed with a three-line `CLAUDE.md` holding a marker word. Under the
session's scratchpad (`/tmp/claude-0/...`) the marker never loaded, trusted or not, with or
without a `.git`; moved to `/home/user/audit-2481` (outside the scratchpad and outside the repo)
it loaded at once. The skill now builds the copy there. Section 8 is the re-run with
`CLAUDE.md` actually loaded.

## 3. Numbers (from the event stream, not the agent's summary)

| Measure | Value |
|---|---|
| Startup context (first request) | 48,261 tokens |
| Peak context (largest single request) | 123,342 tokens |
| Turns | 48 |
| Tool calls | 47: Bash 24, Edit 12, Grep 5, Read 4, Write 2 |
| Output tokens | 24,622 |
| Cache reads / cache writes (summed over turns) | 3,073,332 / 95,480 |
| Wall time | 6 min 17 s |
| Cost reported | $1.87 |

Most reading went through `sed -n`/`grep` in Bash rather than Read, so a Read-only count would
understate it. The full ordered call list is [the appendix](#appendix-ordered-tool-calls). The
first instruction-file read was `cat CLAUDE.md` in call 2; Biome was not in the allowed tools,
so the run could not lint (the skill now allows it).

## 4. The fix, against the real one

| Site the real fix (`4a4bff6`) changed | Run's fix |
|---|---|
| `src/server/mode.ts` `hideFromAI`, indeterminate branch | **Same**: fail closed on any value other than `false`/absent (helper `carriesHeldMarker` in `mode.ts`; the real fix put `isHeldInSoloMarker` in `src/shared/sanitize.ts`) |
| `src/server/mcp/annotations.ts` thread-item reader | **Same** |
| `src/server/mcp/routes/mode-release.ts` release sweep | **Same**, with the right reason (a `"true"` marker would survive release and re-hold after restart) |
| `src/shared/sanitize.ts`: normalise a non-boolean annotation marker to `true` | **Missed** |
| `src/server/annotations/schema.ts`: the durable schema coerces the marker | **Missed** |
| `src/client/App.svelte`: the held-count badge | **Missed**, though its audit names "the client badge" as a reader |

Three of six sites. All three missed are where the marker is **written or stored**, not where it
is read; the issue listed only readers. Tests: it added a truth table, a release-sweep case and a
handler-level test over a real MCP server, and checked that they fail against the old predicate
(10 failures). It did not run Biome (that needed a permission the run did not have).

## 5. What it said, quoted, and a verdict on each

Its documentation table found three things stale or misleading:

- `hideFromAI`'s docblock said the indeterminate mode "fail[s] CLOSED". **Verdict: true**, and
  the real fix rewrote that sentence too.
- `queue.ts`'s comment that pull "fail[s] closed exactly as" the push hold. **Verdict: true
  before the fix**; it describes the intended state, which the bug broke.
- `wake-advisory.ts` mentions a "`hideFromAI`-exact replica" that does not exist. **Verdict:
  plausible, unverified here**; worth a grep in a follow-up.

The single most useful thing it read was **a docblock in code** (`replyPrivacyAllows` in
`src/server/annotations/projection.ts`), which explains why replies are unsanitized. The second
was a **test file's header** (`annotation-promote-pull-surface.test.ts`) warning that another
test reimplements handler filters. Neither is in `docs/` or `CLAUDE.md`.

What it wished had been written down:

1. **An inventory of every reader of the `heldInSolo` marker** and which must agree with
   `hideFromAI`. *Verdict: valid, and it would have caught the missed sites only if it also
   listed writers and the schema; the gap it missed is the write side.*
2. **"Any predicate over a reply field must fail closed, because replies are never
   sanitized."** It noted #2460 and #2481 are the same bug twice. *Verdict: valid. This is a
   silent failure with no check, exactly what CLAUDE.md's header says belongs inline. Better:
   make it a check (for example, a test that every `heldInSolo`/`privacy` comparison in `src/`
   goes through one shared predicate).*
3. **When a CHANGELOG entry is required.** *Verdict: valid; CONTRIBUTING.md does not say.*
4. **The minimum verification for a small server-only fix**, against the full plan-and-review
   loop. *Verdict: this is what ADR-058's tiers answer (#2589).*

## 6. Findings

- **F1. Reply-field predicates must fail closed — a recurring, unchecked class.** #2460 and
  #2481 are two instances. Proposed check: a source scan that fails on `heldInSolo ===`,
  `heldInSolo !==`, `privacy ===` and similar raw comparisons in `src/` outside the shared
  predicates. Becomes an issue.
- **F2. The fix reached readers, not writers or storage.** A rule or docblock that names the
  marker's writers and its schema alongside its readers would have pointed at the three missed
  sites. Folded into F1's issue.
- **F3. Code docblocks did the work docs did not.** For this bug the decisive context lived in
  `projection.ts` and a test header, not in `CLAUDE.md` or `docs/`. Evidence for step 9's
  placement rule: area knowledge belongs next to the code.
- **F4. No CHANGELOG rule.** Small; for CONTRIBUTING.md.

## 7. Next

- **The measurement this baseline could not take** — startup cost and behaviour with CLAUDE.md
  auto-loaded — needs the copy's folder trusted. Options for Bryan: allow this session to add a
  `hasTrustDialogAccepted` entry for the scratch copy in `~/.claude.json`; or run the skill on his
  own machine; or accept this "fetched by hand" baseline and compare step 10 against it like for
  like (also untrusted).
- Step 10 reruns this bug against the slimmed `CLAUDE.md` set once it lands.
- Next scheduled audit: [#2593](https://github.com/bloknayrb/tandem/issues/2593), "Context audit
  due 2027-02-27". Finding F1/F2 is [#2594](https://github.com/bloknayrb/tandem/issues/2594).

## 8. Trusted re-run, with CLAUDE.md loaded

Same bug, same prompt, same parent commit, the copy at `/home/user/audit-2481` and trusted,
with **master's current `CLAUDE.md` (12,012 words at `1ee55d6`) overlaid**, so step 10 can
compare the slimmed set against exactly this one. Tools as the revised skill says: Biome
allowed, writes under `node_modules/` denied (none attempted).

| Measure | Untrusted (sections 3–4) | Trusted (this run) |
|---|---|---|
| Startup context | 48,261 | **80,918** (CLAUDE.md costs about 32.6k tokens) |
| Peak context | 123,342 | 134,499 |
| Turns / tool calls | 48 / 47 | 43 / 42 |
| Read / Grep / Bash calls | 4 / 5 / 24 | 13 / 10 / 6 |
| Output tokens | 24,622 | 16,927 |
| Wall time | 6 min 17 s | 5 min 34 s |
| Cost reported | $1.87 | $1.87 |
| Fix sites matched (of the real fix's 6) | 3 | 3 (the same three) |

The trusted settings also turn on the copy's `.claude/settings.json` allow entries and hooks,
which is why reads moved from Bash to Read/Grep; that confounds a tool-by-tool comparison, not
the startup or fix-quality ones.

**Fix.** Identical coverage: `hideFromAI`, the thread-item reader and the release sweep. It again
missed `sanitize.ts`, `schema.ts` and the client badge, but this time **named the badge and the
annotation-polarity question as residuals** ("someone should decide it deliberately"), which is
exactly where the real fix went. It added 13 tests and checked they fail against the old
predicate.

**What it said about CLAUDE.md** (quoted): "Mostly noise for this task, a little useful. About
40 KB auto-loaded … Neither the Solo/indeterminate hold, `hideFromAI` nor `heldInSolo` is
mentioned anywhere in it, even though it is a privacy gate." The two things that helped were
Critical Rule 2 (seed test writes with `withInternal`) and the #2460 precedent. Its wish list
repeats the baseline's (a fail-closed rule for unsanitized reply fields, a reader inventory) and
adds a "Where to look" row for Solo/Tandem mode and privacy holds.

**Verdict.** For this bug, loading the 12k-word root `CLAUDE.md` cost about 32.6k tokens per
session and did not change the fix's coverage; it shortened the run slightly. The decisive context
was again in code docblocks. This is the baseline step 10 compares against.

## Appendix: ordered tool calls

From the run's event stream. Turn is the assistant turn the call came in; targets are relative to
the copy and cut at 120 characters.

| # | Turn | Tool | Target |
|---|---|---|---|
| 1 | 2 | Bash | `ls; ls docs \| head -50; wc -l CLAUDE.md; grep -rn "heldInSolo" src --include=*.ts \| grep -v test \| head -60` |
| 2 | 3 | Bash | `cat CLAUDE.md; sed -n 1,140p src/server/mode.ts; sed -n 190,260p src/server/mcp/annotations.ts` |
| 3 | 4 | Bash | `grep -rn "replyPrivacyAllows" src \| head; grep -rn "hideFromAI\\|isHeldFromAI" src --include=*.ts \| grep -v "\.test\."...` |
| 4 | 5 | Bash | `sed -n 60,100p src/server/mode.ts; sed -n 300,330p src/server/annotations/projection.ts; sed -n 4085,4140p src/server...` |
| 5 | 7 | Bash | `sed -n 200,240p src/server/mcp/annotations.ts; sed -n 1,120p src/server/mcp/routes/mode-release.ts; sed -n 270,370p s...` |
| 6 | 9 | Bash | `sed -n 40,80p src/server/mcp/wake-advisory.ts; grep -n "hideFromAI\\|heldInSolo\\|replies" src/server/mcp/wake-advisory...` |
| 7 | 11 | Bash | `grep -n "indeterminate\\|heldInSolo" tests/server/mode.test.ts \| head -30; grep -ln "indeterminate" tests/server/annot...` |
| 8 | 12 | Bash | `sed -n 55,100p tests/server/mode.test.ts; grep -n "indeterminate" tests/server/annotation-replies.test.ts tests/serve...` |
| 9 | 13 | Bash | `sed -n 760,830p tests/server/awareness-tools.test.ts; sed -n 480,540p tests/server/annotation-tools.test.ts; grep -n ...` |
| 10 | 15 | Bash | `sed -n 1,140p tests/server/annotation-promote-pull-surface.test.ts` |
| 11 | 17 | Bash | `sed -n 140,260p tests/server/annotation-promote-pull-surface.test.ts; grep -n "export function addUserReply\\|export f...` |
| 12 | 19 | Bash | `sed -n 636,690p src/server/mcp/annotations.ts; sed -n 940,1040p src/server/mcp/annotations.ts; grep -n "export type R...` |
| 13 | 21 | Bash | `python3 - <<'EOF' p='src/server/mode.ts' s=open(p).read() old='''export function hideFromAI( record: { author: string...` |
| 14 | 23 | Edit | `src/server/mode.ts` |
| 15 | 24 | Edit | `src/server/mode.ts` |
| 16 | 25 | Read | `src/server/mcp/routes/mode-release.ts` |
| 17 | 26 | Edit | `src/server/mcp/routes/mode-release.ts` |
| 18 | 27 | Edit | `src/server/mcp/routes/mode-release.ts` |
| 19 | 28 | Edit | `src/server/mcp/annotations.ts` |
| 20 | 29 | Edit | `src/server/mcp/annotations.ts` |
| 21 | 30 | Edit | `tests/server/mode.test.ts` |
| 22 | 31 | Bash | `grep -n "hideFromAI" tests/server/mode.test.ts \| head -2; sed -n 1,60p tests/server/mode-release.test.ts` |
| 23 | 32 | Bash | `sed -i 's#^import { hideFromAI, readLiveMode, readModeState } from "../../src/server/mode.js";#import {\n carriesHeld...` |
| 24 | 33 | Edit | `tests/server/mode.test.ts` |
| 25 | 34 | Read | `tests/server/mode-release.test.ts` |
| 26 | 36 | Edit | `tests/server/mode-release.test.ts` |
| 27 | 37 | Bash | `sed -n 260,340p tests/server/annotation-promote-pull-surface.test.ts; grep -n "userReplies" tests/server/*.test.ts \| ...` |
| 28 | 39 | Write | `tests/server/held-marker-non-boolean.test.ts` |
| 29 | 40 | Bash | `npx vitest run tests/server/held-marker-non-boolean.test.ts tests/server/mode.test.ts tests/server/mode-release.test....` |
| 30 | 43 | Edit | `src/server/mode.ts` |
| 31 | 44 | Bash | `npx vitest run tests/server/held-marker-non-boolean.test.ts tests/server/mode.test.ts tests/server/mode-release.test....` |
| 32 | 47 | Edit | `src/server/mode.ts` |
| 33 | 48 | Bash | `npx vitest run tests/server/held-marker-non-boolean.test.ts tests/server/mode.test.ts tests/server/mode-release.test....` |
| 34 | 49 | Bash | `npx vitest run tests/server/held-marker-non-boolean.test.ts tests/server/mode.test.ts tests/server/mode-release.test....` |
| 35 | 50 | Bash | `npx tsc -p tsconfig.server.json --noEmit; npx tsc -p tsconfig.tests.node.json --noEmit; echo tsc-done` |
| 36 | 51 | Bash | `npx biome check src/server/mode.ts src/server/mcp/annotations.ts src/server/mcp/routes/mode-release.ts tests/server/h...` |
| 37 | 54 | Grep | `heldInSolo\|hideFromAI\|CHANGELOG\|changelog` |
| 38 | 55 | Bash | `for f in docs/architecture.md:315 docs/architecture.md:617 docs/architecture.md:1180 docs/architecture.md:1303 docs/g...` |
| 39 | 56 | Grep | `.{0,200}(heldInSolo\|hideFromAI).{0,300}` |
| 40 | 57 | Bash | `grep -o ".\{0,250\}heldInSolo.\{0,300\}" docs/architecture.md docs/gotchas.md docs/security.md \| head -20` |
| 41 | 58 | Grep | `heldInSolo[^.]{0,200}(=== true\|marker\|indeterminate)` |
| 42 | 59 | Grep | `heldInSolo[^.]{0,200}(=== true\|marker\|indeterminate)[^.]{0,200}` |
| 43 | 62 | Grep | `^## \|#2460` |
| 44 | 63 | Read | `CLAUDE.md` |
| 45 | 65 | Read | `CHANGELOG.md` |
| 46 | 66 | Edit | `CHANGELOG.md` |
| 47 | 68 | Write | `AUDIT.md` |

## Appendix B: ordered tool calls, trusted re-run (section 8)

| # | Turn | Tool | Target |
|---|---|---|---|
| 1 | 2 | Grep | `heldInSolo` |
| 2 | 3 | Read | `src/server/mode.ts` |
| 3 | 4 | Read | `src/server/mcp/annotations.ts` |
| 4 | 6 | Grep | `replyPrivacyAllows\|hideFromAI\(\|heldInSolo ===\|heldInSolo !==` |
| 5 | 8 | Read | `src/server/annotations/projection.ts` |
| 6 | 9 | Read | `src/server/mcp/routes/mode-release.ts` |
| 7 | 11 | Read | `src/server/events/queue.ts` |
| 8 | 14 | Read | `src/server/annotations/held-in-solo.ts` |
| 9 | 16 | Edit | `src/server/mode.ts` |
| 10 | 17 | Edit | `src/server/mcp/annotations.ts` |
| 11 | 18 | Edit | `src/server/mcp/routes/mode-release.ts` |
| 12 | 19 | Edit | `src/server/mcp/routes/mode-release.ts` |
| 13 | 20 | Grep | `from "\.\./mode\.js"` |
| 14 | 21 | Edit | `src/server/mcp/annotations.ts` |
| 15 | 23 | Grep | `hideFromAI\|heldInSolo: "true"\|indeterminate` |
| 16 | 24 | Grep | `hideFromAI\|indeterminate` |
| 17 | 25 | Read | `tests/server/mode.test.ts` |
| 18 | 27 | Edit | `tests/server/mode.test.ts` |
| 19 | 28 | Edit | `tests/server/mode.test.ts` |
| 20 | 30 | Grep | `indeterminate` |
| 21 | 31 | Grep | `heldInSolo.*indeterminate\|indeterminate.*heldInSolo\|setMode\(undefined\)\|clearMode\|removeMode` |
| 22 | 32 | Read | `tests/server/mcp-tool-integration.test.ts` |
| 23 | 34 | Read | `tests/server/awareness-tools.test.ts` |
| 24 | 35 | Read | `tests/server/awareness-tools.test.ts` |
| 25 | 37 | Edit | `tests/server/awareness-tools.test.ts` |
| 26 | 38 | Grep | `Y_MAP_ANNOTATION_REPLIES\|tandem_exportAnnotations` |
| 27 | 39 | Read | `tests/server/mcp-tool-integration.test.ts` |
| 28 | 41 | Read | `tests/server/mcp-tool-integration.test.ts` |
| 29 | 42 | Grep | `function setMode\|beforeEach\|afterEach` |
| 30 | 44 | Edit | `tests/server/mcp-tool-integration.test.ts` |
| 31 | 46 | Read | `tests/server/mode-release.test.ts` |
| 32 | 47 | Edit | `tests/server/mode-release.test.ts` |
| 33 | 48 | Bash | `npx vitest run tests/server/mode.test.ts tests/server/mode-release.test.ts tests/server/awareness-tools.test.ts tests...` |
| 34 | 51 | Bash | `cp src/server/mode.ts /tmp/claude-0/-home-user-audit-2481/5930a83b-522b-47ba-bb33-2e005138bb74/scratchpad/mode.bak &&...` |
| 35 | 53 | Edit | `src/server/mode.ts` |
| 36 | 54 | Bash | `npx vitest run tests/server/mode.test.ts tests/server/mode-release.test.ts tests/server/awareness-tools.test.ts tests...` |
| 37 | 56 | Edit | `src/server/mode.ts` |
| 38 | 57 | Bash | `npx vitest run tests/server/mode.test.ts tests/server/mode-release.test.ts tests/server/mode-release-race.test.ts tes...` |
| 39 | 58 | Bash | `npx tsc -p tsconfig.tests.node.json --noEmit 2>&1 \| tail -5; npx biome check src/server/mode.ts src/server/mcp/annota...` |
| 40 | 61 | Grep | `heldInSolo[^\n]{0,40}(=== ?true\|literally\|boolean)\|hideFromAI` |
| 41 | 62 | Bash | `sed -n 617p docs/architecture.md \| cut -c1-1500; echo ----; sed -n 3560p docs/decisions.md \| grep -o ".\{300\}heldInS...` |
| 42 | 65 | Write | `AUDIT.md` |
