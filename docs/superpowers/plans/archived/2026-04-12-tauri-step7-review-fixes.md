# Tauri Step 7: Review Fixes + Tauri Origin Support

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all findings from the security, code, and silent-failure reviews of the Tauri desktop app, plus fix the `tauri.localhost` origin rejection discovered during manual testing.

**Architecture:** Fixes span three layers: CI workflow hardening, Rust sidecar lifecycle improvements, and server-side origin validation. Each task is independent — no ordering dependencies between tasks except Task 1 (origin fix) which unblocks manual testing of all other fixes.

**Tech Stack:** Rust (Tauri v2), TypeScript (server), GitHub Actions YAML

---

## File Map

| File | Changes |
|------|---------|
| `src/server/yjs/provider.ts` | Accept `tauri.localhost` in WebSocket origin check |
| `src/server/mcp/api-routes.ts` | Accept `tauri.localhost` in CORS origin regex and Host validation |
| `src/shared/constants.ts` | Add `TAURI_ORIGIN` constant |
| `tests/server/api-middleware.test.ts` | Add tests for `tauri.localhost` origin/host |
| `src-tauri/src/lib.rs` | Kill-before-restart race fix, health poll diagnostics, skip update check when pubkey empty |
| `.github/workflows/tauri-release.yml` | CI hardening: error handling, signing key validation, summary job |

---

### Task 1: Accept `tauri.localhost` Origin in Server

The Tauri WebView sends `Origin: http://tauri.localhost` on all requests. Both the Hocuspocus WebSocket origin check and the Express CORS/Host middleware reject it. This is the blocking issue from manual testing.

**Note:** The `/mcp` routes use the MCP SDK's own `localhostHostValidation()` middleware (via `createMcpExpressApp`), which does NOT need updating. The WebView never calls `/mcp` directly — only Claude Code does, and it sends `Host: localhost`. This fix only needs to cover: `isHostAllowed` (HTTP API), `isLocalhostOrigin` (CORS), and the Hocuspocus `onConnect` (WebSocket).

**Note:** This origin fix only applies in production builds. `cargo tauri dev` uses `http://localhost:5173` (Vite devUrl), so testing requires the packaged app.

**Files:**
- Modify: `src/server/yjs/provider.ts:66-77`
- Modify: `src/server/mcp/api-routes.ts:32-41`
- Modify: `src/shared/constants.ts`
- Test: `tests/server/api-middleware.test.ts`

- [ ] **Step 1: Add constant for allowed Tauri hostname**

In `src/shared/constants.ts`, add:

```ts
/** Tauri WebView origin hostname — must be accepted alongside localhost. */
export const TAURI_HOSTNAME = "tauri.localhost";
```

- [ ] **Step 2: Write failing tests for `tauri.localhost` origin acceptance**

In `tests/server/api-middleware.test.ts`, add new assertions to the existing `isHostAllowed` and `isLocalhostOrigin` describe blocks. The file already tests `evil.localhost` rejection, so only add the new `tauri.localhost` acceptance cases:

```ts
// Add inside the existing "isHostAllowed" describe block:
it("accepts tauri.localhost", () => {
  expect(isHostAllowed("tauri.localhost")).toBe(true);
  expect(isHostAllowed("tauri.localhost:3479")).toBe(true);
});

// Add inside the existing "isLocalhostOrigin" describe block:
it("accepts http://tauri.localhost origins", () => {
  expect(isLocalhostOrigin("http://tauri.localhost")).toBe(true);
  expect(isLocalhostOrigin("http://tauri.localhost:3479")).toBe(true);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose tests/server/api-middleware.test.ts`
Expected: `isHostAllowed accepts tauri.localhost` and `isLocalhostOrigin accepts http://tauri.localhost` FAIL

- [ ] **Step 4: Update `isHostAllowed` to accept `tauri.localhost`**

In `src/server/mcp/api-routes.ts`, change `isHostAllowed`:

```ts
import { TAURI_HOSTNAME } from "../../shared/constants.js";

export function isHostAllowed(host: string | undefined): boolean {
  const reqHost = (host ?? "").split(":")[0];
  return reqHost === "localhost" || reqHost === "127.0.0.1" || reqHost === TAURI_HOSTNAME;
}
```

- [ ] **Step 5: Update `LOCALHOST_ORIGIN_RE` to accept `tauri.localhost`**

In `src/server/mcp/api-routes.ts`, change the regex:

```ts
export const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?$/;
```

- [ ] **Step 6: Update Hocuspocus origin check**

In `src/server/yjs/provider.ts`, change the origin validation in `onConnect`:

```ts
import { TAURI_HOSTNAME } from "../../shared/constants.js";

// Inside onConnect:
if (
  url.hostname !== "localhost" &&
  url.hostname !== "127.0.0.1" &&
  url.hostname !== TAURI_HOSTNAME
) {
```

**CSP note:** No CSP change needed. The existing CSP has `connect-src 'self' http://localhost:3478 http://localhost:3479 ws://localhost:3478`. In the Tauri WebView, `'self'` expands to `http://tauri.localhost` (the document origin). The explicit `http://localhost:3478/3479` and `ws://localhost:3478` entries permit cross-origin requests to the sidecar. Both paths are already covered.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- --reporter=verbose tests/server/api-middleware.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/shared/constants.ts src/server/yjs/provider.ts src/server/mcp/api-routes.ts tests/server/api-middleware.test.ts
git commit -m "fix(tauri): accept tauri.localhost origin in WebSocket and CORS checks"
```

---

### Task 2: CI Hardening — Self-Signed Cert Error Handling

**Files:**
- Modify: `.github/workflows/tauri-release.yml:63-71`

- [ ] **Step 1: Add `$ErrorActionPreference` and null check**

In `.github/workflows/tauri-release.yml`, update the "Create self-signed code signing certificate" step:

```yaml
      - name: Create self-signed code signing certificate
        if: matrix.platform == 'windows-latest'
        shell: pwsh
        run: |
          $ErrorActionPreference = 'Stop'
          $cert = New-SelfSignedCertificate `
            -Type CodeSigningCert `
            -Subject "CN=Tandem Editor, O=Tandem" `
            -CertStoreLocation Cert:\CurrentUser\My `
            -NotAfter (Get-Date).AddYears(5)
          if (-not $cert) { throw "Failed to create code signing certificate" }
          echo "CERT_THUMBPRINT=$($cert.Thumbprint)" >> $env:GITHUB_ENV
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/tauri-release.yml
git commit -m "ci(tauri): add error handling to self-signed cert generation"
```

---

### Task 3: CI Hardening — Validate Updater Signing Key

**Files:**
- Modify: `.github/workflows/tauri-release.yml`

- [ ] **Step 1: Add signing key validation step before tauri-action**

Insert before the `tauri-apps/tauri-action` step:

```yaml
      - name: Validate updater signing key
        if: env.TAURI_SIGNING_PRIVATE_KEY == ''
        run: |
          echo "::error::TAURI_SIGNING_PRIVATE_KEY secret is not set. Updater artifacts will not be signed."
          exit 1
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/tauri-release.yml
git commit -m "ci(tauri): fail build when updater signing key is missing"
```

---

### Task 4: CI Hardening — Summary Job for Partial Failures

**Files:**
- Modify: `.github/workflows/tauri-release.yml`

- [ ] **Step 1: Add release-check job after build-tauri**

Append after the `build-tauri` job:

```yaml
  release-check:
    needs: build-tauri
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Check all builds succeeded
        if: needs.build-tauri.result != 'success'
        run: |
          echo "::error::Some platform builds failed. Check the matrix jobs before publishing the release."
          exit 1
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/tauri-release.yml
git commit -m "ci(tauri): add summary job to catch partial platform failures"
```

---

### Task 5: Kill-Before-Restart Race Condition Fix

The 500ms sleep after `kill_sidecar()` before `app.restart()` is unreliable. Poll until the health endpoint is unreachable before restarting.

**Files:**
- Modify: `src-tauri/src/lib.rs:672-684`

- [ ] **Step 1: Replace sleep with health-down poll**

In `src-tauri/src/lib.rs`, find the update install success block (around line 672-684):

```rust
        Ok(()) => {
            log::info!("Update to v{version} installed — killing sidecar and restarting");
            // Kill before restart so the new instance can bind ports 3478/3479.
            // kill() doesn't wait for process exit — sleep briefly to let OS reclaim ports.
            kill_sidecar(app);
            tokio::time::sleep(Duration::from_millis(500)).await;
            app.restart();
        }
```

Replace with:

```rust
        Ok(()) => {
            log::info!("Update to v{version} installed — killing sidecar and restarting");
            kill_sidecar(app);
            // Wait for sidecar to release ports before restarting
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while tokio::time::Instant::now() < deadline {
                if !check_health(client).await {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            app.restart();
        }
```

Note: `check_for_update` currently takes `app: &tauri::AppHandle` but not `client`. The `client` is needed for `check_health`. Check the function signature — if `client` isn't available, create a local one:

```rust
let client = reqwest::Client::builder()
    .timeout(HTTP_CLIENT_TIMEOUT)
    .build()
    .unwrap_or_default();
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix(tauri): poll for port release before restart after update"
```

---

### Task 6: Health Poll Diagnostics

Surface the last HTTP error in the timeout message so users get actionable diagnostics instead of generic "not ready after 15s".

**Files:**
- Modify: `src-tauri/src/lib.rs` (the `wait_for_health` function)

- [ ] **Step 1: Track and surface last error**

Replace the `wait_for_health` function body:

```rust
async fn wait_for_health(
    client: &reqwest::Client,
    sidecar_dead: &AtomicBool,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    let mut last_error: Option<String> = None;
    while start.elapsed() < HEALTH_TIMEOUT {
        if sidecar_dead.load(Ordering::Acquire) {
            return Err("Sidecar process terminated before becoming healthy".to_string());
        }
        match client.get(HEALTH_URL).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => {
                last_error = Some(format!("HTTP {}", resp.status()));
            }
            Err(e) => {
                last_error = Some(e.to_string());
            }
        }
        tokio::time::sleep(HEALTH_POLL_INTERVAL).await;
    }
    Err(format!(
        "Health endpoint not ready after {}s (last error: {})",
        HEALTH_TIMEOUT.as_secs(),
        last_error.unwrap_or_else(|| "none".to_string())
    ))
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix(tauri): surface last HTTP error in health poll timeout message"
```

---

### Task 7: Skip Update Check When Pubkey Is Empty

Prevents confusing error dialogs and log spam in dev builds where the pubkey hasn't been set yet.

**Files:**
- Modify: `src-tauri/src/lib.rs` (the `check_for_update` function)

- [ ] **Step 1: Downgrade updater-unavailable log level**

The existing code at `lib.rs:639-648` already matches on `app.updater()` returning `Err` and logs at `error` level. Change the log level from `error` to `debug` for the non-manual case so it doesn't spam the logs in dev builds where the pubkey is empty:

```rust
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::debug!("Updater unavailable: {e}");
            if manual {
                show_update_error_dialog(app, &format!("Updater not configured: {e}"));
            }
            return;
        }
    };
```

This handles ANY updater init failure (empty pubkey, missing config, etc.) and only shows a dialog when the user explicitly clicked "Check for Updates".

- [ ] **Step 2: Verify it compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix(tauri): downgrade updater-unavailable log to debug, skip silently in non-manual mode"
```

---

### Task 8: Replace `_ => {}` Catch-All on CommandEvent

**Files:**
- Modify: `src-tauri/src/lib.rs` (the sidecar event drain match)

- [ ] **Step 1: Replace wildcard with explicit log**

Find the `_ => {}` arm in the `CommandEvent` match (around line 338) and replace:

```rust
                    _ => {}
```

with:

```rust
                    other => {
                        log::debug!("[sidecar] unhandled event: {other:?}");
                    }
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "refactor(tauri): log unhandled sidecar events instead of silently dropping"
```

---

### Task 9: Warn on Missing Sample Dir in Release Builds

**Files:**
- Modify: `src-tauri/src/lib.rs` (the `copy_sample_files` function)

- [ ] **Step 1: Change log level based on build mode**

Find the `if !src_dir.exists()` block in `copy_sample_files` and replace:

```rust
    if !src_dir.exists() {
        log::info!("No bundled sample/ directory — skipping copy");
        return Ok(());
    }
```

with:

```rust
    if !src_dir.exists() {
        if cfg!(debug_assertions) {
            log::info!("No bundled sample/ directory — skipping copy (dev mode)");
        } else {
            log::warn!("No bundled sample/ directory in release build — first-run tutorial will be missing");
        }
        return Ok(());
    }
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix(tauri): warn when sample dir missing in release builds"
```

---

### Task 10: Run Full Test Suite

- [ ] **Step 1: Run unit tests**

Run: `npm test`
Expected: All 921+ tests pass. The `noExternal` + `banner` changes in tsup.config.ts should not affect test behavior since tests run from source, not dist.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 3: Run cargo check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: No errors or warnings (or only expected warnings)

- [ ] **Step 4: Commit any remaining fixes**

If any tests or checks fail, fix and commit.

---

## Not Addressed (Deferred)

These findings were evaluated and intentionally deferred:

| Finding | Reason |
|---------|--------|
| **Empty updater pubkey** | Pre-release manual prerequisite — Bryan runs `tauri signer generate` and fills it before the first real release. Not a code fix. |
| **Setup endpoint accepts arbitrary `.js` paths** | Mitigated by DNS rebinding protection + localhost-only binding. A proper fix (hardcoding channel path server-side) would change the setup API contract and should be its own PR. |
| **`fs:default`/`shell:default` capabilities unused by WebView** | Removing them risks breaking Rust-side plugin init. Needs careful testing across platforms. Low risk since XSS in a localhost WebView is already a compromised scenario. |
| **`blocking_show()` could use `spawn_blocking`** | Works correctly today on Tauri's multi-threaded runtime. Style improvement, not a bug. |
| **Spawned task panics silently lost** | Edge case — panics in well-tested async code are extremely rare. Adding JoinHandle tracking adds complexity for negligible benefit. |
| **`fail-fast: false` partial releases** | Addressed by Task 4 summary job, which flags partial failures without blocking independent platform builds. |
