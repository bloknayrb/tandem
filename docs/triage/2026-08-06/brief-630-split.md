# #630 doesn't need splitting — items 1–3 already shipped

**Issues:** #630   **Decision needed:** Rewrite #630 down to its four genuinely-remaining items (4–7) plus the hardware-gated item 8, and drop items 1–3 as done — yes or no?

## What these are

The requested split was: items 1–2 actionable on Windows, item 3 hardware-gated. **Both halves of that framing are wrong.** All three landed on 2026-06-08 in `01e8adc` ("fix(desktop): reliably reap node-sidecar on ungraceful exit + surface startup-file rejections (#987, #630)"), and the issue body was never updated.

**Item 1 — shipped.** `pub enum RejectionReason` at `src-tauri/src/lib.rs:342`; `pub fn extract_file_arg(args, cwd) -> Result<Option<PathBuf>, RejectionReason>` at `lib.rs:492-495`. Both production call sites migrated and log the typed reason — second-instance at `lib.rs:929/961`, cold-start at `lib.rs:1180/1184`. Integration tests migrated: `src-tauri/tests/file_association.rs:11` imports `RejectionReason` and asserts on typed variants throughout.

**Item 2 — shipped.** `static STARTUP_REJECTION: Mutex<Option<String>>` at `lib.rs:148`; `#[tauri::command] fn get_startup_rejection() -> Option<String>` at `lib.rs:198`, registered in the invoke handler at `lib.rs:1507`; event constant `EVENT_STARTUP_FILE_REJECTED` at `lib.rs:152`; path-free reason codes via `rejection_reason_code` at `lib.rs:157-161`. Client side is wired in `src/client/App.svelte:390-440` — `isTauriRuntime()` gate, a `listen("startup-file-rejected")` subscription with unlisten cleanup, **and** a one-shot `invoke("get_startup_rejection")` poll on mount. Messages are composed client-side from the code, so no path reaches the DOM. Buffer-take idempotence is tested at `lib.rs:4964-4975`; stale-rejection clearing at `lib.rs:4987-4989`.

**Item 3 — shipped, and it was never hardware-gated.** `pub(crate) fn classify_opened_url(url: &Url) -> Result<PathBuf, OpenedUrlRejection>` at `lib.rs:453`, enum at `lib.rs:396-404` including `NonEmptyHost`. The comment at `lib.rs:393` states the point explicitly: the helper is pure and unit-testable cross-platform; only its caller `handle_opened_urls` is macOS-gated. The extraction was the whole mechanism for making it Windows-testable.

## On the specific claim

**Confirmed as originally true, and already fixed.** Cold-start rejection is classified in `setup()`, which runs before the `App.svelte` `onMount` listener exists — an event emitted there would drop on exactly the failure it exists to surface. That is why the buffer exists, and the reasoning is preserved verbatim in the doc comment at `lib.rs:128-134`. The design shipped as specified: buffered poll for cold-start, live event for warm-start and macOS `RunEvent::Opened`.

## What actually remains

- **Item 4 — `request_open_file` HTTP coverage.** Not done: no `httpmock` in `src-tauri/Cargo.toml`, no `build_open_request` helper anywhere in `lib.rs`. Windows-testable.
- **Item 5 — aggregate drain-failure summary.** ~~Not done: `post_drained_paths` (`lib.rs:656`) has no error-count summary log. Windows-testable.~~
  **DONE by #1416 (2026-08-19).** `post_drained_paths` no longer exists; `post_paths_and_surface` counts failures across the whole batch, logs each at `warn`, and collapses the batch into a single user-facing code (`open-failed`, or `multiple-rejected` for 2+). The follow-up this item proposed would now be written against a deleted symbol — the surviving `post_drained_paths` mention in the "If yes" paragraph below is stale for the same reason.
- **Item 6 — retry-exhaustion drain.** Unverified in detail, but its stated dependency (item 2) is now met, so it is unblocked. Windows-testable.
- **Item 7 — poisoned-mutex surfacing.** Currently log-only: `PendingOpens` poisoning logs at `lib.rs:591` and `lib.rs:611` with no user-facing event. The issue permits "or document why log-only is sufficient" — that is a one-paragraph decision, not code.
- **Item 8 — macOS manual validation.** Genuinely hardware-gated, and per project memory this hardware now partly exists (macOS release smoke passed on real hardware for v0.20.0), so it may be runnable.

## Options

**A. Rewrite #630 to items 4–7 + 8.** Ten minutes. Leaves one issue that says what's true.
**B. Split into two issues** — 4–7 (Windows) and 8 (hardware). Cleaner tracking, more issue churn on a two-person project, and item 8 is now plausibly unblocked anyway.
**C. Close #630 outright.** The user-visible payload (typed rejections, surfaced toasts, the macOS classifier) all shipped; 4–7 are test coverage and log polish. Cheapest, and honest about priority.

## Recommendation

**A**, with item 7 resolved as "log-only, documented" in the same edit. The remaining items are diagnostics and coverage, not correctness — nothing here changes user-visible behaviour, so a single low-priority issue is the right container. Do not split: the premise for splitting (a hardware boundary between items 1–2 and 3) doesn't exist, and item 8 is no longer clearly blocked.

If you'd rather not carry it: **C** is defensible. Two months of the issue being stale had zero cost precisely because the important parts already shipped.

## If yes / If no

> **Archive note (2026-08-19, #1416).** This brief is a dated snapshot of what was true on 2026-08-06 and is not maintained. Item 5 has since shipped (see above) and item 6's retry-exhaustion drain shipped in a different shape than proposed — #1416 surfaces undelivered queued opens from every `start_sidecar` caller and deliberately **retains** the queue rather than draining it, because "Retry Server Start" exists to deliver it. Read the paragraph below as history, not as a plan.

**If yes:** edit the #630 body to strike items 1–3 with a pointer to `01e8adc`, note item 7's log-only resolution, and retitle to something like "#630 follow-ups: startup-file HTTP test coverage + drain diagnostics". Label low-priority. Implementable scope for items 4–6 is: factor `build_open_request(client, token, path) -> RequestBuilder` and assert builder shape (Bearer present with token / absent without, JSON body), add an error-count + first-error summary log after `post_drained_paths`, and drain `PendingOpens` with per-path `startup-file-error` emission when `start_sidecar` exhausts retries.

**If no (close it):** nothing is lost that a future reader can't recover from `01e8adc`; record in the closing comment that items 4–7 were dropped as diagnostics-only, so it isn't mistaken later for unfinished correctness work.
