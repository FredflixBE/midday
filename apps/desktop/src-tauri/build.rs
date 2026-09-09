fn main() {
    // MIDDAY_APP_URL is read with option_env! in lib.rs; rebuild when it changes.
    println!("cargo:rerun-if-env-changed=MIDDAY_APP_URL");
    tauri_build::build()
}
