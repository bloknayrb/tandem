# Security

Tandem is designed local-first. The server binds to `127.0.0.1` by default, document content stays on disk, and there are no Tandem-operated servers in the picture.

## Network posture

- **Default bind:** `127.0.0.1`. The MCP HTTP endpoint and Hocuspocus WebSocket only accept connections from the local machine.
- **LAN exposure (opt-in):** set `TANDEM_BIND_HOST=0.0.0.0` (or a specific interface) to expose Tandem on a LAN. Non-loopback requests require a Bearer token by default; Tandem auto-generates one on first run and stores it at `{APP_DATA_DIR}/tandem_auth_token` with mode `0o600`.
- **Loopback detection is fail-closed.** Authentication middleware uses `req.socket.remoteAddress` exclusively — never the `Host` header — so DNS rebinding attacks cannot trick the server into treating a remote request as loopback. IPv6 variants (`::1`, `::ffff:127.0.0.1`) are normalized to `127.0.0.1`.
- **Insecure LAN opt-in:** `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1` disables the token requirement for non-loopback requests. Intended for trusted-network development only; never set it on a public network.

See [configuration.md](configuration.md#environment-variables) for the full environment-variable reference (ports, bind host, auth token, app-data paths).

## CORS allowlist

The server accepts cross-origin requests from two origins only:

- `http://127.0.0.1:*` (any port)
- `http://tauri.localhost` (the Tauri WebView's fixed origin)

Bare `http://localhost` was narrowed out in PR #637 because it bypassed DNS-rebinding hardening. Hocuspocus WebSocket origin validation uses the same allowlist.

## Auth tokens

- **Generation:** 32 random bytes, base64url-encoded.
- **Storage:** `{APP_DATA_DIR}/tandem_auth_token`, mode `0o600`, written atomically (temp file + rename).
- **Comparison:** both sides SHA-256-hashed, then compared with `crypto.timingSafeEqual` to prevent length-oracle attacks.
- **Rotation:** `tandem rotate-token` generates a new token, posts it to `/api/rotate-token`, and updates MCP client configs. The old token remains valid for a 60-second grace window so connected clients can pick up the new value without a disconnect.

## Privacy

- **Notes are user-private (ADR-027).** Annotations with `type: "note"` are stripped from every MCP tool response and never appear in channel events. The AI cannot read them.
- **What the AI sees:** the document content you open, selections you hold (subject to dwell-time gating), annotations you create or that the AI itself creates, and chat messages sent through the Tandem sidebar.
- **What the AI doesn't see:** files you haven't opened, notes (per above), the auth token, and any environment variables that aren't surfaced through MCP tools.

## No telemetry

Tandem ships with **no usage analytics, no crash reporting, no telemetry beacons**. The codebase contains no Sentry, PostHog, Amplitude, or equivalent integrations. The outbound traffic Tandem initiates is to your configured AI client over loopback (or LAN, if you opted in) and — for the desktop app — periodic update checks against the public release host. Update checks carry no analytics.

## Licensing activation (v1.0)

This describes the paid model arriving at v1.0; during the public beta Tandem is free and unlicensed. See [ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license).

- **Running the app validates a license offline.** At v1.0 the app verifies an Ed25519-signed license file locally against a public key embedded in the build. *Running needs no network call* — activation works air-gapped, and the signature is checked on your own machine. This is a separate key from the Ed25519/minisign key used to sign release artifacts.
- **The license file binds a copy to its buyer.** It carries the buyer's email, an order ID, and an update-window expiry, all covered by the signature.
- **Updates authenticate entitlement, and log only to authorize.** The licensed build's updater authenticates against a small license-checked endpoint that serves new builds only while the license's update window is current. That endpoint logs only what it needs to authorize the download (ideally a signed entitlement check rather than transmitting the raw key), so the no-telemetry posture holds. An expired-window license still *runs* offline; it simply stops receiving new builds.

## Reporting security issues

Email security reports to the maintainer listed in [package.json](../package.json) or open a private security advisory at <https://github.com/bloknayrb/tandem/security/advisories/new>. Please don't file public issues for vulnerabilities.
