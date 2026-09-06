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
- `src/server/mcp/channel-routes.ts` — three removals, no additions:
  - **`:121-135` stops storing `inputPreview` at all**, and the POST handler runs the TTL sweep too.
    This is the removal that matters. Closing only the read route leaves the raw approval-prompt
    content — a `Write`'s file body, a `Bash`'s command line — accumulating in the map for the whole
    process lifetime, because the **only** eviction in the file lives inside the `GET` handler
    (`:142-146`) and this spec has already established that route has no caller: `src/client/`
    greps clean, and the only referents outside the server are `src/channel/run.ts:166` (the POST)
    and `src/shared/api-paths.ts:21`. No reader means no sweep means unbounded growth, visible in a
    heap or crash dump. So: drop `inputPreview` from the destructure and from the `.set()`, and
    hoist the "evict entries older than `PERMISSION_TTL_MS`" loop into a small local
    `sweepStale()` called from **both** handlers, so the map bounds itself without a reader. The
    shim keeps sending the field and the documented `POST` body stays accurate — nothing reads it.
  - `:141-148` `GET /api/channel-permission` returns `{ requestId, toolName, description,
    createdAt }` per entry instead of the raw map value, so the response matches the documented
    shape. With the store change above this is now belt-and-braces rather than the fix.
  - `:136` logs `Permission request: ${toolName} (id: ${requestId})` — drop `description` from the
    line. The verdict log at `:160` is already free of prompt content; leave it.
  - Replace the stale in-place comments at `:117-118` and `:159` with one line each naming the
    state of play (`no return leg — see docs/architecture.md and ADR-047 §3`), so the next reader
    does not re-derive it. **Do not delete the routes**: the shim POSTs to
    `/api/channel-permission` unconditionally and would start logging failures.
- **`description` is deliberately kept, and here is the bound.** It comes from Claude Code's
  `permission_request` notification (`src/channel/run.ts:153-176`) and is the tool-level summary
  line — "Run npm test", "Edit src/foo.ts" — not the argument payload; `input_preview` is the field
  that carries file bodies and command lines, and that is the one this spec removes. `description`
  stays because it is the documented response shape, is what a future permission UI would render,
  and is the only human-readable thing left once `inputPreview` is gone. **Two caveats to record
  rather than fix here**: `authMiddleware` bypasses on loopback
  (`src/server/auth/middleware.ts:165-169`), so any local process can read it; and
  `channel-permission` is absent from the non-loopback read-scrubbing inventory at
  `src/server/mcp/api-routes.ts:257-259` (`info`, `sessions`, `backups`, `launcher/status`,
  `models`, `integrations`), so in Cowork mode a token-holding LAN caller reads it in full. Adding
  it to that scrub list is a security change to a file outside this issue's set; state it in the doc
  rewrite and the PR body so the next reader does not re-derive it, and leave the code change to
  whoever owns that inventory.
- `src/channel/run.ts:181` — the shim logs
  `Permission relay got HTTP ${res.status} — browser may not see prompt`, the same retired claim the
  server-side comments and `docs/mcp-tools.md` are being corrected for. Reword to name reality
  (`relay POST failed; the request is dropped — there is no browser-side permission UI`), so the
  shim and the server stop disagreeing with the doc in the same PR that fixes the doc.
- **Rules that bite.** `NON_LOOPBACK_ALLOWED` already carries all three paths and **must not
  grow** — nothing here adds a route or a method, and `tests/server/api-loopback-invariant.test.ts:49-50`
  stays green untouched. No new mutating `/api` route and no new MCP tool, so Critical Rule 9's
  license-gated set is not engaged in either half. No Y.Doc write, no Y.Map key, no `data-testid`,
  no skill edit.
- **Deliberately not done here:** dropping `"claude/channel/permission": {}` from
  `src/channel/run.ts:54`. It is the declaration that makes Claude Code send the prompt contents at
  all, so removing it is the only change that stops the flow at the source — but it is a
  capability-surface decision on a shipped opt-in path, not a doc correction. Listed for Bryan.

## Tests

One new file, `tests/server/channel-permission-relay.test.ts`, driving the real registrar with a
recorder `app` (`{get, post, options, delete}` capturing `[path, ...handlers]` — `delete` is
required, `registerChannelRoutes` calls `app.delete(API_CHAT, …)` at `:166` and the registrar throws
without it) and mock `req`/`res`, in the `tests/server/health-route.test.ts` "call the handler
directly" pattern.

**`pendingPermissions` is module-level with no reset export** (`:20-29`), so these specs share one
map. Every spec below uses the **same `requestId`**, and each begins by advancing fake timers past
`PERMISSION_TTL_MS` and issuing one draining call, so no spec depends on another's ordering.

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
   `events/queue`, no `events/index` and no broadcast helper, and (b) `sseHandler` is referenced
   exactly once, on the `app.get(API_EVENTS, …)` registration. A `vi.mock` of `../events/queue.js`
   is **not** used: the module is never imported by the subject, so the mock records zero calls
   unconditionally — true before and after the change, and green for a "fix" that fans out through
   `sseHandler` instead. (It also would not resolve: `vi.mock` paths are relative to the test file,
   so `../events/queue.js` from `tests/server/` points at `tests/events/queue.js`.) This is the same
   shape as the importer-set pins in `tests/server/annotation-remove-seam.test.ts` and
   `tests/server/documents-open.test.ts`, and it turns red the moment someone wires an emit in.
4. **Sweep-on-POST**: with fake timers, POST a request, advance past `PERMISSION_TTL_MS`, POST a
   *different* `requestId`, and assert a following `GET` returns only the second — i.e. the first
   was evicted by the POST, not by the read. Pins the half of the fix that bounds the map in
   production, where the `GET` never runs. (The GET-side sweep is unchanged and still covered by
   spec 2's drain.)

## Done when

`docs/mcp-tools.md` no longer describes a relay that does not run and says so in its heading;
**`inputPreview` is neither stored nor served nor logged**, and the pending map is bounded without a
reader (swept on POST); no log line carries prompt content, pinned by spec 1; the shim's
"browser may not see prompt" line no longer claims a UI that does not exist; four specs green;
`npm run typecheck` + `npx vitest run tests/server` green.

## Not in scope

Implementing verdict delivery (SSE or otherwise); a permission UI in `src/client/`; removing
`"claude/channel/permission"` from the shim's declared capabilities (Bryan's call); deleting the
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
