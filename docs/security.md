# Security

Tandem is designed local-first. The server binds to `127.0.0.1` by default, document content stays on disk, and there are no Tandem-operated servers in the picture.

## Network posture

- **Default bind:** `127.0.0.1`. The MCP HTTP endpoint and Hocuspocus WebSocket only accept connections from the local machine.
- **LAN exposure (opt-in):** set `TANDEM_BIND_HOST=0.0.0.0` (or a specific interface) to expose Tandem on a LAN. Non-loopback requests require a Bearer token by default; Tandem auto-generates one on first run and stores it at `{APP_DATA_DIR}/auth-token` with mode `0o600`.
- **Loopback detection is fail-closed.** Authentication middleware uses `req.socket.remoteAddress` exclusively — never the `Host` header — so DNS rebinding attacks cannot trick the server into treating a remote request as loopback. IPv6 variants (`::1`, `::ffff:127.0.0.1`) are normalized to `127.0.0.1`.
- **Insecure LAN opt-in:** `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` lets the server bind to a non-loopback host when no auth token has been provisioned yet. Without it, that startup is refused outright (`bind-check.ts`). The name overstates what it does: it does **not** switch authentication off. `authMiddleware` (`createAuthMiddleware`, `src/server/auth/middleware.ts:156`; mounted at `src/server/mcp/server.ts:595-596`) never reads the flag — it still requires a valid Bearer token from every non-loopback caller, and a token is always minted. Since #1293 the flag relaxes **no guard at all** — it changes exactly one thing, whether the bind is permitted without a provisioned token. (It previously relaxed `assertLoopbackForMutation`, in the inverted direction described below.) Intended for trusted-network development; never set it on a public network.

See [configuration.md](configuration.md#environment-variables) for the full environment-variable reference (ports, bind host, auth token, app-data paths).

## CORS allowlist

The server accepts cross-origin requests from three origins only (`isLocalhostOrigin`, `src/server/mcp/api-routes.ts:112-121`):

- `http(s)://127.0.0.1` with any port
- `http(s)://tauri.localhost` — the Tauri WebView's origin on Windows and macOS
- `tauri://localhost` — the Linux Tauri WebView's custom scheme, matched as an exact string rather than a `tauri://*` wildcard, since it cannot be forged by remote content

Bare `http://localhost` was narrowed out in PR #637 because it bypassed DNS-rebinding hardening.

**Absence of the header is the denial — never `null` (#1291).** `Access-Control-Allow-Origin` is emitted *only* for an allowlisted origin. Writing `null` reads like a refusal and is the opposite of one: `null` is the origin serialization the Fetch spec assigns to *opaque* contexts, so a sandboxed, `data:` or `srcdoc` iframe on any public page sends `Origin: null`, the browser's CORS check matches it, and the response body becomes cross-origin readable. Absence has no matching semantics at all, so it denies every origin including opaque ones. `Vary: Origin` is set unconditionally, including on denied responses, because the response genuinely varies by origin and `/api` carries no `Cache-Control`.

This reaches further than the JSON routes: the SSE handlers call `res.writeHead(200, {...})`, which Node *merges* with headers already set rather than replacing them, so `/api/events` inherits the same protection. If either stream is ever rewritten to a replacing header write, that coverage disappears silently.

**The WebSocket does not use the same allowlist.** Hocuspocus origin validation (`assertAllowedOrigin`, `src/server/yjs/provider.ts:81-104`) and the MCP server's `allowedHosts` (`src/server/mcp/server.ts:493-501`) are separate lists that permit overlapping but different sets — `allowedHosts` additionally accepts the bare hostname `localhost` and `[::1]`. Treat them as three surfaces to audit, not one.

## Auth tokens

- **Generation:** 32 random bytes, base64url-encoded.
- **Storage:** `{APP_DATA_DIR}/auth-token`, mode `0o600`, written atomically (temp file + rename).
- **Comparison:** both sides SHA-256-hashed, then compared with `crypto.timingSafeEqual` to prevent length-oracle attacks.
- **Brute-force limit:** non-loopback callers are rate-limited per source address — five failed attempts in ten minutes returns `429` and stops further token comparison (`src/server/auth/middleware.ts`). Loopback callers never reach it; they bypass auth entirely.
- **Rotation:** `tandem rotate-token` generates a new token, posts it to `/api/rotate-token`, and updates MCP client configs. The old token remains valid for a 60-second grace window so connected clients can pick up the new value without a disconnect.

## What actually guards a mutating route

*Most* mutating `/api` routes call `assertOriginAllowlisted` and then `assertLoopbackForMutation` —
but not all of them do, and the exceptions are enumerated below. Read the pair honestly, because
the names promise more than they deliver (#1293):

- `assertOriginAllowlisted` reads the `Origin` header, which a non-browser client can forge
  freely. It stops a *browser* on a page you visited; it stops nothing else.
- `assertLoopbackForMutation` rejects **every** non-loopback peer, in every configuration (#1293).
  Until then it rejected only when `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` — the stricter posture
  applied only in the *more permissive* configuration, so it was a no-op in every shipped build,
  and the genuinely exposed configuration was the token-authenticated LAN bind that
  `bind-check.ts` permits whenever a token exists.

  It governs the routes that **call** it, and **six** mutating routes registered in
  `src/server/mcp/api-routes.ts` call neither gate: `open` and `upload` — which take a
  caller-supplied filesystem path, the higher-blast-radius subset #1320 was filed over —
  plus `close`, `annotation-reply`, `remove-annotation` and `rotate-token`.
  (`scratchpad` was the tenth of the original ten until #1318 gated it.)

  It was nine until `save`, `convert` and `apply-changes` were gated to close a
  simple-request CSRF: a `text/plain` POST is a SIMPLE request, so no preflight fires and
  the origin allowlist never gets a say; a browser on the user's machine is loopback, so
  `enforceLoopbackMutation` passes and `authMiddleware` skips the token check entirely; and
  `express.json` (no `type` option) leaves `req.body` undefined, which those three handlers
  tolerated and then defaulted every field from. **`/api/save` needed only the steady
  state** — any page the user visited could overwrite their open document on disk, with no
  user interaction, no guessed filename and no attacker-controlled field. Not
  *unconditional*: `saveDocumentToDisk` has ten skip returns (open, on disk rather than
  `upload://`, not read-only, saveable format with an available adapter, no save in
  progress, no unresolved external conflict, no external modification since the last save),
  but there is no dirty check, so the ordinary case writes.

  For an open `.docx` the write re-exports through mammoth over the original and loses what
  the converter cannot represent. The binary carve-out at `document-service.ts:307` does not
  stop it — and was never meant to: it is scoped to `source === "auto-save"`, while
  `routes/save.ts:127` passes `"manual"`, the same value the user's own Ctrl+S carries. So
  the attack does what a legitimate explicit save does rather than slipping past a guard
  aimed at it, and the `.docx` branch's post-write `SaveVerificationError` narrows it
  further. `/api/convert` and `/api/apply-changes` are the same shape but conditional on the
  active document being an on-disk `.docx`.
  Measured, not inferred (express 5.2.1): `text/plain`, `application/x-www-form-urlencoded`,
  `multipart/form-data` and a missing Content-Type all leave `req.body` undefined, so an
  attacker reaches the handler but cannot inject a single field.

  **Two of the six must never be given the origin gate**, and this is the trap in the
  obvious fix: the Tauri sidecar POSTs `open` via reqwest and the CLI POSTs `rotate-token`
  via Node `fetch`, neither sending an `Origin` header, and `assertOriginAllowlisted` fails
  closed on a missing one. For `rotate-token` the CLI reads the resulting non-2xx as
  `serverRejected` and **rolls the new token back off disk**, so the gate would break
  rotation outright. `rotate-token` instead requires a parsed JSON body — a positive proof
  that a preflight was passed rather than a header check. That route's exposure was
  hardening rather than a hole: in the steady state the disk token already equals the
  in-memory one, so the swap is a no-op, and the route 409s before any state touch whenever
  `TANDEM_AUTH_TOKEN` is set, which is the whole Tauri desktop build.
  Since #1320 a LAN peer can no longer reach any of them, but they hold **one** layer rather
  than two, which is why the enumeration survives as the review inventory. It is pinned
  against source by `tests/docs/loopback-gate-claims.test.ts`, so a newly-added ungated
  route fails CI rather than quietly joining a list nobody re-derives — but only at
  **module** granularity. The test resolves per route module, not per handler, so a module
  that exports one gated and one ungated mutating handler reads as gated and the new
  handler never fails CI (the test says so itself at `loopback-gate-claims.test.ts:48-53`).
  Every multi-handler module gates all of its mutating handlers today; split such a module
  rather than trusting the pin to notice.

### The `/api` invariant (#1320)

Since #1320 the default is structural rather than per-handler. `enforceLoopbackMutation`
(`src/server/mcp/api-routes.ts`) is mounted `app.use("/api", …)` in `server.ts`, after
`authMiddleware` and before every registrar, and rejects any non-loopback peer using a
method other than GET/HEAD/OPTIONS. A route added later inherits it without its author
knowing the rule exists — which is the point, because every prior gate on this surface was
a call inside a handler body, invisible at the registration site, and that is how nine
routes ended up ungated by omission and how the contested count went 4 → 11 → 9 → 10 across
three review passes.

The rule is phrased over **method, not mutation**, deliberately: `GET /api/channel-permission`
evicts TTL-expired entries, so it mutates, and a mutation-shaped rule would require exactly
the per-route inventory this replaces. Reads keep their existing per-route posture —
`document/raw` and `diagnostics` refuse a non-loopback caller by hand, while `info`,
`sessions`, `backups`, `launcher/status`, `models` and `integrations` scrub their payload
instead. That scrubbing is what the LAN Host accommodation (`createApiMiddleware`'s
`extraHosts`, wired from `resolvedLanIP`) exists for, and it is now exactly scoped: LAN
hosts may **read** `/api`; their writes are refused.

The exemptions are keyed by **method and path together**, not path alone: the set holds
`DELETE /api/chat`, so a future `POST /api/chat` would be gated like anything else. A
path-only set would have silently handed LAN-write access to the next route added on one of
those six paths — the same fail-open shape this invariant replaced.

Two things sit outside it, for two different reasons:

- **The `/api/channel-*` family and `DELETE /api/chat`** are carved out by name in
  `NON_LOOPBACK_ALLOWED`, because the channel shim (`src/channel/`) and the plugin
  monitor (`src/monitor/`) are documented to run against a non-loopback `TANDEM_URL` — that
  is how Cowork reaches a Tandem running elsewhere. This is the one hand-maintained list
  left in the design; adding to it is a security change. Nothing in CI exercises the shim
  against a non-loopback host and `channel/run.ts` logs a 403 to stderr and continues, so
  the positive-control cases in `tests/server/api-loopback-invariant.test.ts` are the only
  detector a broken carve-out has.
- **`/api/wake`** is a WebSocket upgrade registered on the `http.Server` upgrade event
  (`events/wake-socket.ts`), so `app.use("/api", …)` structurally never sees it. It carries
  its own Origin guard. This is an exception to the middleware's *reach*, not to the policy.

`/api/shutdown` is **not** one of them — it is covered by the invariant like every other
mutator, and *additionally* gates itself, more strictly: its Origin half must permit an
*absent* Origin (the Tauri shell's reqwest client sends none), which
`assertOriginAllowlisted` rejects. Do not read its hand-rolled gate as redundant.

One consequence worth stating because it is documented usage: `tandem rotate-token` against
a remote `TANDEM_URL` now gets a 403. Rotation must run on the host. The CLI rolls the token
file back on a refusal rather than leaving the client on a credential the server will never
accept — see `src/cli/rotate-token.ts`.

**The primary protection is the loopback bind plus Bearer auth for every non-loopback caller** —
the two controls described above, which hold regardless of either assertion. `assertOriginAllowlisted`
is defence in depth on top of that; `assertLoopbackForMutation` now covers the one case neither
control does — a caller who holds a valid token but is not on this machine. A route that
has them is not thereby safe to expose. `docs/decisions.md` ADR-046 states the same posture.

## Privacy

- **Notes are user-private (ADR-027).** Annotations with `type: "note"` are stripped from every MCP tool response and never appear in channel events. The AI cannot read them.
- **What the AI sees:** the document content you open, selections you hold (subject to dwell-time gating), annotations you create or that the AI itself creates, and chat messages sent through the Tandem sidebar.
- **What the AI doesn't see:** files you haven't opened, notes (per above), the auth token, and any environment variables that aren't surfaced through MCP tools.
- **Read routes scrub absolute paths for non-loopback callers.** `GET /api/sessions` and `GET /api/backups` strip paths to their basename, so a LAN caller holding a token learns filenames but not the directory layout of the machine (#1121). `GET /api/document/raw` is loopback-only outright. All path-taking routes reject UNC, enforce an extension allowlist and a 50 MB limit, and write atomically.

## Telemetry: none by default, crash reporting strictly opt-in

Tandem ships with **no usage analytics and no telemetry beacons**, and **crash reporting is off by default**. The only outbound traffic Tandem initiates out of the box is to your configured AI client over loopback (or LAN, if you opted in) and — for the desktop app — periodic update checks against the public release host. Update checks carry no analytics.

Crash reporting is available but **strictly opt-in**: it activates only when you set the `TANDEM_SENTRY_DSN` environment variable to a [Sentry](https://sentry.io) or self-hosted [GlitchTip](https://glitchtip.com) DSN that you control. With the variable unset (the default), no Sentry client is initialized in the desktop shell, the Tauri Sentry plugin is never registered, the WebView is never instrumented, and `@sentry/node` is never even loaded in the sidecar — there is no crash-reporting code path on the wire. When you do opt in, Tandem reports Rust panics + native minidumps (shell), JavaScript errors / unhandled rejections (WebView, bridged over Tauri IPC), and Node uncaught exceptions (sidecar) to *your* endpoint, scrubbing home-directory paths to `~`/`[user]`, redacting Anthropic/bearer-style secrets, and dropping request/document payloads and content breadcrumbs before egress. Document content and annotation bodies are never attached to events. Self-hosting GlitchTip keeps all crash data under your control. Settings → About shows the current on/off status. Implemented in `src-tauri/src/sentry_reporting.rs`, `src/client/sentry.ts`, and `src/server/sentry.ts` (#921).

## Licensing activation (v1.0)

This describes the paid model arriving at v1.0; during the public beta Tandem is free and unlicensed. The system is implemented but **ships dark behind a build flag** (`LICENSE_GATE_ENABLED`, off until v1.0), so beta builds enforce nothing. See [ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license) and `docs/licensing-operations.md`.

- **Running the app validates a license offline.** The app verifies an Ed25519-signed license file locally against a public key embedded in the build. *Running needs no network call* — activation works air-gapped, and the signature is checked on your own machine. This is a separate key from the Ed25519/minisign key used to sign release artifacts. A valid license runs the current version **forever**; the signature alone gates running, while `expiresAt` governs only the update window.
- **The license file binds a copy to its buyer.** It carries the buyer's name and email, an opaque license id, a type (`personal`/`commercial`/`grandfathered`), a creation date, and an update-window expiry, all covered by the signature. It does **not** carry an order ID — the order number lives only in the seller-side issuance ledger, and is the identifier support will ask you for.
- **Enforcement is server-side, not client-trust.** When the gate is active and a trial has expired with no license, the local server marks Hocuspocus document-room connections read-only AND gates Claude's mutation tools / mutating `/api` routes — both re-checked per request. The escape hatch is preserved: you can always open, read, and **export** your local files (and chat keeps working). The trial clock is deliberately **soft** (a local timestamp, no anti-rollback); the signed license is the only hard gate.
- **Updates authenticate entitlement without telemetry.** The licensed updater sends an opaque license id (a UUID, not the buyer's key or email) to a small license-checked endpoint that serves new builds only while the update window is current. Unknown ids and expired windows get a **byte-identical no-update** response (no existence oracle). The endpoint logs `{ result, reason, timestamp }` — a coarse enum describing *the service's* state (`unknown-id`, `expired`, `upstream`, …), **never the license id**, so no per-customer update history exists. That reason field is the only way the operator can tell a broken issuance pipeline from a healthy one, because a license with no entitlement is served the same no-update response as having nothing to install — and the app reports it to you as "You're up to date". Note that the endpoint runs on Cloudflare, whose platform-level request logging is outside Tandem's control; "no telemetry" is a statement about what Tandem records, not about what a CDN sees. An expired-window license still *runs* offline; it simply stops receiving new builds.

## Open findings

**This section is the tracked home for open security findings (#1308).** A new one belongs here as well as in the tracker — the issue label is not a complete index, and neither is [#1199](https://github.com/bloknayrb/tandem/issues/1199), which is a fresh re-audit at the RC tag and does not enumerate open findings.

It lives here rather than in `CLAUDE.md` deliberately. `CLAUDE.md` is auto-loaded into every session, including sessions that read messages from people outside the project; a working exploit brief should not be ambient context in those. Anyone who needs the detail is one link away, and the issues themselves are public.

Open as of v0.24.1 — reconciled against the tracker 2026-08-28, which is what demoted #1420 below from open to fixed-but-unverified:

- **Symlink-following in the `.docx` backup and restore pair — FIXED, recorded here because the class is what matters.** `tandem_applyChanges` probed its backup destination with `fs.access`, which follows symlinks, so a **dangling** link there reported ENOENT, took the "no existing backup" branch, and `fs.copyFile` — `O_WRONLY|O_CREAT|O_TRUNC` — created the link's target and filled it with the user's document. `tandem_restoreBackup`'s `.docx` fallback had the worse half: the same `fs.access` at the sidecar path succeeded through a planted link, `fs.copyFile` read **through** it and overwrote the user's document with an attacker-chosen file, and the size verification compared the link's target against the file it had just written from that same target — identical by construction, so it verified and returned `Restored <name> from backup.` A silent whole-document replacement reported as a success. **Preconditions, which is the honest bound:** a local process already able to write next to the user's document, and for the restore half, an empty doc-backups store for that file (a freshly started server). **Fixed** by `lstat`-and-refuse on both sides, with the `catch` narrowed to ENOENT so an EACCES on the parent is no longer read as "nothing there", and `COPYFILE_EXCL` on the write to close the check-then-act. **No CodeQL alert points at either site** — the restore half was found by an adversarial review of the fix for the write half, which is the reason it is written down here rather than left in a PR body. The general lesson for this codebase: `fs.access` as an existence probe is a symlink-follow wherever the answer decides what gets written.

- **The post-`realpath` prefix re-check in the two export paths never ran on create-new — NARROWED, not closed.** `convert.ts` and `annotations.ts` canonicalize a caller-supplied `outputPath` and then re-screen it for UNC and `\\?\` prefixes, so a legitimately symlinked export directory resolves through while a symlink swap into a network location does not. Both swallowed the `ENOENT` that `realpath` throws when the **leaf** does not exist yet — which is the normal case for an export — so the re-check ran on overwrite and never on the create-new path it exists to guard. CodeQL alert 94 is the `fs.realpath(resolvedOutput)` READ (it was cited here as `convert.ts:119`, which was already the wrong line; it sat at `:127` before #1654 narrowed `outputPath` to a directory and at `:145` after). **It is OPEN, deliberately, and it relocates.** #1654 re-raised it as alert 189 purely because the line moved — same sink, same expression, column-matched — so a PR touching this block gets a red CodeQL for a pre-existing open alert rather than a new one. Do not dismiss the re-raise: 94 is open, so its relocations stay open too, and CodeQL is not a required check. `annotations.ts` carries the same defect with no alert, because `tandem_exportAnnotations` has no `/api` route and CodeQL modelled only the `/api` sources. **Fixed** by canonicalizing `path.dirname` and screening that, in both files. **Residual, and it is smaller than the first version of this entry said.** That version was corrected 2026-08-28 after review; it is worth recording what it got wrong, because each error made the remainder read as larger than it is. It described the junction-to-UNC shape in the present tense, as what still gets through — but that was the **pre-fix** bound. `fs.realpath` resolves reparse points on win32, so a junction targeting a UNC share now comes back as `\\server\share\…` and is refused by `rejectUnsafeWindowsPrefix` (`windows-path-safety.ts:81-83`). It also said the window lets "the junction" be repointed, which is a no-op post-fix: `convert.ts:162` and `annotations.ts:886` rejoin onto `realParent` and **discard the caller's spelling entirely**, so every later operation — `findAvailablePath`, `snapshotBeforeFirstWrite`, `atomicWrite`'s temp sibling — runs against the canonical path. What remains is a race on a component of the *resolved* path (rename the real directory aside, recreate it as a link), which needs a rename-plus-create rather than a reparse-point rewrite.

  **Preconditions, which is the honest bound and which the first version omitted:** local write in the export directory's ancestry **plus** `SeCreateSymbolicLinkPrivilege` (admin or Developer Mode) on Windows, and for the race, also winning a millisecond window and knowing when an export fires. An attacker holding that already has cheaper NTLM-leak primitives that need no export at all — a `.url` file, a shortcut, a `.md` with a `\\host\share` image reference. **That is why this is not counted among the open findings above**: the capability it requires is strictly greater than the capability needed to bypass it by other means, which is the property the counted findings do not have.

  **What the entry understated, and this part is new:** the `realpath` call *is itself* the network touch. Resolving a junction to `\\evil\share` opens a handle through the SMB redirector, so the NTLM authentication attempt happens **inside the check that exists to prevent it**. The screen can stop the write; it cannot stop the handshake. That is the ordering class `windows-path-safety.ts:43-44` names for #1417 — a filesystem call running *before* the check, which a string test cannot detect — and it is pre-existing rather than introduced here, since the overwrite branch has always done it (`convert.ts:127`).

  **This residual is now bounded by #1654's resolution** (see Accepted below), which chose narrowing over containment. It survives as accepted, with one half of it retired by construction: `convert`'s `outputPath` is directory-only, so the caller-named-leaf spelling that reached the ENOENT branch no longer exists there. A symlinked output *directory* is still resolved and re-screened, which is the half worth keeping.

- **[#1420](https://github.com/bloknayrb/tandem/issues/1420) — link-handling escapes: FIXED BUT UNVERIFIED, not open. Browser build closed, Windows SMOKED, macOS/Linux UNVERIFIED.** The tracker issue is CLOSED and the code landed on all three targets, so this is **not counted among the open findings above** — but a closed issue is not evidence that macOS and Linux were checked, and nobody has run them. It stays in this register for exactly that gap. The finding had three parts. **Image sources closed by #1497:** paste and file-open (`.md` via `mdast-ydoc.ts`, `.docx` via `docx-html.ts`) share one allowlist (`src/shared/image-src-safety.ts`), and an `img-src 'self' data: blob:` CSP (`index.html`, matching the pre-existing Tauri CSP) blocks any surviving cross-host image fetch across all three build targets. **Click-navigation closed by #1417:** the mixed-separator normalisation in `rejectUnsafeWindowsPrefix` makes `resolveRelativeLink` refuse `/\evil.com/x.md` and `\/evil.com/x.md`. **The render and middle-click halves closed by the #1420 fix**, with the qualification below:

  - **Render.** The `isAllowedUri` union gained its first NARROWING term, `isRenderableLinkHref` (`src/client/editor/utils/url-safety.ts`). `defaultValidate(url) || isSchemelessPathHref(url)` could only ever widen — `defaultValidate` accepts a leading `/` via its `[^a-z]` alternative without looking at what follows — so every backslash-authority spelling rendered as a live link. The veto refuses leading whitespace, C0 controls anywhere, `/\…` / `\/…` / `\\…` / `\\?\…`, and — because a scheme moves the authority past index 0, where `rejectUnsafeWindowsPrefix` is anchored — any `http:`/`https:`/`ftp:` href in a spelling `isSafeExternalHref` does not recognise (`http:/\evil.com/x`, `https:/evil.com/x`). **The leading-whitespace clause is the load-bearing one and was nearly missed:** `rejectUnsafeWindowsPrefix` is anchored at index 0, so a single leading space walks past it while the browser's URL parser strips it and resolves cross-host — and remark preserves that space inside a pointy-bracket destination (`[x](< /\evil.com/x.md>)`) while `mdast-ydoc.ts` writes `href: node.url` verbatim, so **file open**, not paste, is the delivery path. The render corpus in `tests/client/link-target-internal.test.ts` is therefore generated as prefix × authority and filtered by `new URL().origin`, not hand-listed; a hand-list of the reported spellings went green with the space bypass wide open.
  - **Middle-click.** `Editor.svelte` now registers `onauxclick` alongside `onclick`, both routed through one `interceptAnchorGesture`. Middle button only (2/3/4 are the context menu and cancelable history navigations); no modifier filtering.
  - **Windows SMOKED (2026-08-20). macOS and Linux still UNVERIFIED, which is why this entry does not read "closed" unqualified.** The smoke was run for #1545 and is summarised here rather than left in that PR's body, because a criterion whose evidence lives outside tracked files fails silently (#1308). Rig: Windows 11, `cargo tauri dev`, a **read-only** document — the surface where Chromium raises the default action — with middle clicks synthesised via `mouse_event(MOUSEEVENTF_MIDDLEDOWN|MIDDLEUP)` at DPI-corrected screen coordinates and the handler temporarily instrumented to log `e.type`/`e.button`/`href`. **Result 1: the intercept IS reached** — `auxclick` (button 1) → `interceptAnchorGesture` → `openHref`, confirmed by the app's own "File not found" notification for a relative href. **Result 2: `preventDefault()` suppresses nothing on that engine** — with the `auxclick` arm replaced by a pure pass-through (master's behaviour, event still observable), neither a relative nor an `https://` anchor opened anything, and top-level window and `msedgewebview2` process counts were unchanged across every click. WebView2 raises no observable new-window or navigation default action for a middle click on an in-document anchor — it has no tab UI for "open in new tab" to target, and the `about:blank` popup the Chromium E2E captures does not reproduce. **So the desktop half of the middle-click vector was never reachable on WebView2 to begin with**, and the fix's value there is that the gesture now routes through `openHref`, the single trust gate — not that it cancels a live exposure. Do not read this PR as having closed a Windows hole via this path; there was not one. **Two things the smoke did NOT cover, both flagged as must-carry in #1545 and neither implied by Result 2.** (i) **`target="_blank"` anchors were not smoked** — the runs used a relative href and a bare `https://` anchor in a document, so the #1343 mechanism below (WebView2 treating `_blank` as a new-window request in its own right) is untouched by this result and must not be described as covered by it. (ii) **The render-time veto was not exercised** — the run covers the gesture path only, so nothing here is evidence about `isRenderableLinkHref`. The adjacent #1343 finding is why this was worth measuring rather than assuming: the comment in `editor-extensions.ts` records that WebView2 treats a `_blank` anchor as a new-window request *in its own right*, that no `on_new_window` handler is registered, and that it reaches the OS regardless of `preventDefault` — #1343 was fixed by removing the *attribute*, not by making `preventDefault` work. **WKWebView** (macOS) and **WebKitGTK** (Linux, where middle-click in a contenteditable is claimed by primary-selection paste) remain untested; an engine that fires no `auxclick` at all never runs the interceptor. E2E is chromium-only, so nothing in the suite will ever contradict this. **What holds on every engine regardless** is the render veto: no href that resolves off-origin reaches the DOM as a live link, except spellings `isSafeExternalHref` itself sanctions. That bound is what the earlier wording got wrong — it said such an engine "leaks only a double-open", which is true only for hrefs that keep `target="_blank"`. `LinkWithHoverTitle` strips `_blank` from anything `isSafeExternalHref` refuses, and a live anchor without `_blank` does not open a second tab: it **navigates the editor frame**, taking the session with it — the #1343 shape this codebase already treats as real. So the honest statement of what an engine with a failing `preventDefault` still leaks is: (i) a second tab for `//example.com/x`, `https://…` and the other `_blank`-bearing external hrefs — a genuine annoyance only; and (ii) a frame navigation for any live anchor lacking `_blank`, which after this fix means same-origin relative paths **and, until #1537 landed, the un-subtracted scheme class**, not the reported cross-host class. The `http:/\evil.com/x` family that would otherwise have sat in (ii) is now blanked at render (clause 3 of the veto). Closing the two remaining engines needs the same smoke on macOS and Linux hardware, or `on_new_window` (deliberately out of scope here: the window is declared in `tauri.conf.json`, not a Rust `WebviewWindowBuilder`, so it needs three platform-specific `with_webview` implementations, and `openHref` depends on `window.open` reaching the system browser).
  - **What Chromium actually does, measured, because the obvious claim is wrong.** Middle-click navigation is *already* suppressed inside a `contenteditable`, so the bypass does **not** reproduce in a normally-editable document in the browser build. It reproduces in the **read-only** editor — View Changelog, upgrade-opens-`CHANGELOG.md`, `upload://` files, any `POST /api/open {readOnly:true}` — which is also the surface most likely to hold externally-authored content. The `auxclick` EVENT fires in both cases; only the default action differs. `tests/e2e/relative-links.spec.ts` covers the read-only case specifically, and it is the only row that proves `preventDefault()` suppresses anything.

  **Residue, all deliberate and none of it reaching a destination the click gate refuses:**

  - The veto is a **prefix-class** veto, not a render/click unification — impossible here, since `resolveRelativeLink` needs `currentFilePath`, which the mark renderer does not have. `../../../../..///evil.com/share/x.md` still renders live and is still refused on click.
  - **`//` is a fourth cross-host spelling that the veto deliberately ACCEPTS** (including interior-backslash spellings like `//evil.com\share`, which take the same early return before `rejectUnsafeWindowsPrefix` is consulted)**.** The sentence "it blanks exactly the prefixes `resolveRelativeLink` refuses" is true only because of that carve-out. It stays live because it is in `SAFE_EXTERNAL_PREFIXES` and `openHref` hands it to `window.open` like any `https://` URL — a declared external link, not a relative-looking disguise. Its whitespace-prefixed variants are *not* carved out: `isSafeExternalHref` does not trim, so those are disguises and are blanked.
  - **Surfaces with no `MouseEvent` to intercept.** For the class this finding reported they now reach only same-origin or allowlisted-external hrefs — these surfaces are how #1537's scheme class was reachable before it was closed, so keep them in mind for any future scheme-shaped finding: the **native browser context menu**'s "Open link in new tab" (never present in Tauri, where `detect.ts` claims every link and `install.ts` preventDefaults; always present in the browser build, where `install.ts` returns before attaching — note a blanked `href=""` anchor still matches `a[href]`, so Tauri still claims it), the **keyboard context-menu key / Shift+F10** reaching that same menu, and **dragging a live anchor out of the editor**, whose drag payload is the *resolved absolute* URL.
  - **[#1537](https://github.com/bloknayrb/tandem/issues/1537) — hyphenated schemes bypassed Tiptap's allowlist entirely, and THIS veto does not subtract them; a second ANDed term does. CLOSED — see the #1537 entry under "Closed since v0.22.1".** DOMPurify's `IS_ALLOWED_URI` fallback alternative matches the hyphen, so `defaultValidate("ms-msdt:/id")` returns a match, the `||` short-circuits, and the anchor renders live with the href **verbatim**. Was live until #1537: `ms-msdt:/id` (Follina, CVE-2022-30190), `ms-appinstaller:?source=…` (CVE-2021-43890), `search-ms:crumb=location:\\evil.com\share`, `ms-officecmd:x`, `view-source:http://evil`, `itms-services://?url=http://evil`, plus Tiptap-allowlisted-but-not-Tandem-allowlisted `tel:`/`sms:`/`callto:`/`cid:`/`xmpp:`/`ftps:`. The `search-ms:` spelling is an NTLM/WebDAV-share vector reaching the OS from a right-click "Open link in new tab" — the same class `rejectUnsafeWindowsPrefix` exists to prevent. Delivery is a crafted `.md`/`.docx`; `mdast-ydoc.ts` writes `href: node.url` verbatim. **Deliberately not closed in the #1420 fix** — closing it meant moving to an allowlist posture, which also stops rendering `tel:`/`sms:`/`xmpp:`/`ftps:`, a behaviour change deserving its own review rather than being bundled into a middle-click fix. **It is now CLOSED by #1537’s own fix**, which ANDs a second narrowing term (`isRenderableLinkScheme`) alongside this veto — see the #1537 entry under "Closed since v0.22.1" for what that does and does not cover.
  - **Userinfo-vs-host confusion is not covered either, and was not previously recorded here.** `https://good.com@evil.com/` is a sanctioned `https://` prefix, so `isSafeExternalHref` accepts it, it renders live and `openHref` hands it to `window.open` — which navigates to **evil.com**, while `LinkWithHoverTitle` mirrors the raw string into `title` so the tooltip leads with `good.com`. Same class as the bidi bullet: hover-text spoofing of a genuinely external link, not a bypass of any gate. Pre-existing and unchanged by #1420 or #1537 — recorded here because it was found while reviewing those and was documented nowhere. (Note the harmless mirror image: `https://evil.com@good.com/` resolves to `good.com`; the deceptive spelling is the one with the trusted name in the USERINFO.)
  - **Bidi overrides (U+202A–U+202E) are not covered by either character set.** `LinkWithHoverTitle` mirrors the raw href into `title`, so a tooltip can read as a different host than the anchor resolves to. Navigation is unaffected — those resolve same-origin, percent-encoded — so this is **tooltip spoofing only**, and widening the character set was deliberately left out of the #1420 fix.
  - **A behaviour delta, not a security one:** a Word hyperlink to `\\fileserver\docs\spec.docx` used to render live and produce an explicit "Blocked a link pointing outside this document's folder" notification on click. It now renders with a blanked href — still an `<a>` in the DOM, but struck through, muted and non-interactive — so the refusal is **silent** — the same silent-no-op shape the click-path design deliberately avoids. Outcome is better; the explanation is what is lost.
  - **Unchanged by design (image half):** the content allowlist still treats a general `https://` image URL as safe — a deferred product decision, not a gap, since stripping them would break every document with a hosted badge. The `img-src` CSP is the only control blocking the fetch today, so loosening it re-exposes this, and `'self'` still permits a document to GET the app's own loopback origin (reads are scrubbed and non-GET is refused by `enforceLoopbackMutation`, so this buys nothing today; it is the residue to look at first if that changes).


Closed since v0.22.1 — kept here because the mechanism is load-bearing for the bullets above, and because a reader scanning this section for what is still open must not have to parse a "CLOSED" prefix inside an "Open as of" list:

- **[#1537](https://github.com/bloknayrb/tandem/issues/1537) — hyphenated-scheme render bypass: CLOSED, and what that does and does not cover.** Tiptap's `defaultValidate` accepts any scheme whose body contains a character outside `[a-z+./0-9:]` — its regex is assembled in a template literal where `\-` collapses to a bare `-`, so `[^a-z+.-:]` parses `.-:` as the range U+002E–U+003A and the hyphen falls out of the negated set. It is therefore **not** "hyphenated schemes": `ms_msdt:x` and `user@host:x` are accepted too, while `coap+tcp:x`, `a.b:c`, `x+y:z` and `ms2:x` are not. With both operands of `isAllowedUri` widening, `ms-msdt:/id` (Follina, CVE-2022-30190), `ms-appinstaller:` (CVE-2021-43890), `search-ms:crumb=location:\\evil.com\share`, `ms-officecmd:`, `view-source:` and `itms-services:` all rendered as live anchors with the href verbatim. **Closed by ANDing a scheme allowlist term (`isRenderableLinkScheme`, `src/client/editor/utils/url-safety.ts`) into the union**: a scheme-bearing href must match `SAFE_EXTERNAL_PREFIXES`, and schemeless hrefs are untouched. "Scheme-bearing" means the WHATWG scheme grammar (`/^[a-z][a-z0-9+.-]*:/i`), not "has a colon" — a looser test blanks `2024:plan.md`, `.hidden:note.md` and 397 other measured relative-path spellings that a URL parser resolves relative and that Tandem opened, which breaks the same rule from the other side. **File-import delivery was `.md` only** — `mdast-ydoc.ts` writes `href: node.url` verbatim; `.docx` was already restricted to `^https?://`/`mailto:` at `docx-html.ts:26-28`, and `.txt`/`.html` go through the plaintext adapter, which builds no link marks at all. **File import was not the only live route, and this bullet used to imply it was: the other one is a clipboard carrying `text/html`, parsed through the schema's `parseHTML` `getAttrs` — also closed by this change.** `editor-extensions.ts` states that any clipboard carrying `text/html` bypasses `clipboardTextParser`, and `editor-props.ts`'s `transformPastedHTML` parses the HTML flavour through the schema, so copying an `ms-msdt:` anchor out of a web page, Word or a chat client produced a live one; reverting the ANDed term reddens `ms-msdt:/id`, `search-ms:crumb=location:\\evil.com\share`, `view-source:http://evil` and `tel:+15551234` on the `parseHTML` path alone. Markdown PASTE was already closed by `sanitizeHrefForPaste`. Scope any regression test to both routes. The same change also dropped `tel:`/`sms:`/`callto:`/`cid:`/`xmpp:`/`ftps:` from the render set: those are a **product** decision ("only render as a link if it works as a link"), not a security fix — each already failed visibly on click at `resolveRelativeLink`'s `unsupported-ext`. `mailto:` was traced and **kept**: it is in `SAFE_EXTERNAL_PREFIXES`, so `openHref` hands it to `window.open` rather than to the relative-link walk. **The schemeless backslash-authority spellings** (`/\evil.com/x.md`, `\/evil.com/x.md`, `\\evil.com\share\x.md`, and the leading-space variant) carry no scheme and fall through this term untouched — they are #1420’s half, closed separately by `isRenderableLinkHref`. **Both terms are ANDed at the `isAllowedUri` site and neither covers the other:** the WHATWG scheme test is anchored, so `" ms-msdt:/id"` reads as schemeless here and is refused only by #1420’s leading-whitespace clause, while bare `ms-msdt:/id` carries no special scheme and no Windows prefix and is refused only here.

Still open from the v0.21.0 security gate, whose RC re-run failed on 2026-08-05 with two HIGH:

- **[#1609](https://github.com/bloknayrb/tandem/issues/1609) -- three unscreened path reads reached by `runDoctor`, belonging to no remediation unit.** `TANDEM_CLAUDE_CMD` -> `statSync` (win32) and the `homedir()`-derived `~/.local/bin` probe, both in `src/shared/integrations/detect-claude-cli.ts`, plus the `PATH`-walk `statSync` in `src/shared/integrations/path-lookup.ts`. Same class as #1417's eighth site and reachable the same way, through `/api/diagnostics` and `tandem_diagnostics`. Enumerated in the #1417 narrative below; listed here because that narrative is not where a maintainer looks for what is open.
- **#1292 — the last HIGH.** It gates on the BYO-models flag flip rather than on the release, so no changelog entry closes it. Verify the issue state, not the changelog — and read the state below before repeating either of the two wrong summaries this finding has already produced.

  **"The v0.21.0 fix closed it" is wrong**, and the issue was very nearly closed on it. #1317's two caps (`MAX_STREAMED_CHARS` 64 KiB on the sink, `MAX_STREAMED_RESPONSE_BYTES` 4 MiB on the wire) *bounded* the amplification; they did not remove it. `updateClaudeChatMessage` still re-`set` the whole message value on every flush, so the cost stayed `O(n²)` — measured 2026-08-07 against a live ctrl `Y.Doc`: a 64 KiB reply cost **27 MB** of broadcast, and because the sink's cap resets on `onTurnEnd({ hadToolCalls: true })` while `maxTurns` defaults to 12, a model looping on tool calls reached **~86 MB** at 12 turns (worst case ~325 MB against the 5-minute deadline) — silently, with no truncation marker and no abort.

  **"The 27 MB / 325 MB figures are current" is also wrong.** #1340 replaced the whole-value re-`set` with a minimal diff-splice into a per-message `Y.Text` in the `chatStream` sidecar, which is what actually made the class linear. Re-measured on master 2026-08-20, same rig:

  | shape | content | ctrl update bytes | vs. 2026-08-07 |
  |---|---|---|---|
  | 1 turn, 2 KB | 2,000 | 2,214 (1.1×) | 33 KB |
  | 1 turn, 16 KB | 16,384 | 37,378 (2.3×) | 1.7 MB |
  | 1 turn, at the cap | 65,536 | 136,090 (2.1×) | 27 MB |
  | 1 turn, 200 KB offered | 200,000 | 136,090 — capped, marker written, run aborted | — |
  | 12 tool-call turns × 65 KB | 780,000 | 808,621 (1.0×) | 85.8 MB |

  So the quadratic is gone and the per-turn reset costs ~0.8 MB per run rather than ~86 MB. **What has not changed is the shape**: the cap is still per-turn, and a tool-call turn still writes no marker and does not abort. That is bounded rather than a hole because `onTurnEnd({ hadToolCalls: true })` *discards* the turn's buffer — the content was preamble, the next turn replaces it, and the visible reply is one turn's worth whatever the turn count. A run-scoped *character* budget would therefore be the wrong instrument: it would count characters that were deliberately thrown away and truncate a legitimate agentic run.

  **Whether the residual clears a HIGH is a re-decision, not a fact**, and it belongs to the same person who made the 2026-08-08 call — that call was recorded against 27 MB / 325 MB, which are now wrong by two orders of magnitude. `docs/roadmap.md`'s local-model gate turns on it. Nothing here is reachable in a shipped build: `BYO_MODELS_ENABLED` is a literal `const false` and `startLocalModelCollaborator()` early-returns before `wire()`.

  **The write-volume assertions are the thing that keeps this fixed**, and they are why the numbers above cannot silently rot: `tests/server/local-model/collaborator.test.ts` pins single-turn cost at ≤12×L (#1340) and run-scoped tool-call-loop cost at ≤4× total content (#1292), both byte-shaped rather than wall-clock, plus a pin that a tool-call turn discards its buffer — the load-bearing half of the argument against a run-scoped budget. Each of those three regressions — reverting the sidecar primitive, disabling its prefix scan, making tool-call turns accumulate — turns one or more of them red, verified by hash-guarded mutation.

Closed from that same gate: #1291 (CORS opaque-origin grant), #1293 (inverted loopback gate), #1294, and #1295 (the six-finding LOW batch).

**[#1558](https://github.com/bloknayrb/tandem/issues/1558) is closed, on both doors.** `GET /api/integrations/existing` served a surfaced MCP entry's `url` verbatim to a non-loopback caller, on a docblock premise ("a loopback http URL by construction") that the next paragraph of the same docblock refuted: `extractEntry` casts whatever `mcpServers.<name>` held in the user's config file, stripping `env`/`headers` and nothing else, so an entry reading `http://user:s3cr3t@example.internal/mcp` went out with its userinfo intact — beside a validation `reason` that had been carefully scrubbed of the same string. Both surfaces now reduce a url to scheme + authority for a LAN caller via `scrubUrlForCaller` (`src/server/mcp/routes/_shared.ts`), built by construction from `protocol` + `host` so userinfo, path, query and fragment are never copied. Three things about it are worth carrying forward:

- **The class was two doors wide, and the second one is why "closed" is honest.** `makeGetIntegrationsHandler` — the sibling route the same docblock names — rewrote `configPath` and `workingDirectory` on a **spread**, so `url` and `nodeBinary` rode out whole. `LoopbackUrl` inspects protocol, username, password and hostname **only**, never path or query, so `http://127.0.0.1:3479/mcp?token=SEKRIT` validates on the way in, persists to `integrations.json`, and reaches a LAN peer. A fix to the named route alone would have left that path open under a "closed" heading.
- **An allowlist only helps when every allowlisted key is also type-checked.** Both halves of this finding are one field nobody listed riding out on a `{...entry}` spread — `url` on the sibling route, `nodeBinary` beside it. `scrubMcpEntry` avoids that shape by rebuilding from a four-key allowlist, and review of this very fix showed why that is not sufficient on its own: `type` was already on that allowlist and was copied on an `!== undefined` test alone, so a config file holding `type: { cwd: "/home/alice/projects/acquisition", token: "…" }` sent both to a LAN caller verbatim — the same disclosure as `url`, through a key the allowlist had "covered" since #1294. It is now narrowed to the one literal `McpEntry` declares. An `in` or `!== undefined` guard proves a key exists, never what it holds. **Do not read this as a generalisation from #1294**: that finding's four surfaces had no scrub at all, and the spread was introduced by its fix rather than by its bug.
- **Reduced, not dropped, and per-caller rather than always.** The authority is the only remaining signal that an entry points off-box — the canned `invalid-url` reason names no host. Loopback callers keep the whole url because the LAN-only `scrubValidation` means the same string reaches them one field over regardless; blanking one and not the other would be reduction in appearance only.

**#1417 fixed ordering at seven sites** (both hand-rolled `isUncPath` copies rewritten as an allowlist of `\\?\C:\…` rather than an enumeration of bad forms), and an **eighth was found afterwards**: `checkTandemPlugin` in `src/cli/doctor.ts` read `~/.claude/settings.json` and the Claude Code config unscreened. It landed in `b045045`, *before* the sweep, so the sweep never saw it — the sweep's own bullet below predicted exactly this, and nothing failed for the eleven days until the sweep or the eight after it. (An earlier revision of this sentence said "for a year" -- wrong by a factor of twenty, and the kind of number that gets quoted in a postmortem.) All doctor reads of the **home-derived** Claude client configs now go through one `readClaudeConfig` loader (`checkProjectMcpConfig`'s project-local `.mcp.json` is cwd-derived, not environment-derived, and is deliberately out of scope), and `src/cli/doctor.ts` is in the delegation list of `tests/shared/unc-check-duplication.test.ts`.

Exposure was narrower than the site count suggests and is worth stating precisely, because the fix's PR was nearly written as if it were broader: no request can influence the path. `home` is the *server's own* environment, `tandem_diagnostics` takes no input, and `/api/diagnostics` is loopback-only. The attacker model is environment control — enterprise folder redirection putting a profile on an SMB share — and the amplifier is that `runDoctor` is reachable from HTTP and MCP, which turns a one-shot CLI probe into a repeatable one.

**Still unscreened, and not closed by that fix** — each performs a filesystem call on an environment-derived path:

- `checkAnnotationStore`'s six reads under `resolveAppDataDir()` (`TANDEM_APP_DATA_DIR`, `%LOCALAPPDATA%`, `$XDG_DATA_HOME`). Strictly more handshakes than the doctor hole above; owned by Unit 12 of the maintainability remediation.
- In `src/shared/integrations/detect-claude-cli.ts`: `TANDEM_CLAUDE_CMD` → `statSync` (win32 branch), and the `homedir()`-derived `~/.local/bin` probe. The former honours an env var directly; the latter reaches `$HOME`/`%USERPROFILE%` through `os.homedir()`, so a redirected profile reaches it exactly as it reached `checkTandemPlugin`.
- The `PATH`-walk `statSync` in `src/shared/integrations/path-lookup.ts`, reached from three doctor checks.

Owned by no unit and tracked in **#1609**; `checkAnnotationStore` is Unit 12's.

Four things about the original sweep and this follow-up are worth carrying forward rather than forgetting:

- **The class is "syscall before verdict", and a static check cannot see it.** `tests/shared/unc-check-duplication.test.ts` catches duplicated *predicates*; ordering is pinned per-site in `tests/server/unc-guard-ordering.test.ts`, `tests/cli/doctor-path-safety.test.ts`, `tests/server/launcher/supervisor.test.ts`, `tests/cli/win-path-guard.test.ts` and the reparse-point block in `tests/cli/uninstall-scrub.test.ts`. A new site needs a new ordering test — nothing will fail without one. **That is not hypothetical: it is how the eighth site survived.**
- **Screen the untrusted input, not only the path derived from it.** `path.join` is platform-dependent — four of the fourteen spellings in `tests/helpers/unc-fixtures.ts` (the pure forward-slash forms) survive `path.posix.join` as paths `rejectUnsafeWindowsPrefix` then accepts. A guard applied only to the derived path therefore cannot fire for those four on a Linux runner, and CI's `check` job is ubuntu-only, so the corresponding rows pass because the path stopped being dangerous rather than because anything screened it. Same shape as #1529. Every doctor check that derives a config path from the environment now screens the input as well: the effective home for the two `HOME`/`USERPROFILE` checks, and for the Claude Desktop check the **one** input its resolver's precedence actually selects (`desktopScreenInput`) — not every candidate. Screening every candidate is the tempting error and it costs a real answer: under enterprise redirection `%USERPROFILE%` is on a share while `%APPDATA%` stays local, so refusing on either would call an ordinary local file a network path and drop the only check reporting Claude Desktop registration.
- **Measure with the real predicate, not a stand-in for it.** The count above was first taken with a hand-written `/^(\\\\|\/\/)/` and came out as six. The guard normalises `/` to `\` across its first eight characters, so it still rejects both *mixed*-separator forms after a posix join — a stand-in that skips the normalisation gets the answer wrong in the direction that overstates the problem.
- **Those tests assert the syscall, not the return value, and that is not stylistic.** A UNC path to a host that does not answer already returned `null`/`false`/`[]` before the fix, so a return-value assertion passes against the vulnerable code. The first attempt at one of these tests was written that way and the mutant survived.

**Bare-name resolution of Windows system binaries is closed.** `Command::new("netsh")` never reaches `CreateProcess` as a bare name — Rust resolves it in `search_paths`, which walks **the application directory ahead of System32**. Tandem installs per-user (`INSTALLMODE "currentUser"`, `$INSTDIR = $LOCALAPPDATA\Tandem`, `RequestExecutionLevel user`), so that directory is fully writable by the unelevated user. All five Rust sites — two `netsh`, one `powershell`, one `reg`, one `explorer` — now resolve through `src-tauri/src/system_paths.rs` and fail closed, as do the three remaining Node sites. Five things about it are worth carrying forward:

- **The count was wrong twice before it was right, in both directions.** The first sweep found four Rust sites and missed `explorer` — which is the *worst* of them, not the mildest: `explorer.exe` lives in `%SystemRoot%` rather than System32, so the loader reaches it only after the user-writable application directory **and** System32, and `show_in_file_manager` is the one spawn a webview gesture triggers directly. Reviewing the fix then produced a confident claim that the signed uninstall binary spawns no `netsh` at all, which is false — it reaches it indirectly through `firewall::remove_cowork_rules()`, invisible to a grep of `uninstall_scrub.rs`. A count of spawn sites is not a grep result; both errors came from treating it as one.

- **The repo already knew, and applied the knowledge to exactly one site.** `run_system32_tool` anchored `netstat`/`tasklist` because they feed a *diagnostic string*, while the firewall and uninstall paths — the ones that write system state — used bare names. A rule that lives in one function's docblock and nowhere else is a rule that will be applied where it was written and nowhere else; that is why it now has a `docs/gotchas.md` entry and a module of its own.
- **The obvious anchor was worse than the bare name.** `format!("{SystemRoot}\\System32\\{exe}")` reads the environment block, which belongs to whoever launched the process — so it is attacker-controlled input in mitigation clothing, and poisoning it requires no filesystem write at all. `run_system32_tool`'s own docblock named `SystemRoot` as launcher-settable and then built its path from it. `GetSystemDirectoryW` reads session state instead, and is literally the call Rust makes at step 3 of its own search.
- **Severity is bounded, and overstating it was the first draft's error.** Nothing in the product elevates — `AdminDeclined` is inferred from netsh's exit code, never from a UAC prompt — so in the shipped configuration this is hijack convenience, not a privilege-boundary crossing. `docs/release-smoke-checklist.md`'s "launch elevated" line addresses the release engineer, not users, and an elevated process launched from a user-writable directory is already exposed via DLL search order regardless.
- **The uninstall path documented the mitigation it then defeated.** `src-tauri/windows/installer-hook.nsi` explains that the scrub runs inside the signed `tandem.exe` rather than a separate binary precisely to prevent binary planting — and that signed binary then spawned bare `reg`, and reached bare `netsh` through `firewall::remove_cowork_rules()`. **There are two firewall scrubs**, and the second one is in a different binary: the npm CLI's `src/cli/uninstall-scrub.ts` deletes the same rules and had its own bare `netsh`. Anchoring one and not the other would have closed nothing.

The Node half is narrowed rather than closed. Every Node site is now anchored through `systemBin` — `acl-win.ts`'s Windows PowerShell fallback, the CLI scrub's `netsh`, `process-identity.ts`'s `tasklist` (whose Rust twin was already anchored, an asymmetry rather than a policy), and `install-claude-cli.ts`, which hand-rolled a byte-identical copy of the same join and so would have drifted out of the rule the moment the rule changed. But `systemBin` itself reads `process.env.SystemRoot`, because Node cannot reach `GetSystemDirectoryW` without a native module. What bounds that residual is that the Node server never runs elevated, so a launcher able to poison its environment already holds everything the process holds — and the Node exposure is narrower in kind: libuv does not search the cwd, so it is PATH poisoning only, with no application-directory vector. `pwsh.exe` stays a bare name deliberately — PowerShell 7 has no fixed install path, so PATH is its genuine discovery mechanism rather than a lookup that could have been anchored.

### Accepted (bounded) — decided, not fixed

**A finding lands here when the decision is closed but the code condition
persists.** It is deliberately not in the "Open as of" list above: that list is
the one a reader scans for what still needs a decision, and an entry prefixed
`ACCEPTED` inside it is the same parsing tax the `Closed since` split exists to
avoid. It is equally not `Closed since`, whose entries all narrate a real code
change. Every entry here carries who accepted it, when, its tracked issue, the
bound in full, and the conditions that void the acceptance.

- **[#1654](https://github.com/bloknayrb/tandem/issues/1654) — caller-named write destinations are not root-confined. ACCEPTED 2026-08-28 (narrowed, not contained); revisit by 2027-02-28. CodeQL alert 16 stays OPEN.** Four sites take a caller-supplied write path: `tandem_convertToMarkdown`'s `outputPath` (`src/server/mcp/convert.ts`), `tandem_exportAnnotations`'s `outputPath` (`src/server/mcp/annotations.ts`), the `.docx` `backupPath` (`docx-apply.ts:119`, `path.resolve`d) and Save-As's `targetPath`. None is root-confined and none became so.

  **The target is one class, not four.** An earlier draft claimed anything able to create `*.md` at an arbitrary path reaches `~/.claude/CLAUDE.md`, a project `CLAUDE.md`, `.claude/agents/*.md` and `~/.claude/skills/*/SKILL.md`. Three of those do not hold: `SKILL.md` needs a new subdirectory and `atomicWrite` (`file-io/index.ts:349-353`) does no `mkdir`; `.claude/agents/*.md` puts only the frontmatter `description` in the system prompt and needs valid YAML; `~/.claude/CLAUDE.md` normally already exists, so `findAvailablePath` (`convert.ts:21-53`) refuses it. **What survives is a project `CLAUDE.md` written into a repo that lacks one** — full body, auto-loaded, no user action beyond starting a session there. Creation, not overwrite, is the capability it needs.

  **Why containment was rejected, and this is the part worth carrying forward.** Confining a caller-named destination to the *document's own directory* — the shape `tandem_rename` uses — does not block that target; it **aims at it**. The document is normally already inside the repo whose `CLAUDE.md` is the target, and `CLAUDE.md` is a bare filename, so confinement permits the one surviving class while blocking only the three already discounted. The counterexample used to reject a denylist (`.cursorrules`, `.github/copilot-instructions.md` and this repo's own root `AGENTS.md` all survive it) defeats confinement identically, for the same reason: they are bare filenames in a repo root. A root set fails too — `assertPathSafe`'s default `[homedir(), tmpdir()]` (`apply.ts:577`) contains every project `CLAUDE.md` under `$HOME`. An extension pin resolves to `.md`, the extension the vector requires.

  **What shipped instead — remove the caller-named leaf, keep the caller-named directory.**
  - `tandem_exportAnnotations`: the final resolved basename must end in `.annotations.md` / `.annotations.json`, matching `format`. That is an allowlist **by construction** — it refuses `CLAUDE.md`, `AGENTS.md`, `.cursorrules` and `settings.json` without enumerating them — while the destination directory stays unrestricted, which is the documented point of the parameter. Three preconditions make it sound and are commented at the site: it runs on the **post-realpath** path (a conforming leaf that is a symlink to `CLAUDE.md` would otherwise launder itself); `atomicWrite` is temp-file + `rename`, which **replaces** a symlink rather than writing through it, and is the only reason a check on the *name* implies anything about the *inode*; and it is `endsWith`, never an anchored pattern, because the default is `${filePath}.annotations.${ext}`. A colon in the basename is also refused (NTFS alternate data stream).
  - `tandem_convertToMarkdown`: `outputPath` is now a **directory** that must already exist. The leaf is always derived from the source document, so no caller names the created file.

  **The accepted residual, stated as a chain rather than a capability.** `tandem_rename` pins the extension but not the stem and is confined to the document's own directory, so an attacker can rename an open `report.docx` to `CLAUDE.docx` in place and then convert into a victim directory, producing `<repo>/CLAUDE.md`. This is accepted because every step is loud: the rename moves the user's real file on disk and changes the tab title, and the conversion opens a tab at the destination. It is a three-call chain with two visible side effects, where the finding began as a single call with a caller-named leaf. `tandem_exportAnnotations` — the only **silent** site (no tab, no notification, `writtenPath` returned to Claude alone) — is closed to this target by the suffix pin.

  **Also part of the bound: the larger primitive beside it.** `resolveAndValidatePath` (`src/server/documents/open.ts:615-673` after #1661 relocated it; verified at that commit to contain no `allowedRoots` and no `assertPathSafe`) applies no root containment, so an MCP client can already `tandem_open` any existing allowlisted file at any absolute path, `tandem_edit` it and `tandem_save` it — arbitrary content into any existing `.md` on the machine. That is a **separate finding, tracked as [#1666](https://github.com/bloknayrb/tandem/issues/1666)**; it is named here because this acceptance leans on it, and an acceptance that leans on an untracked condition is not bounded. It is also why the residual above is a marginal capability rather than a new one.

  **`.md` glob loaders are the honest remainder of the suffix pin.** `<name>.annotations.md` is auto-loaded *on session start* by nothing, but `.claude/commands/*.md` is a glob loader and would register `/x.annotations`. It stays weak because the markdown export always begins `# Document Review` (`file-io/docx.ts:193`, `:212`), so the file can never open with `---` and can never carry YAML frontmatter — which is also what defeats `.claude/agents/`.

  **Rename is deliberately not in the four**, and an earlier draft wrongly counted it as a fifth. `document-service.ts:1023` builds the target as `path.dirname(oldPath)` + `path.basename(newName)` behind `validateRenameFilename` (`:995`), an extension pin (`:1001-1009`), an explicit separator/NUL guard (`:1015-1021`) and an `ALREADY_EXISTS` refusal (`:1053-1060`). **Save-As is not in the MCP threat model either**: `saveDocumentAsToDisk` has one caller (`routes/save.ts:103`), an MCP client has no HTTP verb, and it already carries an extension pin (`document-service.ts:690-700`).

  **What an MCP caller sees.** `tandem_exportAnnotations` returns `mcpError` directly, so its `INVALID_PATH` reaches the caller intact and the message names the required suffix — the recoverable action is renaming the leaf. `tandem_convertToMarkdown` is different and this is a live trap: `document.ts:1072-1079` maps `INVALID_PATH` to `FORMAT_ERROR`, which tells an AI caller to retry the *document* format when the *path* was rejected. `docx-apply.ts:460-461` does the same. `PathRejectedError` (`apply.ts:284-293`) carries no `.code`, so a naive catch chain lets it escape as a 500.

  **Revisit criterion, answerable from tracked files.** This acceptance is void if either holds: (i) `src/server/documents/open.ts`'s resolver gains root containment, which would remove the "already reachable" half of the argument and make the residual chain a net-new capability; or (ii) any new tool or route accepts a caller-named write **leaf** (as opposed to a directory). Full analysis: `docs/plans/2026-08-28-caller-supplied-write-destinations.md`.

- **[#1599](https://github.com/bloknayrb/tandem/issues/1599) — boot-sweep / `setup --apply` config race. ACCEPTED by Bryan on 2026-08-24; revisit by 2027-02-24.** Found in review of the npx-convergence self-repair (#1501 is the merged PR whose review found it, not a tracking issue). The boot sweep's Claude Desktop npx→absolute-path convergence and a concurrently-run `tandem setup --apply` or `tandem rotate-token` both read-modify-`atomicWrite` the same config file with no lock between them — the sweep is gated only by the unrelated annotation-store lock, which a separate CLI process never touches. Realistic trigger: a user or a setup script runs the wizard or the CLI at roughly the moment Tandem's server boots.

  **The bound, in full — "merely a replaceable field" is false, and stopping at "not corruption or privilege escalation" understates it.** The failure is a lost update: the last writer's read-modify-write wins, silently reverting the other's change. Each individual `atomicWrite` remains atomic, so there is no torn file and no half-merge. What is lost differs by case, and the two cases do not share a bound:

  - *Token rotation — fails closed.* `rotate-token.ts` writes the new token to the token store (`:52-57`) and confirms the **server** accepts it (`:73-87` — the fetch and its `resp.ok` check) before rewriting any client config at `:149-159`. The concrete race is the boot sweep: `refreshAllMcpEntryBinaries` reads the whole config (`apply.ts:1887`) and, if anything needed repair, writes back `opened.root` wholesale (`apply.ts:1957`) — a full pre-rotation snapshot replayed over the rotation's write. The client is then pointing at a token the server has already stopped accepting, so it breaks loudly once the 60-second grace closes (`src/server/mcp/routes/rotate-token.ts:41-43`). A superseded token never keeps working. Cost: one re-run of `tandem rotate-token`, with nothing pointing at the cause.
  - *Uninstall — does **not** fail closed, and this is the sharp edge.* `removeConfigEntries` (`apply.ts:1295-1311`, called from `uninstall-scrub.ts:453`) deletes the `tandem` and `tandem-channel` entries, bearer token included, and writes the whole root. If a concurrently-booting server's sweep write lands after it, those entries come back verbatim from the sweep's own pre-delete snapshot. **Nothing in the uninstall path revokes or rotates the auth token** — the scrub only takes care not to log it — so the resurrected entry carries a *live, indefinitely valid* credential, not a stale one. That is credential remanence after an explicit scrub, and re-running uninstall fixes it only if the user knows to look. Note that the usual "anyone who could write the config could add their own entry anyway" argument does **not** cover this case: undoing a legitimate deletion needs only timing, not the intent or the ability to author an entry.

  - *First install — silent, permanent, and reported as success.* `applyConfig` (`apply.ts:1007`) reads the config once, merges its own `ops.create`/`ops.remove` onto that single snapshot, and writes the whole root back; there is no re-read before commit and no per-key merge. So if `tandem setup --apply` or the wizard's apply endpoint adds a **new** `tandem`/`tandem-channel` entry at the moment the boot sweep is repairing some unrelated stale entry in the same file, the sweep's full-root write — taken from a snapshot predating the new entry — drops the fresh install entirely. **Nothing recovers it.** `repairEntryInPlace` (`apply.ts:1738`) returns `no-op` for an absent entry, so the next boot sweep repairs what is there and cannot recreate what is not; `applyConfig` has already returned successfully, so the CLI reports the install as done. This case was missed by the first draft of this entry and by #1599, both of which said everything outside the two credential cases recomputes. **That is true of repairing a stale entry and false of installing a new one.**

  Of what remains, the binary path, the npx→absolute convergence and the `SKILL.md` content do genuinely recompute on the next boot or command — they are repairs to entries that are still present, which is exactly the case the sweep handles.

  **Writers covered by this acceptance**, and the pinned set is enforced rather than described: `tests/docs/config-writer-set-claims.test.ts` derives the durable-write sites under `src/server/integrations/` and `src/cli/` from source and fails on any site not classified, so a new writer cannot silently join the accepted set.

  **What is NOT accepted here.** (i) [#1600](https://github.com/bloknayrb/tandem/issues/1600) — `uninstall-scrub.ts`'s `rewriteJson` mutates the three Cowork JSON files that the Rust side mutates under a real cross-process lockfile (`src-tauri/src/cowork_atomic_json.rs:130`). Same read-modify-write shape, different target, and strictly worse: it is the one place where a lock exists and a writer simply does not take it. (ii) The known gap at `rotate-token.ts:160-169`, where rotation does not re-walk Cowork workspaces and strands post-rotation Cowork sessions on a dead token — a separate defect with its own TODO, not a consequence of this race. (iii) The atomicity of any individual write, and specifically the property that a losing writer's token appears **nowhere** in the final file. That is pinned by `tests/server/integrations/apply-malformed.test.ts` and must never regress.

  **The acceptance is void — reopen it as a finding — if any of these becomes true.** Each is currently false and checkable from tracked files:

  - The config-writer guard test fails and the new writer is added to its pinned set without being named in this entry.
  - Any `/api` route or MCP tool reaching a config writer stops calling both `assertOriginAllowlisted` and `assertLoopbackForMutation`. Today `POST /api/integrations/apply` calls both at handler top (`src/server/integrations/api-routes.ts:747-748` — note there is a second, unrelated `api-routes.ts` under `src/server/mcp/`) and no MCP tool reaches a config writer at all.
  - **The server's accepted-token source moves into a file any `apply.ts` writer touches.** This is the load-bearing invariant: `rotate-token.ts` and `src/server/auth/token-store.ts` write the token file independently of every config writer, and that separation is the single fact keeping a lost update from resurrecting a *live* credential in the rotation case. It is pinned by the same guard test, which scans all of `src/` for it rather than the two directories above — a directory-scoped check would be blind to `token-store.ts` by construction.

  At the review date the outcome must be keep, replace or retire. "Revisit again" is not one of them.

## CodeQL dispositions, and why they do not survive a refactor

**A dismissal is keyed to an alert number, and an alert number is keyed to a
location.** Move the code and the scanner retires the alert and opens a new one
at the new line, carrying none of the dismissal or its reasoning. This is not
hypothetical: Unit 7a ([#1645](https://github.com/bloknayrb/tandem/pull/1645),
unmerged at the time of writing — `openFileByPath` and `resolveAndValidatePath`
are still in `src/server/mcp/file-opener.ts` on master) moves the open pipeline
into `src/server/documents/`, and that opened eight fresh `js/path-injection`
alerts on its PR branch against sinks whose master-side twins had just been
dismissed. Each matched its twin at the same **column**, which is what made the
mapping checkable rather than assumed; it is recorded in that PR's comments.

So the reasoning lives here, keyed by **sink and argument** rather than by
number. Re-dismissing after a move should be a lookup against this list plus a
check that the named screen still runs first — not a fresh investigation, and
not a reflex "it was dismissed before".

- **Paths reaching a file open through `resolveAndValidatePath`.** It is called
  unconditionally at the head of `openFileByPath` and screens UNC/extended-length
  prefixes on the raw, resolved *and* `realpath`'d forms, enforces the extension
  allowlist and the size cap. **Bound: screened, but NOT confined to any
  directory** — opening any allowlisted-extension file by absolute path is the
  product's intended behaviour, so a containment-shaped alert here is a policy
  question — see "Caller-named write destinations are not root-confined" under
  Open findings — not a false positive.
- **Paths from the server-owned `OpenDoc` registry, and rename targets.** Request
  input contributes only a document-id map key, `path.basename`'d before lookup;
  a rename target is pinned to the existing file's own directory and extension.
- **`assertPathSafe`'s own ancestor-walk probes.** CodeQL flags the sanitizer.
  They run after its unconditional UNC screen and terminate in its `allowedRoots`
  containment test.
- **Sinks preceded by `rejectUnsafeWindowsPrefix` on the same value.** The screen
  must be on *that* value and immediately before the sink; a screen on a
  different form of the path does not carry.
- **General-purpose path helpers that validate nothing themselves** — the
  session-store and path-join helpers. These are false positives **for the
  current caller set only**, and that phrasing is deliberate: the safety property
  belongs to the callers, not to the flagged code. A new caller must screen
  before calling, so verify the call site rather than trusting the disposition.
- **`js/tainted-format-string` on `sessionPath` interpolations.** The flagged
  argument genuinely *is* the format string (a template literal), so the rule
  reads the shape correctly. The disposition rests on the value: the
  caller-controlled segment passes through `encodeURIComponent`, and every `%` it
  emits is followed by two **uppercase** hex digits, while no `util.format`
  specifier (`s d i f j o O c`) is an uppercase hex digit — the argument survives
  only because case matters, since `c` is a specifier and `C` is a hex digit. The
  specifier list is complete for the Node version this project pins; `%%` is the
  only omission and `%XX` output cannot produce it. **The one unencoded segment is
  the process's own `SESSION_DIR`** (`platform.ts:42`, derived from `homedir()` or
  `TANDEM_APP_DATA_DIR`), so a `%` in a Windows username or in that env var does
  reach the format string unencoded. Bounded but not zero: the impact ceiling is a
  garbled stderr line, since JS format strings have no memory-safety dimension.

**A disappearing alert is not evidence of a fix.** When the uncontained
`fs.copyFile` write moved into `copyBackupExclusive`, CodeQL lost the trace and
the alert vanished from the master-ref listing while the condition was unchanged.
Read a shrinking alert list as a scanner outcome until the code says otherwise.

## Reporting security issues

Email security reports to the address in [package.json](../package.json)'s `bugs.email` field, or open a private security advisory at <https://github.com/bloknayrb/tandem/security/advisories/new>. Please don't file public issues for vulnerabilities.

**Licensing and activation problems go to the same address, not to the issue tracker.** A license key contains your name and email address, and the natural instinct when activation fails is to paste it somewhere for help. Don't paste it in a public issue.
