# Baseline run — summary

Full `npx vitest run` on rev 3114531, Windows 11. The raw reporter output (a 1.7 MB log and a
3.7 MB JSON report) is not committed — `*.log` is gitignored and the JSON is too large to be
useful in review. This file carries the part that is evidence.

```
 Test Files  1 failed | 643 passed | 1 skipped (645)
      Tests  3 failed | 10809 passed | 41 skipped (10853)
   Start at  15:34:53
   Duration  459.53s (transform 104.07s, setup 0ms, import 810.90s, tests 1426.96s, environment 344.58s)
```

## The three failures

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |node| tests/server/docx-apply.test.ts > applyChangesCore — write guards > does not refuse on mtime drift within the tolerance
Error: Test timed out in 60000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/server/docx-apply.test.ts:1099:3
    1097|   });
    1098|
    1099|   it(
       |   ^
    1100|     "does not refuse on mtime drift within the tolerance",
    1101|     async () => {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯

 FAIL  |node| tests/server/docx-apply.test.ts > applyChangesCore — write guards > the watcher reload that completes an apply finally lands (#1749) — clean doc
Error: Test timed out in 60000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/server/docx-apply.test.ts:1137:3
    1135|   );
    1136|
    1137|   it(
       |   ^
    1138|     "the watcher reload that completes an apply finally lands (#1749) …
    1139|     async () => {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯

 FAIL  |node| tests/server/docx-apply.test.ts > applyChangesCore — write guards > the watcher reload that completes an apply flags a conflict on a DIRTY doc (#1749)
Error: Test timed out in 60000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/server/docx-apply.test.ts:1185:3
    1183|   );
    1184|
    1185|   it(
       |   ^
    1186|     "the watcher reload that completes an apply flags a conflict on a …
    1187|     async () => {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯
```

## The same file run in isolation

```
     ✓ marks the imported Word comment done after its promoted suggestion is applied  1774ms
     ✓ resolves nothing for an accepted suggestion that carries no importSource  1698ms

 Test Files  1 passed (1)
      Tests  52 passed | 1 skipped (53)
   Start at  15:43:28
   Duration  25.77s (transform 2.11s, setup 0ms, import 3.40s, tests 22.08s, environment 0ms)

EXIT=0
```

313s under full-suite parallelism against 25.77s alone; 52 passed, 0 failed. Load-induced
flakiness on Windows, not a defective oracle. Not repaired — out of scope for a review.
