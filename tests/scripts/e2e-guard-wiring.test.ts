import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import rootConfig from "../../playwright.config";
import { E2E_APP_DATA_BASENAME, E2E_APP_DATA_DIR } from "../../scripts/e2e-paths";
import shotConfig from "../../scripts/screenshots/playwright.config";
import { DEFAULT_MCP_PORT } from "../../src/shared/constants";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * A correct guard that Playwright never loads protects nothing, and until this
 * file existed nothing referenced `playwright.config.ts` at all — the key could
 * be deleted, or quietly reverted to a relative path, with no test failing.
 */
describe("e2e-guard wiring", () => {
  it("is wired as globalSetup and the file exists", () => {
    expect(rootConfig.globalSetup).toBe(path.resolve(ROOT, "scripts/e2e-guard.ts"));
    expect(existsSync(rootConfig.globalSetup as string)).toBe(true);
  });

  it("keeps globalSetup ABSOLUTE so child configs inherit it", () => {
    // Playwright resolves a relative globalSetup against the LOADED config's
    // dir, so `./scripts/e2e-guard.ts` becomes
    // `scripts/screenshots/scripts/e2e-guard.ts` under the screenshots config
    // and dies with MODULE_NOT_FOUND. This regression has happened once.
    expect(path.isAbsolute(rootConfig.globalSetup as string)).toBe(true);
  });

  it("is inherited by the screenshots config", () => {
    expect(shotConfig.globalSetup).toBe(rootConfig.globalSetup);
  });

  it("guards the port the backend webServer actually uses", () => {
    // The guard reads DEFAULT_MCP_PORT directly while the webServer entry
    // references it independently. #1492 proposes moving the E2E backend to its
    // own port, which would desynchronize them silently — this fails first.
    const entries = rootConfig.webServer as { url: string }[];
    expect(entries.some((w) => w.url.includes(`:${DEFAULT_MCP_PORT}`))).toBe(true);
  });
});

describe("e2e app-data basename", () => {
  it("agrees across all three copies", () => {
    // scripts/e2e-server.mjs deliberately does NOT import the constant — it
    // re-validates by basename before an `rm -rf`, and that independence is the
    // safety boundary. This assertion is what keeps the duplication honest.
    const launcher = readFileSync(path.join(ROOT, "scripts/e2e-server.mjs"), "utf8");
    expect(path.basename(E2E_APP_DATA_DIR)).toBe(E2E_APP_DATA_BASENAME);
    expect(launcher).toContain(`const E2E_APP_DATA_BASENAME = "${E2E_APP_DATA_BASENAME}"`);
  });
});

describe("related-test hook transport", () => {
  const hook = readFileSync(path.join(ROOT, ".claude/hooks/related-test.sh"), "utf8");

  it("resolves vitest by walking up, with npx as the fallback", () => {
    // A bare relative `node_modules/...` is not equivalent to npx: git
    // worktrees have `tests/` but no `node_modules`, so the hook would print
    // "Running related test:" for a run that died with ERR_MODULE_NOT_FOUND.
    expect(hook).toContain("node_modules/vitest/vitest.mjs");
    expect(hook).toContain("npx vitest run");
  });

  it("finds the vitest entry from the repo root", () => {
    expect(existsSync(path.join(ROOT, "node_modules/vitest/vitest.mjs"))).toBe(true);
  });
});
