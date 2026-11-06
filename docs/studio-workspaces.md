# Persistent Git workspaces

The existing HTTP API and cloud-function deployment remain supported. No WebSocket or Rust/WASM server runtime is required.

## Native App workspace chooser (desktop and iOS)

The App starts with a single list of saved local Git repositories, downloaded remote Git repositories, and HTTPS Studio service connections. Select a record to open its connection form; use **Add workspace** for another repository, or the self-hosted Studio connection action for a service. Only one workspace is active at a time. Desktop supports selecting existing Git folders. iOS/Android do not offer the desktop folder picker; they use clones or remote services.

**Rename** changes the display label. **Archive record** hides the connection from the active chooser while preserving its full sanitized record and original UUID. Expand **Archived workspaces** and use **Restore record** to reopen the exact checkout, state and draft identity. Archive never removes checkout files, unpushed commits, recovery drafts, or AppData. Restoration is explicit and never inferred from matching URLs; adding another record does not restore an archived one. Back up the registry together with AppData. Records already deleted by earlier versions require a registry backup containing the original UUID; a URL alone cannot safely recover their identity. The existing `wondershine.native.workspaces.v1` registry is extended without changing native IDs, checkout directories or native draft identity scopes. Invalid/unreadable registries block record writes and show an error rather than silently overwriting the old data. Storage write errors also remain visible; a clone may already exist on disk even if its record could not be saved.

Use **Switch workspace** in the App header. It uses the existing dirty-editor confirmation and logout lifecycle, disposes the old runtime, then returns to the chooser. Pending API writes (including Git commit/sync) block switching, and new requests are blocked while logout is pending. No concurrent live workspace swap or multi-tenant server is introduced. A failed service logout leaves the current connection in place so it can be retried.

Service records contain only an ID, display label and HTTPS origin (no path, query, embedded password or token). Password login is still required on each connection; OIDC remains browser-only. Service draft identities include the workspace record ID and origin; authentication cookies and CSRF values are not rewritten. Earlier service recovery data scoped by origin/account is never silently assigned to a record. After authenticating, expand **Recover legacy remote drafts** in the sidebar and explicitly confirm **Copy legacy drafts and settings** only if those ambiguous drafts belong to this workspace. The source scope is derived from the authenticated transport's exact HTTPS origin, login method and account; other origins/methods/accounts are excluded. This copies document drafts, thread sessions and unsaved threads, settings recovery, guide preference and scoped default save preference. Originals are retained and every existing target wins (including newer drafts); retries are safe. Reopen the workspace after importing so mounted editors and settings load the copied data. Storage failures can leave a partial copy; original data remains intact and retry skips completed copies. Git tokens, service cookies and client API keys remain session-only and are not reused on switching.

Registry and transport isolation tests and native production-browser chooser, dirty-switch cancellation and pending-write coverage are included in source. They require remote CI execution; these additions have not been locally executed or validated on physical devices.

## Choose storage deliberately

- `STUDIO_SITE_ROOT`: edit an existing local site directory. Saving writes files; Studio does not manage Git for this mode.
- `STUDIO_GIT_URL` without a workspace: the existing online/cloud workflow. Each save creates a temporary checkout, commits the edited files, and pushes.
- `STUDIO_GIT_URL` with `STUDIO_GIT_WORKSPACE`: retain a local checkout across application restarts. Save locally, commit locally, then explicitly synchronize.

The persistent workspace is user data, not an expendable cache. Back it up; it can contain the only copy of unpublished files or unpushed commits. Do not put it under a cleanup-managed temporary directory or inside the theme source directory.

## Local/server configuration

After configuring the existing administrator authentication, set these server environment variables:

```dotenv
STUDIO_STATE=file
STUDIO_STATE_DIR=/absolute/private/path/to/studio-state
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

### Private state and upgrades

For local and persistent Git modes, set `STUDIO_STATE_DIR` to an absolute private directory **outside the site/worktree and all HTTP/static serving roots**. Starting from the site directory with the default `.state` is no longer a suitable layout for persisted text baselines and is rejected. For example, use `/srv/studio-private/state` alongside `/srv/sites/example`, not inside it. Do not delete the old `.state` to bypass a configuration error: stop all workers, back up existing state, move it into the chosen private location, preserve ownership/permissions, then update the setting.

Content revisions are opaque identities backed by private exact-text baselines, shared between Node workers using the same state directory. These files contain unpublished content and must not be committed, served, included in an image's public assets, or copied to an unprotected backup. POSIX stores use owner-only permissions. On Windows, mode bits do **not** establish private ACLs: before starting Studio, the administrator must provision and verify a service-account-only directory ACL, removing inherited access for unrelated users. Use a dedicated service identity; verify effective access with Windows Security → Advanced or your deployment ACL tooling. Do not deploy this store on Windows if that isolation cannot be guaranteed.

Unknown, expired, evicted or pre-upgrade SHA-based revisions produce a conflict instead of silently adopting current content. Keep recovery drafts and merge against a freshly loaded document. Stable workspace IDs, save-scope hashes and authentication-state key names are unchanged.

Node acquires the shared baseline lock before reading authoritative file text and holds it through revision registration. This prevents an old read waiting for the lock from later replacing a newer editing baseline. Native repositories likewise serialize snapshot reads by filesystem authority, root and path across repository instances. Batch mutations and recovery reserve all affected paths together; guards run before those reservations so they may read the repository without lock reentry. Saves recheck their revisions after waiting for those reservations, and recovery checks every affected file before restoring any file. Unrelated paths remain independently readable. These locks coordinate Studio operations only: external editors do not participate, and validation followed by a file write is not an atomic compare-and-write against external processes.

## Save, commit and synchronize

Authenticated HTTP endpoints:

| Endpoint | Behavior |
| --- | --- |
| `GET /api/workspace` | Local status and the last known remote tip; does not fetch or create a review |
| `POST /api/workspace/review` | Capture a private temporary review; returns status plus `confirmation` and `confirmationExpiresAt` |
| `POST /api/workspace/commit` with `{ "message": "docs(content): update posts", "confirmation": "<review token>" }` | Validate the reviewed local state and commit managed content/media locally |
| `POST /api/workspace/sync` with `{ "confirmation": "<review token>" }` | Validate the reviewed local state, fetch, fast-forward when safe, and push without force |

HTTP and native in-process transport mutations require a nonempty string `confirmation` from an explicit review (400 if missing/invalid). Engines compare the reviewed branch, local HEAD, managed rows and exact file bytes under the workspace lock; expired or stale tokens are rejected with 409 before mutation. Ordinary status and mutation responses do not contain a new token. After committing, create a new review and let the user confirm synchronization separately. Only trusted internal engine/test callers retain optional token omission for compatibility; this is not supported by user-facing transports.

A review confirms **local workspace state**, not a fixed remote synchronization plan or a one-use authorization. Synchronization fetches the latest remote state and applies the existing clean-worktree, divergence and non-force rules. The displayed remote tip remains the last fetched observation, not a guarantee of what the next fetch will return.

Review capture and validation stream exact bytes in 64 KiB chunks to private derived storage outside the worktree. The defaults allow a 512 MiB snapshot within a 1 GiB total logical-file-byte budget, including the previous snapshot and reserved manifest space during replacement; filesystem allocation overhead is additional. A failed capture immediately attempts to remove only its unpublished files, and never removes the previously published review. Native chunk IPC latency and throughput have not yet been measured; bounded memory is not a performance benchmark. Native review ownership uses a narrow Rust `File::try_lock()` provider (Rust 1.89+, no additional crate). It locks a fixed private AppData file for the app process lifetime, independent of the desktop single-instance plugin. The async `openNativeWorkspaceReviews(state, base)` factory must be awaited after the state directory exists and before runtime exposure; the native runtime awaits this factory before opening Git and exposing transport operations. Remote tests and platform validation are still required before claiming crash recovery works. Rust grants recovery only once per workspace per process, before any response is sent. Only a validated empty derived review lock may be removed, never Git journals/history. A new webview epoch or a leftover lock after that claim requires fully exiting and restarting the app—not reconnecting or waiting for a timeout. Normal review operations recheck Rust ownership and use a separate per-workspace review queue inside the existing mutation queue. IPC cancellation never releases the OS owner. Unsupported filesystem locking fails closed. AppData sandbox/ACL protection is still required; this does not defend against a hostile local process replacing private path ancestors.

During commit-and-sync, local commit success confirms only the local step. If the sync response is lost or fails, the local commit is preserved but the remote outcome needs verification; refreshing local status is not proof that a push did not happen.

Mutation endpoints use the same Origin and CSRF protections as existing writes. `/api/bootstrap` exposes `workspace: true` only when this capability is available. Other connection modes return 404 for workspace endpoints.

The status includes `branch`, `dirty`, `changes`, `ahead`, `behind`, `diverged`, `head`, `remoteHead`, `lastSync` and `managedChanges`. Only explicit review responses add `confirmation` and `confirmationExpiresAt`. Ahead/behind reflect the **last fetched** state. They are not a live remote health check. Synchronizing successfully means Git is up to date; it does not confirm a website deployment.

Revision checks still reject stale saves. Sync refuses uncommitted changes; committing refuses unrelated staged implementation files. Git history backups are never automatically committed. Push failures retain local commits, and retrying synchronization fetches the remote before pushing again.

## Conflicts and recovery

If both devices created commits, Studio fetches the remote and reports divergence without overwriting either history. Open the workspace in a Git tool, review and merge the changes, commit the resolution, then retry synchronization. No force push or automatic conflict resolution is performed.

A fast-forward writes `.git/wondershine-sync.json` before changing the working tree and branch. If interrupted, subsequent writes and syncs stop rather than guessing which files are safe to replace. Stop Studio, back up the workspace, inspect the recorded before/target commits and `git status`, and finish recovery with a Git tool. Remove the journal only after verifying the working tree, index and branch agree, then restart Studio.

A process interruption can also leave a sibling `<workspace>.studio-lock` directory or a `lock` in private revision/review storage. Stop **all** workers using that installation and confirm no operation still owns the lock before an administrator removes an empty lock directory. Age alone is not proof that a lock is abandoned. Never delete the workspace to clear an error.

A `pending` marker in `content-revisions-v1` means baseline publication was interrupted. Removing only `lock` does not make this state valid. Back up the private state and inspect/recover it with the service stopped; do not remove `pending` just to bypass the check. If an administrator replaces a damaged baseline store with a new empty private store after preserving the backup, old editing tokens become invalid and open drafts must be reloaded and merged. Never restore an old baseline store while workers are active.

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
