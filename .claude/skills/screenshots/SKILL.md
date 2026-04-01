---
name: screenshots
description: Capture README screenshots of the Tandem editor UI via Playwright + MCP
disable-model-invocation: true
---

# Capture README Screenshots

Take a fresh set of 8 numbered screenshots for the README documentation.

## When to Use

After UI changes that affect any of these areas: editor layout, side panel (annotations/chat), toolbar/tab bar, status bar, review mode, toast notifications, or the onboarding tutorial card.

## Prerequisites

1. The dev server MUST already be running:
   ```bash
   npm run dev:standalone
   ```

2. Verify health before proceeding:
   ```bash
   curl -sf http://127.0.0.1:3479/health && echo "Ready" || echo "Server not running — start it first"
   ```

## Critical Warnings

### Stale CRDT State
If Tandem is already open in Chrome, the browser tab holds a stale Y.Doc in memory. On reconnect it merges old state back, clobbering fresh content. You MUST:
1. Navigate the Chrome tab away from Tandem (e.g., go to `about:blank`)
2. Then run the screenshot script — it creates its own browser context

### Port Conflict with E2E Tests
Do NOT run `npm run test:e2e` while taking screenshots. Playwright's `webServer` config calls `freePort()` which kills processes on :3478/:3479, terminating your dev server mid-screenshot.

## Run the Script

```bash
node scripts/take-screenshots.mjs
```

The script:
- Connects to the MCP server at `http://localhost:3479/mcp`
- Opens `sample/welcome.md` and creates demo annotations (highlight, comment, suggestion, flag)
- Opens extra temp documents for the multi-tab screenshot
- Captures 8 screenshots with specific viewport clips
- Cleans up temp files on exit
- Uses `headless: false` so you will see a Chrome window appear

## Output

Screenshots are saved to `docs/screenshots/`:

| File | Content |
|------|---------|
| `01-editor-overview.png` | Full editor with annotations visible |
| `02-chat-sidebar.png` | Chat panel with conversation |
| `03-side-panel.png` | Annotation cards in side panel |
| `04-toolbar-actions.png` | Tab bar + toolbar with text selected |
| `05-review-mode.png` | Keyboard review mode overlay |
| `06-claude-presence.png` | Status bar with Claude activity |
| `07-toast-notification.png` | Toast notification popup |
| `08-onboarding-tutorial.png` | Tutorial card for new users |

## After Running

Review the screenshots in `docs/screenshots/` and commit any that look correct. Annotations created by the script persist until the server restarts or documents are closed.
