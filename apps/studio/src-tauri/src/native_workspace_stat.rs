use std::{
    fs::{self, Metadata},
    io::ErrorKind,
    path::{Component, Path},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const INVALID: &str = "Invalid private workspace path";
const SYMLINK: &str = "Private workspace path contains a symlink";
const UNAVAILABLE: &str = "Unable to inspect private workspace path";

fn metadata(base: &Path, path: &Path) -> Result<Option<Metadata>, &'static str> {
    let relative = path.strip_prefix(base).map_err(|_| INVALID)?;
    let mut parts = relative.components();
    let workspace = match (parts.next(), parts.next(), parts.next()) {
        (Some(Component::Normal(workspaces)), Some(Component::Normal(id)), Some(Component::Normal(repo)))
            if workspaces == "workspaces" && repo == "repo" => id,
        _ => return Err(INVALID),
    };
    let Some(id) = workspace.to_str() else {
        return Err(INVALID);
    };
    if id.len() != 36
        || !id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
        || !parts.all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(INVALID);
    }

    let mut current = base.to_path_buf();
    let mut info = fs::symlink_metadata(&current).map_err(|_| UNAVAILABLE)?;
    if info.file_type().is_symlink() {
        return Err(SYMLINK);
    }
    for part in relative.components() {
        current.push(part);
        info = match fs::symlink_metadata(&current) {
            Ok(info) => info,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(UNAVAILABLE),
        };
        if info.file_type().is_symlink() {
            return Err(SYMLINK);
        }
    }
    Ok(Some(info))
}

fn wire(info: Metadata) -> serde_json::Value {
    let millis = |time: std::io::Result<SystemTime>| {
        time.ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
    };
    let mtime = millis(info.modified()).unwrap_or(0);
    let kind = if info.is_file() { "file" } else if info.is_dir() { "directory" } else { "other" };
    #[cfg(unix)]
    let (mode, dev, ino, uid, gid) = {
        use std::os::unix::fs::MetadataExt;
        (info.mode(), info.dev(), info.ino(), info.uid(), info.gid())
    };
    #[cfg(not(unix))]
    let (mode, dev, ino, uid, gid) = (if info.is_dir() { 0o40755 } else { 0o100644 }, 0, 0, 0, 0);
    serde_json::json!({ "kind": kind, "size": info.len(), "mtimeMs": mtime,
        "ctimeMs": millis(info.created()).unwrap_or(mtime), "mode": mode,
        "dev": dev, "ino": ino, "uid": uid, "gid": gid })
}

#[tauri::command]
pub async fn native_workspace_stat(
    app: tauri::AppHandle, webview: tauri::Webview, path: String,
) -> Result<Option<serde_json::Value>, &'static str> {
    if webview.label() != "main" {
        return Err(INVALID);
    }
    let base = app.path().app_data_dir().map_err(|_| UNAVAILABLE)?;
    tauri::async_runtime::spawn_blocking(move || {
        metadata(&base, Path::new(&path)).map(|metadata| metadata.map(wire))
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_checks_ordinary_paths_within_a_private_checkout() {
        let home = std::env::temp_dir().join(format!(
            "studio-workspace-stat-{}-{}",
            std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let workspace = home.join("workspaces/00000000-0000-4000-8000-000000000001");
        let repo = workspace.join("repo");
        let article = repo.join("content/article.md");
        fs::create_dir_all(article.parent().unwrap()).unwrap();
        fs::write(&article, "markdown").unwrap();
        assert_eq!(wire(metadata(&home, &article).unwrap().unwrap())["size"], 8);
        assert!(metadata(&home, &repo.join("missing/image.png")).unwrap().is_none());
        for invalid in [
            home.clone(), workspace.join("state/snapshot.json"), repo.join("../repo/content"),
            repo.join("../../outside"), home.join("workspaces/not-a-workspace/repo"),
        ] {
            assert_eq!(metadata(&home, &invalid).unwrap_err(), INVALID);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&article, repo.join("link.md")).unwrap();
            symlink(article.parent().unwrap(), repo.join("redirect")).unwrap();
            assert_eq!(metadata(&home, &repo.join("link.md")).unwrap_err(), SYMLINK);
            assert_eq!(metadata(&home, &repo.join("redirect/article.md")).unwrap_err(), SYMLINK);
        }
        fs::remove_dir_all(home).unwrap();
    }
}
