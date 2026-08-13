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

1. **Nothing may hold :3478, :3479 or :5173.** The capture config spreads the
   root `playwright.config.ts`, whose `webServer` calls `freePort()` — it will
   kill a running `dev:server` **or the installed desktop app** mid-session.
   Check first; this is not recoverable once it fires.
2. `npm run capture:screenshots` — it brings its own server and its own isolated
   `TANDEM_APP_DATA_DIR`, so there is no dev-server precondition and no real
   chat history to leak into a public image.
3. **Look at every image.** Assertions can distinguish "rendered" from "did not
   render". They cannot distinguish "the right thing" from "a plausible-looking
   wrong thing". Slot 13 additionally needs a privacy pass (below).

## The slots

| Slot | File | Embedded by | Must depict | How |
|---|---|---|---|---|
| 01 | `01-editor-overview.png` | `README.md:35` (hero, above the fold) | The full editor at 1600px: document open on the left, annotation cards in the right rail including the suggestion's replacement diff, tab bar, and the Solo/Tandem toggle visible. | Auto |
| 02 | `02-chat-sidebar.png` | `README.md:126`, `docs/user-guide.md:248` | The right rail with the **Chat** tab active and the **Annotations** tab visible beside it (the post-Wave-I fixed two-tab rail), showing a user message, an AI reply rendered as Markdown, and a pending follow-up in the composer. Must **not** show a cross-rail tab picker — there isn't one. | Auto |
| 03 | `03-side-panel.png` | `README.md:120` | Annotation cards close-up, including a suggestion card with the original text in red strikethrough, the proposed text in green, and Accept/Reject. | Auto — element shot of `annotation-list-scroll-container` |
| 04 | `04-toolbar-actions.png` | `README.md:132`, `docs/user-guide.md:35` | Top of the editor: several document tabs, one carrying the **RO** badge and one the unsaved dot (and **no** M/W/T format letters — none exist), the formatting toolbar, a live text selection, and the **Solo/Tandem toggle** in the title bar. | Auto — clip height derived from the formatting bar's bounding box |
| 05 | — | — | **Gone.** Review Mode was removed from the product. The file and its capture step are both deleted; deleting the file alone would have been undone by the next run. Do not re-add. | — |
| 06 | `06-claude-presence.png` | `docs/user-guide.md:100` | The floating bottom-left status pill **in its hovered/revealed state** (it is faint otherwise), showing the connection dot, the word-count chip, a save state, and the AI indicator with an activity string. Must **not** show a document count or an inline display-name editor — neither exists; the display-name editor lives in Settings → Collaboration. | Auto — element shot of the pill |
| 07 | `07-toast-notification.png` | `docs/user-guide.md:116` | A dismissible toast with its dismiss control. | Auto. **Time-bounded**: `info` toasts auto-dismiss after 4s, so the step asserts and captures immediately. The repeat-count badge is *not* captured — the trigger toast carries no `dedupKey`, so its count never leaves 1. |
| 08 | `08-onboarding-tutorial.png` | nobody | The first-run tutorial card. Kept as a step because the card is a real shipped surface; the image is not currently embedded anywhere, so it is optional output. | Auto |
| 09 | `09-settings-modal.png` | nobody yet | The Settings modal on the AI Assistant tab. Offered to the README/user-docs owners. | Auto |
| 10 | `10-solo-tandem-toggle.png` | nobody yet | The mode toggle in the title bar with both options legible. Requested so the privacy-and-trust section can carry its own image rather than pointing at slot 04. | Auto — element shot |
| 11 | `11-margin-annotations.png` | nobody yet | Margin cards beside the text with bezier leader lines and anchor dots, captured at a **full-width** margin. | Auto. Needs margin view on (Settings → AI Assistant), both rails closed, and ≥1600px viewport. The step **asserts** the column is ≥240px wide — below `full` the ladder silently steps to `narrow` (160px, no action row) or `stub` (28px, a pip) and the caption's Accept/Reject promise stops being true. |
| 12 | `12-outline-rail.png` | nobody yet | The left outline rail with a real heading tree and the search box. | Auto — `sample/welcome.md` carries six headings across two levels |
| 13 | `13-setup-wizard.png` | nobody yet | The integration wizard on its target-picker step. | Auto, **via the manual reopen entry point** (`settings-modal-open-integration-wizard`) — the root config sets `TANDEM_DISABLE_FIRST_RUN_WIZARD_ENV=1`, so first-run can never fire here and waiting for it looks like an unexplained timeout. **Privacy: a human must check this shot for a real username, hostname or absolute path before it is committed** — the reachability rows can render them. |
| 14 | `14-desktop-window.png` | nobody yet | The Tauri window including the overlay titlebar — the only shot that shows Tandem is a desktop app rather than a web page. | **MANUAL.** Neither pipeline drives the WebView; both launch Chromium against `http://127.0.0.1:5173`. Run `cargo tauri dev`, take an OS window capture, crop to the window bounds, drop the shadow. |

Slots 09–13 are captured but not yet embedded. An image nobody embeds is the
same orphan `09-settings-popover.png` was — if the README and user-guide owners
do not claim them, drop the steps rather than committing the files.

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
