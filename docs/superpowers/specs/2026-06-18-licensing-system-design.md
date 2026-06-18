# Licensing System — Design Spec (v2, agent-review incorporated)

**Date:** 2026-06-18
**Issue:** #1116 (engineering tracker) — Wave 5L / v0.16.0
**ADR:** [ADR-040](../../decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license) §3/§4/§6 (Accepted)
**Branch / worktree:** `feat/1116-licensing-gate` @ `C:/Users/blokn/GitHub/tandem-licensing`
**Review:** revised after 3 adversarial agent reviews (security, annotation-model, adversarial-design) + Tauri/Hocuspocus capability verification. Findings + dispositions in §12.

## Goal

Add the on-device licensing *system* on top of the already-shipped verification primitives (#1133): a 14-day trial, a license gate that ships **dark behind a build flag**, license activation surfaces, beta-tester grandfathering, and a license-checked auto-update endpoint. One public build; a valid offline-signed license is the capture vector.

## What already exists (do NOT rebuild — #1133)

- `src/server/license/verifier.ts` — `verifyLicense(blob)` (offline Ed25519 verify vs embedded public key, expiry check via epoch compare, 10KB input bound) + `canonicalize()`.
- `src/server/license/license-types.ts` — `LicenseMetadata` (`id, name, email, type: "personal"|"commercial"|"grandfathered", createdAt, expiresAt, version`) + `SignedLicense`.
- `src/server/license/public-key.ts` — embedded `TANDEM_PUBLIC_KEY` (Ed25519 PEM).
- `src/server/license/grandfather-list.ts` — `GRANDFATHER_EMAILS` + `isGrandfathered(email)` (lowercase/trim).
- `src/server/license/webhook.ts` — Polar/Paddle issuance webhook (`handleLicenseWebhook`); sets `type: "grandfathered"` + `expiresAt: null` for grandfathered emails, `personal` + 1-year window otherwise. Wired at `POST /webhooks/license` in `server.ts` (auth-exempt, HMAC-verified, Host-check intentionally omitted).
- `scripts/generate-keys.ts`, `scripts/sign-license.ts` — offline key-gen + manual signing.
- Tests: `tests/server/license.test.ts`, `tests/server/webhook.test.ts`.

## Decisions (from Bryan, 2026-06-18)

1. **Trial length: 14 days** (under the BUSL §5 30-day legal eval ceiling).
2. **Grandfathering: issued signed licenses** — Bryan signs free `grandfathered` licenses and emails them; testers activate like paid users. No new on-device grandfather code path.
3. **Trial-expiry behavior: read-only data escape hatch** — gate the product value, but always allow open/read/export of local files.
4. **Scope: L2 + L3 + L4** — trial gate, activation UX, license-checked update endpoint, grandfathering. All dark behind a build flag.

---

## 1. State model (the spine)

A new module `src/server/license/license-state.ts` is the single source of truth. It **re-resolves on every read** — there is deliberately **no long-lived cache** (a cache caused the two-writer staleness + mid-session-expiry bugs the reviews found; see §12 H3/H5). Resolution is cheap: an epoch compare plus, at most, one Ed25519 verify of the on-disk blob, memoized by blob SHA-256 so unchanged bytes aren't re-verified.

| State | Condition (gate active) | Behavior |
|---|---|---|
| **`trial`** | No valid license; `now < firstRunAt + 14d` | Full functionality + "N days left" banner |
| **`licensed`** | A valid signed license present (`personal`/`commercial`/`grandfathered`) | Full functionality, forever. `expiresAt` governs only the **update window**, never the right to run |
| **`restricted`** | No valid license; trial expired | **Read-only escape hatch** (§4) |

**The gate never halts boot.** `initLicenseState()` runs unconditionally in `main()` **before the transport branch** (so it applies in HTTP *and* raw-stdio mode) and before server bind. The server always starts so users can open and export files.

**Gate dark (build flag off — v0.16.0):** `resolveLicenseState()` short-circuits to `{ gateActive:false, status:"licensed", updateWindowCurrent:true }`. No trial enforced, no tool gated, no connection marked read-only, no wall. Behavior byte-identical to today. `trial.json` is **only written when the gate is enabled** (see §3) so the flag-flip starts a clean 14-day trial.

### Module surface (isolation + testability)

```ts
// src/server/license/license-state.ts
export type LicenseStatus = "trial" | "licensed" | "restricted";

export interface LicenseState {
  gateActive: boolean;
  status: LicenseStatus;
  trial?: { firstRunAt: string; expiresAt: string; daysRemaining: number };
  license?: LicenseMetadata;
  updateWindowCurrent: boolean;     // license && (expiresAt===null || epoch(expiresAt) > now)
  licenseId?: string;               // opaque UUID for the updater; never PII
}

// Pure resolver — appData dir, clock, and gate flag injected for tests. Re-reads each call.
export function resolveLicenseState(deps: {
  appDataDir: string; now: () => number; gateEnabled: boolean;
}): LicenseState;

export async function ensureTrialStarted(appDataDir: string, now: () => number, gateEnabled: boolean): Promise<void>;
export async function activateLicense(appDataDir: string, blob: string): Promise<LicenseState>; // verify (sig+expiry+known version) then atomic-persist
export function isRestricted(): boolean;   // convenience for the gate — re-resolves
```

Trial math is **epoch arithmetic only** (`expiresAt = epoch(firstRunAt) + 14*86_400_000`; `now < expiresAt`) — never `setDate`/calendar add (avoids DST edge; mirrors `verifier.ts`). `activateLicense` and `resolveLicenseState` **assert a known `metadata.version` major** and reject unknown majors with a clear error (makes the signed `version` field load-bearing — §12 L3).

## 2. Build flag — ships dark

Mirror the `__APP_VERSION__` tsup `define` pattern:

- `tsup.config.ts`: `const LICENSE_GATE_ENABLED = false;` near the top; inject `__LICENSE_GATE_ENABLED__: JSON.stringify(LICENSE_GATE_ENABLED)` into the `define` block of **every bundle whose tree can transitively import `license-state.ts`**. Today that's `server` + `cli` (the `channel` and `monitor` bundles use `selfContained` with no `define` and don't import license code — verified; if that ever changes the define must be added there too). v1.0 flips the single const.
- `license-state.ts` reads it with a dev/test fallback **plus a ship-dark guard**:
  ```ts
  declare const __LICENSE_GATE_ENABLED__: boolean;
  export const GATE_ENABLED =
    typeof __LICENSE_GATE_ENABLED__ !== "undefined"
      ? __LICENSE_GATE_ENABLED__
      : process.env.TANDEM_LICENSE_GATE === "1"; // tsx dev / vitest only
  ```
  **Guard:** at module load, if running as the bundled sidecar (`process.env.TANDEM_TAURI_SIDECAR === "1"`) and `typeof __LICENSE_GATE_ENABLED__ === "undefined"`, log a loud warning — a missing define in a production bundle would silently fall back to the env var and ship dark regardless of the const (§12 H3).
- **Client & Rust need no build flag.** Both derive from `GET /api/license/status` at runtime (the server is the authority — ADR-040 §6).

## 3. Storage (appData, shared by sidecar + CLI)

Under `resolveAppDataDir()` (`src/server/platform.ts`), written via `atomicWrite` (`src/server/file-io/index.ts`).

- `{APP_DATA}/trial.json` — `{ version: 1, firstRunAt: "<ISO8601>" }`. Written by `ensureTrialStarted()` **only when `GATE_ENABLED`**, on first boot if absent, **before server bind / welcome.md open** (§12 H6). Use an exclusive create (`flag: "wx"`) then read-back-if-exists so concurrent stdio+HTTP first-boots don't pick divergent `firstRunAt` (last-rename-wins is otherwise nondeterministic). **Deliberately soft** (ADR-040 §3): a user can delete/edit it *or set the system clock back*; the hard gate is the signed license, not the clock. No anti-rollback — documented as intentional.
- `{APP_DATA}/license.json` — `{ version: 1, blob: "<base64 signed license>" }`. Raw blob stored, **re-verified on read** (never a cached valid-bit). A public-key-verifiable artifact, not a secret.

## 4. The gate — restricted-mode mechanics (TWO server-hard surfaces)

Restricted = trial expired, no license, gate active. The key correction from review: **browser edits and client-authored annotations flow over the Hocuspocus WebSocket into the Y.Doc, not through MCP tools or `/api` routes** — so an MCP-layer gate alone is client-trust (§12 C1). Enforcement is therefore split across the two surfaces that actually carry mutations, both **server-side**:

### Surface A — Hocuspocus connection read-only (browser edits + annotations)
`onAuthenticate` in `src/server/yjs/provider.ts` (already used for the generation gate) sets `connectionConfig.readOnly = true` when `resolveLicenseState().status === "restricted"` **for document rooms only** (`documentName !== CTRL_ROOM`). The server then rejects all Y.Doc updates from that connection — content edits, highlights, notes, comments, accept/dismiss — with **no CRDT revert** (updates are simply not applied). CTRL_ROOM stays writable so **chat, mode toggle, and awareness keep working** (the escape hatch should feel alive, and chat is not the monetized moat — §12 M10).
- **Mid-session expiry:** `readOnly` is fixed at connection time. On transition to `restricted`, the client (polling `GET /api/license/status`) sets `editable=false` immediately and triggers a provider reconnect (reuse `scheduleRebuild` in `yjsSync.svelte.ts`, the generation-gate path) so the server applies `readOnly`. Absent a reconnect, the gate applies on next launch — an accepted soft timing edge, documented.
- **Server-internal writes are unaffected** (tutorial injection via `withInternal`, session restore, force-reload) — `readOnly` is per *client connection*, not a doc-wide lock (§12 N13).

### Surface B — MCP tool + `/api` route gate (Claude's paths)
A **registration-time wrapper** `gatedTool(name, handler)` (not manual per-handler insertion — §12 N12) wraps Claude's mutation tools so a forgotten tool can't silently ship ungated. It re-resolves state per dispatch and returns `mcpError("LICENSE_REQUIRED", …)` when restricted, **before** any `withMcp`/`withTypingPresence` runs (so no half-tagged transaction and no "Claude is working" presence flicker — §12 N12, annotation-Finding-3). The gate is a **pure synchronous pre-check: zero Y.Doc access, never wraps the origin helper**.
- **Gated MCP tools:** `tandem_edit`, `tandem_comment`, `tandem_suggest` (deprecated stub), `tandem_highlight` (deprecated stub), `tandem_flag` (deprecated stub), `tandem_applyChanges`, `tandem_appendContent`, `tandem_scratchpad`, `tandem_editAnnotation`, `tandem_annotationReply`, `tandem_removeAnnotation`. The MCP side must mirror the gated `/api` routes below — an MCP write goes straight to the server Y.Doc and bypasses Surface A, so `tandem_removeAnnotation`/`tandem_scratchpad` are gated to match `/api/remove-annotation`//`/api/scratchpad`. The deprecated stubs are gated for consistency (defence against a future un-stub shipping ungated).
- **Gated `/api` routes** (HTTP, not covered by Surface A): `POST /api/apply-changes`, `POST /api/annotation-reply`, `POST /api/remove-annotation`, `POST /api/document/reload`, `POST /api/docx-conflict/resolve`, `POST /api/backups/restore`, scratchpad/append content routes — audited as one partition over **both** MCP tools and `/api` routes (§12 C2).
- **Allowed (escape hatch + non-moat):** read tools (`tandem_getTextContent`, `tandem_getOutline`, `tandem_getAnnotations`, `tandem_listDocuments`, `tandem_resolveRange`), document **open**, **`tandem_save`/Save-As/export** (safe: Surface A guarantees in-memory content equals disk in restricted mode, so Save-As only ever exports unchanged content — closes §12 H2), `GET` routes, chat (`tandem_reply`, `/api/channel-reply`), `tandem_resolveAnnotation` (accept/dismiss of *existing* work — triage of your own doc).

### Client (UX layer on top of the real boundary)
Restricted: editor `editable=false`, an **activation wall** overlay (paste-license field). Trial: a countdown banner. Both driven by `GET /api/license/status`. `data-testid`s: `license-settings-section`, `license-status-pill`, `license-activate-input`, `license-activate-submit`, `license-activate-error`, `license-wall`, `license-trial-banner`, `license-trial-days`.

**First-run / upgrade:** trial starts at first boot of a gate-active build (clean 14-day trial at the v1.0 flip, since dark builds don't write `trial.json`). Welcome.md/CHANGELOG.md auto-open (already read-only) compose fine with restricted mode; tutorial annotations (server-internal) are not suppressed (§12 N13).

## 5. Activation surfaces

### HTTP routes (centralized in `src/shared/api-paths.ts`)
- `POST /api/license/activate` — body `{ blob }`; `verifyLicense` + known-version check, atomic-persist `license.json`, return new `LicenseState`. **Mutating route:** at handler top, **`assertOriginAllowlisted(req,res,API_LICENSE_ACTIVATE)` then `assertLoopbackForMutation(req,res)`** — same order as `handleRename` (§12 M2) — before reading the body.
- `GET /api/license/status` — **loopback callers** (raw `isLoopback(req.socket.remoteAddress)` check, *not* the mutation helper — §12 M1) get the full `LicenseState` incl. licensee name. **Non-loopback** (LAN/deprecated-browser) callers get a **PII-scrubbed** subset `{ gateActive, status, daysRemaining, updateWindowCurrent }` (no name/email/licenseId) so the wall/banner + `editable` derivation still have input (§12 M9). The Rust updater (loopback) reads `licenseId` + `updateWindowCurrent`.

### GUI (Svelte client)
Settings → License section (status, activate via paste/file, "Licensed to {name}", update-window state) + the restricted-mode wall reusing the same activate component.

### CLI (`src/cli/index.ts` dispatch + new modules)
- `tandem activate <license-or-path>` → `src/cli/activate.ts`: accepts raw blob or file path, verifies, persists. **If a sidecar is running** (health probe), POST `/api/license/activate` so the live GUI updates immediately; **else** write `license.json` directly. Both safe via `atomicWrite`; the running server re-resolves per read (§1) so it never goes stale (§12 H5).
- `tandem license` → `src/cli/license.ts`: prints status. Follows the existing dynamic-import dispatch shape (`setup`/`doctor`/`rotate-token`).

## 6. Grandfathering (issued signed licenses)

No new on-device path — reuses #1133. Deliverables:
- **Runbook** (`docs/licensing-operations.md`): collect beta emails → add to `GRANDFATHER_EMAILS` → batch-issue with `scripts/sign-license.ts --type grandfathered` (or the webhook branch) → email blobs. Log only the license `id`, never email (§12 L1).
- **Tests:** a `grandfathered` license never restricts and never expires the run-right (`expiresAt:null` ⇒ `updateWindowCurrent` forever); `isGrandfathered` normalization round-trip.

## 7. L3 — license-checked update endpoint

**Endpoint tech: Cloudflare Worker** (self-hosted, low lock-in, free tier, pairs with the webhook).

**Tauri mechanism — VERIFIED** (Tauri v2 docs via Context7; the Explore agent's "not supported" claim was wrong — §12 M8): use `app.updater_builder().endpoints(vec![url])?...` (runtime endpoints), URL template vars `{{target}}`/`{{arch}}`/`{{current_version}}` (double-escaped inside `format!`), and `.header("X-Tandem-License-Id", lid)` for the opaque id. Switch **both** `check_for_update` (`lib.rs:~2942`) and the `install_update` path (`lib.rs:~3014`) from `app.updater()` to the same `updater_builder()` so check/install agree on source.

**Flow (PII-free):**
1. **Issued-license store (KV):** the webhook, **after** HMAC-verify + signing and **only when `!isTestPurchase`** (§12 M3), writes `KV[licenseId] = { updateWindowEnd, status, version }` (key = UUID, unguessable). KV failure is **non-fatal** to license delivery (the blob is source of truth) but **logged**.
2. **Worker (`infra/license-update-worker/`):** `GET /latest.json` with `X-Tandem-License-Id` header → look up in KV; entitled & `updateWindowEnd ≥ now` → serve the signed `latest.json` (minisign signature unchanged, still client-verified by the Tauri `pubkey`); else → **no-update**. Unknown-id and expired-window return a **byte-identical** no-update response (no existence oracle — §12 M4). Logs only `{ result, ts }` — **not** `lid` (per-customer update-check logs would be telemetry — §12 M4).
3. **Rust updater:** before check, `GET /api/license/status` (loopback). If `gateActive && licenseId && updateWindowCurrent` → point `updater_builder` at the Worker with the `lid` header; else → today's public GitHub `latest.json`. Expired window ⇒ no new updates offered, **app keeps running**.

**Gate-dark safety:** flag off ⇒ status reports `gateActive:false` ⇒ updater uses the public GitHub endpoint ⇒ v0.16.0 update behavior identical to today.

**In this worktree:** Worker source + `wrangler.toml` + webhook KV write + Rust wiring + a local mock-KV test harness. **Bryan owns** the Cloudflare deployment (account, KV namespace, custom domain, secrets) — documented, not automated.

## 8. Testing strategy

- **Unit (`license-state.ts`)**, injected appData dir + clock + flag: trial active / boundary (epoch day-14 vs 15) / expired→restricted / valid→licensed / grandfathered never expires / tampered+expired rejected / unknown `version` major rejected / **flag-off ⇒ unrestricted**.
- **Activation:** `activateLicense` verify+persist round-trip; bad blob rejected; status route shape (loopback full vs LAN scrubbed); route security order.
- **Surface A (Hocuspocus):** restricted ⇒ a document-room connection is `readOnly` (write rejected) while CTRL_ROOM chat/awareness still apply; licensed/trial ⇒ writable.
- **Surface B (tool/route gate):** restricted ⇒ gated MCP tools + `/api` routes return `LICENSE_REQUIRED`; read/save/chat/accept-dismiss stay open; the `gatedTool` wrapper covers every listed tool (a registration-coverage test).
- **ADR-027:** a restricted-mode user note (if it ever reaches the server) emits zero channel events.
- **CLI:** `activate`/`license` happy + error; running-server-detected POST vs direct-write.
- **Worker:** entitled→manifest; expired & unknown-id→identical no-update; test order excluded.
- Full suite green with the flag **off** (default) and **on** (`TANDEM_LICENSE_GATE=1`).

## 9. Docs

`README.md`, `docs/security.md`, `docs/positioning.md`, `docs/user-guide.md`/`workflows.md`, `CHANGELOG.md`, new `docs/licensing-operations.md`, and a `CLAUDE.md` Gotchas note (build flag, appData files, the two enforcement surfaces, the gated tool/route list).

## 10. Out of scope / Bryan-owned

Cloudflare deployment, MoR (Polar/Paddle) account, real private signing key, pricing, and the v1.0 flag-flip (gated by the commercial-readiness exit criterion).

## 11. PR decomposition (proposed; granular history)

Each lands behind the dark flag, fully test-covered:
- **PR-A (L2 core):** `license-state.ts` (no cache, epoch math, version check) + build flag + guard + storage + boot wiring (`init`/`ensureTrialStarted` pre-transport) + `GET /api/license/status` (loopback/LAN split) + unit tests.
- **PR-B (Surface A):** Hocuspocus `onAuthenticate` `readOnly` for restricted document rooms + client reconnect-on-transition + tests.
- **PR-C (Surface B):** `gatedTool()` wrapper + MCP tool gating + `/api` route gating + `POST /api/license/activate` + CLI `activate`/`license` + tests.
- **PR-D (client UX):** Settings license section + restricted wall + trial banner + testids + Playwright where it adds signal.
- **PR-E (L4):** grandfather runbook + tests + webhook KV write (`!isTestPurchase`, non-fatal).
- **PR-F (L3):** Worker + `wrangler.toml` + Rust `updater_builder` wiring + mock-KV harness + docs.

(Boundaries confirmed in the implementation plan; small ones may merge.)

## 12. Review findings & dispositions

**Converged CRITICAL — gate boundary (annotation-F1 / security-H1 / design-C1):** browser edits + client annotations bypass the MCP layer (Hocuspocus path; `provider.ts` had no write hook). **Resolved** via Surface A (Hocuspocus `connectionConfig.readOnly`, verified supported) + Surface B (tool/route gate). Restricted mode is now genuinely server-enforced.

**Accepted & incorporated:**
- **H2 (save = write primitive):** closed — Surface A makes in-memory == disk, so Save-As only exports unchanged content.
- **H3/H5 (cache staleness, two-writer):** dropped the cache; re-resolve per read; CLI prefers POST-to-running-server.
- **H3-build (4 bundles) / missing-define ship-dark:** define into all importing bundles + sidecar load-time guard.
- **H4 (stdio):** `init` runs pre-transport; gate enforces on MCP tools in raw stdio; activation via CLI; no status endpoint needed there.
- **H6/M7 (first-run race, DST):** `wx` exclusive create + read-back; epoch math only.
- **M1/M2/M9 (route security):** raw `isLoopback` for status GET; PII-scrubbed LAN status; `assertOriginAllowlisted`→`assertLoopbackForMutation` order for activate.
- **M3/M4 (KV, Worker):** `!isTestPurchase`, non-fatal KV, UUID key; no-oracle response; no `lid` logging.
- **M8 (Tauri):** verified `updater_builder` supports runtime endpoints + template vars + headers.
- **M10/C2 (partition):** gate spans MCP tools **and** `/api` routes; chat explicitly allowed.
- **L1 (webhook PII logs):** log id only; runbook note. **L2 (dark trial.json):** write only when gate enabled. **L3 (version):** enforce known major.
- **N11 (`/api/document/raw`):** GET-only; raw edits go through Hocuspocus (covered by Surface A) — no phantom POST hook. **N12 (chokepoint):** registration-time `gatedTool()` wrapper. **N13 (tutorial/welcome):** server-internal writes unaffected by per-connection readOnly.

**Considered and REJECTED — "allow private notes/highlights in restricted mode" (annotation-reviewer recommendation):** a clean server boundary (Surface A blocks all document-room writes) beats a finer per-`audience` carve-out that would reintroduce client-trust and complexity. Bryan's choice #3 is *data access* (open/read/export), which read-only-everything + export satisfies. "Read-only" means read-only. Chat stays allowed (CTRL_ROOM); export is the escape hatch.
