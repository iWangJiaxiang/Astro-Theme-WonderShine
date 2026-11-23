//! Git for private mobile checkouts. All operations open the repository on the calling worker.
mod network;
mod snapshot;
use git2::{Oid, Repository, RepositoryState, Signature, Status, StatusOptions};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

pub use network::initialize;
pub type Result<T> = std::result::Result<T, &'static str>;
const INVALID: &str = "工作区设置无效";
const CHANGED: &str = "工作区已变化，请刷新并重新确认提交范围";
const READ: &str = "无法读取 Git 工作区";
const WRITE: &str = "无法保存 Git 修改";
const RECOVER: &str = "上次同步中断，请先检查 Git 工作区并完成恢复；现有内容已保留";
const BUSY: &str = "Git 操作尚未完成，请先在 Git 工具中完成合并、变基或其他操作";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    id: String,
    url: String,
    branch: String,
    username: String,
    author_name: String,
    author_email: String,
}
impl Profile {
    pub fn workspace_id(&self) -> &str {
        &self.id
    }
}
#[derive(Deserialize)]
pub struct ThemeBlobs {
    path: String,
    before: Option<String>,
    after: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Job {
    Open {
        clone: bool,
    },
    Guard,
    CheckRemote,
    Inspect {
        paths: Option<Vec<String>>,
        writable: bool,
    },
    Commit {
        head: String,
        paths: Vec<String>,
        message: String,
        theme: Option<Vec<ThemeBlobs>>,
    },
    ReviewDiscard,
    Discard {
        head: String,
        paths: Vec<String>,
    },
    Publish {
        head: String,
        paths: Vec<String>,
        message: String,
    },
    Sync {
        head: String,
    },
    Branch {
        key: String,
        files: Vec<snapshot::Input>,
    },
}
fn internal(path: &str) -> bool {
    matches!(
        path.split('/').next(),
        Some(".studio-history" | ".studio-write-lock")
    )
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', '%'])
        && !path.bytes().any(|b| b < 32 || b == 127)
        && path
            .split('/')
            .all(|p| !p.is_empty() && !p.starts_with('.'))
}
fn managed(path: &str) -> bool {
    static TEXT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r"^(package(-lock)?\.json|config\.toml|data(\.[A-Za-z0-9-]+)?\.toml|public/data/friends(\.[A-Za-z0-9-]+)?\.json|content/(articles|pages|collections|threads|topics)/.+\.md|content/_index(\.[A-Za-z0-9-]+)?\.md)$").unwrap()
    });
    relative(path)
        && ((path.encode_utf16().count() <= 500 && TEXT.is_match(path))
            || (path.encode_utf16().count() <= 1000
                && !path.contains(['?', '#'])
                && (path.starts_with("content/") || path.starts_with("public/"))
                && path.rsplit_once('.').is_some_and(|(_, ext)| {
                    matches!(
                        ext.to_ascii_lowercase().as_str(),
                        "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif" | "svg" | "ico" | "bmp"
                    )
                })))
}
fn checked_file(root: &Path, path: &str) -> Result<PathBuf> {
    if !managed(path) {
        return Err(INVALID);
    }
    let mut current = root.to_owned();
    for component in path.split('/') {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(info) if info.is_symlink() => return Err("工作区不允许读写符号链接"),
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(READ),
            _ => (),
        }
    }
    Ok(current)
}
fn directory(path: &Path) -> Result<()> {
    if !fs::symlink_metadata(path).map_err(|_| READ)?.is_dir() {
        return Err(INVALID);
    }
    Ok(())
}
fn signature(p: &Profile) -> Result<Signature<'static>> {
    if p.author_name.trim().is_empty() || p.author_email.trim().is_empty() {
        return Err(INVALID);
    }
    Signature::now(&p.author_name, &p.author_email).map_err(|_| INVALID)
}
fn guard(repo: &Repository, state: &Path) -> Result<()> {
    if state.join("sync.json").try_exists().map_err(|_| READ)? {
        return Err(RECOVER);
    }
    if repo.state() != RepositoryState::Clean
        || repo
            .path()
            .join("index.lock")
            .try_exists()
            .map_err(|_| READ)?
        || repo
            .path()
            .join("BISECT_LOG")
            .try_exists()
            .map_err(|_| READ)?
    {
        return Err(BUSY);
    }
    Ok(())
}
fn head(repo: &Repository) -> Result<Oid> {
    repo.head()
        .and_then(|r| r.peel_to_commit())
        .map(|c| c.id())
        .map_err(|_| READ)
}
fn remote_tip(repo: &Repository, branch: &str) -> Result<Option<Oid>> {
    match repo.refname_to_id(&format!("refs/remotes/origin/{branch}")) {
        Ok(oid) => Ok(Some(oid)),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(_) => Err(READ),
    }
}
fn counts(repo: &Repository, head: Oid, remote: Option<Oid>) -> Result<(usize, usize)> {
    if let Some(remote) = remote {
        return repo.graph_ahead_behind(head, remote).map_err(|_| READ);
    }
    let mut walk = repo.revwalk().map_err(|_| READ)?;
    walk.push(head).map_err(|_| READ)?;
    walk.try_fold((0, 0), |(count, _), oid| {
        oid.map(|_| (count + 1, 0)).map_err(|_| READ)
    })
}
fn changes(repo: &Repository, paths: Option<&[String]>, discard: bool) -> Result<Vec<Value>> {
    if paths == Some(&[]) {
        return Ok(Vec::new());
    }
    repo.add_ignore_rule("/.studio-history/\n/.studio-write-lock/")
        .map_err(|_| READ)?;
    let mut opts = StatusOptions::new();
    opts.exclude_submodules(discard)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .disable_pathspec_match(true)
        .renames_head_to_index(false)
        .renames_index_to_workdir(false)
        .include_unreadable(true);
    if let Some(paths) = paths {
        for path in paths {
            opts.pathspec(path.as_str());
        }
    }
    let mut rows = Vec::new();
    for entry in repo.statuses(Some(&mut opts)).map_err(|_| READ)?.iter() {
        let path = entry.path().ok_or(READ)?;
        if internal(path) {
            continue;
        }
        if discard && [entry.head_to_index(), entry.index_to_workdir()].into_iter().flatten().any(|delta| {
            delta.old_file().mode() == git2::FileMode::Commit || delta.new_file().mode() == git2::FileMode::Commit
        }) {
            continue;
        }
        let s = entry.status();
        if s.is_conflicted() || s.contains(Status::WT_UNREADABLE) {
            return Err(BUSY);
        }
        // Preserve the three review columns (HEAD / working file / index). Exact
        // working bytes are additionally verified by the private review store.
        let h = if s.intersects(Status::INDEX_NEW | Status::WT_NEW) && !s.is_index_deleted() {
            0
        } else {
            1
        };
        let i = if s.is_index_deleted() {
            0
        } else if s
            .intersects(Status::INDEX_NEW | Status::INDEX_MODIFIED | Status::INDEX_TYPECHANGE)
        {
            2
        } else {
            h
        };
        let w = if s.is_wt_deleted() {
            0
        } else if s.intersects(Status::WT_NEW | Status::WT_MODIFIED | Status::WT_TYPECHANGE) {
            3
        } else {
            i
        };
        rows.push(json!([path, h, w, i]));
    }
    Ok(rows)
}
fn inspect(repo: &Repository, branch: &str, paths: Option<&[String]>, discard: bool) -> Result<Value> {
    let local = head(repo)?;
    let remote = remote_tip(repo, branch)?;
    let (ahead, behind) = counts(repo, local, remote)?;
    Ok(
        json!({"head":local.to_string(),"remoteHead":remote.map(|o|o.to_string()),"ahead":ahead,"behind":behind,
        "rows":changes(repo, paths, discard)?}),
    )
}
fn commit(
    repo: &Repository,
    root: &Path,
    p: &Profile,
    expected: &str,
    paths: &[String],
    message: &str,
    theme: Option<&[ThemeBlobs]>,
) -> Result<Oid> {
    if paths.is_empty()
        || message.trim().is_empty()
        || message.len() > 2000
        || message
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))
    {
        return Err(INVALID);
    }
    let parent = repo
        .head()
        .and_then(|r| r.peel_to_commit())
        .map_err(|_| READ)?;
    if parent.id().to_string() != expected {
        return Err(CHANGED);
    }
    let tree = parent.tree().map_err(|_| READ)?;
    if let Some(files) = theme {
        if paths.len() != files.len() { return Err(INVALID); }
        for (path, file) in paths.iter().zip(files) {
            if path != &file.path || !matches!(path.as_str(), "config.toml" | "package.json" | "package-lock.json") {
                return Err(INVALID);
            }
            let before = tree.get_name(path).map(|entry| entry.id().to_string());
            if before != file.before { return Err(CHANGED); }
        }
    }
    let mut index = repo.index().map_err(|_| READ)?;
    if index.has_conflicts() {
        return Err(BUSY);
    }
    if index
        .iter()
        .any(|e| std::str::from_utf8(&e.path).map_or(true, internal))
    {
        return Err("Git 暂存区包含创作中心备份文件，请先在 Git 工具中处理");
    }
    let approved: std::collections::HashSet<&str> = paths.iter().map(String::as_str).collect();
    let diff = repo
        .diff_tree_to_index(Some(&tree), Some(&index), None)
        .map_err(|_| READ)?;
    for delta in diff.deltas() {
        let path = delta.new_file().path().and_then(Path::to_str).ok_or(READ)?;
        if theme.is_some() || !approved.contains(path) {
            return Err("暂存区含有创作中心以外的文件，请先在 Git 工具中处理");
        }
    }
    let author = signature(p)?;
    for path in paths {
        let file = checked_file(root, path)?;
        if file.try_exists().map_err(|_| READ)? {
            if !file.is_file() {
                return Err(INVALID);
            }
            index.add_path(Path::new(path)).map_err(|_| WRITE)?;
        } else if index.get_path(Path::new(path), 0).is_some() {
            index.remove_path(Path::new(path)).map_err(|_| WRITE)?;
        }
    }
    if let Some(files) = theme {
        for file in files {
            let after = index.get_path(Path::new(&file.path), 0).ok_or(CHANGED)?.id;
            if Oid::from_str(&file.after).ok() != Some(after) { return Err(CHANGED); }
        }
    }
    let id = index.write_tree().map_err(|_| WRITE)?;
    let next = repo.find_tree(id).map_err(|_| READ)?;
    index.write().map_err(|_| WRITE)?;
    repo.commit(
        Some("HEAD"),
        &author,
        &author,
        message.trim(),
        &next,
        &[&parent],
    )
    .map_err(|_| WRITE)
}

pub fn execute(
    base: &Path,
    p: &Profile,
    job: Job,
    password: &str,
    progress: &dyn Fn(&str, usize, usize),
) -> std::result::Result<Value, Value> {
    if !p.id.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) {
            b == b'-'
        } else {
            b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
        }
    }) || p.id.len() != 36
    {
        return Err(INVALID.into());
    }
    let url = url::Url::parse(&p.url).map_err(|_| INVALID)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host().is_none()
        || url.path() == "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(INVALID.into());
    }
    if !p.branch.is_empty()
        && (!git2::Reference::is_valid_name(&format!("refs/heads/{}", p.branch))
            || p.branch.starts_with('-'))
    {
        return Err(INVALID.into());
    }
    let workspace = base.join("workspaces").join(&p.id);
    let root = workspace.join("repo");
    let state = workspace.join("state");
    for dir in [base, &base.join("workspaces"), &workspace, &state] {
        directory(dir)?;
    }
    if matches!(job, Job::Open { clone: true })
        && !root.join(".git").try_exists().map_err(|_| READ)?
    {
        if root.try_exists().map_err(|_| READ)? {
            directory(&root)?;
            if fs::read_dir(&root).map_err(|_| READ)?.next().is_some() {
                return Err("工作区目录已有文件，请选择空目录或匹配的 Git 仓库".into());
            }
        }
        network::clone_into(&root, p, password, progress)?;
    }
    directory(&root)?;
    directory(&root.join(".git"))?;
    let repo = Repository::open_ext(
        &root,
        git2::RepositoryOpenFlags::NO_SEARCH,
        std::iter::empty::<&Path>(),
    )
    .map_err(|_| READ)?;
    if repo.is_bare()
        || repo.is_shallow()
        || repo.is_worktree()
        || repo.workdir().and_then(|dir| dir.canonicalize().ok())
            != Some(root.canonicalize().map_err(|_| READ)?)
    {
        return Err(INVALID.into());
    }
    let remote = repo.find_remote("origin").map_err(|_| READ)?;
    if remote.url() != Some(&p.url) || remote.pushurl().is_some_and(|u| u != p.url) {
        return Err(INVALID.into());
    }
    let head_ref = repo.head().map_err(|_| READ)?;
    let branch = head_ref
        .shorthand()
        .filter(|_| head_ref.is_branch())
        .ok_or(INVALID)?;
    if branch != p.branch && !(p.branch.is_empty() && matches!(job, Job::Open { .. })) {
        return Err(INVALID.into());
    }
    if !matches!(
        job,
        Job::Open { .. }
            | Job::Inspect {
                writable: false,
                ..
            }
    ) {
        guard(&repo, &state)?;
    }
    match job {
        Job::Open { .. } => Ok(json!(branch)),
        Job::CheckRemote => {
            network::fetch_current(&repo, p, &state, password)?;
            let (ahead, behind) = counts(&repo, head(&repo)?, remote_tip(&repo, branch)?)?;
            Ok(json!({"ahead": ahead, "behind": behind}))
        }
        Job::Guard => Ok(Value::Null),
        Job::Inspect { paths, .. } => Ok(inspect(&repo, branch, paths.as_deref(), false)?),
        Job::Commit {
            head,
            paths,
            message,
            theme,
        } => {
            let oid = commit(&repo, &root, p, &head, &paths, &message, theme.as_deref())?;
            Ok(json!(oid.to_string()))
        }
        Job::ReviewDiscard => Ok(inspect(&repo, branch, None, true)?),
        Job::Discard { head: expected, paths } => {
            let oid = head(&repo)?;
            let rows = changes(&repo, None, true)?;
            if oid.to_string() != expected || paths.len() != rows.len() ||
                !paths.iter().zip(&rows).all(|(p, row)| row[0].as_str() == Some(p.as_str())) {
                return Err(CHANGED.into());
            }
            let tree = repo.find_commit(oid).and_then(|c| c.tree()).map_err(|_| READ)?;
            let mut restore = git2::build::CheckoutBuilder::new();
            restore.force().disable_pathspec_match(true);
            let mut tracked = false;
            let mut added = Vec::new();
            for path in &paths {
                if internal(path) || path.contains(['\\', ':']) || path.split('/').any(|p| p.is_empty() || p == "." || p == ".." || p.eq_ignore_ascii_case(".git")) {
                    return Err(INVALID.into());
                }
                let mut target = root.clone();
                for part in path.split('/') {
                    target.push(part);
                    if fs::symlink_metadata(&target).is_ok_and(|m| m.is_symlink()) {
                        return Err(INVALID.into());
                    }
                }
                if target.is_dir() { return Err(INVALID.into()); }
                match tree.get_path(Path::new(path)) {
                    Ok(entry) if matches!(entry.filemode(), 0o100644 | 0o100755) => {
                        restore.path(path.as_str());
                        tracked = true;
                    }
                    Err(e) if e.code() == git2::ErrorCode::NotFound => added.push((path, target)),
                    _ => return Err(INVALID.into()),
                }
            }
            if tracked { repo.checkout_tree(tree.as_object(), Some(&mut restore)).map_err(|_| WRITE)?; }
            let mut index = repo.index().map_err(|_| READ)?;
            for (path, target) in added {
                if index.get_path(Path::new(path), 0).is_some() { index.remove_path(Path::new(path)).map_err(|_| WRITE)?; }
                if target.try_exists().map_err(|_| READ)? { fs::remove_file(target).map_err(|_| WRITE)?; }
            }
            index.write().map_err(|_| WRITE)?;
            Ok(Value::Null)
        }
        Job::Publish {
            head,
            paths,
            message,
        } => {
            commit(&repo, &root, p, &head, &paths, &message, None)?;
            // The local commit is durable even if the remote rejects the push.
            Ok(json!({"syncError": network::sync(&repo,p,&state,password).err()}))
        }
        Job::Sync { head: expected } => {
            if head(&repo)?.to_string() != expected {
                return Err(CHANGED.into());
            }
            Ok(json!(network::sync(&repo, p, &state, password)?))
        }
        Job::Branch { key, files } => Ok(snapshot::save(&repo, &root, p, &key, &files)?),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::process::Command;
    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
    #[test]
    fn existing_checkout_preserves_history_index_and_independent_save_branch() {
        let base = tempfile::tempdir().unwrap();
        let p = Profile {
            id: "96aea07e-231a-407a-82cb-860661094206".into(),
            url: "https://git.example.test/site.git".into(),
            branch: "release/blog".into(),
            username: String::new(),
            author_name: "Studio".into(),
            author_email: "test@localhost".into(),
        };
        let workspace = base.path().join("workspaces").join(&p.id);
        let root = workspace.join("repo");
        let state = workspace.join("state");
        let path = "content/threads/one/index.md";
        fs::create_dir_all(root.join("content/threads/one")).unwrap();
        fs::create_dir_all(&state).unwrap();
        git(&root, &["init", "-b", &p.branch]);
        git(&root, &["remote", "add", "origin", &p.url]);
        fs::write(root.join(path), "original").unwrap();
        git(&root, &["add", "."]);
        git(
            &root,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@test",
                "commit",
                "-m",
                "original",
            ],
        );
        let original = git(&root, &["rev-parse", "HEAD"]);
        git(
            &root,
            &["update-ref", "refs/remotes/origin/release/blog", &original],
        );
        git(
            &root,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{original},theme"),
            ],
        );
        git(
            &root,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@test",
                "commit",
                "-m",
                "unpublished gitlink",
            ],
        );
        let before = git(&root, &["rev-parse", "HEAD"]);
        let run = |action| execute(base.path(), &p, action, "", &|_, _, _| {});
        assert_eq!(run(Job::Open { clone: false }).unwrap(), p.branch);
        fs::write(root.join(path), "discard me").unwrap();
        fs::write(root.join("new.txt"), "new").unwrap();
        let rows = changes(&Repository::open(&root).unwrap(), None, true).unwrap();
        let paths = rows.iter().map(|row| row[0].as_str().unwrap().to_owned()).collect();
        assert!(rows.iter().all(|row| row[0] != "theme"), "Leave the uninitialized submodule alone");
        run(Job::Discard { head: before.clone(), paths }).unwrap();
        assert_eq!(fs::read_to_string(root.join(path)).unwrap(), "original");
        assert!(!root.join("new.txt").exists());
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), before);
        fs::write(root.join(path), "unpublished thread").unwrap();
        let status = run(Job::Inspect {
            paths: None,
            writable: true,
        })
        .unwrap();
        assert_eq!(status["ahead"], 1);
        assert!(status["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r[0] == path));
        let data = |digest: &str| {
            serde_json::from_value(
                json!({"action":"branch","key":path,"files":[{"path":path,"digest":digest}]}),
            )
            .unwrap()
        };
        assert!(run(data("wrong")).is_err());
        let hash = format!("{:x}", Sha256::digest(b"unpublished thread"));
        let saved = run(data(&hash)).unwrap();
        assert_eq!(run(data(&hash)).unwrap(), saved);
        let branch = saved["branch"].as_str().unwrap();
        assert_eq!(
            git(&root, &["show", &format!("{branch}:{path}")]),
            "unpublished thread"
        );
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), before);
        assert_eq!(git(&root, &["diff", "--cached", "--name-only"]), "");
        fs::write(root.join("implementation.ts"), "unrelated").unwrap();
        git(&root, &["add", "implementation.ts"]);
        let commit = || Job::Commit {
            head: before.clone(),
            paths: vec![path.into()],
            message: "new thread".into(),
            theme: None,
        };
        assert!(run(commit()).is_err());
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), before);
        git(&root, &["reset", "--", "implementation.ts"]);
        run(commit()).unwrap();
        assert!(git(&root, &["ls-tree", "HEAD", "theme"]).starts_with("160000"));
        assert_eq!(git(&root, &["rev-parse", branch]), saved["commit"]);
        let theme_head = git(&root, &["rev-parse", "HEAD"]);
        fs::write(root.join(path), "another unpublished edit").unwrap();
        let remaining_changes = git(&root, &["diff", "--name-only"]);
        fs::write(root.join("config.toml"), "# Rebuild\n").unwrap();
        let commit_theme = |after: String| Job::Commit {
            head: theme_head.clone(),
            paths: vec!["config.toml".into()],
            message: "chore(theme): rebuild from latest".into(),
            theme: Some(vec![ThemeBlobs { path: "config.toml".into(), before: None, after }]),
        };
        assert_eq!(run(commit_theme("wrong blob".into())), Err(CHANGED.into()));
        assert_eq!(git(&root, &["diff", "--cached", "--name-only"]), "");
        let after = git(&root, &["hash-object", "config.toml"]);
        assert_eq!(run(commit_theme(after)).unwrap(), git(&root, &["rev-parse", "HEAD"]));
        assert_eq!(git(&root, &["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]), "config.toml");
        assert_eq!(git(&root, &["diff", "--name-only"]), remaining_changes);
        fs::write(state.join("sync.json"), "interrupted").unwrap();
        assert_eq!(run(Job::Guard), Err(RECOVER.into()));
        assert_eq!(
            run(Job::Inspect {
                paths: None,
                writable: true
            }),
            Err(RECOVER.into())
        );
        assert!(run(Job::Inspect {
            paths: None,
            writable: false
        })
        .is_ok());
    }
}
