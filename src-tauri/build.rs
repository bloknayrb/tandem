fn main() {
    // No `cargo:rustc-env=TARGET_TRIPLE` forwarding: the last consumer was
    // `sidecar_exe_path`, and #1762 replaced its reconstructed
    // `node-sidecar-<triple>` with `SIDECAR_BIN_NAME` — the stripped name
    // tauri-build actually installs. The triple is a build-time convention of
    // `src-tauri/binaries/` only, so no runtime code may depend on it.
    tauri_build::build()
}
