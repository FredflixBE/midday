fn main() {
    // MIDDAY_APP_URL is read with option_env! in lib.rs; rebuild when it changes.
    println!("cargo:rerun-if-env-changed=MIDDAY_APP_URL");

    // Declaring the app's own commands puts them under the capabilities like
    // any plugin's: without this list Tauri lets every page the window loads
    // call them, whatever capabilities/default.json says. Each one needs an
    // allow-<command> grant there.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["show_window"])),
    )
    .expect("failed to run the tauri build script");
}
