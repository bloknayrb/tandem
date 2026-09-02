# Area: Security

**Raw:** [`../raw/findings-security.txt`](../raw/findings-security.txt) (Fable, resumed, 3 calls),
[`../raw/gapfill-A.txt`](../raw/gapfill-A.txt) (Sonnet, leads at named paths) and
[`../raw/gapfill-F.txt`](../raw/gapfill-F.txt) (Opus, live probes on the scratch server 4918/4919).
**Manifest:** [`../raw/manifests/security.md`](../raw/manifests/security.md).
**Tracks:** [F](../tracks/F-push-paths-and-cli.md) for the relay stub; [K](../tracks/K-tests-and-lows.md) for the Lows.
**Spot-check:** the two top Lows and the relay stub read by the orchestrator; probes re-read from the
gap-fill log, not re-run. No High in this area; the three refutations are in [refuted.md](../refuted.md).

The `security-reviewer` agent should be spawned on every track that touches `src/server/mcp/`,
`src/server/integrations/`, `src/server/launcher/` or `src-tauri/`.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| M | `src/server/mcp/channel-routes.ts:150-162` | The permission verdict is deleted from `pendingPermissions` and never delivered ("push via SSE in follow-up"); `docs/mcp-tools.md:1334-1367` documents a relay that does not exist. | [read] | Source-confirmed | [#1794](https://github.com/bloknayrb/tandem/issues/1794) |
| L | `channel-routes.ts:79-98` | Channel-error `message` logged raw: ESC/BEL/CR/LF and a full OSC-0 sequence reach stderr; the `UNKNOWN_CODE` branch logs before the 400. Route is in `NON_LOOPBACK_ALLOWED`, so LAN-reachable in LAN mode. | [ran] | Agent-ran (probe) | [#1822](https://github.com/bloknayrb/tandem/issues/1822) |
| L | `src/server/yjs/provider.ts:101-107` | No `maxPayload` on Hocuspocus. Measured: an unauthenticated 90 MiB frame moved RSS 179→331 MB; 120 MiB closes 1009. Binds 127.0.0.1 always. `wake-socket.ts:172` caps its own at 1024. | [ran] | Agent-ran (`experiments/server-probes/wsprobe.mjs`) | [#1822](https://github.com/bloknayrb/tandem/issues/1822) |
| L | `src/server/mcp/server.ts:737` | SDK app (`express.json` 100 kB) mounted at root before the `/api` large-body parser; JSON >100 kB to `/mcp` returns an HTML stack trace with the install path. | [read] | Source-confirmed | [#1822](https://github.com/bloknayrb/tandem/issues/1822) |
| L | `src/server/launcher/supervisor.ts:723-739`, `:825` | `resolveCwd` uses `resolveSafeCwd` without `homeConfines`, so an integrations-file `workingDirectory` (`schema.ts:127`) bypasses the launcher route's confinement; spawn env is `process.env`, so `TANDEM_AUTH_TOKEN` and `SENTRY_DSN` reach the launched Claude's subprocess tree. | [read] | Source-confirmed | [#1822](https://github.com/bloknayrb/tandem/issues/1822) |
| L | `src-tauri/src/keychain.rs:54-62` | `keychain_get` returns plaintext to the WebView (XSS amplifier; no XSS found). Moot while #1761 makes the keychain a mock. | [read] | Agent-reported | [#1822](https://github.com/bloknayrb/tandem/issues/1822) |
| L | `src-tauri/src/sidecar.rs:426-467` | Sidecar spawned without `NODE_ENV=production`; Express default error page includes the stack. | [read] | Agent-reported | [#1822](https://github.com/bloknayrb/tandem/issues/1822) |
| L | `src/server/server.ts:824-834` | Traversal-shaped static paths return the SPA `index.html` (phantom 200s for status-only scanners). The traversal claim itself is refuted. | [ran] | Reproduced (probe) | [#1822](https://github.com/bloknayrb/tandem/issues/1822) |
| L | `/api/license/status` while dark | Returns `status: "licensed"` next to `gateActive: false`; `licenseInstalled` boolean reaches LAN in LAN mode. | [ran] | Agent-ran (probe) | [#1822](https://github.com/bloknayrb/tandem/issues/1822) |
| L | `src/server/annotations/store.ts:139-146` | Lock liveness is `kill(pid, 0)`; `startedAtMs` written but never compared, so PID reuse after reboot forces read-only. | [read] | Agent-reported | [#1823](https://github.com/bloknayrb/tandem/issues/1823) |

## Restated, not new

`POST /api/open` with an arbitrary absolute `.md` outside the repo and no Origin → 200
`readOnly: false`; the extension allowlist is the only filter. That is #1666, open and Bryan's
decision; the probe just confirmed it is still the case.

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

`docs/security.md` 50 MB body claim vs the 100 kB SDK parser; `supervisor.ts:1537-1542`
"hand-edit only" docblock wrong; the "any 127.0.0.1:* page is trusted" assumption is unstated;
`security.md:33` token file not atomic; `:163` env-var claim false for auto-launched sessions;
`:170` scrub claim vs Sentry frames; `:178` "re-checked per request" vs per-connection
`onAuthenticate`.

## Verified fine (live-probed)

Six-route one-layer inventory exact; CORS deny-by-absence including SSE; Host allowlist; `/mcp`
unknown session → 404 `-32001`, never 503; auth compare timing-safe; git history clean of secrets;
#1320 simple-request CSRF fix live (`text/plain` POST `/api/save` with no Origin → 403;
`Origin: http://localhost:5173` → 403, deliberate per #1307); `/api/mode/release` origin matrix
(403 for localhost/no-Origin/evil, 200 for 127.0.0.1).
