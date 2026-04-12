fn main() {
    // Forward TARGET to the main crate so resolve_setup_paths can construct
    // the sidecar binary name with the correct target triple suffix.
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap()
    );
    tauri_build::build()
}
