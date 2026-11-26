use std::{sync::Mutex, time::{Duration, Instant}};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Downloaded(Mutex<Option<(Update, Vec<u8>)>>);

#[tauri::command]
pub async fn download_studio_update(
    app: AppHandle,
    state: State<'_, Downloaded>,
    version: String,
    progress: Channel<(u64, Option<u64>)>,
) -> Result<(), String> {
    let target = semver::Version::parse(&version).map_err(|_| "Invalid Studio version")?;
    if !target.pre.is_empty() || !target.build.is_empty() || target <= app.package_info().version {
        return Err("Invalid Studio version".into());
    }
    let repo = option_env!("VITE_STUDIO_RELEASE_REPOSITORY").unwrap_or("iWangJiaxiang/Astro-Theme-WonderShine");
    let prefix = format!("https://github.com/{repo}/releases/download/studio-v{target}/");
    let endpoint = format!("{prefix}studio-updater.json").parse().map_err(|_| "Invalid Studio release URL")?;
    let updater = app.updater_builder().endpoints(vec![endpoint]).and_then(|b| b.build()).map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?.ok_or("No newer Studio release")?;
    if update.version != version || !update.download_url.as_str().starts_with(&prefix) {
        return Err("Invalid Studio update manifest".into());
    }
    let mut count = 0;
    let mut last = Instant::now();
    let bytes = update.download(|n, total| {
        count += n as u64;
        if last.elapsed() >= Duration::from_millis(200) || total == Some(count) {
            let _ = progress.send((count, total));
            last = Instant::now();
        }
    }, || {}).await.map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|_| "Update cache unavailable")? = Some((update, bytes));
    Ok(())
}

#[tauri::command]
pub async fn install_studio_update(app: AppHandle, state: State<'_, Downloaded>, version: String) -> Result<(), String> {
    let package = {
        let mut cache = state.0.lock().map_err(|_| "Update cache unavailable")?;
        if !cache.as_ref().is_some_and(|(update, _)| update.version == version) {
            return Err("Update is no longer available".into());
        }
        cache.take().ok_or("Update is no longer available")?
    };
    let (package, result) = tauri::async_runtime::spawn_blocking(move || {
        let result = package.0.install(&package.1);
        (package, result)
    }).await.map_err(|e| e.to_string())?;
    if let Err(error) = result {
        *state.0.lock().map_err(|_| "Update cache unavailable")? = Some(package);
        return Err(error.to_string());
    }
    app.restart()
}
