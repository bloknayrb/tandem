//! Integration tests for `extract_file_arg` — the helper that parses a file
//! path out of a process's command-line args for the OS file-association
//! cold-start and warm-start (`single-instance` callback) paths.
//!
//! The helper itself is pure (no Tauri runtime), so these tests run as a
//! standard `cargo test` integration test against the `app_lib` crate.

use std::fs::File;
use std::path::PathBuf;

use app_lib::{extract_file_arg, RejectionReason};
use tempfile::TempDir;

/// Build a [exe, ...rest] arg list, mimicking the OS shape.
fn args(rest: &[&str]) -> Vec<String> {
    let mut v = vec!["tandem.exe".to_string()];
    v.extend(rest.iter().map(|s| (*s).to_string()));
    v
}

fn touch(dir: &TempDir, name: &str) -> PathBuf {
    let p = dir.path().join(name);
    File::create(&p).expect("create test file");
    p
}

#[test]
fn empty_args_returns_ok_none() {
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(extract_file_arg(&[], &cwd), Ok(None));
}

#[test]
fn exe_only_returns_ok_none() {
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(extract_file_arg(&args(&[]), &cwd), Ok(None));
}

#[test]
fn flag_only_returns_ok_none() {
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(
        extract_file_arg(&args(&["--debug", "-v", "--help"]), &cwd),
        Ok(None),
    );
}

#[test]
fn nonexistent_file_returns_not_a_file() {
    let cwd = std::env::current_dir().unwrap();
    assert_eq!(
        extract_file_arg(&args(&["/nope/does-not-exist.md"]), &cwd),
        Err(RejectionReason::NotAFile),
    );
}

#[test]
fn unsupported_extension_returns_unsupported_extension() {
    let dir = TempDir::new().unwrap();
    let p = touch(&dir, "secret.exe");
    let cwd = std::env::current_dir().unwrap();
    let result = extract_file_arg(&args(&[p.to_str().unwrap()]), &cwd);
    assert_eq!(
        result,
        Err(RejectionReason::UnsupportedExtension("exe".to_string())),
        "extract_file_arg should reject unsupported .exe extension with typed reason"
    );
}

#[test]
fn absolute_md_path_returns_ok_some() {
    let dir = TempDir::new().unwrap();
    let p = touch(&dir, "doc.md");
    let cwd = std::env::current_dir().unwrap();
    let result = extract_file_arg(&args(&[p.to_str().unwrap()]), &cwd);
    assert_eq!(result, Ok(Some(p)));
}

#[test]
fn relative_path_resolves_against_cwd() {
    let dir = TempDir::new().unwrap();
    touch(&dir, "notes.md");
    // Pretend the OS launched us with cwd=dir and a bare filename on argv.
    let result = extract_file_arg(&args(&["notes.md"]), dir.path());
    assert_eq!(result, Ok(Some(dir.path().join("notes.md"))));
}

#[test]
fn leading_flags_then_file_takes_file() {
    let dir = TempDir::new().unwrap();
    let p = touch(&dir, "x.md");
    let cwd = std::env::current_dir().unwrap();
    let result = extract_file_arg(
        &args(&["--debug", "-v", p.to_str().unwrap()]),
        &cwd,
    );
    assert_eq!(result, Ok(Some(p)));
}

#[test]
fn double_dash_separator_is_skipped() {
    let dir = TempDir::new().unwrap();
    let p = touch(&dir, "y.md");
    let cwd = std::env::current_dir().unwrap();
    let result = extract_file_arg(&args(&["--", p.to_str().unwrap()]), &cwd);
    assert_eq!(result, Ok(Some(p)));
}

#[test]
fn multiple_paths_takes_first() {
    let dir = TempDir::new().unwrap();
    let first = touch(&dir, "first.md");
    let second = touch(&dir, "second.md");
    let cwd = std::env::current_dir().unwrap();
    let result = extract_file_arg(
        &args(&[first.to_str().unwrap(), second.to_str().unwrap()]),
        &cwd,
    );
    assert_eq!(result, Ok(Some(first)));
    let _ = second; // suppress unused warning
}

#[test]
fn key_equals_value_flag_is_skipped_not_parsed() {
    // We do NOT extract a path out of `--open=/some/path.md` — the whole arg
    // is treated as a flag. Only the first non-flag arg is considered.
    let dir = TempDir::new().unwrap();
    let p = touch(&dir, "real.md");
    let bogus = format!("--open={}", p.display());
    let cwd = std::env::current_dir().unwrap();
    let result = extract_file_arg(&args(&[bogus.as_str()]), &cwd);
    assert_eq!(
        result,
        Ok(None),
        "`--open=path` style flags must not have their value parsed as a file"
    );
}

#[test]
fn each_supported_extension_is_accepted() {
    let dir = TempDir::new().unwrap();
    let cwd = std::env::current_dir().unwrap();
    for ext in ["md", "markdown", "txt", "html", "docx"] {
        let p = touch(&dir, &format!("doc.{ext}"));
        let result = extract_file_arg(&args(&[p.to_str().unwrap()]), &cwd);
        assert_eq!(
            result,
            Ok(Some(p.clone())),
            "extension '.{ext}' should be accepted"
        );
    }
}

#[test]
fn extension_check_is_case_insensitive() {
    let dir = TempDir::new().unwrap();
    let p = touch(&dir, "DOC.MD");
    let cwd = std::env::current_dir().unwrap();
    let result = extract_file_arg(&args(&[p.to_str().unwrap()]), &cwd);
    assert_eq!(result, Ok(Some(p)));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_alternate_data_stream_path_is_rejected() {
    // NTFS ADS syntax `file.md:Zone.Identifier` contains a `:` at a position
    // other than the drive-letter slot (index 1). The test does NOT create a
    // real ADS — we just verify the parser rejects the shape.
    let cwd = std::env::current_dir().unwrap();
    let result = extract_file_arg(&args(&["C:\\tmp\\file.md:Zone.Identifier"]), &cwd);
    assert_eq!(
        result,
        Err(RejectionReason::SuspiciousColon),
        "Path with colon outside drive-letter slot must be rejected with SuspiciousColon"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windows_relative_path_with_colon_rejected_after_resolution() {
    // A relative arg like `notes.md:Zone.Identifier` has its colon at index 9
    // in the candidate string, which the candidate-only scan correctly
    // rejects. The harder case is when `cwd.join(candidate)` is what would
    // be passed to the filesystem. We scan the resolved absolute path so the
    // post-join colon position is what matters.
    let cwd = PathBuf::from("C:\\Users\\bryan");
    let result = extract_file_arg(&args(&["notes.md:Zone.Identifier"]), &cwd);
    assert_eq!(
        result,
        Err(RejectionReason::SuspiciousColon),
        "Relative path with ADS colon must be rejected with SuspiciousColon after resolution against cwd"
    );
}

#[test]
fn warm_start_single_instance_args_shape() {
    // Reproduces the arg shape passed by `tauri-plugin-single-instance`:
    // `args[0]` is the executable path (potentially with spaces), `args[1]`
    // is the file the OS handed off. `cwd` is the second-instance's working
    // directory, supplied as a separate parameter by the plugin.
    let dir = TempDir::new().unwrap();
    let target = touch(&dir, "notes.md");

    let warm_args = vec![
        "C:\\Program Files\\Tandem\\tandem.exe".to_string(),
        target.to_string_lossy().into_owned(),
    ];
    let cwd = dir.path().to_path_buf();

    let result = extract_file_arg(&warm_args, &cwd);
    assert_eq!(
        result,
        Ok(Some(target)),
        "warm-start arg shape must resolve the file path"
    );
}
