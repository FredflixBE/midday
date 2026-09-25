use serde_json;
use std::env;
use std::sync::{Arc, Mutex};
use tauri::{
    Emitter, Listener, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder,
};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog;
use tauri_plugin_process;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use image;

#[cfg(desktop)]
mod updates;

// Global state for search window availability
type SearchWindowState = Arc<Mutex<bool>>;

#[tauri::command]
fn show_window(window: tauri::Window) -> Result<(), String> {
    // Always target the main window specifically, not the calling window
    let app_handle = window.app_handle();
    let main_window = match app_handle.get_webview_window("main") {
        Some(window) => window,
        None => {
            return Err("Main window not found".to_string());
        }
    };

    main_window
        .show()
        .map_err(|e| format!("Failed to show window: {}", e))?;
    main_window
        .set_focus()
        .map_err(|e| format!("Failed to set focus: {}", e))?;

    Ok(())
}

fn toggle_search_window(
    app: &tauri::AppHandle,
    search_state: &SearchWindowState,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("🔍 === TOGGLE_SEARCH_WINDOW CALLED ===");

    let is_search_enabled = {
        let guard = search_state.lock().unwrap();
        let value = *guard;
        println!("🔍 Current search window state from lock: {}", value);
        value
    };

    if !is_search_enabled {
        println!("❌ Search window disabled, showing main window instead");
        // Search is disabled, show main window
        if let Some(main_window) = app.get_webview_window("main") {
            main_window.show()?;
            main_window.set_focus()?;
        }
        return Ok(());
    }

    println!("✅ Search window enabled, proceeding with search toggle");
    // Search is enabled, proceed with search toggle
    let search_window_label = "search";

    println!("🔍 Looking for existing search window...");
    if let Some(window) = app.get_webview_window(search_window_label) {
        println!("🔍 Found existing search window");
        if window.is_visible()? {
            println!("🔍 Search window is visible, hiding it");
            // Emit close event to search window
            let _ = window.emit("search-window-open", false);
            window.hide()?;
        } else {
            println!("🔍 Search window is hidden, showing it");
            // Set always on top when showing
            window.set_always_on_top(true)?;
            position_window_on_current_monitor(app, &window)?;
            window.show()?;
            window.set_focus()?; // Focus the window so it can detect focus loss

            // Emit open event to search window
            let _ = window.emit("search-window-open", true);
        }
    } else {
        println!("🔍 Search window doesn't exist, creating it now...");
        // Create search window on-demand
        let app_url = get_app_url();
        let app_clone = app.clone();

        // Use blocking approach for shortcut/tray handlers to ensure window is created
        tauri::async_runtime::block_on(async move {
            if let Ok(_) = create_preloaded_search_window(&app_clone, &app_url).await {
                println!("✅ Search window created successfully via block_on");
                // After creation, show it immediately
                if let Some(window) = app_clone.get_webview_window("search") {
                    let _ = window.set_always_on_top(true);
                    let _ = position_window_on_current_monitor(&app_clone, &window);
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("search-window-open", true);
                    println!("✅ Search window shown successfully");
                } else {
                    println!("❌ Search window not found after creation");
                }
            } else {
                println!("❌ Failed to create search window");
            }
        });
    }

    Ok(())
}

fn position_window_on_current_monitor(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), Box<dyn std::error::Error>> {
    // Get cursor position to determine current monitor
    if let Ok(cursor_position) = app.cursor_position() {
        // Get all monitors
        if let Ok(monitors) = app.available_monitors() {
            // Find which monitor contains the cursor
            let current_monitor = monitors.iter().find(|monitor| {
                let pos = monitor.position();
                let size = monitor.size();
                cursor_position.x >= pos.x as f64
                    && cursor_position.x < (pos.x + size.width as i32) as f64
                    && cursor_position.y >= pos.y as f64
                    && cursor_position.y < (pos.y + size.height as i32) as f64
            });

            if let Some(monitor) = current_monitor {
                let monitor_size = monitor.size();
                let monitor_position = monitor.position();

                // Get the actual window size to ensure accurate centering
                let window_size = window.outer_size().unwrap_or(tauri::PhysicalSize {
                    width: 720,
                    height: 450,
                });

                // Calculate center position on the monitor with slight offset for system UI
                let center_x = monitor_position.x + (monitor_size.width as i32 / 2)
                    - (window_size.width as i32 / 2);
                let center_y = monitor_position.y + (monitor_size.height as i32 / 2)
                    - (window_size.height as i32 / 2);

                // Adjust for macOS menu bar (typically 25-30px) and other system UI
                let center_y = center_y + 15; // Slight downward adjustment for menu bar

                window.set_position(Position::Physical(PhysicalPosition {
                    x: center_x,
                    y: center_y,
                }))?;

                return Ok(());
            }
        }
    }

    // Fallback to default center if monitor detection fails
    window.center()?;
    Ok(())
}

async fn create_preloaded_search_window(
    app: &tauri::AppHandle,
    app_url: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let search_window_label = "search";
    let search_url = format!("{}/desktop/search", app_url);

    let search_builder = WebviewWindowBuilder::new(
        app,
        search_window_label,
        WebviewUrl::External(tauri::Url::parse(&search_url)?),
    )
    .title("Midday Search")
    .inner_size(720.0, 450.0)
    .min_inner_size(720.0, 450.0)
    .resizable(false)
    .user_agent("Mozilla/5.0 (compatible; Midday Desktop App)")
    .transparent(true)
    .decorations(false)
    .visible(false) // Start hidden for preloading
    .on_download(|_window, _event| {
        println!("Search window download triggered!");
        // Allow downloads from search window too
        true
    });

    // macOS: hide the native title bar
    #[cfg(target_os = "macos")]
    let search_builder = search_builder
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay);

    let search_window = search_builder.shadow(false).build()?;

    // Position window on primary monitor (will be repositioned when shown)
    search_window.center()?;

    // Close requests are now handled via auth state changes and direct window management

    // Handle window events - comprehensive auto-hide behavior
    let window_clone = search_window.clone();
    search_window.on_window_event(move |event| {
        match event {
            // Main case: window loses focus (click outside anywhere)
            tauri::WindowEvent::Focused(false) => {
                // Emit close event to search window
                let _ = window_clone.emit("search-window-open", false);
                // Turn off always on top and hide
                let _ = window_clone.set_always_on_top(false);
                let _ = window_clone.hide();
            }
            // Additional safety: if window somehow becomes invisible but should be hidden
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                // Check if still focused after these events, if not, hide
                if let Ok(false) = window_clone.is_focused() {
                    let _ = window_clone.emit("search-window-open", false);
                    let _ = window_clone.set_always_on_top(false);
                    let _ = window_clone.hide();
                }
            }
            _ => {}
        }
    });

    Ok(())
}

/// The dashboard URL the desktop shell loads.
///
/// Set `MIDDAY_APP_URL` when building (`MIDDAY_APP_URL=https://... bun run tauri:build`)
/// to bake it into the binary; a runtime `MIDDAY_APP_URL` overrides it for local
/// testing. Defaults to the local dev server. The host must also be listed in
/// `capabilities/default.json` so the webview can reach the Tauri IPC.
fn get_app_url() -> String {
    let url = env::var("MIDDAY_APP_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| option_env!("MIDDAY_APP_URL").map(|value| value.to_string()))
        .unwrap_or_else(|| "http://localhost:3001".to_string());
    let url = url.trim().trim_end_matches('/').to_string();

    println!("🌍 Using app URL: {}", url);
    url
}

fn is_external_url(url: &str, app_url: &str) -> bool {
    // Parse both URLs to compare domains
    if let (Ok(target_url), Ok(base_url)) = (tauri::Url::parse(url), tauri::Url::parse(app_url)) {
        // Check if schemes are http/https
        let is_http_scheme = target_url.scheme() == "http" || target_url.scheme() == "https";

        // Check if it's a different domain/host
        let is_different_host = target_url.host() != base_url.host();

        return is_http_scheme && is_different_host;
    }
    false
}

/// The deep-link schemes this build registers: `plugins.deep-link.desktop` in
/// tauri.conf.json (`hq`), or in tauri.dev.conf.json for dev builds (`hq-dev`).
/// `desktop` is either one `{ "schemes": [...] }` object or a list of them.
fn configured_schemes(deep_link_config: Option<&serde_json::Value>) -> Vec<String> {
    let protocols = match deep_link_config.and_then(|config| config.get("desktop")) {
        Some(serde_json::Value::Array(list)) => list.iter().collect(),
        Some(one) => vec![one],
        None => vec![],
    };

    protocols
        .into_iter()
        .filter_map(|protocol| protocol.get("schemes")?.as_array())
        .flatten()
        .filter_map(|scheme| scheme.as_str())
        .map(str::to_string)
        .collect()
}

/// The dashboard path a deep link points at, or `None` when the link uses a
/// scheme this build does not own.
fn deep_link_path<'a>(url: &'a str, schemes: &[String]) -> Option<&'a str> {
    let (scheme, path) = url.split_once("://")?;
    if !schemes.iter().any(|own| own.eq_ignore_ascii_case(scheme)) {
        return None;
    }
    Some(path.trim_start_matches('/'))
}

/// The main window's usual size, in logical pixels.
const MAIN_WINDOW_SIZE: (f64, f64) = (1450.0, 910.0);

/// How small the main window may get. Small enough for a 1366×768 Windows
/// laptop at 125% scaling (about 1077×545 left inside the taskbar and title bar).
const MAIN_WINDOW_MIN_SIZE: (f64, f64) = (1024.0, 540.0);

/// The main window's size when it opens, given the room its screen has for the
/// page (the work area less the window's own frame): the usual size, shrunk to
/// fit, but never below the minimum.
fn opening_size(available: (f64, f64)) -> (f64, f64) {
    (
        MAIN_WINDOW_SIZE.0.min(available.0).max(MAIN_WINDOW_MIN_SIZE.0),
        MAIN_WINDOW_SIZE.1.min(available.1).max(MAIN_WINDOW_MIN_SIZE.1),
    )
}

/// Shrinks a just-built, still hidden main window to fit the screen it opens on.
fn fit_to_screen(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let work_area = monitor.work_area().size.to_logical::<f64>(scale);
    // Whatever the window draws around the page: the title bar and borders on
    // Windows, nothing on macOS, where the window is borderless.
    let outer = window.outer_size()?.to_logical::<f64>(scale);
    let inner = window.inner_size()?.to_logical::<f64>(scale);
    let available = (
        work_area.width - (outer.width - inner.width),
        work_area.height - (outer.height - inner.height),
    );

    let size = opening_size(available);
    if size != MAIN_WINDOW_SIZE {
        window.set_size(tauri::LogicalSize::new(size.0, size.1))?;
        window.center()?;
    }
    Ok(())
}

/// Brings the main window back from hidden or minimized and focuses it.
fn bring_main_window_forward(app: &tauri::AppHandle) {
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.unminimize();
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
}

/// Where the main window opens when a deep link launched the app: the link's
/// path on the dashboard. `None` for a link this build does not own, or one that
/// would lead off the dashboard's origin.
fn deep_link_start_url(app_url: &str, url: &str, schemes: &[String]) -> Option<tauri::Url> {
    let path = deep_link_path(url, schemes)?;
    let dashboard = tauri::Url::parse(app_url).ok()?;
    let target = dashboard.join(&format!("/{path}")).ok()?;
    (target.origin() == dashboard.origin()).then_some(target)
}

fn handle_deep_link_event(app_handle: &tauri::AppHandle, urls: Vec<String>) {
    let schemes = configured_schemes(app_handle.config().plugins.0.get("deep-link"));

    for url in &urls {
        let Some(clean_path) = deep_link_path(url, &schemes) else {
            println!("🔗 Ignoring deep link outside {:?}: {}", schemes, url);
            continue;
        };

        // Get the main window and emit navigation event to frontend
        if let Some(window) = app_handle.get_webview_window("main") {
            // Emit event to frontend with just the path - frontend handles the full URL construction
            if let Ok(_) = window.emit("deep-link-navigate", clean_path) {
                bring_main_window_forward(app_handle);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_url = get_app_url();

    let mut builder = tauri::Builder::default();

    // One copy of the app. On Windows and Linux every deep link (the sign-in
    // callback included) starts a new process; that process exits here, and the
    // plugin's `deep-link` feature (Cargo.toml) passes its URL on to the running
    // app's on_open_url. It must be the first plugin registered.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            bring_main_window_forward(app);
        }));
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![show_window])
        .setup(move |app| {
            let app_url_clone = app_url.clone();
            let app_handle = app.handle().clone();

            // Create shared search window state
            let search_state: SearchWindowState = Arc::new(Mutex::new(false));
            
            // Add search state to managed state so commands can access it
            app.manage(search_state.clone());

            // Clone app_handle before it gets moved into closures
            let app_handle_for_deep_links = app_handle.clone();
            let app_handle_for_navigation = app_handle.clone();
            
            // Auth state is now accessed via managed state for consistency

            // Initialize global shortcuts
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };

                let search_shortcut =
                    Shortcut::new(Some(Modifiers::SHIFT | Modifiers::ALT), Code::KeyK);

                if let Ok(_) = app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app_handle, shortcut, event| {
                            if shortcut == &search_shortcut
                                && event.state() == ShortcutState::Pressed
                            {
                                println!("🔍 Global shortcut triggered - checking search state via managed state");
                                // Get search state from managed state (same as commands use)
                                if let Some(managed_search_state) = app_handle.try_state::<SearchWindowState>() {
                                    let current_search_state = *managed_search_state.lock().unwrap();
                                    println!("🔍 Shortcut: Search state from managed state: {}", current_search_state);
                                    
                                    // Use the same app_handle for both search state and toggle function
                                    let result = toggle_search_window(app_handle, &managed_search_state);
                                    match result {
                                        Ok(_) => println!("🔍 Shortcut: toggle_search_window returned Ok"),
                                        Err(e) => println!("🔍 Shortcut: toggle_search_window returned Err: {}", e)
                                    }
                                } else {
                                    println!("❌ Failed to get managed search state for shortcut");
                                }
                            }
                        })
                        .build(),
                ) {
                    let _ = app.global_shortcut().register(search_shortcut);
                }
            }

            // Register deep links at runtime for development (Linux/Windows only).
            // macOS does not support runtime registration — the scheme is registered
            // via Info.plist when the .app bundle is installed in /Applications.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                match app_handle.deep_link().register_all() {
                    Ok(_) => println!("🔗 Deep link schemes registered successfully"),
                    Err(e) => eprintln!("🔗 Failed to register deep link schemes: {}", e),
                }
            }

            // A deep link that launched the app (e.g. the sign-in callback when the
            // app was not running) opens its page; otherwise the dashboard home.
            let launch_urls = app_handle.deep_link().get_current().ok().flatten().unwrap_or_default();
            println!("🔗 Current deep link URLs on launch: {:?}", launch_urls);
            let schemes = configured_schemes(app.config().plugins.0.get("deep-link"));
            let start_url = launch_urls
                .iter()
                .find_map(|url| deep_link_start_url(&app_url_clone, url.as_str(), &schemes))
                .unwrap_or_else(|| tauri::Url::parse(&app_url_clone).unwrap());

            // Handle deep link events
            app_handle.deep_link().on_open_url(move |event| {
                let url_strings: Vec<String> =
                    event.urls().iter().map(|url| url.to_string()).collect();
                println!("🔗 Deep link received: {:?}", url_strings);
                handle_deep_link_event(&app_handle_for_deep_links, url_strings);
            });

            let win_builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(start_url),
            )
            .title("Midday")
            .inner_size(MAIN_WINDOW_SIZE.0, MAIN_WINDOW_SIZE.1)
            .min_inner_size(MAIN_WINDOW_MIN_SIZE.0, MAIN_WINDOW_MIN_SIZE.1)
            .user_agent("Mozilla/5.0 (compatible; Midday Desktop App)")
            .visible(false)
            .shadow(true)
            .disable_drag_drop_handler()
            .on_download(|_window, _event| {
                println!("Download triggered!");
                // Allow all downloads - they will go to default Downloads folder
                true
            })
            .on_navigation(move |url| {
                let url_str = url.as_str();

                // Check if this is an external URL
                if is_external_url(url_str, &app_url_clone) {
                    // Clone the URL string to avoid lifetime issues
                    let url_string = url_str.to_string();
                    let app_handle_clone = app_handle_for_navigation.clone();

                    // Open in system browser using the opener plugin
                    tauri::async_runtime::spawn(async move {
                        let _ = tauri_plugin_opener::OpenerExt::opener(&app_handle_clone)
                                .open_url(url_string, None::<String>);
                    });

                    // Prevent navigation in webview
                    return false;
                }

                // Allow internal navigation
                true
            });

            // On macOS the dashboard draws its own title bar and traffic lights over a
            // borderless window. Elsewhere the window keeps the native title bar and
            // buttons: the dashboard's chrome is macOS-only.
            #[cfg(target_os = "macos")]
            let win_builder = win_builder
                .decorations(false)
                .transparent(true)
                .hidden_title(true)
                .title_bar_style(TitleBarStyle::Overlay);

            let window = win_builder.build().unwrap();
            if let Err(error) = fit_to_screen(&window) {
                eprintln!("Could not fit the main window to the screen: {}", error);
            }

            // Closing the main window hides it, as the dashboard's own close button
            // does, so the tray and the global shortcut can bring it back. Destroyed,
            // it could not be recreated. On Windows this is the native close button.
            let window_for_close = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_for_close.hide();
                }
            });

            // Listen for search window state events from the frontend
            let search_state_for_events = search_state.clone();
            let app_handle_for_events = app_handle.clone();
            window.listen("search-window-enabled", move |event| {
                if let Ok(enabled) = serde_json::from_str::<bool>(&event.payload()) {
                    println!("🔍 Event received: search-window-enabled = {}", enabled);
                    *search_state_for_events.lock().unwrap() = enabled;
                    println!("🔍 Search window state updated to {}", enabled);
                    
                    // If search is disabled, clean up search window to prevent interference
                    if !enabled {
                        println!("🔍 Search disabled, cleaning up search window");
                        if let Some(search_window) = app_handle_for_events.get_webview_window("search") {
                            let _ = search_window.close();
                            println!("🔍 Search window closed and cleaned up");
                        }
                    }
                }
            });

            // Listen for search window close requests from the frontend
            let app_handle_for_close = app_handle.clone();
            window.listen("search-window-close-requested", move |_event| {
                println!("🔍 Event received: search-window-close-requested");
                if let Some(search_window) = app_handle_for_close.get_webview_window("search") {
                    let _ = search_window.emit("search-window-open", false);
                    let _ = search_window.set_always_on_top(false);
                    let _ = search_window.hide();
                    println!("🔍 Search window closed via close request");
                }
            });

            // Fallback timer to ensure main window shows on first launch
            let window_clone = window.clone();
            tauri::async_runtime::spawn(async move {
                std::thread::sleep(std::time::Duration::from_secs(2));

                // Check if window is still hidden after 2 seconds
                if let Ok(is_visible) = window_clone.is_visible() {
                    if !is_visible {
                        let _ = window_clone.show();
                        let _ = window_clone.set_focus();
                    }
                }
            });

            // Don't preload search window immediately - create it on first use instead
            // This prevents interference with the login flow

            // Set the default app menu to restore the Midday menu. macOS only: on
            // Windows and Linux an app menu becomes a menu bar inside every window.
            #[cfg(target_os = "macos")]
            {
                let app_menu = Menu::default(app.handle())?;
                app.set_menu(app_menu)?;
            }

            // Setup simple system tray for search toggle only
            // Load custom tray icon
            let tray_icon = {
                let icon_bytes = include_bytes!("../icons/tray-icon.png");
                let img = image::load_from_memory(icon_bytes).map_err(|e| format!("Failed to load tray icon: {}", e))?;
                let rgba = img.to_rgba8();
                let (width, height) = rgba.dimensions();
                Image::new_owned(rgba.into_raw(), width, height)
            };

            // Create tray menu. "Open Midday" is the way back to a closed (hidden)
            // main window where there is no Dock icon to click, as on Windows.
            // The version line is how anyone can tell an update has landed.
            let open_item = MenuItem::with_id(app, "open", "Open Midday", true, None::<&str>)?;
            let update_item =
                MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
            let version_item = MenuItem::with_id(
                app,
                "version",
                format!("Version {}", app.package_info().version),
                false,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Midday", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[&open_item, &update_item, &version_item, &separator, &quit_item],
            )?;

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    println!("🔧 Tray menu event triggered: {:?}", event.id);
                    if event.id == "open" {
                        bring_main_window_forward(app);
                    }
                    #[cfg(desktop)]
                    if event.id == "check-updates" {
                        updates::check_in_background(app, updates::Check::Asked);
                    }
                    if event.id == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(move |tray, event| {
                    match event {
                        // Handle left clicks to toggle search window (keep existing behavior)
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            let app_handle = tray.app_handle();
                            if let Some(managed_search_state) = app_handle.try_state::<SearchWindowState>() {
                                let _ = toggle_search_window(app_handle, &managed_search_state);
                            }
                        },
                        _ => {}
                    }
                })
                .build(app)?;

            #[cfg(desktop)]
            updates::start(app.handle());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri app")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }
            }
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                // An explicit quit (tray menu → app.exit) carries a code; let it through.
                if code.is_some() {
                    return;
                }

                // Prevent app from quitting to keep global shortcuts working
                api.prevent_exit();
                
                // Hide all windows instead of quitting
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.hide();
                }
                if let Some(search_window) = app_handle.get_webview_window("search") {
                    let _ = search_window.hide();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_schemes_from_a_single_protocol() {
        let config = json!({ "desktop": { "schemes": ["hq"] } });
        assert_eq!(configured_schemes(Some(&config)), vec!["hq"]);
    }

    #[test]
    fn reads_schemes_from_a_list_of_protocols() {
        let config = json!({ "desktop": [{ "schemes": ["hq"] }, { "schemes": ["hq-dev"] }] });
        assert_eq!(configured_schemes(Some(&config)), vec!["hq", "hq-dev"]);
    }

    #[test]
    fn no_config_means_no_schemes() {
        assert!(configured_schemes(None).is_empty());
        assert!(configured_schemes(Some(&json!({}))).is_empty());
    }

    #[test]
    fn opens_the_path_of_an_own_scheme() {
        let schemes = vec!["hq".to_string()];
        assert_eq!(deep_link_path("hq://transactions", &schemes), Some("transactions"));
        assert_eq!(
            deep_link_path("hq:///settings/accounts?id=1&step=reconnect", &schemes),
            Some("settings/accounts?id=1&step=reconnect")
        );
        assert_eq!(deep_link_path("HQ://inbox", &schemes), Some("inbox"));
    }

    #[test]
    fn ignores_every_other_scheme() {
        let schemes = vec!["hq".to_string()];
        assert_eq!(deep_link_path("midday://transactions", &schemes), None);
        assert_eq!(deep_link_path("hq-dev://transactions", &schemes), None);
        assert_eq!(deep_link_path("https://midday.fredflix.be", &schemes), None);
        assert_eq!(deep_link_path("not a url", &schemes), None);
    }

    const DASHBOARD: &str = "https://midday.fredflix.be";

    fn launch_page(url: &str) -> Option<String> {
        deep_link_start_url(DASHBOARD, url, &["hq".to_string()]).map(|url| url.to_string())
    }

    #[test]
    fn a_launch_link_opens_its_page_on_the_dashboard() {
        assert_eq!(launch_page("hq://transactions").as_deref(), Some("https://midday.fredflix.be/transactions"));
        assert_eq!(launch_page("hq://").as_deref(), Some("https://midday.fredflix.be/"));
    }

    #[test]
    fn a_launch_link_keeps_the_sign_in_code() {
        assert_eq!(
            launch_page("hq://api/auth/callback?code=abc-123").as_deref(),
            Some("https://midday.fredflix.be/api/auth/callback?code=abc-123")
        );
    }

    #[test]
    fn a_launch_link_never_leaves_the_dashboard() {
        assert_eq!(launch_page("midday://transactions"), None);
        // The URL parser reads a backslash as a slash, so this one resolves to
        // //evil.example/x, another host; only the origin check stops it.
        assert_eq!(launch_page("hq://\\\\evil.example/x"), None);
        for escape in ["hq://\\\\evil.example/x", "hq:///\\evil.example/x", "hq://%2F%2Fevil.example/x"] {
            if let Some(url) = launch_page(escape) {
                assert!(url.starts_with("https://midday.fredflix.be/"), "{escape} opened {url}");
            }
        }
    }

    fn parse_json(json: &str) -> serde_json::Value {
        serde_json::from_str(json).expect("valid JSON")
    }

    #[test]
    fn a_shipped_build_trusts_no_localhost() {
        // Without an explicit list Tauri enables every file in capabilities/,
        // dev.json included, so this list is what keeps localhost out.
        let config = parse_json(include_str!("../tauri.conf.json"));
        assert_eq!(config["app"]["security"]["capabilities"], json!(["default"]));

        let default = parse_json(include_str!("../capabilities/default.json"));
        let urls = default["remote"]["urls"].as_array().unwrap();
        assert!(!urls.is_empty());
        assert!(urls.iter().all(|url| !url.as_str().unwrap().contains("localhost")));
    }

    #[test]
    fn the_dev_capability_grants_localhost_exactly_what_production_gets() {
        let default = parse_json(include_str!("../capabilities/default.json"));
        let dev = parse_json(include_str!("../capabilities/dev.json"));
        for key in ["permissions", "windows", "platforms"] {
            assert_eq!(dev[key], default[key], "dev.json {key} differ from default.json");
        }
        assert_eq!(dev["remote"]["urls"], json!(["http://localhost:3001/**"]));
    }

    #[test]
    fn a_shipped_build_updates_from_the_newest_github_release() {
        let config = parse_json(include_str!("../tauri.conf.json"));
        let updater = &config["plugins"]["updater"];
        assert_eq!(
            updater["endpoints"],
            json!(["https://github.com/FredflixBE/midday/releases/latest/download/latest.json"])
        );
        assert!(!updater["pubkey"].as_str().unwrap_or_default().is_empty());
    }

    #[test]
    fn a_dev_build_never_offers_a_production_release() {
        let dev = parse_json(include_str!("../tauri.dev.conf.json"));
        assert_eq!(dev["plugins"]["updater"]["endpoints"], json!([]));
    }

    #[test]
    fn a_large_screen_opens_the_usual_size() {
        assert_eq!(opening_size((2560.0, 1400.0)), MAIN_WINDOW_SIZE);
    }

    #[test]
    fn a_small_screen_opens_a_window_that_fits_it() {
        // A 1366×768 laptop at 100%, less the taskbar and the title bar.
        assert_eq!(opening_size((1350.0, 681.0)), (1350.0, 681.0));
        // The same laptop at 125%.
        assert_eq!(opening_size((1077.0, 545.0)), (1077.0, 545.0));
    }

    #[test]
    fn a_window_never_opens_below_its_minimum() {
        assert_eq!(opening_size((800.0, 500.0)), MAIN_WINDOW_MIN_SIZE);
    }

    #[test]
    fn the_website_gets_only_what_the_dashboard_calls() {
        // The window shows a remote site: anything granted here, any page on
        // that origin can do. The tray, menus, app metadata, images, webviews
        // and updates stay in Rust.
        let default = parse_json(include_str!("../capabilities/default.json"));
        let granted: Vec<&str> = default["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|permission| permission.as_str().unwrap())
            .collect();
        let forbidden = [
            "core:default",
            "core:app:",
            "core:image:",
            "core:menu:",
            "core:tray:",
            "core:webview:",
            "deep-link:",
            "updater:",
        ];
        for permission in &granted {
            assert!(
                !forbidden.iter().any(|prefix| permission.starts_with(prefix)),
                "capabilities/default.json grants the website {permission}"
            );
        }
    }
}
