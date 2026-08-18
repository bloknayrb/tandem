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

  It governs the routes that **call** it, and **nine** mutating routes registered in
  `src/server/mcp/api-routes.ts` call neither gate: `open`, `save` (save-as), `convert`,
  `upload` — the four taking a caller-supplied filesystem path, the higher-blast-radius
  subset #1320 was filed over — plus `close`, `apply-changes`, `annotation-reply`,
  `remove-annotation` and `rotate-token`. (`scratchpad` was the tenth until #1318 gated it.)
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

Open as of v0.22.1:

- **[#1420](https://github.com/bloknayrb/tandem/issues/1420) — two link-handling escapes, image sources closed.** Middle-click never reaches the link intercept (`Editor.svelte` registers `onclick` and no `onauxclick`), and `/\evil.com/x.md` renders live because the guard is `defaultValidate(url) || isSchemelessPathHref(url)` and the first operand short-circuits the second away. **Partially reduced by the #1417 fix, and do not read that as closed:** the mixed-separator normalisation in `rejectUnsafeWindowsPrefix` means `resolveRelativeLink` now refuses `/\evil.com/x.md` and `\/evil.com/x.md`, so the *click-navigation* path is guarded. The mark still renders as a live link (the `defaultValidate(url) || isSchemelessPathHref(url)` short-circuit is untouched), and middle-click still bypasses the intercept — both still open. **The image-source half closed by #1497:** paste and file-open (`.md` via `mdast-ydoc.ts`, `.docx` via `docx-html.ts`) now share one allowlist (`src/shared/image-src-safety.ts`), closing the protocol-relative/mixed-separator/control-char-prefixed bypasses the click-navigation guard already had, and a new `img-src 'self' data: blob:` CSP (`index.html`, matching the pre-existing Tauri CSP) blocks any surviving cross-host image fetch at the browser level across all three build targets — previously only the packaged desktop app had this CSP. Still open, by design: the content allowlist still treats a general `https://` image URL as safe (a deferred product decision, not a gap — stripping them would break every document with a hosted badge). Note what that does and does not mean now: the `img-src` CSP above blocks the *fetch* in all three build targets, so such an image does not load today — the CSP is the only control doing that, and loosening it re-exposes this, and `'self'` still permits a document to GET the app's own loopback origin (reads are scrubbed and non-GET is refused by `enforceLoopbackMutation`, so this buys nothing today; it is the residue to look at first if that changes).
- **Boot-sweep / `setup --apply` config race (found in review of the npx-convergence self-repair, #1501).** The boot sweep's Claude Desktop npx→absolute-path convergence and a concurrently-run `tandem setup --apply` (or `tandem rotate-token`) both read-modify-`atomicWrite` the same config file with no lock between them — the sweep is gated only by the unrelated annotation-store lock, which a separate CLI process never touches. Scope is a **lost update** (last writer's read-modify-write wins, silently reverting the other's change), not corruption or privilege escalation — each individual `atomicWrite` is still atomic, and anyone who can already write the config file could add their own runnable MCP entry directly without needing this race at all. Realistic trigger: a user (or a setup script) runs the wizard or the CLI at roughly the same moment Tandem's server boots. No fix landed for this pass; either add real cross-process locking around every `apply.ts` config writer (modeled on the existing annotation-store lockfile), or accept it as a documented, bounded risk.

Still open from the v0.21.0 security gate, whose RC re-run failed on 2026-08-05 with two HIGH:

- **#1292 — the last HIGH.** Its code fix shipped in v0.21.0, but it gates on the BYO-models flag flip rather than on the release, so the v0.21.0 changelog entry does not close it. Verify the issue state, not the changelog.

Closed from that same gate: #1291 (CORS opaque-origin grant), #1293 (inverted loopback gate), #1294, and #1295 (the six-finding LOW batch).

**#1417 is closed** (ordering fixed at seven sites; both hand-rolled `isUncPath` copies rewritten as an allowlist of `\\?\C:\…` rather than an enumeration of bad forms). Two things about it are worth carrying forward rather than forgetting:

- **The class is "syscall before verdict", and a static check cannot see it.** `tests/shared/unc-check-duplication.test.ts` catches duplicated *predicates*; ordering is pinned per-site in `tests/server/unc-guard-ordering.test.ts`, `tests/server/launcher/supervisor.test.ts`, `tests/cli/win-path-guard.test.ts` and the reparse-point block in `tests/cli/uninstall-scrub.test.ts`. A new site needs a new ordering test — nothing will fail without one.
- **Those tests assert the syscall, not the return value, and that is not stylistic.** A UNC path to a host that does not answer already returned `null`/`false`/`[]` before the fix, so a return-value assertion passes against the vulnerable code. The first attempt at one of these tests was written that way and the mutant survived.

## Reporting security issues

Email security reports to the address in [package.json](../package.json)'s `bugs.email` field, or open a private security advisory at <https://github.com/bloknayrb/tandem/security/advisories/new>. Please don't file public issues for vulnerabilities.

**Licensing and activation problems go to the same address, not to the issue tracker.** A license key contains your name and email address, and the natural instinct when activation fails is to paste it somewhere for help. Don't paste it in a public issue.
