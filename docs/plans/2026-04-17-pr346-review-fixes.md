# PR #346 Review Fix Plan — Revision 2

Status: final, ready for implementation
Target branch: `fix/336-stdio-bridge-silent-failures` (PR #346)
Base: master
Author: Bryan (via Claude)
Date: 2026-04-17

## Revision notes (vs. R1)

- Line numbers refreshed against `pr-346` HEAD (commit `d0fab3f`).
- **A1 reframed.** `StdioServerTransport.send` never rejects on the current SDK — the catch arm is defensive. Per silent-failure-hunter, the cleanest fix is to call `shutdown(1, synth)` directly from the catch so there's no id-leak path if a future SDK *does* reject.
- **B2 dropped.** `StreamableHTTPClientTransport.start()` doesn't perform HTTP I/O — it only creates an `AbortController`. The only way for it to throw is double-start, which our code never does. No test possible without mocking; the catch branch is defense-in-depth and gets a comment instead.
- **A3 scope expanded.** `channel.ts` also needs updating — small change, same PR.
- **B1 renamed + rescoped.** It's a "pendingIds cleared on success" test, not an A1 regression guard.
- **New A10** — note drain parallelism in a source comment (C#2 from R1).
- **A6 comment softened.** Don't claim "dead code"; say we haven't observed the SDK firing `onclose` independently.

## Context

PR #346 fixes silent-failure paths in `src/cli/mcp-stdio.ts` so plugin hosts (Cowork, Claude Code plugin-loader mode) receive JSON-RPC `-32000` errors instead of silent stdio close when the Tandem HTTP upstream is unavailable. Five specialized review agents found one HIGH silent-failure, two MEDIUM issues, multiple test gaps, comment hygiene items, and a latent race. Two plan-reviewers then critiqued this fix plan and surfaced SDK-level constraints that reshape A1 and B2.

This plan addresses every actionable finding in the same PR. Section D explicitly lists items deliberately dropped.

## Items (ordered by dependency)

### A. Source fixes

#### A1 [HIGH → HARDENED-DEFENSIVE] `http.onmessage` stdio-send failure must not leak pending ids

**Source:** silent-failure-hunter H1 + plan-review discovery that `StdioServerTransport.send` never rejects today.

**Current (`src/cli/mcp-stdio.ts:159-166`):**
```ts
http.onmessage = (msg: JSONRPCMessage) => {
  const responseId = getResponseId(msg);
  if (responseId !== undefined) pendingIds.delete(responseId);
  stdio.send(msg).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[tandem mcp-stdio] stdio write failed: ${detail}\n`);
  });
};
```

**Why we're hardening:** if `stdio.send` ever rejects (future SDK change, EPIPE-on-drain, etc.), the current code deletes `pendingIds[responseId]` *before* the send, so `synthesizePending` cannot recover. And because `stdio.onclose` only fires from our own `stdio.close()` call, there is no trigger to even start shutdown. A leaking-then-silent scenario identical to the one the whole PR exists to prevent.

**Fix:** delete only on successful send; on failure, trigger shutdown via `shutdown(1, {synth})` which drains `pendingIds` including this id. Include the id in the stderr diagnostic.

```ts
http.onmessage = (msg: JSONRPCMessage) => {
  const responseId = getResponseId(msg);
  stdio.send(msg).then(
    () => {
      if (responseId !== undefined) pendingIds.delete(responseId);
    },
    (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[tandem mcp-stdio] stdio write failed for id ${responseId ?? "<notification>"}: ${detail}\n`,
      );
      // Leave responseId in pendingIds — shutdown's synthesizePending will
      // retry via sendErrorResponse. If stdio is truly gone, that send also
      // fails and we log twice. Safe delete-after-send narrows the pending
      // window; it never widens for well-ordered responses.
      void shutdown(1, {
        message: "Tandem stdio write failed",
        detail,
      });
    },
  );
};
```

**Test coverage:** see B1 (pendingIds cleared on success) which also exercises the rewritten delete-after-send ordering. The rejection-specific path is guarded by a comment + code structure; not separately tested because the SDK's `send` cannot reject today, and mocking-based tests here add more fragility than they remove.

---

#### A2 [IMPORTANT] Guard `forwardToUpstream` catch against double-synthesize (future-proofing)

**Source:** code-reviewer latent-race finding; both plan-reviewers confirmed orderings sound.

**Current (`src/cli/mcp-stdio.ts:108-115`):**
```ts
http.send(msg).catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[tandem mcp-stdio] upstream send failed: ${detail}\n`);
  if (requestId !== undefined) {
    pendingIds.delete(requestId);
    void sendErrorResponse(requestId, "Tandem HTTP upstream unreachable", detail);
  }
});
```

**Fix:** `Set.prototype.delete` returns `true` iff the element was present — atomic check-and-remove.

```ts
http.send(msg).catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[tandem mcp-stdio] upstream send failed: ${detail}\n`);
  // `delete` returns true iff the id was still pending — prevents double-
  // synth if a future change ever allows synthesizePending to fire while
  // http.send is still in flight. (Not a current bug; belt-and-suspenders.)
  if (requestId !== undefined && pendingIds.delete(requestId)) {
    void sendErrorResponse(requestId, "Tandem HTTP upstream unreachable", detail);
  }
});
```

No new test — future-proofing guard, not a bug fix.

---

#### A3 [MEDIUM] Distinguish "unreachable" from "unhealthy" in preflight probe — update both callers

**Source:** silent-failure-hunter M1 + plan-reviewer C3 (update `channel.ts` too).

**Change `src/cli/preflight.ts`:**

```ts
// Note: "unreachable" is a catch-all for any non-HTTP-status failure —
// DNS, TLS, timeout, ECONNREFUSED, RST all land here. "unhealthy" is
// strictly non-2xx responses from /health.
export type PreflightProbe =
  | { ok: true }
  | { ok: false; url: string; reason: string; kind: "unreachable" | "unhealthy" };

export async function probeTandemServer(opts: PreflightOptions = {}): Promise<PreflightProbe> {
  const url = resolveTandemUrl(opts.url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    if (!res.ok) {
      return {
        ok: false,
        url,
        reason: `health endpoint returned HTTP ${res.status}`,
        kind: "unhealthy",
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      url,
      reason: err instanceof Error ? err.message : String(err),
      kind: "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureTandemServer(opts: PreflightOptions = {}): Promise<void> {
  const probe = await probeTandemServer(opts);
  if (!probe.ok) {
    const guidance =
      probe.kind === "unreachable"
        ? "Start the Tauri app or run `tandem start` on the host, then retry."
        : "The Tandem server is running but unhealthy — check the host logs.";
    process.stderr.write(
      `[tandem] Tandem server preflight failed at ${probe.url} (${probe.reason}).\n` +
        `[tandem] ${guidance}\n`,
    );
    process.exit(1);
  }
}
```

**Change `src/cli/mcp-stdio.ts` caller (lines 194-211):** branch user-facing strings on `probe.kind`, route through `deferredShutdown` (introduced in A5).

```ts
const probe = await probeTandemServer({ url: baseUrl });
if (!probe.ok) {
  const guidance =
    probe.kind === "unreachable"
      ? "Start the Tauri app or run `tandem start` on the host, then retry."
      : "The Tandem server is running but unhealthy — check the host logs.";
  process.stderr.write(
    `[tandem mcp-stdio] Tandem server preflight failed at ${probe.url} (${probe.reason}).\n` +
      `[tandem mcp-stdio] ${guidance}\n`,
  );
  const synthMessage =
    probe.kind === "unreachable"
      ? "Tandem server not running. Start the Tauri app or run `tandem start`."
      : "Tandem server unhealthy (check host logs).";
  deferredShutdown({ message: synthMessage, detail: probe.reason });
  return;
}
```

`channel.ts` doesn't need a direct change — it uses `ensureTandemServer`, which now handles both cases internally.

---

#### A4 [MEDIUM] `shutdown` close-failures must not be silent

**Source:** silent-failure-hunter M2.

**Current (`src/cli/mcp-stdio.ts:145-146`):**
```ts
await http.close().catch(() => {});
await stdio.close().catch(() => {});
```

**Fix:**
```ts
await http.close().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[tandem mcp-stdio] http.close failed: ${detail}\n`);
});
await stdio.close().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[tandem mcp-stdio] stdio.close failed: ${detail}\n`);
});
```

---

#### A5 [REFACTOR] Extract `deferredShutdown` helper

**Source:** code-simplifier #3; prerequisite for A3's readable caller.

Inside `runMcpStdio`, above `stdio.onmessage`:

```ts
function deferredShutdown(synth: { message: string; detail?: string }): void {
  setTimeout(() => void shutdown(1, synth), PREFLIGHT_GRACE_MS);
}
```

Replace both `setTimeout(() => void shutdown(1, {...}), PREFLIGHT_GRACE_MS)` blocks (preflight-fail + http.start-fail) with `deferredShutdown({...})`.

---

#### A6 [COMMENT] Soften `http.onclose` guard rationale

**Source:** comment-analyzer #6 + plan-reviewer C1.

**Current (`src/cli/mcp-stdio.ts:181-187`):**
```ts
http.onclose = () => {
  if (shuttingDown) return;
  void shutdown(1, {
    message: "Tandem HTTP upstream closed unexpectedly",
    detail: "upstream connection dropped mid-session",
  });
};
```

**Fix:** add a comment explaining both the `shuttingDown` guard (defends against synth-during-shutdown) AND the observed behavior (the current SDK only fires onclose from our own close()).

```ts
http.onclose = () => {
  // We've observed the current @modelcontextprotocol/sdk (0.20.x) only
  // firing onclose from inside its own close() method — i.e., as a
  // consequence of *our* shutdown. The synth branch below is defensive
  // for future SDK versions that may propagate socket-death as onclose.
  // The `shuttingDown` guard prevents double-synth when shutdown() calls
  // http.close() itself.
  if (shuttingDown) return;
  void shutdown(1, {
    message: "Tandem HTTP upstream closed unexpectedly",
    detail: "upstream connection dropped mid-session",
  });
};
```

---

#### A7 [COMMENT] Soften hardcoded "2s" in `PREFLIGHT_GRACE_MS` docblock

**Source:** comment-analyzer #2.

**Current (`src/cli/mcp-stdio.ts:35-39`):** mentions "preflight's own 2s fetch timeout" (cross-file magic number coupling).

**Fix:**
```ts
// After preflight or http.start() fails we wait ~1.5s for any already-in-
// flight `initialize` from the plugin loader to land on stdin and receive
// a -32000 reply before tear-down. Sizing covers stdin-read lag between
// preflight resolution and first message arrival — independent of
// preflight's own fetch timeout.
const PREFLIGHT_GRACE_MS = 1500;
```

---

#### A8 [COMMENT] Soften "typically writes `initialize`" claim

**Source:** comment-analyzer #4.

**Current (`src/cli/mcp-stdio.ts:200-203`)** — inside the preflight-fail branch, will be moved/rewritten by A3. After A3 lands, edit the remaining rationale on `deferredShutdown` OR add a module-level comment once (since both preflight-fail and http.start-fail paths benefit).

**Fix** — add one comment next to `deferredShutdown`'s definition:

```ts
// Plugin hosts typically send `initialize` immediately after spawn (MCP
// lifecycle §initialization). Deferring shutdown by PREFLIGHT_GRACE_MS
// lets that request land during the preflight/start window and receive
// a -32000 reply rather than a silent stdio close. stdio.onclose
// short-circuits this if the loader closes stdin first.
function deferredShutdown(synth: { message: string; detail?: string }): void {
  setTimeout(() => void shutdown(1, synth), PREFLIGHT_GRACE_MS);
}
```

---

#### A9 [COMMENT] Trim WHAT-sentence at drain block

**Source:** comment-analyzer #9.

**Current (`src/cli/mcp-stdio.ts:228-230`):**
```ts
// Drain any requests that arrived while preflight + http.start() were
// running. They were held to preserve forwarding semantics — now that
// upstream is ready, push them through the normal path.
const buffered = preReadyBuffer.splice(0);
for (const msg of buffered) forwardToUpstream(msg);
```

**Fix:**
```ts
// Held to preserve forwarding semantics — push through the normal path
// now that upstream is ready. Note: forwardToUpstream does not await the
// http.send, so buffered requests POST in parallel. Plugin hosts wait
// for `initialize` to resolve before sending follow-ups per MCP spec, so
// the buffer is usually ≤1 entry; we don't enforce serial ordering here.
const buffered = preReadyBuffer.splice(0);
for (const msg of buffered) forwardToUpstream(msg);
```

---

#### A10 [COMMENT] Document drain parallelism in source

**Source:** plan-reviewer 2, item C#2.

Covered by A9's expanded comment. No separate code change needed.

---

### B. Test fixes — `tests/cli/mcp-stdio.test.ts`

#### B1 [NEW TEST] `pendingIds` is cleared on successful response

**Source:** pr-test-analyzer gap #4 + plan-reviewer I1 (corrected framing).

**Scope:** integration test proving that a successful round-trip does NOT leave its id in `pendingIds`. This exercises both the pre-existing `delete` logic AND the A1-reordered `.then(delete)` path.

**Test:**
1. Spawn mcp-stdio pointed at a fake server that answers `initialize` with `result`.
2. Send request id=1, read success response, assert `error` is undefined.
3. Send a SECOND request id=2; this time fake server holds the response.
4. Destroy the held response (`held.destroy()`) so `forwardToUpstream.catch` fires for id=2.
5. Read next stdout line: expect exactly ONE `-32000` with id=2. No second line for id=1.

Success = id=1 was cleared from `pendingIds` after its response, so it was NOT eligible for synth.

---

#### B2 [DROPPED] `http.start()` failure path

**Source:** pr-test-analyzer gap #1 + plan-reviewer C2.

**Rationale for drop:** `StreamableHTTPClientTransport.start()` in the current SDK only creates an `AbortController` — no HTTP I/O. The only way for it to throw is double-start, which our code never triggers. Integration test is impossible; mock-based unit test would test the SDK's error propagation rather than our logic.

**Mitigation:** leave A6-style defensive comment at the `try { await http.start() }` block (`mcp-stdio.ts:213-225`):

```ts
// The current @modelcontextprotocol/sdk's StreamableHTTPClientTransport.start()
// only creates an AbortController and returns synchronously — this catch is
// defensive for future SDK versions that may perform real I/O during start().
try {
  await http.start();
} catch (err) {
  // ...
}
```

---

#### B3 [NEW TEST] Notifications do not receive synth

**Source:** pr-test-analyzer gap #5.

**Test:**
1. Spawn mcp-stdio with env pointing at a dead port (preflight fails fast).
2. Immediately write a notification (`{jsonrpc: "2.0", method: "notifications/initialized"}` — no id) to stdin.
3. Wait for child to exit with code 1.
4. Assert: stdout is empty OR contains no JSON-RPC line with `error.code === -32000`.

A regression that added notifications to `pendingIds` would produce a reply with `id: null`, breaking protocol.

---

#### B4 [NEW TEST] Multiple concurrent pending requests all receive synth

**Source:** pr-test-analyzer gap #3.

**Test:**
1. Spawn mcp-stdio against a fake server that answers `/health` 200 and holds all `/mcp` POSTs.
2. Poll for http-ready (first `/mcp` GET received OR `receivedPosts.length > 0` on an initial throwaway).
3. Send three requests (ids 100, 101, 102).
4. Destroy the server.
5. Collect stdout lines until three `-32000` replies arrive, each with a distinct id in {100,101,102}.

Proves `synthesizePending`'s `Promise.all` delivers for all entries.

---

#### B5 [FLAKINESS FIX] Poll for handshake in existing mid-session test

**Source:** pr-test-analyzer #8.

Existing `await new Promise(r => setTimeout(r, 600))` (`tests/cli/mcp-stdio.test.ts:372` area) replaced with polling on the fake server's `/mcp` GET counter or received-POST count. Cleaner and more cold-CI-robust.

---

#### B6 [HYGIENE] Tighten regex in mid-session test

**Source:** code-reviewer Important-1 + plan-reviewer (test hygiene, not bug closure).

The existing `/closed|unreachable/i` regex accepts either path. Per SDK investigation, the test currently hits `forwardToUpstream.catch` → message `"Tandem HTTP upstream unreachable"`. Tighten to `/unreachable/i`. If we want to add `onclose`-path coverage, that requires forcing the SDK to fire onclose from external socket death — which doesn't happen on the current SDK. Leave that path covered by the comment in A6.

---

#### B7 [HYGIENE] Trim third `#336` citation

**Source:** comment-analyzer #10.

Delete the `describe`-block preamble at the top of the error-synthesis suite in `tests/cli/mcp-stdio.test.ts` (lines 168-172 area). The test names already describe the behavior; the file-level source docblock is the canonical explanation.

---

### C. Additional comment cleanup

#### C1 [COMMENT] Trim `preReadyBuffer` / `pendingIds` inline descriptions

**Source:** comment-analyzer #7 (borderline).

**Current (`src/cli/mcp-stdio.ts:64-70`):** redundant WHAT halves.

**Fix (tighten to WHY-only):**
```ts
// On upstream failure we synthesize -32000 for every entry before exit.
const pendingIds = new Set<string | number>();
// Messages arriving before httpReady flips; either drained and forwarded
// on success, or each request answered with -32000 on preflight/http-start
// failure.
const preReadyBuffer: JSONRPCMessage[] = [];
```

Small win; bundled here rather than as a separate item.

---

### D. Items explicitly NOT addressed (with rationale)

1. **Shared preflight-failure-message formatter across mcp-stdio + channel (code-simplifier #6):** A3 already unifies the logic inside `ensureTandemServer` + branches in the mcp-stdio caller. Further extraction buys <5 LOC and adds an export.
2. **Drain `await` ordering (code-reviewer suggestion):** parallel POSTs match the non-buffered hot path; changing only the drain path creates behavioral asymmetry. Documented via A9's expanded comment instead.
3. **`readOneLine` listener-attach ergonomics (code-reviewer + pr-test-analyzer #7):** test-only, not currently hit. Defer.
4. **`readOneLine` interval-vs-event refactor (code-simplifier #7):** equivalent complexity.
5. **`getRequestId`/`getResponseId` merge (code-simplifier #4):** names carry their weight.
6. **Port-1 portability (pr-test-analyzer #9):** currently reliable across platforms.
7. **`stdio.onclose` abandoned-pendingIds logging:** deferred; stdio-close implies client no longer listens.

---

## Build order

1. **A5** — extract `deferredShutdown` helper (prerequisite for A3's caller).
2. **A3** — preflight discriminator + update both callers (`mcp-stdio.ts`, `ensureTandemServer`).
3. **A1** — stdio-send failure hardening (delete-after-send + `shutdown` trigger).
4. **A2** — double-synth guard (one-line).
5. **A4** — close-failure logs.
6. **A6–A9, C1** — comment updates (batch).
7. **B1, B3, B4** — new tests.
8. **B5, B6, B7** — flakiness fix + regex tighten + preamble trim.
9. **typecheck + test** — expect +3 new integration tests, +1 unit cluster (getResponseId already added).
10. **Commit** on top of `fix/336-stdio-bridge-silent-failures`.

## Verification checklist

- `npm run typecheck` — clean.
- `npm test` — all pass; new test count matches; no new skips.
- Expected test delta: existing 1219 + 3 new integration (B1, B3, B4) = **1222 passing, 3 skipped** post-change. (B5/B6 modify existing tests; B7 trims a comment.)
- Manual smoke (not blocking): `node dist/cli/index.js mcp-stdio` against a down server; observe `-32000` on stdout.

## Out of scope for this PR

Per PR #346's own charter (deferred to v0.7.0):
- Channel-shim tests (issue #336 item).
- Windows `npx` smoke test.
- The 5 nits in #336.

## Estimated diff size

Source: ~50 lines added, ~35 lines modified.
Tests: ~180 lines added.
PR growth: +~230 lines on top of the current +445/-72.
