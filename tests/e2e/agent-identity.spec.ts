import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { E2E_MCP_PORT } from "../../scripts/test-ports";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants";
import {
  cleanupAllOpenDocuments,
  E2E_PAGE_ORIGIN,
  expectOnlyAllowanceNotices,
  McpTestClient,
  resetLocalModelState,
} from "./helpers";
import { PICKER_TITLE } from "./local-model-strings";

// Local models ship dark: the first-run window never mounts while the flag is
// off, so this whole file is skipped there (pinned by
// tests/scripts/e2e-local-model-skip-wiring.test.ts; the flip deletes it).
test.skip(!BYO_MODELS_ENABLED, "Models UI gated off until BYO_MODELS_ENABLED (#1123)");

/**
 * The first-run local-model window (#1123; Bryan's pick W1 of 2026-11-17,
 * "Cheaper: tied to the setup wizard"; rewritten in #1123 PR 8a).
 *
 * The window is offered once, when the setup wizard that opened by itself
 * closes on its Done screen with Claude Code or Claude Desktop applied, the
 * model list loaded and empty, and the window never dismissed. The E2E server
 * runs with `TANDEM_DISABLE_FIRST_RUN_WIZARD=1` and answers `needed: false`, so
 * this spec drives the wizard through ROUTED fetches:
 *  - `first-run-needed` is fetched from the real server and answered with
 *    `needed: true`, `walkthrough: false` and a fresh `launchId` per fetch (so a
 *    reload is a new launch for the wizard's closed-for-launch latch);
 *  - `existing` answers one Claude Code install whose config is missing;
 *  - the saved setup (`GET /api/integrations`) is read from the server;
 *  - the persist `POST /api/integrations` and the `apply` POST are answered
 *    here and never reach the server: they would write `integrations.json` and
 *    a Claude config that `integration-wizard.spec.ts` reads later in the run;
 *  - any other write under `/api/integrations/` is aborted and recorded, and
 *    the test fails on it (the installer, Keep, secrets); other reads go to the
 *    server.
 * After each test Node checks the server's saved setup is still empty.
 *
 * Not covered here: a local model's turn producing an agent-authored
 * annotation is covered by vitest (ADR-039, Ruling R-e5); chat against a stub
 * model server is #1123 PR 8b.
 */

// The base config seeds `tandem:modelPickerDismissed` for every spec so the
// first-run window stays out of the way (RW-6); this spec is the one that
// expects that window, so it starts from empty storage.
test.use({ storageState: { cookies: [], origins: [] } });

const WIZARD = "[data-testid='integration-wizard']";
const WINDOW = "[data-testid='first-run-model-modal']";

let mcp: McpTestClient;
let tmpDir: string;
let unexpected: string[] = [];

/** How the routed apply answers the Claude Code row. */
type ApplyAs = "applied" | "error";

async function routeWizard(page: Page, applyAs: ApplyAs = "applied"): Promise<void> {
  // Registered first, so it is consulted last: a write the handlers below do
  // not answer is refused and recorded, never sent to the server (the
  // installer, Keep, secrets). A read the wizard makes on the way (for
  // example `claude-cli-status`) goes to the server: GETs change nothing.
  await page.route("**/api/integrations/**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fallback();
    unexpected.push(`${req.method()} ${new URL(req.url()).pathname}`);
    await route.abort();
  });
  await page.route("**/api/integrations/first-run-needed", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({
      response: res,
      json: { ...body, needed: true, walkthrough: false, launchId: randomUUID() },
    });
  });
  await page.route("**/api/integrations/existing", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: {
        installs: [
          {
            target: {
              label: "Claude Code",
              configPath: path.join(tmpDir, ".claude.json"),
              kind: "claude-code",
            },
            status: "missing",
          },
        ],
      },
    });
  });
  await page.route("**/api/integrations/apply", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const { ids } = route.request().postDataJSON() as { ids: string[] };
    await route.fulfill({
      json: {
        results: ids.map((id) =>
          applyAs === "applied"
            ? { id, status: "applied" }
            : { id, status: "error", code: "WRITE_FAILED", message: "routed failure" },
        ),
        nextNonce: "e2e-nonce-next",
      },
    });
  });
  await page.route("**/api/integrations", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fallback();
    if (req.method() !== "POST") {
      unexpected.push(`${req.method()} /api/integrations`);
      return route.abort();
    }
    const file = req.postDataJSON() as { integrations: Array<{ id: string }> };
    await route.fulfill({
      json: { ids: file.integrations.map((i) => i.id), confirmationNonce: "e2e-nonce" },
    });
  });
}

/** Wait for the page's model list to load: the window is decided only after. */
function modelsLoaded(page: Page) {
  return page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/models" && res.request().method() === "GET",
  );
}

/** Drive the visible auto-opened wizard to its Done screen and press Done. */
async function finishWizard(page: Page): Promise<void> {
  await expect(page.locator(WIZARD)).toBeVisible();
  await expect(page.locator(WINDOW)).toHaveCount(0);
  await page.locator("[data-testid='integration-wizard-connect-btn']").click();
  await expect(page.locator("[data-testid='integration-wizard-step-done']")).toBeVisible();
  await page.locator("[data-testid='integration-wizard-done-close']").click();
  await expect(page.locator(WIZARD)).toHaveCount(0);
}

/**
 * A settle point for "the window did not open": the wizard's close decides
 * synchronously, and the Settings modal opening is refused while the window
 * is up (RW-2). So once Settings opens and closes, the decision is behind us.
 */
async function settleAfterClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as { __tandemTest: { openSettingsModal: () => void } }
    ).__tandemTest.openSettingsModal();
  });
  await expect(page.locator("[data-testid='settings-modal']")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid='settings-modal']")).toHaveCount(0);
}

async function serverSavedSetup(): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${E2E_MCP_PORT}/api/integrations`, {
    headers: { Origin: E2E_PAGE_ORIGIN },
  });
  if (!res.ok) throw new Error(`GET /api/integrations answered ${res.status}`);
  return ((await res.json()) as { integrations?: unknown } | null)?.integrations;
}

test.beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-agent-identity-"));
  fs.writeFileSync(path.join(tmpDir, "sample.md"), "# Sample\n\nA paragraph.\n");
  mcp = new McpTestClient();
  await mcp.connect();
});

test.afterAll(async () => {
  await cleanupAllOpenDocuments(mcp).catch(() => {});
  await mcp.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await resetLocalModelState("agent-identity");
  expect(await serverSavedSetup()).toEqual([]);
  unexpected = [];
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
});

test.afterEach(async ({ page }) => {
  if (!BYO_MODELS_ENABLED) return;
  try {
    expect(unexpected, "a wizard request reached no handler").toEqual([]);
    expect(await serverSavedSetup(), "the routed wizard wrote the real setup").toEqual([]);
    await expectOnlyAllowanceNotices(page);
  } finally {
    await resetLocalModelState("agent-identity");
  }
});

test("the window is offered when the wizard closes on Done with Claude set up, not before", async ({
  page,
}) => {
  await routeWizard(page);
  const loaded = modelsLoaded(page);
  await page.goto("/");
  await loaded;
  await finishWizard(page);

  const window = page.locator(WINDOW);
  await expect(window).toBeVisible();
  await expect(window).toContainText(PICKER_TITLE);
  const providers = await page
    .locator("[data-testid='first-run-providers'] input[type='radio']")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(providers.length).toBeGreaterThan(0);
  expect(providers.filter((v) => !v.startsWith("local-"))).toEqual([]);
});

test("closing the window is remembered: a later setup on a new launch offers nothing", async ({
  page,
}) => {
  await routeWizard(page);
  await page.goto("/");
  await finishWizard(page);
  await expect(page.locator(WINDOW)).toBeVisible();
  await page.locator("[data-testid='first-run-skip']").click();
  await expect(page.locator(WINDOW)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("tandem:modelPickerDismissed"))).toBe("1");

  // A new launch (fresh launchId) with the wizard's own dismissal cleared: the
  // wizard opens again and is set up again, and the window stays shut.
  await page.evaluate(() => localStorage.removeItem("tandem:wizard-dismissed"));
  const reloaded = modelsLoaded(page);
  await page.reload();
  await reloaded;
  await finishWizard(page);
  await settleAfterClose(page);
  await expect(page.locator(WINDOW)).toHaveCount(0);
});

test("closing the wizard before Done offers no window", async ({ page }) => {
  await routeWizard(page);
  const loaded = modelsLoaded(page);
  await page.goto("/");
  await loaded;
  await expect(page.locator(WIZARD)).toBeVisible();
  await page.locator("[data-testid='integration-wizard-close']").click();
  await expect(page.locator(WIZARD)).toHaveCount(0);
  await settleAfterClose(page);
  await expect(page.locator(WINDOW)).toHaveCount(0);
});

test("Done with no Claude row applied offers no window", async ({ page }) => {
  await routeWizard(page, "error");
  const loaded = modelsLoaded(page);
  await page.goto("/");
  await loaded;
  await finishWizard(page);
  await settleAfterClose(page);
  await expect(page.locator(WINDOW)).toHaveCount(0);
});
