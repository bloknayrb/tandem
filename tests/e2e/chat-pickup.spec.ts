import path from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_MCP_PORT } from "../../scripts/test-ports.js";
import {
  cleanupAllOpenDocuments,
  cleanupFixtureDir,
  createFixtureDir,
  McpTestClient,
  openChat,
} from "./helpers";

/**
 * The pickup row under the user's latest chat message, driven end to end:
 * a real browser send, a real `tandem_checkInbox` read stamp, and real
 * `tandem_reply` calls — the ack with `inProgress` and the result after it.
 *
 * Every transition here is something the server or Claude recorded. The row
 * deliberately reads nothing from presence (`claudeActive` / `claudeWorking`),
 * so this spec never touches `tandem_status`.
 */

let mcp: McpTestClient;
let tmpDir: string;

test.beforeEach(async () => {
  mcp = new McpTestClient();
  await mcp.connect();
  // An open document, as every other chat spec has: the editor boots into it.
  tmpDir = createFixtureDir("sample.md");
  await mcp.callTool("tandem_open", { filePath: path.join(tmpDir, "sample.md") });
});

test.afterEach(async () => {
  // Chat lives in CTRL_ROOM and outlives the page, so clear it for the next spec.
  try {
    await fetch(`http://127.0.0.1:${E2E_MCP_PORT}/api/chat`, { method: "DELETE" });
  } catch {
    // Best-effort: a failure here must not mask the assertion that just ran.
  }
  await cleanupAllOpenDocuments(mcp);
  await mcp.close();
  cleanupFixtureDir(tmpDir);
});

interface InboxChat {
  id: string;
  text: string;
}

/** The chat bucket of a `tandem_checkInbox` result, whichever envelope it arrives in. */
function chatFrom(result: unknown): InboxChat[] {
  const r = result as { data?: { chatMessages?: InboxChat[] }; chatMessages?: InboxChat[] };
  return r.data?.chatMessages ?? r.chatMessages ?? [];
}

test("the pickup row follows a chat message from send to answer", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tandem-editor").waitFor({ state: "visible", timeout: 10_000 });
  await openChat(page);

  const row = page.locator("[data-testid='chat-pickup-status']");
  await page.locator("[data-testid='chat-composer-input']").fill("tighten the intro");
  await page.locator("[data-testid='chat-composer-input']").press("Enter");

  await expect(row).toHaveAttribute("data-pickup", "waiting", { timeout: 10_000 });
  await expect(row).toContainText("waiting for your AI to pick it up");

  const inbox = await mcp.callTool("tandem_checkInbox");
  const msg = chatFrom(inbox).find((m) => m.text === "tighten the intro");
  expect(msg, "the sent message reaches the inbox").toBeDefined();
  await expect(row).toHaveAttribute("data-pickup", "received", { timeout: 10_000 });
  await expect(row).toContainText("Your AI has your message");

  await mcp.callTool("tandem_reply", {
    text: "On it — tightening the intro now.",
    replyTo: msg!.id,
    inProgress: true,
  });
  await expect(row).toHaveAttribute("data-pickup", "working", { timeout: 10_000 });
  await expect(row).toContainText("Your AI is working on it");
  await expect(row.locator(".chat-typing-dot")).toHaveCount(3);

  await mcp.callTool("tandem_reply", {
    text: "Done: the intro is two sentences shorter.",
    replyTo: msg!.id,
  });
  await expect(row).toHaveCount(0, { timeout: 10_000 });
});
