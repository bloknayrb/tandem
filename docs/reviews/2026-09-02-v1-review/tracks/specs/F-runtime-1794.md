# F-runtime — #1794 the channel permission relay documented in `mcp-tools.md` does not exist

Branch `fix/push-paths-runtime-1759`. Closes #1794. Ledgers:
`docs/reviews/2026-09-02-v1-review/areas/security.md:18` and `areas/docs.md:21`. Probe: none — the
gap is read-verified in three places already
(`docs/architecture.md:483`, `docs/decisions.md:1740` = ADR-047 §3 item 1,
`docs/plans/2026-08-07-channel-flag-removal.md:43`).

## Problem

`docs/mcp-tools.md:1410-1443` documents `POST /api/channel-permission`, `GET
/api/channel-permission` and `POST /api/channel-permission-verdict` as a working relay. There is no
return leg and there never was:

- Nothing in `src/client/` reads `pendingPermissions` — no permission UI exists, so no prompt is
  ever shown (grep for `channel-permission` under `src/client/` returns nothing).
- The shim registers `permission_request` as an MCP **notification** handler
  (`src/channel/run.ts:153-189`), and notifications cannot be answered.
- `POST /api/channel-permission-verdict` (`src/server/mcp/channel-routes.ts:152-162`) does
  `pendingPermissions.delete(requestId)`, `console.error`s the verdict and returns it **to the
  browser that submitted it**. The in-place comment says as much: *"Store verdict for the channel
  shim to poll (or push via SSE in follow-up)"* — no store, no poll route, no SSE.

So there is no waiting caller to deliver to. `docs/architecture.md:483` already states this
correctly and says the `mcp-tools.md` half is "wrong and tracked for correction" — this is that
correction.

Second, read-verified while writing this spec: `GET /api/channel-permission` returns the whole map
value including **`inputPreview`**, and `POST /api/channel-permission` `console.error`s
`description`. Those are Claude Code tool-approval prompt contents — for a `Write`, file content;
for a `Bash`, the command line. `authMiddleware` bypasses on loopback, so any local process can read
them. The field is not in the documented response either, so a rewrite that describes reality
either documents a leak or removes it. (`docs/plans/2026-08-07-channel-flag-removal.md:116` filed
this and it never landed.)

## Fix

**Option B from the issue body: describe what the routes do, do not build the return leg.** Building
delivery would mean an SSE `permission:verdict` event, a shim-side waiter, and a verdict→Claude-Code
answer path for a *notification* that has no reply channel — a feature, not a fix, and one whose
resolve map is keyed on a 5-character case-insensitive code with no sender binding. That is a
`/diverge` + plan, not this PR.

- `docs/mcp-tools.md:1410-1443` — retitle the group `### Channel permission relay (experimental —
  no return leg)` and open it with one paragraph: the shim forwards Claude Code's approval prompt to
  the server, the server holds it for 30 s, and **nothing displays it and no verdict reaches Claude
  Code**; the editor has no permission UI, `permission_request` arrives as an MCP notification that
  cannot be answered, and `POST /api/channel-permission-verdict` only deletes the pending entry and
  echoes the verdict to its own caller. Point at `docs/architecture.md:483` and ADR-047 §3. Keep
  the three request/response blocks — they are accurate about the wire — and correct the two
  sentences that imply a working feature: *"for editor-side permission UI"* (there is none) and
  *"failures are logged because the browser may not see the approval prompt"* (the browser never
  sees it). Remove `inputPreview` from the documented `POST` request body only if it is removed from
  the route; it is not (see below) — the shim still sends it.
- **The residual exposure gets a tracked home, because a PR body and a doc paragraph are the
  disposal that already failed once for this exact route.** `docs/plans/2026-08-07-channel-flag-removal.md:116`
  filed this same finding into a plan doc and it never landed; CLAUDE.md's Security section states
  the rule that would have caught it — new findings go in
  [`docs/security.md#open-findings`](../../../../security.md) *as well as* in the tracker. Nothing
  catches the omission automatically: `tests/docs/security-findings-claims.test.ts` pins CLAUDE.md's
  count word against CLAUDE.md's **own** enumeration and each enumerated finding against a register
  bullet — it is blind in the reverse direction, so an unregistered finding is green forever. Three
  edits, all in this PR:
  - **Filed:** [#1884](https://github.com/bloknayrb/tandem/issues/1884) — the security finding —
    and [#1885](https://github.com/bloknayrb/tandem/issues/1885) — the
    `"claude/channel/permission": {}` withdrawal decision. Both exist already; cite the numbers,
    do not re-file.
  - **A new top-level bullet under `## Open findings` in `docs/security.md`**, naming #1884 in its
    first clause (the test's entry matcher reads only the first 240 characters of the bullet, so the
    issue reference must sit in the opening, not in a continuation line). It says: `GET
    /api/channel-permission` serves `description` — the tool-approval summary line — with no scrub,
    readable by **any local process** because `authMiddleware` bypasses auth on loopback
    (`src/server/auth/middleware.ts:163-166`) and by **any token-holding LAN caller under Cowork**
    because `channel-permission` is absent from the non-loopback scrub inventory at
    `src/server/mcp/api-routes.ts:254-259`, which `src/server/mcp/server.ts:768` reaches via
    `lanAwareApiMiddleware`; and `POST /api/channel-permission` is a `NON_LOOPBACK_ALLOWED` carve-out
    (`api-routes.ts:220`), so under Cowork the shim's `input_preview` — file bodies, command lines
    (`src/channel/run.ts:153-176`) — **crosses the LAN before the server discards it**. Name the
    declaration at `src/channel/run.ts:54` as what makes Claude Code send any of it, and name #1885
    as the decision that would close it at the source. Record what this PR does and does not change:
    it removes the field from three server-side sinks; it does not add the scrub and does not
    withdraw the capability. **Do not move the reconciliation-date marker** unless you actually
    reconcile the whole register against the tracker — the test only asserts the marker exists, and
    a bumped date that reflects no reconciliation is exactly the failure #1420 produced.
  - **CLAUDE.md's findings bullet**, in the same commit: add `#1884` to the `— open:` enumeration
    (at parenthetical depth zero, before the `**Fixed but unverified:**` label, with a one-clause
    description and no exploit detail — the exploit detail belongs in `docs/security.md`, which is
    the whole reason that file exists) and change the count word `**Three security findings are
    open` → `**Four security findings are open`. Both edits are required together:
    `tests/docs/security-findings-claims.test.ts` derives the count from the enumeration, so one
    without the other turns that suite red.
- `src/server/mcp/channel-routes.ts` — four removals and one narrowing, no additions:
  - **`:121-135` stops storing `inputPreview` at all**, and the POST handler runs the TTL sweep too.
    This is the removal that matters. Closing only the read route leaves the raw approval-prompt
    content — a `Write`'s file body, a `Bash`'s command line — accumulating in the map for the whole
    process lifetime, because the **only** eviction in the file lives inside the `GET` handler
    (`:142-146`) and this spec has already established that route has no caller: `src/client/`
    greps clean, and the only referents outside the server are `src/channel/run.ts:166` (the POST)
    and `src/shared/api-paths.ts:21`. No reader means no sweep means unbounded growth, visible in a
    heap or crash dump. So: drop `inputPreview` from the destructure **and from the `.set()` and
    from the `Map<string, {...}>` type declaration at `:26`** — that fourth site is easy to miss
    from a two-item removal list, it is a `tsc` error if left behind once the `.set()` stops
    supplying it, and it is the one occurrence that would independently redden spec 3 clause (c).
    Then hoist the "evict entries older than `PERMISSION_TTL_MS`" loop into a small local
    `sweepStale()` called from **both** handlers, so the map bounds itself without a reader. The
    shim keeps sending the field and the documented `POST` body stays accurate — nothing reads it.
  - **Narrow `description` at the store site.** `:132` is `description: (description as string) ??
    ""` — a cast, not a check: `??` catches only `null`/`undefined`, and the guard at `:125`
    validates `requestId` and `toolName` only, so a non-string body field survives and the new `GET`
    projection then does *not* "match the documented shape" for a hostile or buggy caller (spec 1's
    "exactly `requestId`, `toolName`, `description`, `createdAt`" passes with `description` typed as
    an object or a number). Make it `typeof description === "string" ? description : ""`, matching
    how the sibling handlers at `:49-53` and `:103-107` already narrow their untrusted body fields.
    One line, same file, no new surface.
  - `:141-148` `GET /api/channel-permission` returns `{ requestId, toolName, description,
    createdAt }` per entry instead of the raw map value, so the response matches the documented
    shape. With the store change above this is now belt-and-braces rather than the fix.
  - `:136` logs `Permission request: ${toolName} (id: ${requestId})` — drop `description` from the
    line. The verdict log at `:160` is already free of prompt content; leave it.
  - Replace the stale in-place comments at `:117-118` and `:159` with one line each naming the
    state of play (`no return leg — see docs/architecture.md and ADR-047 §3`), so the next reader
    does not re-derive it. **The replacement comments must not name `inputPreview`** — spec 3 clause
    (c) is a whole-file text sweep for that identifier, so the natural comment ("`inputPreview` is no
    longer stored") turns the pin red on day one. Write "the shim's approval-prompt payload is not
    stored" instead. **Do not delete the routes**: the shim POSTs to `/api/channel-permission`
    unconditionally and would start logging failures.
- **`description` is deliberately kept, and here is the bound.** It comes from Claude Code's
  `permission_request` notification (`src/channel/run.ts:153-176`) and is the tool-level summary
  line — "Run npm test", "Edit src/foo.ts" — not the argument payload; `input_preview` is the field
  that carries file bodies and command lines, and that is the one this spec removes. `description`
  stays because it is the documented response shape, is what a future permission UI would render,
  and is the only human-readable thing left once `inputPreview` is gone. **Say the asymmetry out
  loud in the doc rewrite and the PR body**, because on `description` alone this change moves
  exposure the *wrong* way: it removes the stderr sink, which only the machine owner reads, and
  keeps the served one, which nothing reads today but any local process — and, under Cowork, any
  token-holding LAN caller — can. That is defensible only because `description` is a summary line
  and `inputPreview` is the payload; it is not defensible if stated as "prompt content is no longer
  exposed". **Two caveats to record
  rather than fix here**: `authMiddleware` bypasses on loopback
  (`src/server/auth/middleware.ts:165-169`), so any local process can read it; and
  `channel-permission` is absent from the non-loopback read-scrubbing inventory at
  `src/server/mcp/api-routes.ts:257-259` (`info`, `sessions`, `backups`, `launcher/status`,
  `models`, `integrations`), so in Cowork mode a token-holding LAN caller reads it in full. Adding
  it to that scrub list is a security change to a file outside this issue's set; state it in the doc
  rewrite **and file it — that is [#1884](https://github.com/bloknayrb/tandem/issues/1884), with a
  register entry in `docs/security.md` per the bullet above**. "Recorded in the PR body" is not a
  tracked home and is precisely how this finding was lost the first time.
- `src/channel/run.ts:181` — the shim logs
  `Permission relay got HTTP ${res.status} — browser may not see prompt`, the same retired claim the
  server-side comments and `docs/mcp-tools.md` are being corrected for. Reword to name reality
  (`relay POST failed; the request is dropped — there is no browser-side permission UI`), so the
  shim and the server stop disagreeing with the doc in the same PR that fixes the doc.
- **Rules that bite.** `NON_LOOPBACK_ALLOWED` already carries **both channel-permission POSTs** and
  **must not grow** — the `GET` is exempt by *method*, not by membership (`enforceLoopbackMutation`
  short-circuits every GET at `src/server/mcp/api-routes.ts:267-271` before the set is consulted, and
  the set at `:214-226` lists `POST API_CHANNEL_PERMISSION` and `POST
  API_CHANNEL_PERMISSION_VERDICT` only). Nothing here adds a route or a method, and
  `tests/server/api-loopback-invariant.test.ts:49-50` stays green untouched. No new mutating `/api` route and no new MCP tool, so Critical Rule 9's
  license-gated set is not engaged in either half. No Y.Doc write, no Y.Map key, no `data-testid`,
  no skill edit.
- **Deliberately not done here, and tracked as
  [#1885](https://github.com/bloknayrb/tandem/issues/1885):** dropping
  `"claude/channel/permission": {}` from `src/channel/run.ts:54`. It is the declaration that makes
  Claude Code send the prompt contents at all, so removing it is the only change that stops the flow
  at the source — but it is a capability-surface decision on a shipped opt-in path, not a doc
  correction. Bryan's call; #1885 carries the three options and their costs, and #1884's register
  entry names it as the source-level close. Cite the number in the PR body rather than writing
  "listed for Bryan": a deferral with no issue number is untracked while reading as though someone
  is on it.

## Tests

One new file, `tests/server/channel-permission-relay.test.ts`, driving the real registrar with a
recorder `app` (`{get, post, options, delete}` capturing `[path, ...handlers]` — `delete` is
required, `registerChannelRoutes` calls `app.delete(API_CHAT, …)` at `:166` and the registrar throws
without it) and mock `req`/`res`, in the `tests/server/health-route.test.ts` "call the handler
directly" pattern.

**`pendingPermissions` is module-level with no reset export** (`:20-29`), so these specs share one
map. Specs 1–3 use the **same `requestId`**, and each begins by advancing fake timers past
`PERMISSION_TTL_MS` and issuing one draining call, so no spec depends on another's ordering.

**Spec 4 is carved out of that rule and uses two distinct ids, `req_A` and `req_B`.** The map is
keyed by `requestId` (`src/server/mcp/channel-routes.ts:128`), so under the shared-id rule POST B
*overwrites* A and the following `GET` returns exactly one entry with or without a POST-side sweep —
the assertion could not fail, and the clock-rollback observation round 2 added would be inert. Spec 4
therefore uses `req_A` and `req_B`, and still opens with its own drain past `PERMISSION_TTL_MS`.

1. `POST /api/channel-permission` then `GET /api/channel-permission`: the pending entry has exactly
   `requestId`, `toolName`, `description`, `createdAt` — **and `inputPreview` is `undefined`**. Same
   spec, second half: spy `console.error`, POST with a distinctive `description` string, and assert
   the emitted line contains `toolName` and `requestId` but **not** that string. That second half is
   the only thing pinning the "no log line carries prompt content" half of "Done when"; without it a
   later edit restores the leak silently.
2. `POST /api/channel-permission-verdict` responds `{ ok: true, requestId, behavior: "allow" }`, and
   a following `GET` returns `{ pending: [] }`. Pins "the verdict's only effect is deletion" — the
   sentence the doc rewrite turns on.
3. **The negative that carries the issue**, as an import-graph pin rather than a mock. Read
   `src/server/mcp/channel-routes.ts` as text and assert (a) its import list contains no
   `events/queue`, no `events/index` and no broadcast helper; (b) `sseHandler` appears **exactly
   twice** in the file text — its import at `:14` and the single `app.get(API_EVENTS, …)`
   registration at `:35` — stated as an explicit count so the pin fails when someone adds a second
   fan-out site (the round-1 wording said "exactly once", which is off by one against the real file
   and would have been red on day one, inviting a widening rather than a correction); and (c) the
   identifier `inputPreview` appears **nowhere** in the file. Clause (c) is what pins the *stored*
   half of "neither stored nor served nor logged": spec 1 reads through the `GET`, and the same fix
   adds an explicit `{requestId, toolName, description, createdAt}` projection to that `GET`, so an
   implementation that adds only the projection — leaving the raw approval-prompt content
   accumulating in `pendingPermissions` for the process lifetime — passes spec 1. A text sweep for
   the identifier is the smallest assertion that turns red if the destructure, the `.set()` or the
   type declaration at `:26` survives behind the projection. And (d) **`sweepStale(` appears at
   least three times — one `function sweepStale()` declaration plus one call inside each of the two
   handler bodies.** "At least twice" was the round-2 wording and does not pin what it claims: the
   declaration plus a single call in the existing `GET` already makes two, so an implementation that
   never sweeps on POST passes it. If a count feels brittle, assert instead that the call text
   `sweepStale();` appears within the source slice between `app.post(API_CHANNEL_PERMISSION` and
   `app.get(API_CHANNEL_PERMISSION` — that is the property, stated directly. Either way this is the
   text companion to spec 4, which is the behavioural pin. A `vi.mock` of `../events/queue.js`
   is **not** used: the module is never imported by the subject, so the mock records zero calls
   unconditionally — true before and after the change, and green for a "fix" that fans out through
   `sseHandler` instead. (It also would not resolve: `vi.mock` paths are relative to the test file,
   so `../events/queue.js` from `tests/server/` points at `tests/events/queue.js`.) This is the same
   shape as the importer-set pins in `tests/server/annotation-remove-seam.test.ts` and
   `tests/server/documents-open.test.ts`, and it turns red the moment someone wires an emit in.
4. **Sweep-on-POST — two distinct ids, and the observation must be blind to the GET's own sweep.**
   **Use `req_A` and `req_B`, not the shared `requestId` from the preamble** (carved out there): the
   map is keyed by id, so with one id POST B overwrites A and the `GET` returns one entry whether or
   not the POST swept — no sweep, no failure, nothing pinned. With two ids the assertion is that
   `pending` maps to exactly `["req_B"]` (and holds both A and B in the no-sweep case).
   The naive shape
   (POST A, advance past `PERMISSION_TTL_MS`, POST B, `GET` and expect only B) **also cannot fail**,
   for a second and independent reason: the
   `GET` handler evicts every entry older than `PERMISSION_TTL_MS` before responding
   (`src/server/mcp/channel-routes.ts:141-147`, unchanged by this fix), so A is gone whether or not
   the POST swept. Deleting the GET-side sweep is not an option either — `docs/security.md:114` and
   `docs/decisions.md:1873` both rest the "non-GET, not mutating" phrasing on `GET
   /api/channel-permission` mutating. **Roll the clock back instead**: `vi.setSystemTime(t0)`, POST
   `req_A`; `vi.setSystemTime(t0 + PERMISSION_TTL_MS + 1)`, POST `req_B`; `vi.setSystemTime(t0 + 1)`,
   then `GET`. At that clock `req_A` is no longer stale, so the GET sweep cannot touch it: with a
   POST-side sweep the response is exactly `["req_B"]`, without one it is `["req_A", "req_B"]`. That
   is the assertion that pins the half of the fix which bounds the map in production, where the `GET`
   never runs. Spec 3's clause (d) is the belt-and-braces companion; the GET-side sweep stays covered
   by spec 2's drain.

## Done when

`docs/mcp-tools.md` no longer describes a relay that does not run and says so in its heading;
**`inputPreview` is neither stored, served nor logged BY THE SERVER** — the shim still transmits it
(`src/channel/run.ts:153-176`), and under Cowork that POST crosses the LAN before the server
discards it, because `POST /api/channel-permission` is a `NON_LOOPBACK_ALLOWED` carve-out; closing
*that* means withdrawing `"claude/channel/permission": {}` at `src/channel/run.ts:54`, which is
Bryan's call, tracked as #1885, and not done here.
**The finding is registered:** `docs/security.md#open-findings` has a top-level bullet naming #1884
in its opening clause, CLAUDE.md's enumeration carries `#1884` and its count word reads **Four**, and
`npx vitest run tests/docs/security-findings-claims.test.ts` is green — the register and CLAUDE.md
agree.
**The pending map no longer grows without bound across the process lifetime for a well-behaved
shim** — entries older than `PERMISSION_TTL_MS` are swept on POST as well as GET, pinned by spec 4's
clock-rollback with two distinct ids. It is **still unbounded within one TTL window** against a
caller that POSTs arbitrary `requestId`s: every field is caller-supplied, there is no count or length
cap beyond `express.json`'s ~100 kb per request, and the route is reachable without authentication
from any local process and, under Cowork, from any token-holding LAN caller. That is unchanged by
this PR (removing `inputPreview` shrinks each entry), and the same sentence belongs in #1884's
register entry so the PR body does not ship a claim stronger than the code.
No log line carries prompt content, pinned by spec 1;
`description` remains readable over `GET /api/channel-permission` by any local process and, under
Cowork, by any token-holding LAN caller — stated in the doc rewrite and registered as #1884 rather
than fixed; the shim's "browser may not see prompt" line no longer claims a UI that does not exist;
four specs green; `npm run typecheck` + `npx vitest run tests/server tests/docs` green.

**Files touched.** `docs/mcp-tools.md`, `src/server/mcp/channel-routes.ts`, `src/channel/run.ts`
(the one log line), `docs/security.md`, `CLAUDE.md`, and the new
`tests/server/channel-permission-relay.test.ts`.

## Not in scope

Implementing verdict delivery (SSE or otherwise); a permission UI in `src/client/`; removing
`"claude/channel/permission"` from the shim's declared capabilities (Bryan's call, #1885); adding
`channel-permission` to the non-loopback scrub inventory (#1884); deleting the
routes; `docs/roadmap.md:266`'s endpoint list, which is a loopback-carve-out inventory and is
correct as it stands.

## Review corrections (round 1)

**Adopted**

- *The spec closed the read route but not the collection: `inputPreview` kept being stored, and the
  only eviction runs inside the `GET` handler the spec itself proves has no caller — so approval-
  prompt content accumulates in server memory unbounded for the process lifetime, while "Done when"
  read as if the leak were addressed.* Verified: store at `src/server/mcp/channel-routes.ts:121-135`,
  eviction only at `:142-146` inside the `GET`, no consumer anywhere outside `src/channel/run.ts:166`
  and `src/shared/api-paths.ts:21`. Adopted as a third removal — stop storing the field, and sweep on
  POST as well as GET — and spec 4 is re-worded to pin sweep-on-POST, the path production actually
  takes.
- *Test 3 is vacuous: it mocks a module the subject never imports, and the `vi.mock` path would not
  resolve from `tests/server/`.* Verified against `src/server/mcp/channel-routes.ts:1-18` (only
  `sseHandler` from `../events/sse.js`). Adopted: replaced with an import-graph pin over the module's
  text, which can actually fail, plus a reference to the existing importer-set pins it copies.
- *The recorder `app` shape is incomplete and the registrar would throw.* Verified: `app.delete` at
  `:166`. Adopted: `delete` added.
- *`pendingPermissions` is module-level with no reset, so the specs share state and spec 2 is
  order-dependent.* Adopted: the Tests preamble now fixes one shared `requestId` and a per-spec
  drain.
- *"No log line carries prompt content" is checked by no spec.* Adopted: spec 1 gains the
  `console.error` spy and the negative assertion on a distinctive `description`.
- *`description` is dropped from the log as prompt content but kept on the wire — an incoherent
  threat model, and `channel-permission` is absent from the non-loopback scrub inventory.* Verified:
  `src/server/mcp/api-routes.ts:257-259` enumerates six read routes and this is not one of them.
  Adopted as an explicit decision paragraph — `description` is the tool-level summary and stays,
  `input_preview` is the payload and goes — with both caveats (loopback bypass, missing from the
  scrub list) recorded for the doc rewrite and the PR body.
- *`src/channel/run.ts:181` still logs the same retired "browser may not see prompt" claim.*
  Adopted: added to the fix's file set with replacement wording.

**Not adopted**

- *Add `channel-permission` to the non-loopback scrubbing list in `src/server/mcp/api-routes.ts`.*
  Not done here. It is a security change to a file outside this issue's named set, on a route the
  same PR is documenting as having no consumer; doing it under a doc-correction issue would land an
  unreviewed posture change. Recorded in the spec and the PR body instead, which is the half the
  finding actually asked for.

## Review corrections (round 2)

**Adopted**

- *Test 4 ("sweep-on-POST") cannot fail: it observes through `GET /api/channel-permission`, whose
  own eviction loop drops the stale entry whether or not the POST swept — so the half of the fix
  that bounds the map in production is pinned by nothing.* Verified at
  `src/server/mcp/channel-routes.ts:141-147` (the GET evicts before responding, and this spec leaves
  that sweep unchanged), and verified that deleting the GET-side sweep is not available:
  `docs/security.md:113-115` and `docs/decisions.md:1873` both rest the "non-GET, not mutating"
  phrasing on this exact route mutating. Adopted with the clock-rollback observation — POST A at
  `t0`, POST B at `t0 + PERMISSION_TTL_MS + 1`, then `GET` with the clock set back to `t0 + 1`, at
  which A is not stale and only a POST-side sweep can have removed it. Spec 3 gains a `sweepStale(`
  call-count clause as the text companion. (Two findings made this point; one correction covers
  both. The test-only `_pendingPermissionCountForTests()` export the first proposed is not taken —
  the rollback needs no production export, and the wave-table's rule for this track is minimal
  changes in the named files.)
- *"`inputPreview` is neither stored nor served nor logged" is unpinned on the stored half: spec 1
  reads through the `GET`, and the same fix adds a projection to that `GET`, so a projection-only
  implementation passes while the raw payload accumulates in `pendingPermissions`.* Verified against
  the store site at `:121-135` and the projection specced at Fix `:67-69`. Adopted: spec 3's text pin
  gains a clause asserting the identifier `inputPreview` appears **nowhere** in
  `src/server/mcp/channel-routes.ts` — the smallest assertion that turns red if the destructure or
  the `.set()` survives behind the projection.
- *Spec 3's "`sseHandler` is referenced exactly once" is off by one against the file as written
  (import at `:14`, registration at `:35`), so the assertion as specced is red on day one and
  invites being widened rather than corrected.* Verified. Adopted: restated as "appears exactly
  twice — the import and the single `app.get(API_EVENTS, …)` registration", with the count stated
  explicitly so a second fan-out site still turns it red. (Two findings made this point.)
- *"Done when" overstates the closure: `inputPreview` is still transmitted, and under Cowork it
  crosses the LAN before the server discards it.* Verified: the shim still sends `input_preview`
  (`src/channel/run.ts:153-176`), `"claude/channel/permission": {}` stays declared at `run.ts:54`,
  and `POST /api/channel-permission` is a `NON_LOOPBACK_ALLOWED` carve-out. Adopted: the clause is
  now scoped to the server and names the shim-side half and what closing it would take.
- *Removing `description` from the log while keeping it on the wire moves exposure the wrong way —
  the stderr sink only the machine owner reads goes, the reachable one stays.* Verified (loopback
  bypass at `src/server/auth/middleware.ts:164-168`; `channel-permission` absent from the
  non-loopback scrub inventory). Adopted as the finding's second option: the asymmetry is now stated
  out loud in the Fix bullet, the doc rewrite and "Done when", rather than left implicit. Dropping
  `description` from the GET payload is **not** taken — it is the documented response shape and the
  only human-readable field a future permission UI would render, and this PR's mandate is to make
  the doc match the code, not to shrink a documented response under a doc-correction issue.
- *"`NON_LOOPBACK_ALLOWED` already carries all three paths" is wrong: it carries two entries, and
  the GET is exempt by method rather than by membership.* Verified at
  `src/server/mcp/api-routes.ts:214-226` and `:267-271`. Adopted: reworded.

**Not adopted**

- None.

## Review corrections (round 3)

**Adopted**

- *#1794 read-verifies a NEW security finding and then files it nowhere the project's own machinery
  can see — CLAUDE.md's Security section requires new findings in `docs/security.md#open-findings`
  as well as the tracker, and the spec routed the residual into a PR body and a doc paragraph: the
  same disposal that already failed once for this exact route
  (`docs/plans/2026-08-07-channel-flag-removal.md:116`, "it never landed").* Verified in full: the
  serve site at `src/server/mcp/channel-routes.ts:141-148` with no scrub; the six-route scrub
  inventory at `src/server/mcp/api-routes.ts:254-259` that does not include it, reached via
  `lanAwareApiMiddleware` at `src/server/mcp/server.ts:768`; the loopback auth bypass at
  `src/server/auth/middleware.ts:163-166`; and `POST API_CHANNEL_PERMISSION` in
  `NON_LOOPBACK_ALLOWED` at `api-routes.ts:220`, which puts `src/channel/run.ts:153-176`'s
  `input_preview` on the LAN under Cowork. Also verified that nothing catches the omission:
  `tests/docs/security-findings-claims.test.ts` checks CLAUDE.md → `docs/security.md` only, so an
  unregistered finding is green forever. **Adopted in full, and the tracker half is already done —
  both issues are filed:** [#1884](https://github.com/bloknayrb/tandem/issues/1884) (the finding)
  and [#1885](https://github.com/bloknayrb/tandem/issues/1885) (the
  `"claude/channel/permission": {}` withdrawal decision, so "Bryan's call" is a tracked deferral
  with a number). The spec now carries a Fix bullet requiring the `docs/security.md` register entry
  (with the issue ref in the bullet's opening clause, since the test's matcher reads only the first
  240 characters) and the paired CLAUDE.md edit — enumeration plus the count word `Three` → `Four`,
  which must move together or that suite reddens — and "Done when" names both. The reconciliation
  marker is explicitly left alone unless a real reconciliation happens. (Two findings made this
  point; one correction covers both. The second noted correctly that the register entry alone cannot
  redden the suite, which is why the CLAUDE.md half is stated as a deliberate choice rather than a
  test requirement.)
- *Spec 4 — the only test that pins sweep-on-POST — cannot fail, because the Tests preamble forces
  both POSTs onto one `requestId` and the map is keyed by it.* Verified: the preamble's shared-id
  rule against `pendingPermissions.set(requestId, …)` at `src/server/mcp/channel-routes.ts:128` —
  POST B overwrites A, the GET returns one entry either way, and round 2's clock-rollback observation
  is inert. Adopted: the preamble now carves spec 4 out and gives it `req_A` / `req_B`, spec 4 asserts
  `pending` is exactly `["req_B"]` (both, in the no-sweep case), and spec 3 clause (d) is tightened
  from "at least twice" (satisfied by the declaration plus the pre-existing GET call) to three
  occurrences — one declaration and one call per handler — with a slice-based alternative stated.
- *The `description` store is `(description as string) ?? ""`, a cast rather than a check, so the new
  GET projection does not in fact "match the documented shape" for a hostile or buggy caller.*
  Verified at `:132`, against the `requestId`/`toolName`-only guard at `:125` and the sibling
  handlers' narrowing at `:49-53` / `:103-107`. Adopted as a one-line narrowing in the same file:
  `typeof description === "string" ? description : ""`.
- *The Fix enumerates removals but omits the `inputPreview` field on the `pendingPermissions` type
  declaration, which spec 3 clause (c) then requires to be gone.* Verified at `:26`. Adopted: `:26`
  joins the removal list explicitly, noted as both a `tsc` error if left and an independent redden of
  clause (c).
- *Clause (c)'s whole-file sweep for `inputPreview` collides with the same spec's instruction to
  replace the in-place comments with a line naming the state of play.* Adopted: the comment bullet
  now forbids naming the identifier and supplies the replacement phrasing ("the shim's
  approval-prompt payload is not stored").
- *"The pending map is bounded without a reader" is stronger than a TTL sweep delivers: unbounded
  distinct `requestId`s inside one 30 s window still grow it, and after the last POST the residue is
  never swept at all.* Verified — no count or length cap beyond `express.json`'s default, and the
  route is reachable unauthenticated on loopback and, under Cowork, from the LAN. Adopted: "Done
  when" is scoped to "no longer grows without bound across the process lifetime for a well-behaved
  shim", with the within-one-TTL-window residual stated and marked unchanged by this PR, and the same
  sentence required in #1884's register entry.

**Not adopted**

- None.
