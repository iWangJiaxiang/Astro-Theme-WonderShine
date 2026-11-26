fn main() {
    tauri_plugin::Builder::new(&["unmetered", "download", "install"])
        .android_path("android")
        .build();
}
