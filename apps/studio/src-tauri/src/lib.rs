#[cfg(all(debug_assertions, feature = "native-smoke", target_os = "macos"))]
mod native_smoke;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));
    #[cfg(all(debug_assertions, feature = "native-smoke", target_os = "macos"))]
    let builder = builder.on_page_load(native_smoke::on_page_load).setup(native_smoke::setup);
    let context = tauri::generate_context!();
    #[cfg(all(debug_assertions, feature = "native-smoke", target_os = "macos"))]
    let context = native_smoke::configure(context);
    let builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_persisted_scope::init());
    builder
        .run(context)
        .expect("Failed to start Creator Studio");
}
