use super::*;
use git2::{
    AutotagOption, Cred, CredentialType, Direction, FetchOptions, PushOptions, RemoteCallbacks,
    RemoteRedirect,
};
use std::{cell::Cell, sync::OnceLock};

const CONNECT: &str = "暂时无法连接 Git 远端，本地文件和提交已保留";
const AUTH: &str = "Git 远端认证失败，请检查当前会话的访问令牌和仓库权限";
const CERT: &str = "Git 远端证书验证失败，请检查仓库地址和设备信任设置";
const REJECTED: &str = "Git 远端拒绝了推送，请检查分支保护规则和写入权限；本地提交已保留";
const MERGE: &str = "无法自动合并，请在 Git 工具中处理；双方提交均已保留";
const PUSH: &str = "Git 推送未确认，请重试同步以核对远端；本地提交已保留";
const CLONE: &str = "首次下载 Git 工作区失败，请检查连接；已有文件未被替换";
const UNSHALLOW: i32 = i32::MAX;

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
            return Err(git2::Error::new(
                git2::ErrorCode::Auth,
                git2::ErrorClass::Callback,
                "Authentication failed",
            ));
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

fn network_error(stage: &str, error: git2::Error, fallback: &'static str) -> Value {
    let message = match error.code() {
        git2::ErrorCode::Auth => AUTH,
        git2::ErrorCode::Certificate => CERT,
        _ => fallback,
    };
    // Error messages from transports can contain URLs or credentials. Export only libgit2 enums.
    json!({"message": message, "gitDetail": format!("libgit2 {} {:?}/{:?}", stage, error.class(), error.code())})
}

fn fetch_options<'a>(
    p: &'a Profile,
    password: &'a str,
    progress: &'a dyn Fn(&str, usize, usize),
    depth: i32,
) -> FetchOptions<'a> {
    let mut options = FetchOptions::new();
    options
        .depth(depth)
        .follow_redirects(RemoteRedirect::None)
        .download_tags(AutotagOption::None)
        .remote_callbacks(callbacks(p, password, progress));
    options
}

fn fetch(
    repo: &Repository,
    p: &Profile,
    password: &str,
    branch: &str,
    depth: i32,
    progress: &dyn Fn(&str, usize, usize),
    fallback: &'static str,
) -> std::result::Result<(), Value> {
    let mut remote = repo.find_remote("origin").map_err(|_| READ)?;
    let mut options = fetch_options(p, password, progress, depth);
    remote
        .fetch(
            &[format!("+refs/heads/{branch}:refs/remotes/origin/{branch}")],
            Some(&mut options),
            None,
        )
        .map_err(|error| network_error("fetch", error, fallback))
}

fn submodules(
    repo: &Repository,
    p: &Profile,
    password: &str,
    progress: &dyn Fn(&str, usize, usize),
) -> std::result::Result<(), Value> {
    let root = repo.workdir().ok_or(CLONE)?;
    match fs::symlink_metadata(root.join(".gitmodules")) {
        Ok(info) if info.is_file() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        _ => return Err(CLONE.into()),
    }
    let origin = url::Url::parse(&p.url).map_err(|_| CLONE)?;
    for module in repo.submodules().map_err(|_| CLONE)? {
        let Some(pin) = module.index_id() else { continue };
        let path = module.path().to_str().ok_or(CLONE)?;
        let mut target = root.to_owned();
        for part in path.split('/') {
            let lower = part.to_ascii_lowercase();
            if part.is_empty()
                || part.ends_with(['.', ' '])
                || part.contains(['\\', ':'])
                || part.chars().any(char::is_control)
                || lower.eq(".git")
                || lower.starts_with("git~")
                || lower.starts_with(".git~")
            {
                return Err(CLONE.into());
            }
            target.push(part);
            match fs::symlink_metadata(&target) {
                Ok(info) if info.is_dir() => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&target).map_err(|_| CLONE)?;
                }
                _ => return Err(CLONE.into()),
            }
        }
        if fs::read_dir(&target).map_err(|_| CLONE)?.next().is_some() {
            return Err(CLONE.into());
        }
        let address = module.url().ok_or(CLONE)?;
        let url = if address.starts_with("./") || address.starts_with("../") {
            let base = format!("{}/", origin.as_str().trim_end_matches('/'));
            url::Url::parse(&base).and_then(|base| base.join(address))
        } else {
            url::Url::parse(address)
        }
        .map_err(|_| CLONE)?;
        validate_remote(&url)?;
        let child = Repository::init(&target).map_err(|_| CLONE)?;
        let mut remote = child.remote("origin", url.as_str()).map_err(|_| CLONE)?;
        let mut shallow = fetch_options(p, password, progress, 1);
        // Older pinned commits may require fetching the advertised branch or tag that contains them.
        if remote.fetch(&[format!("{pin}:refs/studio/pinned")], Some(&mut shallow), None).is_err()
            || child.find_commit(pin).is_err()
        {
            let depth = if child.is_shallow() { UNSHALLOW } else { 0 };
            let mut options = fetch_options(p, password, progress, depth);
            options.download_tags(AutotagOption::All);
            remote.fetch(&["+refs/heads/*:refs/remotes/origin/*"], Some(&mut options), None)
                .map_err(|error| network_error("fetch", error, CLONE))?;
        }
        child.set_head_detached(pin).map_err(|_| CLONE)?;
        child.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .map_err(|_| CLONE)?;
    }
    Ok(())
}

pub(super) fn clone_into(
    root: &Path,
    p: &Profile,
    password: &str,
    progress: &dyn Fn(&str, usize, usize),
    include_submodules: bool,
) -> std::result::Result<(), Value> {
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
                .map_err(|error| network_error("fetch", error, CLONE))?;
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
            return Err(CLONE.into());
        }
        drop(remote);
        fetch(&repo, p, password, &branch, 1, progress, CLONE)?;
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
        if include_submodules {
            submodules(&repo, p, password, progress)?;
        }
    }
    fs::rename(staging.path(), root).map_err(|_| CLONE)?;
    Ok(())
}

pub(super) fn fetch_current(repo: &Repository, p: &Profile, state: &Path, password: &str, syncing: bool) -> std::result::Result<(), Value> {
    #[cfg(target_os = "android")]
    android_roots(state)?;
    let no_progress = |_: &str, _: usize, _: usize| {};
    if !repo.is_shallow() {
        return fetch(repo, p, password, &p.branch, 0, &no_progress, CONNECT);
    }
    let tip = remote_tip(repo, &p.branch)?;
    let mut remote = repo.find_remote("origin").map_err(|_| READ)?;
    let mut connection = remote
        .connect_auth(Direction::Fetch, Some(callbacks(p, password, &no_progress)), None)
        .map_err(|error| network_error("fetch", error, CONNECT))?;
    let name = format!("refs/heads/{}", p.branch);
    let advertised = connection.list().map_err(|_| CONNECT)?.iter()
        .find(|entry| entry.name() == name)
        .map(|entry| entry.oid())
        .ok_or("远端分支不存在，本地文件和提交已保留")?;
    drop(connection);
    if Some(advertised) == tip && (!syncing || head(repo)? == advertised) {
        return Ok(());
    }
    // Keep the last known remote tip until we have a complete history to compare.
    let pending = "refs/studio/fetched";
    match repo.find_reference(pending) {
        Ok(mut old) => old.delete().map_err(|_| WRITE)?,
        Err(error) if error.code() == git2::ErrorCode::NotFound => (),
        Err(_) => return Err(READ.into()),
    }
    let mut options = fetch_options(p, password, &no_progress, UNSHALLOW);
    remote
        .fetch(&[format!("+{name}:{pending}")], Some(&mut options), None)
        .map_err(|error| network_error("fetch", error, CONNECT))?;
    let mut fetched = repo.find_reference(pending).map_err(|_| CONNECT)?;
    let target = fetched.target().ok_or(CONNECT)?;
    fetched.delete().map_err(|_| WRITE)?;
    if repo.is_shallow() {
        return Err("远端未提供所需的 Git 历史，本地文件和提交已保留".into());
    }
    repo.reference(&format!("refs/remotes/origin/{}", p.branch), target, true, "Studio fetch")
        .map_err(|_| WRITE)?;
    Ok(())
}

pub(super) fn sync(repo: &Repository, p: &Profile, state: &Path, password: &str) -> std::result::Result<bool, Value> {
    let no_progress = |_: &str, _: usize, _: usize| {};
    fetch_current(repo, p, state, password, true)?;
    let before = head(repo)?;
    let target = remote_tip(repo, &p.branch)?.ok_or(CONNECT)?;
    let (ahead, behind) = counts(repo, before, Some(target))?;
    if behind != 0 {
        let target = if ahead != 0 {
            // Compute the merge off-branch. Conflicts never reach the real index or worktree.
            repo.merge_base(before, target).map_err(|_| MERGE)?;
            let ours = repo.find_commit(before).map_err(|_| READ)?;
            let theirs = repo.find_commit(target).map_err(|_| READ)?;
            let mut index = repo
                .merge_commits(&ours, &theirs, None)
                .map_err(|_| MERGE)?;
            if index.has_conflicts() {
                return Err(MERGE.into());
            }
            let tree_id = index.write_tree_to(repo).map_err(|_| WRITE)?;
            let tree = repo.find_tree(tree_id).map_err(|_| READ)?;
            let author = signature(p)?;
            repo.commit(
                None,
                &author,
                &author,
                "Merge remote workspace changes",
                &tree,
                &[&ours, &theirs],
            )
            .map_err(|_| WRITE)?
        } else {
            target
        };
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
            "Studio sync",
        )
        .map_err(|_| RECOVER)?;
        fs::remove_file(journal).map_err(|_| RECOVER)?;
    }
    if ahead != 0 {
        let accepted = Cell::new(None);
        let mut cb = callbacks(p, password, &no_progress);
        cb.push_update_reference(|_, error| {
            accepted.set(Some(error.is_none()));
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
            .map_err(|error| network_error("push", error, PUSH))?;
        match accepted.get() {
            Some(true) => (),
            Some(false) => return Err(REJECTED.into()),
            None => return Err(PUSH.into()),
        }
    }
    Ok(behind != 0)
}
