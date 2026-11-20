import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants";
import { MODELS_SCHEMA_VERSION } from "../../src/shared/models/contract";
import type { ToolResponse } from "../../src/shared/types";
import {
  cleanupAllOpenDocuments,
  expectOnlyAllowanceNotices,
  McpTestClient,
  openAnnotatePopup,
  openChat,
  readServerAnswerer,
  resetLocalModelState,
  seedModels,
  selectTextStable,
  setServerAnswerer,
  submitAnnotation,
} from "./helpers";
import {
  LOCAL_COMMENT_INFO_TEXT,
  LOCAL_PERIOD_STATUS_LINE,
  RUN_FAILURE_NOT_FOUND,
} from "./local-model-strings";
import { type StubModel, startStubModel, userTexts } from "./local-model-stub";

// Local models ship dark: a dark server answers no chat with a local model, so
// this whole file is skipped there (pinned by
// tests/scripts/e2e-local-model-skip-wiring.test.ts; the flip deletes it).
test.skip(!BYO_MODELS_ENABLED, "Models UI gated off until BYO_MODELS_ENABLED (#1123)");

/**
 * Chat answered by a local model, against a stub model server (#1123 PR 8b;
 * ADR-039's amendment on E2E against a stubbed local model; closes #1123 M4's
 * "E2E against a stub OpenAI-compatible server").
 *
 * The model call is the E2E backend's, to the saved Endpoint, so the stub
 * (`local-model-stub.ts`) listens on a real loopback port and each test reads
 * what it received. Each test seeds one enabled local entry at the stub, named
 * "Stub Ollama", as the Default, and sets chat to the local model from Node
 * (an allowance write, which raises its warning notice: expected).
 *
 * Not covered here (Ruling R-e5): a local model writing a comment, its byline
 * on a card, Accept and editing off. The stub has no tool-call mode; those are
 * covered by vitest.
 */

const STUB_NAME = "Stub Ollama";
const STUB_MODEL_ID = "stub-model";
const STUB_REPLY = "Hello from the stub model.";
const COMPOSER = "[data-testid='chat-composer-input']";
const SEND = "[data-testid='chat-send-btn']";

let mcp: McpTestClient;
let stub: StubModel;
let tmpDir: string;
let filePath: string;
/** Warning texts this test expects on top of the allowance's notices. */
let expectedAlerts: string[] = [];

type InboxData = {
  summary?: string;
  localModelAnswersChat?: boolean;
  chatMessages: Array<{ text?: string }>;
  userActions: Array<{ content?: string }>;
};

async function inbox(): Promise<InboxData> {
  const res = (await mcp.callTool("tandem_checkInbox")) as ToolResponse<InboxData>;
  if (res.error !== false) throw new Error("tandem_checkInbox returned an error envelope");
  return res.data;
}

/** The completions requests whose user messages contain `text`. */
function requestsCarrying(text: string) {
  return stub.requests.filter(
    (r) => r.path === "/v1/chat/completions" && userTexts(r).some((t) => t.includes(text)),
  );
}

async function sendChat(page: Page, text: string): Promise<void> {
  await page.locator(COMPOSER).fill(text);
  await page.locator(SEND).click();
}

/** The chat bubble whose text includes `text`, and its author label. */
function bubbleWith(page: Page, text: string): { bubble: Locator; author: Locator } {
  const bubble = page
    .locator("[data-testid='chat-panel'] .chat-bubble")
    .filter({ hasText: text })
    .last();
  return { bubble, author: bubble.locator("[data-testid^='chat-author-']") };
}

async function commentOnFirstParagraph(page: Page, text: string): Promise<void> {
  const editor = page.locator(".tiptap");
  await editor.click();
  await selectTextStable(editor.locator("p").first());
  await openAnnotatePopup(page);
  await page.locator("[data-testid='popup-annotation-input']").fill(text);
  await submitAnnotation(page, "comment");
}

test.beforeAll(async () => {
  stub = await startStubModel();
  mcp = new McpTestClient();
  await mcp.connect();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-e2e-local-chat-"));
  filePath = path.join(tmpDir, "sample.md");
  fs.writeFileSync(filePath, "# Sample\n\nThe first paragraph of the sample.\n", "utf-8");
});

test.afterAll(async () => {
  // Reset before the stub goes: a registry left pointing at a closed port
  // could otherwise be answered by whatever takes that port next.
  try {
    await resetLocalModelState("local-model-chat");
  } finally {
    await stub?.close();
    if (mcp) {
      await cleanupAllOpenDocuments(mcp);
      await mcp.close();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test.beforeEach(async ({ page }) => {
  await resetLocalModelState("local-model-chat");
  expectedAlerts = [];
  stub.setMode({ kind: "reply", text: STUB_REPLY });
  stub.requests.length = 0;
  await mcp.callTool("tandem_open", { filePath });
  // A comment is held in Solo, which would hide it from test 4's inbox.
  const status = (await mcp.callTool("tandem_status")) as ToolResponse<{ mode: string }>;
  expect(status.error === false && status.data.mode).toBe("tandem");
  const id = "e2e-stub-ollama";
  await seedModels({
    schemaVersion: MODELS_SCHEMA_VERSION,
    models: [
      {
        id,
        provider: "local-ollama",
        displayName: STUB_NAME,
        modelId: STUB_MODEL_ID,
        endpoint: stub.url,
        enabled: true,
      },
    ],
    defaultModelId: id,
  });
  await setServerAnswerer("local");
  // Server notices reach the page only over the notify stream, with no replay
  // of a live push, so the stream must be open before any step whose result
  // is a notice.
  const notifyStream = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/api/notify-stream"),
  );
  await page.goto("/");
  await notifyStream;
  await expect(page.locator(".tiptap").locator("p").first()).toContainText("first paragraph", {
    timeout: 10_000,
  });
  await openChat(page);
});

test.afterEach(async ({ page }) => {
  if (!BYO_MODELS_ENABLED) return;
  try {
    await expectOnlyAllowanceNotices(page, expectedAlerts);
  } finally {
    await resetLocalModelState("local-model-chat");
  }
});

test("a chat is answered by the local model, labelled with its name; Claude's reply reads Claude", async ({
  page,
}) => {
  await sendChat(page, "hello local model");

  // The positive anchor: the stub was asked, with the text and the model id.
  await expect.poll(() => requestsCarrying("hello local model").length).toBe(1);
  const [req] = requestsCarrying("hello local model");
  expect((req.body as { model?: string }).model).toBe(STUB_MODEL_ID);

  const reply = bubbleWith(page, STUB_REPLY);
  await expect(reply.bubble).toBeVisible();
  // Upper-cased by CSS, so the text node is compared, not the rendered text.
  await expect.poll(async () => (await reply.author.textContent())?.trim()).toBe(STUB_NAME);

  const claudeText = "A reply from Claude itself.";
  await mcp.callTool("tandem_reply", { text: claudeText });
  const claude = bubbleWith(page, claudeText);
  await expect(claude.bubble).toBeVisible();
  await expect.poll(async () => (await claude.author.textContent())?.trim()).toBe("Claude");
});

test("while chat is set to the local model, Claude is handed nothing", async ({ page }) => {
  const text = "for the local model only";
  await sendChat(page, text);
  // Anchor: the message reached the local model before Claude's inbox is read.
  await expect.poll(() => requestsCarrying(text).length).toBe(1);

  const data = await inbox();
  expect(data.summary).toBe(LOCAL_PERIOD_STATUS_LINE);
  expect(data.localModelAnswersChat).toBe(true);
  expect(data.chatMessages.filter((m) => m.text?.includes(text))).toEqual([]);
});

test("a comment made while chat is set to the local model says it waits for Claude", async ({
  page,
}) => {
  // The notice depends on a live MCP session (this spec's client): wait until
  // the status pill shows one, in the local period's form.
  await expect(page.locator("[data-testid='status-ai-indicator']")).toHaveAttribute(
    "data-ai-state",
    "local-connected",
    { timeout: 15_000 },
  );
  await commentOnFirstParagraph(page, "a comment in the local period");
  const toast = page
    .locator("[data-testid='toast-container'] > [data-testid^='toast-']")
    .filter({ hasText: LOCAL_COMMENT_INFO_TEXT });
  await expect(toast).toHaveCount(1);
  await expect(toast.locator(".msg")).toHaveText(LOCAL_COMMENT_INFO_TEXT);
});

test("after the switch back to Claude, comments reach Claude and the local period's chat does not", async ({
  page,
}) => {
  const chatX = "chat sent while local";
  const commentC = "comment made while local";
  const chatY = "chat sent after the switch back";

  await sendChat(page, chatX);
  await expect.poll(() => requestsCarrying(chatX).length).toBe(1);
  await commentOnFirstParagraph(page, commentC);
  // The comment travels over the document's socket, the switch below over
  // HTTP: wait until the SERVER holds C, so C is a comment of the local
  // period and not one that landed after the switch back.
  await expect
    .poll(async () => {
      const res = (await mcp.callTool("tandem_getAnnotations")) as ToolResponse<{
        annotations: Array<{ content?: string }>;
      }>;
      return res.error === false && res.data.annotations.some((a) => a.content === commentC);
    })
    .toBe(true);

  await setServerAnswerer("claude");
  expect(await readServerAnswerer()).toBe("claude");
  await sendChat(page, chatY);

  // A cursor-less poll hands each item out once (an unacknowledged item
  // repeats only for a cursor reader), so everything handed over across the
  // polls is collected. Anchor: Y reaches Claude; only then are the
  // absences read.
  const chats: string[] = [];
  const actions: string[] = [];
  const summaries: Array<string | undefined> = [];
  await expect
    .poll(async () => {
      const data = await inbox();
      summaries.push(data.summary);
      chats.push(...data.chatMessages.map((m) => m.text ?? ""));
      actions.push(...data.userActions.map((a) => a.content ?? ""));
      return chats.some((t) => t.includes(chatY));
    })
    .toBe(true);
  expect(summaries).not.toContain(LOCAL_PERIOD_STATUS_LINE);
  expect(actions).toContain(commentC);
  expect(chats.filter((t) => t.includes(chatX))).toEqual([]);
  // A later anchor before reading the stub: a local run would start on the
  // same chat event that handed Y over, so wait for something after it.
  // Claude's reply is a separate pipeline, so this is a bound, not proof: a
  // local run started by Y would reach the stub long before this renders.
  const later = "Claude answers after the switch back.";
  await mcp.callTool("tandem_reply", { text: later });
  await expect(bubbleWith(page, later).bubble).toBeVisible();
  expect(requestsCarrying(chatY)).toEqual([]);
});

test("a failed run names its cause", async ({ page }) => {
  stub.setMode({ kind: "status", code: 404 });
  expectedAlerts = [RUN_FAILURE_NOT_FOUND];
  await sendChat(page, "this one fails");
  await expect.poll(() => requestsCarrying("this one fails").length).toBeGreaterThan(0);

  const alerts = page
    .locator("[data-testid='toast-container'] [role='alert']")
    .filter({ hasText: RUN_FAILURE_NOT_FOUND });
  await expect(alerts).toHaveCount(1);
});
