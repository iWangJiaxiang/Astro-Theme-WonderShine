// Compiled only for an explicitly requested debug smoke-test binary.
// Production App builds never read this environment variable or evaluate test code.
pub fn on_page_load(window: &tauri::Webview<tauri::Wry>, payload: &tauri::webview::PageLoadPayload<'_>) {
    eprintln!("Native smoke page event: {:?}", payload.event());
    if payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
    }
    if let Ok(value) = std::env::var("STUDIO_NATIVE_SMOKE_CONFIG") {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&value) {
            let script = format!("window.__studioSmokeConfig = {};\n{}", config, include_str!("../../tests/native/macos-ui.js"));
            if let Err(error) = window.eval(script) { eprintln!("Native smoke injection failed: {error}"); }
        }
    }
}


pub fn configure(mut context: tauri::Context<tauri::Wry>) -> tauri::Context<tauri::Wry> {
    context.config_mut().identifier = "me.wondershine.studio.acceptance".into();
    // Keep automation timers running when another desktop window takes focus.
    // The regular App retains the platform's default background policy.
    for window in &mut context.config_mut().app.windows {
        // Use a nonpersistent WebView store, including on crashes or forced exits.
        window.incognito = true;
        window.title = "WonderShine Studio — isolated acceptance test".into();
        window.background_throttling = Some(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    }
    context
}

// Emulate only the directory permission grant in automated native tests.
// The real system dialog remains an interactive OS UI.
pub fn setup(app: &mut tauri::App<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    if let Ok(value) = std::env::var("STUDIO_NATIVE_SMOKE_CONFIG") {
        let config: serde_json::Value = serde_json::from_str(&value)?;
        if config.get("restoreOnly").and_then(|v| v.as_bool()) != Some(true) {
            if let Some(path) = config.get("profile").and_then(|v| v.get("localPath")).and_then(|v| v.as_str()) {
                app.fs_scope().allow_directory(path, true)?;
                app.asset_protocol_scope().allow_directory(path, true)?;
            }
        }
    }
    Ok(())
}
