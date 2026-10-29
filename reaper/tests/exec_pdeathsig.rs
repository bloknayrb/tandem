//! `tandem-reaper --exec-with-pdeathsig` (#1988): the desktop shell's Linux
//! sidecar trampoline. These run the real binary.
//!
//! The thread-death test is the one that matters most: Linux sends the
//! parent-death signal when the THREAD that forked the child exits, not when
//! the process does. That is why `src-tauri/src/sidecar_anchor.rs` forks the
//! sidecar from one thread that never exits — and this test shows both halves:
//! the child survives while its forking thread lives, and dies of SIGTERM
//! once that thread ends, though this process is still alive.

#![cfg(target_os = "linux")]

use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const REAPER: &str = env!("CARGO_BIN_EXE_tandem-reaper");

fn sleep_bin() -> &'static str {
    ["/bin/sleep", "/usr/bin/sleep"]
        .into_iter()
        .find(|p| Path::new(p).exists())
        .expect("a sleep binary")
}

fn sh_bin() -> &'static str {
    ["/bin/sh", "/usr/bin/sh"]
        .into_iter()
        .find(|p| Path::new(p).exists())
        .expect("a sh binary")
}

fn wait_exit(child: &mut Child, within: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tandem-reaper-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn the_child_dies_of_sigterm_when_its_forking_thread_ends() {
    let (child_tx, child_rx) = mpsc::channel::<Child>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let forker = std::thread::spawn(move || {
        let child = Command::new(REAPER)
            .args([
                "--exec-with-pdeathsig",
                &std::process::id().to_string(),
                sleep_bin(),
                "30",
            ])
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn the reaper");
        child_tx.send(child).expect("hand the child over");
        // Live until told to end.
        let _ = release_rx.recv();
    });
    let mut child = child_rx.recv().expect("the child");

    // Control: while the forking thread lives, the exec'd program keeps running.
    assert!(
        wait_exit(&mut child, Duration::from_millis(700)).is_none(),
        "the program must run while the thread that forked it is alive"
    );

    release_tx.send(()).expect("release the forker");
    forker.join().expect("the forker ends");

    let status = wait_exit(&mut child, Duration::from_secs(5))
        .expect("the program must die within 5 s of its forking thread ending");
    assert_eq!(status.signal(), Some(libc::SIGTERM), "status: {status:?}");
}

#[test]
fn a_parent_that_is_not_the_named_one_starts_nothing() {
    let dir = temp_dir("wrong-parent");
    let marker = dir.join("ran");
    // pid 1 is never this test's process.
    let status = Command::new(REAPER)
        .args([
            "--exec-with-pdeathsig",
            "1",
            sh_bin(),
            "-c",
            &format!("touch '{}'", marker.display()),
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run the reaper");
    assert_eq!(status.code(), Some(3));
    std::thread::sleep(Duration::from_millis(100));
    assert!(!marker.exists(), "the target must not have run");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_target_runs_with_its_arguments_and_keeps_the_pid() {
    let dir = temp_dir("runs");
    let marker = dir.join("pid");
    let mut child = Command::new(REAPER)
        .args([
            "--exec-with-pdeathsig",
            &std::process::id().to_string(),
            sh_bin(),
            "-c",
            // `$$` is the shell's own pid: equal to the reaper's after exec.
            &format!("echo $$ > '{}'", marker.display()),
        ])
        .stdin(Stdio::null())
        .spawn()
        .expect("spawn the reaper");
    let reaper_pid = child.id();
    let status = wait_exit(&mut child, Duration::from_secs(5)).expect("exits");
    assert!(status.success(), "status: {status:?}");
    let written = std::fs::read_to_string(&marker).expect("the target ran");
    assert_eq!(
        written.trim(),
        reaper_pid.to_string(),
        "exec in place: same pid"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn usage_errors_exit_2_and_a_relative_program_is_refused() {
    let me = std::process::id().to_string();
    for args in [
        vec!["--exec-with-pdeathsig"],
        vec!["--exec-with-pdeathsig", me.as_str()],
        vec!["--exec-with-pdeathsig", "not-a-pid", sh_bin()],
        vec!["--exec-with-pdeathsig", "0", sh_bin()],
        // No PATH search: a bare name is refused, not looked up.
        vec!["--exec-with-pdeathsig", me.as_str(), "sh", "-c", "exit 0"],
    ] {
        let status = Command::new(REAPER)
            .args(&args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("run the reaper");
        assert_eq!(status.code(), Some(2), "args: {args:?}");
    }
}

#[test]
fn a_program_that_cannot_be_executed_exits_127() {
    let status = Command::new(REAPER)
        .args([
            "--exec-with-pdeathsig",
            &std::process::id().to_string(),
            "/nonexistent/tandem-no-such-program",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run the reaper");
    assert_eq!(status.code(), Some(127));
}

#[test]
fn the_probe_flag_reports_the_mode() {
    let status = Command::new(REAPER)
        .arg("--supports-exec-with-pdeathsig")
        .stdin(Stdio::null())
        .status()
        .expect("run the reaper");
    assert_eq!(status.code(), Some(0));
}

#[test]
fn the_launcher_contract_is_untouched_a_flag_is_never_a_pid() {
    // The Node launcher's form: <parent_pid> <program> [args...]. A flag in
    // the pid slot was always a usage error, and still is for any other flag.
    let status = Command::new(REAPER)
        .args(["--some-other-flag", sh_bin(), "-c", "exit 0"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run the reaper");
    assert_eq!(status.code(), Some(2));
}
