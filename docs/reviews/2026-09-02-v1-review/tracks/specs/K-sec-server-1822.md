# K-sec-server — #1822 items 1, 2, 3, 7, 8: channel-error log injection, no Hocuspocus `maxPayload`, a 413 that ships the install path, phantom 200s, and the dark license wire

Branch `fix/security-lows-server-half-log-injection-unbounded-frames-a-leaking-413-and-two-presence-status-oracles-1822`. **Refs #1822, does not close it** — items 4, 5, 6 (supervisor cwd/env, `keychain_get`, sidecar `NODE_ENV`) are K-sec-launcher's and are unstarted. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:462`.

Bryan's 2026-09-08 triage comment governs three of the five: item 1's "any host" is corrected (LAN callers hold a bearer token), item 2 gets the pre-auth payload bound and **no** connection ceiling, and **item 7 gets no code change**.

## Problem

1. **Channel-error log injection (`src/server/mcp/channel-routes.ts:101-117`).** `message` is interpolated raw into `console.error` on both arms (`:108`, `:114`) and `String(error)` is too on the `UNKNOWN_CODE` arm, which logs the rejected value *before* the 400 — contradicting the comment two lines above it. ESC/BEL/CR/LF and a full OSC-0 title sequence reach the operator's terminal verbatim, unbounded in length. `POST /api/channel-error` is in `NON_LOOPBACK_ALLOWED` (`api-routes.ts:214-225`), so under a LAN bind a **bearer-authenticated** peer reaches it. Same shape at `:160` (`toolName`, `requestId`) and `:182` (`requestId`) on two more carved-out routes; those fields are `typeof … !== "string"`-guarded (`:147`, `:174`), so there the hazard is control characters and length only. **`message` and `error` are unvalidated**, and `String(value)` *throws* on a JSON-craftable object — measured: `node -e 'String(JSON.parse("{\"toString\":1,\"valueOf\":2}"))'` → `TypeError: Cannot convert object to primitive value`. That throw is in an outer-app handler, so item 3's handler cannot catch it; it lands on Express's HTML error page.
2. **No `maxPayload` on Hocuspocus (`src/server/yjs/provider.ts:212`).** `hocuspocusInstance.listen()` takes no websocket options, so `new WebSocketServer({ noServer: true })` keeps ws's 100 MiB default. Measured in the issue: an *unauthenticated* peer's 90 MiB frame moved RSS 179→331 MB; 120 MiB closed 1009. Hocuspocus always binds `127.0.0.1` (`provider.ts:106`), so this is loopback-only. `events/wake-socket.ts:172` is the in-repo precedent (cap 1024).
3. **413 ships an HTML stack trace with the install path (`src/server/mcp/server.ts:560`, `:761`).** A 200 kB `application/json` body to `POST /mcp` returns `413 text/html` whose `<pre>` carries `PayloadTooLargeError` plus absolute `…\node_modules\raw-body\index.js:163` frames. **It is not loopback-only:** `createMcpExpressApp` installs a bare `express.json()` at the sub-app root and `app.use(mcpApp)` (`:761`) mounts it at the ROOT above `registerApiRoutes` (`:764`), so every `/api` body passes the 100 kB parser too. Six `/api` routes are carved out of `enforceLoopbackMutation`, so a bearer-authenticated LAN peer under a Cowork bind gets the operator's username and install path. (`app.use("/api", authMiddleware)` at `:707` is why a token is required; `finalhandler` emits `err.stack` whenever `NODE_ENV !== "production"` — item 6's reported sidecar state.)
4. **Item 7 — phantom 200s (`server.ts:851-857`).** The SPA fallback answers any unmatched path with `index.html`, byte-identical; `/.git/HEAD` returns 200 with no file read. `refuted.md:13` records the traversal claim as refuted.
5. **Item 8 — the dark license wire (`src/server/mcp/routes/license.ts:38-51`, `:88-97`).** Both wires emit `status: "licensed"` beside `gateActive: false`; the LAN-scrubbed wire also carries `licenseInstalled` (`:95`).

## Fix

**Item 1 — `channel-routes.ts` only.** One module-private helper plus an exported clamp constant, used at all five interpolation sites (`:108` twice, `:114`, `:160` twice, `:182`):

```ts
export const LOG_FIELD_MAX = 200;
function sanitizeForLog(value: unknown): string
```

It must be **total before it strips**, because two inputs are unvalidated request-body fields:

```ts
let s: string;
try { s = typeof value === "string" ? value : String(value); } catch { s = "[unstringifiable]"; }
```

Then strip C0 **including `\n`/`\r`/`\t`**, C1 (`\x80-\x9f`), DEL and the bidi set (`\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c`), then clamp to `LOG_FIELD_MAX` with a `…` marker. Model: `stripControlChars` (`src/client/utils/diagnostics.ts:73`) — **not imported**, because `src/server` imports nothing from `src/client` today, and this copy strips LF (a bare LF forges a log line, the whole point here). Keep the `UNKNOWN_CODE` log where it is; rewrite its comment to describe the sanitize-and-clamp. **`NON_LOOPBACK_ALLOWED` does not change** — the carve-out is the finding's premise.

**Left with reason (say it in the PR body):** `provider.ts:92`/`:96` interpolate an attacker-supplied `Origin` into `console.error` unstripped. Same class, but Hocuspocus binds `127.0.0.1` unconditionally, so it is loopback-only and strictly lower severity; item 2 opens that file, so leaving it is deliberate, not unnoticed.

**Item 2 — `provider.ts`.** Module constant, passed as `listen`'s **third positional** argument:

```ts
export const MAX_SYNC_PAYLOAD_BYTES = MAX_FILE_SIZE + 16 * 1024 * 1024; // 66 MiB
await hocuspocusInstance.listen(null, null, { maxPayload: MAX_SYNC_PAYLOAD_BYTES });
```

Import `MAX_FILE_SIZE` from `src/shared/constants.ts:155` (50 MB); **add no new constant there**. `listen`'s signature is `(portOrCallback = null, callback = null, websocketOptions = {})` and `typeof null !== "number"`, so the constructor's port survives and the options reach `new Server(this, websocketOptions)` → `new WebSocketServer({ noServer: true, ...websocketOptions })`. ws rejects at the **frame header** (`node_modules/ws/lib/receiver.js:437-450`, on the declared `_payloadLength`), which is structurally before `onAuthenticate` — what the issue asks for.

Why the cap is safe: `maxPayload` bounds **inbound** frames only (server→client is unbounded), and the repo has **no client-side Yjs persistence** (`grep -rn "IndexeddbPersistence\|y-indexeddb" src/ package.json` returns nothing), so a browser's `syncStep2` on first connect is empty and every later frame carries only what that client typed or pasted.

**Residual, stated rather than measured.** `MAX_FILE_SIZE` gates **bytes on disk** (`documents/open.ts:718`) or uploaded bytes (`:568`), and a `.docx` is a ZIP — so its *extracted text* is not bounded by 50 MB and `MAX_FILE_SIZE + 16 MiB` is not provably above such a room's largest inbound frame. The reachable failure is one client-origin transaction larger than the cap (bulk paste, source-view commit, or a reconnect re-sending state after the server dropped the doc): ws answers 1009 and the provider reconnects and re-sends, so the symptom is a wedged sync loop, not a dropped message. **The PR body must say this, and one issue must be filed for it** (title naming extracted-text expansion versus `MAX_FILE_SIZE`) — check the open list first so it is not a duplicate. Measuring the `.docx` expansion ratio is *not* in this PR's scope. The PR body must also record that this closes the **per-frame** bound only — N connections just under the cap remain unbounded, by Bryan's decision.

**Item 3 — `server.ts` only.** A four-argument JSON error handler registered on **`mcpApp`**, after the three `mcpApp.*("/mcp", …)` routes (the last ends at `:667`) and before `app.use(mcpApp)` at `:761`. An error thrown inside a mounted sub-app is offered to that sub-app's error handlers before the parent's `finalhandler`, so this also answers `/api` body-parse errors — the parser that raises them is the sub-app's. A throw inside an outer-app `/api` **route handler** is past that stack and still reaches `finalhandler`, which is why item 1's helper has to be total.

Shape: `next(err)` when `res.headersSent`; `err.status` when numeric, else 500; branch the body:

- `req.path === "/mcp"` → the JSON-RPC envelope the rest of this endpoint uses (`sendJsonRpcError`, `:301`) and `src/cli/mcp-stdio.ts` parses: `{"jsonrpc":"2.0","error":{"code":-32600,"message":"Request body exceeds this endpoint's size limit."},"id":null}`.
- else `err.type === "entity.too.large"` → `{ error: "PAYLOAD_TOO_LARGE", message: "Request body exceeds this endpoint's size limit." }`.
- else `err.type === "entity.parse.failed"` → `{ error: "BAD_REQUEST", message: "Request body is not valid JSON." }`.
- else → `{ error: "INTERNAL_ERROR", message: "Request could not be processed." }`.

**No `err.message`, no `err.stack`, no path in any branch.** The PR body must state that `/api` body-parse errors change shape without `api-routes.ts` being edited, so E2-upgrade is not surprised.

**Item 7 — no code change; the analysis is the deliverable.** A 404 rule narrow enough to be safe cannot be written from the path shape: the SPA fallback serves every client route, and any route containing a dot — every deep link to a document whose name carries one — is indistinguishable from `/.git/HEAD` by pattern. Nothing is disclosed either way. **Verbatim in the PR body and as a comment on #1822.**

**Item 8 — no code change; both halves are recommendations to Bryan.** All six wire consumers were enumerated and **all six are guarded**: `deriveLicenseUi` (`client/utils/license-ui.ts:66`, `!state.gateActive` early return), `useLicense.svelte.ts:47-48` and `:118`, `SettingsLicenseTab.svelte:36` and `:78`, `src-tauri/src/lib.rs:2565` (`Public` before it reads `status`), and `cli/license.ts:62,66,73,91,161` (in-process `LicenseState`, never the wire). So "any consumer that forgets `gateActive`" describes zero consumers today. Against that: the sentinel exists so an older client talking to a newer sidecar stays byte-identical (`routes/license.ts:22-28`), `CLAUDE.md` requires the dark gate to stay byte-identical, `"inactive"` is not in `LicenseStatus` or `LicenseStatusResponse["status"]` (a type change in two languages plus Rust), and the sentinel lives only on the `!gateActive` arm, which is unreachable once the flag flips — so it buys nothing after the flip and risks the dark window before it. `licenseInstalled` likewise: it reports the **host's** purchase state to a caller who already holds an operator-issued token, removing it costs the beta activation confirmation named at `routes/license.ts:42-47`, and `H-c-1789.md:168` already records it as "documented deliberate". Both go in the PR body under `bryan`.

## Tests

- **`tests/server/channel-error-log-sanitization.test.ts` (new).** Reuse `makeRecorderApp()` (`channel-permission-relay.test.ts:46`) so the real handler runs, with `vi.spyOn(console, "error")`.
  - (a) `message` of `"a\u001b]0;pwned\u0007b\r\nFAKE"` on the **valid-code** arm logs a string containing none of `\u001b`, `\u0007`, `\n`, `\r` — kills a fix that only sanitizes the `UNKNOWN_CODE` arm.
  - (b) Same payload with an out-of-schema `error`: the line still logs (diagnostic trail survives) and carries no control character from either field — kills deleting the log, and kills sanitizing `message` but not `String(error)`.
  - (c) **Clamp, on every clamped field.** 5,000-character values for `error` and `message` (UNKNOWN_CODE arm), for `message` (valid arm), and for `toolName`/`requestId` (`/api/channel-permission`) and `requestId` (`/api/channel-permission-verdict`); each asserted with `expect(logged).not.toContain("X".repeat(300))`. That form is independent of the implementer's prefix wording, which a total-length bound is not.
  - (d) **A benign non-ASCII `message` survives unchanged:** `"connexion échouée — 日本語 ok"`, asserted with `toContain` on the whole string — kills a lazy `replace(/[^\x20-\x7e]/g, "")`.
  - (e) **Totality.** `{ error: "CHANNEL_CONNECT_FAILED", message: JSON.parse('{"toString":1,"valueOf":2}') }` returns 200 rather than a thrown 500 and logs a benign placeholder. This is the case that separates a total helper from `String(value)`.
- **`tests/server/hocuspocus-max-payload.test.ts` (new).** No assertion on the constant's arithmetic — a number pinned against its own derivation guards nothing the two behavioural specs do not.
  - (a) After a real `startHocuspocus(port)` on a port from `tests/helpers/alloc-port.ts`, `(instance as any).server.webSocketServer.options.maxPayload === MAX_SYNC_PAYLOAD_BYTES`. **Discriminating:** the options are `listen`'s third positional argument, and a value in the wrong position or on the constructor config is silently ignored.
  - (b) A `ws` client sending one `MAX_SYNC_PAYLOAD_BYTES + 1` byte binary frame is closed with code **exactly 1009**. The client MUST send `origin: http://127.0.0.1:<port>` — `assertAllowedOrigin` (`provider.ts:75-79`) throws on a missing Origin from `onConnect`, and without the header the close code races Hocuspocus's Forbidden close. Never loosen to "the socket closed".
  - Teardown order (`startHocuspocus` writes a module singleton and exports no stop helper): `ws.terminate()` every client, then `await instance.destroy()`, then null the singleton. An unterminated ~66 MB socket keeps `destroy()` from settling and hangs the worker. `{ timeout: 60_000 }` on each frame test; note the transient ~130 MB allocation in the docblock.
- **`tests/server/server-security-invariants.test.ts` (extend).** Using the existing real-server `beforeEach`:
  - A >100 kB `application/json` body to `POST /mcp` returns 413, `content-type: application/json`, a body parsing to a JSON-RPC envelope with `error.code === -32600`, and raw text containing **none of** `node_modules`, `<html`, `PayloadTooLargeError`. Do not assert on `at ` — the static copy is the implementer's.
  - The same three negatives for a >100 kB body to `POST /api/channel-error` — the only path that crosses the LAN under a Cowork bind, and the spec that reddens if a later refactor scopes the handler to `/mcp`.
  - Positive control: a well-formed under-limit `POST /mcp` is not 413.
- **Mutation-test each fix** (revert the line, watch the named spec redden, restore from a file copy — never `git checkout`): the `sanitizeForLog` call at `:114`; the helper's `try`/`catch` (spec (e)); the `{ maxPayload: … }` argument (spec (a)); the `mcpApp.use(errorHandler)` registration (both 413 specs).

## Files touched

`src/server/mcp/channel-routes.ts`, `src/server/yjs/provider.ts`, `src/server/mcp/server.ts`; tests `tests/server/channel-error-log-sanitization.test.ts` (new), `tests/server/hocuspocus-max-payload.test.ts` (new), `tests/server/server-security-invariants.test.ts`. Everything else is read-only, including `docs/security.md`, `src/client/utils/diagnostics.ts`, `src/server/mcp/routes/license.ts`, and E2-upgrade's `api-routes.ts`, `src/client/hooks/*`, `src-tauri/src/lib.rs`.

## Done when

`npm run typecheck`, `npx vitest run tests/server/`, `npm run typecheck:tests` and `npx biome check .` are green; the four mutation tests each redden a named spec; the PR body carries item 3's measured before/after, item 2's `.docx` residual plus the per-frame-only bound, the `provider.ts` origin-log sites left with reason, item 7's reasoning verbatim, the two item-8 recommendations under `bryan`, and the `/api` blast-radius note for E2-upgrade; the `.docx` residual issue is filed (and checked against the open list for duplicates); #1822 carries a comment with item 7's outcome and the item-8 recommendations. **Cross-platform:** every change is platform-neutral Node/Express/ws, run locally on Windows only; CI's ubuntu `check` job is what executes the suite on Linux, and `rust-test`/`windows-acl-proof` are untouched by this diff. No E2E, no Rust, no skill bump, no `data-testid`.

## Not in scope

#1822 items 4, 5, 6 (K-sec-launcher). #1488 — accepted finding, see `K-sec-server-1488.md`; the code must not change. **#1981** (filed during planning, OPEN): the SDK sub-app's 100 kB parser shadows the 70 MB `largeBody`, capping every `/api` body at 100 kB — item 3 changes that bug's symptom, not its ceiling, and fixing the ceiling means moving a mount past a Host check. **Any edit to `docs/security.md`**, including its `:166` citation and its 70 MB clause. Measuring `.docx` extracted-text expansion. The `status: "inactive"` change and the `licenseInstalled` removal (Bryan's call). The connection-count ceiling (Bryan declined it). The `provider.ts` origin log sites.

## Review corrections (scope cut)

**Removed, not repaired**

1. **All `docs/security.md` edits** — the `:166` citation refresh, the JSON-413 clause, and the #1981 qualifier on the 70 MB clause. The issue asks for a 413 that does not leak the install path; rewriting the security register is a different artifact, and it is the register the four remaining findings fought over. With the file untouched, findings 2, 4 and 7 are moot: this PR no longer cites or edits the line whose next clause it disproved. #1981 records the disproof and is where it belongs.
2. **The `src/client/utils/diagnostics.ts` back-reference comment.** A drift guard against a second copy of a regex the issue never asked us to unify; it puts a client file in a server security PR for no behaviour.
3. **The `tests/server/hocuspocus-max-payload.test.ts` arithmetic assertion** (`MAX_SYNC_PAYLOAD_BYTES >= ceil(MAX_FILE_SIZE * 1.08) + 8 MiB`). Calibration pinning a constant against its own derivation. Removing it moots finding 8 entirely, and the derivation it encoded is the one findings 1 and 6 showed does not bound `.docx` — so pinning it would have frozen a wrong bound.
4. **The Yjs sizing table, the 1.08× / 1.00× / 299,712 B measurements and the `.docx` synthesis experiment.** Findings 1 and 6 offered measure-or-state; stating the residual is the smaller of the two and is what ships, with one filed issue so it is not an unfiled deferral.
5. **The `tests/server/license-status-route.test.ts` extension.** Item 8 ships no code; a new characterization spec for an unchanged branch is coverage work the issue did not ask for.

**Fixed directly**

- Finding 3 (item 3 is not loopback-only) — the reach is restated in Problem 3 with the mount-order evidence, and the `POST /api/channel-error` 413 spec is kept.
- Finding 5 (`sanitizeForLog` is not total) — the `try`/`catch` and spec (e) are kept, with the reason it cannot rely on item 3's handler.
- Finding 9 (clamp pinned on one field of one arm) — test (c) now covers `error`, `message`, `toolName` and `requestId` with the `not.toContain(…repeat(300))` form, and the arithmetically-impossible total-length bound is gone rather than recomputed.
