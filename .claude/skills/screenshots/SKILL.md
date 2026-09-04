---
name: screenshots
description: Capture README screenshots of the Tandem editor UI via Playwright + MCP
disable-model-invocation: true
---

# Capture README Screenshots

Regenerate the numbered screenshot set in `docs/screenshots/`.

## When to Use

After UI changes that affect any of these areas: editor layout, the right rail
(annotations/chat), toolbar/tab bar, the status pill, toast notifications, the
margin view, the outline rail, the Settings modal, the integration wizard, or the
onboarding tutorial card.

## One pipeline

```bash
npm run capture:screenshots
```

That is `scripts/screenshots/capture.spec.ts` behind its own Playwright config.
It brings its own server, so there is **no** `dev:standalone` precondition, and
it runs against an isolated per-run `TANDEM_APP_DATA_DIR`, so it cannot capture
the operator's real chat history into a public image.

There is exactly one capture pipeline, and a second one must not be added: two
pipelines writing the same filenames means whichever ran last decides what the
README shows, with different framing and seed data per shot.

## Critical warning — the reserved harness ports

The capture config spreads the root `playwright.config.ts`, which since #1492
runs on the **reserved harness ports** from `scripts/test-ports.ts` (Vite 4573,
backend 4728/4729) — a running `npm run dev:server` or the installed desktop
app on 3478/3479 is safe and stays up. The reserved pair itself is not
negotiable: the harness backend's boot `freePort()` **kills whatever holds
4728/4729**, so do not run `npm run test:e2e` (same ports) concurrently.

## Output

The slot table — what each image must depict, which document embeds it, which
ones are manual, and the privacy check slot 13 needs — lives in
[docs/screenshots/README.md](../../../docs/screenshots/README.md). It is the
single copy on purpose; do not restate it here, in `.agents/skills/screenshots/`,
or in the spec.

One slot is not automatable: `14-desktop-window.png`. Neither pipeline drives the
Tauri WebView, so the desktop-window shot is taken by hand.

## After running

Read the run output — every step asserts on what it is photographing, and a skip
is a hard failure rather than a `console.warn`. Then **look at each image**:
assertions distinguish "rendered" from "did not render", never "the right thing"
from "a plausible-looking wrong thing". Commit only what you have actually
looked at.
