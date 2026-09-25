//! Native notifications for the dashboard's activities.
//!
//! The dashboard decides what to show (its Realtime subscription and a switch
//! in its settings) and calls `notify`; the shell decides whether the window
//! is in use. A click
//! brings the main window forward and opens `path` there, through the same
//! `deep-link-navigate` event an `hq://` link uses.
//!
//! This talks to the operating system directly rather than through
//! tauri-plugin-notification, whose desktop side cannot report a click.

use tauri::{AppHandle, Emitter, Manager};

/// Shows `text` as a native notification. `path` is a dashboard path, such as
/// `invoices?invoiceId=…&invoiceType=details`, opened when it is clicked.
///
/// Nothing shows while the main window is in use, unless `even_in_foreground`:
/// the page cannot tell for itself, because WebKit reports the document as
/// focused even while the app is hidden.
#[tauri::command]
pub fn notify(
    app: AppHandle,
    text: String,
    path: Option<String>,
    even_in_foreground: Option<bool>,
) -> Result<(), String> {
    let main = app.get_webview_window("main").map(|window| Window {
        visible: window.is_visible().unwrap_or(false),
        focused: window.is_focused().unwrap_or(false),
        minimized: window.is_minimized().unwrap_or(false),
    });
    if !should_show(main, even_in_foreground.unwrap_or(false)) {
        return Ok(());
    }

    let path = dashboard_path(path.as_deref());
    // Waiting for the click blocks, so each notification gets its own thread
    // for as long as it sits in the notification centre.
    std::thread::spawn(move || {
        if show(&app, &text) {
            println!("🔔 Notification clicked, opening /{}", path);
            open(&app, &path);
        }
    });
    Ok(())
}

#[derive(Clone, Copy, Debug)]
struct Window {
    visible: bool,
    focused: bool,
    minimized: bool,
}

/// Whether a notification shows: always when asked to, and otherwise only
/// when the main window is not the one in use (hidden in the tray, minimized,
/// or behind another app).
fn should_show(main: Option<Window>, even_in_foreground: bool) -> bool {
    let in_use = main.is_some_and(|w| w.visible && w.focused && !w.minimized);
    even_in_foreground || !in_use
}

/// The path a click opens, without the leading slashes that would turn
/// `/${path}` into a link to another host.
fn dashboard_path(path: Option<&str>) -> String {
    path.unwrap_or_default().trim_start_matches(['/', '\\']).to_string()
}

fn open(app: &AppHandle, path: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("deep-link-navigate", path);
    }
}

/// Shows the notification and waits: `true` when it was clicked.
#[cfg(target_os = "macos")]
fn show(app: &AppHandle, text: &str) -> bool {
    use mac_notification_sys::{Notification, NotificationResponse};
    use std::sync::Once;

    // Which app the notification comes from: its name and icon, and where
    // macOS keeps its notification settings.
    static APPLICATION: Once = Once::new();
    APPLICATION.call_once(|| {
        let _ = mac_notification_sys::set_application(&app.config().identifier);
    });

    match mac_notification_sys::send_notification(
        text,
        None,
        "",
        Some(Notification::new().wait_for_click(true)),
    ) {
        Ok(NotificationResponse::Click) => true,
        Ok(_) => false,
        Err(error) => {
            eprintln!("🔔 Could not show a notification: {}", error);
            false
        }
    }
}

/// Shows the notification and waits: `true` when it was clicked.
#[cfg(windows)]
fn show(app: &AppHandle, text: &str) -> bool {
    use std::sync::mpsc;
    use tauri_winrt_notification::{Toast, ToastDismissalReason};

    // An installed app's toasts carry its own name and icon, through the
    // AppUserModelID the installer registers (the bundle identifier). A binary
    // run straight from target/ has none, so it borrows PowerShell's.
    let installed = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
        .is_some_and(|dir| !dir.ends_with("target\\release") && !dir.ends_with("target\\debug"));
    let app_id = if installed {
        app.config().identifier.clone()
    } else {
        Toast::POWERSHELL_APP_ID.to_string()
    };

    // true for a click, false when the user closes the toast. A toast that
    // times out moves to the notification centre, where it can still be
    // clicked, so the wait goes on.
    let (answered, answer) = mpsc::channel();
    let dismissed = answered.clone();
    let toast = Toast::new(&app_id)
        .title(text)
        .on_activated(move |_| {
            let _ = answered.send(true);
            Ok(())
        })
        .on_dismissed(move |reason| {
            if reason == Some(ToastDismissalReason::UserCanceled) {
                let _ = dismissed.send(false);
            }
            Ok(())
        });
    if let Err(error) = toast.show() {
        eprintln!("🔔 Could not show a notification: {}", error);
        return false;
    }
    // `toast` holds the handlers, so it lives until the answer comes.
    let clicked = answer.recv().unwrap_or(false);
    drop(toast);
    clicked
}

#[cfg(not(any(target_os = "macos", windows)))]
fn show(_app: &AppHandle, _text: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_shows_over_the_window_in_use() {
        let in_use = Window { visible: true, focused: true, minimized: false };
        assert!(!should_show(Some(in_use), false));
        assert!(should_show(Some(in_use), true));
    }

    #[test]
    fn it_shows_whenever_the_window_is_not_in_use() {
        for window in [
            Window { visible: false, focused: false, minimized: false }, // in the tray
            Window { visible: true, focused: false, minimized: false },  // behind another app
            Window { visible: true, focused: true, minimized: true },    // minimized
        ] {
            assert!(should_show(Some(window), false), "{window:?}");
        }
        assert!(should_show(None, false));
    }

    #[test]
    fn a_click_opens_a_dashboard_path() {
        assert_eq!(
            dashboard_path(Some("invoices?invoiceId=1&invoiceType=details")),
            "invoices?invoiceId=1&invoiceType=details"
        );
        assert_eq!(dashboard_path(Some("/inbox")), "inbox");
        assert_eq!(dashboard_path(None), "");
    }

    #[test]
    fn a_click_never_leaves_the_dashboard() {
        assert_eq!(dashboard_path(Some("//evil.example/x")), "evil.example/x");
        assert_eq!(dashboard_path(Some("/\\evil.example/x")), "evil.example/x");
    }
}
