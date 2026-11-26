#[cfg(target_os = "android")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("studio-apk")
        .setup(|_, api| {
            api.register_android_plugin("wang.jiaxiang.studio.updates", "StudioUpdatePlugin")?;
            Ok(())
        })
        .build()
}
