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
//! - Native minidumps from hard crashes (segfaults, aborts) via `sentry`'s
//!   `MinidumpIntegration` (Linux, macOS, Windows) — the one signal neither the
//!   Node sidecar handlers nor the WebView `ErrorBoundary` can produce.
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
//! ## PII scrubbing, and how far it reaches
//!
//! A `before_send` hook scrubs the **event** before it leaves the process:
//! - absolute home-directory paths are rewritten to `~/…` in the message and
//!   exception values
//! - `event.server_name` — the machine's hostname — is cleared outright (#2023)
//! - every exception stack frame's `filename` / `abs_path` is redacted (#2023)
//! - every `debug_meta.images[]` path (`name`, `code_file`, `debug_file`) is
//!   redacted (#2161). The debug-images integration records the full path of
//!   every loaded module on every event, and a per-user Windows install lives
//!   under `%LOCALAPPDATA%`, so those paths carry the username. The integration
//!   runs before `before_send` (sentry-core `Client::prepare_event`), which is
//!   what lets this hook see them; `tests::debug_images_reach_before_send` pins
//!   that order against the real client.
//! - the DSN is never logged
//!
//! **The minidump is not scrubbed.** A native crash of this shell process also
//! sends a minidump attachment. Attachments are added to the envelope after
//! `before_send` has run, and rewriting a binary dump in place is not
//! attempted, so its bytes leave exactly as written. On Linux that dump
//! carries the full command line, the process's whole inherited environment
//! and the path of every open file, among other streams; `docs/security.md`
//! ("Telemetry") lists what each platform's dump holds. It goes only to the
//! operator's own DSN, and only after they opted in.
//!
//! Document content is not deliberately attached to events, but the shell
//! process's minidump can carry document paths (argv, open files) and any of
//! its memory that is on a thread stack. The sidecar and the WebView are
//! separate processes and are not in this dump. The WebView side applies its
//! own scrubbing in `src/client/sentry.ts`.

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

/// Opaque guard that must outlive the Tauri event loop. Holding the
/// `ClientInitGuard` keeps the Sentry client alive (it flushes on drop), and
/// with it the minidump integration, which owns the out-of-process crash
/// reporter's handle. Dropping it early would silently disable reporting, so
/// `run()` binds this to a `let _guard` that lives for the whole function.
pub struct SentryGuard {
    client: sentry::ClientInitGuard,
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

    let mut options = base_options();

    // Out-of-process native crash handler (minidumps). Since
    // tauri-plugin-sentry 0.7 this is `sentry`'s own `minidump` integration
    // (enabled through the plugin's default `minidump` feature), registered on
    // the options rather than started after `sentry::init`. It must be added
    // BEFORE `sentry::init`: the crash-reporter process re-executes this binary
    // and diverges inside `sentry::init` (it never returns there), so
    // everything before that call runs in both processes. The reporter's client
    // is cloned from these options, so `before_send` scrubbing still applies to
    // the minidump EVENT — but not to the dump bytes, which are attached after
    // `before_send` runs and leave unscrubbed (#2161; see the module doc). The
    // cfg matches the `sentry` re-export's own gate —
    // the integration exists only on Linux, macOS and Windows.
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        options =
            options.add_integration(sentry::integrations::minidump::MinidumpIntegration::new());
    }

    let client = sentry::init((dsn, options));

    SENTRY_ENABLED.store(true, Ordering::Release);
    Some(SentryGuard { client })
}

/// The client options every enabled client starts from: release, no session
/// tracking, the scrubbing `before_send`, and no default PII. Split out of
/// [`init`] so a test can build a real client from the same options without
/// reading the environment, flipping [`SENTRY_ENABLED`] or adding the
/// minidump integration (which re-executes the current binary).
fn base_options() -> sentry::ClientOptions {
    // sentry 0.49 marks `ClientOptions` `#[non_exhaustive]`, so the struct
    // literal no longer compiles from outside the crate — build via
    // `Default` and assign the same four fields as before.
    let mut options = sentry::ClientOptions::default();
    options.release = sentry::release_name!();
    // Crash events only — no session/usage telemetry. Even though the
    // operator opted in by setting a DSN, the privacy-minimal posture is
    // to ship faults, not session pings (#921).
    options.auto_session_tracking = false;
    // Scrub PII before any event leaves the process.
    options.before_send = Some(Arc::new(|mut event| {
        scrub_event(&mut event);
        Some(event)
    }));
    // Belt-and-braces: ask the SDK not to attach IP / identifying data.
    options.send_default_pii = false;
    options
}

/// Mutate an outgoing Sentry event in place to strip personally-identifying
/// data: clear the machine's hostname, and rewrite the user's home directory to
/// `~` everywhere it appears in the event's stringified surfaces. Mirrors the
/// sidecar's `scrubEvent` (`src/server/sentry.ts`).
///
/// **The order here is the contract (#2023).** Clearing `server_name` is not a
/// redaction and needs no home directory, so it happens BEFORE the
/// [`home_dir_string`] lookup that the rest of the scrubbing early-returns on.
/// Leaving it inside [`scrub_event_with_home`] alone would make hostname
/// removal conditional on `dirs::home_dir()` succeeding — on a host where it
/// yields `None` the hostname would still egress, and no inner-function test
/// could see it.
fn scrub_event(event: &mut sentry::protocol::Event<'static>) {
    event.server_name = None;
    let Some(home) = home_dir_string() else { return };
    scrub_event_with_home(event, &home);
}

/// The pure half of [`scrub_event`], taking the home directory as an argument
/// so it is unit-testable without touching the process environment — the same
/// shape [`redact_home`] already has.
///
/// Exception stacktraces only, exactly like the sidecar hook: the panic
/// integration puts the backtrace on the exception, and nothing here registers
/// a handler that would populate `event.stacktrace` or `event.threads`.
fn scrub_event_with_home(event: &mut sentry::protocol::Event<'static>, home: &str) {
    // Idempotent with the caller's own clear, so a test driving this function
    // still pins the hostname removal.
    event.server_name = None;

    // Scrub the top-level message and any exception values/types — these are
    // the surfaces most likely to embed an absolute path (panic payloads,
    // file-not-found messages, etc.).
    if let Some(msg) = event.message.take() {
        event.message = Some(redact_home(&msg, home).into_owned());
    }
    for exception in event.exception.values.iter_mut() {
        if let Some(value) = exception.value.take() {
            exception.value = Some(redact_home(&value, home).into_owned());
        }
        if let Some(stacktrace) = exception.stacktrace.as_mut() {
            scrub_frames(stacktrace, home);
        }
    }

    // `debug_meta` arrives as `Cow::Borrowed` from the integration's static
    // list, so it is only made owned (cloned) when something in it needs
    // redacting — the common case on a system-wide install allocates nothing.
    if debug_meta_mentions_home(&event.debug_meta, home) {
        scrub_debug_images(event.debug_meta.to_mut(), home);
    }
}

/// Every path-bearing field of one debug image, for the cheap pre-check.
///
/// The match is exhaustive with no wildcard arm on purpose, here and in
/// [`scrub_debug_images`]: `DebugImage` is not `#[non_exhaustive]`, so a new
/// variant in a sentry bump fails to compile instead of egressing unscrubbed.
fn debug_image_paths(image: &sentry::protocol::DebugImage) -> Vec<&str> {
    use sentry::protocol::DebugImage;
    match image {
        DebugImage::Apple(img) => vec![img.name.as_str()],
        DebugImage::Symbolic(img) => {
            let mut paths = vec![img.name.as_str()];
            paths.extend(img.debug_file.as_deref());
            paths
        }
        DebugImage::Proguard(_) => Vec::new(),
        DebugImage::Wasm(img) => {
            let mut paths = vec![img.name.as_str(), img.code_file.as_str()];
            paths.extend(img.debug_file.as_deref());
            paths
        }
    }
}

fn debug_meta_mentions_home(meta: &sentry::protocol::DebugMeta, home: &str) -> bool {
    meta.images
        .iter()
        .flat_map(debug_image_paths)
        .any(|path| !matches!(redact_home(path, home), Cow::Borrowed(_)))
}

/// Redact the home directory out of every debug image's paths (#2161). On a
/// `Symbolic` image `name` is the code file path; `Proguard` carries no path.
fn scrub_debug_images(meta: &mut sentry::protocol::DebugMeta, home: &str) {
    use sentry::protocol::DebugImage;
    fn redact_in_place(field: &mut String, home: &str) {
        if let Cow::Owned(redacted) = redact_home(field, home) {
            *field = redacted;
        }
    }
    fn redact_opt_in_place(field: &mut Option<String>, home: &str) {
        if let Some(value) = field.as_mut() {
            redact_in_place(value, home);
        }
    }
    for image in meta.images.iter_mut() {
        match image {
            DebugImage::Apple(img) => redact_in_place(&mut img.name, home),
            DebugImage::Symbolic(img) => {
                redact_in_place(&mut img.name, home);
                redact_opt_in_place(&mut img.debug_file, home);
            }
            DebugImage::Proguard(_) => {}
            DebugImage::Wasm(img) => {
                redact_in_place(&mut img.name, home);
                redact_in_place(&mut img.code_file, home);
                redact_opt_in_place(&mut img.debug_file, home);
            }
        }
    }
}

/// Redact the home directory out of every frame path in one stacktrace. In a
/// source-run or dev build `filename` and `abs_path` are absolute paths under
/// `$HOME`; both are scrubbed so whichever the runtime populates is covered.
fn scrub_frames(stacktrace: &mut sentry::protocol::Stacktrace, home: &str) {
    for frame in stacktrace.frames.iter_mut() {
        if let Some(filename) = frame.filename.take() {
            frame.filename = Some(redact_home(&filename, home).into_owned());
        }
        if let Some(abs_path) = frame.abs_path.take() {
            frame.abs_path = Some(redact_home(&abs_path, home).into_owned());
        }
    }
}

/// Best-effort home-directory lookup as a `String`, normalised without a
/// trailing separator so the replacement reads `~/foo` not `~//foo`.
pub(crate) fn home_dir_string() -> Option<String> {
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

    // ---- #2023: server_name and stack-frame paths ----

    fn event_with_frame(filename: &str, abs_path: &str) -> sentry::protocol::Event<'static> {
        let frame = sentry::protocol::Frame {
            filename: Some(filename.to_string()),
            abs_path: Some(abs_path.to_string()),
            ..Default::default()
        };
        let exception = sentry::protocol::Exception {
            ty: "panic".into(),
            value: Some("boom".into()),
            stacktrace: Some(sentry::protocol::Stacktrace {
                frames: vec![frame],
                ..Default::default()
            }),
            ..Default::default()
        };
        sentry::protocol::Event {
            exception: vec![exception].into(),
            ..Default::default()
        }
    }

    #[test]
    fn scrub_event_with_home_clears_server_name() {
        let mut event = sentry::protocol::Event {
            server_name: Some("build-box".into()),
            ..Default::default()
        };
        scrub_event_with_home(&mut event, "/home/alice");
        assert_eq!(event.server_name, None);
    }

    #[test]
    fn scrub_event_with_home_redacts_frame_paths() {
        let mut event = event_with_frame("/home/alice/app/src/x.rs", "/home/alice/app/src/x.rs");
        scrub_event_with_home(&mut event, "/home/alice");

        let frame = &event.exception.values[0].stacktrace.as_ref().unwrap().frames[0];
        assert_eq!(frame.filename.as_deref(), Some("~/app/src/x.rs"));
        assert_eq!(frame.abs_path.as_deref(), Some("~/app/src/x.rs"));
    }

    #[test]
    fn scrub_event_with_home_tolerates_an_empty_event() {
        let mut event = sentry::protocol::Event::default();
        scrub_event_with_home(&mut event, "/home/alice");
        assert!(event.exception.values.is_empty());
        assert_eq!(event.message, None);
    }

    /// The hoist: the outer hook clears the hostname BEFORE the home-directory
    /// lookup it early-returns on, so a host where `dirs::home_dir()` yields
    /// `None` still gets the hostname removed. Every spec above drives the
    /// inner function and cannot see that return.
    #[test]
    fn scrub_event_clears_server_name_without_a_home_dir() {
        let mut event = sentry::protocol::Event {
            server_name: Some("build-box".into()),
            ..Default::default()
        };
        scrub_event(&mut event);
        assert_eq!(event.server_name, None);
    }

    // ---- #2161: debug_meta image paths ----

    use sentry::protocol::{
        Addr, AppleDebugImage, DebugImage, DebugMeta, ProguardDebugImage, SymbolicDebugImage,
        WasmDebugImage,
    };

    fn symbolic(name: &str, debug_file: Option<&str>) -> DebugImage {
        DebugImage::Symbolic(SymbolicDebugImage {
            name: name.to_string(),
            arch: Some("x86_64".into()),
            image_addr: Addr(0x1000),
            image_size: 4096,
            image_vmaddr: Addr(0),
            id: sentry::types::DebugId::default(),
            code_id: None,
            debug_file: debug_file.map(str::to_string),
        })
    }

    fn event_with_images(images: Vec<DebugImage>) -> sentry::protocol::Event<'static> {
        sentry::protocol::Event {
            debug_meta: Cow::Owned(DebugMeta {
                sdk_info: None,
                images,
            }),
            ..Default::default()
        }
    }

    #[test]
    fn scrubs_symbolic_image_paths_posix() {
        let mut event = event_with_images(vec![symbolic(
            "/home/alice/.local/share/tandem/tandem",
            Some("/home/alice/.local/share/tandem/tandem.debug"),
        )]);
        scrub_event_with_home(&mut event, "/home/alice");

        let DebugImage::Symbolic(img) = &event.debug_meta.images[0] else {
            panic!("variant changed");
        };
        assert_eq!(img.name, "~/.local/share/tandem/tandem");
        assert_eq!(img.debug_file.as_deref(), Some("~/.local/share/tandem/tandem.debug"));
        // Non-path fields are untouched.
        assert_eq!(img.arch.as_deref(), Some("x86_64"));
        assert_eq!(img.image_addr, Addr(0x1000));
        assert_eq!(img.image_size, 4096);
        assert_eq!(img.id, sentry::types::DebugId::default());
    }

    #[test]
    fn scrubs_symbolic_image_paths_windows() {
        let mut event = event_with_images(vec![symbolic(
            r"C:\Users\bob\AppData\Local\Tandem\tandem.exe",
            Some(r"C:\Users\bob\AppData\Local\Tandem\tandem.pdb"),
        )]);
        scrub_event_with_home(&mut event, r"C:\Users\bob");

        let DebugImage::Symbolic(img) = &event.debug_meta.images[0] else {
            panic!("variant changed");
        };
        assert_eq!(img.name, r"~\AppData\Local\Tandem\tandem.exe");
        assert_eq!(img.debug_file.as_deref(), Some(r"~\AppData\Local\Tandem\tandem.pdb"));
    }

    #[test]
    fn scrubs_apple_and_wasm_image_paths() {
        let mut event = event_with_images(vec![
            DebugImage::Apple(AppleDebugImage {
                name: "/Users/carol/Applications/Tandem.app/Contents/MacOS/tandem".into(),
                arch: None,
                cpu_type: None,
                cpu_subtype: None,
                image_addr: Addr(0),
                image_size: 0,
                image_vmaddr: Addr(0),
                uuid: sentry::protocol::Uuid::nil(),
            }),
            DebugImage::Wasm(WasmDebugImage {
                name: "/Users/carol/w/mod.wasm".into(),
                debug_id: sentry::protocol::Uuid::nil(),
                debug_file: Some("/Users/carol/w/mod.debug.wasm".into()),
                code_id: None,
                code_file: "/Users/carol/w/mod.wasm".into(),
            }),
        ]);
        scrub_event_with_home(&mut event, "/Users/carol");

        let images = &event.debug_meta.images;
        let DebugImage::Apple(apple) = &images[0] else {
            panic!("variant changed");
        };
        assert_eq!(apple.name, "~/Applications/Tandem.app/Contents/MacOS/tandem");
        let DebugImage::Wasm(wasm) = &images[1] else {
            panic!("variant changed");
        };
        assert_eq!(wasm.name, "~/w/mod.wasm");
        assert_eq!(wasm.code_file, "~/w/mod.wasm");
        assert_eq!(wasm.debug_file.as_deref(), Some("~/w/mod.debug.wasm"));
    }

    #[test]
    fn proguard_image_survives_unchanged() {
        let proguard = DebugImage::Proguard(ProguardDebugImage {
            uuid: sentry::protocol::Uuid::nil(),
        });
        let mut event =
            event_with_images(vec![proguard.clone(), symbolic("/home/alice/bin/tandem", None)]);
        scrub_event_with_home(&mut event, "/home/alice");
        assert_eq!(event.debug_meta.images[0], proguard);
    }

    /// Images outside the home directory are left alone, and a `debug_meta`
    /// that arrived borrowed (as the integration's static list does) is not
    /// cloned when nothing in it needs redacting.
    #[test]
    fn images_outside_home_stay_borrowed_and_unchanged() {
        static META: std::sync::OnceLock<DebugMeta> = std::sync::OnceLock::new();
        let meta = META.get_or_init(|| DebugMeta {
            sdk_info: None,
            images: vec![symbolic(
                "/usr/lib/libc.so.6",
                Some("/usr/lib/debug/libc.so.6.debug"),
            )],
        });
        let mut event = sentry::protocol::Event {
            debug_meta: Cow::Borrowed(meta),
            ..Default::default()
        };
        scrub_event_with_home(&mut event, "/home/alice");
        assert!(matches!(event.debug_meta, Cow::Borrowed(_)));
        let DebugImage::Symbolic(img) = &event.debug_meta.images[0] else {
            panic!("variant changed");
        };
        assert_eq!(img.name, "/usr/lib/libc.so.6");
    }

    /// The outer hook, with the real home directory, redacts an image built
    /// under it.
    #[test]
    fn scrub_event_redacts_an_image_under_the_real_home() {
        let home = home_dir_string().expect("the test host has a home directory");
        let mut event =
            event_with_images(vec![symbolic(&format!("{home}/tandem/bin/tandem"), None)]);
        scrub_event(&mut event);
        let DebugImage::Symbolic(img) = &event.debug_meta.images[0] else {
            panic!("variant changed");
        };
        assert!(!img.name.contains(&home), "{}", img.name);
        assert!(img.name.starts_with('~'), "{}", img.name);
    }

    /// The seam the scrub depends on: the debug-images integration fills
    /// `debug_meta` BEFORE `before_send` runs, so the hook sees the images.
    /// Built on a local `Client` with a capturing transport — never
    /// `sentry::init` or [`init`], which would bind the global hub, read the
    /// environment and (through the minidump integration) re-execute the test
    /// binary as a crash reporter.
    #[test]
    fn debug_images_reach_before_send() {
        use std::sync::Mutex;

        struct Capture(Mutex<Vec<sentry::Envelope>>);
        impl sentry::Transport for Capture {
            fn send_envelope(&self, envelope: sentry::Envelope) {
                self.0.lock().unwrap().push(envelope);
            }
        }

        let capture = Arc::new(Capture(Mutex::new(Vec::new())));
        let mut options = base_options();
        options.dsn = Some("https://public@example.invalid/1".parse().unwrap());
        options.default_integrations = false;
        options.integrations = vec![Arc::new(
            sentry::integrations::debug_images::DebugImagesIntegration::new(),
        )];
        options.transport = Some(Arc::new(capture.clone()));
        let client = sentry::Client::with_options(options);
        assert!(client.is_enabled());

        client.capture_event(
            sentry::protocol::Event {
                message: Some("seam probe".into()),
                level: sentry::Level::Info,
                ..Default::default()
            },
            None,
        );
        client.close(Some(std::time::Duration::from_secs(2)));

        let envelopes = capture.0.lock().unwrap();
        let event = envelopes
            .iter()
            .find_map(|e| e.event())
            .expect("the probe event was sent");
        let images = &event.debug_meta.images;
        assert!(!images.is_empty(), "the integration ran before before_send");

        if let Some(home) = home_dir_string() {
            let paths: Vec<&str> = images.iter().flat_map(debug_image_paths).collect();
            for path in &paths {
                assert!(!path.contains(home.as_str()), "unredacted image path: {path}");
            }
            // Bites only when the test binary itself runs from under $HOME
            // (true on CI runners); vacuous otherwise.
            let exe = std::env::current_exe().unwrap();
            if exe.to_string_lossy().starts_with(home.as_str()) {
                assert!(
                    paths.iter().any(|p| p.starts_with('~')),
                    "the test binary lives under home, so some image should read ~…"
                );
            }
        }
    }
}
