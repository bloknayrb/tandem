# Security

Tandem is designed local-first. The server binds to `127.0.0.1` by default, document content stays on disk, and there are no Tandem-operated servers in the picture.

## Network posture

- **Default bind:** `127.0.0.1`. The MCP HTTP endpoint and Hocuspocus WebSocket only accept connections from the local machine.
- **LAN exposure (opt-in):** set `TANDEM_BIND_HOST=0.0.0.0` (or a specific interface) to expose Tandem on a LAN. Non-loopback requests require a Bearer token by default; Tandem auto-generates one on first run and stores it at `{APP_DATA_DIR}/auth-token` with mode `0o600`.
- **Loopback detection is fail-closed.** Authentication middleware uses `req.socket.remoteAddress` exclusively — never the `Host` header — so DNS rebinding attacks cannot trick the server into treating a remote request as loopback. IPv6 variants (`::1`, `::ffff:127.0.0.1`) are normalized to `127.0.0.1`.
- **Insecure LAN opt-in:** `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` lets the server bind to a non-loopback host when no auth token has been provisioned yet. Without it, that startup is refused outright (`bind-check.ts`). The name overstates what it does: it does **not** switch authentication off. `authMiddleware` (`src/server/auth/middleware.ts:161`) never reads the flag — it still requires a valid Bearer token from every non-loopback caller, and a token is always minted. Since #1293 the flag relaxes **no guard at all** — it changes exactly one thing, whether the bind is permitted without a provisioned token. (It previously relaxed `assertLoopbackForMutation`, in the inverted direction described below.) Intended for trusted-network development; never set it on a public network.

See [configuration.md](configuration.md#environment-variables) for the full environment-variable reference (ports, bind host, auth token, app-data paths).

## CORS allowlist

The server accepts cross-origin requests from three origins only (`isLocalhostOrigin`, `src/server/mcp/api-routes.ts:96-105`):

- `http(s)://127.0.0.1` with any port
- `http(s)://tauri.localhost` — the Tauri WebView's origin on Windows and macOS
- `tauri://localhost` — the Linux Tauri WebView's custom scheme, matched as an exact string rather than a `tauri://*` wildcard, since it cannot be forged by remote content

Bare `http://localhost` was narrowed out in PR #637 because it bypassed DNS-rebinding hardening.

**Absence of the header is the denial — never `null` (#1291).** `Access-Control-Allow-Origin` is emitted *only* for an allowlisted origin. Writing `null` reads like a refusal and is the opposite of one: `null` is the origin serialization the Fetch spec assigns to *opaque* contexts, so a sandboxed, `data:` or `srcdoc` iframe on any public page sends `Origin: null`, the browser's CORS check matches it, and the response body becomes cross-origin readable. Absence has no matching semantics at all, so it denies every origin including opaque ones. `Vary: Origin` is set unconditionally, including on denied responses, because the response genuinely varies by origin and `/api` carries no `Cache-Control`.

This reaches further than the JSON routes: the SSE handlers call `res.writeHead(200, {...})`, which Node *merges* with headers already set rather than replacing them, so `/api/events` inherits the same protection. If either stream is ever rewritten to a replacing header write, that coverage disappears silently.

**The WebSocket does not use the same allowlist.** Hocuspocus origin validation (`src/server/yjs/provider.ts:91-104`) and the MCP server's `allowedHosts` (`src/server/mcp/server.ts:386`) are separate lists that permit overlapping but different sets — `allowedHosts` additionally accepts the bare hostname `localhost` and `[::1]`. Treat them as three surfaces to audit, not one.

## Auth tokens

- **Generation:** 32 random bytes, base64url-encoded.
- **Storage:** `{APP_DATA_DIR}/auth-token`, mode `0o600`, written atomically (temp file + rename).
- **Comparison:** both sides SHA-256-hashed, then compared with `crypto.timingSafeEqual` to prevent length-oracle attacks.
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

  It governs the routes that **call** it, and **ten** mutating routes registered in
  `src/server/mcp/api-routes.ts` call neither gate. Four of them take a caller-supplied
  filesystem path — `open`, `save` (save-as), `convert`, `upload` — which makes them the
  higher-blast-radius subset and the one #1320 tracks. The other six are `close`, `scratchpad`
  (#1318 is adding its gate), `apply-changes`, `annotation-reply`, `remove-annotation` and
  `rotate-token`; a token-holding LAN peer can still reach those. Separately, `/api/channel/*`
  and `DELETE /api/chat` are ungated **deliberately**, because the channel shim and monitor are
  documented to run against a non-loopback `TANDEM_URL` (Cowork) and gating them would break that
  transport. "Mutating routes are loopback-only" is not a statement about all of `/api`.

**The primary protection is the loopback bind plus Bearer auth for every non-loopback caller** —
the two controls described above, which hold regardless of either assertion. `assertOriginAllowlisted`
is defence in depth on top of that; `assertLoopbackForMutation` now covers the one case neither
control does — a caller who holds a valid token but is not on this machine. A route that
has them is not thereby safe to expose. `docs/decisions.md` ADR-046 states the same posture.

## Privacy

- **Notes are user-private (ADR-027).** Annotations with `type: "note"` are stripped from every MCP tool response and never appear in channel events. The AI cannot read them.
- **What the AI sees:** the document content you open, selections you hold (subject to dwell-time gating), annotations you create or that the AI itself creates, and chat messages sent through the Tandem sidebar.
- **What the AI doesn't see:** files you haven't opened, notes (per above), the auth token, and any environment variables that aren't surfaced through MCP tools.

## Telemetry: none by default, crash reporting strictly opt-in

Tandem ships with **no usage analytics and no telemetry beacons**, and **crash reporting is off by default**. The only outbound traffic Tandem initiates out of the box is to your configured AI client over loopback (or LAN, if you opted in) and — for the desktop app — periodic update checks against the public release host. Update checks carry no analytics.

Crash reporting is available but **strictly opt-in**: it activates only when you set the `TANDEM_SENTRY_DSN` environment variable to a [Sentry](https://sentry.io) or self-hosted [GlitchTip](https://glitchtip.com) DSN that you control. With the variable unset (the default), no Sentry client is initialized in the desktop shell, the Tauri Sentry plugin is never registered, the WebView is never instrumented, and `@sentry/node` is never even loaded in the sidecar — there is no crash-reporting code path on the wire. When you do opt in, Tandem reports Rust panics + native minidumps (shell), JavaScript errors / unhandled rejections (WebView, bridged over Tauri IPC), and Node uncaught exceptions (sidecar) to *your* endpoint, scrubbing home-directory paths to `~`/`[user]`, redacting Anthropic/bearer-style secrets, and dropping request/document payloads and content breadcrumbs before egress. Document content and annotation bodies are never attached to events. Self-hosting GlitchTip keeps all crash data under your control. Settings → About shows the current on/off status. Implemented in `src-tauri/src/sentry_reporting.rs`, `src/client/sentry.ts`, and `src/server/sentry.ts` (#921).

## Licensing activation (v1.0)

This describes the paid model arriving at v1.0; during the public beta Tandem is free and unlicensed. The system is implemented but **ships dark behind a build flag** (`LICENSE_GATE_ENABLED`, off until v1.0), so beta builds enforce nothing. See [ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license) and `docs/licensing-operations.md`.

- **Running the app validates a license offline.** The app verifies an Ed25519-signed license file locally against a public key embedded in the build. *Running needs no network call* — activation works air-gapped, and the signature is checked on your own machine. This is a separate key from the Ed25519/minisign key used to sign release artifacts. A valid license runs the current version **forever**; the signature alone gates running, while `expiresAt` governs only the update window.
- **The license file binds a copy to its buyer.** It carries the buyer's name and email, an opaque license id, a type (`personal`/`commercial`/`grandfathered`), a creation date, and an update-window expiry, all covered by the signature. It does **not** carry an order ID — the order number lives only in the seller-side issuance ledger, and is the identifier support will ask you for.
- **Enforcement is server-side, not client-trust.** When the gate is active and a trial has expired with no license, the local server marks Hocuspocus document-room connections read-only AND gates Claude's mutation tools / mutating `/api` routes — both re-checked per request. The escape hatch is preserved: you can always open, read, and **export** your local files (and chat keeps working). The trial clock is deliberately **soft** (a local timestamp, no anti-rollback); the signed license is the only hard gate.
- **Updates authenticate entitlement without telemetry.** The licensed updater sends an opaque license id (a UUID, not the buyer's key or email) to a small license-checked endpoint that serves new builds only while the update window is current. Unknown ids and expired windows get a **byte-identical no-update** response (no existence oracle). The endpoint logs `{ result, reason, timestamp }` — a coarse enum describing *the service's* state (`unknown-id`, `expired`, `upstream`, …), **never the license id**, so no per-customer update history exists. That reason field is the only way the operator can tell a broken issuance pipeline from a healthy one, because a license with no entitlement is served the same no-update response as having nothing to install — and the app reports it to you as "You're up to date". Note that the endpoint runs on Cloudflare, whose platform-level request logging is outside Tandem's control; "no telemetry" is a statement about what Tandem records, not about what a CDN sees. An expired-window license still *runs* offline; it simply stops receiving new builds.

## Reporting security issues

Email security reports to the address in [package.json](../package.json)'s `bugs.email` field, or open a private security advisory at <https://github.com/bloknayrb/tandem/security/advisories/new>. Please don't file public issues for vulnerabilities.

**Licensing and activation problems go to the same address, not to the issue tracker.** A license key contains your name and email address, and the natural instinct when activation fails is to paste it somewhere for help. Don't paste it in a public issue.
