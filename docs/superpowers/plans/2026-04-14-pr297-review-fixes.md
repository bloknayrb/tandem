# PR #297 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address the IMPORTANT and LOW findings from the PR #297 review — add real async-EPIPE test coverage and fix two comment drifts in `src/monitor/index.ts`.

**Architecture:** Extract the inner stdout-error handler as a pure, testable function exposed via the existing `_resetMonitorStateForTests` style test seam. Add a direct unit test that asserts the handler logs to stderr and exits 1. The `IS_VITEST` gate on `installStdoutErrorHandler()` stays (prevents real-listener accumulation across tests), but the handler logic itself becomes directly testable.

**Tech Stack:** TypeScript, vitest, Node.js `process.stdout`, `process.exit`.

---

## Context: Review Findings Disposition

| Finding | Severity | Disposition |
| --- | --- | --- |
| CHANGELOG.md `[0.6.0]` header empty | CRITICAL (claimed) | **FALSE POSITIVE** — verified post-state on branch (lines 8–36): `## [Unreleased]` is the empty placeholder, `## [0.6.0] - 2026-04-14` correctly owns all Added/Changed/Fixed subsections. No action. |
| Async EPIPE handler untested | IMPORTANT | **Fix** in Tasks 1–3. |
| Comment drift: "one-shot" vs `.on` at `src/monitor/index.ts:357` | LOW | **Fix** in Task 4. |
| Comment wording: sync-EPIPE framing at `src/monitor/index.ts:352-358` | LOW | **Fix** in Task 4 (same block). |
| Positive observations | — | Preserve; no action. |

## File Structure

**Modified:**
- `src/monitor/index.ts` — extract `onStdoutError(err)` inner handler; expose via `_monitorTestExports` named export; soften misleading comments at lines 352–358 and 357.
- `tests/monitor/sse-parsing.test.ts` — add a new `describe("installStdoutErrorHandler")` block with a single test that invokes the exported handler directly and asserts `console.error` + `process.exit(1)`.

**Not modified:** CHANGELOG.md (false-positive finding), version-bump files, shutdown.test.ts (existing console.error assertion already correct).

---

## Task 1: Add failing test for the `onStdoutError` handler

**Files:**
- Modify: `tests/monitor/sse-parsing.test.ts` (append new `describe` block at end of file, before final closing)

**Rationale:** The PR fixes a silent failure where async EPIPE caused `lastEventId` to advance past lost events. The existing `EPIPE on stdout.write` test covers only the synchronous throw path (the ordering invariant); it does not exercise the new `installStdoutErrorHandler()` code at all. A future refactor that deletes the handler would still pass CI today. This test fences the actual behavior: "when stdout emits 'error', the process logs to stderr and exits 1."

- [ ] **Step 1.1: Append the failing test to `tests/monitor/sse-parsing.test.ts`**

Open `tests/monitor/sse-parsing.test.ts` and add this block immediately after the closing `});` of the existing `describe("EPIPE on stdout.write", ...)` block (after current line 195) and before `describe("SSE resume behavior", ...)`:

```typescript
describe("installStdoutErrorHandler (async EPIPE)", () => {
  it("logs stderr and exits 1 when stdout emits 'error' (async EPIPE)", async () => {
    // The PR's headline fix: process.stdout.write does NOT synchronously throw
    // on EPIPE. Node emits an 'error' event asynchronously when the plugin-host
    // read end closes mid-stream. Without a listener, writes keep advancing
    // lastEventId past events that never arrived. This test fences that the
    // handler (a) logs to stderr so support has a trail, and (b) exits 1 so
    // the plugin host respawns us with a fresh stdout.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const mod = await import("../../src/monitor/index.js");
    const err = new Error("EPIPE");

    mod._monitorTestExports.onStdoutError(err);

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("stdout error"),
      err,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `npx vitest run tests/monitor/sse-parsing.test.ts -t "installStdoutErrorHandler"`

Expected: FAIL with a message like `TypeError: Cannot read properties of undefined (reading 'onStdoutError')` or `_monitorTestExports is not defined` — because neither the export nor the named handler exists yet.

---

## Task 2: Extract `onStdoutError` and expose via `_monitorTestExports`

**Files:**
- Modify: `src/monitor/index.ts:476-491` (the `installStdoutErrorHandler` function and its JSDoc)
- Modify: `src/monitor/index.ts` end-of-file (add `_monitorTestExports` after existing `_resetMonitorStateForTests` export near line 614)

**Rationale:** The handler body is a single call — logging + `process.exit(1)`. Extracting it as a module-level function lets the test invoke it with a mocked `process.exit` without needing to spawn a real subprocess or emit on the real `process.stdout`. The `IS_VITEST` short-circuit on the installer stays in place so importing the module during a test run does not register real listeners on `process.stdout`.

- [ ] **Step 2.1: Replace the `installStdoutErrorHandler` block**

Find this block at `src/monitor/index.ts:476-491`:

```typescript
/**
 * `process.stdout.write` does NOT synchronously throw on EPIPE. Node emits
 * an 'error' event asynchronously when the downstream pipe (plugin host)
 * closes its read end mid-stream. Without this handler, writes after the
 * close are silently dropped and the retry loop keeps advancing
 * lastEventId past events that never arrived — the next reconnect's
 * Last-Event-ID header then skips the lost range. Exit 1 so the plugin
 * host can respawn us with a fresh stdout instead.
 */
function installStdoutErrorHandler(): void {
  if (IS_VITEST) return;
  process.stdout.on("error", (err) => {
    console.error("[Monitor] stdout error (plugin-host pipe likely closed):", err);
    process.exit(1);
  });
}
```

Replace it with:

```typescript
/**
 * Async EPIPE handler. `process.stdout.write` does NOT synchronously throw
 * on EPIPE — Node emits an 'error' event asynchronously when the downstream
 * pipe (plugin host) closes its read end mid-stream. Without this handler,
 * writes after the close are silently dropped and the retry loop keeps
 * advancing lastEventId past events that never arrived; the next reconnect's
 * Last-Event-ID header then skips the lost range. Logging to stderr keeps a
 * trail for support; exit 1 so the plugin host respawns us with a fresh
 * stdout instead of wedging on a dead pipe.
 */
function onStdoutError(err: Error): void {
  console.error("[Monitor] stdout error (plugin-host pipe likely closed):", err);
  process.exit(1);
}

function installStdoutErrorHandler(): void {
  if (IS_VITEST) return;
  process.stdout.on("error", onStdoutError);
}
```

- [ ] **Step 2.2: Add `_monitorTestExports` named export**

Find the `_resetMonitorStateForTests` function in `src/monitor/index.ts` (currently at line 603). Immediately after its closing `}` (currently line 614), add:

```typescript

/**
 * Test-only exports. DO NOT import from production code.
 * Grouped in a single namespace so production imports never accidentally
 * pull handler internals.
 */
export const _monitorTestExports = {
  onStdoutError,
};
```

- [ ] **Step 2.3: Run the failing test to verify it now passes**

Run: `npx vitest run tests/monitor/sse-parsing.test.ts -t "installStdoutErrorHandler"`

Expected: PASS (1 test).

- [ ] **Step 2.4: Run typecheck to catch any type regressions**

Run: `npm run typecheck`

Expected: exit code 0, no errors.

---

## Task 3: Run the full monitor test suite to verify no regressions

**Files:** none modified.

**Rationale:** Task 2 renamed no public symbols and added one named export. Other monitor tests share `IS_VITEST` gates and `_resetMonitorStateForTests`; confirming they still pass rules out any subtle listener-state interaction.

- [ ] **Step 3.1: Run full monitor test suite**

Run: `npx vitest run tests/monitor/`

Expected: all monitor tests pass (was 45 before PR #297; should be 46 now with the new test).

- [ ] **Step 3.2: Run full unit test suite as a belt-and-braces check**

Run: `npm test`

Expected: 1121 pass (was 1120 before), 2 skipped. Count may differ if other PRs have landed on master since — the PASS with no new failures is the signal.

---

## Task 4: Fix misleading comments at `src/monitor/index.ts:352-358`

**Files:**
- Modify: `src/monitor/index.ts:352-358`

**Rationale:** The current comment (a) says "one-shot stdout 'error' listener" but the code uses `.on`, not `.once` (minor drift — future reader reasoning about lifecycle gets wrong info); (b) frames the sync-throw path as the primary EPIPE case when in practice Node delivers EPIPE on `process.stdout` asynchronously via `emit('error')`. Both nits came from the comment-analyzer and silent-failure-hunter agents independently.

- [ ] **Step 4.1: Replace the false-checkpoint-guard comment block**

Find at `src/monitor/index.ts:352-358`:

```typescript
        // False-checkpoint guard: `onEventId(eventId)` MUST stay below the
        // write. A synchronous EPIPE throw propagates out of the loop and the
        // retry layer handles it; the ordering ensures lastEventId never
        // advances past an event that didn't make it to stdout. Asynchronous
        // EPIPE (plugin host closes mid-stream, write buffered but not
        // flushed) is caught by the one-shot stdout 'error' listener
        // installed in main() → process.exit(1).
```

Replace with:

```typescript
        // False-checkpoint guard: `onEventId(eventId)` MUST stay below the
        // write so lastEventId never advances past an event that didn't
        // make it to stdout. EPIPE on process.stdout is almost always
        // async — Node emits 'error' after the close; see installStdoutErrorHandler,
        // which calls process.exit(1) so the plugin host respawns us. A
        // synchronous throw (rare) would propagate out of the loop and the
        // retry layer would handle it; either way, the order below is what
        // closes the silent-advance hole.
```

- [ ] **Step 4.2: Run the monitor tests again to confirm comment change didn't touch logic**

Run: `npx vitest run tests/monitor/`

Expected: still 46 pass.

---

## Task 5: Commit and push

**Files:** all staged changes from Tasks 1–4.

- [ ] **Step 5.1: Review the diff**

Run: `git status && git diff src/monitor/index.ts tests/monitor/sse-parsing.test.ts`

Expected: 2 files modified; roughly +30 / -8 lines.

- [ ] **Step 5.2: Stage and commit**

```bash
git add src/monitor/index.ts tests/monitor/sse-parsing.test.ts
git commit -m "$(cat <<'EOF'
test(monitor): fence async EPIPE handler behavior + comment fixes

Review follow-ups from PR #297:
- Extract onStdoutError handler and expose via _monitorTestExports
  so the async-EPIPE path (not just the sync regression fence) has
  direct test coverage.
- Fix comment drift at index.ts:352-358 — handler uses .on not .once,
  and EPIPE on process.stdout is almost always async.

CHANGELOG [0.6.0] header structure verified correct; review claim
was a false positive (only read the diff insert, not the post-state).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5.3: Push to PR branch**

Run: `git push origin fix/monitor-epipe-async-handler`

Expected: push succeeds; CI will re-run on the PR.

- [ ] **Step 5.4: Verify PR CI status**

Run: `gh pr checks 297`

Expected: checks either running or green. If they go red, the push still closed the review gaps; investigate failures in a separate pass.

---

## Self-Review Notes

- Spec coverage: all three real findings (async-test gap, two comment drifts) map to tasks. CHANGELOG false-positive documented in the disposition table.
- No placeholders. Every step has exact code or an exact command.
- Type consistency: `onStdoutError` signature (`(err: Error) => void`) matches what `process.stdout.on("error", ...)` expects. `_monitorTestExports` is a named export (not default) so the test import syntax is correct.
- Test seam design rationale: exporting the handler (not unhiding `installStdoutErrorHandler`) avoids relisitening on real `process.stdout` during tests, which is the original reason for the `IS_VITEST` gate. The test exercises the handler's behavior, not the wiring — which is acceptable because the installer is a single line (`process.stdout.on("error", onStdoutError)`), visually auditable.
