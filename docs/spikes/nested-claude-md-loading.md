# Spike: which actions load a nested CLAUDE.md?

**Date:** 2026-11-27
**Claude Code:** `2.1.332 (Claude Code)`, headless (`claude -p --output-format stream-json --verbose`), `--model haiku`
**Platform:** linux/x64 (cloud container)
**Answers:** precondition 0 of step 9 in the CLAUDE.md slimming plan (ADR-058): rule (b) moves a rule into
`D/CLAUDE.md` only if the file is in context whenever the rule can be broken. This records which
actions actually put it there.

## Method

A throwaway repo outside the session scratchpad, so its instructions load (the 2026-11-27 context
audit found that nothing under `/tmp/claude-0/…` loads a CLAUDE.md, trusted or not; see section 8
of `docs/reviews/2026-11-27-context-audit-2481-baseline.md`, added by #2592).
It had no trust entry.

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
| c4, c4b | Bash `cat src/server/a.ts`, then `cat src/server/b.ts` | **yes** (both runs) |
| c13 | Bash `sed -n 1p src/server/a.ts` | **yes** |
| c14 | Bash `head -1 src/server/a.ts` | **yes** |
| c5 | `Grep` pattern `export`, path `src/server` | no |
| c6 | `Glob` `src/server/*.ts` | no |
| c10, c10b | Bash `sed -i 's/1/5/' src/server/a.ts` (a write) | no (both runs) |
| c11 | Bash `grep -rn export src/server` | no |
| c12 | Bash `ls src/server` | no |
| c7 | a general-purpose subagent runs `Read src/server/b.ts` | **yes, in the subagent's context** (the parent read nothing, so it has the file only if it reads under the directory itself) |
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
  - **a parent session whose subagent did the reading.** The rules reach the subagent's context
    and not the parent's, so a parent that then edits on the subagent's report has not seen them.
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
