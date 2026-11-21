use serde_json::{json, Value};
use std::{
    cell::RefCell,
    sync::Mutex,
    time::{Duration, Instant},
};
use studio_mobile_git::{Job, Profile};
use tauri::{ipc::JavaScriptChannelId, Manager};

#[tauri::command]
pub async fn mobile_git(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    ownership: tauri::State<'_, crate::native_review::ReviewOwnership>,
    profile: Profile,
    job: Job,
    password: Option<String>,
    progress: Option<JavaScriptChannelId>,
) -> Result<Value, Value> {
    if webview.label() != "main" || !ownership.owns_workspace(profile.workspace_id()) {
        return Err("工作区设置无效".into());
    }
    let progress = progress.map(|id| id.channel_on::<_, Value>(webview));
    let base = app.path().app_data_dir().map_err(|_| "工作区设置无效")?;
    tauri::async_runtime::spawn_blocking(move || {
        static GIT: Mutex<()> = Mutex::new(());
        let _operation = GIT.lock().map_err(|_| "操作失败")?;
        studio_mobile_git::initialize()?;
        let last = RefCell::new(None::<(String, Instant, usize)>);
        studio_mobile_git::execute(
            &base,
            &profile,
            job,
            password.as_deref().unwrap_or(""),
            &|phase, n, total| {
                if let Some(channel) = &progress {
                    let mut last = last.borrow_mut();
                    if last.as_ref().is_some_and(|(old, at, previous)| {
                        old == phase
                            && at.elapsed() < Duration::from_millis(100)
                            && (n != total || *previous == n)
                    }) {
                        return;
                    }
                    *last = Some((phase.into(), Instant::now(), n));
                    let _ = channel.send(json!({"phase":phase,"loaded":n,"total":total}));
                }
            },
        )
    })
    .await
    .map_err(|_| "操作失败")?
}
