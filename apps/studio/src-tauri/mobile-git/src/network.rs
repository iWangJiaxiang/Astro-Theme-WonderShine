use super::*;
use git2::{
    AutotagOption, Cred, CredentialType, Direction, FetchOptions, PushOptions, RemoteCallbacks,
    RemoteRedirect,
};
use std::{cell::Cell, sync::OnceLock};

const CONNECT: &str = "暂时无法连接 Git 远端，本地文件和提交已保留";
const PUSH: &str = "Git 推送未确认，请重试同步以核对远端；本地提交已保留";
const CLONE: &str = "首次下载 Git 工作区失败，请检查连接；已有文件未被替换";

pub fn initialize() -> Result<()> {
    static INIT: OnceLock<Result<()>> = OnceLock::new();
    *INIT.get_or_init(|| {
        // This is the only native Git consumer. Every entry waits here before using libgit2.
        unsafe {
            git2::opts::set_server_connect_timeout_in_milliseconds(30_000).map_err(|_| CONNECT)?;
            git2::opts::set_server_timeout_in_milliseconds(60_000).map_err(|_| CONNECT)?;
        }
        Ok(())
    })
}
#[cfg(target_os = "android")]
fn android_roots(base: &Path) -> Result<()> {
    use std::{io::Write, sync::Mutex};
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().map_err(|_| CONNECT)?;
    if *ready {
        return Ok(());
    }
    // Android's CA filenames use the legacy OpenSSL subject hash. Load the actual
    // platform PEM roots into the vendored TLS backend, including the Conscrypt APEX.
    let dir = [
        "/apex/com.android.conscrypt/cacerts",
        "/system/etc/security/cacerts",
    ]
    .into_iter()
    .map(Path::new)
    .find(|d| d.is_dir())
    .ok_or(CONNECT)?;
    let mut bundle = tempfile::NamedTempFile::new_in(base).map_err(|_| CONNECT)?;
    for entry in fs::read_dir(dir).map_err(|_| CONNECT)? {
        let bytes = fs::read(entry.map_err(|_| CONNECT)?.path()).map_err(|_| CONNECT)?;
        bundle
            .write_all(&bytes)
            .and_then(|_| bundle.write_all(b"\n"))
            .map_err(|_| CONNECT)?;
    }
    bundle.flush().map_err(|_| CONNECT)?;
    // Mobile commands serialize access to libgit2, including TLS initialization.
    unsafe {
        git2::opts::set_ssl_cert_file(bundle.path()).map_err(|_| CONNECT)?;
    }
    *ready = true;
    Ok(())
}

fn callbacks<'a>(
    p: &'a Profile,
    password: &'a str,
    progress: &'a dyn Fn(&str, usize, usize),
) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    let mut attempted = false;
    callbacks.credentials(move |url, _, kinds| {
        if attempted
            || password.is_empty()
            || !kinds.contains(CredentialType::USER_PASS_PLAINTEXT)
            || Some(
                url::Url::parse(url)
                    .map_err(|_| git2::Error::from_str("URL"))?
                    .origin(),
            ) != url::Url::parse(&p.url).ok().map(|u| u.origin())
        {
            return Err(git2::Error::from_str("Authentication failed"));
        }
        attempted = true;
        Cred::userpass_plaintext(
            if p.username.is_empty() {
                "oauth2"
            } else {
                &p.username
            },
            password,
        )
    });
    callbacks.transfer_progress(move |s| {
        progress("Receiving objects", s.received_objects(), s.total_objects());
        true
    });
    callbacks
}
fn fetch(
    repo: &Repository,
    p: &Profile,
    password: &str,
    branch: &str,
    progress: &dyn Fn(&str, usize, usize),
) -> Result<()> {
    let mut remote = repo.find_remote("origin").map_err(|_| READ)?;
    let mut options = FetchOptions::new();
    options
        .follow_redirects(RemoteRedirect::None)
        .download_tags(AutotagOption::None)
        .remote_callbacks(callbacks(p, password, progress));
    remote
        .fetch(
            &[format!("+refs/heads/{branch}:refs/remotes/origin/{branch}")],
            Some(&mut options),
            None,
        )
        .map_err(|_| CONNECT)
}

pub(super) fn clone_into(
    root: &Path,
    p: &Profile,
    password: &str,
    progress: &dyn Fn(&str, usize, usize),
) -> Result<()> {
    #[cfg(target_os = "android")]
    android_roots(root.parent().ok_or(INVALID)?)?;
    let staging = tempfile::Builder::new()
        .prefix(".clone-")
        .tempdir_in(root.parent().ok_or(INVALID)?)
        .map_err(|_| CLONE)?;
    {
        let repo = Repository::init(staging.path()).map_err(|_| CLONE)?;
        repo.config()
            .and_then(|mut c| c.set_str("http.followRedirects", "false"))
            .map_err(|_| CLONE)?;
        let mut remote = repo.remote("origin", &p.url).map_err(|_| CLONE)?;
        let branch = if p.branch.is_empty() {
            let conn = remote
                .connect_auth(
                    Direction::Fetch,
                    Some(callbacks(p, password, progress)),
                    None,
                )
                .map_err(|_| CLONE)?;
            conn.default_branch()
                .map_err(|_| CLONE)?
                .as_str()
                .and_then(|s| s.strip_prefix("refs/heads/"))
                .ok_or(CLONE)?
                .to_owned()
        } else {
            p.branch.clone()
        };
        if !git2::Reference::is_valid_name(&format!("refs/heads/{branch}")) {
            return Err(CLONE);
        }
        drop(remote);
        fetch(&repo, p, password, &branch, progress).map_err(|_| CLONE)?;
        let commit = repo
            .find_commit(remote_tip(&repo, &branch)?.ok_or(CLONE)?)
            .map_err(|_| CLONE)?;
        repo.branch(&branch, &commit, false).map_err(|_| CLONE)?;
        repo.set_head(&format!("refs/heads/{branch}"))
            .map_err(|_| CLONE)?;
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout
            .force()
            .progress(|_, n, total| progress("Updating workdir", n, total));
        repo.checkout_head(Some(&mut checkout)).map_err(|_| CLONE)?;
    }
    fs::rename(staging.path(), root).map_err(|_| CLONE)?;
    Ok(())
}

pub(super) fn sync(repo: &Repository, p: &Profile, state: &Path, password: &str) -> Result<bool> {
    #[cfg(target_os = "android")]
    android_roots(state)?;
    let no_progress = |_: &str, _: usize, _: usize| {};
    fetch(repo, p, password, &p.branch, &no_progress)?;
    let before = head(repo)?;
    let target = remote_tip(repo, &p.branch)?.ok_or(CONNECT)?;
    let (ahead, behind) = counts(repo, before, Some(target))?;
    if ahead != 0 && behind != 0 {
        return Err("本地与远端都有新提交，请先在 Git 工具中合并；双方提交均已保留");
    }
    if behind != 0 {
        let object = repo.find_commit(target).map_err(|_| READ)?.into_object();
        let mut check = git2::build::CheckoutBuilder::new();
        check.safe().dry_run();
        repo.checkout_tree(&object, Some(&mut check))
            .map_err(|_| CHANGED)?;
        let journal = state.join("sync.json");
        fs::write(
            state.join("sync.json.tmp"),
            json!({"before":before.to_string(),"target":target.to_string()}).to_string(),
        )
        .map_err(|_| WRITE)?;
        fs::rename(state.join("sync.json.tmp"), &journal).map_err(|_| WRITE)?;
        repo.checkout_tree(&object, Some(git2::build::CheckoutBuilder::new().safe()))
            .map_err(|_| RECOVER)?;
        repo.reference_matching(
            &format!("refs/heads/{}", p.branch),
            target,
            true,
            before,
            "Studio fast-forward",
        )
        .map_err(|_| RECOVER)?;
        fs::remove_file(journal).map_err(|_| RECOVER)?;
    }
    if ahead != 0 {
        let rejected = Cell::new(true);
        let mut cb = callbacks(p, password, &no_progress);
        cb.push_update_reference(|_, error| {
            rejected.set(error.is_some());
            Ok(())
        });
        let mut options = PushOptions::new();
        options
            .follow_redirects(RemoteRedirect::None)
            .remote_callbacks(cb);
        let mut remote = repo.find_remote("origin").map_err(|_| READ)?;
        remote
            .push(
                &[format!("refs/heads/{0}:refs/heads/{0}", p.branch)],
                Some(&mut options),
            )
            .map_err(|_| PUSH)?;
        if rejected.get() {
            return Err(PUSH);
        }
    }
    Ok(behind != 0)
}
