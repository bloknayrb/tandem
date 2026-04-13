fn main() {
    // Forward TARGET to the main crate so resolve_setup_paths can construct
    // the sidecar binary name with the correct target triple suffix.
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("TARGET not set -- run via cargo build or cargo tauri build")
    );
    tauri_build::build()
}
