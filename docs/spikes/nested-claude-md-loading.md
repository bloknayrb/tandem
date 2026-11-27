# Spike: which actions load a nested CLAUDE.md?

**Date:** 2026-11-27
**Claude Code:** `2.1.332 (Claude Code)`, headless (`claude -p --output-format stream-json --verbose`), `--model haiku`
**Platform:** linux/x64 (cloud container)
**Answers:** a precondition of a planned slimming of the root `CLAUDE.md` (the review-tier decision
that frames it is ADR-058, proposed in #2589). The plan lets a rule leave the auto-loaded root
`CLAUDE.md` for a per-directory `D/CLAUDE.md` only when every way to break the rule goes through a
file under `D`, so that the directory's file is in context exactly when the mistake becomes
possible. That holds only for the actions that actually load `D/CLAUDE.md`, and this spike records
which those are.

## Method

A throwaway repo under `/home/user`, outside both the checkout and the session scratchpad, with no
trust entry. The location matters. Earlier the same day, a probe found that a three-line
`CLAUDE.md` holding a marker word never loaded in a copy under the session scratchpad
(`/tmp/claude-0/…`). That held whether or not the folder was trusted and whether or not it had a
`.git`. The same copy moved under `/home/user` loaded at once. That probe is written up in the
context-audit baseline report that #2592 adds.

```
CLAUDE.md             "ROOTMARK-7731: root instructions file."
src/server/CLAUDE.md  "NESTMARK-4419: nested src/server instructions file."
src/server/a.ts, src/server/b.ts, src/client/c.ts   (one-line exports)
```

Each case was a fresh `claude -p` from a clean tree, told to do exactly one action and then end
with `MARKERS:` listing every token of the form `CAPITALLETTERS-dddd` in its context that it did not
write, and never to read a CLAUDE.md directly. The stream-json does not show the attachment itself,
so the evidence is the model echoing `NESTMARK-4419`. It cannot guess four random digits, and the
control cases never echoed it. Every case echoed `ROOTMARK-7731`.

## Results

| Case | Action | Nested file loaded |
|---|---|---|
| c0 | no tool, cwd = repo root | no |
| c1 | `Read src/server/a.ts` | **yes** |
| c2 | `Edit src/server/a.ts` (the Edit tool requires a Read first, so it ran Read then Edit) | **yes** |
| c3 | `Write` creating the new file `src/server/new.ts`, nothing read | **yes** |
| c4 | Bash `cat src/server/a.ts` | **yes** |
| c4b | Bash `cat src/server/b.ts`, in its own fresh session (a repeat of c4 on the other file) | **yes** |
| c13 | Bash `sed -n 1p src/server/a.ts` | **yes** |
| c14 | Bash `head -1 src/server/a.ts` | **yes** |
| c5 | `Grep` pattern `export`, path `src/server` | no |
| c6 | `Glob` `src/server/*.ts` | no |
| c10, c10b | Bash `sed -i 's/1/5/' src/server/a.ts` (a write) | no (both runs) |
| c11 | Bash `grep -rn export src/server` | no |
| c12 | Bash `ls src/server` | no |
| c7 | a general-purpose subagent runs `Read src/server/b.ts` | **yes, in the subagent's context**. Observed from the subagent's own final report, which arrives in the parent's stream as the Agent tool's result and ends `MARKERS: ROOTMARK-7731, NESTMARK-4419`. The parent made no file call itself. |
| c8 | no tool, cwd = `src/server` | **yes, at startup** |
| c9 | control: `Read src/client/c.ts` | no |

## What this means for rule (b)

- **It holds for:** the Read, Edit and Write tools (Write even for a new file nothing has read),
  single-file read commands through Bash (`cat`, `sed -n`, `head`), a subagent's own reads, and a
  session started inside the directory.
- **Named residuals, where the nested file is NOT loaded:**
  - **writes through Bash**, such as `sed -i` (the case CLAUDE.md's rules are most often broken by:
    codemods, `eslint --fix`, heredoc rewrites, `git apply`);
  - **Grep, Glob and multi-file Bash searches** (`grep -r`, `ls`). These only find code, but an
    agent that edits from what a search returned, without a Read, never sees the rules;
  - **a parent session whose subagent did the reading.** The file is attached in the subagent's
    context. [Inference] The parent gets only what the subagent's report repeats. In c7 that was
    the marker, because the prompt asked for it, but an ordinary report need not carry the rules.
    A parent that edits on such a report without a Read of its own has not been shown them. This
    run did not test what the parent's context holds beyond the relayed text.
- [Inference] Claude Code appears to recognise a single file path in a read-only Bash command and
  attach the nested CLAUDE.md for it. Commands that write, or take a directory, get nothing. This is
  observed behaviour on one build, not documented behaviour, so step 9 must treat it as liable to
  change.

## Limits

- One build (`2.1.332`), one platform, headless only. An interactive session was not tested.
- Each case ran once, except the Bash `cat` and `sed -i` cases, which ran twice with the same result.
- Detection depends on the model reporting the marker. A false negative is possible in principle.
  None was seen in the cases where loading was expected, and no false positive appeared in the
  controls.
- Not tested: `NotebookEdit`, MCP tools that touch files, paths given as absolute or `../`, and a
  CLAUDE.md nested more than one level below the root.
