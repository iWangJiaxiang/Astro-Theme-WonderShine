//! Narrow process ownership only. Review bytes and Git logic remain in TypeScript.
use std::{collections::HashSet, fs::{self, File, OpenOptions}, path::Path, sync::Mutex};
use tauri::Manager;

const UNAVAILABLE: &str = "工作区确认所有权不可用，请完全退出其他 Studio 实例后重启应用";
const RESTART: &str = "创作窗口已重新加载，请完全退出并重启应用后重新确认工作区";
const INVALID: &str = "Invalid native review ownership request";

// Test adapters never retain filesystem data or errors, only one fixed classification.
#[cfg(test)]
mod diagnostic {
    use std::{cell::Cell, fs::TryLockError, io::{Error, ErrorKind}};

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Attempt { SameProcessReacquire }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Stage {
        Base, CreateDirectory, Ordinary, Directory, CreateFile, ExistingFile,
        FinalFile, OpenedFile, NamedFile, TryLock,
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Check { Operation, Metadata, Type, Permissions, Identity, Lock }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum IoKind {
        NotFound, PermissionDenied, AlreadyExists, WouldBlock, InvalidInput,
        Unsupported, Interrupted, Other, Unknown,
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum LockKind { WouldBlock, Error(IoKind), Unknown }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Failure { Io(IoKind), Validation, Lock(LockKind) }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) struct Snapshot {
        pub(super) attempt: Attempt,
        pub(super) stage: Stage,
        pub(super) check: Check,
        pub(super) failure: Failure,
    }
    #[derive(Clone, Copy, Default)]
    struct Capture { attempt: Option<Attempt>, snapshot: Option<Snapshot> }
    std::thread_local! {
        static CAPTURE: Cell<Capture> = const { Cell::new(Capture { attempt: None, snapshot: None }) };
    }
    pub(super) fn reset(attempt: Attempt) {
        CAPTURE.with(|slot| slot.set(Capture { attempt: Some(attempt), snapshot: None }));
    }
    pub(super) fn take() -> Option<Snapshot> {
        CAPTURE.with(|slot| slot.replace(Capture::default()).snapshot)
    }
    fn record(stage: Stage, check: Check, failure: Failure) {
        CAPTURE.with(|slot| {
            let mut capture = slot.get();
            if let Some(attempt) = capture.attempt {
                if capture.snapshot.is_none() {
                    capture.snapshot = Some(Snapshot { attempt, stage, check, failure });
                    slot.set(capture);
                }
            }
        });
    }
    fn io_kind(error: &Error) -> IoKind {
        match error.kind() {
            ErrorKind::NotFound => IoKind::NotFound,
            ErrorKind::PermissionDenied => IoKind::PermissionDenied,
            ErrorKind::AlreadyExists => IoKind::AlreadyExists,
            ErrorKind::WouldBlock => IoKind::WouldBlock,
            ErrorKind::InvalidInput => IoKind::InvalidInput,
            ErrorKind::Unsupported => IoKind::Unsupported,
            ErrorKind::Interrupted => IoKind::Interrupted,
            ErrorKind::Other => IoKind::Other,
            _ => IoKind::Unknown,
        }
    }
    pub(super) fn io(stage: Stage, check: Check, error: &Error) {
        record(stage, check, Failure::Io(io_kind(error)));
    }
    pub(super) fn validation(stage: Stage, check: Check) {
        record(stage, check, Failure::Validation);
    }
    #[allow(unreachable_patterns)]
    pub(super) fn lock(error: &TryLockError) {
        let kind = match error {
            TryLockError::WouldBlock => LockKind::WouldBlock,
            TryLockError::Error(error) => LockKind::Error(io_kind(error)),
            _ => LockKind::Unknown,
        };
        record(Stage::TryLock, Check::Lock, Failure::Lock(kind));
    }
    // Only label an ordinary() failure after it returns; do not repeat its checks.
    pub(super) fn annotate(stage: Stage) {
        CAPTURE.with(|slot| {
            let mut capture = slot.get();
            if let Some(snapshot) = &mut capture.snapshot {
                if snapshot.stage == Stage::Ordinary {
                    snapshot.stage = stage;
                    slot.set(capture);
                }
            }
        });
    }
}

// Non-test expansions keep the original maps/conditions without observer calls.
#[cfg(test)]
macro_rules! owner_io {
    ($result:expr, $stage:ident, $check:ident) => {
        ($result).map_err(|error| {
            diagnostic::io(diagnostic::Stage::$stage, diagnostic::Check::$check, &error);
            UNAVAILABLE
        })
    };
}
#[cfg(not(test))]
macro_rules! owner_io {
    ($result:expr, $stage:ident, $check:ident) => { ($result).map_err(|_| UNAVAILABLE) };
}
#[cfg(test)]
macro_rules! owner_io_return {
    ($error:expr, $stage:ident) => {{
        diagnostic::io(diagnostic::Stage::$stage, diagnostic::Check::Operation, &$error);
        return Err(UNAVAILABLE);
    }};
}
#[cfg(not(test))]
macro_rules! owner_io_return {
    ($error:expr, $stage:ident) => { return Err(UNAVAILABLE) };
}
#[cfg(test)]
macro_rules! owner_reject {
    ($condition:expr, $stage:ident, $check:ident) => {
        if $condition {
            diagnostic::validation(diagnostic::Stage::$stage, diagnostic::Check::$check);
            return Err(UNAVAILABLE);
        }
    };
}
#[cfg(not(test))]
macro_rules! owner_reject {
    ($condition:expr, $stage:ident, $check:ident) => {
        if $condition { return Err(UNAVAILABLE); }
    };
}
#[cfg(test)]
macro_rules! owner_ordinary {
    ($result:expr, $stage:ident) => {
        ($result).inspect_err(|_| diagnostic::annotate(diagnostic::Stage::$stage))
    };
}
#[cfg(not(test))]
macro_rules! owner_ordinary {
    ($result:expr, $stage:ident) => { $result };
}
#[cfg(test)]
macro_rules! owner_lock {
    ($result:expr) => {
        ($result).map_err(|error| { diagnostic::lock(&error); UNAVAILABLE })
    };
}
#[cfg(not(test))]
macro_rules! owner_lock {
    ($result:expr) => { ($result).map_err(|_| UNAVAILABLE) };
}

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
    let info = owner_io!(fs::symlink_metadata(path), Ordinary, Metadata)?;
    owner_reject!(info.file_type().is_symlink() || (if directory { !info.is_dir() } else { !info.is_file() }), Ordinary, Type);
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        owner_reject!(info.mode() & 0o077 != 0 || (!directory && info.nlink() != 1), Ordinary, Permissions);
    }
    Ok(())
}
fn acquire(base: &Path) -> Result<File, &'static str> {
    // AppData is supplied by Tauri, never by JavaScript. Its private child is not
    // in the plugin-fs workspace grant and is never unlinked/replaced by cleanup.
    let info = owner_io!(fs::symlink_metadata(base), Base, Metadata)?;
    owner_reject!(info.file_type().is_symlink() || !info.is_dir(), Base, Type);
    let directory = base.join(".studio-review-owner-v1");
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    match builder.create(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_error) => owner_io_return!(_error, CreateDirectory),
    }
    owner_ordinary!(ordinary(&directory, true), Directory)?;
    let path = directory.join("owner.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            owner_ordinary!(ordinary(&path, false), ExistingFile)?;
            owner_io!(OpenOptions::new().read(true).write(true).open(&path), ExistingFile, Operation)?
        },
        Err(_error) => owner_io_return!(_error, CreateFile),
    };
    owner_ordinary!(ordinary(&path, false), FinalFile)?;
    let info = owner_io!(file.metadata(), OpenedFile, Metadata)?;
    owner_reject!(!info.is_file(), OpenedFile, Type);
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        let named = owner_io!(fs::symlink_metadata(&path), NamedFile, Metadata)?;
        owner_reject!(info.dev() != named.dev() || info.ino() != named.ino() || info.nlink() != 1 || info.mode() & 0o077 != 0, OpenedFile, Identity);
    }
    // Unsupported filesystem/target is an error, never a queue-only fallback.
    owner_lock!(file.try_lock())?;
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

    // Synthetic adapters only: these do not exercise filesystem/security branches.
    fn validation_adapter(reject: bool) -> Result<(), &'static str> {
        owner_reject!(reject, Ordinary, Type);
        Ok(())
    }
    fn io_return_adapter(error: std::io::Error) -> Result<(), &'static str> {
        owner_io_return!(error, CreateDirectory)
    }
    fn expected_snapshot(stage: diagnostic::Stage, check: diagnostic::Check, failure: diagnostic::Failure) -> Option<diagnostic::Snapshot> {
        Some(diagnostic::Snapshot { attempt: diagnostic::Attempt::SameProcessReacquire, stage, check, failure })
    }
    #[test]
    fn diagnostic_io_adapters_keep_fixed_mapping_and_return() {
        use diagnostic::{Attempt, Check, Failure, IoKind, Stage};
        use std::io::{Error, ErrorKind};
        for (kind, expected) in [
            (ErrorKind::NotFound, IoKind::NotFound),
            (ErrorKind::PermissionDenied, IoKind::PermissionDenied),
            (ErrorKind::AlreadyExists, IoKind::AlreadyExists),
            (ErrorKind::WouldBlock, IoKind::WouldBlock),
            (ErrorKind::InvalidInput, IoKind::InvalidInput),
            (ErrorKind::Unsupported, IoKind::Unsupported),
            (ErrorKind::Interrupted, IoKind::Interrupted),
            (ErrorKind::Other, IoKind::Other),
            (ErrorKind::TimedOut, IoKind::Unknown),
        ] {
            diagnostic::reset(Attempt::SameProcessReacquire);
            let result: Result<(), &'static str> = owner_io!(Err::<(), _>(Error::from(kind)), Base, Metadata);
            let snapshot = diagnostic::take();
            assert_eq!(result, Err(UNAVAILABLE), "{snapshot:?}");
            assert_eq!(snapshot, expected_snapshot(Stage::Base, Check::Metadata, Failure::Io(expected)));
        }
        diagnostic::reset(Attempt::SameProcessReacquire);
        let result = io_return_adapter(Error::from(ErrorKind::PermissionDenied));
        let snapshot = diagnostic::take();
        assert_eq!(result, Err(UNAVAILABLE), "{snapshot:?}");
        assert_eq!(snapshot, expected_snapshot(Stage::CreateDirectory, Check::Operation, Failure::Io(IoKind::PermissionDenied)));
    }
    #[test]
    fn diagnostic_lock_adapter_distinguishes_would_block_variants() {
        use diagnostic::{Attempt, Check, Failure, IoKind, LockKind, Stage};
        use std::{fs::TryLockError, io::{Error, ErrorKind}};
        for (error, expected) in [
            (TryLockError::WouldBlock, LockKind::WouldBlock),
            (TryLockError::Error(Error::from(ErrorKind::WouldBlock)), LockKind::Error(IoKind::WouldBlock)),
            (TryLockError::Error(Error::from(ErrorKind::PermissionDenied)), LockKind::Error(IoKind::PermissionDenied)),
            (TryLockError::Error(Error::from(ErrorKind::TimedOut)), LockKind::Error(IoKind::Unknown)),
        ] {
            diagnostic::reset(Attempt::SameProcessReacquire);
            let result: Result<(), &'static str> = owner_lock!(Err::<(), _>(error));
            let snapshot = diagnostic::take();
            assert_eq!(result, Err(UNAVAILABLE), "{snapshot:?}");
            assert_eq!(snapshot, expected_snapshot(Stage::TryLock, Check::Lock, Failure::Lock(expected)));
        }
    }
    #[test]
    fn diagnostic_validation_annotation_keeps_first_failure_and_check() {
        use diagnostic::{Attempt, Check, Failure, IoKind, Stage};
        diagnostic::reset(Attempt::SameProcessReacquire);
        let result = owner_ordinary!(validation_adapter(true), ExistingFile);
        let later: Result<(), &'static str> = owner_io!(Err::<(), _>(std::io::Error::from(std::io::ErrorKind::NotFound)), Base, Metadata);
        let snapshot = diagnostic::take();
        assert_eq!(result, Err(UNAVAILABLE), "{snapshot:?}");
        assert_eq!(later, Err(UNAVAILABLE), "{snapshot:?}");
        assert_eq!(snapshot, expected_snapshot(Stage::ExistingFile, Check::Type, Failure::Validation));

        diagnostic::reset(Attempt::SameProcessReacquire);
        let result: Result<(), &'static str> = owner_ordinary!(owner_io!(Err::<(), _>(std::io::Error::from(std::io::ErrorKind::NotFound)), Ordinary, Metadata), Directory);
        let snapshot = diagnostic::take();
        assert_eq!(result, Err(UNAVAILABLE), "{snapshot:?}");
        assert_eq!(snapshot, expected_snapshot(Stage::Directory, Check::Metadata, Failure::Io(IoKind::NotFound)));
    }
    #[test]
    fn diagnostic_reset_take_disarm_and_thread_isolation() {
        use diagnostic::{Attempt, Check, Failure, IoKind, Stage};
        assert_eq!(diagnostic::take(), None);
        assert_eq!(validation_adapter(true), Err(UNAVAILABLE));
        assert_eq!(diagnostic::take(), None);
        diagnostic::reset(Attempt::SameProcessReacquire);
        assert_eq!(validation_adapter(true), Err(UNAVAILABLE));
        diagnostic::reset(Attempt::SameProcessReacquire);
        assert_eq!(validation_adapter(false), Ok(()));
        assert_eq!(diagnostic::take(), None);
        assert_eq!(validation_adapter(true), Err(UNAVAILABLE));
        assert_eq!(diagnostic::take(), None);

        diagnostic::reset(Attempt::SameProcessReacquire);
        assert_eq!(validation_adapter(true), Err(UNAVAILABLE));
        let handles = [
            (std::io::ErrorKind::NotFound, IoKind::NotFound),
            (std::io::ErrorKind::PermissionDenied, IoKind::PermissionDenied),
        ].map(|(kind, expected)| std::thread::spawn(move || {
            assert_eq!(diagnostic::take(), None);
            assert_eq!(validation_adapter(true), Err(UNAVAILABLE));
            assert_eq!(diagnostic::take(), None);
            diagnostic::reset(Attempt::SameProcessReacquire);
            let result: Result<(), &'static str> = owner_io!(Err::<(), _>(std::io::Error::from(kind)), Base, Metadata);
            let snapshot = diagnostic::take();
            assert_eq!(result, Err(UNAVAILABLE), "{snapshot:?}");
            assert_eq!(snapshot, expected_snapshot(Stage::Base, Check::Metadata, Failure::Io(expected)));
            assert_eq!(validation_adapter(true), Err(UNAVAILABLE));
            assert_eq!(diagnostic::take(), None);
        }));
        let joined = handles.map(|handle| handle.join().is_ok());
        assert_eq!(joined, [true, true]);
        assert_eq!(diagnostic::take(), expected_snapshot(Stage::Ordinary, Check::Type, Failure::Validation));
        assert_eq!(validation_adapter(true), Err(UNAVAILABLE));
        assert_eq!(diagnostic::take(), None);
    }
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
        diagnostic::reset(diagnostic::Attempt::SameProcessReacquire);
        let result = restarted.authorize(&base, ID, ID, true);
        let snapshot = diagnostic::take();
        // None is honest: authorize guards are outside the acquire adapters.
        assert_eq!(result, Ok(true), "{snapshot:?}");
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
