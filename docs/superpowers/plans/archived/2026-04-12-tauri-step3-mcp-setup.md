# Tauri Step 3: MCP Setup on Every Launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every Tauri app launch, validate and rewrite MCP config files with correct absolute paths to the bundled Node binary and channel JS file, so Claude can discover Tandem's MCP tools without manual setup.

**Architecture:** After the Node.js sidecar passes its health check, the Rust shell POSTs to a new `/api/setup` endpoint on the sidecar. The server runs `detectTargets()` → `buildMcpEntries()` → `applyConfig()` → `installSkill()` and returns results. If no Claude installations are found, Rust shows a non-blocking dialog.

**Tech Stack:** TypeScript (Express route), Rust (reqwest HTTP client, tauri_plugin_dialog), vitest (tests)

**Spec:** `docs/superpowers/specs/2026-04-12-tauri-step3-mcp-setup-design.md`

---

## File Map

| File | Responsibility |
|------|----------------|
| `src/server/mcp/api-routes.ts` | New `POST /api/setup` route — validates input, calls setup functions, returns results |
| `src/cli/setup.ts` | Existing — exports `detectTargets`, `buildMcpEntries`, `applyConfig`, `installSkill` (no changes) |
| `tests/server/setup-api.test.ts` | Unit tests for the new `/api/setup` validation and orchestration logic |
| `src-tauri/build.rs` | Forward TARGET triple to main crate for sidecar binary path construction |
| `src-tauri/src/lib.rs` | New `run_setup()` async fn — resolves paths, POSTs to setup endpoint, handles response |
| `src-tauri/capabilities/default.json` | Add `dialog:allow-message` permission |
| `docs/tauri-plan.md` | Update Step 3 status to Done |

---

### Task 1: Validate `nodeBinary` — extract helper and test

The security review requires validating that the `nodeBinary` basename matches an allowlist before writing it into MCP config. This validation will be used by the route handler.

**Files:**
- Modify: `src/server/mcp/api-routes.ts` (add validation function + export)
- Create: `tests/server/setup-api.test.ts` (validation tests)

- [ ] **Step 1: Write the failing tests for `isValidNodeBinary`**

Create `tests/server/setup-api.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { isValidNodeBinary } from "../../src/server/mcp/api-routes.js";

describe("isValidNodeBinary", () => {
  it("accepts absolute path ending in node", () => {
    expect(isValidNodeBinary("/usr/local/bin/node")).toBe(true);
  });

  it("accepts absolute path ending in node.exe", () => {
    expect(isValidNodeBinary("C:\\Program Files\\node.exe")).toBe(true);
  });

  it("accepts path ending in node-sidecar", () => {
    expect(isValidNodeBinary("/Applications/Tandem.app/Contents/MacOS/node-sidecar")).toBe(true);
  });

  it("accepts path ending in node-sidecar.exe", () => {
    expect(isValidNodeBinary("C:\\Program Files\\Tandem\\node-sidecar.exe")).toBe(true);
  });

  it("accepts bare 'node' (dev mode)", () => {
    expect(isValidNodeBinary("node")).toBe(true);
  });

  it("accepts bare 'node.exe' (dev mode)", () => {
    expect(isValidNodeBinary("node.exe")).toBe(true);
  });

  it("rejects arbitrary executables", () => {
    expect(isValidNodeBinary("/usr/bin/python")).toBe(false);
    expect(isValidNodeBinary("calc.exe")).toBe(false);
    expect(isValidNodeBinary("/bin/sh")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidNodeBinary("")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidNodeBinary("../../../bin/sh")).toBe(false);
    expect(isValidNodeBinary("/tmp/evil/node/../../../bin/sh")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/setup-api.test.ts`
Expected: FAIL — `isValidNodeBinary` is not exported from `api-routes.js`

- [ ] **Step 3: Implement `isValidNodeBinary` in api-routes.ts**

Add to `src/server/mcp/api-routes.ts`, near the top after the existing imports:

```typescript
import { basename } from "node:path";
```

Then add the validation function (after the `LOCALHOST_ORIGIN_RE` export, before `errorCodeToHttpStatus`):

```typescript
/** Validate that a nodeBinary path points to a Node.js binary, not an arbitrary executable. */
const VALID_NODE_BASENAME_RE = /^node(-sidecar)?(\.exe)?$/;
export function isValidNodeBinary(nodeBinary: string): boolean {
  if (!nodeBinary) return false;
  return VALID_NODE_BASENAME_RE.test(basename(nodeBinary));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/setup-api.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp/api-routes.ts tests/server/setup-api.test.ts
git commit -m "feat(tauri): add nodeBinary validation for MCP setup security"
```

---

### Task 2: Add `POST /api/setup` route

Wire up the setup endpoint that accepts paths from the Tauri shell, validates, runs the existing setup functions, and returns results.

**Files:**
- Modify: `src/server/mcp/api-routes.ts:163` (add route inside `registerApiRoutes`)
- Modify: `tests/server/setup-api.test.ts` (add integration-style tests)

- [ ] **Step 1: Write the failing tests for the setup orchestration**

Append to `tests/server/setup-api.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { runSetupHandler } from "../../src/server/mcp/api-routes.js";

describe("runSetupHandler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tandem-setup-api-"));
    // Create ~/.claude dir so detectTargets finds Claude Code
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 400 when nodeBinary is missing", async () => {
    const result = await runSetupHandler({ channelPath: "/fake/channel.js" }, tmpDir);
    expect(result.status).toBe(400);
  });

  it("returns 400 when channelPath is missing", async () => {
    const result = await runSetupHandler({ nodeBinary: "node" }, tmpDir);
    expect(result.status).toBe(400);
  });

  it("returns 400 when nodeBinary fails validation", async () => {
    const result = await runSetupHandler(
      { nodeBinary: "/usr/bin/python", channelPath: "/fake/channel.js" },
      tmpDir,
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("BAD_REQUEST");
  });

  it("configures Claude Code when .claude dir exists", async () => {
    const result = await runSetupHandler(
      { nodeBinary: "node", channelPath: "/fake/dist/channel/index.js" },
      tmpDir,
    );
    expect(result.status).toBe(200);
    expect(result.body.data.configured).toContain("Claude Code");

    // Verify the config file was actually written
    const config = JSON.parse(readFileSync(join(tmpDir, ".claude.json"), "utf-8"));
    expect(config.mcpServers.tandem.url).toContain("/mcp");
    expect(config.mcpServers["tandem-channel"].command).toBe("node");
    expect(config.mcpServers["tandem-channel"].args).toEqual(["/fake/dist/channel/index.js"]);
  });

  it("returns empty targets when no Claude installations found", async () => {
    // Use a home dir with no .claude
    const emptyHome = mkdtempSync(join(tmpdir(), "tandem-empty-home-"));
    try {
      const result = await runSetupHandler(
        { nodeBinary: "node", channelPath: "/fake/channel.js" },
        emptyHome,
      );
      expect(result.status).toBe(200);
      expect(result.body.data.targets).toEqual([]);
      expect(result.body.data.configured).toEqual([]);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it("installs the Claude Code skill", async () => {
    const result = await runSetupHandler(
      { nodeBinary: "node", channelPath: "/fake/channel.js" },
      tmpDir,
    );
    expect(result.status).toBe(200);
    expect(result.body.data.skillInstalled).toBe(true);
    const skillPath = join(tmpDir, ".claude", "skills", "tandem", "SKILL.md");
    expect(readFileSync(skillPath, "utf-8")).toContain("name: tandem");
  });

  it("reports partial failures without failing the whole request", async () => {
    // Create a directory at the config path to make applyConfig fail for it
    const configPath = join(tmpDir, ".claude.json");
    mkdirSync(configPath, { recursive: true });
    const result = await runSetupHandler(
      { nodeBinary: "node", channelPath: "/fake/channel.js" },
      tmpDir,
    );
    expect(result.status).toBe(200);
    expect(result.body.data.errors.length).toBeGreaterThan(0);
  });

  it("uses custom nodeBinary in MCP config", async () => {
    const result = await runSetupHandler(
      {
        nodeBinary: "/app/MacOS/node-sidecar",
        channelPath: "/app/Resources/dist/channel/index.js",
      },
      tmpDir,
    );
    expect(result.status).toBe(200);
    const config = JSON.parse(readFileSync(join(tmpDir, ".claude.json"), "utf-8"));
    expect(config.mcpServers["tandem-channel"].command).toBe("/app/MacOS/node-sidecar");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server/setup-api.test.ts`
Expected: FAIL — `runSetupHandler` is not exported

- [ ] **Step 3: Implement `runSetupHandler` in api-routes.ts**

Add imports at the top of `src/server/mcp/api-routes.ts`:

```typescript
import { basename } from "node:path";
import {
  applyConfig,
  buildMcpEntries,
  detectTargets,
  installSkill,
  type DetectedTarget,
} from "../../cli/setup.js";
```

Add the handler function after `isValidNodeBinary` (exported so tests can call it directly without Express):

```typescript
interface SetupResult {
  status: number;
  body: {
    error?: string;
    message?: string;
    data?: {
      targets: DetectedTarget[];
      configured: string[];
      errors: string[];
      skillInstalled: boolean;
    };
  };
}

/**
 * Core setup logic, extracted for testability.
 * Validates input, detects Claude installs, writes MCP config, installs skill.
 */
export async function runSetupHandler(
  input: Record<string, unknown>,
  homeOverride?: string,
): Promise<SetupResult> {
  const { nodeBinary, channelPath } = input;

  if (!nodeBinary || typeof nodeBinary !== "string") {
    return { status: 400, body: { error: "BAD_REQUEST", message: "nodeBinary is required" } };
  }
  if (!channelPath || typeof channelPath !== "string") {
    return { status: 400, body: { error: "BAD_REQUEST", message: "channelPath is required" } };
  }
  if (!isValidNodeBinary(nodeBinary)) {
    return {
      status: 400,
      body: { error: "BAD_REQUEST", message: "nodeBinary must be a node binary" },
    };
  }

  const targets = detectTargets({ homeOverride });
  const entries = buildMcpEntries(channelPath, nodeBinary);

  const configured: string[] = [];
  const errors: string[] = [];

  for (const target of targets) {
    try {
      await applyConfig(target.configPath, entries);
      configured.push(target.label);
    } catch (err) {
      errors.push(`${target.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let skillInstalled = false;
  try {
    await installSkill({ homeOverride });
    skillInstalled = true;
  } catch (err) {
    errors.push(`Skill install: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    status: 200,
    body: { data: { targets, configured, errors, skillInstalled } },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server/setup-api.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Register the Express route in `registerApiRoutes`**

Add at the end of the `registerApiRoutes` function in `src/server/mcp/api-routes.ts`, before the closing brace (after the `/api/apply-changes` route):

```typescript
  app.options("/api/setup", apiMiddleware);
  app.post("/api/setup", apiMiddleware, largeBody, async (req: Request, res: Response) => {
    const result = await runSetupHandler((req.body ?? {}) as Record<string, unknown>);
    res.status(result.status).json(result.body);
  });
```

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `npx vitest run`
Expected: All existing tests PASS, no regressions

- [ ] **Step 7: Commit**

```bash
git add src/server/mcp/api-routes.ts tests/server/setup-api.test.ts
git commit -m "feat(tauri): add POST /api/setup endpoint for MCP config management"
```

---

### Task 3: Rust `run_setup()` — call setup endpoint after health check

Add the Rust function that POSTs to the setup endpoint with resolved paths, and wire it into the startup flow so it fires in both the "just spawned" and "already running" sidecar paths.

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs` (pass target triple to main crate)

- [ ] **Step 1: Pass TARGET triple through build.rs**

Tauri sidecar binaries are named `node-sidecar-{target-triple}[.exe]` and live alongside the main executable (not in resource_dir). The target triple is only available in build scripts, so we forward it as a compile-time env var.

Update `src-tauri/build.rs`:

```rust
fn main() {
    // Forward TARGET to the main crate so resolve_setup_paths can construct
    // the sidecar binary name with the correct target triple suffix.
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::build()
}
```

- [ ] **Step 2: Add `run_setup()` function to lib.rs**

Add after the `check_health` function (after line 176):

```rust
const SETUP_URL: &str = "http://localhost:3479/api/setup";
const CLAUDE_DOWNLOAD_URL: &str = "https://claude.ai/download";

/// POST to /api/setup with resolved paths. Best-effort — failures are logged, not fatal.
async fn run_setup(handle: &tauri::AppHandle) -> Result<(), String> {
    let (node_binary, channel_path) = resolve_setup_paths(handle)?;

    let client = build_http_client(Duration::from_secs(5))?;
    let body = serde_json::json!({
        "nodeBinary": node_binary,
        "channelPath": channel_path,
    });

    let resp = client
        .post(SETUP_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Setup request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Setup returned {status}: {text}"));
    }

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Setup response parse error: {e}"))?;

    // Log what was configured
    if let Some(configured) = result["data"]["configured"].as_array() {
        for target in configured {
            if let Some(label) = target.as_str() {
                log::info!("MCP config written for {label}");
            }
        }
    }

    if let Some(errors) = result["data"]["errors"].as_array() {
        for err in errors {
            if let Some(msg) = err.as_str() {
                log::warn!("Setup error: {msg}");
            }
        }
    }

    // Show dialog if no Claude installations found
    let targets = result["data"]["targets"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);

    if targets == 0 {
        show_no_claude_dialog(handle);
    }

    Ok(())
}

/// Resolve nodeBinary and channelPath based on build mode.
///
/// Sidecar binaries live alongside the main executable (not in resource_dir)
/// and use the naming convention `node-sidecar-{target-triple}[.exe]`.
/// Channel JS and other resources live in resource_dir.
fn resolve_setup_paths(handle: &tauri::AppHandle) -> Result<(String, String), String> {
    if cfg!(debug_assertions) {
        // Dev mode: use bare "node" (PATH-dependent) and repo-relative channel path
        let channel_path = std::env::current_dir()
            .map_err(|e| format!("Failed to get cwd: {e}"))?
            .join("dist/channel/index.js");
        Ok(("node".to_string(), channel_path.to_string_lossy().into_owned()))
    } else {
        // Release mode: channel JS is a resource
        let resource_dir = handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;
        let channel_path = resource_dir.join("dist/channel/index.js");

        // Sidecar binary lives alongside the main executable with target triple suffix
        let exe_dir = std::env::current_exe()
            .map_err(|e| format!("Failed to get current exe: {e}"))?
            .parent()
            .ok_or("Failed to get exe parent dir")?
            .to_path_buf();

        let sidecar_name = if cfg!(target_os = "windows") {
            format!("node-sidecar-{}.exe", env!("TARGET_TRIPLE"))
        } else {
            format!("node-sidecar-{}", env!("TARGET_TRIPLE"))
        };
        let node_binary = exe_dir.join(sidecar_name);

        Ok((
            node_binary.to_string_lossy().into_owned(),
            channel_path.to_string_lossy().into_owned(),
        ))
    }
}

/// Show a non-blocking dialog informing the user that Claude is not installed.
fn show_no_claude_dialog(handle: &tauri::AppHandle) {
    use tauri_plugin_dialog::DialogExt;

    handle
        .dialog()
        .message(format!(
            "No Claude installation found.\n\n\
             Tandem works as a standalone editor, but AI collaboration \
             features require Claude Desktop or Claude Code.\n\n\
             Download Claude at: {CLAUDE_DOWNLOAD_URL}"
        ))
        .title("Claude Not Found")
        .ok_button_label("OK")
        .show(|_| {});
}
```

- [ ] **Step 4: Refactor `start_sidecar()` to return without running setup, and wire setup into the `setup` closure**

Replace the entire `setup` closure in the `run()` function (lines 30-47 of lib.rs) with:

```rust
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_sidecar(&handle).await {
                    log::error!("Sidecar failed: {e}");
                    // TODO: show user-visible error dialog
                    return;
                }

                // Setup fires after health check passes — in BOTH paths
                // (freshly spawned sidecar OR already-running dev server)
                if let Err(e) = run_setup(&handle).await {
                    log::warn!("MCP setup failed (non-fatal): {e}");
                }
            });

            Ok(())
        })
```

This ensures `run_setup()` fires after health check succeeds regardless of whether the sidecar was spawned or was already running.

- [ ] **Step 5: Verify it compiles**

Verify that `serde_json` (line 21) and `tauri-plugin-dialog` (line 28) are already in `Cargo.toml` — no changes needed. `serde_json::json!` and `tauri_plugin_dialog::DialogExt` are path-qualified in the functions, so no top-level imports needed beyond what already exists.



Run: `cd src-tauri && cargo check`
Expected: Compiles with zero errors. Warnings about unused variables are acceptable.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/build.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): call /api/setup after sidecar health check on every launch"
```

---

### Task 4: Add dialog capability permission

The `show_no_claude_dialog` function requires the `dialog:allow-message` permission in the Tauri capability manifest.

**Files:**
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add the permission**

Update `src-tauri/capabilities/default.json` to add `"dialog:allow-message"` to the permissions array:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "enables the default permissions",
  "windows": [
    "main"
  ],
  "permissions": [
    "core:default",
    "shell:default",
    "fs:default",
    "dialog:default",
    "dialog:allow-message"
  ]
}
```

Note: `dialog:default` may already include `allow-message`. If `cargo check` passes without this addition, it's redundant and can be removed. Add it defensively — Tauri silently ignores duplicate permissions.

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with zero errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/capabilities/default.json
git commit -m "feat(tauri): add dialog permission for Claude-not-found message"
```

---

### Task 5: Update plan status and verify end-to-end

Mark Step 3 as done in the Tauri plan and do a manual smoke test.

**Files:**
- Modify: `docs/tauri-plan.md` (Step 3 status + progress table)

- [ ] **Step 1: Update Step 3 status in tauri-plan.md**

In `docs/tauri-plan.md`, change the Step 3 heading to include ✅:

```markdown
### Step 3: MCP Setup (Every Launch) ✅
```

And update the progress table at the bottom:

```markdown
| 3 | MCP Setup (Every Launch) | Done |
```

- [ ] **Step 2: Run full TypeScript test suite**

Run: `npx vitest run`
Expected: All tests PASS including the new `setup-api.test.ts`

- [ ] **Step 3: Run Rust compilation check**

Run: `cd src-tauri && cargo check`
Expected: Zero errors

- [ ] **Step 4: Smoke test in dev mode**

Start the dev server: `npm run dev:standalone`
Then in another terminal: `cd src-tauri && cargo run`

Verify in the Rust log output:
- "Server already healthy — skipping sidecar spawn" (since dev:standalone is running)
- "MCP config written for Claude Code" (or whichever Claude installs exist)
- No error dialogs (assuming Claude is installed)

Check that `~/.claude.json` contains the `tandem` and `tandem-channel` entries with `command: "node"` and the repo-relative channel path.

- [ ] **Step 5: Commit plan update**

```bash
git add docs/tauri-plan.md
git commit -m "docs: mark Tauri Step 3 (MCP setup) as complete"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | `isValidNodeBinary` validation + tests | `api-routes.ts`, `setup-api.test.ts` |
| 2 | `POST /api/setup` route + handler + tests | `api-routes.ts`, `setup-api.test.ts` |
| 3 | Rust `run_setup()` + startup wiring | `build.rs`, `lib.rs` |
| 4 | Dialog capability permission | `default.json` |
| 5 | Plan update + smoke test | `tauri-plan.md` |
