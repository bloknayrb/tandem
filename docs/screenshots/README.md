# Screenshot slots

The spec for `docs/screenshots/*.png`: what each image must depict, which
document embeds it, and how it is produced. `scripts/screenshots/capture.spec.ts`
implements this table — if the two disagree, this file is the requirement and
the spec is the bug.

**One pipeline.** `npm run capture:screenshots`. `scripts/take-screenshots.mjs`
was deleted in the post-v0.22.1 documentation overhaul: two pipelines writing the
same filenames meant whichever ran last decided what the README showed, and for
the three shots they shared they used different framing and different seed data.

## Before you capture

1. **A running Tandem is safe; the reserved harness ports are not yours.** The
   capture config spreads the root `playwright.config.ts`, so it runs on the
   reserved E2E pair and Vite port in `scripts/test-ports.ts` (#1492), never the
   product's :3478/:3479 or dev Vite's :5173. A running `dev:server`, `npm run
   dev` or the installed desktop app is untouched. Whatever holds the *reserved*
   pair is a different matter: `scripts/e2e-guard.ts` refuses to run against a
   foreign holder it can identify, and the harness's boot `freePort()` kills one
   it cannot.
2. `npm run capture:screenshots` — it brings its own server and its own isolated
   `TANDEM_APP_DATA_DIR`, so there is no dev-server precondition and no real
   chat history to leak into a public image.
3. **Look at every image.** Assertions can distinguish "rendered" from "did not
   render". They cannot distinguish "the right thing" from "a plausible-looking
   wrong thing". This is not a formality: the run that first passed all twelve
   steps also produced an outline shot with a tutorial card clipped across it
   and a wizard shot carrying a real account name three times. Both passed
   every assertion. Both are now prevented in the spec — but the reason they
   were found at all is that someone opened the files.

## The slots

| Slot | File | Embedded by | Must depict | How |
|---|---|---|---|---|
| 01 | `01-editor-overview.png` | [README § Why I built this](../../README.md#why-i-built-this) (hero, above the fold) | The full editor at 1600px: document open on the left, annotation cards in the right rail including the suggestion's replacement diff, tab bar, and the Solo/Tandem toggle visible. | Auto. Collapses the side panel's filter bar, which the shared e2e helper `switchToAnnotationsTab` expands: its chip rows pushed the suggestion card's Accept/Dismiss row out of frame. |
| 02 | `02-chat-sidebar.png` | [README § What you get](../../README.md#what-you-get), [user-guide § Chat](../user-guide.md#chat) | The right rail with the **Chat** tab active and the **Annotations** tab visible beside it (the post-Wave-I fixed two-tab rail), showing a user message, an AI reply rendered as Markdown, and a pending follow-up in the composer. Must **not** show a cross-rail tab picker — there isn't one. | Auto |
| 03 | `03-side-panel.png` | [README § What you get](../../README.md#what-you-get) | Annotation cards close-up, including a suggestion card with the original text in red strikethrough, the proposed text in green, and Accept/Dismiss. | Auto — element shot of `annotation-list-scroll-container` |
| 04 | `04-toolbar-actions.png` | [README § What you get](../../README.md#what-you-get), [user-guide § The Editor](../user-guide.md#the-editor) | Top of the editor: several document tabs, one carrying the unsaved dot (and **no** M/W/T format letters — none exist), the formatting toolbar, a live text selection, and the **Solo/Tandem toggle** in the title bar. | Auto — clip height derived from the formatting bar's bounding box |
| 05 | — | — | **Gone.** Review Mode was removed from the product. The file and its capture step are both deleted; deleting the file alone would have been undone by the next run. Do not re-add. | — |
| 06 | `06-claude-presence.png` | [user-guide § Status Bar](../user-guide.md#status-bar) | The floating bottom-left status pill **in its hovered/revealed state** (it is faint otherwise), showing the connection dot, the word-count chip, a save state, and the AI indicator with its " · N session(s)" count (shown when the server reports one) and an activity string. Must **not** show a document count or an inline display-name editor — neither exists; the display-name editor lives in Settings → Collaboration. | Auto — element shot of the pill. Waits for the connection label to read **Synced**: the page's first connect is a rising edge, so for two seconds after load the label says "Reconnected", and earlier captures photographed that. One MCP client serves the whole run, because the server keeps counting a closed session for about a minute and per-step clients made this shot read "5 sessions". |
| 07 | `07-toast-notification.png` | [user-guide § Toast Notifications](../user-guide.md#toast-notifications) | A dismissible toast with its dismiss control. | Auto. The trigger is Settings' working-directory **Save**, so the step **closes Settings first**: the modal's backdrop (a 70% wash of the page background, `SettingsModal.svelte`) sits on `--tandem-z-above-titlebar`, far above the toast tier `--tandem-z-toast` (`ToastContainer.svelte`), and every earlier capture of this slot was a pale toast seen through that wash. #2257 tracks the app-side layering bug. It then waits out the 200ms slide-in with `getAnimations()`, because `toBeVisible` passes on the animation's first frame. **Time-bounded**: `info` toasts auto-dismiss after 4s, so the step asserts and captures immediately. The repeat-count badge is *not* captured — the trigger toast carries no `dedupKey`, so its count never leaves 1. |
| 08 | `08-onboarding-tutorial.png` | [user-guide § First Launch](../user-guide.md#first-launch) | The first-run tutorial card. | Auto |
| 09 | `09-settings-modal.png` | [user-guide § Settings](../user-guide.md#settings) | The Settings modal on the AI Assistant tab. Offered to the README/user-docs owners. Must **not** show the tutorial card: it sits bottom-left, half under the backdrop, and reads as part of Settings. | Auto. Suppresses the tutorial card before `goto`, as slots 01/11/12 do. |
| 10 | `10-solo-tandem-toggle.png` | [user-guide § Solo / Tandem Mode](../user-guide.md#solo--tandem-mode) | The mode toggle in the title bar with both options legible. Requested so the privacy-and-trust section can carry its own image rather than pointing at slot 04. | Auto — element shot |
| 11 | `11-margin-annotations.png` | [README § What you get](../../README.md#what-you-get), [user-guide § Annotations](../user-guide.md#annotations) | Margin cards beside the text with bezier leader lines and anchor dots, captured at a **full-width** margin. | Auto. Needs margin view on (Settings → AI Assistant), both rails closed, and ≥1600px viewport. The step **asserts** the column is ≥240px wide — below `full` the ladder silently steps to `narrow` (160px, no action row) or `stub` (28px, a pip) and the caption's Accept/Dismiss promise stops being true. |
| 12 | `12-outline-rail.png` | [user-guide § Outline Panel (left)](../user-guide.md#outline-panel-left) | The left outline rail with a real heading tree and the search box. | Auto — `sample/welcome.md` carries six headings across two levels. Suppresses the tutorial card first (`addInitScript`, so it must run **before** `goto`): the card is anchored bottom-left and overlaps the rail, and every assertion here passed with it clipped across the lower third of the first captured frame. |
| 13 | `13-setup-wizard.png` | [user-guide § First Launch](../user-guide.md#first-launch) | The integration wizard on its target-picker step. | Auto, **via the manual reopen entry point** (`settings-modal-open-integration-wizard`) — the root config sets `TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV=1`, so first-run can never fire here and waiting for it looks like an unexplained timeout. **Privacy: handled by construction, not by review.** The wizard prints the real resolved config path for every client it finds, account name included. `redactAccountName()` rewrites that segment to `you` before the shot, and the step then scans the whole rendered viewport for any **path-shaped** run of text still carrying the account name — so a redaction that silently stopped working fails the capture instead of publishing. Both halves are narrower than they were (#1528): the replacement is anchored to the home directory's own path segment, and the assertion no longer accepts "the string is gone" as proof, because the old body-wide substring replace satisfied that by rewriting ordinary UI copy on any machine whose account is `root` / `user` / `home` / `admin`. The rule lives in `scripts/screenshots/redact-account.ts` and is tested without a browser in `tests/scripts/screenshot-redaction.test.ts`. **Two ways the capture stops rather than ships**, both deliberate: a home directory with no parent segment to anchor against (`/root`, or a bare name) is not rewritten at all, because the approximation over-replaces — the scan alone then decides; and an account name that collides with a segment of slot 13's own paths (`claude`, `json`, `appdata`, `roaming`, `config`) reports as a leak that nothing can distinguish from a real one. Both need a human decision, not a code change. This row used to ask a human to check each image; that is not a control, because it passes by default and passes silently on the run nobody reads. |
| 14 | `14-desktop-window.png` | nobody yet | The Tauri window including the overlay titlebar — the only shot that shows Tandem is a desktop app rather than a web page. | **MANUAL.** The capture pipeline does not drive the WebView; it launches Chromium against the harness's own Vite server. Run `cargo tauri dev`, take an OS window capture, crop to the window bounds, drop the shadow. |
| 15 | `15-dark-theme.png` | [README § What you get](../../README.md#what-you-get), [user-guide § Brand Menu](../user-guide.md#brand-menu) | Slot 01's document, seed and framing in the **Dark** theme: annotation cards, tab bar and the Solo/Tandem toggle all re-coloured. | Auto. Switched through the brand menu's `brand-menu-theme-dark` swatch (the control a reader uses), and the step asserts `<html data-theme="dark">` — a light frame is a perfectly plausible-looking screenshot. |
| 16 | `16-warm-theme.png` | [user-guide § Brand Menu](../user-guide.md#brand-menu) | The same frame in the **Warm** (paper-toned light) theme. | Auto — slot 15's step with `brand-menu-theme-warm`. |
| 17 | `17-reply-thread-and-note.png` | [user-guide § Note](../user-guide.md#note) | The annotation list holding (a) an AI comment with its reply thread **expanded** — the user's reply and the AI's answer — and (b) a **private note** card carrying its Private pill. | Auto — element shot of `annotation-list-scroll-container`. The user's reply goes through the card's own Reply button; the note through the selection popup's composer (**Note to self**), because Claude has no path to create a note (ADR-027). Asserts both cards sit wholly inside the captured box, then **removes the note**: the per-step slate sweep lists through `tandem_getAnnotations`, which never returns a note, so a left-over note shows up behind later shots of `welcome.md` (it did, behind slot 22). |
| 18 | `18-external-conflict-banner.png` | [user-guide § When a File Changes on Disk](../user-guide.md#when-a-file-changes-on-disk) | The "changed on disk while you have unsaved edits" banner with **Keep my edits** and **Reload from file**, the tab's unsaved dot, and the document under it. | Auto — clip from the top of the window to below the banner. Raised for real: an edit typed in the editor (asserted via the tab's dirty dot), and `makeUnsavedEdit` then polls `tandem_getTextContent` until the server holds it — the dot comes from the browser's own Y.Doc, and a disk write that beats the WebSocket update makes the watcher silently reload instead. Then the file is rewritten with `fs`. Autosave is one global interval (`src/server/session/manager.ts`), not a window that opens at the edit, so the capture must finish before the next tick, which can come at any point within 60 s. |
| 19 | `19-command-palette.png` | [user-guide § Navigation & General](../user-guide.md#navigation--general) | The command palette (`Ctrl+Shift+P`) with a query typed and several matching commands listed. | Auto — element shot of `command-palette`. |
| 20 | `20-help-modal.png` | [user-guide § Help Modal](../user-guide.md#help-modal) | The keyboard-shortcuts reference opened from the brand menu. | Auto — element shot of the dialog inside `help-modal` (that testid is the backdrop). |
| 21 | `21-activity-tray.png` | [user-guide § Activity Tray](../user-guide.md#activity-tray) | The Activity tray open above its pill, holding at least two entries of different severities, with **Clear all**. | Auto — clip around tray and pill. Both entries are **real** events, not the e2e suite's injected ones: a clean file rewritten on disk (an info "reloaded" entry) and a dirty one (a warning conflict entry). The transient toasts are dismissed first so they are not stacked over the tray. |
| 22 | `22-settings-notifications.png` | [user-guide § Reply Notifications](../user-guide.md#reply-notifications) | Settings → Notifications in its settled state ("This browser allows Tandem's notifications."), with the content, flash, sound and test controls visible. | Auto. Grants the `notifications` permission first so the tab does not show the one-time **Allow notifications** prompt, and stubs `Notification.permission` to `"granted"` with `addInitScript`, because the headless shell reports "denied" whatever is granted and `web-notifier.ts` reads that property directly. As with slot 13's stub of the machine's config, only the environment is stubbed, never Tandem code: the tab renders its own granted branch. Asserts the last control sits inside the modal's visible body, because the modal is a fixed 900x680 with a scrolling body ([gotchas](../gotchas.md#testing--e2e)). |
| — | *not captured* | — | **Launcher-dependent states:** the AI Assistant tab's Tandem's Claude section, the status pill's **Start Tandem's Claude** button, and chat's Start / Turn off controls. | **DEFERRED.** They render only from the launcher's live state, and the capture harness never runs Tandem's Claude — it has no Claude Code install to launch. Route-stubbing the launcher status would photograph a state no real launcher produced. Take by hand from a desktop build with Claude Code set up. |
| — | *not captured* | — | **The connection-lost banner** ("We've lost the connection to the Tandem server" with **Retry now**). | **DEFERRED.** It appears only after the backend has been unreachable for the degraded threshold (30s by default), and every step shares one harness backend, so stopping it mid-run would break each step after it. Take by hand: open a document, stop the server, wait. |

Every numbered slot except 14 is now captured **and embedded**; the two *not captured* rows are states the pipeline cannot reach honestly, recorded so that nobody re-derives why they are missing. That is the standing rule
rather than a status line: an image nobody embeds is the same orphan
`09-settings-popover.png` was, so a new slot either gets a home in the Embedded
column or its step is deleted. Do not commit a capture step whose output no page
references — a file with no reader cannot go stale visibly, which is exactly how
a screenshot of a removed feature survived four months.

## Two rules the capture spec enforces

1. **Every `page.screenshot()` is preceded by an `expect()` on the thing the
   shot is meant to show.** An unasserted capture writes *something* whether or
   not the UI rendered, and a plausible wrong image is worse than a red run.
2. **A skip is a failure.** No `try {} catch { console.warn("SKIPPED") }`. The
   deleted pipeline skipped slots 07 and 08 silently; 08's committed file was
   four months older than the rest of the set and nothing said so.

Annotation ranges are resolved by `indexOf` against `tandem_getTextContent`, and
a missing snippet throws. Blind offsets into `sample/welcome.md` stay *valid*
when the prose changes — they just land on different text, so the screenshot
comes out quietly wrong.
