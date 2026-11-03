# Persistent Git workspaces

The existing HTTP API and cloud-function deployment remain supported. No WebSocket or Rust/WASM server runtime is required.

## Choose storage deliberately

- `STUDIO_SITE_ROOT`: edit an existing local site directory. Saving writes files; Studio does not manage Git for this mode.
- `STUDIO_GIT_URL` without a workspace: the existing online/cloud workflow. Each save creates a temporary checkout, commits the edited files, and pushes.
- `STUDIO_GIT_URL` with `STUDIO_GIT_WORKSPACE`: retain a local checkout across application restarts. Save locally, commit locally, then explicitly synchronize.

The persistent workspace is user data, not an expendable cache. Back it up; it can contain the only copy of unpublished files or unpushed commits. Do not put it under a cleanup-managed temporary directory or inside the theme source directory.

## Local/server configuration

After configuring the existing administrator authentication, set these server environment variables:

```dotenv
STUDIO_STATE=file
STUDIO_GIT_URL=https://git.example.com/owner/site.git
STUDIO_GIT_BRANCH=main
STUDIO_GIT_USERNAME=your-provider-username
STUDIO_GIT_TOKEN=your-token
STUDIO_GIT_AUTHOR=Your Name
STUDIO_GIT_EMAIL=you@example.com
STUDIO_GIT_WORKSPACE=/absolute/path/to/your/site-workspace
```

Repositories that pin their theme with a Git submodule are supported for content editing: existing gitlinks are preserved through content commits and synchronization. Both uninitialized and already-initialized theme submodules are covered by tests; Studio does not recursively download or manage the theme submodule.

The initial clone requires connectivity, a readable existing branch and an initialized remote repository. An empty destination or a matching local repository is accepted; unrelated directories, linked Git directories, mismatched branches and mismatched remote URLs are rejected. Clone completes in a separate staging directory before becoming the workspace. The configured origin URL never contains credentials.

Once downloaded, content and media reads, saving, and committing work without network access. Reopening uses the same local repository. The first implementation downloads the selected branch with history so it can detect divergence accurately; it does not promise sparse checkout, Git LFS hydration, recursive submodules, SSH authentication, or automatic background synchronization.

Persistent workspaces are rejected with `STUDIO_STATE=blob`. Cloud-function ephemeral disks must continue using the online Git mode. A self-hosted Node deployment can use a persistent mounted directory; run only one Studio installation against a workspace and avoid simultaneous editing with other Git tools during synchronization.

## Save, commit and synchronize

Authenticated HTTP endpoints:

| Endpoint | Behavior |
| --- | --- |
| `GET /api/workspace` | Local status and the last known remote tip; does not fetch |
| `POST /api/workspace/commit` with `{ "message": "docs(content): update posts", "confirmation": "<status token>" }` | Commit changed managed content and media locally |
| `POST /api/workspace/sync` with `{ "confirmation": "<status token>" }` | Fetch remote changes, fast-forward when safe, push local commits without force |

HTTP and native in-process transport mutations require a nonempty string `confirmation` from the reviewed workspace status (400 if missing/invalid). Engines compare it against fresh status under the workspace lock and reject stale tokens with 409 before mutation. After committing, use the returned status token for sync, not the pre-commit token. Only trusted internal engine/test callers retain optional token omission for compatibility; this is not supported by user-facing transports.

During commit-and-sync, local commit success confirms only the local step. If the sync response is lost or fails, the local commit is preserved but the remote outcome needs verification; refreshing local status is not proof that a push did not happen.

Mutation endpoints use the same Origin and CSRF protections as existing writes. `/api/bootstrap` exposes `workspace: true` only when this capability is available. Other connection modes return 404 for workspace endpoints.

The status includes `branch`, `dirty`, `changes`, `ahead`, `behind`, `diverged`, `head`, `remoteHead`, `lastSync`, `managedChanges`, and `confirmation`. Ahead/behind reflect the **last fetched** state. They are not a live remote health check. Synchronizing successfully means Git is up to date; it does not confirm a website deployment.

Revision checks still reject stale saves. Sync refuses uncommitted changes; committing refuses unrelated staged implementation files. Git history backups are never automatically committed. Push failures retain local commits, and retrying synchronization fetches the remote before pushing again.

## Conflicts and recovery

If both devices created commits, Studio fetches the remote and reports divergence without overwriting either history. Open the workspace in a Git tool, review and merge the changes, commit the resolution, then retry synchronization. No force push or automatic conflict resolution is performed.

A fast-forward writes `.git/wondershine-sync.json` before changing the working tree and branch. If interrupted, subsequent writes and syncs stop rather than guessing which files are safe to replace. Stop Studio, back up the workspace, inspect the recorded before/target commits and `git status`, and finish recovery with a Git tool. Remove the journal only after verifying the working tree, index and branch agree, then restart Studio.

A process interruption can also leave a sibling `<workspace>.studio-lock` directory. Check that no Studio operation/process uses the workspace before removing this empty lock directory. Never delete the workspace to clear an error.

## Verified coverage

`apps/studio/tests/git-workspace.test.ts` uses a temporary bare Git remote served over smart HTTP. It covers initial download, offline save and commit, reopening, stale saves, fast-forward, refused/retried pushes, media, unrelated staged files, divergence, interrupted-sync protection, deployment-mode validation, and authenticated/CSRF-protected routes. It does not use user repositories or live provider tokens.

## 保存方式与默认值

文章、动态、话题和设置的保存按钮右侧有下拉菜单。选择本次使用的方式后，可点击「将当前方式设为默认」。默认值保存在当前设备的 localStorage，按工作区与登录身份隔离；连接自建创作中心时还按服务地址隔离。自动保存沿用当前编辑器的方式，切换默认值不会立即执行保存。

| 连接 | 可选方式 |
| --- | --- |
| App 本地文件夹 / 本地缓存 Git 仓库 | 本地保存、Git 分支保存 |
| Node 持久化 Git 工作区 | 本地保存、Git 分支保存 |
| `STUDIO_SITE_ROOT` 普通目录 | 本地保存 |
| 无持久化工作区的在线 Git / 云函数 | 远端保存（保持既有流程） |

**本地保存**写入当前工作区文件。在自建 Node 服务中，“本地”指服务器的持久磁盘；在 App 直连仓库中，指设备磁盘。保留草稿、是否可发布仍由内容属性控制，与保存目的地独立。

**Git 分支保存**先保存工作区文件，再提交到 `studio/save-…` 独立本地分支；界面显示具体分支名。同一文件继续使用该分支，相同内容不会重复创建提交。提交使用本次文件快照、必要的缺失语言目录文件和引用的本地图片，不切换当前分支，不改暂存区，不收集其他文章草稿或已存在父级文件的修改。提交前在工作区锁内复核文件快照，防止并发旧保存覆盖较新的内容。

此功能不会自动推送、创建 PR 或合并。需要审核发布时，用 Git 工具推送界面显示的分支，再在托管平台创建 PR。现有「工作区同步」仍只同步工作区配置的分支，不会推送这些保存分支。新建话题、关联文章、站点配置等如果还未进入基础分支，需要另行纳入发布流程；单文件保存分支不是整站发布事务。

如果本地文件保存成功而分支提交失败，界面会报告部分完成，保留最新文件 revision，并允许直接重试。此时自动保存暂停；不会把失败显示为发布成功。建议保留页面直至重试完成。页面重开后，本地文件仍在，可再次选择 Git 分支保存。

API：`PUT /api/document` 和 `PUT /api/settings/:id` 接受可选 `saveMode: "local" | "branch" | "remote"`。服务端按实际能力校验，不支持的模式在写入前返回 400。`/api/bootstrap` 返回 `saveCapabilities.modes` 和不含明文目录的 `saveScope`。部分成功响应保留 `revision`，并带 `branchPending: true`；成功的分支保存返回 `branch` 和 `commit`。
