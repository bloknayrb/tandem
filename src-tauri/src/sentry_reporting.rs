//! Crash reporting via `tauri-plugin-sentry` (#921).
//!
//! ## Privacy posture: OPT-IN, off by default
//!
//! Telemetry is **disabled unless** the operator sets a DSN via the
//! `TANDEM_SENTRY_DSN` environment variable. With no DSN, [`init`] calls
//! `sentry::init` with an empty DSN, which yields a *disabled* (no-op) client:
//! no network egress, no minidump handler, no IPC transport injection into the
//! WebView. This matches Tandem's local-first posture — crash reporting is a
//! thing the operator turns on, never an always-on default.
//!
//! ## What it captures (when enabled)
//!
//! - Rust panics in the shell (`sentry::init` installs a `panic::set_hook`).
//! - Native minidumps from hard crashes (segfaults, aborts) via the plugin's
//!   re-exported `minidump` handler — the one signal neither the Node sidecar
//!   handlers nor the WebView `ErrorBoundary` can produce.
//! - JavaScript errors / unhandled promise rejections, bridged from
//!   `@sentry/browser` in the WebView over Tauri IPC to this Rust client
//!   (see `src/client/sentry.ts`).
//!
//! ## No global-subscriber collision
//!
//! The Sentry Rust SDK's default feature set does **not** install a global
//! `tracing` subscriber (only the optional `sentry-tracing` integration does,
//! and we don't enable it). `tauri-plugin-log` and the `devtools` feature each
//! own the global `tracing` subscriber; Sentry coexists with whichever is
//! active. See CLAUDE.md "devtools is mutually exclusive with tauri-plugin-log".
//!
//! ## PII scrubbing
//!
//! A `before_send` hook scrubs events before they leave the process:
//! - absolute home-directory paths are rewritten to `~/…`
//! - the DSN is never logged
//! Document content and annotation bodies never reach this layer — they live in
//! the sidecar/WebView and are not attached to Rust panic events. The WebView
//! side applies its own scrubbing in `src/client/sentry.ts`.

use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Environment variable that supplies the Sentry/GlitchTip DSN. Unset → crash
/// reporting is a no-op. Keep this name in sync with the `TANDEM_SENTRY_DSN`
/// reference in `src/client/sentry.ts` and the README opt-in docs.
pub const SENTRY_DSN_ENV: &str = "TANDEM_SENTRY_DSN";

/// Process-wide flag: set true exactly once, when [`init`] constructs a real
/// (DSN-configured) client. Read by the `sentry_enabled` Tauri command so the
/// WebView can decide whether to initialise `@sentry/browser` — the WebView
/// can't read the env var, and injection-via-`eval` races page load, so a
/// command read is the deterministic source of truth.
static SENTRY_ENABLED: AtomicBool = AtomicBool::new(false);

/// Whether opt-in crash reporting was enabled at startup. Exposed to the WebView
/// via the `sentry_enabled` command.
pub fn is_enabled() -> bool {
    SENTRY_ENABLED.load(Ordering::Acquire)
}

/// Opaque guard bundle that must outlive the Tauri event loop. Holding the
/// `ClientInitGuard` keeps the Sentry client alive (it flushes on drop); the
/// `minidump` guard (boxed, type-erased) keeps the out-of-process crash
/// reporter alive. Dropping either early would silently disable reporting, so
/// `run()` binds this to a `let _guard` that lives for the whole function.
pub struct SentryGuard {
    client: sentry::ClientInitGuard,
    // The minidump init returns a process guard whose concrete type we don't
    // need to name; box it so a disabled build can store `None` uniformly.
    #[allow(dead_code)]
    _minidump: Option<Box<dyn std::any::Any + Send + Sync>>,
}

impl SentryGuard {
    /// Borrow the live Sentry client guard for plugin registration.
    /// `ClientInitGuard` derefs to `sentry::Client`, so `guard.client()`
    /// coerces to the `&Client` that `tauri_plugin_sentry::init` expects.
    pub fn client(&self) -> &sentry::ClientInitGuard {
        &self.client
    }
}

/// Initialise crash reporting. Returns `Some(guard)` when a DSN is configured
/// (the guard MUST be kept alive for the lifetime of the app), or `None` when
/// telemetry is disabled (no DSN) — in which case the caller registers no
/// plugin and the WebView injection never happens.
///
/// The returned `sentry::ClientInitGuard` is *always* constructed (even with an
/// empty DSN it is a valid, disabled client), but we only return `Some` and ask
/// the caller to register the plugin when a DSN is actually present, so the
/// IPC-transport injection into the WebView is likewise gated on opt-in.
pub fn init() -> Option<SentryGuard> {
    let dsn = std::env::var(SENTRY_DSN_ENV).ok().filter(|d| !d.trim().is_empty());

    let Some(dsn) = dsn else {
        log::info!(
            "[sentry] crash reporting disabled (set {SENTRY_DSN_ENV} to opt in)"
        );
        return None;
    };

    // NB: do NOT log the DSN — it can embed a public key. Log only that we
    // enabled, not the value.
    log::info!("[sentry] crash reporting enabled (DSN configured via {SENTRY_DSN_ENV})");

    let client = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: sentry::release_name!(),
            // Crash events only — no session/usage telemetry. Even though the
            // operator opted in by setting a DSN, the privacy-minimal posture is
            // to ship faults, not session pings (#921).
            auto_session_tracking: false,
            // Scrub PII before any event leaves the process.
            before_send: Some(Arc::new(|mut event| {
                scrub_event(&mut event);
                Some(event)
            })),
            // Belt-and-braces: ask the SDK not to attach IP / identifying data.
            send_default_pii: false,
            ..Default::default()
        },
    ));

    // Out-of-process native crash handler (minidumps). Re-exported by the
    // plugin so no separate `sentry-rust-minidump` dependency is required.
    // iOS is not a Tandem build target, but gate defensively to match the
    // plugin's own contract ("everything before here runs in both the app and
    // the crash-reporter process").
    #[cfg(not(target_os = "ios"))]
    let minidump: Option<Box<dyn std::any::Any + Send + Sync>> =
        Some(Box::new(tauri_plugin_sentry::minidump::init(&client)));
    #[cfg(target_os = "ios")]
    let minidump: Option<Box<dyn std::any::Any + Send + Sync>> = None;

    SENTRY_ENABLED.store(true, Ordering::Release);
    Some(SentryGuard { client, _minidump: minidump })
}

/// Mutate an outgoing Sentry event in place to strip personally-identifying
/// data. Currently: rewrite the user's home directory to `~` everywhere it
/// appears in the event's stringified surfaces. Pure-ish (reads `$HOME` once);
/// unit-tested via [`redact_home`].
fn scrub_event(event: &mut sentry::protocol::Event<'static>) {
    let Some(home) = home_dir_string() else { return };

    // Scrub the top-level message and any exception values/types — these are
    // the surfaces most likely to embed an absolute path (panic payloads,
    // file-not-found messages, etc.).
    if let Some(msg) = event.message.take() {
        event.message = Some(redact_home(&msg, &home).into_owned());
    }
    for exception in event.exception.values.iter_mut() {
        if let Some(value) = exception.value.take() {
            exception.value = Some(redact_home(&value, &home).into_owned());
        }
    }
}

/// Best-effort home-directory lookup as a `String`, normalised without a
/// trailing separator so the replacement reads `~/foo` not `~//foo`.
fn home_dir_string() -> Option<String> {
    let home = dirs::home_dir()?;
    let s = home.to_string_lossy();
    Some(s.trim_end_matches(['/', '\\']).to_string())
}

/// Replace every occurrence of the absolute home directory `home` in `input`
/// with `~`. Returns a borrowed `Cow` when nothing matched (the common case)
/// so the hot path allocates nothing. A `home` of length ≤ 1 (e.g. `""` or a
/// degenerate root `/`) is a no-op: it would otherwise match between every
/// character / replace every separator.
pub(crate) fn redact_home<'a>(input: &'a str, home: &str) -> Cow<'a, str> {
    if home.len() <= 1 || !input.contains(home) {
        return Cow::Borrowed(input);
    }
    Cow::Owned(input.replace(home, "~"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_home_prefix() {
        assert_eq!(
            redact_home("/home/alice/docs/secret.md not found", "/home/alice"),
            "~/docs/secret.md not found"
        );
    }

    #[test]
    fn redacts_windows_home() {
        assert_eq!(
            redact_home(r"C:\Users\bob\Documents\x.md", r"C:\Users\bob"),
            r"~\Documents\x.md"
        );
    }

    #[test]
    fn redacts_every_occurrence() {
        assert_eq!(
            redact_home("/home/a/x and /home/a/y", "/home/a"),
            "~/x and ~/y"
        );
    }

    #[test]
    fn no_match_borrows_unchanged() {
        let out = redact_home("/var/log/syslog", "/home/alice");
        assert!(matches!(out, Cow::Borrowed(_)));
        assert_eq!(out, "/var/log/syslog");
    }

    #[test]
    fn empty_home_is_noop() {
        let out = redact_home("/home/alice/x", "");
        assert!(matches!(out, Cow::Borrowed(_)));
        assert_eq!(out, "/home/alice/x");
    }
}
