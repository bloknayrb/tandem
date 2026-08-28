//! The startup-file rejection buffer (#630, #1344, #1416).
//!
//! **Extracted from `lib.rs` (Unit 11f).** A pure move: the one-slot
//! `STARTUP_REJECTION` buffer, its poison-recovering accessor, the four wire
//! codes, the `RejectionBatch` that collapses one OS batch into one of them,
//! and the `startup_rejection_tests` module are reproduced verbatim. The only
//! edits the move required are the `pub(crate)` on the nine items `lib.rs`
//! still calls, and the imports below.
//!
//! **`tauri::Emitter` is the import that does not appear in the moved text.**
//! `surface_startup_rejection` calls `app.emit(…)`, a trait method, so its
//! absence is an E0599 on a line that looks self-contained rather than the
//! E0432 an unresolved path would give. Unit 11e lost time to exactly this.
//!
//! **What deliberately stayed in `lib.rs`.** Every *caller* — the argv cold
//! start, the single-instance warm start, the macOS Apple-Event handler,
//! `show_server_error_dialog`'s decline arm — and `post_paths_and_surface`,
//! which drives a batch to completion and belongs to the open pipeline rather
//! than to the buffer. `lib.rs` re-exports this module's names at the crate
//! root instead of qualifying ~20 call sites, the same idiom it already uses
//! for `open_candidate`; that is what keeps the call sites byte-identical and
//! keeps a sibling module's `use crate::{…}` resolving across the split.

use std::sync::Mutex;

use tauri::Emitter;

/// Buffered file-open rejection reason CODE (stable, path-free) — the single
/// delivery surface for EVERY entry point, cold start and warm start alike.
/// See issues #630 and #1344.
///
/// ## Why buffer instead of just emitting an event
///
/// A cold-start "Open With" rejection (`extract_file_arg` returns `Err`) is
/// classified in `setup()` — which runs before `App.svelte` exists at all, let
/// alone its listener. Emitting a Tauri event there drops silently on the exact
/// failure mode it is meant to surface. So the reason is buffered here and
/// drained via `get_startup_rejection()` when the client comes up.
///
/// ## Why the buffer is unconditional, and not gated on WebView readiness
///
/// `startup-file-rejected` is a payload-free NUDGE, answered by calling
/// `get_startup_rejection()` — the same take-once accessor the init-time drain
/// uses. So Rust never has to know whether the listener is wired, which it
/// cannot know.
///
/// An earlier revision of this work (see PR #1414's history; the design does not
/// appear in issue #1344 itself) inferred readiness from a `REJECTION_POLLED`
/// latch — "the WebView has polled, so its listener must be wired" — and skipped
/// the buffer once set. The inference does not hold, for a reason that needs no
/// race to demonstrate: the latch is process-global and the listener is not. **A
/// WebView reload leaves the latch set and the listener gone**, so every
/// rejection after the first reload took the emit-only path and was dropped
/// permanently. (`App.svelte` also wires the listener and drains in two
/// independent promise chains whose completion order is not guaranteed, so a
/// completed drain never proved a wired listener either — but that one is a
/// sub-millisecond window and is not the argument this rests on.)
///
/// Unconditional buffering also means a nudge with no listener costs one dropped
/// event rather than the toast. Same queue-then-drain shape as `PendingOpens`,
/// the other place in this file where a producer must not care whether the
/// consumer is ready.
///
/// ## Why a `Mutex<Option<_>>` and not a `OnceLock`
///
/// `OnceLock` cannot be cleared, but the buffer MUST be cleared on
/// `restart_sidecar` so a stale rejection from a previous launch isn't replayed
/// against the new sidecar. A `Mutex<Option<String>>` gives set / take / clear.
///
/// ## No path leakage
///
/// The buffer holds a stable reason CODE only (e.g. `"unsupported-extension"`),
/// never the rejected path — the resolved path is already logged at `warn` for
/// diagnostics, and the human-readable toast message is composed client-side
/// (mirrors the path-free `sidecar-restart-failed` toast contract). The writers
/// take `&'static str` precisely so this cannot be relaxed by accident; see
/// [`buffer_startup_rejection_code`].
static STARTUP_REJECTION: Mutex<Option<String>> = Mutex::new(None);

/// Run `f` against the rejection buffer, recovering from (and reporting) a
/// poisoned mutex. One helper rather than three hand-rolled `match` arms: the
/// take path used to be the only one that recovered *silently*, and it is the
/// one whose recovery destroys state, so the divergence was exactly backwards.
fn with_rejection<R>(what: &str, f: impl FnOnce(&mut Option<String>) -> R) -> R {
    match STARTUP_REJECTION.lock() {
        Ok(mut guard) => f(&mut guard),
        Err(poisoned) => {
            log::error!("STARTUP_REJECTION mutex poisoned during {what} — recovering");
            f(&mut poisoned.into_inner())
        }
    }
}

/// Tauri event name for a startup-file rejection surfaced to the WebView.
/// Deliberately payload-FREE: it is a nudge to call `get_startup_rejection`,
/// not the delivery itself (see [`STARTUP_REJECTION`]). Keeping the code out of
/// the payload is what makes the buffer the single source of truth, so a nudge
/// with no listener costs nothing.
const EVENT_STARTUP_FILE_REJECTED: &str = "startup-file-rejected";

/// Record an already-mapped, path-free reason CODE in the buffer. The single
/// writer — every entry point funnels through [`surface_startup_rejection`],
/// which funnels through here.
///
/// `&'static str`, not `&str`, and that is a safety property rather than a
/// style choice. `Display for OpenedUrlRejection` deliberately EMBEDS the
/// resolved path (it is the log format), so a sink taking `&str` would accept
/// `&format!("{reason}")` and put a filesystem path on the wire to the DOM.
/// A formatted string is not `'static`, so that mistake is now a compile error
/// rather than a thing tests have to notice. Both producers
/// ([`rejection_reason_code`], [`opened_url_reason_code`]) already return
/// `&'static str` from a closed set of literals.
///
/// Last-write-wins. A multi-file Opened batch rejects at most once through
/// [`surface_startup_rejection`] — the batch collapses to a single code before
/// it reaches here — so the surviving value is one deliberate summary, not an
/// arbitrary survivor of N racing writes.
fn buffer_startup_rejection_code(code: &'static str) {
    with_rejection("buffer", |slot| *slot = Some(code.to_string()));
}

/// Deliver a startup-file rejection to the WebView. THE delivery path — every
/// OS entry point that rejects a candidate calls this and nothing else: argv
/// cold start, second-instance warm start, and the macOS Apple Event, which
/// alone serves cold and warm start through one arm.
///
/// Buffer first, then nudge, unconditionally. Do not re-add a "has the WebView
/// polled yet" discriminator to skip the buffer on warm start — [`STARTUP_REJECTION`]
/// records why the readiness inference is false (it also raced, being read
/// outside the buffer's mutex).
pub(crate) fn surface_startup_rejection(app: &tauri::AppHandle, code: &'static str) {
    surface_startup_rejection_with(code, || {
        if let Err(e) = app.emit(EVENT_STARTUP_FILE_REJECTED, ()) {
            // Non-fatal by construction: the code is already buffered, so the
            // worst case is that the toast waits for the next client init.
            log::warn!("Failed to emit {EVENT_STARTUP_FILE_REJECTED}: {e}");
        }
    });
}

/// The testable half of [`surface_startup_rejection`], split out because
/// `tauri::AppHandle` cannot be constructed in a unit test (no `tauri` `test`
/// feature is in dev-dependencies) — and without this seam the ordering below
/// was pinned by nothing at all: deleting the buffer call reverted the whole
/// fix, and swapping the two lines re-opened the drop, both with a green suite.
///
/// The order is the contract. Buffer BEFORE nudging, or a live listener drains
/// an empty slot and the toast is lost — the nudge is deliberately payload-free,
/// so it carries nothing the client could fall back on.
fn surface_startup_rejection_with(code: &'static str, nudge: impl FnOnce()) {
    buffer_startup_rejection_code(code);
    nudge();
}

/// Wire code for "more than one file in this batch was refused". Distinct from
/// the per-reason codes because a mixed batch has no single true reason, and
/// picking one of them would state something false rather than something vague.
///
/// Ungated since #1416: `post_paths_and_surface` gives it callers on every
/// platform.
const CODE_MULTIPLE_REJECTED: &str = "multiple-rejected";

/// Wire code for "the candidate passed shell validation, and then failed to open
/// anyway" — a non-2xx from `/api/open`, a transport failure, or an open that
/// arrived after the app stopped trying to start the server (#1416).
///
/// Deliberately ONE code for all three, not three: the user's remedy is identical
/// (try again / reopen the file), the distinction is a diagnostic `tandem.log`
/// already records with the real error text, and every extra code is another
/// string that can desync from a stale WebView. Distinct from the *validation*
/// codes because nothing about the file was wrong — `messageForStartupRejection`
/// maps it to the deliberately vague "That file couldn't be opened in Tandem."
pub(crate) const CODE_OPEN_FAILED: &str = "open-failed";

/// Wire codes for "queued, not yet delivered, and the queue is RETAINED".
///
/// Split from [`CODE_OPEN_FAILED`] because that code's message is flatly past
/// tense — "That file couldn't be opened in Tandem." — and for a retained queue
/// that is a false statement: `promote_healthy_and_drain` will open the file if
/// the user ever restarts the server, which the failure dialog explicitly tells
/// them how to do. Asserting a finality the design does not have is the same
/// defect as the "Abandoning N queued file open(s)" line deleted in this change,
/// and it would be read by the one user in a position to act on it.
///
/// Two codes rather than one because the singular message cannot describe a
/// five-file drop, mirroring the [`CODE_MULTIPLE_REJECTED`] split.
pub(crate) const CODE_OPEN_DEFERRED: &str = "open-deferred";
pub(crate) const CODE_MULTIPLE_DEFERRED: &str = "multiple-deferred";

/// Collapses one OS batch — a Finder multi-select "Open With", a multi-file Dock
/// drop — into the single code the user should see.
///
/// This exists because the buffer is one slot and the batch is N rejections. The
/// obvious shape (call [`surface_startup_rejection`] per rejected URL) is what
/// the first version did, and it is nondeterministic in a way that shows: the
/// loop is synchronous while the client's drain is an async IPC round-trip, so
/// whether the user got one toast or two-with-a-count-badge, and which reason it
/// named, depended on where the drain happened to land. Same user action, two
/// different outcomes.
///
/// Accumulating first and surfacing once removes the race rather than narrowing
/// it. Deliberately ungated and free of Tauri types so it is unit-testable on
/// every platform — its principal caller, `handle_opened_urls`, is macOS-only and
/// cannot be tested from Windows or Linux CI, which is precisely why the logic
/// must not live inside it.
///
/// Since #1416 the batch also carries POST failures (`CODE_OPEN_FAILED`), so ONE
/// accumulator spans validation *and* delivery for a single OS batch. That is
/// what keeps "one batch, one surface call" true **for everything that resolves
/// synchronously with the batch**: a Finder multi-select of a `.pdf` (refused)
/// plus a 60 MB `.md` (refused by the server) would otherwise write twice into
/// the one-slot buffer and the user would see a count badge whose value depended
/// on where the client's async drain landed.
///
/// **The claim stops at the async boundary, deliberately.** A path that returns
/// `OpenRoute::Queued` has no outcome yet, and may not have one for minutes —
/// its verdict arrives from `report_pending_opens_with` when the user answers
/// the server-failure dialog. Carrying the accumulator across that gap was
/// considered and rejected: it would have to stay open for a user-timescale
/// wait, trading a merge bug for a staleness bug. Instead the client keys its
/// toast dedup on the CODE (`startup-file-rejected:${code}`), so a validation
/// reason and a later delivery verdict can never merge into one count badge.
#[derive(Default)]
pub(crate) struct RejectionBatch {
    first: Option<&'static str>,
    count: usize,
}

impl RejectionBatch {
    pub(crate) fn record(&mut self, code: &'static str) {
        self.count += 1;
        if self.first.is_none() {
            self.first = Some(code);
        }
    }

    /// The one code to surface, or `None` when nothing was rejected. A single
    /// rejection keeps its specific reason; two or more report multiplicity,
    /// because "that file type can't be opened" is actively misleading when the
    /// user just dropped five files and four of them opened.
    pub(crate) fn resolve(&self) -> Option<&'static str> {
        match self.count {
            0 => None,
            1 => self.first,
            _ => Some(CODE_MULTIPLE_REJECTED),
        }
    }
}

/// Clear any buffered rejection. Called from `restart_sidecar` so a stale
/// rejection from the previous launch can't be replayed against the new sidecar.
///
/// Note the scope is wider than that rationale: since every entry point buffers,
/// this also discards a LIVE rejection caught in the window between
/// [`surface_startup_rejection`] and the client's drain. That needs the user to
/// hit Relaunch in the same breath as a rejected open, and the alternative
/// (replaying it against the new sidecar) is worse.
pub(crate) fn clear_startup_rejection() {
    with_rejection("clear", |slot| *slot = None);
}

/// Client-drained accessor for the buffered rejection code. Returns `Some(code)`
/// exactly once per buffered rejection: the value is TAKEN, so a re-init (e.g.
/// an in-WebView reload) doesn't replay a toast the user already saw. Called
/// from BOTH `App.svelte` sites — the init-time drain and the
/// `startup-file-rejected` listener — because the event is a payload-free nudge
/// and this is the only way to read what it is about. Take-once is what makes
/// that safe: whichever arrives first wins, the other gets `None`.
#[tauri::command]
pub(crate) fn get_startup_rejection() -> Option<String> {
    with_rejection("take", |slot| slot.take())
}
/// Tests for the startup-file rejection surfacing (issue #630): the path-free
/// reason-code mapping and the buffered-rejection take/clear semantics.
#[cfg(test)]
mod startup_rejection_tests {
    use super::*;
    use crate::{
        opened_url_reason_code, post_paths_and_surface, rejection_reason_code,
        validate_open_candidate, OpenedUrlRejection, RejectionReason, ScreenedOpenPath,
    };
    use std::path::PathBuf;
    use std::sync::Mutex as StdMutex;

    // Serialize tests that mutate STARTUP_REJECTION (a process-wide static).
    static REJECTION_LOCK: StdMutex<()> = StdMutex::new(());

    #[test]
    fn reason_code_is_stable_and_path_free() {
        // The codes are the cross-process contract with the App.svelte toast
        // map — assert the exact strings so a rename can't silently desync.
        assert_eq!(
            rejection_reason_code(&RejectionReason::UnsupportedExtension {
                ext: "exe".into(),
                path: PathBuf::from("/secret/place/file.exe"),
            }),
            "unsupported-extension"
        );
        assert_eq!(
            rejection_reason_code(&RejectionReason::NotAFile {
                path: PathBuf::from("/secret/place/dir"),
            }),
            "not-a-file"
        );
        assert_eq!(
            rejection_reason_code(&RejectionReason::SuspiciousColon {
                path: PathBuf::from("/secret/place/file.md:Zone.Identifier"),
                index: 7,
            }),
            "suspicious-path"
        );
    }

    #[test]
    fn reason_code_never_leaks_the_path() {
        // The reason code is a fixed enum string; assert it shares no substring
        // with a path that would be sensitive to leak into a DOM toast.
        let secret = "/Users/victim/Secret Plans.md";
        let code = rejection_reason_code(&RejectionReason::NotAFile {
            path: PathBuf::from(secret),
        });
        assert!(
            !code.contains("Secret") && !code.contains('/'),
            "reason code must not embed the rejected path"
        );
    }

    #[test]
    fn buffer_then_get_takes_once_then_returns_none() {
        let _g = REJECTION_LOCK.lock().unwrap();
        clear_startup_rejection();

        buffer_startup_rejection_code(rejection_reason_code(&RejectionReason::UnsupportedExtension {
            ext: "exe".into(),
            path: PathBuf::from("/x/file.exe"),
        }));
        assert_eq!(
            get_startup_rejection(),
            Some("unsupported-extension".to_string()),
            "first poll returns the buffered code"
        );
        assert_eq!(
            get_startup_rejection(),
            None,
            "the buffer is TAKEN — a second poll (e.g. WebView reload) returns None"
        );
    }

    #[test]
    fn clear_drops_a_buffered_rejection() {
        let _g = REJECTION_LOCK.lock().unwrap();
        clear_startup_rejection();

        buffer_startup_rejection_code(rejection_reason_code(&RejectionReason::NotAFile {
            path: PathBuf::from("/x/missing.md"),
        }));
        // restart_sidecar calls clear_startup_rejection — a stale rejection from
        // the previous launch must not survive into the next init-time drain.
        clear_startup_rejection();
        assert_eq!(
            get_startup_rejection(),
            None,
            "clear must drop the buffered rejection"
        );
    }

    #[test]
    fn buffer_is_last_write_wins() {
        let _g = REJECTION_LOCK.lock().unwrap();
        clear_startup_rejection();

        buffer_startup_rejection_code(rejection_reason_code(&RejectionReason::NotAFile {
            path: PathBuf::from("/x/a.md"),
        }));
        buffer_startup_rejection_code(rejection_reason_code(&RejectionReason::UnsupportedExtension {
            ext: "exe".into(),
            path: PathBuf::from("/x/b.exe"),
        }));
        assert_eq!(
            get_startup_rejection(),
            Some("unsupported-extension".to_string()),
            "the most recent buffered reason wins"
        );
        clear_startup_rejection();
    }

    /// Un-gated since #1344 (`opened_url_reason_code` is now unconditionally
    /// compiled), so this contract runs on ubuntu, windows AND macOS.
    #[test]
    fn opened_url_reason_codes_are_path_free_and_stable() {
        assert_eq!(
            opened_url_reason_code(&OpenedUrlRejection::NonFileScheme),
            "non-file-url"
        );
        assert_eq!(
            opened_url_reason_code(&OpenedUrlRejection::NonEmptyHost),
            "suspicious-path"
        );
        assert_eq!(
            opened_url_reason_code(&OpenedUrlRejection::ConversionFailed),
            "not-a-file"
        );

        // The delegating arm reuses the argv path's codes rather than minting
        // new ones — App.svelte's reason-code→message map already handles both.
        let unsupported = opened_url_reason_code(&OpenedUrlRejection::PathRejected(
            RejectionReason::UnsupportedExtension {
                ext: "exe".into(),
                path: PathBuf::from("/secret/place/file.exe"),
            },
        ));
        assert_eq!(unsupported, "unsupported-extension");
        let not_a_file = opened_url_reason_code(&OpenedUrlRejection::PathRejected(
            RejectionReason::NotAFile {
                path: PathBuf::from("/Users/victim/Secret Plans.md"),
            },
        ));
        assert_eq!(not_a_file, "not-a-file");

        // Mirrors `reason_code_never_leaks_the_path`: delegating must never
        // start putting a path on the wire.
        for code in [unsupported, not_a_file] {
            assert!(
                !code.contains('/') && !code.contains("Secret"),
                "delegated reason code must not embed the rejected path"
            );
        }
    }

    /// THE delivery-ordering contract, and the reason `surface_startup_rejection`
    /// was split around a closure.
    ///
    /// Without this, two one-line mutations reverted the #1344 fix with a fully
    /// green suite: deleting the buffer write made every path emit-only again
    /// (the original cold-start drop), and swapping buffer/nudge let a live
    /// listener drain an empty slot (the nudge is payload-free, so there is
    /// nothing to fall back on). Both are killed here by asserting from INSIDE
    /// the nudge that the code is already readable.
    #[test]
    fn the_code_is_buffered_before_the_nudge_fires() {
        let _g = REJECTION_LOCK.lock().unwrap();
        clear_startup_rejection();

        let mut nudged = false;
        surface_startup_rejection_with("unsupported-extension", || {
            nudged = true;
            // A real listener answers the nudge by calling get_startup_rejection.
            // Doing that here is the whole point: it must already be there.
            assert_eq!(
                get_startup_rejection(),
                Some("unsupported-extension".to_string()),
                "the buffer must be populated BEFORE the nudge is emitted, or a \
                 listener that answers immediately drains nothing"
            );
        });
        assert!(nudged, "the nudge must actually be invoked");
        clear_startup_rejection();
    }

    /// A failed emit must not cost the toast — the code stays queued for the
    /// client's next init-time drain. This is the justification printed in
    /// `surface_startup_rejection`'s `log::warn!`, now enforced.
    #[test]
    fn a_failed_nudge_leaves_the_code_buffered() {
        let _g = REJECTION_LOCK.lock().unwrap();
        clear_startup_rejection();

        surface_startup_rejection_with("not-a-file", || { /* emit failed; do nothing */ });

        assert_eq!(
            get_startup_rejection(),
            Some("not-a-file".to_string()),
            "a dropped nudge costs one event, not the toast"
        );
        clear_startup_rejection();
    }

    /// One OS batch yields exactly one buffered code, so the toast the user gets
    /// does not depend on where the client's async drain happened to land.
    #[test]
    fn a_batch_collapses_to_one_deterministic_code() {
        let mut empty = RejectionBatch::default();
        assert_eq!(empty.resolve(), None, "nothing rejected, nothing to surface");
        empty.record("unsupported-extension");
        assert_eq!(
            empty.resolve(),
            Some("unsupported-extension"),
            "a lone rejection keeps its specific reason"
        );

        let mut mixed = RejectionBatch::default();
        mixed.record("unsupported-extension");
        mixed.record("not-a-file");
        assert_eq!(
            mixed.resolve(),
            Some("multiple-rejected"),
            "a mixed batch has no single true reason, so it must not claim one"
        );

        let mut same = RejectionBatch::default();
        same.record("not-a-file");
        same.record("not-a-file");
        assert_eq!(
            same.resolve(),
            Some("multiple-rejected"),
            "multiplicity is reported even when the reason agrees — four of five \
             files opening is the case a singular message misdescribes"
        );
    }

    // ---- #1416: the post-validation failure code and its batch ------------
    //
    // No statics are touched here, so these need neither `REJECTION_LOCK` nor
    // `pending_opens_tests`'s `FLAG_LOCK`.

    #[test]
    fn open_failed_code_is_stable() {
        // The cross-process contract with `messageForStartupRejection`'s
        // explicit `case "open-failed"`. A rename on either side desyncs
        // silently, because the client's `default` renders the same text.
        assert_eq!(CODE_OPEN_FAILED, "open-failed");
    }

    #[test]
    fn deferred_codes_are_stable_and_distinct_from_the_failure_codes() {
        assert_eq!(CODE_OPEN_DEFERRED, "open-deferred");
        assert_eq!(CODE_MULTIPLE_DEFERRED, "multiple-deferred");
        // The split is the point: a retained queue still opens on the next
        // successful start, so it must never render as the past-tense failure
        // message. Collapsing these back onto the failure codes would restore
        // the false statement this pair exists to remove.
        assert_ne!(CODE_OPEN_DEFERRED, CODE_OPEN_FAILED);
        assert_ne!(CODE_MULTIPLE_DEFERRED, CODE_MULTIPLE_REJECTED);
    }

    /// Drive `post_paths_and_surface` with an injected poster.
    ///
    /// `tauri::async_runtime::block_on` works in a plain `#[test]` — it lazily
    /// initialises its own runtime and needs no `AppHandle`, no `#[tokio::test]`
    /// and no tokio dev-dependency.
    fn run_batch(paths: &[&str], failing: &[&str], seed: Option<&'static str>) -> Vec<&'static str> {
        let mut surfaced: Vec<&'static str> = Vec::new();
        let mut batch = RejectionBatch::default();
        if let Some(code) = seed {
            batch.record(code);
        }
        // Real screened paths, because `post_paths_and_surface` now takes
        // `ScreenedOpenPath` and the newtype has no test-only constructor by
        // design (#1415). The names are matched on the file name below, so the
        // tempdir prefix is invisible to every caller.
        let dir = tempfile::TempDir::new().expect("tempdir");
        let owned: Vec<ScreenedOpenPath> = paths
            .iter()
            .map(|name| {
                let path = dir.path().join(name);
                std::fs::write(&path, b"x").expect("write fixture");
                validate_open_candidate(path).expect("fixture must pass the screener")
            })
            .collect();
        tauri::async_runtime::block_on(post_paths_and_surface(
            "test",
            owned,
            batch,
            // The `fail` decision is computed OUTSIDE the async block on
            // purpose: an `Fn` closure may only borrow, so an `async move` that
            // captured `failing` itself would be E0507 on the second call.
            |path| {
                let name = path
                    .as_path()
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let fail = failing.iter().any(|f| name == *f);
                async move {
                    if fail {
                        Err("boom".to_string())
                    } else {
                        Ok(())
                    }
                }
            },
            |code| surfaced.push(code),
        ));
        surfaced
    }

    #[test]
    fn a_fully_successful_batch_surfaces_nothing() {
        assert!(
            run_batch(&["a.md", "b.md"], &[], None).is_empty(),
            "opening two files successfully must not toast"
        );
    }

    #[test]
    fn a_failed_post_surfaces_the_open_failed_code_once() {
        // The #1416 bug itself: this used to be a `log::warn!` and nothing else,
        // which in a release build is a file the user never opens.
        assert_eq!(run_batch(&["big.md"], &["big.md"], None), vec!["open-failed"]);
        // Two failures are still ONE surface call, and report multiplicity.
        assert_eq!(
            run_batch(&["a.md", "b.md", "c.md"], &["a.md", "c.md"], None),
            vec!["multiple-rejected"]
        );
    }

    #[test]
    fn a_validation_rejection_and_a_post_failure_share_one_toast() {
        // One Finder multi-select: a .pdf refused by the validator and a 60 MB
        // .md refused by the server. Two surface calls would write twice into
        // the one-slot buffer, and `useNotifications` would show a count badge
        // whose value depends on where the client's async drain landed — the
        // exact race `RejectionBatch` exists to remove.
        let surfaced = run_batch(&["huge.md"], &["huge.md"], Some("unsupported-extension"));
        assert_eq!(
            surfaced,
            vec!["multiple-rejected"],
            "the batch spans validation AND delivery, and resolves exactly once"
        );
    }

    #[test]
    fn a_batch_with_nothing_to_post_still_surfaces_its_rejections() {
        // A fully-rejected batch (the common shape since #1344: a double-clicked
        // .pdf, a stale alias) has nothing to POST and still has something to
        // say. `post_batch_for_app`'s early return mirrors this by surfacing
        // BEFORE it returns — that ordering is not covered here, since it needs
        // an AppHandle; this pins the helper's half of it.
        assert_eq!(run_batch(&[], &[], Some("not-a-file")), vec!["not-a-file"]);
    }
}
