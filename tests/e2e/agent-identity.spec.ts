import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants";
import { cleanupAllOpenDocuments, McpTestClient } from "./helpers";

/**
 * Per-agent identity choreography E2E (#1123 M4).
 *
 * SKIP-GUARDED, exactly like `settings-models.spec.ts`: the first-run model
 * picker and the titlebar default-model chip are gated behind
 * `BYO_MODELS_ENABLED`, so with the flag off this whole suite is skipped and
 * auto-enables the moment the flag flips at v1.0 — the flip inherits real
 * browser coverage of the choreography for free.
 *
 * NOT covered here (a documented flip-time deliverable, per the M4 plan): driving
 * the local-model loop end-to-end against a stub OpenAI-compatible server so a
 * real model turn produces an agent-authored annotation. That harness does not
 * exist yet; these tests cover the flag-gated UI choreography, which derives from
 * client state and needs no model server. The per-agent decoration COLOR + byline
 * rendering is covered at the unit/component layer (agent-color.test.ts,
 * annotation-decoration.test.ts, annotation-card-header.test.ts, reply-thread.test.ts,
 * marginLeaderGeometry.test.ts).
 */

let mcp: McpTestClient;
let tmpDir: string;

test.beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-agent-identity-"));
  fs.writeFileSync(path.join(tmpDir, "sample.md"), "# Sample\n\nA paragraph.\n");
  mcp = new McpTestClient();
});

test.afterAll(async () => {
  await cleanupAllOpenDocuments(mcp).catch(() => {});
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  // Flag off ⇒ the model picker + chip never render; skip reversibly (re-enables
  // at the BYO_MODELS_ENABLED flip). See settings-models.spec.ts for the twin.
  test.skip(!BYO_MODELS_ENABLED, "Agent-identity UI gated off until BYO_MODELS_ENABLED (#1123)");
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("http://127.0.0.1:5173");
});

test("first-run picker appears on a fresh boot with no configured model", async ({ page }) => {
  // Decoupled from the tutorial (#1123 M4): the picker shows purely from registry
  // state — BYO on, no default configured, not dismissed.
  await expect(page.locator("[data-testid='first-run-model-modal']")).toBeVisible();
});

test("skipping the picker persists dismissal across a reload (no re-nag)", async ({ page }) => {
  await page.locator("[data-testid='first-run-model-modal']").waitFor();
  await page.locator("[data-testid='first-run-skip']").click();
  await expect(page.locator("[data-testid='first-run-model-modal']")).toHaveCount(0);
  // Reload: a persisted dismissal (localStorage) must keep it closed — the M4
  // fix for the M2b replay re-summon edge.
  await page.reload();
  await expect(page.locator("[data-testid='first-run-model-modal']")).toHaveCount(0);
});
