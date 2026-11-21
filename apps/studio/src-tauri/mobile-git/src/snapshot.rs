use super::*;
use git2::{Index, IndexEntry, IndexTime, ObjectType};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    path: String,
    digest: Option<String>,
    #[serde(default)]
    only_if_missing: bool,
}

pub(super) fn save(
    repo: &Repository,
    root: &Path,
    profile: &Profile,
    key: &str,
    files: &[Input],
) -> Result<Value> {
    if !managed(key) || files.is_empty() {
        return Err(INVALID);
    }
    let digest = format!("{:x}", Sha256::digest(key.as_bytes()));
    let branch = format!("studio/save-{}", &digest[..24]);
    if branch == profile.branch {
        return Err("请先切回工作区主分支，再使用分支保存");
    }
    let reference = format!("refs/heads/{branch}");
    let existing = match repo.refname_to_id(&reference) {
        Ok(id) => Some(id),
        Err(e) if e.code() == git2::ErrorCode::NotFound => None,
        Err(_) => return Err(READ),
    };
    let parent = repo
        .find_commit(existing.unwrap_or(head(repo)?))
        .map_err(|_| READ)?;
    let tree = parent.tree().map_err(|_| READ)?;
    let mut index = Index::new().map_err(|_| WRITE)?;
    index.read_tree(&tree).map_err(|_| READ)?;
    let conflict = "分支中的路径类型冲突，请在 Git 工具中处理";
    for input in files {
        let file = checked_file(root, &input.path)?;
        let bytes = match fs::symlink_metadata(&file) {
            Ok(info) if info.is_file() && info.len() <= 20 * 1024 * 1024 => {
                Some(fs::read(file).map_err(|_| READ)?)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            _ => return Err(INVALID),
        };
        if bytes.as_ref().map(|b| format!("{:x}", Sha256::digest(b))) != input.digest {
            return Err("文件在分支提交前已更新，请重新加载并合并修改");
        }
        let path = Path::new(&input.path);
        let entry = match tree.get_path(path) {
            Ok(e) => Some(e),
            Err(e) if e.code() == git2::ErrorCode::NotFound => None,
            Err(_) => return Err(conflict),
        };
        if entry.is_some() && input.only_if_missing {
            continue;
        }
        if entry
            .as_ref()
            .is_some_and(|e| e.kind() != Some(ObjectType::Blob) || e.filemode() == 0o120000)
        {
            return Err(conflict);
        }
        for parent_path in path
            .ancestors()
            .skip(1)
            .filter(|p| !p.as_os_str().is_empty())
        {
            if let Ok(e) = tree.get_path(parent_path) {
                if e.kind() != Some(ObjectType::Tree) {
                    return Err(conflict);
                }
            }
        }
        if let Some(data) = bytes {
            let id = repo.blob(&data).map_err(|_| WRITE)?;
            let mode = entry.map_or(0o100644, |e| e.filemode() as u32);
            let stamp = IndexTime::new(0, 0);
            index
                .add(&IndexEntry {
                    ctime: stamp,
                    mtime: stamp,
                    dev: 0,
                    ino: 0,
                    mode,
                    uid: 0,
                    gid: 0,
                    file_size: data.len() as u32,
                    id,
                    flags: 0,
                    flags_extended: 0,
                    path: input.path.as_bytes().to_vec(),
                })
                .map_err(|_| WRITE)?;
        } else if index.get_path(path, 0).is_some() {
            index.remove_path(path).map_err(|_| WRITE)?;
        }
    }
    let tree_id = index.write_tree_to(repo).map_err(|_| WRITE)?;
    let id = if existing.is_some() && tree_id == tree.id() {
        parent.id()
    } else {
        let next = repo.find_tree(tree_id).map_err(|_| READ)?;
        let author = signature(profile)?;
        repo.commit(
            Some(&reference),
            &author,
            &author,
            &format!("content: save {key}"),
            &next,
            &[&parent],
        )
        .map_err(|_| WRITE)?
    };
    Ok(json!({"branch":branch,"commit":id.to_string()}))
}
