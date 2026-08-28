//! Pending-update boot marker (#1118, the ADR-043 deferred follow-up).
//!
//! `AppHandle::restart()` is divergent, and on Windows the updater plugin does
//! not even reach it: `install_inner` ends in an unconditional
//! `std::process::exit(0)` after a `ShellExecuteW` whose return is discarded
//! (tauri-plugin-updater-2.10.1 `src/updater.rs:865`). Either way the process
//! that started an update is gone before it can observe the outcome, so "the
//! installer ran and the shell came back on the old binary" is completely
//! silent today. A small file on disk is the smallest carrier of "an update was
//! in flight" across the boundary that divergent exit destroys.
//!
//! Everything here is DELIBERATELY UNGATED — no `#[cfg(target_os = ...)]`. A
//! cfg'd body in this file is parsed but never type-checked on other hosts
//! (cfg-stripping runs before name resolution), so gated logic would be proven
//! by nothing until CI's three-OS `rust-test` matrix. Keeping the logic in
//! ungated helpers that take `&Path` / `&str` is what makes `cargo test` on any
//! one host actually mean something.
//!
//! **Extracted from `lib.rs` (Unit 11a).** The four items `lib.rs` still calls
//! are `pub(crate)` -- `evaluate_pending_update_marker`,
//! `get_pending_update_hint`, `record_pending_update` and
//! `clear_pending_update`. That is what the move requires and no wider:
//! `mod pending_update;` is declared bare rather than `pub`, so nothing here
//! is reachable from `src-tauri/tests/*.rs` either way -- matching
//! `autostart.rs`, and unlike `keychain.rs`, which needs `pub mod` for its
//! own external integration test. Everything else stays private to this
//! module, and the test module is a descendant so it keeps its access to
//! `PendingUpdateMarker`'s private fields without widening anything.
//!
//! `check_for_update_now` deliberately did NOT move. Its body is a single call
//! to `check_for_update`, a private crate-root function five thousand lines
//! away that four unrelated sites also use; moving the command here would have
//! forced that function public — a visibility widening on an item outside this
//! cluster, which is exactly what the extraction is not allowed to do.

use std::sync::Mutex;

use tauri::{Emitter, Manager};

/// Marker file recording an in-flight update, written beside the `autostart-seen`
/// marker at the app-data root.
const PENDING_UPDATE_MARKER: &str = "update-pending.json";

/// Contents of [`PENDING_UPDATE_MARKER`]. Rust-only file, never read by the
/// sidecar or the WebView, so the field names stay snake_case.
///
/// `ts` is DIAGNOSTIC ONLY — nothing branches on it. It exists so a support log
/// can say when the attempt happened; adding a staleness rule here would be a
/// behaviour change, not a tidy-up.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct PendingUpdateMarker {
    target_version: String,
    ts: u64,
}

/// What the boot-time read concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingUpdateVerdict {
    /// No marker, or one too damaged to trust. Nothing to say.
    NoMarker,
    /// The running version matches the version we were installing.
    Completed,
    /// A marker survived and we are NOT running the version it names.
    MayHaveFailed,
}

/// Shape guard for a version string read back off disk. READER-SIDE ONLY.
///
/// The writer deliberately does not validate, so an unusual-but-legitimate
/// version fails toward SILENCE (written, then read back as `NoMarker` and
/// deleted) rather than toward a false "your update may not have completed".
/// Validating on the write side too would produce the same silence with an
/// extra branch. The `debug` log is what leaves a trace if this ever bites.
fn plausible_version(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '+' || c == '-')
}

/// Pure verdict function — no I/O, no Tauri types, total over well-formed input.
///
/// Normalization (trim, strip one leading `v`) is defence-in-depth: the version
/// we write comes from `Update::version`, which the plugin has already
/// normalized. It costs nothing and removes a whole class of "nagged after a
/// successful update" bug if that ever stops being true.
///
/// KNOWN RESIDUAL, and it is the one most likely to be hit: this answers "did
/// the shell binary's version change", NOT "did the update complete". A Windows
/// half-install where NSIS replaced `Tandem.exe` but not `node-sidecar.exe` —
/// a state `perform_install` explicitly tolerates, see the "still locked" and
/// "still responding" warnings — lands here as `Completed`. Recorded in ADR-043
/// beside "no rollback". Closing it needs the marker to carry an expected
/// sidecar version, which is a different change.
fn classify_pending_update(
    marker: Option<PendingUpdateMarker>,
    running_version: &str,
) -> PendingUpdateVerdict {
    let Some(marker) = marker else {
        return PendingUpdateVerdict::NoMarker;
    };
    // `trim()` here is belt-and-braces for the `running_version` side;
    // whitespace on the marker side is already screened upstream by
    // `read_pending_update_marker`, which trims before its shape guard.
    let normalize = |s: &str| {
        let t = s.trim();
        t.strip_prefix('v').unwrap_or(t).to_string()
    };
    if normalize(&marker.target_version) == normalize(running_version) {
        PendingUpdateVerdict::Completed
    } else {
        PendingUpdateVerdict::MayHaveFailed
    }
}

/// Write the marker. Returns `Result` ONLY so tests can assert on it — the
/// production caller discards it, because a marker write must never fail an
/// update (#1118: "best-effort").
///
/// The timestamp is computed here rather than by the caller so the panic audit
/// has one function to read. `.unwrap_or_default()` is load-bearing, not
/// idiom: `duration_since(UNIX_EPOCH)` errors on a clock set before the epoch,
/// and the idiomatic `.unwrap()` would panic INSIDE a closure unwinding through
/// the plugin's `download()`, aborting the tokio task so that NEITHER match arm
/// in `perform_install` runs and no error dialog ever appears — a silently
/// failed update, exactly what this issue exists to prevent.
///
/// Not atomic, and deliberately so: `cowork_atomic_json::with_locked_json` is
/// Windows-only AND carries a 30-second exclusive-lock budget, and a marker
/// write that can stall an update by 30s is the regression #1118 forbids. The
/// reachable bad states without it (truncate-then-die, ext4 delayed-allocation
/// zero-fill) are both parse failures, and both are swept by the unconditional
/// clear in `evaluate_pending_update_marker`.
fn write_pending_update_marker(dir: &std::path::Path, target_version: &str) -> std::io::Result<()> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let marker = PendingUpdateMarker {
        target_version: target_version.to_string(),
        ts,
    };
    let body = serde_json::to_string(&marker)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(PENDING_UPDATE_MARKER), body)
}

/// Read the marker. TOTAL — returns `Option`, never `Result`.
///
/// Missing dir, missing file, permission error, non-UTF-8, 0-byte, malformed
/// JSON, missing fields and implausible versions all collapse to `None`, so a
/// corrupt marker can never fail a boot. Owning the shape guard here is what
/// lets `classify_pending_update` stay total over well-formed input.
fn read_pending_update_marker(dir: &std::path::Path) -> Option<PendingUpdateMarker> {
    let raw = std::fs::read_to_string(dir.join(PENDING_UPDATE_MARKER)).ok()?;
    let mut marker: PendingUpdateMarker = serde_json::from_str(&raw).ok()?;
    // Trim BEFORE the guard, not after. `plausible_version` rejects every ASCII
    // space, so with the order reversed a marker carrying a stray trailing
    // newline would be screened out here and silently become `NoMarker` — the
    // failure would be invisible, and `classify_pending_update`'s own `trim()`
    // would be unreachable through the only real producer.
    marker.target_version = marker.target_version.trim().to_string();
    if !plausible_version(&marker.target_version) {
        log::debug!("Ignoring pending-update marker with implausible target_version");
        return None;
    }
    Some(marker)
}

/// Remove the marker. `true` when it is provably gone — removed, or already
/// absent.
///
/// No existence pre-check: that is what makes this a silent no-op on a clean
/// boot, which in turn is what lets `evaluate_pending_update_marker` call it
/// unconditionally on every verdict instead of carrying a "did a file exist"
/// discriminator that would widen the reader back into a `Result`.
fn clear_pending_update_marker(dir: &std::path::Path) -> bool {
    match std::fs::remove_file(dir.join(PENDING_UPDATE_MARKER)) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            log::warn!("Could not remove pending-update marker: {e}");
            false
        }
    }
}

/// Buffered pending-update hint CODE, drained by the WebView.
///
/// A SEPARATE static from `STARTUP_REJECTION`, not a reuse: that buffer is one
/// last-write-wins slot, so sharing it would let a file-open rejection and an
/// update hint clobber each other.
///
/// Same buffer-then-payload-free-nudge shape and the same reason: this is
/// classified in `setup()`, before `App.svelte` exists at all, let alone its
/// listener. Emitting an event there drops silently on the exact failure mode it
/// is meant to surface. See `startup_rejection::STARTUP_REJECTION` for why "the
/// WebView is surely up by now" is not an inference we are allowed to make.
static PENDING_UPDATE_HINT: Mutex<Option<String>> = Mutex::new(None);

/// Run `f` against the hint buffer, recovering from (and reporting) a poisoned
/// mutex. Mirrors `with_rejection`; `.lock().unwrap()` is itself a panic path
/// and this code must not add one to the boot sequence.
fn with_pending_hint<R>(what: &str, f: impl FnOnce(&mut Option<String>) -> R) -> R {
    match PENDING_UPDATE_HINT.lock() {
        Ok(mut guard) => f(&mut guard),
        Err(poisoned) => {
            log::error!("PENDING_UPDATE_HINT mutex poisoned during {what} — recovering");
            f(&mut poisoned.into_inner())
        }
    }
}

/// Stable, path-free, version-free reason code for the pending-update banner.
const CODE_UPDATE_MAY_NOT_HAVE_COMPLETED: &str = "update-may-not-have-completed";

/// Payload-free nudge meaning "call `get_pending_update_hint`".
const EVENT_PENDING_UPDATE_HINT: &str = "pending-update-hint";

/// Buffer first, then nudge — split from the Tauri wrapper so the ORDERING is
/// testable without an `AppHandle`. A nudge that outran the buffer would hand a
/// live listener an empty slot and drop the hint permanently.
///
/// `&'static str`, not `&str`, and that is a safety property rather than a style
/// choice: it is what makes "a formatted string carrying a version or a path"
/// a compile error instead of something review has to notice. Same contract as
/// `buffer_startup_rejection_code`.
fn surface_pending_update_hint_with(code: &'static str, nudge: impl FnOnce()) {
    with_pending_hint("buffer", |slot| *slot = Some(code.to_string()));
    nudge();
}

/// Deliver a pending-update hint to the WebView.
fn surface_pending_update_hint(app: &tauri::AppHandle, code: &'static str) {
    surface_pending_update_hint_with(code, || {
        if let Err(e) = app.emit(EVENT_PENDING_UPDATE_HINT, ()) {
            // Already buffered, so the worst case is the banner waiting for the
            // client's init drain.
            log::warn!("Failed to emit {EVENT_PENDING_UPDATE_HINT}: {e}");
        }
    });
}

/// Client-drained accessor. TAKES, so a WebView reload cannot replay a banner
/// the user already saw.
#[tauri::command]
pub(crate) fn get_pending_update_hint() -> Option<String> {
    with_pending_hint("take", |slot| slot.take())
}

/// Record that an update install is in flight. Returns `()` — there is nothing
/// for the caller to inspect, propagate or `?`, which is what makes
/// "best-effort" a type-level property rather than a convention.
pub(crate) fn record_pending_update(app: &tauri::AppHandle, target_version: &str) {
    // NB: no `strip_win_prefix()` here, and that is deliberate. That rule
    // governs paths handed to the Node sidecar, which cannot resolve `\\?\`.
    // `std::fs` handles the extended-length prefix correctly, so stripping it
    // would be the bug.
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("app_data_dir unavailable for pending-update marker: {e}");
            return;
        }
    };
    match write_pending_update_marker(&dir, target_version) {
        Ok(()) => log::info!("Recorded pending update to v{target_version}"),
        Err(e) => log::warn!("Could not write pending-update marker: {e}"),
    }
}

/// Drop the marker after an install failure that we OBSERVED in-process.
///
/// The `Err` arm already shows the user a native error dialog, so a surviving
/// marker would nag on the next boot about something they were told to their
/// face.
pub(crate) fn clear_pending_update(app: &tauri::AppHandle) {
    match app.path().app_data_dir() {
        Ok(dir) => {
            clear_pending_update_marker(&dir);
        }
        Err(e) => log::warn!("app_data_dir unavailable to clear pending-update marker: {e}"),
    }
}

/// Decide what to do with a verdict once the clear has been attempted.
///
/// Pure, so the policy is exhaustively testable without a filesystem that can
/// be made to fail `remove_file` — which is not something a test running as
/// root can arrange.
///
/// **A hint that cannot be made one-shot is worse than no hint.** If the clear
/// failed — a read-only app-data dir, a marker locked by an AV scanner or a
/// roaming-profile sync — the same `MayHaveFailed` verdict would fire on every
/// subsequent boot, and the take-once buffer would re-raise the banner each
/// time with no way for the user to stop it. That is the one residual FALSE
/// POSITIVE in this design, so it is suppressed rather than shipped: a missed
/// diagnostic is recoverable, a permanent un-dismissable nag is not.
fn verdict_after_clear(verdict: PendingUpdateVerdict, cleared: bool) -> PendingUpdateVerdict {
    if cleared {
        return verdict;
    }
    match verdict {
        PendingUpdateVerdict::MayHaveFailed => PendingUpdateVerdict::NoMarker,
        other => other,
    }
}

/// Boot-time evaluation, as an UNGATED seam over `&Path` / `&str`.
///
/// This exists as its own function for one reason: the one-shot clear is the
/// single invariant whose failure produces a permanent, every-boot,
/// un-dismissable nag for every affected user, and with the logic living inside
/// an `AppHandle`-taking function it was pinned by nothing — deleting the clear
/// outright left `cargo test`, the client suites, biome and typecheck all green.
/// The only thing that would have caught it was a hardware-gated manual smoke
/// bullet on the very platforms whose unavailability is why #1118 sat deferred.
/// Taking `&Path`/`&str` — the same seam every other helper in this module uses
/// — is what lets that invariant execute on every host and every CI leg.
///
/// Read → classify → clear → apply the suppression policy. Idempotent by
/// construction and with no latch: the read is destructive, so a second call
/// finds `NoMarker`, clears a file that is already gone, and hints nothing.
fn evaluate_pending_update_at(
    dir: &std::path::Path,
    running_version: &str,
) -> PendingUpdateVerdict {
    let verdict = classify_pending_update(read_pending_update_marker(dir), running_version);

    // Unconditional, on every verdict: `clear` is a no-op when absent, which is
    // how a corrupt marker gets removed without a "did a file exist" branch.
    // One-shot is the issue's explicit requirement ("never nag twice for the
    // same attempt"); the banner's own "Check for updates" CTA is the
    // remediation, and on a boot where the sidecar never came up it is the ONLY
    // one available for the next 8 hours (the launch-time `check_for_update`
    // sits behind `start_sidecar`'s failure `return`, and the periodic task
    // discards its first immediate tick).
    let cleared = clear_pending_update_marker(dir);
    if !cleared {
        log::error!(
            "Could not clear the pending-update marker — suppressing the hint rather than \
             raising a banner that would return on every boot with no way to dismiss it"
        );
    }
    verdict_after_clear(verdict, cleared)
}

/// Boot-time evaluation. Returns `()`; every step is either infallible or
/// `match`ed to a log line, so this cannot turn `setup()` into an `Err` and the
/// app can never fail to start because of the marker.
///
/// Runs in `setup()` rather than after `wait_for_health()` — which is what the
/// issue text suggested — because `start_sidecar`'s health-`Ok` arm is reached
/// ONLY when `wait_for_health` returns `Ok`, and a half-installed update IS a
/// boot where the sidecar does not come up healthy. Evaluating there would
/// suppress the hint on exactly the boots it exists for.
///
/// Everything decidable without Tauri lives in `evaluate_pending_update_at`;
/// what is left here is dir resolution, logging and the emit.
pub(crate) fn evaluate_pending_update_marker(app: &tauri::AppHandle) {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("app_data_dir unavailable to read pending-update marker: {e}");
            return;
        }
    };
    // `package_info().version` and NOT `env!("CARGO_PKG_VERSION")`. `env!` reads
    // Cargo.toml; the updater's own comparison baseline is
    // `app.package_info().version` (tauri.conf.json) — see
    // tauri-plugin-updater `updater.rs:169`. They agree today only because
    // `tests/plugin/plugin-version-pin.test.ts` pins both to package.json, and
    // reading a different field than the updater compares would turn a missed
    // surface in the six-surface version bump into a warning banner on every
    // user's machine after every successful update.
    let running = app.package_info().version.to_string();

    match evaluate_pending_update_at(&dir, &running) {
        PendingUpdateVerdict::NoMarker => {}
        PendingUpdateVerdict::Completed => {
            log::info!("Update to v{running} verified — clearing pending-update marker");
        }
        PendingUpdateVerdict::MayHaveFailed => {
            log::warn!("Pending-update marker survived an update — running v{running}");
            surface_pending_update_hint(app, CODE_UPDATE_MAY_NOT_HAVE_COMPLETED);
        }
    }
}

#[cfg(test)]
mod pending_update_tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // Serialize the tests that touch PENDING_UPDATE_HINT (a process-wide
    // static), exactly as `startup_rejection_tests` does with REJECTION_LOCK.
    static HINT_LOCK: StdMutex<()> = StdMutex::new(());

    fn marker(v: &str) -> PendingUpdateMarker {
        PendingUpdateMarker {
            target_version: v.to_string(),
            ts: 1_700_000_000,
        }
    }

    // --- write / read round trip -------------------------------------------

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempfile::TempDir::new().unwrap();
        write_pending_update_marker(dir.path(), "0.24.0").unwrap();

        let got = read_pending_update_marker(dir.path()).expect("marker should read back");
        assert_eq!(got.target_version, "0.24.0");
        // The timestamp is computed inside the writer. A `ts` stuck at 0 means
        // the clock step silently degraded (`unwrap_or_default`) on a machine
        // where it should not have.
        assert_ne!(got.ts, 0, "writer must stamp a real timestamp");
        assert!(got.ts > 1_600_000_000, "ts should be a plausible epoch: {}", got.ts);
    }

    #[test]
    fn read_returns_none_for_missing_file_and_missing_dir() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(read_pending_update_marker(dir.path()), None);
        assert_eq!(
            read_pending_update_marker(&dir.path().join("does-not-exist")),
            None
        );
    }

    #[test]
    fn read_returns_none_for_malformed_json_and_zero_byte_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join(PENDING_UPDATE_MARKER);

        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(read_pending_update_marker(dir.path()), None, "malformed JSON");

        std::fs::write(&path, b"").unwrap();
        assert_eq!(read_pending_update_marker(dir.path()), None, "zero-byte file");

        // Well-formed JSON, wrong shape — the `ts` field is missing.
        std::fs::write(&path, br#"{"target_version":"0.24.0"}"#).unwrap();
        assert_eq!(read_pending_update_marker(dir.path()), None, "missing field");
    }

    #[test]
    fn read_rejects_implausible_version() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join(PENDING_UPDATE_MARKER);

        for bad in [
            "x".repeat(500),
            "0.24.0\u{0}\u{1}".to_string(),
            String::new(),
            "0.24.0 && rm -rf /".to_string(),
        ] {
            let body = serde_json::to_string(&PendingUpdateMarker {
                target_version: bad.clone(),
                ts: 1,
            })
            .unwrap();
            std::fs::write(&path, body).unwrap();
            assert_eq!(
                read_pending_update_marker(dir.path()),
                None,
                "should reject implausible version: {bad:?}"
            );
        }

        // Control: the guard must not be so tight that real versions bounce.
        for good in ["0.24.0", "1.0.0-rc.1", "0.24.0+build.5", "v0.24.0"] {
            let body = serde_json::to_string(&marker(good)).unwrap();
            std::fs::write(&path, body).unwrap();
            assert!(
                read_pending_update_marker(dir.path()).is_some(),
                "should accept real version: {good}"
            );
        }
    }

    // --- classifier ---------------------------------------------------------

    #[test]
    fn classify_matching_version_is_completed() {
        assert_eq!(
            classify_pending_update(Some(marker("0.24.0")), "0.24.0"),
            PendingUpdateVerdict::Completed
        );
        // Defence-in-depth — `Update::version` reaches us already normalized, so
        // this pins nothing that can realistically drift. It is here so a future
        // writer that does NOT normalize cannot silently start nagging after
        // every successful update. `plausible_version` accepts a leading `v`, so
        // unlike whitespace this branch IS reachable through the read path.
        assert_eq!(
            classify_pending_update(Some(marker("v0.24.0")), "0.24.0"),
            PendingUpdateVerdict::Completed
        );
    }

    #[test]
    fn whitespace_is_trimmed_on_the_read_path_before_the_shape_guard() {
        // Order matters and is easy to get backwards. `plausible_version`
        // rejects every ASCII space, so if the reader guarded before trimming, a
        // marker carrying a stray trailing newline would silently read back as
        // `None` -> `NoMarker` -> no banner, and `classify`'s own `trim()` would
        // be unreachable through the only real producer.
        let dir = tempfile::TempDir::new().unwrap();
        let body = serde_json::to_string(&PendingUpdateMarker {
            target_version: "  0.24.0\n".to_string(),
            ts: 1,
        })
        .unwrap();
        std::fs::write(dir.path().join(PENDING_UPDATE_MARKER), body).unwrap();

        let got = read_pending_update_marker(dir.path()).expect("whitespace must be trimmed, not rejected");
        assert_eq!(got.target_version, "0.24.0");
        assert_eq!(
            classify_pending_update(Some(got), "0.24.0"),
            PendingUpdateVerdict::Completed
        );
    }

    #[test]
    fn classify_mismatched_version_is_may_have_failed() {
        // The load-bearing direction: an inverted comparison here would make the
        // whole feature silently never fire, and every other test would pass.
        assert_eq!(
            classify_pending_update(Some(marker("0.24.0")), "0.23.0"),
            PendingUpdateVerdict::MayHaveFailed
        );
        assert_eq!(
            classify_pending_update(Some(marker("0.24.0")), "0.24.1"),
            PendingUpdateVerdict::MayHaveFailed
        );
    }

    #[test]
    fn classify_none_is_no_marker() {
        assert_eq!(
            classify_pending_update(None, "0.23.0"),
            PendingUpdateVerdict::NoMarker
        );
    }

    // --- clear --------------------------------------------------------------

    #[test]
    fn clear_is_idempotent_and_reports_absence() {
        let dir = tempfile::TempDir::new().unwrap();

        // Already absent must report success, or every clean boot would warn.
        assert!(clear_pending_update_marker(dir.path()));

        write_pending_update_marker(dir.path(), "0.24.0").unwrap();
        assert!(clear_pending_update_marker(dir.path()));
        assert_eq!(read_pending_update_marker(dir.path()), None);
        assert!(clear_pending_update_marker(dir.path()), "second clear");
    }

    // --- panic containment --------------------------------------------------

    #[test]
    fn write_into_a_path_blocked_by_a_file_returns_err_not_panic() {
        let dir = tempfile::TempDir::new().unwrap();
        // A regular file where the marker's directory should be: `create_dir_all`
        // fails. The point is that it returns Err rather than panicking — a
        // panic here unwinds through the plugin's `download()` and kills both
        // match arms in `perform_install`, so the user gets no error dialog.
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"i am a file").unwrap();

        let result = write_pending_update_marker(&blocked, "0.24.0");
        assert!(result.is_err(), "expected Err, got {result:?}");
    }

    // --- buffer + nudge ordering --------------------------------------------

    #[test]
    fn surface_pending_update_hint_with_buffers_before_nudging() {
        let _g = HINT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        with_pending_hint("test-reset", |slot| *slot = None);

        // The nudge is payload-free, so a listener answers it by draining the
        // buffer. If the nudge fired first the slot would be empty and the hint
        // would be dropped permanently.
        let mut seen_during_nudge: Option<String> = None;
        surface_pending_update_hint_with(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED, || {
            seen_during_nudge = with_pending_hint("test-peek", |slot| slot.clone());
        });

        assert_eq!(
            seen_during_nudge.as_deref(),
            Some(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED),
            "buffer must be populated BEFORE the nudge fires"
        );

        with_pending_hint("test-reset", |slot| *slot = None);
    }

    #[test]
    fn get_pending_update_hint_takes_once() {
        let _g = HINT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        with_pending_hint("test-reset", |slot| *slot = None);

        surface_pending_update_hint_with(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED, || {});

        assert_eq!(
            get_pending_update_hint().as_deref(),
            Some(CODE_UPDATE_MAY_NOT_HAVE_COMPLETED)
        );
        // Take-once: a WebView reload re-runs the init drain, and a peek-style
        // accessor would replay the banner the user already dismissed.
        assert_eq!(get_pending_update_hint(), None, "second read must be empty");

        with_pending_hint("test-reset", |slot| *slot = None);
    }

    // --- the one-shot clear, and the policy that guards it -----------------

    #[test]
    fn evaluating_a_mismatch_hints_once_and_consumes_the_marker() {
        // THE load-bearing test of this change. One-shot is the issue's explicit
        // requirement, and its failure mode is the worst one available: a
        // permanent, every-boot, un-dismissable banner for every affected user.
        // Before this test existed, deleting the clear outright left `cargo
        // test`, the client suites, biome and typecheck all green.
        let dir = tempfile::TempDir::new().unwrap();
        write_pending_update_marker(dir.path(), "0.24.0").unwrap();

        assert_eq!(
            evaluate_pending_update_at(dir.path(), "0.23.0"),
            PendingUpdateVerdict::MayHaveFailed
        );
        assert!(
            !dir.path().join(PENDING_UPDATE_MARKER).exists(),
            "the marker must be gone after it has been surfaced once"
        );
        // A second boot must say nothing at all.
        assert_eq!(
            evaluate_pending_update_at(dir.path(), "0.23.0"),
            PendingUpdateVerdict::NoMarker,
            "a second evaluation must not re-raise the hint"
        );
    }

    #[test]
    fn evaluating_a_match_reports_completed_and_consumes_the_marker() {
        let dir = tempfile::TempDir::new().unwrap();
        write_pending_update_marker(dir.path(), "0.24.0").unwrap();

        assert_eq!(
            evaluate_pending_update_at(dir.path(), "0.24.0"),
            PendingUpdateVerdict::Completed
        );
        assert!(!dir.path().join(PENDING_UPDATE_MARKER).exists());
    }

    #[test]
    fn evaluating_a_corrupt_marker_says_nothing_and_still_removes_it() {
        // The clear is unconditional precisely so a marker too damaged to
        // classify does not linger forever. If the clear were moved onto the
        // hint branch, this file would survive every boot.
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(PENDING_UPDATE_MARKER), b"{ not json").unwrap();

        assert_eq!(
            evaluate_pending_update_at(dir.path(), "0.23.0"),
            PendingUpdateVerdict::NoMarker
        );
        assert!(
            !dir.path().join(PENDING_UPDATE_MARKER).exists(),
            "a corrupt marker must not linger"
        );
    }

    #[test]
    fn evaluating_a_clean_boot_is_a_silent_no_op() {
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(
            evaluate_pending_update_at(dir.path(), "0.23.0"),
            PendingUpdateVerdict::NoMarker
        );
    }

    #[test]
    fn a_failed_clear_suppresses_the_hint_but_nothing_else() {
        // Exhaustive over the policy. A `remove_file` failure cannot be staged
        // in a test running as root, which is exactly why the decision is a pure
        // function rather than a branch buried in the I/O path.
        use PendingUpdateVerdict::{Completed, MayHaveFailed, NoMarker};
        for v in [NoMarker, Completed, MayHaveFailed] {
            assert_eq!(verdict_after_clear(v, true), v, "a successful clear changes nothing");
        }
        assert_eq!(verdict_after_clear(NoMarker, false), NoMarker);
        assert_eq!(verdict_after_clear(Completed, false), Completed);
        // The one residual false positive in the design: a hint that cannot be
        // made one-shot would return every boot with no way to dismiss it, so it
        // is suppressed rather than shipped.
        assert_eq!(
            verdict_after_clear(MayHaveFailed, false),
            NoMarker,
            "an un-clearable marker must not raise a permanent nag"
        );
    }

    #[test]
    fn hint_code_is_stable_and_carries_no_version_or_path() {
        // Cross-process contract with the client's message map.
        assert_eq!(
            CODE_UPDATE_MAY_NOT_HAVE_COMPLETED,
            "update-may-not-have-completed"
        );
        assert!(!CODE_UPDATE_MAY_NOT_HAVE_COMPLETED.contains('/'));
        assert!(!CODE_UPDATE_MAY_NOT_HAVE_COMPLETED.contains('\\'));
        assert!(
            !CODE_UPDATE_MAY_NOT_HAVE_COMPLETED
                .chars()
                .any(|c| c.is_ascii_digit()),
            "the code must not carry a version"
        );
    }
}
