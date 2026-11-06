//! Narrow process ownership only. Review bytes and Git logic remain in TypeScript.
use std::{collections::HashSet, fs::{self, File, OpenOptions}, path::Path, sync::Mutex};
use tauri::Manager;

const UNAVAILABLE: &str = "工作区确认所有权不可用，请完全退出其他 Studio 实例后重启应用";
const RESTART: &str = "创作窗口已重新加载，请完全退出并重启应用后重新确认工作区";
const INVALID: &str = "Invalid native review ownership request";

#[derive(Default)]
pub struct ReviewOwnership(Mutex<Owner>);
#[derive(Default)]
struct Owner {
    // Never unlock on IPC completion/cancellation. Drop only at process shutdown.
    file: Option<File>,
    epoch: Option<String>,
    claimed: HashSet<String>,
}
fn uuid(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() && !b.is_ascii_uppercase() }
    })
}
fn ordinary(path: &Path, directory: bool) -> Result<(), &'static str> {
    let info = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    if info.file_type().is_symlink() || (if directory { !info.is_dir() } else { !info.is_file() }) { return Err(UNAVAILABLE); }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if info.mode() & 0o077 != 0 || (!directory && info.nlink() != 1) { return Err(UNAVAILABLE); }
    }
    Ok(())
}
fn acquire(base: &Path) -> Result<File, &'static str> {
    // AppData is supplied by Tauri, never by JavaScript. Its private child is not
    // in the plugin-fs workspace grant and is never unlinked/replaced by cleanup.
    let info = fs::symlink_metadata(base).map_err(|_| UNAVAILABLE)?;
    if info.file_type().is_symlink() || !info.is_dir() { return Err(UNAVAILABLE); }
    let directory = base.join(".studio-review-owner-v1");
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    match builder.create(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err(UNAVAILABLE),
    }
    ordinary(&directory, true)?;
    let path = directory.join("owner.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            ordinary(&path, false)?;
            OpenOptions::new().read(true).write(true).open(&path).map_err(|_| UNAVAILABLE)?
        },
        Err(_) => return Err(UNAVAILABLE),
    };
    ordinary(&path, false)?;
    let info = file.metadata().map_err(|_| UNAVAILABLE)?;
    if !info.is_file() { return Err(UNAVAILABLE); }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        let named = fs::symlink_metadata(&path).map_err(|_| UNAVAILABLE)?;
        if info.dev() != named.dev() || info.ino() != named.ino() || info.nlink() != 1 || info.mode() & 0o077 != 0 { return Err(UNAVAILABLE); }
    }
    // Unsupported filesystem/target is an error, never a queue-only fallback.
    file.try_lock().map_err(|_| UNAVAILABLE)?;
    Ok(file)
}
impl Owner {
    fn authorize(&mut self, base: &Path, workspace: &str, epoch: &str, claim: bool) -> Result<bool, &'static str> {
        if !uuid(workspace) || !uuid(epoch) { return Err(INVALID); }
        if let Some(current) = &self.epoch { if current != epoch { return Err(RESTART); } }
        if self.file.is_none() { self.file = Some(acquire(base)?); self.epoch = Some(epoch.to_owned()); }
        if claim {
            if self.claimed.len() >= 4096 && !self.claimed.contains(workspace) { return Err(UNAVAILABLE); }
            // Set BEFORE responding; lost responses never grant a second recovery.
            Ok(self.claimed.insert(workspace.to_owned()))
        } else if self.claimed.contains(workspace) { Ok(false) } else { Err(INVALID) }
    }
}

#[tauri::command]
pub fn native_review_owner(
    app: tauri::AppHandle, webview: tauri::Webview,
    ownership: tauri::State<'_, ReviewOwnership>, workspace_id: String, epoch: String, claim_recovery: bool,
) -> Result<bool, &'static str> {
    if webview.label() != "main" { return Err(INVALID); }
    let base = app.path().app_data_dir().map_err(|_| UNAVAILABLE)?;
    let mut owner = ownership.0.lock().map_err(|_| UNAVAILABLE)?;
    owner.authorize(&base, &workspace_id, &epoch, claim_recovery)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("studio-owner-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&path).unwrap(); path
    }
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    const EPOCH: &str = "00000000-0000-4000-8000-000000000002";
    #[test]
    fn command_capability_is_local_main_only_on_desktop_and_mobile() {
        let capability: serde_json::Value = serde_json::from_str(include_str!("../capabilities/native-review.json")).unwrap();
        assert_eq!(capability["local"], true);
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert!(capability.get("windows").is_none());
        assert!(capability.get("remote").is_none());
        assert!(capability.get("platforms").is_none());
        assert_eq!(capability["permissions"], serde_json::json!(["allow-native-review-owner"]));
        assert!(include_str!("../permissions/native-review.toml").contains("commands.allow = [\"native_review_owner\"]"));
    }
    #[test]
    fn recovery_once_and_reload_requires_process_restart() {
        let base = directory();
        let mut owner = Owner::default();
        assert_eq!(owner.authorize(&base, ID, EPOCH, true), Ok(true));
        assert_eq!(owner.authorize(&base, ID, EPOCH, true), Ok(false));
        assert_eq!(owner.authorize(&base, ID, EPOCH, false), Ok(false));
        assert_eq!(owner.authorize(&base, ID, ID, true), Err(RESTART));
        assert_eq!(owner.authorize(&base, EPOCH, ID, true), Err(RESTART));
        assert_eq!(owner.authorize(&base, EPOCH, EPOCH, false), Err(INVALID));
        assert_eq!(owner.authorize(&base, EPOCH, EPOCH, true), Ok(true));
        assert!(acquire(&base).is_err());
        drop(owner);
        let mut restarted = Owner::default();
        assert_eq!(restarted.authorize(&base, ID, ID, true), Ok(true));
        drop(restarted); fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn child_owner_probe() {
        let Ok(base) = std::env::var("STUDIO_OWNER_TEST_PATH") else { return; };
        assert!(acquire(Path::new(&base)).is_ok() == (std::env::var("STUDIO_OWNER_TEST_FREE").unwrap() == "yes"));
    }
    #[test]
    fn invalid_request_never_acquires_or_creates_files() {
        let base = directory();
        let mut owner = Owner::default();
        assert_eq!(owner.authorize(&base, "../state", EPOCH, true), Err(INVALID));
        assert_eq!(owner.authorize(&base, ID, "bad-epoch", true), Err(INVALID));
        assert!(owner.file.is_none());
        assert_eq!(fs::read_dir(&base).unwrap().count(), 0);
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn concurrent_claims_grant_recovery_once() {
        let base = directory();
        let owner = std::sync::Arc::new(ReviewOwnership::default());
        let handles: Vec<_> = (0..8).map(|_| {
            let owner = owner.clone();
            let base = base.clone();
            std::thread::spawn(move || owner.0.lock().unwrap().authorize(&base, ID, EPOCH, true).unwrap())
        }).collect();
        let granted = handles.into_iter().map(|handle| usize::from(handle.join().unwrap())).sum::<usize>();
        assert_eq!(granted, 1);
        assert!(acquire(&base).is_err());
        drop(owner);
        fs::remove_dir_all(base).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlink_owner_file_is_rejected() {
        let base = directory();
        let lock = acquire(&base).unwrap();
        drop(lock);
        let path = base.join(".studio-review-owner-v1/owner.lock");
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(base.join("outside"), path).unwrap();
        assert!(acquire(&base).is_err());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn child_owner_until_process_exit() {
        use std::io::{Read, Write};
        let Ok(base) = std::env::var("STUDIO_OWNER_EXIT_TEST_PATH") else { return; };
        let _held = acquire(Path::new(&base)).unwrap();
        println!("owner-ready");
        std::io::stdout().flush().unwrap();
        let mut signal = [0];
        std::io::stdin().read_exact(&mut signal).unwrap();
        // Deliberately bypass Rust destructors, like abrupt process termination.
        std::process::exit(0);
    }
    #[test]
    fn actual_process_exit_allows_fresh_owner_and_recovery() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        let base = directory();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_review::tests::child_owner_until_process_exit", "--nocapture"])
            .env("STUDIO_OWNER_EXIT_TEST_PATH", &base)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(output.read_line(&mut line).unwrap() > 0, "child exited before owning lock");
            if line.contains("owner-ready") { break; }
        }
        let contended = acquire(&base).is_err();
        child.stdin.take().unwrap().write_all(b"x").unwrap();
        assert!(child.wait().unwrap().success());
        assert!(contended, "another process must not acquire a live owner lock");
        let mut restarted = Owner::default();
        assert_eq!(restarted.authorize(&base, ID, EPOCH, true), Ok(true));
        drop(restarted);
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn process_handoff_releases_os_lock() {
        let base = directory();
        let held = acquire(&base).unwrap();
        let probe = |free: &str| std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_review::tests::child_owner_probe", "--nocapture"])
            .env("STUDIO_OWNER_TEST_PATH", &base).env("STUDIO_OWNER_TEST_FREE", free).status().unwrap();
        assert!(probe("no").success());
        drop(held);
        assert!(probe("yes").success());
        fs::remove_dir_all(base).unwrap();
    }
}
