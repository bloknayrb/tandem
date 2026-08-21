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

- **[#1420](https://github.com/bloknayrb/tandem/issues/1420) — link-handling escapes: browser build closed, DESKTOP HALF UNVERIFIED.** The finding had three parts. **Image sources closed by #1497:** paste and file-open (`.md` via `mdast-ydoc.ts`, `.docx` via `docx-html.ts`) share one allowlist (`src/shared/image-src-safety.ts`), and an `img-src 'self' data: blob:` CSP (`index.html`, matching the pre-existing Tauri CSP) blocks any surviving cross-host image fetch across all three build targets. **Click-navigation closed by #1417:** the mixed-separator normalisation in `rejectUnsafeWindowsPrefix` makes `resolveRelativeLink` refuse `/\evil.com/x.md` and `\/evil.com/x.md`. **The render and middle-click halves closed by the #1420 fix**, with the qualification below:

  - **Render.** The `isAllowedUri` union gained its first NARROWING term, `isRenderableLinkHref` (`src/client/editor/utils/url-safety.ts`). `defaultValidate(url) || isSchemelessPathHref(url)` could only ever widen — `defaultValidate` accepts a leading `/` via its `[^a-z]` alternative without looking at what follows — so every backslash-authority spelling rendered as a live link. The veto refuses leading whitespace, C0 controls anywhere, `/\…` / `\/…` / `\\…` / `\\?\…`, and — because a scheme moves the authority past index 0, where `rejectUnsafeWindowsPrefix` is anchored — any `http:`/`https:`/`ftp:` href in a spelling `isSafeExternalHref` does not recognise (`http:/\evil.com/x`, `https:/evil.com/x`). **The leading-whitespace clause is the load-bearing one and was nearly missed:** `rejectUnsafeWindowsPrefix` is anchored at index 0, so a single leading space walks past it while the browser's URL parser strips it and resolves cross-host — and remark preserves that space inside a pointy-bracket destination (`[x](< /\evil.com/x.md>)`) while `mdast-ydoc.ts` writes `href: node.url` verbatim, so **file open**, not paste, is the delivery path. The render corpus in `tests/client/link-target-internal.test.ts` is therefore generated as prefix × authority and filtered by `new URL().origin`, not hand-listed; a hand-list of the reported spellings went green with the space bypass wide open.
  - **Middle-click.** `Editor.svelte` now registers `onauxclick` alongside `onclick`, both routed through one `interceptAnchorGesture`. Middle button only (2/3/4 are the context menu and cancelable history navigations); no modifier filtering.
  - **UNVERIFIED, and the reason this entry does not read "closed" unqualified: the desktop build.** Whether `preventDefault()` on `auxclick` suppresses the new-window request in **WebView2** is untested — and this repo already documents the adjacent failure: the #1343 comment in `editor-extensions.ts` records that WebView2 treats a `_blank` anchor as a new-window request *in its own right*, that no `on_new_window` handler is registered, and that it reaches the OS regardless of `preventDefault`. #1343 was fixed by removing the *attribute*, not by making `preventDefault` work. **WKWebView** (macOS) and **WebKitGTK** (Linux, where middle-click in a contenteditable is claimed by primary-selection paste) are equally untested; an engine that fires no `auxclick` at all never runs the interceptor. E2E is chromium-only, so nothing in the suite will ever contradict this. **What holds on every engine regardless** is the render veto: no href that resolves off-origin reaches the DOM as a live link, except spellings `isSafeExternalHref` itself sanctions. That bound is what the earlier wording got wrong — it said such an engine "leaks only a double-open", which is true only for hrefs that keep `target="_blank"`. `LinkWithHoverTitle` strips `_blank` from anything `isSafeExternalHref` refuses, and a live anchor without `_blank` does not open a second tab: it **navigates the editor frame**, taking the session with it — the #1343 shape this codebase already treats as real. So the honest statement of what an engine with a failing `preventDefault` still leaks is: (i) a second tab for `//example.com/x`, `https://…` and the other `_blank`-bearing external hrefs — a genuine annoyance only; and (ii) a frame navigation for any live anchor lacking `_blank`, which after this fix means same-origin relative paths **and the un-subtracted scheme class in #1537 below**, not the reported cross-host class. The `http:/\evil.com/x` family that would otherwise have sat in (ii) is now blanked at render (clause 3 of the veto). Closing the desktop half needs a Windows smoke, or `on_new_window` (deliberately out of scope here: the window is declared in `tauri.conf.json`, not a Rust `WebviewWindowBuilder`, so it needs three platform-specific `with_webview` implementations, and `openHref` depends on `window.open` reaching the system browser).
  - **What Chromium actually does, measured, because the obvious claim is wrong.** Middle-click navigation is *already* suppressed inside a `contenteditable`, so the bypass does **not** reproduce in a normally-editable document in the browser build. It reproduces in the **read-only** editor — View Changelog, upgrade-opens-`CHANGELOG.md`, `upload://` files, any `POST /api/open {readOnly:true}` — which is also the surface most likely to hold externally-authored content. The `auxclick` EVENT fires in both cases; only the default action differs. `tests/e2e/relative-links.spec.ts` covers the read-only case specifically, and it is the only row that proves `preventDefault()` suppresses anything.

  **Residue, all deliberate and none of it reaching a destination the click gate refuses:**

  - The veto is a **prefix-class** veto, not a render/click unification — impossible here, since `resolveRelativeLink` needs `currentFilePath`, which the mark renderer does not have. `../../../../..///evil.com/share/x.md` still renders live and is still refused on click.
  - **`//` is a fourth cross-host spelling that the veto deliberately ACCEPTS.** The sentence "it blanks exactly the prefixes `resolveRelativeLink` refuses" is true only because of that carve-out. It stays live because it is in `SAFE_EXTERNAL_PREFIXES` and `openHref` hands it to `window.open` like any `https://` URL — a declared external link, not a relative-looking disguise. Its whitespace-prefixed variants are *not* carved out: `isSafeExternalHref` does not trim, so those are disguises and are blanked.
  - **Surfaces with no `MouseEvent` to intercept.** For the class this finding reported they now reach only same-origin or allowlisted-external hrefs — but see #1537 immediately below, which is reachable from exactly these: the **native browser context menu**'s "Open link in new tab" (never present in Tauri, where `detect.ts` claims every link and `install.ts` preventDefaults; always present in the browser build, where `install.ts` returns before attaching — note a blanked `href=""` anchor still matches `a[href]`, so Tauri still claims it), the **keyboard context-menu key / Shift+F10** reaching that same menu, and **dragging a live anchor out of the editor**, whose drag payload is the *resolved absolute* URL.
  - **[#1537](https://github.com/bloknayrb/tandem/issues/1537) — hyphenated schemes bypass Tiptap's allowlist entirely, and this veto does not subtract them.** DOMPurify's `IS_ALLOWED_URI` fallback alternative matches the hyphen, so `defaultValidate("ms-msdt:/id")` returns a match, the `||` short-circuits, and the anchor renders live with the href **verbatim**. Measured live today: `ms-msdt:/id` (Follina, CVE-2022-30190), `ms-appinstaller:?source=…` (CVE-2021-43890), `search-ms:crumb=location:\\evil.com\share`, `ms-officecmd:x`, `view-source:http://evil`, `itms-services://?url=http://evil`, plus Tiptap-allowlisted-but-not-Tandem-allowlisted `tel:`/`sms:`/`callto:`/`cid:`/`xmpp:`/`ftps:`. The `search-ms:` spelling is an NTLM/WebDAV-share vector reaching the OS from a right-click "Open link in new tab" — the same class `rejectUnsafeWindowsPrefix` exists to prevent. Delivery is a crafted `.md`/`.docx`; `mdast-ydoc.ts` writes `href: node.url` verbatim. **Deliberately not closed in the #1420 fix:** closing it means moving to an allowlist posture, which would also stop rendering `tel:`/`sms:`/`xmpp:`/`ftps:` — a behaviour change deserving its own review rather than being bundled into a middle-click fix. It is pre-existing and is not widened by #1420 (a narrowing term can only subtract).
  - **Bidi overrides (U+202A–U+202E) are not covered by either character set.** `LinkWithHoverTitle` mirrors the raw href into `title`, so a tooltip can read as a different host than the anchor resolves to. Navigation is unaffected — those resolve same-origin, percent-encoded — so this is **tooltip spoofing only**, and widening the character set was deliberately left out of the #1420 fix.
  - **A behaviour delta, not a security one:** a Word hyperlink to `\\fileserver\docs\spec.docx` used to render live and produce an explicit "Blocked a link pointing outside this document's folder" notification on click. It now renders as plain text with no href, so the refusal is **silent** — the same silent-no-op shape the click-path design deliberately avoids. Outcome is better; the explanation is what is lost.
  - **Unchanged by design (image half):** the content allowlist still treats a general `https://` image URL as safe — a deferred product decision, not a gap, since stripping them would break every document with a hosted badge. The `img-src` CSP is the only control blocking the fetch today, so loosening it re-exposes this, and `'self'` still permits a document to GET the app's own loopback origin (reads are scrubbed and non-GET is refused by `enforceLoopbackMutation`, so this buys nothing today; it is the residue to look at first if that changes).

- **Boot-sweep / `setup --apply` config race (found in review of the npx-convergence self-repair, #1501).** The boot sweep's Claude Desktop npx→absolute-path convergence and a concurrently-run `tandem setup --apply` (or `tandem rotate-token`) both read-modify-`atomicWrite` the same config file with no lock between them — the sweep is gated only by the unrelated annotation-store lock, which a separate CLI process never touches. Scope is a **lost update** (last writer's read-modify-write wins, silently reverting the other's change), not corruption or privilege escalation — each individual `atomicWrite` is still atomic, and anyone who can already write the config file could add their own runnable MCP entry directly without needing this race at all. Realistic trigger: a user (or a setup script) runs the wizard or the CLI at roughly the same moment Tandem's server boots. No fix landed for this pass; either add real cross-process locking around every `apply.ts` config writer (modeled on the existing annotation-store lockfile), or accept it as a documented, bounded risk.

Still open from the v0.21.0 security gate, whose RC re-run failed on 2026-08-05 with two HIGH:

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

**#1417 is closed** (ordering fixed at seven sites; both hand-rolled `isUncPath` copies rewritten as an allowlist of `\\?\C:\…` rather than an enumeration of bad forms). Two things about it are worth carrying forward rather than forgetting:

- **The class is "syscall before verdict", and a static check cannot see it.** `tests/shared/unc-check-duplication.test.ts` catches duplicated *predicates*; ordering is pinned per-site in `tests/server/unc-guard-ordering.test.ts`, `tests/server/launcher/supervisor.test.ts`, `tests/cli/win-path-guard.test.ts` and the reparse-point block in `tests/cli/uninstall-scrub.test.ts`. A new site needs a new ordering test — nothing will fail without one.
- **Those tests assert the syscall, not the return value, and that is not stylistic.** A UNC path to a host that does not answer already returned `null`/`false`/`[]` before the fix, so a return-value assertion passes against the vulnerable code. The first attempt at one of these tests was written that way and the mutant survived.

## Reporting security issues

Email security reports to the address in [package.json](../package.json)'s `bugs.email` field, or open a private security advisory at <https://github.com/bloknayrb/tandem/security/advisories/new>. Please don't file public issues for vulnerabilities.

**Licensing and activation problems go to the same address, not to the issue tracker.** A license key contains your name and email address, and the natural instinct when activation fails is to paste it somewhere for help. Don't paste it in a public issue.
