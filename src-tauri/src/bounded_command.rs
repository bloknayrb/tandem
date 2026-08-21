//! Run an external process with a deadline that bounds the WHOLE call (#1371).
//!
//! `std::process::Command::output()` is spawn-and-block-to-completion with no
//! cancellation: a child that never exits is a caller that never returns. On the
//! Cowork path that caller was a sync `#[tauri::command]`, i.e. the UI thread.
//!
//! This module is deliberately **not** cfg-gated. Its only consumer today is
//! `firewall.rs`, which is Windows-only — but a `#[cfg(target_os = "windows")]`
//! module is never parsed on any other target, so gating this would put the one
//! piece of genuinely tricky logic where it could not be unit-tested on a
//! developer's machine. Ungated, `cargo test` exercises it on every CI leg.
//!
//! ## Why not the obvious implementation
//!
//! A bare `try_wait()` poll loop with no reader threads deadlocks the moment the
//! child fills the pipe buffer (64 KiB on Linux, as little as 4 KiB on Windows):
//! the child blocks in `write`, so it never exits, so `try_wait` never returns
//! `Some`, so the deadline fires and we kill a process that was working fine.
//! Worse, it scales with output size — a machine with many Hyper-V adapters is
//! exactly the one that would hit it. `large_output_does_not_deadlock` below is
//! the regression test for that shape.
//!
//! ## Why the reader threads are never `join`ed
//!
//! `Child::kill()` is `TerminateProcess`/`SIGKILL` on the **immediate** process
//! only. Any descendant that inherited the stdout/stderr write handle keeps the
//! pipe open, so `read_to_end` never observes EOF and a `join()` on that reader
//! would never return — which would put the unbounded wait straight back, one
//! layer down. Collection therefore goes through `mpsc::recv_timeout` against the
//! remaining budget, and a reader that has not answered by then is abandoned. An
//! abandoned reader is a bounded leak of one parked thread that exits when the
//! pipe finally closes; it cannot wedge the caller.

use std::io::Read;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// How often the exit poll wakes up. ~750 wakeups across a 15 s budget, on a
/// thread that would otherwise be blocked outright.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Grace given to the post-kill reap and to draining whatever the readers have
/// already buffered. Separate from the caller's budget, which is by definition
/// already spent by the time we get here.
const KILL_GRACE: Duration = Duration::from_millis(2_000);

/// Floor on the output-collection window for a child that exited right at (or
/// after) the deadline. Without it a process that exits on the last tick would
/// be reported as timed out purely because there was no budget left to read the
/// bytes already sitting in the pipe.
const COLLECT_FLOOR: Duration = Duration::from_millis(500);

/// What happened to a bounded process run.
#[derive(Debug)]
pub enum BoundedOutcome {
    /// The child exited and both streams were read in full.
    Completed(Output),
    /// The budget expired (or output could not be collected within it) and the
    /// child was killed.
    ///
    /// `pid` is the child we killed — it lets a test assert the process is
    /// actually gone rather than merely that we returned on schedule.
    ///
    /// The partial lengths are best-effort and distinguish the two failure modes
    /// that want completely different advice: `0/0` means the process never
    /// produced anything (process start hung), while a non-zero stdout length
    /// means it started answering and then stalled (the CIM query hung after the
    /// marker line). They are `0` when the reader could not complete at all,
    /// which is honest: we do not know.
    TimedOut {
        pid: u32,
        partial_stdout_len: usize,
        partial_stderr_len: usize,
    },
}

/// Run `cmd` to completion, killing it if it outlives `budget`.
///
/// `Err` is reserved for a **spawn** failure and is never used for a timeout.
/// Callers depend on that split: `firewall.rs` maps `ErrorKind::NotFound` to
/// `AdapterEnumerationFailed`, and folding a missing `powershell.exe` into
/// "timed out" would report a wait that never happened.
pub fn output_with_timeout(mut cmd: Command, budget: Duration) -> std::io::Result<BoundedOutcome> {
    // `Stdio::null()` on stdin is deliberate: a probe must never inherit a
    // console and block on a prompt.
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let deadline = Instant::now() + budget;
    let mut child = cmd.spawn()?;
    let pid = child.id();

    let rx_out = spawn_reader(child.stdout.take());
    let rx_err = spawn_reader(child.stderr.take());

    match wait_until(&mut child, deadline)? {
        Some(status) => collect_completed(status, pid, &rx_out, &rx_err, deadline),
        None => kill_and_report(child, pid, &rx_out, &rx_err),
    }
}

/// Poll for exit until `deadline`. `Ok(None)` means the deadline won.
fn wait_until(child: &mut Child, deadline: Instant) -> std::io::Result<Option<ExitStatus>> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        thread::sleep(POLL_INTERVAL.min(remaining));
    }
}

/// The child exited inside the budget — but collecting its output must ALSO be
/// bounded, and this is the subtlest correctness point in the module.
///
/// A descendant that inherited the write handle keeps the pipe open after its
/// parent exits, so `recv` here could block forever even though `try_wait`
/// already succeeded. When collection outlives the budget we return `TimedOut`
/// rather than `Completed` with whatever bytes did arrive: partial stdout is not
/// merely incomplete, it is *misleading*. `classify_subnet_output` reads a
/// `TANDEM_ADAPTERS <n>` marker followed by one address line per adapter, so a
/// truncated stream is indistinguishable from a complete one that found fewer
/// adapters — it would be confidently classified as `NoAdapter` or `NoIpv4` and
/// the user would be told something false about their machine.
fn collect_completed(
    status: ExitStatus,
    pid: u32,
    rx_out: &Receiver<Vec<u8>>,
    rx_err: &Receiver<Vec<u8>>,
    deadline: Instant,
) -> std::io::Result<BoundedOutcome> {
    let window = deadline
        .saturating_duration_since(Instant::now())
        .max(COLLECT_FLOOR);

    let started = Instant::now();
    let stdout = rx_out.recv_timeout(window).ok();
    let stderr = rx_err
        .recv_timeout(window.saturating_sub(started.elapsed()).max(COLLECT_FLOOR))
        .ok();

    match (stdout, stderr) {
        (Some(stdout), Some(stderr)) => Ok(BoundedOutcome::Completed(Output {
            status,
            stdout,
            stderr,
        })),
        (stdout, stderr) => Ok(BoundedOutcome::TimedOut {
            pid,
            partial_stdout_len: stdout.map_or(0, |b| b.len()),
            partial_stderr_len: stderr.map_or(0, |b| b.len()),
        }),
    }
}

/// The budget expired. Kill, reap, drain what is already buffered, give up on
/// the rest.
fn kill_and_report(
    mut child: Child,
    pid: u32,
    rx_out: &Receiver<Vec<u8>>,
    rx_err: &Receiver<Vec<u8>>,
) -> std::io::Result<BoundedOutcome> {
    // Non-fatal on purpose. `kill()` errors on an already-reaped child and can
    // fail with access-denied; neither is a reason to abandon the function, and
    // an unconditional `?` here would be a second way to never return.
    let _ = child.kill();

    // Bounded reap. `Child::drop` deliberately does NOT reap, so skipping this
    // leaves a zombie on unix — `timed_out_child_is_killed_and_reaped` is what
    // notices. If even this grace expires we drop `child` and accept one zombie:
    // bounded by construction (one per pathological timeout, and the caller's
    // single-flight guard bounds how many of those can exist at once). Windows
    // has no zombie state; the handle is closed on drop.
    let _ = wait_until(&mut child, Instant::now() + KILL_GRACE);

    let stdout = rx_out.recv_timeout(KILL_GRACE).ok();
    let stderr = rx_err.recv_timeout(KILL_GRACE).ok();

    Ok(BoundedOutcome::TimedOut {
        pid,
        partial_stdout_len: stdout.map_or(0, |b| b.len()),
        partial_stderr_len: stderr.map_or(0, |b| b.len()),
    })
}

/// Read a pipe to EOF on its own thread and post the bytes once.
///
/// The `JoinHandle` is dropped: see the module doc for why this must never be
/// joined.
fn spawn_reader<R: Read + Send + 'static>(pipe: Option<R>) -> Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    match pipe {
        Some(mut pipe) => {
            thread::spawn(move || {
                let mut buf = Vec::new();
                // Send ONLY on a complete read. A failed `read_to_end` leaves
                // whatever it managed to read in `buf`, and publishing that would
                // be indistinguishable from a complete read: `collect_completed`
                // would see two `Some`s and return `Completed` with truncated
                // stdout — the one thing this module's header says can never
                // happen. `classify_subnet_output` would then parse a
                // `TANDEM_ADAPTERS n` marker with fewer address lines than `n`
                // and report `NoAdapter`/`NoIpv4`, a confident false claim about
                // the user's machine.
                //
                // Dropping `tx` instead surfaces as `Disconnected`, which the
                // `.ok()` at both call sites already maps to `None`, and thence
                // to `TimedOut` — "we stopped waiting", which is honest.
                match pipe.read_to_end(&mut buf) {
                    Ok(_) => {
                        let _ = tx.send(buf);
                    }
                    Err(_) => {}
                }
            });
        }
        // Unreachable given the `Stdio::piped()` above, but a silently missing
        // pipe must not read as "the reader never answered" — that would report
        // a timeout for a process that ran fine.
        None => {
            let _ = tx.send(Vec::new());
        }
    }
    rx
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Selects what the re-invoked test binary should do. See
    /// `helper_process_entrypoint`.
    const MODE_ENV: &str = "TANDEM_BOUNDED_TEST_MODE";
    /// Path the `marker_file` mode writes to if it is allowed to finish.
    const MARKER_PATH_ENV: &str = "TANDEM_BOUNDED_TEST_MARKER_PATH";
    const MARKER: &str = "TANDEM_BOUNDED_MARKER";

    /// Build a `Command` that re-invokes THIS test binary in a helper mode.
    ///
    /// Deliberately not `sh -c` / `cmd /C`: on Windows `cmd /C "<sleeper>"`
    /// leaves the sleeper as a surviving grandchild holding the inherited pipe,
    /// which is precisely the case the module doc says `join()` cannot handle —
    /// the test helper would then hang CI rather than test anything. Re-invoking
    /// `current_exe()` spawns exactly one process on both platforms, needs no
    /// shell, and makes the ≥1 MiB writer trivial.
    ///
    /// Caveat for assertions: the child is a libtest binary, so it prints its own
    /// harness lines to stdout. Assertions below use `contains` and length
    /// floors, never equality.
    fn helper(mode: &str) -> Command {
        let mut cmd = Command::new(std::env::current_exe().expect("current_exe"));
        cmd.env(MODE_ENV, mode);
        cmd.args([
            "--exact",
            "bounded_command::tests::helper_process_entrypoint",
            "--ignored",
            "--nocapture",
        ]);
        cmd
    }

    /// The helper subprocess. Never run as part of the suite (`#[ignore]`); the
    /// tests above re-invoke the test binary with `--exact` on this name.
    #[test]
    #[ignore = "helper subprocess entrypoint, re-invoked by the output_with_timeout tests"]
    fn helper_process_entrypoint() {
        use std::io::Write;

        let Ok(mode) = std::env::var(MODE_ENV) else {
            return;
        };
        match mode.as_str() {
            "echo" => println!("{MARKER}"),
            "big" => {
                // 20 x 64 KiB = 1.25 MiB, comfortably past every pipe buffer.
                let chunk = vec![b'x'; 64 * 1024];
                let mut out = std::io::stdout().lock();
                for _ in 0..20 {
                    out.write_all(&chunk).expect("write chunk");
                }
                out.flush().expect("flush");
            }
            "sleep" => thread::sleep(Duration::from_secs(60)),
            "streams" => {
                println!("OUT_{MARKER}");
                eprintln!("ERR_{MARKER}");
            }
            "dribble" => {
                let mut out = std::io::stdout().lock();
                writeln!(out, "{MARKER}").expect("write marker");
                out.flush().expect("flush");
                drop(out);
                thread::sleep(Duration::from_secs(60));
            }
            "marker_file" => {
                thread::sleep(Duration::from_secs(2));
                if let Ok(path) = std::env::var(MARKER_PATH_ENV) {
                    let _ = std::fs::write(path, b"ran");
                }
            }
            _ => {}
        }
    }

    fn expect_completed(outcome: BoundedOutcome) -> Output {
        match outcome {
            BoundedOutcome::Completed(output) => output,
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[test]
    fn completed_returns_status_and_stdout() {
        let outcome = output_with_timeout(helper("echo"), Duration::from_secs(30)).expect("spawn");
        let output = expect_completed(outcome);
        assert!(output.status.success(), "helper exited non-zero: {output:?}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains(MARKER), "stdout did not carry the marker: {stdout:?}");
    }

    /// Red if the reader threads are removed: a bare `try_wait` loop deadlocks on
    /// a full pipe buffer and this comes back `TimedOut`.
    #[test]
    fn large_output_does_not_deadlock() {
        let outcome = output_with_timeout(helper("big"), Duration::from_secs(30)).expect("spawn");
        let output = expect_completed(outcome);
        assert!(
            output.stdout.len() >= 1_048_576,
            "expected >= 1 MiB of stdout, got {} bytes",
            output.stdout.len()
        );
    }

    /// Red if the stderr pipe or its reader is dropped — stderr would silently
    /// empty, and `FirewallError::NetshFailure`'s `stderr_tail` would go blank in
    /// production with nothing to notice it.
    #[test]
    fn stderr_is_captured_separately() {
        let outcome =
            output_with_timeout(helper("streams"), Duration::from_secs(30)).expect("spawn");
        let output = expect_completed(outcome);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stdout.contains(&format!("OUT_{MARKER}")), "stdout: {stdout:?}");
        assert!(stderr.contains(&format!("ERR_{MARKER}")), "stderr: {stderr:?}");
        assert!(
            !stdout.contains(&format!("ERR_{MARKER}")),
            "the two streams were merged: {stdout:?}"
        );
    }

    /// Red if the deadline check is removed, AND — via the marker file — red if
    /// `child.kill()` is removed. Without the marker assertion a deleted `kill()`
    /// still passes: the poll loop would return `TimedOut` right on schedule
    /// while the orphan carried on running.
    #[test]
    fn times_out_and_actually_kills_the_child() {
        let dir = std::env::temp_dir().join(format!("tandem-bounded-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let marker = dir.join("child-finished");
        let _ = std::fs::remove_file(&marker);

        let mut cmd = helper("marker_file");
        cmd.env(MARKER_PATH_ENV, &marker);

        let started = Instant::now();
        let outcome = output_with_timeout(cmd, Duration::from_millis(300)).expect("spawn");
        let elapsed = started.elapsed();

        assert!(
            matches!(outcome, BoundedOutcome::TimedOut { .. }),
            "expected TimedOut, got {outcome:?}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "deadline did not bound the call: {elapsed:?}"
        );

        // The helper writes the marker 2s in. Wait past that: if the kill did not
        // land, the file appears.
        thread::sleep(Duration::from_secs(3));
        assert!(
            !marker.exists(),
            "child survived the deadline and finished its work — kill() did not land"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Red if the post-kill reap is removed.
    ///
    /// It is NOT red if `child.kill()` is removed — a surviving child reads as
    /// state `S`, not `Z`, so this passes. That deletion is caught by
    /// `times_out_and_actually_kills_the_child`'s marker-file assertion instead.
    /// The two tests cover different deletions and neither substitutes for the
    /// other; do not delete one on the strength of the other.
    ///
    /// Linux-only, and deliberately so: the helper owns the `Child`, so "did it
    /// reap?" is not observable from the caller — a timing assertion cannot tell
    /// a reap from a sleep. `/proc` can: a reaped-and-gone process has no entry,
    /// while a killed-but-unreaped one is state `Z`. No new dependency needed.
    /// (PID reuse inside the few hundred ms between reap and read is possible in
    /// principle and vanishingly unlikely with Linux's default `pid_max`.)
    #[cfg(target_os = "linux")]
    #[test]
    fn timed_out_child_is_killed_and_reaped() {
        let outcome =
            output_with_timeout(helper("sleep"), Duration::from_millis(300)).expect("spawn");
        let BoundedOutcome::TimedOut { pid, .. } = outcome else {
            panic!("expected TimedOut, got {outcome:?}");
        };

        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            // Gone entirely: killed and reaped.
            Err(_) => {}
            Ok(stat) => {
                let state = proc_state(&stat);
                assert_ne!(
                    state, 'Z',
                    "pid {pid} is a zombie — it was killed but never reaped: {stat}"
                );
            }
        }
    }

    /// Third field of `/proc/<pid>/stat`. The second field is `(comm)`, which may
    /// itself contain spaces and parentheses, so the state is found from the LAST
    /// `)` rather than by splitting on whitespace.
    #[cfg(target_os = "linux")]
    fn proc_state(stat: &str) -> char {
        let close = stat.rfind(')').expect("no ')' in /proc stat line");
        stat[close + 1..]
            .trim_start()
            .chars()
            .next()
            .expect("no state field after comm")
    }

    /// Red if the partial-length payload is dropped. That payload is what
    /// separates "process start hung" (0 bytes) from "the query hung after the
    /// marker line" (>0) in `tandem.log`.
    #[test]
    fn partial_lengths_report_what_arrived() {
        let outcome =
            // 3s, not 1.5s: the child has to spawn, dynamically link, start
            // libtest and reach its first flush before the budget expires, and
            // 1.5s was the tightest margin in this module by 5x. A miss there
            // would read as "the helper flushed but nothing was reported",
            // pointing at the code when the runner was slow. The helper still
            // outlives this by 57s, so the `TimedOut` half is unaffected.
            output_with_timeout(helper("dribble"), Duration::from_secs(3)).expect("spawn");
        match outcome {
            BoundedOutcome::TimedOut {
                partial_stdout_len, ..
            } => assert!(
                partial_stdout_len > 0,
                "the helper flushed a marker line before stalling, but nothing was reported"
            ),
            other => panic!("expected TimedOut, got {other:?}"),
        }
    }

    /// A reader that yields some bytes and then fails.
    struct FailingReader {
        emitted: bool,
    }

    impl Read for FailingReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if !self.emitted {
                self.emitted = true;
                let bytes = b"partial";
                let n = buf.len().min(bytes.len());
                buf[..n].copy_from_slice(&bytes[..n]);
                return Ok(n);
            }
            // Not `Interrupted`, which `read_to_end` retries.
            Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "boom"))
        }
    }

    /// Red if `spawn_reader` sends its buffer regardless of the read's outcome.
    ///
    /// That is the only way truncated output can reach `Completed`: the caller
    /// would see two `Some`s and hand `classify_subnet_output` a stream missing
    /// address lines, which it would classify as `NoAdapter`/`NoIpv4` — a
    /// confident false claim about the user's machine. Dropping the sender
    /// instead shows up as `Disconnected`, i.e. `None`, i.e. `TimedOut`.
    #[test]
    fn a_failed_pipe_read_publishes_nothing() {
        let rx = spawn_reader(Some(FailingReader { emitted: false }));
        match rx.recv_timeout(Duration::from_secs(5)) {
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {}
            other => panic!(
                "a failed read must not publish a truncated buffer, but the channel yielded {other:?}"
            ),
        }
    }

    /// Red if a spawn failure is folded into the timeout path — which in
    /// `firewall.rs` would report `Timeout` for a missing `powershell.exe`
    /// instead of `AdapterEnumerationFailed`.
    #[test]
    fn spawn_failure_is_err_not_timeout() {
        let cmd = Command::new("tandem-no-such-program-9f3a2c");
        let err = output_with_timeout(cmd, Duration::from_secs(5))
            .expect_err("a nonexistent program must not resolve to an outcome");
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound, "{err:?}");
    }
}
