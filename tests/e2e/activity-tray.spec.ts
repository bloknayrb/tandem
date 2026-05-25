import { expect, type Page, test } from "@playwright/test";
import path from "path";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
} from "./helpers";

// Activity center (sub-PR 1.10a): the bottom-right pill + expandable tray, fed
// by the same notification store as the transient toast pops. Notifications are
// injected via the dev-only `__tandemTest.pushNotification` hook to avoid the
// SSE-connect race (the server notify-stream has no buffer replay, so a
// notification pushed before the EventSource connects would be lost). This
// drives the real client `push` → ingest path, identical to production echoes.

let mcp: McpTestClient;
let tmpDir: string;

interface InjectableNotification {
  id: string;
  type: string;
  severity: "info" | "warning" | "error";
  message: string;
  dedupKey?: string;
  documentId?: string;
}

async function pushNotification(page: Page, n: InjectableNotification): Promise<void> {
  await page.evaluate((notification) => {
    const w = window as unknown as {
      __tandemTest?: { pushNotification: (x: unknown) => void };
    };
    if (!w.__tandemTest?.pushNotification) {
      throw new Error(
        "__tandemTest.pushNotification is not installed — App.svelte must export it in dev builds",
      );
    }
    w.__tandemTest.pushNotification({ ...notification, timestamp: Date.now() });
  }, n);
}

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = createFixtureDir("sample.md");
});

test.afterEach(async () => {
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

async function openEditor(page: Page): Promise<void> {
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
  await page.goto("/");
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });
}

test("pill shows the empty state and toggles the tray open and closed", async ({ page }) => {
  await openEditor(page);

  const pill = page.locator("[data-testid='activity-pill']");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("No activity");
  await expect(pill).toHaveAttribute("aria-expanded", "false");

  // Tray is not mounted until opened.
  await expect(page.locator("[data-testid='activity-tray']")).toHaveCount(0);

  await pill.click();
  await expect(page.locator("[data-testid='activity-tray']")).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("[data-testid='activity-empty']")).toContainText("Nothing to report.");

  await pill.click();
  await expect(page.locator("[data-testid='activity-tray']")).toHaveCount(0);
  await expect(pill).toHaveAttribute("aria-expanded", "false");
});

test("warning notification pops a transient toast AND lands in the tray", async ({ page }) => {
  await openEditor(page);

  await pushNotification(page, {
    id: "warn-1",
    type: "annotation-error",
    severity: "warning",
    message: "Your AI tried a deprecated tool.",
  });

  // Transient pop appears.
  const toast = page.locator("[data-testid='toast-warn-1']");
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText("Your AI tried a deprecated tool.");

  // Pill reflects the count; tray row carries the same message.
  const pill = page.locator("[data-testid='activity-pill']");
  await expect(pill).toContainText("1");
  await pill.click();
  await expect(page.locator("[data-testid='activity-row-warn-1']")).toContainText(
    "Your AI tried a deprecated tool.",
  );
});

test("dismissing the pop leaves the tray entry; dismissing the row removes it", async ({
  page,
}) => {
  await openEditor(page);

  await pushNotification(page, {
    id: "err-1",
    type: "general-error",
    severity: "error",
    message: "Something went wrong.",
  });

  const toast = page.locator("[data-testid='toast-err-1']");
  await expect(toast).toBeVisible({ timeout: 5_000 });

  // Dismiss the transient pop — the tray entry must survive.
  await page.locator("[data-testid='toast-dismiss-err-1']").click();
  await expect(toast).toHaveCount(0);

  const pill = page.locator("[data-testid='activity-pill']");
  await pill.click();
  const row = page.locator("[data-testid='activity-row-err-1']");
  await expect(row).toBeVisible();

  // Dismiss the tray row — now it is gone and the pill is empty.
  await page.locator("[data-testid='activity-dismiss-err-1']").click();
  await expect(row).toHaveCount(0);
  await expect(page.locator("[data-testid='activity-empty']")).toBeVisible();
});

test("Clear all empties the tray", async ({ page }) => {
  await openEditor(page);

  await pushNotification(page, {
    id: "e1",
    type: "general-error",
    severity: "error",
    message: "First error.",
  });
  await pushNotification(page, {
    id: "e2",
    type: "general-error",
    severity: "error",
    message: "Second error.",
  });

  const pill = page.locator("[data-testid='activity-pill']");
  await expect(pill).toContainText("2");
  await pill.click();

  await expect(page.locator("[data-testid='activity-row-e1']")).toBeVisible();
  await expect(page.locator("[data-testid='activity-row-e2']")).toBeVisible();

  await page.locator("[data-testid='activity-clear-all']").click();
  await expect(page.locator("[data-testid='activity-empty']")).toBeVisible();
  await expect(pill).toContainText("No activity");
});

test("activity persists across a page reload", async ({ page }) => {
  await openEditor(page);

  await pushNotification(page, {
    id: "persist-1",
    type: "general-error",
    severity: "error",
    message: "Survives reload.",
  });

  const pill = page.locator("[data-testid='activity-pill']");
  await expect(pill).toContainText("1");

  // The localStorage write is debounced (250ms); a hard reload tears down the
  // JS context without a graceful unmount, so poll until the entry is durable
  // before reloading rather than racing the debounce.
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("tandem:activityHistory") ?? ""))
    .toContain("persist-1");

  await page.reload();
  await expect(page.locator(".tandem-editor")).toBeVisible({ timeout: 10_000 });

  // Rehydrated from localStorage — error severity is not TTL-pruned.
  await expect(page.locator("[data-testid='activity-pill']")).toContainText("1");
  await page.locator("[data-testid='activity-pill']").click();
  await expect(page.locator("[data-testid='activity-row-persist-1']")).toContainText(
    "Survives reload.",
  );
});

test("a save-error row shows Retry, and clicking it re-runs the save for that doc", async ({
  page,
}) => {
  await openEditor(page);

  // Intercept the save POST so no real disk write happens, and capture the
  // documentId the Retry button forwards to triggerSave.
  let savedDocumentId: string | null = null;
  await page.route("**/api/save", async (route) => {
    if (route.request().method() === "POST") {
      savedDocumentId =
        (route.request().postDataJSON() as { documentId?: string }).documentId ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "saved" }),
      });
    } else {
      await route.continue();
    }
  });

  // Target the genuinely-open active doc so onAction reaches triggerSave
  // (rather than the closed-doc "reopen to retry" fallback).
  const docId = await page.evaluate(() => {
    const w = window as unknown as { __tandemTest?: { activeDocumentId: () => string | null } };
    return w.__tandemTest?.activeDocumentId() ?? null;
  });
  expect(docId).toBeTruthy();

  await pushNotification(page, {
    id: "save-err-1",
    type: "save-error",
    severity: "error",
    message: "Save failed: disk full",
    documentId: docId as string,
  });

  await page.locator("[data-testid='activity-pill']").click();
  const retry = page.locator("[data-testid='activity-action-save-err-1']");
  await expect(retry).toBeVisible();
  await expect(retry).toContainText("Retry");

  await retry.click();
  await expect.poll(() => savedDocumentId).toBe(docId);
});
