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
- `src/server/mcp/channel-routes.ts` — two removals, no additions:
  - `:141-148` `GET /api/channel-permission` returns `{ requestId, toolName, description,
    createdAt }` per entry instead of the raw map value, so the response matches the documented
    shape and stops serving `inputPreview` to any local reader. Nothing consumes the route, so
    there is no compatibility surface.
  - `:136` logs `Permission request: ${toolName} (id: ${requestId})` — drop `description` from the
    line. The verdict log at `:160` is already free of prompt content; leave it.
  - Replace the stale in-place comments at `:117-118` and `:159` with one line each naming the
    state of play (`no return leg — see docs/architecture.md and ADR-047 §3`), so the next reader
    does not re-derive it. **Do not delete the routes**: the shim POSTs to
    `/api/channel-permission` unconditionally and would start logging failures.
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
recorder `app` (`{get, post, options}` capturing `[path, ...handlers]`) and mock `req`/`res`, in the
`tests/server/health-route.test.ts` "call the handler directly" pattern.

1. `POST /api/channel-permission` then `GET /api/channel-permission`: the pending entry has exactly
   `requestId`, `toolName`, `description`, `createdAt` — **and `inputPreview` is `undefined`**.
   Kills a reintroduction of the raw map value, and pins the response the doc now describes.
2. `POST /api/channel-permission-verdict` responds `{ ok: true, requestId, behavior: "allow" }`, and
   a following `GET` returns `{ pending: [] }`. Pins "the verdict's only effect is deletion" — the
   sentence the doc rewrite turns on.
3. **The negative that carries the issue**: after a verdict, no SSE/event fan-out ran. Assert by
   construction — `src/server/mcp/channel-routes.ts` imports `sseHandler` only for `GET /api/events`
   and imports nothing from `src/server/events/queue.js`; the spec asserts the verdict handler
   produced no call on a `vi.mock`ed `../events/queue.js`. Kills a "fix" that adds an emit without
   a consumer and calls the relay delivered.
4. A request older than `PERMISSION_TTL_MS` is evicted by the next `GET` (fake timers). Pre-existing
   behaviour, unpinned today, and it is stated in the doc block being kept.

## Done when

`docs/mcp-tools.md` no longer describes a relay that does not run and says so in its heading;
`GET /api/channel-permission` no longer serves `inputPreview` and no log line carries prompt
content; four specs green; `npm run typecheck` + `npx vitest run tests/server` green.

## Not in scope

Implementing verdict delivery (SSE or otherwise); a permission UI in `src/client/`; removing
`"claude/channel/permission"` from the shim's declared capabilities (Bryan's call); deleting the
routes; `docs/roadmap.md:266`'s endpoint list, which is a loopback-carve-out inventory and is
correct as it stands.
