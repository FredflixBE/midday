//! Updates, checked and installed from Rust.
//!
//! The window shows the remote dashboard, so the website never gets
//! `updater:*`: a page on that origin could otherwise start an install.
//! Releases come from the desktop release workflow, which publishes a signed
//! `latest.json` next to the installers (see `plugins.updater` in
//! tauri.conf.json).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// How often a running app looks for a new version after the launch check.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Who asked for the check. Only someone who asked hears "up to date" or an
/// error; the launch and timer checks stay silent unless there is an update.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Check {
    Scheduled,
    Asked,
}

#[derive(Default)]
struct UpdateState {
    /// A check or an install is in progress, so a second one never stacks a
    /// second dialog on top of the first.
    busy: AtomicBool,
    /// The version the user answered "Later" to. The timer does not ask about
    /// it again until the app restarts; asking by hand always does.
    declined: Mutex<Option<String>>,
}

/// Checks now, then every few hours, for as long as the app runs.
pub fn start(app: &AppHandle) {
    app.manage(UpdateState::default());
    let app = app.clone();
    std::thread::spawn(move || loop {
        tauri::async_runtime::block_on(check(&app, Check::Scheduled));
        std::thread::sleep(CHECK_EVERY);
    });
}

/// Runs a check off the calling thread: the dialogs block, and the tray's
/// menu handler runs on the main thread.
pub fn check_in_background(app: &AppHandle, trigger: Check) {
    let app = app.clone();
    std::thread::spawn(move || tauri::async_runtime::block_on(check(&app, trigger)));
}

async fn check(app: &AppHandle, trigger: Check) {
    let Some(state) = app.try_state::<UpdateState>() else {
        return;
    };
    if state.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    run_check(app, &state, trigger).await;
    state.busy.store(false, Ordering::SeqCst);
}

async fn run_check(app: &AppHandle, state: &UpdateState, trigger: Check) {
    let name = app.package_info().name.clone();
    let current = app.package_info().version.to_string();

    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) => {
            println!("⬆️ No update: {} is the latest", current);
            if trigger == Check::Asked {
                tell(app, "No update", &format!("{name} {current} is the latest version."));
            }
            return;
        }
        // A build without an endpoint (dev builds) has updates turned off.
        Err(tauri_plugin_updater::Error::EmptyEndpoints) => return,
        Err(error) => {
            // Offline, GitHub unreachable, or no release yet: say nothing
            // unless someone asked.
            eprintln!("⬆️ Update check failed: {}", error);
            if trigger == Check::Asked {
                tell(app, "Could not check for updates", &error.to_string());
            }
            return;
        }
    };

    let declined = state.declined.lock().unwrap().clone();
    if !should_ask(&update.version, declined.as_deref(), trigger) {
        return;
    }

    let install = app
        .dialog()
        .message(offer(&name, &update.version, &current, cfg!(windows)))
        .title("Update available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and restart".into(),
            "Later".into(),
        ))
        .blocking_show();
    if !install {
        *state.declined.lock().unwrap() = Some(update.version.clone());
        return;
    }

    println!("⬆️ Installing {}", update.version);
    match update.download_and_install(|_, _| {}, || {}).await {
        // On Windows the installer has already closed the app by now.
        Ok(()) => app.restart(),
        Err(error) => {
            eprintln!("⬆️ Update failed: {}", error);
            tell(app, "The update failed", &error.to_string());
        }
    }
}

fn tell(app: &AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok)
        .blocking_show();
}

/// Whether to offer `version`: always when asked, and otherwise unless it is
/// the one the user already put off.
fn should_ask(version: &str, declined: Option<&str>, trigger: Check) -> bool {
    trigger == Check::Asked || declined != Some(version)
}

/// The text of the "update available" dialog.
fn offer(name: &str, version: &str, current: &str, windows: bool) -> String {
    let mut text = format!("{name} {version} is available. You have {current}.");
    if windows {
        text.push_str(&format!("\n\n{name} closes while the update installs."));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_a_new_version() {
        assert!(should_ask("0.5.12", None, Check::Scheduled));
        assert!(should_ask("0.5.12", Some("0.5.11"), Check::Scheduled));
    }

    #[test]
    fn the_timer_does_not_ask_again_about_a_version_put_off() {
        assert!(!should_ask("0.5.12", Some("0.5.12"), Check::Scheduled));
    }

    #[test]
    fn asking_by_hand_always_offers_it() {
        assert!(should_ask("0.5.12", Some("0.5.12"), Check::Asked));
    }

    #[test]
    fn the_offer_names_both_versions() {
        assert_eq!(
            offer("HQ", "0.5.12", "0.5.9", false),
            "HQ 0.5.12 is available. You have 0.5.9."
        );
    }

    #[test]
    fn on_windows_the_offer_says_the_app_closes() {
        assert!(offer("HQ", "0.5.12", "0.5.9", true).ends_with("HQ closes while the update installs."));
    }
}
