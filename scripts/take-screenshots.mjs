/**
 * Screenshot script for README documentation.
 * Captures editor overview, side panel, toolbar, status bar, and onboarding screenshots.
 *
 * Requires the dev server to already be running: npm run dev:standalone
 * Run with: node scripts/take-screenshots.mjs
 */

import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SCREENSHOTS_DIR = path.join(REPO_ROOT, "docs", "screenshots");
const MCP_URL = "http://localhost:3479/mcp";
const SAMPLE_PATH = path.resolve(REPO_ROOT, "sample", "welcome.md");
const CLIENT_URL = process.env.TANDEM_CLIENT_URL || "http://localhost:5173";

// ── MCP helper ────────────────────────────────────────────────────────────────

class McpClient {
  constructor() {
    this.client = new Client({ name: "tandem-screenshot", version: "1.0.0" });
    this.connected = false;
  }

  async connect(retries = 10, delayMs = 1500) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
        await this.client.connect(transport);
        this.connected = true;
        console.log(`  MCP connected on attempt ${attempt}`);
        return;
      } catch (err) {
        if (attempt === retries) throw err;
        console.log(`  MCP connect attempt ${attempt}/${retries} failed, retrying...`);
        await sleep(delayMs);
      }
    }
  }

  async call(name, args = {}) {
    if (!this.connected) throw new Error("Not connected");
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const content = result.content;
      const msg = content?.find((c) => c.type === "text")?.text ?? "unknown error";
      throw new Error(`MCP "${name}" failed: ${msg}`);
    }
    const content = result.content;
    const textItem = content?.find((c) => c.type === "text");
    if (textItem?.text) {
      try {
        return JSON.parse(textItem.text);
      } catch {
        return textItem.text;
      }
    }
    return result;
  }

  // Annotation tools return RANGE_MOVED (not an MCP error) when the text was found
  // at a different position than specified. Retry with the server-resolved offsets.
  async addAnnotation(toolName, args) {
    const result = await this.call(toolName, args);
    if (result?.code === "RANGE_MOVED" && result?.details?.resolvedFrom !== undefined) {
      const { resolvedFrom, resolvedTo } = result.details;
      return this.call(toolName, { ...args, from: resolvedFrom, to: resolvedTo });
    }
    return result;
  }

  async close() {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const mcp = new McpClient();
  console.log("Connecting to MCP server...");
  await mcp.connect();

  // Create temp files for multi-doc demo
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-ss-"));
  const extraFiles = [
    {
      name: "quarterly-budget-analysis-2025.md",
      content: `# Quarterly Budget Analysis 2025\n\nThis document summarizes the budget performance for Q1-Q3.\n\n## Revenue\n\nTotal revenue reached $4.2M, exceeding the forecast by 12%.\n\n## Expenses\n\nOperating costs were within budget at $2.8M.\n`,
    },
    {
      name: "product-roadmap.md",
      content: `# Product Roadmap\n\n## Q1 Milestones\n\n- Launch collaborative editing\n- Ship annotation system\n- MCP integration\n\n## Q2 Goals\n\n- Word document support\n- Channel push notifications\n`,
    },
    {
      name: "meeting-notes-march.md",
      content: `# Meeting Notes — March 2025\n\n## Attendees\n\nBryan, Sarah, Mike, Claude\n\n## Action Items\n\n1. Finalize the API spec by Friday\n2. Review the NPS survey results\n3. Schedule the Q2 planning session\n`,
    },
  ];

  for (const f of extraFiles) {
    fs.writeFileSync(path.join(tmpDir, f.name), f.content);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    // ── Open the main document ───────────────────────────────────────────────
    console.log("\n1. Opening welcome.md via MCP...");
    const openResult = await mcp.call("tandem_open", { filePath: SAMPLE_PATH, force: true });
    const docId = openResult?.data?.documentId;
    if (!docId) {
      console.error("   ERROR: No documentId in response:", JSON.stringify(openResult));
      throw new Error("Failed to get documentId from tandem_open");
    }
    console.log(`   documentId: ${docId}`);

    // Navigate to the app and mark tutorial as completed so it doesn't interfere
    console.log(`   Navigating to ${CLIENT_URL}...`);
    await page.goto(CLIENT_URL);
    await page.waitForSelector(".ProseMirror", { timeout: 15000 });
    await sleep(1000);

    // Mark tutorial as completed so its annotations don't clutter screenshots
    await page.evaluate(() => {
      localStorage.setItem("tandem:tutorialCompleted", "true");
    });

    // Dismiss any existing tutorial card
    const tutorialDismiss = page.locator('[data-testid="tutorial-skip-btn"]');
    if (await tutorialDismiss.isVisible({ timeout: 1000 }).catch(() => false)) {
      await tutorialDismiss.click();
      await sleep(300);
    }

    // Dismiss any toast notifications from the force reload
    const toastDismissBtns = page.locator('[data-testid^="toast-dismiss-"]');
    const toastCount = await toastDismissBtns.count();
    for (let i = 0; i < toastCount; i++) {
      try { await toastDismissBtns.nth(0).click(); await sleep(200); } catch {}
    }
    await sleep(500);

    // Dismiss the existing tutorial annotations (accept them all) to start clean
    const existingAnnotations = await mcp.call("tandem_getAnnotations", { documentId: docId });
    const annList = existingAnnotations?.data?.annotations || [];
    for (const ann of annList) {
      if (ann.status === "pending" && ann.id?.startsWith("tutorial-")) {
        try {
          await mcp.call("tandem_resolveAnnotation", { annotationId: ann.id, action: "dismiss", documentId: docId });
        } catch {}
      }
    }
    await sleep(500);

    // ── Read the document text to get accurate offsets ─────────────────────
    console.log("   Reading document text for offset calculation...");
    const textResult = await mcp.call("tandem_getTextContent", { documentId: docId });
    const docText = textResult?.data?.text || textResult?.text || "";
    console.log(`   Document length: ${docText.length} chars`);

    // Find key text ranges in the document
    function findRange(snippet) {
      const idx = docText.indexOf(snippet);
      if (idx === -1) {
        console.warn(`   WARNING: Could not find "${snippet.slice(0, 40)}..." in document`);
        return null;
      }
      return { from: idx, to: idx + snippet.length };
    }

    // ── Add annotations via MCP ──────────────────────────────────────────
    console.log("   Adding annotations...");

    // Highlight on "Both you and Claude can see and edit this document at the same time"
    const highlightText = "Both you and Claude can see and edit this document at the same time";
    const hlRange = findRange(highlightText);
    if (hlRange) {
      await mcp.addAnnotation("tandem_highlight", {
        from: hlRange.from,
        to: hlRange.to,
        color: "yellow",
        note: "Great opening line — sets collaborative expectations immediately.",
        textSnapshot: highlightText,
      });
      console.log("   + highlight added");
    }

    // Comment on the "Review an annotation" instruction
    const commentText = "Review an annotation";
    const cmRange = findRange(commentText);
    if (cmRange) {
      await mcp.addAnnotation("tandem_comment", {
        from: cmRange.from,
        to: cmRange.to,
        text: "Consider linking to a specific annotation so new users don't have to search for one.",
        textSnapshot: commentText,
      });
      console.log("   + comment added");
    }

    // Suggestion on the sample content paragraph
    const suggestText = "The project launched in early 2025 with three core goals";
    const sgRange = findRange(suggestText);
    if (sgRange) {
      await mcp.addAnnotation("tandem_suggest", {
        from: sgRange.from,
        to: sgRange.to,
        newText: "In early 2025, the project set three ambitious goals",
        reason: "Active voice and stronger verb choice makes this punchier.",
        textSnapshot: suggestText,
      });
      console.log("   + suggestion added");
    }

    // Flag on the timeline slip mention
    const flagText = "the dashboard timeline slipped due to an unexpected API redesign in May";
    const flRange = findRange(flagText);
    if (flRange) {
      await mcp.addAnnotation("tandem_flag", {
        from: flRange.from,
        to: flRange.to,
        note: "This needs a mitigation plan or updated timeline before sharing externally.",
        textSnapshot: flagText,
      });
      console.log("   + flag added");
    }

    // Set Claude's status
    await mcp.call("tandem_setStatus", {
      text: "Reviewing document structure...",
      focusParagraph: 2,
    });
    console.log("   + status set");

    // Wait for annotations to render in the browser
    await sleep(3000);

    // Dismiss any toasts that appeared from annotation creation
    const toastDismissBtns2 = page.locator('[data-testid^="toast-dismiss-"]');
    const toastCount2 = await toastDismissBtns2.count();
    for (let i = 0; i < toastCount2; i++) {
      try { await toastDismissBtns2.nth(0).click(); await sleep(200); } catch {}
    }
    await sleep(500);

    // Make sure we're on the Annotations tab
    const annotationsTab = page.locator("button", { hasText: "Annotations" });
    if (await annotationsTab.isVisible()) {
      await annotationsTab.click();
      await sleep(500);
    }

    // Wait for annotation cards to appear
    try {
      await page.waitForSelector('[data-testid^="annotation-card-"]', { timeout: 8000 });
    } catch {
      console.warn("   WARNING: No annotation cards visible — proceeding anyway");
    }

    // ── Screenshot 1: Editor overview ────────────────────────────────────
    console.log("\n2. Taking 01-editor-overview.png...");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "01-editor-overview.png") });
    console.log("   DONE");

    // ── Screenshot 3: Side panel (cropped) ───────────────────────────────
    console.log("\n3. Taking 03-side-panel.png...");
    // Crop to the right side of the page where the side panel lives
    // The side panel is typically ~350px wide on the right
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "03-side-panel.png"),
      clip: { x: 940, y: 40, width: 460, height: 750 },
    });
    console.log("   DONE");

    // ── Screenshot 4: Toolbar + tab bar with multiple docs ───────────────
    console.log("\n4. Opening additional documents for tab bar...");
    for (const f of extraFiles) {
      const fp = path.join(tmpDir, f.name).replace(/\\/g, "/");
      try {
        await mcp.call("tandem_open", { filePath: fp });
        console.log(`   + opened ${f.name}`);
      } catch (err) {
        console.warn(`   WARNING: Failed to open ${f.name}: ${err.message}`);
      }
    }
    await sleep(2000);

    // Switch back to the welcome doc so it's active
    if (docId) {
      await mcp.call("tandem_switchDocument", { documentId: docId });
    }
    await sleep(1000);

    // Select some text in the editor to show toolbar buttons
    const proseMirror = page.locator(".ProseMirror");
    const editorBox = await proseMirror.boundingBox();
    if (editorBox) {
      // Click and drag to select a line of text
      await page.mouse.click(editorBox.x + 50, editorBox.y + 80);
      await page.keyboard.down("Shift");
      await page.keyboard.press("End");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("End");
      await page.keyboard.up("Shift");
      await sleep(300);
    }

    console.log("   Taking 04-toolbar-actions.png...");
    // Capture the top portion: tab bar + toolbar + start of editor
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "04-toolbar-actions.png"),
      clip: { x: 0, y: 0, width: 1400, height: 180 },
    });
    console.log("   DONE");

    // ── Screenshot 5: Keyboard review mode ──────────────────────────────
    console.log("\n5. Taking 05-review-mode.png...");
    // Switch back to welcome doc and make sure Annotations tab is active
    if (docId) {
      await mcp.call("tandem_switchDocument", { documentId: docId });
      await sleep(500);
    }
    const annTabBtn = page.locator("button", { hasText: "Annotations" });
    if (await annTabBtn.isVisible()) {
      await annTabBtn.click();
      await sleep(300);
    }
    // Enter review mode with Ctrl+Shift+R
    await page.keyboard.press("Control+Shift+R");
    await sleep(1000);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "05-review-mode.png"),
    });
    console.log("   DONE");
    // Exit review mode
    await page.keyboard.press("Escape");
    await sleep(500);

    // ── Screenshot 2: Chat sidebar ───────────────────────────────────────
    console.log("\n6. Taking 02-chat-sidebar.png...");
    // Click the Chat tab first so the input is visible
    const chatTabBtn = page.locator("button", { hasText: "Chat" });
    if (await chatTabBtn.isVisible()) {
      await chatTabBtn.click();
      await sleep(500);
    }
    // Send a user message via the chat input so it appears in the conversation
    const chatInput = page.locator('[data-testid="chat-input"]').first();
    if (await chatInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await chatInput.click();
      await chatInput.fill("Can you look at the sample content section? The timeline details feel vague.");
      await page.keyboard.press("Enter");
      await sleep(800);
    }
    // Add a Claude reply via MCP
    await mcp.call("tandem_reply", {
      text: "The sample content section uses passive constructions and buries the timeline slip. I've added a suggestion to tighten the opening sentence — active voice makes the goals land harder. For the slip mention, I flagged it: it needs a concrete mitigation plan before this goes external.",
    });
    await sleep(800);
    // Type a follow-up to show the input area with pending text
    if (await chatInput.isVisible({ timeout: 500 }).catch(() => false)) {
      await chatInput.click();
      await chatInput.fill("Makes sense. Accept the suggestion and let's move on.");
      await sleep(300);
    }
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "02-chat-sidebar.png"),
      clip: { x: 940, y: 40, width: 460, height: 650 },
    });
    console.log("   DONE");
    // Clear the input and switch back to Annotations tab
    if (await chatInput.isVisible({ timeout: 500 }).catch(() => false)) {
      await chatInput.fill("");
    }
    if (await annTabBtn.isVisible()) {
      await annTabBtn.click();
      await sleep(300);
    }

    // ── Screenshot 6: Status bar (Claude presence) ───────────────────────
    console.log("\n7. Taking 06-claude-presence.png...");
    // Update status to show activity
    await mcp.call("tandem_setStatus", {
      text: "Analyzing paragraph structure and readability...",
      focusParagraph: 3,
    });
    await sleep(1000);

    // Capture just the bottom status bar area
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "06-claude-presence.png"),
      clip: { x: 0, y: 860, width: 1400, height: 40 },
    });
    console.log("   DONE");

    // ── Screenshot 8: Onboarding tutorial ────────────────────────────────
    console.log("\n8. Taking 08-onboarding-tutorial.png...");
    // Clear the tutorial completion flag so the tutorial card shows
    await page.evaluate(() => {
      localStorage.removeItem("tandem:tutorialCompleted");
    });
    // Reload the page to trigger the tutorial
    await page.reload();
    await page.waitForSelector(".ProseMirror", { timeout: 15000 });
    await sleep(2000);

    // Check if tutorial card is visible
    const tutorialCard = page.locator('[data-testid="onboarding-tutorial"]');
    try {
      await tutorialCard.waitFor({ state: "visible", timeout: 5000 });
      // Capture the bottom-left area showing the tutorial card
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, "08-onboarding-tutorial.png"),
        clip: { x: 0, y: 550, width: 500, height: 350 },
      });
      console.log("   DONE");
    } catch {
      console.warn("   SKIPPED: Onboarding tutorial card not visible");
    }

    // ── Screenshot 7: Toast notification ─────────────────────────────────
    console.log("\n9. Taking 07-toast-notification.png...");
    // Trigger a toast by calling an MCP tool with invalid args that produces a notification
    try {
      await mcp.call("tandem_highlight", {
        from: 0,
        to: 5,
        color: "yellow",
        textSnapshot: "NOMATCH_FORCE_ERROR_FOR_TOAST",
      });
    } catch {
      // Expected to fail — the failure should push a toast notification
    }
    await sleep(1500);

    const toastContainer = page.locator('[data-testid="toast-container"]');
    try {
      await toastContainer.waitFor({ state: "visible", timeout: 3000 });
      const toastBox = await toastContainer.boundingBox();
      if (toastBox) {
        await page.screenshot({
          path: path.join(SCREENSHOTS_DIR, "07-toast-notification.png"),
          clip: {
            x: Math.max(0, toastBox.x - 20),
            y: Math.max(0, toastBox.y - 20),
            width: Math.min(toastBox.width + 40, 1400),
            height: Math.min(toastBox.height + 40, 300),
          },
        });
        console.log("   DONE");
      } else {
        console.warn("   SKIPPED: Toast container has no bounding box");
      }
    } catch {
      console.warn("   SKIPPED: No toast notification appeared");
    }

    console.log("\n--- All screenshots saved to docs/screenshots/ ---");
  } finally {
    await browser.close();
    await mcp.close();
    // Clean up temp files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error("Screenshot script failed:", err);
  process.exit(1);
});
