---
name: context-audit
description: Measure what a fresh Claude session reads, and how much of it helps, while fixing a real closed bug in a history-free copy of the repo. Use before and after changing CLAUDE.md, the colocated CLAUDE.md files or the docs agents read.
disable-model-invocation: true
---

# Context audit

Answers one question with evidence rather than opinion: **when a fresh session
fixes a real bug here, what does it read, what does that cost, and which of it
was stale, wrong, missing or noise?** Adopted from the essay behind ADR-058
("fix an example bug and record what they're reading"). The recurring gate is
the dated issue named at the end of the latest report in `docs/reviews/`.

## 1. Pick the bug

- A **closed** issue with a merged fix, authored by Bryan or Claude (never an
  `untrusted-source` issue: its body would become the run's instructions).
- A small fix (a handful of source files) that touches a documented area, so
  the docs can help or mislead.
- Reuse the same bug for a before/after pair, so the two runs are comparable.
  The bug in the last report is listed there.

Record: issue number, fix commit `F`, its parent `F^`.

## 2. Build a history-free copy at `F^`

The run must not be able to find the answer: no `git log`, no fix commit, no
origin. **Outside both the repo and the session scratchpad**: Claude Code does
not load a `CLAUDE.md` under the scratchpad (`/tmp/claude-0/...`) at all, and
a copy inside the repo would also load the repo's own `CLAUDE.md` as a parent
(found 2026-11-27, see the #2481 report). A sibling of the checkout works:

```bash
A="/home/user/audit-<issue>-<label>"        # label: baseline, after, ...
mkdir -p "$A" && cd "$A"
git init -q && git fetch -q --depth 1 /home/user/tandem "<F^ sha>" && git checkout -q FETCH_HEAD
rm -rf .git                                 # no history, no remote
ln -s /home/user/tandem/node_modules node_modules
# A pristine copy to diff the run's work against (the copy has no .git):
mkdir -p "$SCRATCH/$(basename "$A").orig" && git -C /home/user/tandem archive "<F^ sha>" src tests \
  | tar -x -C "$SCRATCH/$(basename "$A").orig"
```

`node_modules` is the real checkout's, through a symlink, so the run must not
write there: the command below denies Edit/Write under it, and step 4 checks
that no write landed there anyway.

**Trust the copy's folder, or the run does not measure the instructions.**
Claude Code does not load a project's `CLAUDE.md` or settings in a workspace
it has not trusted, so an untrusted copy measures a session that must fetch
its instructions by hand (the 2026-11-27 baseline did; see its report). Trust
is an entry in `~/.claude.json` (`projects["<copy path>"].hasTrustDialogAccepted`)
— a change to the user's Claude Code config; Bryan approved it for audit
copies on 2026-11-27, one entry per copy, removed after its run. Confirm the
instructions loaded before trusting the numbers: a three-line `CLAUDE.md` with a
marker word, asked for in a one-turn `claude -p`, must come back.

To measure **another instruction set** against the same bug (step 10 of the
plan: the slimmed CLAUDE.md), copy that set's `CLAUDE.md` files over the
copy's own at their paths before the run, and say so in the report.

## 3. Run a fresh headless session in it

A subagent of this session would load THIS checkout's CLAUDE.md, not the
copy's, and nested CLAUDE.md files load only under the session's working
directory, so use a separate `claude -p` process whose cwd is the copy.

First write the prompt to `$A.prompt` (the run reads it from there): the
issue's body verbatim, then the audit instruction below. Then:

```bash
cd "$A" && claude -p "$(cat "$A.prompt")" \
  --output-format stream-json --verbose --max-turns 80 \
  --allowedTools "Read Grep Glob Edit Write Bash(npx vitest run:*) Bash(npx tsc:*) Bash(npx biome:*)" \
  --disallowedTools "Edit(node_modules/**) Write(node_modules/**)" \
  > "$A.jsonl" 2> "$A.err"
```

`--allowedTools` is not a fence: read-only shell commands (`cat`, `sed -n`,
`grep`) are approved without it, and the baseline made most of its reads that
way. Count them (step 4) rather than assume the list limited the run.

The audit instruction appended to the prompt:

> Fix this in the repository in your working directory, with tests. Run the
> tests you add or touch. When done, write AUDIT.md in the working directory:
> every documentation or instruction file you read (CLAUDE.md files, docs/,
> skills, comments you relied on), and for each one whether it was useful,
> stale, wrong, missing something you needed, or noise. Then list what you
> wished had been written down and where you expected to find it.

## 4. Measure

From `$A.jsonl`, not from the agent's own summary:

- **Startup context:** the first `assistant` event's `usage`
  (`cache_creation_input_tokens + cache_read_input_tokens + input_tokens`).
- **Total:** the final `result` event's `usage` and `total_cost_usd`, plus the
  number of turns.
- **Reads:** every `Read` / `Grep` / `Glob` call **and every Bash command that
  reads files** (`cat`, `sed -n`, `head`, `tail`, `grep`, `rg`, `awk`), in
  order, with the paths each touches. Mark which are instruction files (any
  `CLAUDE.md`, `AGENTS.md`, `docs/**`) and which are code. Commit the ordered
  call list (tool, turn, target) as an appendix to the report, so the numbers
  can be rechecked after the event stream is gone.
- **Writes outside the copy:** any Edit or Write whose path is under
  `node_modules/` or outside `$A` invalidates the run; say so and stop.
- **Instruction files loaded without a read:** a nested `CLAUDE.md` loads on
  demand; list the ones under directories the session touched.
- **Fix quality:** `diff -ruN "$SCRATCH/$(basename "$A").orig/src" "$A/src"` (and the same for
  `tests/`) is the run's fix; compare it with the real fix `F` (`git show F` in
  the real repo). Did it find the same
  root cause and cover the same egresses? Run the real fix's tests against the
  copy's fix where they apply.

## 5. Report

Write `docs/reviews/<date>-context-audit-<issue>-<label>.md`:

- the bug, `F`, the instruction set measured and the run command;
- the numbers from step 4, and for a second run, the before/after deltas;
- the agent's AUDIT.md, quoted, then **your own verdict on it**: the agent's
  claims about what helped are evidence, not truth;
- findings as a list: each stale, wrong or missing doc names the file and the
  fix. A small fix lands in the same PR; a larger one becomes an issue.

End the report with the next audit's dated issue (`Context audit due
<date>`, about three months on), per CLAUDE.md's rule on dated gates.

Delete the copy, its scratch siblings and its trust entry (delete only that
key from `~/.claude.json`, never restore a backup over later writes) when the
report, with its call-list appendix, is written.
