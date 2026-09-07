# F-runtime — #1794 the channel permission relay documented in `mcp-tools.md` does not exist

Branch `fix/push-paths-runtime-1759`. Closes #1794. Ledgers:
`docs/reviews/2026-09-02-v1-review/areas/security.md:18` and `areas/docs.md:21`. Probe: none — the
gap is read-verified in three places already (`docs/architecture.md:483`, `docs/decisions.md:1740`
= ADR-047 §3 item 1, `docs/plans/2026-08-07-channel-flag-removal.md:43`).

## Problem

`docs/mcp-tools.md:1410-1443` documents `POST /api/channel-permission`, `GET /api/channel-permission`
and `POST /api/channel-permission-verdict` as a working relay. There is no return leg and there never
was: nothing in `src/client/` reads `pendingPermissions` (grep for `channel-permission` there returns
nothing), so no prompt is ever shown; the shim registers `permission_request` as an MCP
**notification** (`src/channel/run.ts:153-189`), and notifications cannot be answered; and
`POST /api/channel-permission-verdict` (`src/server/mcp/channel-routes.ts:152-162`) deletes the
pending entry, `console.error`s the verdict and returns it **to the browser that submitted it** — its
own comment says *"Store verdict for the channel shim to poll (or push via SSE in follow-up)"*, and
there is no store, no poll route and no SSE. So there is no waiting caller to deliver to.
`docs/architecture.md:483` already says so and calls the `mcp-tools.md` half "wrong and tracked for
correction" — this is that correction.

Second, read-verified while writing this spec: `POST /api/channel-permission` stores **`inputPreview`**
(`:121-135`) and `console.error`s `description` (`:136`), and the `GET` serves the whole map value
(`:141-148`). Those are Claude Code tool-approval prompt contents — for a `Write`, file content; for
a `Bash`, the command line — and `authMiddleware` bypasses on loopback, so any local process can read
them. The field is not in the documented response either, so a rewrite describing reality either
documents a leak or removes it. (`docs/plans/2026-08-07-channel-flag-removal.md:116` filed this and
it never landed.)

## Fix

**Option B from the issue body: describe what the routes do, do not build the return leg.** Delivery
would mean an SSE `permission:verdict` event, a shim-side waiter, and a verdict→Claude-Code answer
path for a *notification* that has no reply channel — a feature, not a fix, and one whose resolve map
is keyed on a 5-character case-insensitive code with no sender binding. That is a `/diverge` + plan.

- `docs/mcp-tools.md:1410-1443` — retitle the group `### Channel permission relay (experimental — no
  return leg)` and open it with one paragraph: the shim forwards Claude Code's approval prompt, the
  server holds it for 30 s, and **nothing displays it and no verdict reaches Claude Code**; the editor
  has no permission UI, `permission_request` arrives as a notification that cannot be answered, and
  the verdict route only deletes the pending entry and echoes to its own caller. Point at
  `docs/architecture.md:483` and ADR-047 §3. Keep the three request/response blocks — accurate about
  the wire — and correct the two sentences implying a working feature: *"for editor-side permission
  UI"* (there is none) and *"failures are logged because the browser may not see the approval
  prompt"* (it never sees it). The documented `POST` body keeps `inputPreview`, because the shim still
  sends it; say that the server now discards it.
- `src/server/mcp/channel-routes.ts` — removals only, no additions:
  - **`:121-135` stops storing `inputPreview` at all.** Drop it from the destructure, from the
    `.set()`, **and from the `Map<string, {...}>` type declaration at `:26`** — that third site is
    easy to miss from a two-item list and is a `tsc` error once the `.set()` stops supplying it. With
    the field gone the stored record already *is* the documented `{requestId, toolName, description,
    createdAt}` shape, so the `GET` needs no projection.
  - `:136` becomes `Permission request: ${toolName} (id: ${requestId})` — `description` out of the
    line. The verdict log at `:160` is already free of prompt content; leave it.
  - Replace the stale comments at `:117-118` and `:159` with one line each naming the state of play
    (`no return leg — see docs/architecture.md and ADR-047 §3`). **They must not name `inputPreview`**
    — test 3 is a whole-file text sweep for that identifier, so the natural comment ("`inputPreview`
    is no longer stored") turns the pin red on day one; write "the shim's approval-prompt payload is
    not stored". **Do not delete the routes**: the shim POSTs unconditionally and would start logging
    failures.
- **`description` is deliberately kept, and here is the bound.** It is the tool-level summary line —
  "Run npm test", "Edit src/foo.ts" — while `input_preview` carries file bodies and command lines,
  and that is the one this removes. `description` stays because it is the documented response shape
  and the only human-readable thing left. **Say the asymmetry out loud in the doc rewrite and the PR
  body**: on `description` alone this change moves exposure the *wrong* way — it removes the stderr
  sink, which only the machine owner reads, and keeps the served one, which any local process
  (`authMiddleware` bypasses on loopback, `src/server/auth/middleware.ts:163-166`) and, under Cowork,
  any token-holding LAN caller can read, because `channel-permission` is absent from the non-loopback
  scrub inventory at `src/server/mcp/api-routes.ts:254-259`. Defensible because `description` is a
  summary line; **not** defensible if stated as "prompt content is no longer exposed".
- **The residual gets a tracked home, because a PR body and a doc paragraph are the disposal that
  already failed once for this exact route** (`docs/plans/2026-08-07-channel-flag-removal.md:116`).
  CLAUDE.md's Security section states the rule: new findings go in `docs/security.md#open-findings`
  *as well as* the tracker. Both issues are already filed — [#1884](https://github.com/bloknayrb/tandem/issues/1884)
  (the finding) and [#1885](https://github.com/bloknayrb/tandem/issues/1885) (the
  `"claude/channel/permission": {}` withdrawal decision, Bryan's call) — so cite the numbers, do not
  re-file. Two edits, same commit. **(a)** One top-level bullet under `## Open findings` in
  `docs/security.md`, naming #1884 in its first clause (`tests/docs/security-findings-claims.test.ts`
  reads only a bullet's first 240 characters, so the reference must sit in the opening): what is
  served un-scrubbed and to whom; that `POST /api/channel-permission` is a `NON_LOOPBACK_ALLOWED`
  carve-out, so under Cowork the shim's `input_preview` crosses the LAN before the server discards
  it; that `src/channel/run.ts:54` is the declaration making Claude Code send any of it; that #1885
  is the source-level close; and that this PR removes the field from the server sinks but does **not**
  add the scrub or withdraw the capability. **Do not move the reconciliation-date marker** — the test
  only asserts it exists, and a bumped date reflecting no reconciliation is the failure #1420
  produced. **(b)** CLAUDE.md's findings bullet: add `#1884` to the `— open:` enumeration at
  parenthetical depth zero, before the `**Fixed but unverified:**` label, one clause and no exploit
  detail, and change the count word `**Three security findings are open` → `**Four`. Both are
  required together — the test derives the count from the enumeration, so one without the other
  turns that suite red.
- `src/channel/run.ts:181` — the shim logs `Permission relay got HTTP ${res.status} — browser may not
  see prompt`, the same retired claim. Reword to name reality (`relay POST failed; the request is
  dropped — there is no browser-side permission UI`).
- **Rules that bite.** `NON_LOOPBACK_ALLOWED` already carries both channel-permission POSTs and **must
  not grow**; the `GET` is exempt by *method* (`enforceLoopbackMutation` short-circuits every GET at
  `src/server/mcp/api-routes.ts:267-271` before the set is consulted). Nothing here adds a route, a
  method, or an MCP tool, so `tests/server/api-loopback-invariant.test.ts:49-50` stays green and
  Critical Rule 9 is not engaged. No Y.Doc write, no Y.Map key, no `data-testid`, no skill edit.

## Tests

One new file, `tests/server/channel-permission-relay.test.ts`, driving the real registrar with a
recorder `app` (`{get, post, options, delete}` capturing `[path, ...handlers]` — `delete` is required,
`registerChannelRoutes` calls `app.delete(API_CHAT, …)` at `:166` and throws without it) and mock
`req`/`res`, in the `tests/server/health-route.test.ts` "call the handler directly" pattern.
`pendingPermissions` is module-level with no reset export, so the specs share one map: each uses the
same `requestId` and opens by advancing fake timers past `PERMISSION_TTL_MS` and issuing one draining
`GET`, so none depends on another's ordering.

1. `POST /api/channel-permission` then `GET /api/channel-permission`: the pending entry has exactly
   `requestId`, `toolName`, `description`, `createdAt` — **and `inputPreview` is `undefined`**. Same
   spec, second half: spy `console.error`, POST with a distinctive `description` string, assert the
   emitted line contains `toolName` and `requestId` but **not** that string. That half is the only
   pin on the "no log line carries prompt content" clause of Done when.
2. `POST /api/channel-permission-verdict` responds `{ ok: true, requestId, behavior: "allow" }` and a
   following `GET` returns `{ pending: [] }`. Pins "the verdict's only effect is deletion" — the
   sentence the doc rewrite turns on.
3. Read `src/server/mcp/channel-routes.ts` as text and assert the identifier `inputPreview` appears
   **nowhere**. Spec 1 reads through the `GET`, so it cannot tell "removed from the record" from
   "hidden behind a projection"; the sweep is the smallest assertion that turns red if the
   destructure, the `.set()` or the type declaration at `:26` survives.

## Done when

`docs/mcp-tools.md` no longer describes a relay that does not run and says so in its heading;
**`inputPreview` is neither stored, served nor logged BY THE SERVER** — the shim still transmits it
(`src/channel/run.ts:153-176`) and under Cowork that POST crosses the LAN before the server discards
it, which is #1885 and Bryan's call, not done here; the server-side comments and the shim's failure
log no longer claim a browser sees the prompt; **the finding is registered** —
`docs/security.md#open-findings` has a top-level bullet naming #1884 in its opening clause, CLAUDE.md's
enumeration carries `#1884` and its count word reads **Four**, and
`npx vitest run tests/docs/security-findings-claims.test.ts` is green; `npm run typecheck` +
`npx vitest run tests/server/channel-permission-relay.test.ts tests/server/api-loopback-invariant.test.ts`
green.

**Files touched.** `docs/mcp-tools.md`, `src/server/mcp/channel-routes.ts`, `src/channel/run.ts` (one
log line), `docs/security.md`, `CLAUDE.md`, `tests/server/channel-permission-relay.test.ts`.

## Not in scope

Building the return leg; adding `channel-permission` to the non-loopback scrub inventory; withdrawing
`"claude/channel/permission": {}` (#1885); a permission UI; bounding `pendingPermissions` against a
caller that POSTs arbitrary `requestId`s within one TTL window.

## Review corrections (scope cut)

The round 1–3 logs were replaced by this section. Their load-bearing adoptions survive above: the
type-declaration third site, the comment wording that would redden the text sweep, the `description`
asymmetry stated out loud, and the register entries.

**Finding fixed directly.** *#1794 read-verifies a new security finding and files it nowhere the
project's own machinery can see; `tests/docs/security-findings-claims.test.ts` pins CLAUDE.md against
the register but is blind to a finding in neither, so an unregistered finding is green forever.*
Verified against the test — it derives the count from CLAUDE.md's own enumeration and matches each ref
against a register bullet opening. Fixed by the two register edits above, made together so the suite
stays green, and by citing #1884/#1885 rather than "listed for Bryan". Two findings made this point;
one correction covers both.

## Review corrections (second pass, post-PR)

**The POST-side sweep shipped after all — the "Removed" paragraph below records the scope cut, not
the branch.** The post-cut review round found that with no client polling the GET, nothing ever ran
the sweep, so every forwarded `description` stayed resident for the life of the server process;
`sweepStalePermissions()` now runs from both routes, with the POST as the load-bearing one, pinned by
`evicts stale entries on the POST, not only on the GET nothing polls`. `docs/mcp-tools.md` and the
#1884 register entry describe that state. The route comment had lagged both — it said the entry
"is held for `PERMISSION_TTL_MS`" and that the prompt payload "is not stored", while `description`
IS stored and served and residency is bounded only by the next request's sweep; it now says so.

**The shim stops sending `input_preview`.** The first pass left the shim transmitting it ("the
server now discards it") and filed the LAN crossing under #1884. That was the half within reach:
`src/channel/run.ts`'s `PermissionRequestSchema` no longer declares the field, so the SDK's parse
strips it and the POST body carries `requestId`, `toolName` and `description` only — pinned by
`tests/channel/permission-forward.test.ts`, which drives the real handler through the registered
schema. #1884 stays open for the served `description`; its register entry, `CLAUDE.md`'s clause,
`docs/mcp-tools.md` and `docs/architecture.md` were re-corrected to say what still crosses.

**Removed — and one finding is moot as a result.** The `sweepStale()` hoist and its behavioural spec
(POST `req_A`, roll the clock past `PERMISSION_TTL_MS`, POST `req_B`, roll back, `GET`, assert
`["req_B"]`), plus the clause counting `sweepStale(` occurrences: bounding `pendingPermissions` across
the process lifetime is a real but *pre-existing* condition #1794 does not raise, and the
clock-rollback choreography existed only because the GET-side sweep hides the POST-side one. **That
makes the "the sweep spec cannot fail under the shared-`requestId` rule" finding moot** — there is no
such spec; the condition is recorded in Not in scope. Also removed: the import-graph and
`sseHandler`-count clauses (drift guards on a file the fix barely touches, one already off by one
against the real file — the `inputPreview` sweep is kept because it is the test *for the fix*); the
`{requestId, toolName, description, createdAt}` projection on the `GET` (belt-and-braces, since the
raw map value now matches the documented shape); and the `typeof description === "string"` narrowing
at the store site (a misbehaving-shim concern unrelated to #1794).
