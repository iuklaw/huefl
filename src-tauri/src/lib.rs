mod config;
mod daily;
mod hue;
mod i18n;
mod logs;
mod paths;
mod report;
mod sync;
mod tray;
mod updates;
mod window;

use tauri::{AppHandle, Emitter, WindowEvent};

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    // Before anything reads them: bring config and logs over from the old name.
    let migrated = paths::migrate_legacy();
    tauri::Builder::default()
        .manage(hue::HueState::default())
        .manage(window::WindowPlacement::default())
        .manage(sync::manager::SyncManager::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            logs::init(app.handle());
            updates::init(app.handle());
            if !migrated.is_empty() {
                logs::write(
                    app.handle(),
                    "info",
                    "app",
                    "app.migrated",
                    "Moved settings and logs from Hue Tray to HueFL",
                    Some(serde_json::json!({ "to": migrated })),
                );
            }
            tray::init(app.handle())?;
            Ok(())
        })
        // The window is never destroyed by the window manager (Alt+F4 etc.):
        // the UI decides between hiding to the tray and quitting, based on the
        // user's preference or by asking. The window is visible at this point,
        // so its JS is running and can answer.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            quit,
            config::load_config,
            config::save_config,
            hue::hue_request,
            hue::hue_stream,
            hue::hue_stream_close,
            hue::avahi_browse,
            hue::discover_cloud,
            hue::device_name,
            daily::color_of_the_day,
            tray::set_tray_state,
            window::window_hide,
            window::window_show,
            sync::sync_overview,
            sync::sync_start,
            sync::sync_stop,
            sync::sync_status,
            sync::sync_audio_devices,
            sync::sync_monitors,
            sync::sync_screen_pick,
            sync::sync_create_area,
            sync::sync_update_area,
            sync::sync_delete_area,
            logs::log_write,
            logs::log_read,
            logs::log_clear,
            logs::log_path,
            updates::update_check,
            updates::update_install,
            updates::update_restart,
            report::bug_report_system_info,
            report::bug_report_logs,
            report::bug_report_send,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start the application")
        .run(|app, event| {
            // Never leave a stream running (and the lights stuck) after quitting.
            if let tauri::RunEvent::Exit = event {
                sync::shutdown(app);
            }
        });
}
