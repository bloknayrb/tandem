# npm Global Install (tandem-editor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tandem installable via `npm install -g tandem-editor` so anyone can run `tandem setup` once and then `tandem` from any directory to start the server and open the UI.

**Architecture:** Add a `src/cli/` entrypoint that dispatches to `start` (spawn server + open browser) or `setup` (detect and write Claude Code / Claude Desktop MCP configs). Add static file serving to the Express MCP server so the Vite-built client is accessible at `:3479`. Bundle the CLI via tsup. Rename the package to `tandem-editor`, add `bin`/`files`/`prepublishOnly`, and create a thin `tandem-doc` stub package using npm workspaces.

**Tech Stack:** Node.js 22, TypeScript, tsup, Express `express.static`, `child_process.spawn`, `fs/promises`, `env-paths` (already a dep)

---

## File Map

**Create:**
- `src/server/open-browser.ts` — cross-platform browser open (lives in server, not CLI, to keep dep direction clean)
- `src/cli/index.ts` — CLI entrypoint: parses args, dispatches to start or setup
- `src/cli/start.ts` — spawns server process with `TANDEM_OPEN_BROWSER=1`, forwards signals
- `src/cli/setup.ts` — detects Claude Code / Claude Desktop config paths, writes MCP entries
- `src/cli/setup.test.ts` — vitest unit tests for setup detection + config writing
- `packages/tandem-doc/package.json` — stub package depending on tandem-editor via local path in dev, `*` on publish
- `packages/tandem-doc/bin/tandem.mjs` — thin wrapper that delegates to tandem-editor CLI

**Modify:**
- `src/server/mcp/server.ts` — add `express.static` for `dist/client`, add `TANDEM_OPEN_BROWSER` hook after server binds
- `tsup.config.ts` — add `src/cli/index.ts` entry → `dist/cli/` with `define` for version baking
- `package.json` — rename to `tandem-editor`, add `bin`, `main`, `files`, `exports`, `prepublishOnly`, `workspaces`, remove `"private": true`
- `scripts/doctor.mjs` — add user-level MCP registration check

---

## Task 1: Browser open helper (in server layer)

**Files:**
- Create: `src/server/open-browser.ts`

This lives in `src/server/` (not `src/cli/`) so that the server bundle can import it directly without creating a CLI→server or server→CLI circular dependency.

- [ ] **Step 1: Implement `src/server/open-browser.ts`**

```ts
// src/server/open-browser.ts
import { exec } from "node:child_process";

/**
 * Open a URL in the default browser.
 * Best-effort — errors are logged to stderr, never thrown.
 */
export function openBrowser(url: string): void {
  let cmd: string;
  if (process.platform === "win32") {
    // `start` requires the empty title arg ("") to handle URLs with & correctly
    cmd = `start "" "${url}"`;
  } else if (process.platform === "darwin") {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) console.error(`[Tandem] Could not open browser: ${err.message}`);
  });
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/server/open-browser.ts
git commit -m "feat(server): cross-platform browser open helper"
```

---

## Task 2: Static file serving + TANDEM_OPEN_BROWSER in server

**Files:**
- Modify: `src/server/mcp/server.ts`

The server's Express app already exists in `startMcpServerHttp`. We add:
1. Top-level imports for `existsSync` and `openBrowser`
2. `express.static` serving `dist/client/` (relative to `import.meta.url`)
3. SPA fallback route
4. After the server binds, call `openBrowser` when `TANDEM_OPEN_BROWSER=1`

Note: static routes intentionally omit `apiMiddleware` (DNS rebinding protection) — static assets carry no sensitive data, and applying it would block legitimate browser requests from navigating to the app.

- [ ] **Step 1: Run typecheck to confirm baseline**

```bash
npm run typecheck
```

Expected: passes with no errors.

- [ ] **Step 2: Add imports to `server.ts`**

At the top of `src/server/mcp/server.ts`, add alongside the existing imports:

```ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "../open-browser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/server/mcp/ → dist/client/
const CLIENT_DIST = join(__dirname, "../../client");
```

- [ ] **Step 3: Add static serving + SPA fallback in `startMcpServerHttp`**

In `startMcpServerHttp`, after `registerChannelRoutes(app, apiMiddleware);` and before the `return new Promise(...)`, add:

```ts
  // Serve built client assets when present (populated by `vite build`).
  // express.static falls through for paths it doesn't find, so /mcp, /api/*,
  // /health, and channel routes registered above continue to work normally.
  // Static routes omit apiMiddleware by design — assets carry no sensitive data.
  if (existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST, { index: "index.html" }));
    // SPA fallback: serve index.html for client-side routes not matched above.
    // Must be registered AFTER all API routes so it only fires for unknown paths.
    app.get("*", (_req, res) => {
      res.sendFile(join(CLIENT_DIST, "index.html"));
    });
    console.error(`[Tandem] Serving client from ${CLIENT_DIST}`);
  } else {
    console.error(`[Tandem] No client dist at ${CLIENT_DIST} — run 'npm run build' first`);
  }
```

- [ ] **Step 4: Open browser after server binds**

Update the `return new Promise<Server>` block's callback to:

```ts
    const httpServer = app.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      httpServer.on("error", (err: Error) => console.error("[Tandem] HTTP server error:", err));
      console.error(`[Tandem] MCP HTTP server on http://${host}:${port}/mcp`);
      if (process.env.TANDEM_OPEN_BROWSER === "1") {
        openBrowser(`http://localhost:${port}`);
      }
      resolve(httpServer);
    });
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 6: Smoke-test manually**

```bash
npm run build
TANDEM_OPEN_BROWSER=1 node dist/server/index.js
```

Expected: server starts, browser opens to `http://localhost:3479`, the Tandem UI loads.

- [ ] **Step 7: Commit**

```bash
git add src/server/mcp/server.ts src/server/open-browser.ts
git commit -m "feat(server): serve dist/client statically and open browser on TANDEM_OPEN_BROWSER=1"
```

---

## Task 3: `setup.ts` — detect Claude installs and write MCP config

**Files:**
- Create: `src/cli/setup.ts`
- Create: `src/cli/setup.test.ts`

The setup command detects:
- **Claude Code**: `~/.claude/mcp_settings.json` — detected if file OR parent directory (`~/.claude`) exists, since Claude Code always creates `~/.claude` at install time
- **Claude Desktop**: platform-specific file path — detected only if the file itself exists (Desktop users have already run the app at least once)

For each detected target it:
1. Reads + parses existing JSON (or starts with `{}`)
2. Merges in the tandem + tandem-channel entries (overwrites existing tandem entries)
3. Writes back atomically (write temp in same directory + rename, with EXDEV fallback for cross-device Windows scenarios)

With `--force`, targets are added regardless of `existsSync` checks (useful on fresh machines).

- [ ] **Step 1: Write the failing tests**

```ts
// src/cli/setup.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMcpEntries, detectTargets, applyConfig } from "./setup.js";

describe("buildMcpEntries", () => {
  it("returns tandem HTTP entry and channel node entry", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js");
    expect(entries.tandem).toEqual({ type: "http", url: "http://localhost:3479/mcp" });
    expect(entries["tandem-channel"].command).toBe("node");
    expect(entries["tandem-channel"].args).toEqual(["/abs/path/to/dist/channel/index.js"]);
    expect(entries["tandem-channel"].env).toEqual({ TANDEM_URL: "http://localhost:3479" });
  });
});

describe("applyConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tandem-setup-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates config file with tandem entries when file does not exist", async () => {
    const configPath = join(tmpDir, "mcp_settings.json");
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toEqual({ type: "http", url: "http://localhost:3479/mcp" });
    expect(written.mcpServers["tandem-channel"].command).toBe("node");
  });

  it("creates parent directory if it does not exist", async () => {
    const configPath = join(tmpDir, "nested", "dir", "mcp_settings.json");
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toBeDefined();
  });

  it("merges with existing config without overwriting other servers", async () => {
    const configPath = join(tmpDir, "mcp_settings.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { "my-other-server": { command: "foo" } } }));
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers["my-other-server"]).toEqual({ command: "foo" });
    expect(written.mcpServers.tandem).toBeDefined();
  });

  it("overwrites existing tandem entries", async () => {
    const configPath = join(tmpDir, "mcp_settings.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { tandem: { type: "http", url: "http://old:9999/mcp" } } }));
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem.url).toBe("http://localhost:3479/mcp");
  });

  it("overwrites malformed JSON with fresh config", async () => {
    const configPath = join(tmpDir, "mcp_settings.json");
    writeFileSync(configPath, "{ this is not json }}}");
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toBeDefined();
  });
});

describe("detectTargets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tandem-home-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects Claude Code when mcp_settings.json exists", async () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "mcp_settings.json"), "{}");
    const targets = await detectTargets({ homeOverride: tmpDir });
    expect(targets.some((t) => t.label === "Claude Code")).toBe(true);
  });

  it("detects Claude Code when only ~/.claude directory exists (no mcp_settings.json yet)", async () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    const targets = await detectTargets({ homeOverride: tmpDir });
    expect(targets.some((t) => t.label === "Claude Code")).toBe(true);
  });

  it("does not detect Claude Code when ~/.claude does not exist", async () => {
    const targets = await detectTargets({ homeOverride: tmpDir });
    expect(targets.some((t) => t.label === "Claude Code")).toBe(false);
  });

  it("detects Claude Code with --force even when ~/.claude is absent", async () => {
    const targets = await detectTargets({ homeOverride: tmpDir, force: true });
    expect(targets.some((t) => t.label === "Claude Code")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- src/cli/setup.test.ts
```

Expected: FAIL — `Cannot find module './setup.js'`

- [ ] **Step 3: Implement `src/cli/setup.ts`**

```ts
// src/cli/setup.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { writeFile, rename, copyFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Absolute path to dist/channel/index.js (sibling of dist/cli/)
const CHANNEL_DIST = resolve(__dirname, "../channel/index.js");

export interface McpEntry {
  type?: "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpEntries {
  tandem: McpEntry;
  "tandem-channel": McpEntry;
}

export function buildMcpEntries(channelPath: string): McpEntries {
  return {
    tandem: {
      type: "http",
      url: "http://localhost:3479/mcp",
    },
    "tandem-channel": {
      command: "node",
      args: [channelPath],
      env: { TANDEM_URL: "http://localhost:3479" },
    },
  };
}

export interface DetectedTarget {
  label: string;
  configPath: string;
}

interface DetectOptions {
  homeOverride?: string;
  force?: boolean;
}

export async function detectTargets(opts: DetectOptions = {}): Promise<DetectedTarget[]> {
  const home = opts.homeOverride ?? homedir();
  const targets: DetectedTarget[] = [];

  // Claude Code — cross-platform.
  // Detect if the config file exists OR if ~/.claude directory exists
  // (Claude Code creates ~/.claude at install; mcp_settings.json may not exist yet).
  // With --force, always include regardless.
  const claudeCodeConfig = join(home, ".claude", "mcp_settings.json");
  const claudeCodeDir = dirname(claudeCodeConfig);
  if (opts.force || existsSync(claudeCodeConfig) || existsSync(claudeCodeDir)) {
    targets.push({ label: "Claude Code", configPath: claudeCodeConfig });
  }

  // Claude Desktop — platform-specific.
  // Only detect if the config file already exists (user has launched Desktop at least once).
  // With --force, always include.
  let desktopConfig: string | null = null;
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    desktopConfig = join(appdata, "Claude", "claude_desktop_config.json");
  } else if (process.platform === "darwin") {
    desktopConfig = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else {
    desktopConfig = join(home, ".config", "claude", "claude_desktop_config.json");
  }

  if (desktopConfig && (opts.force || existsSync(desktopConfig))) {
    targets.push({ label: "Claude Desktop", configPath: desktopConfig });
  }

  return targets;
}

/**
 * Atomic write: write to a temp file in the SAME directory as the destination,
 * then rename. Using the same directory avoids EXDEV errors on Windows when
 * %TEMP% and %APPDATA% are on different drives.
 */
async function atomicWrite(content: string, dest: string): Promise<void> {
  const tmp = join(dirname(dest), `.tandem-setup-${randomUUID()}.json.tmp`);
  await writeFile(tmp, content, "utf-8");
  try {
    await rename(tmp, dest);
  } catch (err) {
    // EXDEV: cross-device link — fall back to copy + delete
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(tmp, dest);
      await unlink(tmp);
    } else {
      await unlink(tmp).catch(() => {}); // clean up temp on other errors
      throw err;
    }
  }
}

export async function applyConfig(configPath: string, entries: McpEntries): Promise<void> {
  // Read existing config or start fresh
  let existing: { mcpServers?: Record<string, McpEntry> } = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // Malformed JSON — overwrite with fresh config
    }
  }

  const updated = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      ...entries,
    },
  };

  // Ensure directory exists before writing
  mkdirSync(dirname(configPath), { recursive: true });

  await atomicWrite(JSON.stringify(updated, null, 2) + "\n", configPath);
}

/** Run the setup command. Writes MCP config to all detected Claude installs. */
export async function runSetup(opts: { force?: boolean } = {}): Promise<void> {
  console.error("\nTandem Setup\n");
  console.error("Detecting Claude installations...");

  const targets = await detectTargets({ force: opts.force });

  if (targets.length === 0) {
    console.error(
      "  No Claude installations detected.\n" +
        "  If Claude Code is installed, ensure ~/.claude exists.\n" +
        "  You can force configuration to default paths with: tandem setup --force",
    );
    return;
  }

  for (const t of targets) {
    console.error(`  Found: ${t.label} (${t.configPath})`);
  }

  console.error("\nWriting MCP configuration...");
  const entries = buildMcpEntries(CHANNEL_DIST);

  for (const t of targets) {
    try {
      await applyConfig(t.configPath, entries);
      console.error(`  \x1b[32m✓\x1b[0m ${t.label}`);
    } catch (err) {
      console.error(`  \x1b[31m✗\x1b[0m ${t.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.error("\nSetup complete! Start Tandem with: tandem");
  console.error("Then in Claude, your tandem_* tools will be available.\n");
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/cli/setup.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup.ts src/cli/setup.test.ts
git commit -m "feat(cli): setup command detects Claude installs and writes MCP config"
```

---

## Task 4: `start.ts` — spawn server and open browser

**Files:**
- Create: `src/cli/start.ts`

`start` is thin: it resolves the server bundle path, spawns it as a child process with `TANDEM_OPEN_BROWSER=1`, inherits stdio, and forwards signals. On Windows, `SIGTERM` is emulated — `proc.kill()` with no argument sends `SIGTERM` on Unix and calls `TerminateProcess` on Windows, which is the correct cross-platform approach.

- [ ] **Step 1: Implement `src/cli/start.ts`**

```ts
// src/cli/start.ts
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIST = resolve(__dirname, "../server/index.js");

export function runStart(): void {
  console.error("[Tandem] Starting server...");

  const proc = spawn("node", [SERVER_DIST], {
    stdio: "inherit",
    env: { ...process.env, TANDEM_OPEN_BROWSER: "1" },
  });

  proc.on("error", (err) => {
    console.error(`[Tandem] Failed to start server: ${err.message}`);
    process.exit(1);
  });

  proc.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  // Forward signals — proc.kill() with no argument uses SIGTERM on Unix
  // and TerminateProcess on Windows (correct cross-platform behavior).
  // SIGINT on Windows propagates to the child via the process group; the
  // handler here is a safety net for other SIGTERM senders.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      proc.kill();
    });
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/cli/start.ts
git commit -m "feat(cli): start command spawns server with browser open"
```

---

## Task 5: `index.ts` — CLI entrypoint

**Files:**
- Create: `src/cli/index.ts`

The version is injected at build time via tsup `define` (Task 6) as `__TANDEM_VERSION__`. The file uses a `declare const` so TypeScript is happy.

- [ ] **Step 1: Implement `src/cli/index.ts`**

```ts
#!/usr/bin/env node
/**
 * Tandem CLI — entry point for the `tandem` global command.
 *
 * Usage:
 *   tandem            Start the Tandem server and open the browser
 *   tandem setup      Register Tandem MCP tools with Claude Code / Claude Desktop
 *   tandem setup --force  Register even if no Claude install is auto-detected
 *   tandem --help     Show this help
 *   tandem --version  Show version
 */

// Injected at build time by tsup define; declared here for TypeScript
declare const __TANDEM_VERSION__: string;
const version = typeof __TANDEM_VERSION__ !== "undefined" ? __TANDEM_VERSION__ : "0.0.0-dev";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`tandem v${version}

Usage:
  tandem                  Start Tandem server and open the browser
  tandem setup            Register MCP tools with Claude Code / Claude Desktop
  tandem setup --force    Register to default paths regardless of detection
  tandem --version
  tandem --help
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
  process.exit(0);
}

if (args[0] === "setup") {
  const { runSetup } = await import("./setup.js");
  await runSetup({ force: args.includes("--force") });
} else {
  const { runStart } = await import("./start.js");
  runStart();
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): tandem CLI entrypoint with start and setup subcommands"
```

---

## Task 6: Bundle CLI via tsup (with version injection)

**Files:**
- Modify: `tsup.config.ts`

The CLI entry bakes the version in via `define` so `dist/cli/index.js` doesn't need to find `package.json` at runtime (which would fail in a global install where `../../package.json` doesn't exist).

- [ ] **Step 1: Update `tsup.config.ts`**

```ts
import { defineConfig } from "tsup";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("./package.json") as { version: string };

export default defineConfig([
  {
    entry: ["src/server/index.ts"],
    outDir: "dist/server",
    format: ["esm"],
    target: "node22",
    platform: "node",
    splitting: false,
    clean: true,
    dts: false,
    sourcemap: true,
  },
  {
    entry: ["src/channel/index.ts"],
    outDir: "dist/channel",
    format: ["esm"],
    target: "node22",
    platform: "node",
    splitting: false,
    clean: true,
    dts: false,
    sourcemap: true,
  },
  {
    entry: ["src/cli/index.ts"],
    outDir: "dist/cli",
    format: ["esm"],
    target: "node22",
    platform: "node",
    splitting: false,
    clean: true,
    dts: false,
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
    define: {
      __TANDEM_VERSION__: JSON.stringify(pkg.version),
    },
  },
]);
```

- [ ] **Step 2: Build and verify**

```bash
npm run build:server
```

Expected: `dist/cli/index.js` exists, starts with `#!/usr/bin/env node`, and contains the version string baked in (not a `require` call).

```bash
grep __TANDEM_VERSION__ dist/cli/index.js  # should find nothing (replaced by value)
node dist/cli/index.js --version           # should print current version
node dist/cli/index.js --help
```

- [ ] **Step 3: Commit**

```bash
git add tsup.config.ts
git commit -m "build: bundle CLI via tsup with version baked in via define"
```

---

## Task 7: Update package.json for publishing

**Files:**
- Modify: `package.json`

Changes:
- Remove `"private": true`
- Rename `"name"` to `"tandem-editor"`
- Add description, keywords, license
- Add `"bin": { "tandem": "./dist/cli/index.js" }`
- Add `"main": "./dist/cli/index.js"`
- Add `"files": ["dist/", "sample/"]` — `sample/` included so welcome.md is available on global install; `packages/` excluded (tandem-doc is a separate publication)
- Add `"exports"` for the CLI entrypoint
- Add `"workspaces": ["packages/*"]` for tandem-doc local development
- Add `"prepublishOnly": "npm run build"`

- [ ] **Step 1: Apply changes to `package.json`**

Replace the opening section (through `"scripts"`) with:

```json
{
  "name": "tandem-editor",
  "version": "0.1.0",
  "description": "Collaborative AI-human document editor with MCP tool integration for Claude",
  "keywords": ["tandem", "mcp", "claude", "editor", "ai", "collaborative"],
  "license": "MIT",
  "type": "module",
  "main": "./dist/cli/index.js",
  "bin": {
    "tandem": "./dist/cli/index.js"
  },
  "files": [
    "dist/",
    "sample/"
  ],
  "exports": {
    ".": "./dist/cli/index.js",
    "./dist/cli/index.js": "./dist/cli/index.js"
  },
  "workspaces": [
    "packages/*"
  ],
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "dev": "vite",
    "dev:standalone": "concurrently \"vite\" \"tsx watch src/server/index.ts\"",
    "dev:client": "vite",
    "dev:server": "tsx watch src/server/index.ts",
    "build": "npm run typecheck && vite build && tsup",
    "build:server": "tsup",
    "typecheck": "tsc -p tsconfig.server.json --noEmit && tsc --noEmit",
    "server": "tsx src/server/index.ts",
    "start:server": "node dist/server/index.js",
    "channel": "tsx src/channel/index.ts",
    "start:channel": "node dist/channel/index.js",
    "test": "vitest",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "preview": "vite preview",
    "lint": "eslint .",
    "format": "biome format --write .",
    "doctor": "node scripts/doctor.mjs",
    "prepare": "husky",
    "prepublishOnly": "npm run build"
  },
```

(Leave `"lint-staged"`, `"dependencies"`, and `"devDependencies"` unchanged.)

- [ ] **Step 2: Run tests to confirm nothing broke**

```bash
npm test
```

Expected: all existing tests pass.

- [ ] **Step 3: Verify `npm pack --dry-run` includes correct files and excludes source**

```bash
npm run build && npm pack --dry-run 2>&1
```

Expected:
- `dist/client/`, `dist/server/`, `dist/channel/`, `dist/cli/` are listed
- `sample/welcome.md` is listed
- `src/` is NOT listed
- `packages/` is NOT listed

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: rename to tandem-editor, add bin/files/exports/workspaces for npm publish"
```

---

## Task 8: tandem-doc stub package

**Files:**
- Create: `packages/tandem-doc/package.json`
- Create: `packages/tandem-doc/bin/tandem.mjs`

The stub installs `tandem-editor` as a workspace dependency (local path in dev, published version in prod) and exposes a `tandem` bin that delegates to it via `require.resolve`.

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p packages/tandem-doc/bin
```

- [ ] **Step 2: Create `packages/tandem-doc/package.json`**

```json
{
  "name": "tandem-doc",
  "version": "0.1.0",
  "description": "Alias for tandem-editor — collaborative AI-human document editor",
  "type": "module",
  "bin": {
    "tandem": "./bin/tandem.mjs"
  },
  "dependencies": {
    "tandem-editor": "*"
  },
  "engines": {
    "node": ">=22"
  },
  "keywords": ["tandem", "mcp", "claude", "editor", "ai"],
  "license": "MIT"
}
```

- [ ] **Step 3: Create `packages/tandem-doc/bin/tandem.mjs`**

```js
#!/usr/bin/env node
/**
 * tandem-doc → delegates to tandem-editor's CLI.
 * Install either package to get the `tandem` command.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// tandem-editor's "main" field points to dist/cli/index.js
const cliPath = require.resolve("tandem-editor");
await import(cliPath);
```

- [ ] **Step 4: Link tandem-editor locally for testing**

From the repo root (using npm workspaces):

```bash
# The workspace declaration in root package.json links packages/tandem-doc
npm install
# Now packages/tandem-doc/node_modules/tandem-editor is linked to the local build
node packages/tandem-doc/bin/tandem.mjs --version
```

Expected: prints the current tandem-editor version.

Note: `node packages/tandem-doc/bin/tandem.mjs --version` tests local linking. Full `npm install -g tandem-doc` only works after both packages are published to npm.

- [ ] **Step 5: Commit**

```bash
git add packages/tandem-doc/
git commit -m "feat: tandem-doc stub package aliasing tandem-editor"
```

---

## Task 9: Update doctor.mjs for global install awareness

**Files:**
- Modify: `scripts/doctor.mjs`

The doctor script currently checks for `.mcp.json` in the working directory. For global installs, the relevant check is whether the user-level MCP config has tandem registered.

- [ ] **Step 1: Add a check for user-level MCP registration in `scripts/doctor.mjs`**

Add after `checkMcpJson()` in the file:

```js
// ── Check: user-level MCP config (global install path) ─────────────

function checkUserMcpConfig() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const claudeCodePath = join(home, ".claude", "mcp_settings.json");

  if (!existsSync(claudeCodePath)) {
    warn(
      "~/.claude/mcp_settings.json not found",
      "Run: tandem setup  (or ignore if using project-local .mcp.json)",
    );
    return;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(claudeCodePath, "utf-8"));
  } catch {
    warn("~/.claude/mcp_settings.json is malformed JSON", "Run: tandem setup to rewrite it");
    return;
  }

  const servers = config?.mcpServers ?? {};
  if (!servers.tandem) {
    warn("tandem not registered in ~/.claude/mcp_settings.json", "Run: tandem setup");
  } else {
    pass("tandem registered in ~/.claude/mcp_settings.json");
  }
  if (!servers["tandem-channel"]) {
    warn("tandem-channel not registered in ~/.claude/mcp_settings.json", "Run: tandem setup");
  } else {
    pass("tandem-channel registered in ~/.claude/mcp_settings.json");
  }
}
```

Then call `checkUserMcpConfig()` inside `main()` after the existing checks.

- [ ] **Step 2: Run the doctor**

```bash
npm run doctor
```

Expected: new check reports pass/warn based on current state.

- [ ] **Step 3: Commit**

```bash
git add scripts/doctor.mjs
git commit -m "feat(doctor): check user-level MCP registration for global install"
```

---

## Task 10: End-to-end smoke test

No new code — verifies the full global install flow.

- [ ] **Step 1: Full build**

```bash
npm run build
```

Expected: `dist/client/`, `dist/server/`, `dist/channel/`, `dist/cli/` all populated. `dist/cli/index.js` starts with `#!/usr/bin/env node`.

- [ ] **Step 2: Simulate global install (stop dev server first if running)**

```bash
npm install -g .
```

Expected: `tandem` command available in PATH.

- [ ] **Step 3: Test `--version` and `--help`**

```bash
tandem --version   # should print 0.1.0 (not 0.0.0-dev)
tandem --help
```

- [ ] **Step 4: Test setup command**

```bash
tandem setup
```

Expected: detects Claude Code, writes tandem + tandem-channel entries, prints confirmation.

```bash
cat ~/.claude/mcp_settings.json
```

Expected: contains `"tandem"` and `"tandem-channel"` with absolute paths to the globally installed `dist/channel/index.js`.

- [ ] **Step 5: Test start command**

```bash
tandem
```

Expected: server starts, browser opens to `http://localhost:3479`, Tandem UI loads.

- [ ] **Step 6: Verify MCP tools work from a different directory**

Open Claude Code in a new terminal pointed at a different project directory. Run `/mcp` to list servers.

Expected: `tandem` and `tandem-channel` appear in the MCP server list.

- [ ] **Step 7: Uninstall and clean up**

```bash
npm uninstall -g tandem-editor
```

- [ ] **Step 8: Final commit**

```bash
git commit --allow-empty -m "chore: e2e global install smoke test verified"
```
