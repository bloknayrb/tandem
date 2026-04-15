# PR #285 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address every finding from the 4-agent review of PR #285 ("Add Claude Code plugin support with real-time event monitor") — fix misleading skill guidance, harden the monitor's error handling / retry semantics / shutdown path, and add behavioral test coverage for the 243 lines of currently-untested networking code.

**Architecture:** Three-phase work on top of the existing PR branch (`claude/refine-local-plan-6YSg8`). Phase A collapses the dual-source-of-truth for SKILL.md and fixes the misleading `question` guidance. Phase B re-orders monitor error handling around three invariants: *never silently drop a user signal*, *always surface a visible failure*, *never block the hot path on slow I/O*. Phase C adds a `tests/monitor/` harness driven by stubbed `fetch` + controllable `ReadableStream` so every branch has a regression test.

**Tech Stack:** TypeScript, Node 22 fetch/ReadableStream, vitest with fake timers + `vi.stubGlobal`, tsup bundler, Zod schemas.

**Branch strategy:** Check out PR #285 (`gh pr checkout 285`) and commit directly on `claude/refine-local-plan-6YSg8`. Each task ends with a commit; push after Phase A, Phase B, Phase C, Phase D to keep the PR review cycle flowing.

**Plan-review corrections applied (2026-04-13):** Two review agents independently surfaced:
- **Module state bleed across tests.** Vitest isolates modules per *file*, not per test. The monitor's module-level `cachedMode`, `cachedModeAt`, `modeRefreshInFlight`, and signal-handler registrations will contaminate sibling tests. Addressed by **Task B0b** which exports a `_resetMonitorStateForTests()` helper called in every `beforeEach` + guards the module-level `console.*` redirect behind `VITEST !== "true"`.
- **Signal listener accumulation.** Every test that invokes `main()` re-registers `process.on("SIGINT", ...)` handlers. Addressed by having `installShutdownHandlers()` bail if `VITEST === "true"` (tests drive `shutdownForTests` directly) and having `_resetMonitorStateForTests()` remove any stray listeners.
- **Finding #9 only commented, not fixed.** C2 originally only documented the `tandem-channel` backward-compat intent without addressing the duplicate-events bug. **Task C2 is now rewritten** to drop `tandem-channel` from new installs (with an opt-in `--with-channel-shim` flag for users on older setups).
- **No docs/CHANGELOG updates.** Per project convention (`feedback_docs_always_current.md`), every code change requires doc updates. Added **Phase D (D1-D4)** for `CHANGELOG.md`, `docs/architecture.md`, `docs/lessons-learned.md`, and `README` + migration note.
- **B12 contract drift.** B12 adds `getModeSync` + `refreshMode`; the rewrite accidentally made `getCachedMode` unused. Clarified: `getCachedMode` is **preserved unchanged** (B3 semantics) and `refreshMode` is an **additional** background variant that fails open-stale (leaves cache unchanged). Hot path uses `refreshMode` + `getModeSync`; startup warm uses `getCachedMode`.
- **AbortSignal.timeout + fake timers.** Vitest's `useFakeTimers()` defaults may not fake `AbortSignal.timeout`. B0b's harness now pins the fake-timer config explicitly.
- **Windows path case.** The `isDirectRun` compare is case-insensitive on `win32` to avoid drive-letter casing drift.

---

## Context

PR #285 replaces the channel shim's event-delivery role with a plugin monitor (`src/monitor/index.ts`, 243 new lines) that streams SSE events to Claude Code via stdout. Four specialist review agents (code-reviewer, silent-failure-hunter, pr-test-analyzer, comment-analyzer) independently surfaced 10 material issues. The top three — misleading `question` annotation guidance in `SKILL.md`, silently-wrong `/api/mode` fallback direction, and retry counter that can both over-reset and under-reset — ship user-visible bugs the moment the plugin is installed. Zero behavioral tests exist for the new monitor, so any of these regress silently on future edits.

The review summary lives in the conversation above. This plan turns it into mergeable patches.

---

## File Structure

**New files:**

| File | Purpose |
|------|---------|
| `tests/monitor/fetch-harness.ts` | Shared helpers: stubbed `fetch`, controllable `ReadableStream` that yields SSE frames on demand, fake-timer-aware sleep, **module-state reset utility**. |
| `tests/monitor/exports.test.ts` | Smoke test asserting `main`/`connectAndStream`/`getCachedMode`/`_resetMonitorStateForTests` are exported. |
| `tests/monitor/retry.test.ts` | Retry counter reset semantics, exponential backoff, max-retries exit path. |
| `tests/monitor/mode-cache.test.ts` | `/api/mode` fail-closed, 2s TTL, don't-poison-on-failure, warm-on-startup. |
| `tests/monitor/sse-parsing.test.ts` | SSE frame boundaries, buffer overflow, malformed JSON, poisoned-event behavior. |
| `tests/monitor/shutdown.test.ts` | SIGINT/SIGTERM clears awareness before exit, pending timers cleaned up. |
| `tests/monitor/timeouts.test.ts` | `AbortSignal.timeout` on every fetch; hung server doesn't wedge monitor. |
| `tests/monitor/solo-filter.test.ts` | Non-chat events suppressed in solo mode; chat always delivered. |

**Modified files:**

| File | Why |
|------|-----|
| `skills/tandem/SKILL.md` | Fix `question` annotation guidance + complete highlight-color list. |
| `src/cli/skill-content.ts` | Refactor to read `skills/tandem/SKILL.md` at startup instead of mirroring its content as a string literal. |
| `src/monitor/index.ts` | All critical/important monitor fixes. |
| `src/cli/setup.ts` | `PACKAGE_ROOT` validation, `tandem-channel` backward-compat comment. |
| `.claude-plugin/plugin.json` | Reconcile description with `package.json`. |
| `tests/cli/skill-parity.test.ts` | **Delete** — obsolete once skill-content.ts reads the markdown at runtime. |

---

## Phase A — SKILL.md fixes

**Rationale:** Cheapest, highest-impact fixes. Every Claude instance shipped with PR #285 would otherwise look for a `"question"` annotation type that never reaches MCP (sanitized to `"comment" + directedAt: "claude"` at `src/shared/sanitize.ts:44-46`).

### Task A1: Collapse dual-source-of-truth for SKILL.md

**Files:**
- Modify: `src/cli/skill-content.ts`
- Delete: `tests/cli/skill-parity.test.ts` (replaced by runtime load — divergence becomes impossible)
- Context reference: `skills/tandem/SKILL.md` is the single source of truth; `src/cli/setup.ts:160` calls `atomicWrite(SKILL_CONTENT, skillPath)` — unchanged public API.

- [ ] **Step 1: Replace `skill-content.ts` body with a runtime file load**

```ts
/**
 * SKILL.md content installed to ~/.claude/skills/tandem/ by `tandem setup`.
 * Single source of truth lives at `skills/tandem/SKILL.md`. This module
 * reads that file at module load so the plugin install path and the
 * `tandem setup` install path always deliver byte-identical content.
 *
 * The file is shipped via package.json `files: ["skills/", ...]`, and the
 * CLI entry (dist/cli/index.js) is not self-contained — so at runtime the
 * relative path `../../skills/tandem/SKILL.md` resolves from either
 * dist/cli/ (npm install) or src/cli/ (tsx dev) to the package-root
 * `skills/tandem/SKILL.md`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(__dirname, "../../skills/tandem/SKILL.md");

export const SKILL_CONTENT = readFileSync(SKILL_PATH, "utf-8");
```

- [ ] **Step 2: Delete the skill-parity test**

```bash
git rm tests/cli/skill-parity.test.ts
```

- [ ] **Step 3: Run the existing setup tests to verify `installSkill()` still works**

Run: `npm test -- tests/cli/setup.test.ts`
Expected: PASS. All existing `installSkill` and `applyConfig` tests still pass because the public `SKILL_CONTENT` export is unchanged (same string, different source).

- [ ] **Step 4: Commit**

```bash
git add src/cli/skill-content.ts tests/cli/skill-parity.test.ts
git commit -m "refactor(setup): read SKILL.md at runtime, drop parity test

Single source of truth eliminates byte-identity drift. The parity test
enforced equality between two hand-maintained copies; with a runtime
load, divergence is impossible and the test is obsolete."
```

### Task A2: Fix misleading `question` annotation guidance in SKILL.md

**Files:**
- Modify: `skills/tandem/SKILL.md` (the "Annotation Guide" section, around line 50)

- [ ] **Step 1: Replace the `question` paragraph with guidance that matches sanitize.ts**

In `skills/tandem/SKILL.md`, find:

```
**User-created types:** `question` annotation is created by users, not Claude. When you see a `question` in `tandem_checkInbox` or `tandem_getAnnotations`, respond with a `tandem_comment` on the same range or `tandem_reply` for conversational answers.
```

Replace with:

```
**User questions to Claude.** Users can author a "question" annotation in the UI. The server normalizes it to `type: "comment"` with `directedAt: "claude"` before returning it — so when scanning `tandem_checkInbox` or `tandem_getAnnotations`, match on `type === "comment" && directedAt === "claude" && author === "user"`, not `type === "question"`. Respond with `tandem_reply` for conversational answers, or a new `tandem_comment` on the same range for a textual annotation.
```

- [ ] **Step 2: Verify setup tests still pass (SKILL_CONTENT now loads the edited file)**

Run: `npm test -- tests/cli/setup.test.ts`
Expected: PASS. The `installSkill` test that writes to a tmp dir will now contain the corrected guidance; no assertion currently inspects the exact `question` paragraph, so nothing breaks.

- [ ] **Step 3: Commit**

```bash
git add skills/tandem/SKILL.md
git commit -m "docs(skill): correct question annotation guidance

sanitizeAnnotation() rewrites type:\"question\" to type:\"comment\" with
directedAt:\"claude\" before it reaches MCP (src/shared/sanitize.ts:44-46),
so Claude never actually sees type===\"question\". Match on the sanitized
shape instead."
```

### Task A3: Complete the highlight color list

**Files:**
- Modify: `skills/tandem/SKILL.md` (the "Annotation Guide" → `tandem_highlight` bullet)

- [ ] **Step 1: Update the color list to match the schema**

`src/shared/types.ts:19` — `HighlightColorSchema = z.enum(["yellow", "red", "green", "blue", "purple"])`.

In `skills/tandem/SKILL.md`, find:

```
- **`tandem_highlight`** — Visual marker with a short note. Colors: green (verified/good), red (problem), yellow (needs attention). Use when the finding is self-evident from the color and a brief note.
```

Replace with:

```
- **`tandem_highlight`** — Visual marker with a short note. Colors (full set): `green` (verified/good), `red` (problem), `yellow` (needs attention), `blue` (informational), `purple` (style/tone). Prefer the first three for review work; `blue`/`purple` are available when a fourth/fifth category is meaningful. Use when the finding is self-evident from the color and a brief note.
```

- [ ] **Step 2: Commit**

```bash
git add skills/tandem/SKILL.md
git commit -m "docs(skill): list all five highlight colors

HighlightColorSchema accepts yellow/red/green/blue/purple. The curated
three-color guidance stays as the recommendation, with blue/purple
documented as available extensions."
```

---

## Phase B — Monitor hardening

**Rationale:** The monitor's current error handling leaks solo-mode events, hangs forever on slow fetches, double-counts or under-counts retries, and abandons awareness state with no shutdown hook. Each task below is a self-contained TDD cycle; commit after each.

**Setup task — create the test harness first so every subsequent task can drive against it.**

### Task B0: Create the monitor test harness

**Files:**
- Create: `tests/monitor/fetch-harness.ts`

The monitor is structured as a single `main()` that runs the `while (retries < MAX)` loop and a `connectAndStream(lastEventId, onEventId)` that does the SSE work. To test it we need:

1. A stubbed `fetch` that returns controllable `Response` objects.
2. A `ReadableStream<Uint8Array>` we can push SSE frames into on command.
3. A way to drive fake timers to advance past debounce / auto-clear / mode-TTL / retry-delay.
4. A way to run `main()` or `connectAndStream()` and capture `process.stdout.write` + `console.error`.

Task B1 onward will require `connectAndStream`, `main`, and `getCachedMode` to be **exported** from `src/monitor/index.ts`. We'll do that in Task B1. For now, just build the harness.

- [ ] **Step 1: Write the harness file**

```ts
// tests/monitor/fetch-harness.ts
import { vi } from "vitest";

/**
 * A controllable SSE stream. Test code calls .push() to emit bytes,
 * .end() to signal done, or .error(err) to reject the next read.
 */
export class ControllableStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  public readonly stream: ReadableStream<Uint8Array>;
  private encoder = new TextEncoder();

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
      },
    });
  }
  push(text: string) {
    this.controller?.enqueue(this.encoder.encode(text));
  }
  end() {
    this.controller?.close();
  }
  error(err: Error) {
    this.controller?.error(err);
  }
}

/**
 * Per-URL fetch behavior. Test code registers handlers keyed by URL
 * substring; unmatched URLs throw to fail loudly.
 */
export interface FetchHandler {
  (url: string, init?: RequestInit): Promise<Response> | Response;
}

export interface FetchStub {
  on(urlSubstr: string, handler: FetchHandler): void;
  /** Array of {url, init} for every fetch made. */
  readonly calls: Array<{ url: string; init?: RequestInit }>;
  install(): void;
  restore(): void;
}

export function createFetchStub(): FetchStub {
  const handlers: Array<{ url: string; handler: FetchHandler }> = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let original: typeof fetch | undefined;

  const stubFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    for (const { url: match, handler } of handlers) {
      if (url.includes(match)) {
        return handler(url, init);
      }
    }
    throw new Error(`[fetch-harness] Unhandled fetch: ${url}`);
  };

  return {
    calls,
    on(urlSubstr, handler) {
      handlers.push({ url: urlSubstr, handler });
    },
    install() {
      original = globalThis.fetch;
      vi.stubGlobal("fetch", stubFn);
    },
    restore() {
      if (original !== undefined) {
        vi.stubGlobal("fetch", original);
      }
    },
  };
}

/** Build a Response whose body is a ControllableStream. */
export function sseResponse(stream: ControllableStream, init?: ResponseInit): Response {
  return new Response(stream.stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

/** Frame helper: wrap a TandemEvent object into SSE wire format. */
export function sseFrame(event: unknown, id?: string): string {
  const parts: string[] = [];
  if (id) parts.push(`id: ${id}`);
  parts.push(`data: ${JSON.stringify(event)}`);
  return parts.join("\n") + "\n\n";
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/monitor/fetch-harness.ts
git commit -m "test(monitor): add fetch + SSE stream harness

Shared test infrastructure: stubbed global fetch with per-URL handlers,
ControllableStream for pushing SSE frames on demand, sseFrame() helper
for building wire-format events. Used by all tests/monitor/*.test.ts."
```

### Task B0b: Add test-reset helper + harness state control

**Why:** Vitest isolates modules per **file**, not per test. Without an explicit reset, `cachedMode`, `cachedModeAt`, `modeRefreshInFlight`, `shutdownTimers`, and registered signal handlers will leak across tests in the same file, causing order-dependent failures.

**Files:**
- Modify: `src/monitor/index.ts` (append export)
- Modify: `tests/monitor/fetch-harness.ts` (add fake-timer helper with explicit `toFake` config)

- [ ] **Step 1: Append the reset helper to `src/monitor/index.ts`**

At the bottom of the file (but **before** the auto-run guard), add:

```ts
/**
 * Testing-only. Resets module-level state so tests within a single file
 * don't contaminate each other. Also strips any process signal handlers
 * registered by previous main() calls to prevent listener accumulation
 * (Node emits MaxListenersExceededWarning after 10).
 *
 * DO NOT call this from production code.
 */
export function _resetMonitorStateForTests(): void {
  cachedMode = TANDEM_MODE_DEFAULT;
  cachedModeAt = 0;
  modeRefreshInFlight = null; // declared in B12; safe to reset before B12 — just add the binding now
  shutdownTimers.awarenessTimer = null;
  shutdownTimers.clearAwarenessTimer = null;
  shutdownTimers.lastDocumentId = null;
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
}
```

**Note:** `modeRefreshInFlight` and `shutdownTimers` are referenced above but only introduced in B12/B8 respectively. Declare them as module-level `let` bindings in this task so the reset helper works at every stage:

```ts
// Placeholder bindings — populated by B8 (shutdownTimers) and B12 (modeRefreshInFlight).
// Declared here so _resetMonitorStateForTests can reference them safely.
let shutdownTimers: {
  awarenessTimer: ReturnType<typeof setTimeout> | null;
  clearAwarenessTimer: ReturnType<typeof setTimeout> | null;
  lastDocumentId: string | null;
} = { awarenessTimer: null, clearAwarenessTimer: null, lastDocumentId: null };
let modeRefreshInFlight: Promise<void> | null = null;
```

- [ ] **Step 2: Guard the module-level console redirect**

Change:
```ts
console.log = console.error;
console.warn = console.error;
console.info = console.error;
```

to:
```ts
// Guard the redirect so test imports don't pollute vitest's console routing.
// Production runs set VITEST !== "true".
if (process.env.VITEST !== "true") {
  console.log = console.error;
  console.warn = console.error;
  console.info = console.error;
}
```

- [ ] **Step 3: Update the fetch harness to control fake-timer faking explicitly**

Append to `tests/monitor/fetch-harness.ts`:

```ts
/**
 * Install fake timers with the faking surface the monitor tests need.
 * Explicitly opts into faking `setTimeout`, `clearTimeout`, `setInterval`,
 * `clearInterval`, `Date`, and `performance`. AbortSignal.timeout is built
 * on setTimeout, so this is enough to fake it. Also keeps `queueMicrotask`
 * real so awaited `.catch()` chains resolve predictably.
 */
export function installMonitorFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
}
```

Every `tests/monitor/*.test.ts` file in later tasks calls `installMonitorFakeTimers()` in `beforeEach` instead of `vi.useFakeTimers()`.

- [ ] **Step 4: Add a convention block to every monitor test file's `beforeEach`**

Every monitor test file created in B3-B12 should have `beforeEach`:

```ts
beforeEach(async () => {
  installMonitorFakeTimers();
  stub = createFetchStub();
  stub.install();
  const mod = await import("../../src/monitor/index.js");
  mod._resetMonitorStateForTests();
});

afterEach(() => {
  stub.restore();
  vi.useRealTimers();
});
```

(Later task code blocks already show this pattern; the lift of `_resetMonitorStateForTests` is the important part.)

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors. The placeholder bindings compile even though B8/B12 haven't populated them yet.

- [ ] **Step 6: Commit**

```bash
git add src/monitor/index.ts tests/monitor/fetch-harness.ts
git commit -m "test(monitor): add module-state reset helper and fake-timer harness

_resetMonitorStateForTests clears module-level cache and strips signal
listeners so tests within a single file can't contaminate each other.
Module-level console redirect is now guarded behind VITEST env so test
imports don't reroute sibling tests' console output."
```

### Task B1: Export `main`, `connectAndStream`, `getCachedMode` from the monitor

**Files:**
- Modify: `src/monitor/index.ts`

We need these exports for tests to drive the code deterministically. This is a structural change with no behavior change.

- [ ] **Step 1: Write a failing test that imports the symbols**

Create `tests/monitor/exports.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("monitor exports", () => {
  it("exposes entry points for testing", async () => {
    const mod = await import("../../src/monitor/index.js");
    expect(typeof mod.main).toBe("function");
    expect(typeof mod.connectAndStream).toBe("function");
    expect(typeof mod.getCachedMode).toBe("function");
    expect(typeof mod._resetMonitorStateForTests).toBe("function");
  });
});
```

Run: `npm test -- tests/monitor/exports.test.ts`
Expected: FAIL with "mod.main is not a function" (or similar).

- [ ] **Step 2: Add exports and guard the auto-run so tests don't trigger `main()` on import**

In `src/monitor/index.ts`:

1. Change `async function main(): Promise<void> {` → `export async function main(): Promise<void> {`.
2. Change `async function connectAndStream(...)` → `export async function connectAndStream(...)`.
3. Change `async function getCachedMode(): Promise<TandemMode> {` → `export async function getCachedMode(): Promise<TandemMode> {`.
4. Wrap the auto-run at the bottom so `import` doesn't execute it. Replace:

```ts
main().catch((err) => {
  console.error("[Monitor] Fatal error:", err);
  process.exit(1);
});
```

with:

```ts
// Auto-run when invoked directly (e.g. `node dist/monitor/index.js` or
// `tsx src/monitor/index.ts`). Skipped under vitest so tests can import
// and drive individual functions.
//
// Cross-platform direct-run detection: compare resolved file paths
// (not URL strings) because Windows file:// URLs normalize differently
// than process.argv[1] backslashes. Case-insensitive on win32 because
// C:\ vs c:\ drive letters can drift depending on how the CLI was invoked.
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
const __thisFile = fileURLToPath(import.meta.url);
function normalizeForCompare(p: string): string {
  const r = resolvePath(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}
const isDirectRun =
  typeof process.argv[1] === "string" &&
  normalizeForCompare(process.argv[1]) === normalizeForCompare(__thisFile);
if (isDirectRun && process.env.VITEST !== "true") {
  main().catch((err) => {
    console.error("[Monitor] Fatal error:", err);
    process.exit(1);
  });
}
```

Vitest sets `VITEST=true` in its test environment automatically.

- [ ] **Step 3: Run the test to verify**

Run: `npm test -- tests/monitor/exports.test.ts`
Expected: PASS.

- [ ] **Step 4: Verify the production build still auto-runs**

Build and inspect:
```bash
npm run build:server
node dist/monitor/index.js 2>&1 | head -2
```
Expected: the monitor logs `[Monitor] Tandem monitor starting (server: http://localhost:3479)` and attempts to connect (or exits retrying). The "starting" log proves `main()` fired on direct run.

- [ ] **Step 5: Commit**

```bash
git add src/monitor/index.ts tests/monitor/exports.test.ts
git commit -m "refactor(monitor): export entry points for testing

main/connectAndStream/getCachedMode are now exported so tests can drive
them directly. Auto-run is guarded by import.meta.url === argv[1] and
VITEST env so importing from tests doesn't spawn a real connection."
```

### Task B2: Fetch timeout helper (foundation for B3, B5, B6)

**Files:**
- Modify: `src/monitor/index.ts`

Every `fetch()` today has no timeout. A hung server blocks forever. Add a single helper and thread it through.

- [ ] **Step 1: Write a failing test for timeout behavior**

Create `tests/monitor/timeouts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedMode } from "../../src/monitor/index.js";
import { createFetchStub } from "./fetch-harness.js";

describe("fetch timeout", () => {
  let stub: ReturnType<typeof createFetchStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    stub = createFetchStub();
    stub.install();
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
  });

  it("aborts a hung /api/mode fetch via AbortSignal.timeout and falls back to solo", async () => {
    stub.on("/api/mode", (_url, init) => {
      const signal = init?.signal;
      // Return a promise that never resolves unless aborted
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    // Force a cache miss by not setting cachedModeAt recently
    const modePromise = getCachedMode();
    // Advance past the 2000ms mode-check timeout (see MODE_FETCH_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(2500);
    const mode = await modePromise;
    expect(mode).toBe("solo"); // fail-closed (see Task B3 for the rationale)
  });
});
```

Run: `npm test -- tests/monitor/timeouts.test.ts`
Expected: FAIL. Either the fetch hangs forever and the test times out, OR mode comes back as "tandem" (current fail-open default).

- [ ] **Step 2: Add the timeout constants and `fetchWithTimeout` helper**

In `src/monitor/index.ts`, add near the other `*_MS` constants:

```ts
const CONNECT_FETCH_TIMEOUT_MS = 10_000;  // /api/events initial handshake
const MODE_FETCH_TIMEOUT_MS = 2_000;      // /api/mode cache refresh
const AWARENESS_FETCH_TIMEOUT_MS = 5_000; // /api/channel-awareness POST
const ERROR_REPORT_TIMEOUT_MS = 3_000;    // /api/channel-error POST on exit

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  // AbortSignal.timeout is supported on Node 20+; tsup target is node22.
  const signal = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal });
}
```

Then replace every `fetch(` call inside `connectAndStream`, `getCachedMode`, `main`'s error-report path, and the awareness helpers with `fetchWithTimeout` using the matching constant:

- `/api/events` initial `fetch(...)` → `fetchWithTimeout(..., { headers }, CONNECT_FETCH_TIMEOUT_MS)`
- `/api/mode` → `fetchWithTimeout(url, {}, MODE_FETCH_TIMEOUT_MS)`
- `/api/channel-awareness` (both `clearAwareness` and `flushAwareness`) → `fetchWithTimeout(..., AWARENESS_FETCH_TIMEOUT_MS)`
- `/api/channel-error` → `fetchWithTimeout(..., ERROR_REPORT_TIMEOUT_MS)`

**Note:** The initial `fetchWithTimeout` to `/api/events` only times out the *handshake*. Once `res.body` is being read, timeouts are enforced by server keepalives; the reader blocks between frames are intentional.

- [ ] **Step 3: Run the test — it should still fail because B3 (fail-closed) isn't done yet**

Run: `npm test -- tests/monitor/timeouts.test.ts`
Expected: FAIL — this time because mode returns `"tandem"` instead of `"solo"`. That's the B3 fix. Proceed to B3.

- [ ] **Step 4: Commit**

```bash
git add src/monitor/index.ts
git commit -m "feat(monitor): add per-route fetch timeouts

Every fetch now uses AbortSignal.timeout with a route-appropriate budget
(10s connect, 2s mode, 5s awareness, 3s error report). Prevents a hung
server from wedging the monitor's main loop indefinitely."
```

### Task B3: Fail-closed mode semantics + don't poison cache on failure

**Files:**
- Modify: `src/monitor/index.ts` (`getCachedMode`)

**Design:** Solo mode is a privacy signal. On `/api/mode` failure, prefer suppressing events (solo) over leaking them (tandem). Also: keep the cache timestamp *only* on success, so transient failures don't silently rate-limit retries for 2s.

- [ ] **Step 1: Write the failing test**

Append to `tests/monitor/mode-cache.test.ts` (create if it doesn't exist):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedMode } from "../../src/monitor/index.js";
import { createFetchStub } from "./fetch-harness.js";

describe("getCachedMode fail-closed", () => {
  let stub: ReturnType<typeof createFetchStub>;
  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    // Explicit module-state reset — vitest isolates modules per *file*,
    // not per test, so without this the cachedMode from test N leaks to N+1.
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
  });

  it("returns 'solo' when /api/mode throws (network error)", async () => {
    stub.on("/api/mode", () => {
      throw new Error("ECONNREFUSED");
    });
    const mode = await getCachedMode();
    expect(mode).toBe("solo");
  });

  it("returns 'solo' when /api/mode returns 500", async () => {
    stub.on("/api/mode", () => new Response("err", { status: 500 }));
    const mode = await getCachedMode();
    expect(mode).toBe("solo");
  });

  it("retries /api/mode on next call if previous call failed (does not poison cache timestamp)", async () => {
    let callCount = 0;
    stub.on("/api/mode", () => {
      callCount++;
      if (callCount === 1) throw new Error("transient");
      return new Response(JSON.stringify({ mode: "tandem" }), { status: 200 });
    });
    const first = await getCachedMode();
    expect(first).toBe("solo"); // failed call → fail closed
    const second = await getCachedMode();
    expect(second).toBe("tandem"); // retry succeeded
    expect(callCount).toBe(2); // cache was not poisoned
  });
});
```

Run: `npm test -- tests/monitor/mode-cache.test.ts`
Expected: FAIL on the first and third assertions (current default is `"tandem"`; cache is poisoned on failure).

- [ ] **Step 2: Rewrite `getCachedMode`**

In `src/monitor/index.ts`, replace the current `getCachedMode` implementation with:

```ts
/**
 * Module-scoped mode cache. Only updated after a successful /api/mode
 * call — failures do NOT refresh the timestamp, so the next event-loop
 * iteration will retry instead of serving a stale "might-be-wrong" value
 * for 2 seconds.
 */
let cachedMode: TandemMode = TANDEM_MODE_DEFAULT;
let cachedModeAt = 0;

/**
 * Get the current collaboration mode, with a 2s TTL cache.
 *
 * **Fail-closed to "solo"** on any failure (network, non-2xx, JSON
 * parse, shape mismatch). Solo is a user-driven privacy signal; leaking
 * events when the mode endpoint is broken is strictly worse than
 * temporarily over-suppressing them. The user will notice missed events
 * sooner than they'll notice leaked ones in a supposedly-quiet session.
 */
export async function getCachedMode(): Promise<TandemMode> {
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return cachedMode;

  try {
    const res = await fetchWithTimeout(`${TANDEM_URL}/api/mode`, {}, MODE_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      console.error(`[Monitor] Mode check returned ${res.status}, failing closed to 'solo'`);
      return "solo"; // do NOT update cache
    }
    const body = (await res.json()) as { mode?: unknown };
    if (!VALID_MODES.has(body.mode as TandemMode)) {
      console.error(`[Monitor] Mode check returned invalid mode ${JSON.stringify(body.mode)}, failing closed to 'solo'`);
      return "solo"; // do NOT update cache
    }
    cachedMode = body.mode as TandemMode;
    cachedModeAt = now; // only on success
    return cachedMode;
  } catch (err) {
    console.error(
      "[Monitor] Mode check failed, failing closed to 'solo':",
      err instanceof Error ? err.message : err,
    );
    return "solo"; // do NOT update cache
  }
}
```

- [ ] **Step 3: Run the tests**

Run: `npm test -- tests/monitor/mode-cache.test.ts tests/monitor/timeouts.test.ts`
Expected: PASS on all.

- [ ] **Step 4: Commit**

```bash
git add src/monitor/index.ts tests/monitor/mode-cache.test.ts
git commit -m "fix(monitor): fail mode check closed to solo, don't poison cache

Mode failure now returns \"solo\" instead of delivering events under the
stale default. Cache timestamp is only updated on success, so transient
failures don't rate-limit retries for 2s. Covers network errors, non-2xx
responses, and invalid mode values."
```

### Task B4: Warm mode cache on startup

**Files:**
- Modify: `src/monitor/index.ts` (`main`)

Currently, the first non-chat event uses `TANDEM_MODE_DEFAULT = "tandem"` because `cachedModeAt = 0` until the first successful fetch. With B3's fail-closed change, the first event now defaults to "solo" on fetch failure, but on success it still requires a round-trip per event until cached. Warm the cache once at startup to make steady-state behavior predictable.

- [ ] **Step 1: Write the failing test**

Append to `tests/monitor/mode-cache.test.ts`:

```ts
describe("startup cache warm", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    installMonitorFakeTimers();
    stub = createFetchStub();
    stub.install();
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    // Mock process.exit so main()'s retry exhaustion doesn't kill the worker.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    // Stub awareness + channel-error so any accidental call is handled.
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stub.on("/api/channel-error", () => new Response("", { status: 200 }));
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    exitSpy.mockRestore();
  });

  it("main() calls /api/mode once before attempting SSE connection", async () => {
    const { main } = await import("../../src/monitor/index.js");

    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "solo" }), { status: 200 }));
    stub.on("/api/events", () => {
      throw new Error("skip SSE for this test");
    });

    const mainPromise = main().catch(() => {}); // exit-with-error is fine
    // Yield once to let the startup warm-up fetch resolve.
    await vi.advanceTimersByTimeAsync(1);

    const modeCalls = stub.calls.filter((c) => c.url.includes("/api/mode"));
    expect(modeCalls.length).toBeGreaterThanOrEqual(1);

    // Advance through full retry exhaustion (5 retries × up to 30s each post-B7).
    await vi.advanceTimersByTimeAsync(5 * 30_000 + 5_000);
    await mainPromise;
  });
});
```

Run: `npm test -- tests/monitor/mode-cache.test.ts`
Expected: FAIL — current `main()` doesn't call `/api/mode` before SSE.

- [ ] **Step 2: Add the warm-up call to `main()`**

At the top of `main()`, right after the "starting" log, add:

```ts
console.error(`[Monitor] Tandem monitor starting (server: ${TANDEM_URL})`);

// Warm the mode cache before the first event so we don't default-suppress
// or default-deliver under an unknown user setting.
await getCachedMode().catch(() => {
  // Already logged inside getCachedMode; continue with fail-closed default
});
```

- [ ] **Step 3: Run the test**

Run: `npm test -- tests/monitor/mode-cache.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/monitor/index.ts tests/monitor/mode-cache.test.ts
git commit -m "feat(monitor): warm mode cache on startup

main() fetches /api/mode once before the SSE loop so the first event is
classified under the user's real mode, not the fail-closed default."
```

### Task B5: Separate JSON.parse from parseTandemEvent catch; bind the error

**Files:**
- Modify: `src/monitor/index.ts` (`connectAndStream`, around lines 157-162)

Current code combines two operations in one parameterless catch. Any future exception inside `parseTandemEvent` (or a CPU-throw like `RangeError` on giant JSON) gets misreported as "malformed data" and silently loses the `eventId` checkpoint — causing the server to re-send the bad event forever.

- [ ] **Step 1: Write the failing test**

Create `tests/monitor/sse-parsing.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndStream } from "../../src/monitor/index.js";
import { ControllableStream, createFetchStub, sseFrame, sseResponse } from "./fetch-harness.js";

describe("SSE parsing error isolation", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stream: ControllableStream;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    stub = createFetchStub();
    stub.install();
    stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    stdoutSpy.mockRestore();
  });

  it("advances past a malformed-JSON frame WITHOUT updating lastEventId", async () => {
    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId);

    // Frame 1: malformed JSON, but has an id
    stream.push(`id: evt_bad\ndata: {not json\n\n`);
    // Frame 2: valid frame, should get through
    stream.push(sseFrame(
      { id: "evt_ok", type: "chat:message", timestamp: 1, payload: { messageId: "m", text: "hi", replyTo: null, anchor: null } },
      "evt_ok",
    ));
    stream.end();

    await promise.catch(() => {}); // "SSE stream ended" is expected
    // onEventId should have been called for evt_ok but NOT evt_bad
    expect(onEventId).toHaveBeenCalledWith("evt_ok");
    expect(onEventId).not.toHaveBeenCalledWith("evt_bad");
  });

  it("logs the specific parse error message (not just 'malformed')", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onEventId = vi.fn();
    // Note: connectAndStream's signature becomes 3-arg in Task B6; until
    // then it is 2-arg. Both forms are valid here during B5; once B6 lands
    // the 3rd arg (onStable) is optional so this call keeps working.
    const promise = connectAndStream(undefined, onEventId);

    stream.push(`id: evt_bad\ndata: {not json\n\n`);
    stream.end();
    await promise.catch(() => {});

    const msgs = errSpy.mock.calls.map((c) => c.join(" "));
    expect(msgs.some((m) => m.includes("JSON") || m.includes("parse"))).toBe(true);
    errSpy.mockRestore();
  });
});
```

Run: `npm test -- tests/monitor/sse-parsing.test.ts`
Expected: FAIL on the second test (current log message is "Malformed SSE event data", no error details).

- [ ] **Step 2: Rewrite the parse block**

In `src/monitor/index.ts`, in `connectAndStream`, find the block:

```ts
let event: TandemEvent | null;
try {
  event = parseTandemEvent(JSON.parse(data));
} catch {
  console.error("[Monitor] Malformed SSE event data (skipping):", data.slice(0, 200));
  continue;
}
if (!event) {
  console.error("[Monitor] Received invalid SSE event, skipping");
  continue;
}
```

Replace with:

```ts
let raw: unknown;
try {
  raw = JSON.parse(data);
} catch (err) {
  console.error(
    `[Monitor] SSE JSON parse failed (eventId=${eventId ?? "none"}, len=${data.length}): ${
      err instanceof Error ? err.message : err
    }. Tail:`,
    data.slice(Math.max(0, data.length - 200)),
  );
  continue;
}
const event = parseTandemEvent(raw);
if (!event) {
  console.error(
    `[Monitor] SSE event failed validation (eventId=${eventId ?? "none"}): shape mismatch`,
  );
  continue;
}
```

Note both skip paths intentionally do **not** call `onEventId(eventId)` — a malformed event should be re-delivered after reconnect, not silently advanced past. This is a deliberate design choice: server-side, the same poisoned event will probably also fail, and repeated failure triggers the retry budget (now correctly bounded by B6), which escalates via `/api/channel-error` (Task B8).

- [ ] **Step 3: Run the tests**

Run: `npm test -- tests/monitor/sse-parsing.test.ts`
Expected: PASS on both.

- [ ] **Step 4: Commit**

```bash
git add src/monitor/index.ts tests/monitor/sse-parsing.test.ts
git commit -m "fix(monitor): split JSON parse from event validation, log error

Parameterless catch was hiding any throw from parseTandemEvent as
'malformed data'. Now each failure mode logs its own diagnostic with the
eventId and payload-tail for debugging. Malformed events still do not
advance lastEventId so the server will re-request them on reconnect."
```

### Task B6: Fix retry counter semantics

**Files:**
- Modify: `src/monitor/index.ts` (`main` and `connectAndStream`)

Two convergent bugs: (1) resetting `retries` on every event ID means a pathological server that crashes after one event will loop forever; (2) a connection that succeeds but dies before any event arrives never resets, exhausting the budget prematurely. Fix: reset `retries` when the connection is **stable for a minimum duration**, not on every event.

- [ ] **Step 1: Write the failing test**

Create `tests/monitor/retry.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/monitor/index.js";
import { ControllableStream, createFetchStub, sseFrame, sseResponse } from "./fetch-harness.js";

describe("retry counter semantics", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    stub = createFetchStub();
    stub.install();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stub.on("/api/channel-error", () => new Response("", { status: 200 }));
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("exits after MAX retries even when each attempt produces a single event first", async () => {
    let connectAttempts = 0;
    stub.on("/api/events", () => {
      connectAttempts++;
      const s = new ControllableStream();
      // Emit one event then immediately die
      setTimeout(() => {
        s.push(sseFrame(
          { id: `evt_${connectAttempts}`, type: "chat:message", timestamp: 1, payload: { messageId: "m", text: "hi", replyTo: null, anchor: null } },
          `evt_${connectAttempts}`,
        ));
        s.error(new Error("stream died"));
      }, 0);
      return sseResponse(s);
    });

    const mainPromise = main().catch(() => {}); // expect exit
    // Advance through 5 retry cycles (each with 2s+ delay)
    await vi.advanceTimersByTimeAsync(60_000);
    await mainPromise;

    // With the old bug, this would loop forever. With the fix, max 5 attempts.
    expect(connectAttempts).toBeLessThanOrEqual(5);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("resets retries after a connection stays healthy for STABLE_CONNECTION_MS", async () => {
    let connectAttempts = 0;
    let currentStream: ControllableStream | null = null;

    stub.on("/api/events", () => {
      connectAttempts++;
      currentStream = new ControllableStream();
      return sseResponse(currentStream);
    });

    const mainPromise = main().catch(() => {});
    // Connect 1: stay healthy 90s, then die
    await vi.advanceTimersByTimeAsync(90_000);
    currentStream?.error(new Error("stream died"));
    // Wait for retry delay + reconnect
    await vi.advanceTimersByTimeAsync(5_000);
    // Connect 2: stay healthy 90s, then die — retries should have reset
    await vi.advanceTimersByTimeAsync(90_000);
    currentStream?.error(new Error("stream died"));
    // Continue until exhaustion...
    // With the fix, each long-healthy stream resets the budget, so we should get many attempts.
    // With the bug (reset on every event), a stream producing 0 events would keep retries count.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connectAttempts).toBeGreaterThan(5); // budget reset at least once
    await mainPromise;
  }, 15_000);
});
```

Run: `npm test -- tests/monitor/retry.test.ts`
Expected: FAIL — first test loops forever (or times out) because current code resets on every event.

- [ ] **Step 2: Add the stable-connection reset**

In `src/monitor/index.ts`:

Add near the other constants:
```ts
const STABLE_CONNECTION_MS = 60_000; // Reset retries after this much continuous uptime
```

Change `connectAndStream`'s signature to accept an **optional** `onStable` callback (optional so pre-B6 tests still compile):

```ts
export async function connectAndStream(
  lastEventId: string | undefined,
  onEventId: (id: string) => void,
  onStable: () => void = () => {},
): Promise<void> {
  // ... existing setup ...

  const res = await fetchWithTimeout(`${TANDEM_URL}/api/events`, { headers }, CONNECT_FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`SSE endpoint returned ${res.status}`);
  if (!res.body) throw new Error("SSE endpoint returned no body");

  // Schedule the stable-uptime reset
  const stableTimer = setTimeout(onStable, STABLE_CONNECTION_MS);

  // ... existing reader logic ...

  try {
    // existing while(true) loop — but REMOVE the `retries = 0` behavior
    // from inside onEventId callers. Just call onEventId(eventId).
    // ... existing code unchanged ...
  } finally {
    clearTimeout(stableTimer);
    if (awarenessTimer) clearTimeout(awarenessTimer);
    if (clearAwarenessTimer) clearTimeout(clearAwarenessTimer);
    pendingAwareness = null;
  }
}
```

Change `main`'s loop to use `onStable` for the reset, and have `onEventId` only update `lastEventId` (not reset retries):

```ts
export async function main(): Promise<void> {
  console.error(`[Monitor] Tandem monitor starting (server: ${TANDEM_URL})`);
  await getCachedMode().catch(() => {});

  let retries = 0;
  let lastEventId: string | undefined;

  while (retries < CHANNEL_MAX_RETRIES) {
    try {
      await connectAndStream(
        lastEventId,
        (id) => {
          lastEventId = id;
        },
        () => {
          // Stable connection — reset retry budget
          retries = 0;
        },
      );
    } catch (err) {
      retries++;
      // ... existing retry/exit logic ...
    }
  }
}
```

- [ ] **Step 3: Run the tests**

Run: `npm test -- tests/monitor/retry.test.ts`
Expected: PASS on both.

- [ ] **Step 4: Commit**

```bash
git add src/monitor/index.ts tests/monitor/retry.test.ts
git commit -m "fix(monitor): reset retries after stable uptime, not per event

Previously, retries reset on every event ID — a server that produced one
event then crashed would reconnect forever. Now the budget resets only
after a connection stays healthy for 60s, so pathological
connect-fail-reconnect loops correctly exhaust the retry budget and
report to /api/channel-error."
```

### Task B7: Exponential backoff

**Files:**
- Modify: `src/monitor/index.ts` (main loop retry delay)

PR description says "exponential backoff" but current code uses a fixed 2s delay. Make it match the description.

- [ ] **Step 1: Write the failing test**

Append to `tests/monitor/retry.test.ts`:

```ts
describe("exponential backoff", () => {
  // Same beforeEach/afterEach as above

  it("sleeps 2^(n-1) * base between retries, capped at max", async () => {
    let connectAttempts = 0;
    const attemptTimes: number[] = [];
    const start = Date.now();

    stub.on("/api/events", () => {
      connectAttempts++;
      attemptTimes.push(Date.now() - start);
      throw new Error("refused");
    });

    const mainPromise = main().catch(() => {});
    await vi.advanceTimersByTimeAsync(120_000);
    await mainPromise;

    // Expected delays between attempts: ~2000, ~4000, ~8000, ~16000 (capped at 30000)
    const deltas = attemptTimes.slice(1).map((t, i) => t - attemptTimes[i]);
    expect(deltas[0]).toBeGreaterThanOrEqual(1900);
    expect(deltas[0]).toBeLessThan(3000);
    expect(deltas[1]).toBeGreaterThanOrEqual(3900);
    expect(deltas[1]).toBeLessThan(5000);
    expect(deltas[2]).toBeGreaterThanOrEqual(7900);
    expect(deltas[2]).toBeLessThan(9000);
  });
});
```

Run: `npm test -- tests/monitor/retry.test.ts`
Expected: FAIL on the backoff test — all deltas are ~2000.

- [ ] **Step 2: Implement exponential backoff**

In `src/monitor/index.ts`, add a constant:

```ts
const CHANNEL_RETRY_MAX_DELAY_MS = 30_000;
```

In `main`'s retry loop, replace:
```ts
await new Promise((r) => setTimeout(r, CHANNEL_RETRY_DELAY_MS));
```

with:
```ts
// Exponential backoff: 2s, 4s, 8s, 16s, 30s (capped)
const delay = Math.min(
  CHANNEL_RETRY_DELAY_MS * 2 ** (retries - 1),
  CHANNEL_RETRY_MAX_DELAY_MS,
);
console.error(`[Monitor] Retrying in ${delay}ms...`);
await new Promise((r) => setTimeout(r, delay));
```

- [ ] **Step 3: Run the test**

Run: `npm test -- tests/monitor/retry.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/monitor/index.ts tests/monitor/retry.test.ts
git commit -m "feat(monitor): exponential backoff for reconnect delay

Matches the PR description. Delay is 2^(retries-1) * base, capped at 30s.
Reduces load on a flapping server during a brief outage."
```

### Task B8: SIGINT/SIGTERM handlers — clear awareness on shutdown

**Files:**
- Modify: `src/monitor/index.ts`

When Claude Code kills the plugin, the server-side awareness indicator stays "active" forever. Add signal handlers that POST a final `clearAwareness` before exiting.

- [ ] **Step 1: Write the failing test**

Create `tests/monitor/shutdown.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchStub } from "./fetch-harness.js";

describe("graceful shutdown", () => {
  let stub: ReturnType<typeof createFetchStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    stub = createFetchStub();
    stub.install();
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
  });

  it("POSTs a final clearAwareness when SIGINT fires (after an event set lastDocumentId)", async () => {
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));

    // Seed shutdownTimers.lastDocumentId as if an event had flowed through.
    // In a real SIGINT scenario, this is populated inside connectAndStream's
    // flushAwareness. We expose a test helper to avoid driving the full loop.
    mod._setLastDocumentIdForTests("doc-123");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    try {
      await mod.shutdownForTests("SIGINT");
    } catch {
      // exit thrown is expected
    }

    const clears = stub.calls.filter((c) =>
      c.url.includes("/api/channel-awareness") &&
      typeof c.init?.body === "string" &&
      c.init.body.includes('"active":false'),
    );
    expect(clears.length).toBeGreaterThanOrEqual(1);
    expect(exitSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("skips the awareness POST when no document is active (lastDocumentId === null)", async () => {
    const mod = await import("../../src/monitor/index.js");
    mod._resetMonitorStateForTests();
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    try {
      await mod.shutdownForTests("SIGINT");
    } catch {
      // exit thrown is expected
    }

    const clears = stub.calls.filter((c) => c.url.includes("/api/channel-awareness"));
    expect(clears.length).toBe(0);
    exitSpy.mockRestore();
  });
});
```

Run: `npm test -- tests/monitor/shutdown.test.ts`
Expected: FAIL — `mod.shutdownForTests` doesn't exist.

- [ ] **Step 2: Add shutdown handling**

In `src/monitor/index.ts`:

Replace the module-level awareness-related state with lifted module-scope trackers, and add a shutdown function. Near the top (after the constants):

```ts
// Module-scope shutdown coordination. connectAndStream sets these on its
// own timers/state; the signal handler reads them to do a final flush.
let shutdownTimers: {
  awarenessTimer: ReturnType<typeof setTimeout> | null;
  clearAwarenessTimer: ReturnType<typeof setTimeout> | null;
  lastDocumentId: string | null;
} = {
  awarenessTimer: null,
  clearAwarenessTimer: null,
  lastDocumentId: null,
};

async function finalClearAwareness(): Promise<void> {
  if (shutdownTimers.awarenessTimer) clearTimeout(shutdownTimers.awarenessTimer);
  if (shutdownTimers.clearAwarenessTimer) clearTimeout(shutdownTimers.clearAwarenessTimer);
  // If no awareness was ever scheduled for a document, skip the POST —
  // sending {documentId: null} is ambiguous and the server may reject it.
  if (shutdownTimers.lastDocumentId === null) return;
  try {
    await fetchWithTimeout(
      `${TANDEM_URL}/api/channel-awareness`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: shutdownTimers.lastDocumentId,
          status: "idle",
          active: false,
        }),
      },
      AWARENESS_FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    console.error(
      "[Monitor] Shutdown awareness clear failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Exposed for testing. Callers should NOT invoke this outside tests. */
export async function shutdownForTests(signal: string): Promise<void> {
  console.error(`[Monitor] Received ${signal}, clearing awareness and exiting`);
  await finalClearAwareness();
  process.exit(0);
}

/** Exposed for testing only — seeds the lastDocumentId that shutdown reads. */
export function _setLastDocumentIdForTests(id: string | null): void {
  shutdownTimers.lastDocumentId = id;
}

function installShutdownHandlers(): void {
  // Never install real signal handlers under vitest — tests drive
  // shutdownForTests() directly. Without this guard, every main() call
  // in a test accumulates SIGINT listeners and hits Node's MaxListeners
  // warning, and a stray real SIGINT could call process.exit during a
  // test run.
  if (process.env.VITEST === "true") return;
  const handler = (signal: string) => {
    shutdownForTests(signal).catch((err) => {
      console.error("[Monitor] Shutdown handler failed:", err);
      process.exit(1);
    });
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}
```

Inside `connectAndStream`, update the timer assignments to also track in `shutdownTimers` and record `lastDocumentId` when scheduling awareness:

In `flushAwareness`:
```ts
function flushAwareness() {
  if (!pendingAwareness) return;
  const event = pendingAwareness;
  pendingAwareness = null;
  shutdownTimers.lastDocumentId = event.documentId ?? null;
  // ... rest unchanged ...
  if (clearAwarenessTimer) clearTimeout(clearAwarenessTimer);
  clearAwarenessTimer = setTimeout(() => clearAwareness(event.documentId), AWARENESS_CLEAR_MS);
  shutdownTimers.clearAwarenessTimer = clearAwarenessTimer;
}
```

In `scheduleAwareness`:
```ts
function scheduleAwareness(event: TandemEvent) {
  pendingAwareness = event;
  if (awarenessTimer) clearTimeout(awarenessTimer);
  awarenessTimer = setTimeout(flushAwareness, AWARENESS_DEBOUNCE_MS);
  shutdownTimers.awarenessTimer = awarenessTimer;
}
```

In `main`, call `installShutdownHandlers()` at the start:

```ts
export async function main(): Promise<void> {
  installShutdownHandlers();
  console.error(`[Monitor] Tandem monitor starting (server: ${TANDEM_URL})`);
  // ... rest ...
}
```

- [ ] **Step 3: Run the test**

Run: `npm test -- tests/monitor/shutdown.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/monitor/index.ts tests/monitor/shutdown.test.ts
git commit -m "feat(monitor): clear awareness on SIGINT/SIGTERM

Before this change, killing the plugin left the server's awareness
indicator stuck on 'active' indefinitely. Signal handlers now POST a
final clearAwareness with the last known documentId before exiting."
```

### Task B9: Solo-mode filter test (no code change, regression fence)

**Files:**
- Create: `tests/monitor/solo-filter.test.ts`

The solo-mode filter code exists in `connectAndStream`. We just need regression coverage.

- [ ] **Step 1: Write the test**

```ts
// tests/monitor/solo-filter.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAndStream } from "../../src/monitor/index.js";
import { ControllableStream, createFetchStub, sseFrame, sseResponse } from "./fetch-harness.js";

describe("solo-mode event filtering", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stream: ControllableStream;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    stub = createFetchStub();
    stub.install();
    stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    stdoutSpy.mockRestore();
  });

  it("suppresses non-chat events when mode is solo", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "solo" }), { status: 200 }));
    const promise = connectAndStream(undefined, () => {}, () => {});

    stream.push(sseFrame(
      { id: "e1", type: "document:opened", timestamp: 1, payload: { fileName: "a.md", format: "md" } },
      "e1",
    ));
    stream.end();
    await promise.catch(() => {});

    // No stdout output for the suppressed event
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("ALWAYS delivers chat:message events regardless of mode", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "solo" }), { status: 200 }));
    const promise = connectAndStream(undefined, () => {}, () => {});

    stream.push(sseFrame(
      { id: "c1", type: "chat:message", timestamp: 1, payload: { messageId: "m", text: "hi", replyTo: null, anchor: null } },
      "c1",
    ));
    stream.end();
    await promise.catch(() => {});

    expect(stdoutSpy).toHaveBeenCalled();
  });

  it("delivers all event types when mode is tandem", async () => {
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    const promise = connectAndStream(undefined, () => {}, () => {});

    stream.push(sseFrame(
      { id: "e2", type: "document:opened", timestamp: 1, payload: { fileName: "a.md", format: "md" } },
      "e2",
    ));
    stream.end();
    await promise.catch(() => {});

    expect(stdoutSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- tests/monitor/solo-filter.test.ts`
Expected: PASS (behavior is already correct; this is a regression fence).

- [ ] **Step 3: Commit**

```bash
git add tests/monitor/solo-filter.test.ts
git commit -m "test(monitor): regression fence for solo-mode event filtering

Locks in the contract: non-chat events suppressed in solo, chat always
delivered, everything delivered in tandem."
```

### Task B10: Buffer overflow test

**Files:**
- Append to: `tests/monitor/sse-parsing.test.ts`

- [ ] **Step 1: Add the test**

```ts
describe("SSE buffer overflow", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let stream: ControllableStream;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    stub = createFetchStub();
    stub.install();
    stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));
    stub.on("/api/mode", () => new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stub.restore();
    vi.useRealTimers();
    stdoutSpy.mockRestore();
  });

  it("throws when the buffer grows past 1MB without a frame boundary", async () => {
    const promise = connectAndStream(undefined, () => {}, () => {});
    // Push 1.1MB without a `\n\n` frame boundary
    stream.push("data: " + "x".repeat(1_100_000));
    await expect(promise).rejects.toThrow(/SSE buffer exceeded/);
  });

  it("allows a single 900KB event that ends with a proper boundary", async () => {
    const onEventId = vi.fn();
    const promise = connectAndStream(undefined, onEventId, () => {});

    const payload = JSON.stringify({
      id: "big",
      type: "chat:message",
      timestamp: 1,
      payload: { messageId: "m", text: "x".repeat(900_000), replyTo: null, anchor: null },
    });
    stream.push(`id: big\ndata: ${payload}\n\n`);
    stream.end();
    await promise.catch(() => {});

    expect(onEventId).toHaveBeenCalledWith("big");
  });
});
```

- [ ] **Step 2: Run and commit**

Run: `npm test -- tests/monitor/sse-parsing.test.ts`
Expected: PASS.

```bash
git add tests/monitor/sse-parsing.test.ts
git commit -m "test(monitor): regression fence for SSE buffer overflow guard"
```

### Task B11: Exit signal on stdout (visibility for Claude Code)

**Files:**
- Modify: `src/monitor/index.ts` (main's exit paths)

Currently, when the monitor exhausts retries and exits, the only surface is stderr — which Claude Code doesn't show. Emit a structured event on stdout so the user sees "monitor died, restart Tandem" as a notification.

- [ ] **Step 1: Write the failing test**

Append to `tests/monitor/retry.test.ts`, **inside the existing `describe("retry counter semantics", ...)` block** so it inherits the `stub`, `stdoutSpy`, and `exitSpy` fixtures:

```ts
it("writes a monitor:exit notification to stdout before process.exit(1)", async () => {
  stub.on("/api/events", () => {
    throw new Error("refused");
  });

  const mainPromise = main().catch(() => {});
  await vi.advanceTimersByTimeAsync(120_000);
  await mainPromise;

  const stdoutCalls = stdoutSpy.mock.calls.map((c) => String(c[0]));
  const exitLine = stdoutCalls.find((s) => s.includes("monitor:exit") || s.includes("Tandem monitor disconnected"));
  expect(exitLine).toBeDefined();
});
```

Run: `npm test -- tests/monitor/retry.test.ts`
Expected: FAIL.

- [ ] **Step 2: Emit an exit notification**

In `src/monitor/index.ts`, inside `main`'s exhaustion branch, right before `process.exit(1)`, add:

```ts
// Visible-to-Claude-Code notification. stderr is invisible to the plugin
// host, so the user would otherwise see events just stop with no signal.
process.stdout.write(
  "Tandem monitor disconnected — restart Tandem to restore real-time events\n",
);
```

- [ ] **Step 3: Run the test and commit**

Run: `npm test -- tests/monitor/retry.test.ts`
Expected: PASS.

```bash
git add src/monitor/index.ts tests/monitor/retry.test.ts
git commit -m "feat(monitor): emit exit notification to stdout on retry exhaustion

stderr is invisible to Claude Code. On retry exhaustion, write a
user-facing line to stdout so the notification is actually surfaced."
```

### Task B12: Move mode refresh off the hot path

**Files:**
- Modify: `src/monitor/index.ts`

Currently `getCachedMode` is `await`ed inside the event-read loop. Even with B2's timeout (2s), a single cache miss can introduce up to 2s of latency per cold-cache event. Refactor so the cache refresh happens in the background and the hot path always reads the last known value.

- [ ] **Step 1: Write the failing test**

Append to `tests/monitor/mode-cache.test.ts`:

```ts
describe("background mode refresh", () => {
  // Same beforeEach/afterEach as above

  it("event delivery is not blocked by a slow /api/mode response", async () => {
    let modeResolve: ((r: Response) => void) | undefined;
    stub.on("/api/mode", () => new Promise<Response>((resolve) => {
      modeResolve = resolve;
    }));

    const stream = new ControllableStream();
    stub.on("/api/events", () => sseResponse(stream));
    stub.on("/api/channel-awareness", () => new Response("", { status: 200 }));

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const promise = connectAndStream(undefined, () => {}, () => {});
    stream.push(sseFrame(
      { id: "e1", type: "document:opened", timestamp: 1, payload: { fileName: "a.md", format: "md" } },
      "e1",
    ));

    // Advance time but DO NOT resolve /api/mode
    await vi.advanceTimersByTimeAsync(100);
    // stdout should already have the event (cached default is "tandem", non-blocking)
    expect(stdoutSpy).toHaveBeenCalled();

    // Now resolve mode and end the stream
    modeResolve?.(new Response(JSON.stringify({ mode: "tandem" }), { status: 200 }));
    stream.end();
    await promise.catch(() => {});
    stdoutSpy.mockRestore();
  });
});
```

Run: `npm test -- tests/monitor/mode-cache.test.ts`
Expected: FAIL — current `await getCachedMode()` blocks event delivery.

- [ ] **Step 2: Add a sync read + background refresh (preserve `getCachedMode` unchanged)**

**Contract clarification (added after plan-review):**
- `getCachedMode()` — keeps the B3 semantics (fail-closed to "solo" on failure; updates cache only on success). Used by **startup warm-up only**.
- `getModeSync()` — new. Pure sync read of `cachedMode`. Never fails. Used on the **hot path**.
- `refreshMode()` — new. Fire-and-forget background fetch; on failure, leaves `cachedMode` unchanged (stale-preferred over disruption-mid-session). Deduplicated via `modeRefreshInFlight`.

This means: on startup, a failed `/api/mode` correctly downgrades to "solo" (privacy-safe cold start). Once a successful fetch has cached "tandem", a later transient failure prefers the stale value over flipping to "solo" mid-session (which would confuse the user with random suppression). This is an intentional asymmetry — document it in the commit message.

In `src/monitor/index.ts` add:

```ts
// Note: the `modeRefreshInFlight` binding is already declared in Task B0b
// so _resetMonitorStateForTests can reset it. This task only ASSIGNS to it.

/** Sync reader — always returns the last known mode. Use this on the hot path. */
export function getModeSync(): TandemMode {
  return cachedMode;
}

/**
 * Background refresh — fire-and-forget, deduplicated.
 *
 * Leaves `cachedMode` UNCHANGED on failure (stale-preferred). Distinct from
 * getCachedMode which fails closed on failure — see B3/B12 contract notes
 * in the plan commit messages for the asymmetry rationale.
 */
function refreshMode(): void {
  if (modeRefreshInFlight) return;
  const now = Date.now();
  if (now - cachedModeAt < MODE_CACHE_TTL_MS) return;

  modeRefreshInFlight = (async () => {
    try {
      const res = await fetchWithTimeout(`${TANDEM_URL}/api/mode`, {}, MODE_FETCH_TIMEOUT_MS);
      if (res.ok) {
        const body = (await res.json()) as { mode?: unknown };
        if (VALID_MODES.has(body.mode as TandemMode)) {
          cachedMode = body.mode as TandemMode;
          cachedModeAt = Date.now(); // only on success
        } else {
          console.error(`[Monitor] Mode refresh returned invalid mode ${JSON.stringify(body.mode)}`);
        }
      } else {
        console.error(`[Monitor] Mode refresh returned ${res.status}`);
      }
    } catch (err) {
      console.error(
        "[Monitor] Background mode refresh failed (keeping cached):",
        err instanceof Error ? err.message : err,
      );
    } finally {
      modeRefreshInFlight = null;
    }
  })();
}
```

**Keep `getCachedMode` exactly as B3 left it** — do not rewrite. `main()`'s warm-up call `await getCachedMode()` still benefits from fail-closed-to-solo on failure.

Change the hot-path use in `connectAndStream` from:

```ts
if (event.type !== "chat:message") {
  const mode = await getCachedMode();
  if (mode === "solo") { ... }
}
```

to:

```ts
if (event.type !== "chat:message") {
  refreshMode(); // fire-and-forget
  if (getModeSync() === "solo") {
    console.error(`[Monitor] Solo mode: suppressed ${event.type} event`);
    continue;
  }
}
```

Note: startup warm-up in `main()` still calls `await getCachedMode()` — that's correct, we want to block startup briefly to warm the cache.

Also: because the hot path is now non-blocking, the "cache miss delivers default" window shrinks to just startup. After `main()` warms the cache once, every subsequent event uses the real value (fail-closed on startup error).

- [ ] **Step 3: Run the test**

Run: `npm test -- tests/monitor/mode-cache.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/monitor/index.ts tests/monitor/mode-cache.test.ts
git commit -m "perf(monitor): refresh mode cache in background, never on hot path

Event delivery no longer awaits /api/mode. Cache is warmed at startup
(blocking) and refreshed fire-and-forget on expiry. Prevents a slow
mode endpoint from stalling event throughput."
```

---

## Phase C — Minor cleanups

### Task C1: PACKAGE_ROOT validation in setup.ts

**Files:**
- Modify: `src/cli/setup.ts` (around line 222-232)

If `PACKAGE_ROOT` resolution produces a path that doesn't contain `.claude-plugin/plugin.json` (e.g. unusual install layouts), the printed dev instruction is invalid. Validate and warn.

- [ ] **Step 1: Add the validation**

In `runSetup`, replace the plugin-install instructions block with:

```ts
// Plugin install instructions (shown on all successful setups)
if (failures < targets.length) {
  const pluginManifest = join(PACKAGE_ROOT, ".claude-plugin", "plugin.json");
  const devInstructions = existsSync(pluginManifest)
    ? `  Or for development, load directly from this package:\n\n` +
      `    claude --plugin-dir ${PACKAGE_ROOT}\n\n`
    : `  (Development plugin dir not found at ${pluginManifest}; skipping local-plugin instructions.)\n\n`;

  console.error(
    "\n\x1b[1mReal-time push notifications (recommended):\x1b[0m\n" +
      "  Install the Tandem plugin for instant events (one-time):\n\n" +
      "    claude plugin marketplace add bloknayrb/tandem\n" +
      "    claude plugin install tandem@tandem-editor\n\n" +
      devInstructions +
      "  Without the plugin, Claude still works but relies on tandem_checkInbox polling.\n",
  );
}
```

- [ ] **Step 2: Add a test**

Append to `tests/cli/setup.test.ts`:

```ts
describe("runSetup plugin instructions", () => {
  // Harder to test directly without refactoring runSetup; at minimum,
  // assert that when the repo's own .claude-plugin/plugin.json exists,
  // the PACKAGE_ROOT path exists:
  it("package .claude-plugin/plugin.json exists at expected path", () => {
    const manifestPath = resolve(import.meta.dirname, "../../.claude-plugin/plugin.json");
    expect(existsSync(manifestPath)).toBe(true);
  });
});
```

(Add `import { existsSync } from "node:fs"; import { resolve } from "node:path";` if not present.)

- [ ] **Step 3: Run and commit**

Run: `npm test -- tests/cli/setup.test.ts`
Expected: PASS.

```bash
git add src/cli/setup.ts tests/cli/setup.test.ts
git commit -m "fix(setup): validate PACKAGE_ROOT plugin manifest before printing dev hint

If --plugin-dir PACKAGE_ROOT wouldn't work (missing manifest), print a
warning instead of a bad command."
```

### Task C2: Stop writing tandem-channel by default (actually fix duplicate-events bug)

**Why:** Finding #9 in the review was that installing the plugin AND running `tandem setup` produces **duplicate event notifications** because both the channel shim and the monitor subscribe to `/api/events`. Merely commenting this behavior (the plan's original C2) doesn't fix the bug — it just acknowledges it. Drop the `tandem-channel` MCP entry by default; keep an opt-in for users who explicitly want it.

**Files:**
- Modify: `src/cli/setup.ts` (`buildMcpEntries` + `runSetup`)
- Modify: `tests/cli/setup.test.ts` (update the existing `buildMcpEntries` tests)

- [ ] **Step 1: Update the existing `buildMcpEntries` tests to reflect the new default**

In `tests/cli/setup.test.ts`, change the first two tests to match:

```ts
describe("buildMcpEntries", () => {
  it("returns only the tandem HTTP entry by default (plugin handles channel)", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js");
    expect(entries.tandem).toEqual({
      type: "http",
      url: `http://localhost:${DEFAULT_MCP_PORT}/mcp`,
    });
    expect(entries["tandem-channel"]).toBeUndefined();
  });

  it("includes tandem-channel when withChannelShim: true (legacy opt-in)", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
      withChannelShim: true,
    });
    expect(entries["tandem-channel"]?.command).toBe("node");
    expect(entries["tandem-channel"]?.args).toEqual(["/abs/path/to/dist/channel/index.js"]);
  });

  it("uses custom nodeBinary when provided (Tauri sidecar path)", () => {
    const entries = buildMcpEntries("/app/Resources/dist/channel/index.js", {
      withChannelShim: true,
      nodeBinary: "/app/MacOS/node-sidecar",
    });
    expect(entries["tandem-channel"]?.command).toBe("/app/MacOS/node-sidecar");
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npm test -- tests/cli/setup.test.ts`
Expected: the new tests FAIL (current signature is `buildMcpEntries(channelPath, nodeBinary = "node")`, returns both entries always).

- [ ] **Step 3: Update `buildMcpEntries` to make the channel shim opt-in**

Replace in `src/cli/setup.ts`:

```ts
export interface McpEntries {
  tandem: McpEntry;
  "tandem-channel"?: McpEntry;
}

export interface BuildMcpEntriesOptions {
  /** Include the legacy stdio channel shim. Defaults to false — the plugin
   *  monitor handles event push for modern installs. Users on older setups
   *  can run `tandem setup --with-channel-shim` to preserve the shim. */
  withChannelShim?: boolean;
  nodeBinary?: string;
}

export function buildMcpEntries(
  channelPath: string,
  opts: BuildMcpEntriesOptions = {},
): McpEntries {
  const entries: McpEntries = {
    tandem: { type: "http", url: `${MCP_URL}/mcp` },
  };
  if (opts.withChannelShim) {
    entries["tandem-channel"] = {
      command: opts.nodeBinary ?? "node",
      args: [channelPath],
      env: { TANDEM_URL: MCP_URL },
    };
  }
  return entries;
}
```

- [ ] **Step 4: Plumb the flag through `runSetup`**

Change `runSetup`'s signature from `{ force?: boolean }` to `{ force?: boolean; withChannelShim?: boolean }`. In the body, replace:

```ts
const entries = buildMcpEntries(CHANNEL_DIST);
```

with:

```ts
const entries = buildMcpEntries(CHANNEL_DIST, {
  withChannelShim: opts.withChannelShim,
});
```

Add a CLI flag in `src/cli/index.ts` (wherever `runSetup` is dispatched) to accept `--with-channel-shim`. Also update the post-setup message to note that the channel shim is only included when requested.

- [ ] **Step 5: Run all setup tests**

Run: `npm test -- tests/cli/setup.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/setup.ts src/cli/index.ts tests/cli/setup.test.ts
git commit -m "fix(setup): drop tandem-channel entry by default, add --with-channel-shim

Installing the Tandem plugin AND running tandem setup previously produced
duplicate event notifications — both the channel shim and the monitor
subscribe to /api/events. Default setup now writes only the HTTP tandem
entry; users on legacy workflows opt in with --with-channel-shim."
```

### Task C3: Reconcile plugin.json and package.json descriptions

**Files:**
- Modify: `.claude-plugin/plugin.json`

The plugin-facing description loses the "no copy-paste, full LLM access via MCP" framing. Unify.

- [ ] **Step 1: Update plugin.json**

```json
{
  "name": "tandem",
  "version": "0.5.1",
  "description": "Edit and iterate on documents with Claude — no copy-paste, real-time push via plugin monitor",
  ...
}
```

- [ ] **Step 2: Also update marketplace.json's plugin description to match**

In `.claude-plugin/marketplace.json`, change:
```json
"description": "Collaborative AI-human document editor with real-time event push"
```
to match (or remove if redundant with plugin.json).

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "docs(plugin): unify plugin description with package.json

Both now lead with the 'no copy-paste' value prop."
```

### Task C4: Build artifact smoke test

**Files:**
- Create: `tests/monitor/build-artifact.test.ts`

Assert that `npm run build:server` produces a runnable `dist/monitor/index.js` — catches tsup misconfig regressions.

- [ ] **Step 1: Write the test**

```ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MONITOR_DIST = resolve(import.meta.dirname, "../../dist/monitor/index.js");

describe("monitor build artifact", () => {
  it("dist/monitor/index.js exists after build (run `npm run build:server` first)", () => {
    if (!existsSync(MONITOR_DIST)) {
      console.warn("Skipping: run `npm run build:server` first to produce the bundle.");
      return;
    }
    expect(statSync(MONITOR_DIST).size).toBeGreaterThan(1000);
  });

  it("dist/monitor/index.js references /api/events (not accidentally a different endpoint)", () => {
    if (!existsSync(MONITOR_DIST)) return;
    const content = readFileSync(MONITOR_DIST, "utf-8");
    expect(content).toContain("/api/events");
    expect(content).toContain("/api/mode");
  });
});
```

- [ ] **Step 2: Run after a build**

```bash
npm run build:server
npm test -- tests/monitor/build-artifact.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/monitor/build-artifact.test.ts
git commit -m "test(monitor): smoke-test the built artifact for expected endpoints"
```

---

## Phase D — Documentation

**Why:** Project convention (`feedback_docs_always_current.md`, CLAUDE.md): every code change requires doc updates. The plan touches monitor architecture, migration path, and introduces a new opt-in flag — all of which need surfacing.

### Task D1: CHANGELOG.md entry for 0.5.1

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a 0.5.1 block above the existing most-recent entry**

Follow the existing format. Entry should cover:
- **Added:** Claude Code plugin support (monitor-based event push); `tandem setup --with-channel-shim` for legacy setups.
- **Changed:** `tandem setup` no longer writes the `tandem-channel` MCP entry by default (prevents duplicate events when plugin is installed).
- **Fixed:** Mode check fails closed to "solo" on `/api/mode` errors; retry counter resets on stable uptime (not per event); SIGINT clears server-side awareness indicator; fetch calls have per-route timeouts; SKILL.md corrects `question` annotation guidance.

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): add 0.5.1 entry for plugin + monitor hardening"
```

### Task D2: docs/architecture.md — add monitor + plugin section

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add a "Plugin Monitor" section**

Under the existing architecture section, add a subsection that covers:
- The monitor's role (SSE client → stdout → Claude Code notifications).
- Contract asymmetry: startup warm-up is fail-closed (solo); hot-path background refresh is stale-preferred.
- Retry semantics: exponential backoff, reset on stable uptime (60s), escalation to `/api/channel-error` after 5 exhaustion.
- Awareness lifecycle: debounced POST on events, 3s auto-clear, final SIGINT/SIGTERM clear.
- Why `tandem-channel` is now opt-in only.

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): document plugin monitor lifecycle and contracts"
```

### Task D3: docs/lessons-learned.md — append 4 new lessons

**Files:**
- Modify: `docs/lessons-learned.md`

- [ ] **Step 1: Append four entries at the bottom of the file, numbered sequentially from the current max**

1. **Privacy signals fail closed, not open.** Solo mode is user privacy preference; failing open on `/api/mode` errors leaks activity the user asked to suppress. Startup uses fail-closed; hot-path background refresh uses stale-preferred (no random suppression mid-session).
2. **Retry budgets must reset on stable uptime, not per event.** Resetting on every event ID lets a server that crashes after each event loop forever. Reset only after a connection stays healthy for a meaningful window (60s here).
3. **Stdio monitors must surface errors on stdout, not stderr.** Claude Code plugin hosts route stdout to the user but swallow stderr. Any user-visible state (including "monitor died") must be on stdout.
4. **Vitest isolates modules per file, not per test.** Module-level state (caches, registered signal handlers) bleeds between tests in the same file. Export a `_resetForTests()` helper; call it in every `beforeEach`. Also guard module-level side effects (e.g. `console.*` redirect) behind `VITEST !== "true"`.

- [ ] **Step 2: Commit**

```bash
git add docs/lessons-learned.md
git commit -m "docs(lessons): 4 new lessons from PR #285 hardening"
```

### Task D4: README — add plugin install quickstart

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Quickstart: Claude Code plugin" block near the top of the install section**

Covers:
- `claude plugin marketplace add bloknayrb/tandem`
- `claude plugin install tandem@tandem-editor`
- Note that existing users of the channel shim can opt in with `tandem setup --with-channel-shim` if they can't install the plugin yet.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): add Claude Code plugin quickstart"
```

---

## Verification

Run the full verification sequence before pushing the branch back to PR #285:

### Unit + monitor tests
```bash
npm test
```
Expected: all tests green. The new `tests/monitor/*.test.ts` files add ~7 suites.

### Type check
```bash
npm run typecheck
```
Expected: no errors.

### Build
```bash
npm run build
```
Expected: `dist/server/index.js`, `dist/channel/index.js`, `dist/monitor/index.js`, `dist/cli/index.js` all produced.

### Manual plugin smoke test
With Tandem running (`npm run dev:server`), in a separate terminal:
```bash
node dist/monitor/index.js
```
Expected: prints `[Monitor] Tandem monitor starting (server: http://localhost:3479)` on stderr, then blocks on the SSE loop. Open `welcome.md` in the Tandem browser tab — you should see a `document:opened` notification line on stdout. Close the tab — stdout emits `document:closed`. Ctrl+C — stderr logs `[Monitor] Received SIGINT, clearing awareness and exiting`.

### Manual solo-mode check
In the Tandem UI, toggle mode to "solo". Open a new document. Expected: `document:opened` is **not** emitted to stdout (but the stderr log shows `[Monitor] Solo mode: suppressed document:opened event`). Send a chat message from the UI — that IS emitted (chat always bypasses solo).

### Manual shutdown check (awareness cleanup)
1. Start the monitor.
2. Open a document so an awareness POST fires.
3. Kill the monitor with Ctrl+C.
4. In the Tandem UI, confirm the "Claude is active" indicator disappears (instead of hanging).

### Push back to the PR branch
```bash
git push origin claude/refine-local-plan-6YSg8
```
Then re-run the `/pr-review-toolkit:review-pr errors tests` subset to verify the three convergent findings (retry budget, mode fail-open, awareness shutdown) are now resolved.

---

## Task Dependency Graph

```
Phase A (independent, do first):
  A1 → A2 → A3

Phase B (order matters — B0 → B0b → B1 are prerequisites for the rest):
  B0 → B0b → B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → B9 → B10 → B11 → B12

Phase C (independent, any order after Phase A):
  C1, C2, C3, C4

Phase D (after Phase B + C, before push):
  D1, D2, D3, D4 (independent of each other)
```

Recommended execution: **Phase A → Phase B → Phase C → Phase D**, committing after every task, pushing after each phase.

Total: **28 commits** across 4 phases. Each task is bite-sized (2-5 min for code-only steps, 5-10 min for TDD-cycle tasks in Phase B).

**Optional squash on push:** If 28 commits is too granular for PR review, squash within phases:
- Phase A → 1 commit
- Phase B0 + B0b + B1 → 1 commit (test infrastructure)
- B2 through B12 → keep individual (each is a reviewable TDD cycle)
- Phase C → 1 commit
- Phase D → 1 commit per doc file (CHANGELOG/architecture/lessons/README kept separate so reviewers can land them independently).

Net if squashed: ~16 commits.
