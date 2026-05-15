# Host-Allowlist Narrowing Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the audit started by PR #637. Eliminate the remaining `http://localhost:3478|3479` defaults baked into the Rust supervisor, Tauri dev config, CLI/channel/monitor entry points, plugin/example configs, scripts, and tests — all of which travel through Tandem's `apiMiddleware` and get rejected with **HTTP 403 Forbidden** because PR #477 PR 2 narrowed `isHostAllowed` to `127.0.0.1` + `tauri.localhost` only.

**Architecture:** Two central defaults drive every CLI/script consumer — `resolveTandemUrl()` in `src/shared/cli-runtime.ts:45` and `MCP_URL` in `src/cli/setup.ts:16`. Flip both to `127.0.0.1`. Sweep stragglers (`.claude-plugin/plugin.json`, `.env.example`, `.mcp.json.example`, `scripts/dev-standalone.mjs`, `scripts/doctor.mjs`, `scripts/take-screenshots.mjs`, the channel error string, the EditorHarness). Update test fixtures so suites match the new default. Run typecheck + vitest. The Rust supervisor + Tauri WebView changes that triggered this audit are already on this branch (see "Already applied" below) and are part of the same commit history; this plan covers the rest.

**Tech Stack:** Node.js (CLI, scripts) + Rust (Tauri supervisor) + Svelte 5 (client) + Vitest.

---

## File Map

### Already applied on this branch (`fix/host-allowlist-narrowing-audit`)

These three changes were made before this plan, in response to the live `dev:tauri` "Server failed to start" dialog. They are uncommitted but staged conceptually with this work. Reviewers should treat them as part of the plan's surface area.

- `src-tauri/src/lib.rs:36-38` — Rust supervisor URL constants (`HEALTH_URL`, `SETUP_URL`, `OPEN_URL`): `localhost` → `127.0.0.1`. **Primary fix** — supervisor health-poll was 403'ing for 15s, then giving up after 3 restarts.
- `src-tauri/tauri.conf.json:8` — Tauri `devUrl`: `http://localhost:5173` → `http://127.0.0.1:5173`. Makes the WebView's Origin pass Hocuspocus' narrowed origin check in dev mode.
- `src-tauri/tauri.conf.json:29` — CSP `connect-src`: `localhost` → `127.0.0.1`. Aligns CSP with the client's `API_BASE` (already `127.0.0.1`).
- `src/client/hooks/yjsSync.svelte.ts:197,266` — Hocuspocus WS URL: `localhost` → `127.0.0.1`. Consistency; the URL hostname isn't checked by Hocuspocus' Origin-only gate, but keeps the codebase free of bare-`localhost` strings.

### To modify in this plan (revised after agent review — original grep missed template literals using `${port}`/`${DEFAULT_MCP_PORT}`)

| File | Line | Change |
|---|---|---|
| `src/shared/cli-runtime.ts` | 45 | `resolveTandemUrl()` default → `127.0.0.1` (+ JSDoc at line 25) |
| `src/cli/setup.ts` | 16 | `MCP_URL` constant → `127.0.0.1` |
| `src/server/mcp/launcher.ts` | 28 | `tandemUrl` template literal → `127.0.0.1` (server-internal — was 403'ing against the same server it spawned alongside) |
| `src/server/mcp/server.ts` | 335, 337, 346, 348 | OAuth `/.well-known/oauth-protected-resource` `resource` + `authorization_servers` → `127.0.0.1`. **Protocol-visible** — newer MCP clients probe this. Does not violate invariant 6 (the rule is "never `req.host` / detected LAN IP", not "must be the string `localhost`"); both `localhost` and `127.0.0.1` are non-attacker-controlled. |
| `src/server/index.ts` | 411, 419-421, 435 | Startup banner log strings — users copy these into MCP configs |
| `.claude-plugin/plugin.json` | 16, 23 | `TANDEM_URL` env values → `127.0.0.1` |
| `.mcp.json.example` | 9, 15 | example URL + `TANDEM_URL` → `127.0.0.1` |
| `.env.example` | 8 | `TANDEM_URL` example → `127.0.0.1` |
| `scripts/dev-standalone.mjs` | 17 | fallback URL → `127.0.0.1` |
| `scripts/doctor.mjs` | 129, 241, 247 | guidance + 2 diagnostic strings → `127.0.0.1` |
| `scripts/take-screenshots.mjs` | 20 | `MCP_URL` constant → `127.0.0.1` |
| `src/channel/run.ts` | 215 | error-message URL example → `127.0.0.1` |
| `src/client/svelte-harness/EditorHarness.svelte` | 12 | test harness WS URL → `127.0.0.1` |
| `vite.config.ts` | 28 | Vite dev proxy `target` → `127.0.0.1` |
| `tests/cli/setup.test.ts` | **27, 53, 68, 76, 85, 105, 149, 196** | **all 8** localhost assertions → `127.0.0.1` (original plan listed only 3; would have failed Task 2 verification) |
| `tests/cli/preflight.test.ts` | 31, 35, 52, 73 | fixture URLs → `127.0.0.1` (lines 40, 45, 80, 84 also use `localhost` but exercise different ports as deliberate non-Tandem URLs — leave) |
| `tests/monitor/url-resolution.test.ts` | 50, 56, 73, 121, 135 | default + fixture URLs → `127.0.0.1` |
| `tests/server/server-security-invariants.test.ts` | 62, 73, 90 | `body.resource === http://localhost:${port}/mcp` → `127.0.0.1` (paired with `server.ts` OAuth change above) |

### Intentionally NOT touched

- `tests/server/api-middleware.test.ts:13,28,58-60,70` — negative-test assertions that lock in the narrowing. `expect(isHostAllowed("localhost:3479")).toBe(false)` and `expect(isLocalhostOrigin("http://localhost:5173")).toBe(false)` MUST stay.
- `tests/shared/cli-runtime.test.ts:30,40,49,…` — `authFetch("http://localhost/test")` uses `localhost` as a generic mocked-fetch identity; not a real Tandem target. Leave.
- `tests/channel/fetch-with-timeout.test.ts`, `tests/channel/reply-abort.test.ts` — same; mocked fetch URLs, not real Tandem targets.
- `tests/server/setup-api.test.ts:258,276` — fixtures for `http://localhost:9999` as a third-party "some-other-server" in MCP config migration tests. Leave.
- `tests/cli/preflight.test.ts:40,45,80,84` — deliberately tests non-Tandem ports / env-override semantics; the URL strings are inputs, not assertions about Tandem. Leave.
- `README.md`, `docs/architecture.md`, `docs/workflows.md`, `docs/mcp-tools.md`, `docs/decisions.md`, `docs/roadmap.md` — user-facing docs. Static SPA serving in `src/server/mcp/server.ts:386` intentionally omits `apiMiddleware` (verified by reviewer), so browser navigation to `http://localhost:3479` still works. Doc consistency pass is a follow-up.
- `docs/superpowers/plans/archived/*`, `.claude/reviews/*.codex.md` — historical artifacts. Never edit.
- `scripts/ci/stdio-smoke.mjs:175` — already `127.0.0.1`. No-op.

---

## Task 1: Update `resolveTandemUrl` default and its test fixtures

**Files:**
- Modify: `src/shared/cli-runtime.ts:20-46`
- Modify: `tests/monitor/url-resolution.test.ts:50,56,73,121,135`

- [ ] **Step 1: Update the test expectations to the new default**

Open `tests/monitor/url-resolution.test.ts` and change every assertion that expects the localhost default. Specifically:

```typescript
// Line 50 (was: "http://localhost:3479")
expect(resolveTandemUrl()).toBe("http://127.0.0.1:3479");

// Line 56 (blank-env fallback)
expect(resolveTandemUrl()).toBe("http://127.0.0.1:3479");

// Line 73 (whitespace-only override falls back)
expect(resolveTandemUrl("\t")).toBe("http://127.0.0.1:3479");

// Lines 121, 135 (authFetch call sites — assertion is on Authorization header,
// not the URL string, but update for consistency)
await authFetch("http://127.0.0.1:3479/test");
```

- [ ] **Step 2: Run the test, verify it now fails**

```
npx vitest run tests/monitor/url-resolution.test.ts
```
Expected: FAIL — current default returns `http://localhost:3479`, tests now expect `127.0.0.1`.

- [ ] **Step 3: Update the default and the JSDoc**

In `src/shared/cli-runtime.ts`, change line 45:

```typescript
return `http://127.0.0.1:${DEFAULT_MCP_PORT}`;
```

And update the JSDoc at lines 20-30 — replace the line `* (4) localhost default` (currently around line 25) with `* (4) 127.0.0.1 default (apiMiddleware narrowed out bare `localhost` in PR #477 PR 2)`.

- [ ] **Step 4: Run the test, verify it now passes**

```
npx vitest run tests/monitor/url-resolution.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/cli-runtime.ts tests/monitor/url-resolution.test.ts
git commit -m "fix(cli): default TANDEM_URL resolves to 127.0.0.1, not localhost

Server's apiMiddleware (isHostAllowed) was narrowed in #477 PR 2 to
reject bare 'localhost'. Any caller falling back to the default hit
403 on /health, /api/*, and /api/channel-* paths."
```

---

## Task 2: Update `MCP_URL` in setup.ts and its tests

**Files:**
- Modify: `src/cli/setup.ts:16`
- Modify: `tests/cli/setup.test.ts:27,53,68,76,85,105,149,196`

- [ ] **Step 1: Update all 8 test assertions** (code-reviewer agent caught: original plan listed only 3 of 8; would have failed Task 2 Step 4)

```typescript
// Line 27 (default buildMcpEntries fixture)
url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`,

// Line 53 (entries.tandem.url assertion)
expect(entries.tandem.url).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);

// Line 68 (tandem-channel env when token provided)
expect(entries["tandem-channel"]?.env?.TANDEM_URL).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}`);

// Line 76 (tandem-channel env when no token)
expect(entries["tandem-channel"]?.env?.TANDEM_URL).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}`);

// Line 85 (claude-desktop target tandem env)
expect(entries.tandem.env?.TANDEM_URL).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}`);

// Line 105 (second entries.tandem.url assertion)
expect(entries.tandem.url).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);

// Line 149 (applyConfig fixture)
url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`,

// Line 196 (written config assertion)
expect(written.mcpServers.tandem.url).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
```

Do **not** touch line 190 / 205 — those are fixture inputs for `http://old:9999/mcp` testing the migration path. They are unrelated.

- [ ] **Step 2: Run setup tests, verify fail**

```
npx vitest run tests/cli/setup.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Update MCP_URL constant**

In `src/cli/setup.ts:16`:

```typescript
const MCP_URL = `http://127.0.0.1:${DEFAULT_MCP_PORT}`;
```

- [ ] **Step 4: Run tests, verify pass**

```
npx vitest run tests/cli/setup.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup.ts tests/cli/setup.test.ts
git commit -m "fix(cli): tandem setup writes 127.0.0.1 into ~/.claude.json

setup.ts wrote http://localhost:3479 into ~/.claude.json mcp entries
and into the channel shim TANDEM_URL env. Claude Code's HTTP MCP
transport tolerates this (SDK middleware accepts localhost) but
tandem mcp-stdio's preflight hits the narrowed apiMiddleware on
/health and returns 403, breaking Claude Desktop installs."
```

---

## Task 3: Update preflight test fixtures

**Files:**
- Modify: `tests/cli/preflight.test.ts:31,35,52,73`

The preflight implementation reads `resolveTandemUrl`'s output, so its behavior already shifted with Task 1. Tests pass explicit URLs to the helper; align those with the new default.

- [ ] **Step 1: Update fixture URLs**

In `tests/cli/preflight.test.ts`, change four assertions:

```typescript
// Line 31
await expect(ensureTandemServer({ url: "http://127.0.0.1:3479" })).resolves.toBeUndefined();

// Line 35
expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:3479/health", expect.any(Object));

// Line 52
await expect(ensureTandemServer({ url: "http://127.0.0.1:3479" })).rejects.toBeInstanceOf(...);

// Line 73
ensureTandemServer({ url: "http://127.0.0.1:3479", timeoutMs: 10 }),
```

- [ ] **Step 2: Run tests, verify pass**

```
npx vitest run tests/cli/preflight.test.ts
```
Expected: PASS (assertions are pinned to the URL string passed in).

- [ ] **Step 3: Commit**

```bash
git add tests/cli/preflight.test.ts
git commit -m "test(cli): preflight fixtures align with resolveTandemUrl default

Preflight passes explicit URLs to ensureTandemServer; pin the fixture
URL strings to the new 127.0.0.1 default from Task 1 so a reader does
not encounter a stale localhost reference next to the updated default."
```

---

## Task 4: Update plugin/example configs

**Files:**
- Modify: `.claude-plugin/plugin.json:16,23`
- Modify: `.mcp.json.example:9,15`
- Modify: `.env.example:8`

These ship with the package and tell users what to put in their MCP/env config.

- [ ] **Step 1: Edit `.claude-plugin/plugin.json`**

Replace both occurrences of `"http://localhost:3479"` with `"http://127.0.0.1:3479"` (lines 16 and 23 — `mcpServers.tandem.env.TANDEM_URL` and `mcpServers.tandem-channel.env.TANDEM_URL`).

- [ ] **Step 2: Edit `.mcp.json.example`**

```jsonc
// Line 9 — http MCP entry
"url": "http://127.0.0.1:3479/mcp"
// Line 15 — channel shim env
"TANDEM_URL": "http://127.0.0.1:3479"
```

- [ ] **Step 3: Edit `.env.example`**

```
# Line 8
TANDEM_URL=http://127.0.0.1:3479  # Server URL for channel shim to connect to
```

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .mcp.json.example .env.example
git commit -m "fix(config): plugin/example configs default to 127.0.0.1

Anyone copying these examples into ~/.claude.json or .env would have
hit 403 on /health, /api/*, and the channel SSE stream."
```

---

## Task 5: Update script defaults

**Files:**
- Modify: `scripts/dev-standalone.mjs:17`
- Modify: `scripts/doctor.mjs:129`
- Modify: `scripts/take-screenshots.mjs:20`

- [ ] **Step 1: Edit `scripts/dev-standalone.mjs:17`**

```javascript
const raw = env.TANDEM_URL ?? `http://127.0.0.1:${env.TANDEM_MCP_PORT ?? DEFAULT_MCP_PORT}`;
```

- [ ] **Step 2: Edit `scripts/doctor.mjs` lines 129, 241, 247**

Line 129 — config guidance string users copy:
```javascript
'Add "env": {"TANDEM_URL": "http://127.0.0.1:3479"}',
```

Lines 241 + 247 — diagnostic messages shown when the server doesn't respond. The script already fetches `http://127.0.0.1:${MCP_PORT}/health` (line 238); only the display string says `localhost`:
```javascript
// Line 241
fail(`Server not responding on 127.0.0.1:${MCP_PORT}`, "npm run dev:standalone");
// Line 247
`Server not responding on 127.0.0.1:${MCP_PORT} (${result.error})`,
```

- [ ] **Step 3: Edit `scripts/take-screenshots.mjs:20`**

```javascript
const MCP_URL = "http://127.0.0.1:3479/mcp";
```

- [ ] **Step 4: Run the doctor script as a smoke test (does it parse?)**

```
node scripts/doctor.mjs --help 2>&1 | head -5
```
Expected: prints usage without a SyntaxError.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-standalone.mjs scripts/doctor.mjs scripts/take-screenshots.mjs
git commit -m "fix(scripts): scripts default to 127.0.0.1 for /api/* compatibility"
```

---

## Task 6: Update server-internal callers, dev proxy, banner strings, channel error, harness

This task is the cleanup sweep for surfaces the original grep missed (template-literal forms using `${port}`). Reviewer agents specifically flagged `server.ts` OAuth metadata as the most serious miss because it is wire-format protocol-visible.

**Files:**
- Modify: `src/server/mcp/server.ts:335,337,346,348` (OAuth `.well-known` metadata)
- Modify: `tests/server/server-security-invariants.test.ts:62,73,90` (paired with above)
- Modify: `src/server/mcp/launcher.ts:28` (server-internal `tandemUrl`)
- Modify: `src/server/index.ts:411,419-421,435` (startup banner log strings)
- Modify: `vite.config.ts:28` (Vite dev `/ws` proxy target)
- Modify: `src/channel/run.ts:215` (user-facing TANDEM_URL error format example)
- Modify: `src/client/svelte-harness/EditorHarness.svelte:12` (dev-only harness WS URL)

- [ ] **Step 1: Update test expectations for OAuth metadata** (paired-test-first; will fail until server.ts is updated)

In `tests/server/server-security-invariants.test.ts`, change three assertions:
```typescript
// Line 62
expect(body.resource).toBe(`http://127.0.0.1:${port}/mcp`);
// Line 73
expect(body.resource).toBe(`http://127.0.0.1:${port}/mcp`);
// Line 90
expect(body.resource).toBe(`http://127.0.0.1:${port}/mcp`);
```

Run:
```
npx vitest run tests/server/server-security-invariants.test.ts
```
Expected: FAIL.

- [ ] **Step 2: Update OAuth metadata in `src/server/mcp/server.ts`**

Lines 335, 337 (in `/.well-known/oauth-protected-resource/mcp`) and 346, 348 (in `/.well-known/oauth-protected-resource`):
```typescript
resource: `http://127.0.0.1:${port}/mcp`,
bearer_methods_supported: ["header"],
authorization_servers: [`http://127.0.0.1:${port}`],
```

Also update the comment at line 328 to read:
```
// resource uses literal "127.0.0.1" (invariant 6 — never req.host or a detected LAN IP).
```

Rerun the test: PASS.

Note on invariant 6: the rule is "never `req.host` / detected LAN IP" (both attacker-controlled). The choice between the literal strings `localhost` and `127.0.0.1` is not what the invariant prohibits — both are non-attacker-controlled. Switching to `127.0.0.1` aligns the advertised resource identifier with the Host the server actually accepts on `/api/*` and `/health`.

- [ ] **Step 3: Update `src/server/mcp/launcher.ts:28`**

```typescript
const tandemUrl = `http://127.0.0.1:${process.env.TANDEM_MCP_PORT || DEFAULT_MCP_PORT}`;
```

`launcher.ts` spawns the channel shim via stdio with `TANDEM_URL` env. Before this fix, the shim defaulted to `localhost:3479` → 403'd against the very server it was spawned alongside.

- [ ] **Step 4: Update startup banner in `src/server/index.ts`**

Lines 411, 419-421, 435 are `console.error` calls advertising the server URLs. Users see these on first run and may copy them into MCP configs:
```typescript
// Line 411 and 435 (Hocuspocus banner)
console.error(`[Tandem] Hocuspocus WebSocket server running on ws://127.0.0.1:${wsPort}`);

// Lines 419-421 (startup summary block)
console.error(`  MCP HTTP:    http://127.0.0.1:${mcpPort}/mcp`);
console.error(`  WebSocket:   ws://127.0.0.1:${wsPort}`);
console.error(`  Health:      http://127.0.0.1:${mcpPort}/health`);
```

- [ ] **Step 5: Update `vite.config.ts:28`**

```typescript
target: "ws://127.0.0.1:3478",
```

Hocuspocus checks Origin (not Host) on the WS handshake, so the localhost form has not been functionally broken, but consistency matters.

- [ ] **Step 6: Update `src/channel/run.ts:215`**

```typescript
`[Channel] Invalid TANDEM_URL: "${url}" — expected format: http://127.0.0.1:3479`,
```
User-visible error message: users who copy the example would get the working URL.

- [ ] **Step 7: Update `src/client/svelte-harness/EditorHarness.svelte:12`**

```svelte
url: "ws://127.0.0.1:3478",
```

Sanity-check no remaining callers (note: original plan's `'"ws://localhost:3478"'` quote-and-port-anchored grep would miss template-literal forms — svelte-reviewer agent flagged this):
```
grep -rn "ws://localhost\|http://localhost:347" src/ tests/
```
Expected: no matches except the negative-test assertions in `tests/server/api-middleware.test.ts` and the mocked-fetch identity strings in `tests/shared/cli-runtime.test.ts` / `tests/channel/*.test.ts`.

- [ ] **Step 8: Run paired tests, verify pass**

```
npx vitest run tests/server/server-security-invariants.test.ts
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/mcp/server.ts src/server/mcp/launcher.ts src/server/index.ts vite.config.ts src/channel/run.ts src/client/svelte-harness/EditorHarness.svelte tests/server/server-security-invariants.test.ts
git commit -m "fix(server): server-internal + protocol-visible URLs use 127.0.0.1

OAuth /.well-known/oauth-protected-resource metadata advertised
http://localhost:\${port}/mcp as the protocol resource identifier.
Clients following the metadata sent subsequent requests with Host:
localhost — fine for /mcp (SDK middleware accepts localhost) but
inconsistent with /api/* (narrowed apiMiddleware rejects it).
launcher.ts spawned the channel shim with TANDEM_URL=localhost,
which 403'd against the same server it was launched alongside.
Banner log strings, the Vite /ws proxy target, the user-facing
channel error message, and the dev-only Svelte harness are
included in the same commit to finish the sweep."
```

---

## Task 7: Full verification

- [ ] **Step 1: Typecheck**

```
npm run typecheck
```
Expected: `0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`.

- [ ] **Step 1b: Rust supervisor tests** (code-reviewer agent flagged: pre-existing test coverage for `HEALTH_URL`/`SETUP_URL`/`OPEN_URL` consumers lives in `src-tauri/src/lib.rs` `#[test]` modules. The branch's first three edits are unguarded by any Node test.)

Pre-create the resource stubs `tauri_build::build()` requires (lesson `feedback_tauri_build_resource_stubs.md`):
```bash
mkdir -p src-tauri/binaries dist/channel dist/server dist/client
# Stubs may already exist from prior dev session; this is idempotent.
```

```
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: PASS. Skip if `cargo` is unavailable in the executor environment — note that pre-push hooks will run it.

- [ ] **Step 2: Run full Vitest suite (Node project)**

```
npx vitest run
```
Expected: all tests pass. If `tests/server/api-middleware.test.ts` fails, you accidentally changed the negative test — revert.

- [ ] **Step 3: Run the stdio smoke script**

```
node scripts/ci/stdio-smoke.mjs
```
Expected: completes without 403. The script already uses `127.0.0.1` for its own `TANDEM_URL`, but exercises the full preflight + MCP flow.

- [ ] **Step 4: Live smoke against `dev:tauri`**

User runs `npm run dev:tauri`. Watch the sidecar logs (`[2026-...][app_lib][WARN] [sidecar] ...`). Required observations:
- No `Rejected connection from origin: http://localhost:5173` lines.
- No `HTTP 403 Forbidden` from the health poll.
- "Sidecar healthy after Xs" log line appears.
- The editor loads `welcome.md` (not a blank pane).

If any of these fail, stop and re-investigate — the fix is incomplete.

---

## Task 8: Update memory + open PR

- [ ] **Step 1: Update `feedback_cors_narrowing_client_fetch_audit.md`**

Append to the existing memory at `C:\Users\blokn\.claude\projects\C--Users-blokn-GitHub-tandem\memory\feedback_cors_narrowing_client_fetch_audit.md`:

```
**Audit checklist (expanded after this audit):** when narrowing CORS/Host allowlist, sweep
- client fetch URLs (caught in PR #637)
- Playwright config + Vite host (caught in PR #637)
- **Rust supervisor URL constants** (src-tauri/src/lib.rs HEALTH_URL/SETUP_URL/OPEN_URL)
- **Tauri devUrl + CSP connect-src** (src-tauri/tauri.conf.json)
- **CLI runtime defaults** (src/shared/cli-runtime.ts resolveTandemUrl, src/cli/setup.ts MCP_URL)
- **Plugin/example configs** (.claude-plugin/plugin.json, .mcp.json.example, .env.example)
- **Helper scripts** (scripts/dev-standalone.mjs, scripts/doctor.mjs, scripts/take-screenshots.mjs)
- **Test fixtures** (tests/cli/setup.test.ts, tests/cli/preflight.test.ts, tests/monitor/url-resolution.test.ts)
```

Output `MEMORY_STORED` after the edit (auto-memory protocol).

- [ ] **Step 2: Open the PR via `/commit-commands:commit-push-pr`**

The slash command bundles unpushed commits, pushes the branch, and opens a PR. PR title:

`fix: finish #477 PR 2 audit — drop localhost from CLI/script/config defaults`

PR body should reference:
- Root cause: `isHostAllowed` narrowing in PR #477 PR 2
- Predecessor: PR #637 caught browser fetches + Playwright
- Symptom: `dev:tauri` "Server failed to start after 3 restart attempts" dialog
- Latent surfaces fixed: Rust supervisor, Tauri dev config, CLI runtime defaults, plugin configs, scripts, test fixtures

---

## Open follow-ups (out of scope, file later if requested)

- **Docs cosmetic pass:** `README.md`, `docs/architecture.md`, `docs/workflows.md`, `docs/mcp-tools.md`, `docs/decisions.md`, `docs/roadmap.md` reference `http://localhost:3479` for editor browser-open URL. Static SPA serving bypasses apiMiddleware so those still work, but consistency would be nice.
- **Roadmap effect_update_depth_exceeded bug** (Todo #4): tracked separately on its own branch.
