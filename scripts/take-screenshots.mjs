/**
 * Screenshot script for README documentation.
 * Captures 01-editor-overview.png, 02-chat-sidebar.png, 03-side-panel.png.
 *
 * Requires the dev server to already be running: npm run dev:server
 * Run with: node scripts/take-screenshots.mjs
 */

import { chromium } from "@playwright/test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SCREENSHOTS_DIR = path.join(REPO_ROOT, "docs", "screenshots");
const API_BASE = "http://localhost:3479";
const WS_BASE = "ws://localhost:3478";
const CTRL_ROOM = "__tandem_ctrl__";

async function apiPost(urlPath, body) {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`API ${urlPath} failed: ${JSON.stringify(json)}`);
  return json;
}

/** Connect via HocuspocusProvider, write to Y.Doc, wait for sync, then disconnect. */
function seedRoom(room, writeFn) {
  return new Promise((resolve, reject) => {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: WS_BASE,
      name: room,
      document: ydoc,
      WebSocketPolyfill: WebSocket,
      onSynced: () => {
        try {
          writeFn(ydoc);
          // Give Hocuspocus time to broadcast the update before we disconnect
          setTimeout(() => {
            provider.destroy();
            resolve();
          }, 1500);
        } catch (err) {
          provider.destroy();
          reject(err);
        }
      },
    });

    setTimeout(() => {
      provider.destroy();
      reject(new Error(`seedRoom timed out for: ${room}`));
    }, 10000);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-screenshots-"));
  const samplePath = path.join(tmpDir, "annual-report.md");

  fs.writeFileSync(
    samplePath,
    `# Annual Report 2025

This report presents our annual findings across product, engineering, and customer success.

## Executive Summary

The organization achieved significant milestones this year, demonstrating resilience in a challenging market environment. Revenue grew 34% year-over-year, driven primarily by expansion within existing accounts.

## Product Highlights

- Launched three major features in Q2 and Q3
- Reduced time-to-value from 45 days to 12 days
- Net Promoter Score improved from 42 to 61

## Engineering

Infrastructure reliability reached 99.97% uptime. The team completed a full migration to the new data pipeline architecture ahead of schedule.

## Looking Ahead

The coming year will focus on deepening integrations and expanding into two new verticals.
`
  );

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    console.log("Navigating to app...");
    await page.goto("http://localhost:5173");
    await page.waitForSelector(".ProseMirror", { timeout: 15000 });
    await page.waitForTimeout(1000);

    console.log("Opening document via REST API...");
    const openResult = await apiPost("/api/open", { filePath: samplePath });
    const docId = openResult.data.documentId;
    console.log("Opened document:", docId);

    // Wait for the document tab to appear in the browser
    await page.waitForSelector(`[data-testid^="tab-"]`, { timeout: 10000 });
    await page.waitForTimeout(1500);

    // Seed annotations into the document's Y.Doc room
    console.log("Seeding annotations...");
    await seedRoom(docId, (ydoc) => {
      const map = ydoc.getMap("annotations");
      const now = Date.now();

      map.set("ann-1", {
        id: "ann-1",
        type: "comment",
        from: 2,
        to: 91,
        textSnapshot:
          "This report presents our annual findings across product, engineering, and customer success.",
        text: "Consider a warmer opening — this reads like a board memo rather than a team update.",
        author: "claude",
        status: "pending",
        createdAt: now - 120000,
      });

      map.set("ann-2", {
        id: "ann-2",
        type: "suggestion",
        from: 2,
        to: 91,
        textSnapshot:
          "This report presents our annual findings across product, engineering, and customer success.",
        originalText:
          "This report presents our annual findings across product, engineering, and customer success.",
        suggestedText:
          "Here's a look at how we did this year across product, engineering, and customer success.",
        explanation: "Warmer, team-oriented tone fits the audience better.",
        author: "claude",
        status: "pending",
        createdAt: now - 110000,
      });

      map.set("ann-3", {
        id: "ann-3",
        type: "highlight",
        from: 195,
        to: 233,
        textSnapshot: "Revenue grew 34% year-over-year",
        note: "Strong result — worth leading with in the executive summary.",
        color: "yellow",
        author: "claude",
        status: "pending",
        createdAt: now - 100000,
      });

      map.set("ann-4", {
        id: "ann-4",
        type: "flag",
        from: 308,
        to: 350,
        textSnapshot: "Net Promoter Score improved from 42 to 61",
        reason: "Verify these NPS numbers with the CX team before publishing.",
        author: "claude",
        status: "pending",
        createdAt: now - 90000,
      });

      console.log("  Annotations map size:", map.size);
    });
    console.log("  ✓ Annotations seeded");

    // Seed chat messages into the CTRL_ROOM
    console.log("Seeding chat messages...");
    await seedRoom(CTRL_ROOM, (ydoc) => {
      const chatMap = ydoc.getMap("chat");
      const now = Date.now();

      chatMap.set("msg-1", {
        id: "msg-1",
        author: "user",
        text: "Can you look at the opening paragraph? The tone feels a bit too formal for this audience.",
        timestamp: now - 90000,
        documentId: docId,
        anchor: {
          from: 2,
          to: 48,
          textSnapshot: "This report presents our annual findings",
        },
        read: true,
      });

      chatMap.set("msg-2", {
        id: "msg-2",
        author: "claude",
        text: "You're right — it reads like a board memo. I've added a suggestion that softens the first sentence. Let me know if that direction works.",
        timestamp: now - 75000,
        documentId: docId,
        read: true,
      });

      chatMap.set("msg-3", {
        id: "msg-3",
        author: "user",
        text: "Perfect, that's exactly the tone I'm going for. Can you do the same for the Executive Summary section?",
        timestamp: now - 60000,
        documentId: docId,
        read: true,
      });

      console.log("  Chat map size:", chatMap.size);
    });
    console.log("  ✓ Chat messages seeded");

    // Allow the browser to receive and render the updates
    await page.waitForTimeout(2000);

    // ── Screenshot 1: Editor overview ─────────────────────────────────────────
    const annotationsTab = page.locator("button", { hasText: "Annotations" });
    if (await annotationsTab.isVisible()) {
      await annotationsTab.click();
      await page.waitForTimeout(400);
    }
    console.log("Taking editor overview screenshot...");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "01-editor-overview.png") });
    console.log("  ✓ 01-editor-overview.png");

    // ── Screenshot 3: Side panel ───────────────────────────────────────────────
    console.log("Taking side panel screenshot...");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "03-side-panel.png") });
    console.log("  ✓ 03-side-panel.png");

    // ── Screenshot 2: Chat sidebar ─────────────────────────────────────────────
    const chatTab = page.locator("button", { hasText: "Chat" });
    await chatTab.click();
    await page.waitForTimeout(800);
    console.log("Taking chat sidebar screenshot...");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "02-chat-sidebar.png") });
    console.log("  ✓ 02-chat-sidebar.png");

    console.log("\nAll screenshots saved to docs/screenshots/");
  } finally {
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Screenshot script failed:", err);
  process.exit(1);
});
