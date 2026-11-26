use super::*;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Local,
    Remote,
}

const UNSUPPORTED: &str = "此冲突需要在 Git 工具中处理；双方提交均已保留";

pub(super) fn process(
    repo: &Repository, profile: &Profile, state: &Path, expected: &str, expected_remote: &str,
    mut choices: Option<BTreeMap<String, Side>>,
) -> Result<Value> {
    let local = head(repo)?;
    let remote = remote_tip(repo, &profile.branch)?.ok_or(CHANGED)?;
    if local.to_string() != expected || remote.to_string() != expected_remote
        || !changes(repo, None, false)?.is_empty() { return Err(CHANGED); }
    let (ahead, behind) = counts(repo, local, Some(remote))?;
    if ahead == 0 || behind == 0 { return Err(CHANGED); }
    repo.merge_base(local, remote).map_err(|_| UNSUPPORTED)?;
    let ours = repo.find_commit(local).map_err(|_| READ)?;
    let theirs = repo.find_commit(remote).map_err(|_| READ)?;
    let mut index = repo.merge_commits(&ours, &theirs, None).map_err(|_| UNSUPPORTED)?;
    let conflicts = index.conflicts().map_err(|_| READ)?.collect::<std::result::Result<Vec<_>, _>>().map_err(|_| READ)?;
    let mut files = Vec::new();
    for conflict in conflicts {
        let first = conflict.our.as_ref().or(conflict.their.as_ref()).or(conflict.ancestor.as_ref()).ok_or(UNSUPPORTED)?;
        let path = std::str::from_utf8(&first.path).map_err(|_| UNSUPPORTED)?.to_owned();
        if internal(&path) || [&conflict.ancestor, &conflict.our, &conflict.their].into_iter().flatten()
            .any(|entry| entry.path != first.path || !matches!(entry.mode, 0o100644 | 0o100755)) {
            return Err(UNSUPPORTED);
        }
        files.push(json!({"path":path,"local":conflict.our.is_some(),"remote":conflict.their.is_some()}));
        if let Some(selected) = choices.as_mut() {
            let side = selected.remove(&path).ok_or(CHANGED)?;
            index.conflict_remove(Path::new(&path)).map_err(|_| WRITE)?;
            let selected = match side { Side::Local => conflict.our, Side::Remote => conflict.their };
            if let Some(mut entry) = selected {
                // Move the chosen blob from the conflict stage into the merged tree.
                entry.flags &= !0x3000;
                index.add(&entry).map_err(|_| WRITE)?;
            }
        }
    }
    let Some(remaining) = choices else { return Ok(json!(files)); };
    if files.is_empty() || !remaining.is_empty() || index.has_conflicts() { return Err(CHANGED); }
    let tree = repo.find_tree(index.write_tree_to(repo).map_err(|_| WRITE)?).map_err(|_| READ)?;
    let author = signature(profile)?;
    let merged = repo.commit(None, &author, &author, "Resolve workspace merge conflicts", &tree, &[&ours, &theirs]).map_err(|_| WRITE)?;
    network::checkout_merge(repo, profile, state, local, merged)?;
    Ok(Value::Null)
}
