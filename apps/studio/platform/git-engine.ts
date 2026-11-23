import { mergeTarget } from './merge-target.js';
import { assertThemeCommit } from './theme-commit.js';
import type { ThemeCommit } from '../shared/theme-update.js';
import { commitBranchSnapshot, assertBranchSnapshot } from './branch-save.js';
import type { BranchFile, BranchSave } from '../shared/save.js';
import './buffer.js';
import { add, checkout, clone, commit, currentBranch, fetch, getConfig, listFiles, log, push, readCommit, remove, resolveRef, statusMatrix, writeRef, type HttpClient, type ProgressCallback, type StatusRow } from 'isomorphic-git';
import { StudioError } from '../core/errors.js';
import { validateMediaPath } from '../core/media-validation.js';
import { validateRepositoryPath } from '../shared/repository.js';
import type { WorkspaceControl, WorkspaceStatus } from '../shared/workspace.js';
import { requireWorkspaceConfirmation, workspaceReviewUnavailable, type ReviewState, type WorkspaceReviewAdapter } from '../shared/workspace-confirmation.js';
import { ensureDirectory, missingFile, parentPath, type WorkspaceFiles } from './filesystem.js';
import { validateBranch, validateProfile, validateRemote, type WorkspaceProfile } from './hosting.js';
import { withWorkspaceLock } from './queue.js';
const git = { add, checkout, clone, commit, currentBranch, fetch, getConfig, listFiles, log, push, readCommit, remove, resolveRef, statusMatrix, writeRef };

const internal = (path: string) => path === '.studio-history' || path.startsWith('.studio-history/') || path === '.studio-write-lock' || path.startsWith('.studio-write-lock/');
function managed(path: string): boolean {
  try { validateRepositoryPath(path); return true; } catch { /* Check media next. */ }
  try { validateMediaPath(path); return true; } catch { return false; }
}

function checkAuthError(error: unknown) {
  if (error instanceof StudioError) throw error;
  const status = (error as { data?: { statusCode?: number } })?.data?.statusCode;
  if (status === 401 || status === 403) throw new StudioError(403, '仓库授权失败，请重新登录或更新访问令牌');
}

/** Persistent Git operations with injected filesystem/network; no embedded Node runtime. */
export class NativeGitEngine implements WorkspaceControl {
  constructor(private files: WorkspaceFiles, private root: string, private stateRoot: string,
    private profile: WorkspaceProfile, private http: HttpClient,
    private credentials: () => { username: string; password: string } | Promise<{ username: string; password: string }>,
    private reviews?: WorkspaceReviewAdapter) {
    validateProfile(profile, { allowAutomaticBranch: true });
    if (!root || root === '/' || root.endsWith('/') || root.split('/').some(part => part === '.' || part === '..')
      || stateRoot === root || stateRoot.startsWith(root + '/')) throw new Error('Git 工作区与状态目录必须分开存储');
  }
  private get options() { return { fs: { promises: this.files }, dir: this.root }; }
  private get remoteRef() { return `refs/remotes/origin/${this.profile.branch}`; }
  private get journal() { return this.stateRoot + '/sync.json'; }

  private async exists(path: string): Promise<boolean> {
    try { await this.files.lstat(path); return true; } catch (error) { if (missingFile(error)) return false; throw error; }
  }
  private async removeTree(path: string): Promise<void> {
    try {
      const info = await this.files.lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return this.files.unlink(path);
      for (const child of await this.files.readdir(path)) await this.removeTree(path + '/' + child);
      await this.files.rmdir(path);
    } catch (error) { if (!missingFile(error)) throw error; }
  }
  private async ordinaryDirectory(path: string) {
    const info = await this.files.lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StudioError(400, '工作区必须是普通目录，不能使用符号链接');
  }
  private async safeFile(path: string): Promise<void> {
    let current = this.root;
    for (const part of path.split('/')) {
      current += '/' + part;
      try { if ((await this.files.lstat(current)).isSymbolicLink()) throw new StudioError(400, '工作区不允许读写符号链接'); }
      catch (error) { if (missingFile(error)) return; throw error; }
    }
  }

  open(onProgress?: ProgressCallback, allowClone = true): Promise<void> { return withWorkspaceLock(this.root, () => this.openUnlocked(allowClone, onProgress)); }
  private async openUnlocked(allowClone = false, onProgress?: ProgressCallback): Promise<void> {
    if (this.profile.source !== 'local') await ensureDirectory(this.files, parentPath(this.root));
    const exists = await this.exists(this.root);
    if (exists) await this.ordinaryDirectory(this.root);
    const hasGit = exists && await this.exists(this.root + '/.git');
    if (hasGit) {
      validateProfile(this.profile);
      await this.ordinaryDirectory(this.root + '/.git');
    }
    else {
      if (this.profile.source === 'local') throw new StudioError(400, '请选择已有的本地 Git 仓库');
      if (!allowClone) throw new StudioError(409, '请先下载并打开 Git 工作区');
      if (exists && (await this.files.readdir(this.root)).length) throw new StudioError(409, '工作区目录已有文件，请选择空目录或匹配的 Git 仓库');
      const staging = this.root + '.clone-' + crypto.randomUUID();
      await this.files.mkdir(staging);
      try {
        await git.clone({ fs: { promises: this.files }, http: this.http, dir: staging, url: this.profile.url,
          ...(this.profile.branch ? { ref: this.profile.branch } : {}), singleBranch: true, nonBlocking: true, batchSize: 8, onAuth: this.credentials, onProgress });
        const detectedBranch = await git.currentBranch({ fs: { promises: this.files }, dir: staging });
        validateBranch(detectedBranch || '');
        if (this.profile.branch && detectedBranch !== this.profile.branch) throw new Error('Clone branch mismatch');
        // Keep partial downloads outside the selected workspace until clone fully succeeds.
        await this.files.rename(staging, this.root);
        this.profile.branch = detectedBranch!;
      } catch (error) {
        checkAuthError(error);
        throw new StudioError(502, '首次下载 Git 工作区失败，请检查连接；已有文件未被替换');
      } finally { await this.removeTree(staging); }
    }
    const origin = await git.getConfig({ ...this.options, path: 'remote.origin.url' });
    if ((origin || '') !== this.profile.url || await git.currentBranch(this.options) !== this.profile.branch) {
      throw new StudioError(409, '本地仓库的地址或分支与工作区配置不一致，请检查配置');
    }
    if (await this.exists(this.root + '/.git/shallow') && String(await this.files.readFile(this.root + '/.git/shallow', 'utf8')).trim()) {
      throw new StudioError(409, '工作区需要完整 Git 历史，请先补全浅克隆历史');
    }
    await ensureDirectory(this.files, this.stateRoot);
  }

  /** Caller may already hold the workspace queue. Never nest a queue here. */
  async assertWritable(): Promise<void> {
    if (await this.exists(this.journal)) throw new StudioError(409, '上次同步中断，请先检查 Git 工作区并完成恢复；现有内容已保留');
    const entries = new Set((await this.files.readdir(this.root + '/.git')).map(name => name.toLowerCase()));
    if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'index.lock'].some(marker => entries.has(marker.toLowerCase()))) {
      throw new StudioError(409, 'Git 操作尚未完成，请先在 Git 工具中完成合并、变基或其他操作');
    }
  }
  private async rows(cache = {}) {
    // statusMatrix's filter omits result rows but still descends into excluded directories.
    const files: WorkspaceFiles = Object.create(this.files);
    files.readdir = path => internal(path.slice(this.root.length + 1)) ? Promise.resolve([]) : this.files.readdir(path);
    return (await git.statusMatrix({ fs: { promises: files }, dir: this.root, cache, refresh: false, filter: path => !internal(path) }))
      .filter(([, head, worktree, stage]) => head !== worktree || head !== stage);
  }
  status(): Promise<WorkspaceStatus> {
    return withWorkspaceLock(this.root, async () => { await this.openUnlocked(); return this.statusUnlocked(); });
  }
  createReview(): Promise<WorkspaceStatus> {
    return withWorkspaceLock(this.root, async () => {
      await this.openUnlocked(); await this.assertWritable();
      const { status, review } = await this.inspectUnlocked();
      const adapter = this.reviewAdapter();
      const result = await adapter.store.createReview(review, adapter.source);
      return { ...status, canPublish: status.canSync, confirmation: result.confirmation, confirmationExpiresAt: result.expiresAt };
    });
  }
  private reviewAdapter(): WorkspaceReviewAdapter {
    if (!this.reviews) throw new StudioError(503, workspaceReviewUnavailable);
    return this.reviews;
  }
  private async head(): Promise<string | null> {
    try { return await git.resolveRef({ ...this.options, ref: 'HEAD' }); }
    catch (error) { if ((error as { code?: string }).code !== 'NotFoundError') throw error; return null; }
  }
  private reviewState(head: string | null, rows: StatusRow[]): ReviewState {
    return { scope: 'native:' + this.root, branch: this.profile.branch, head, rows: rows.filter(([path]) => managed(path)) };
  }
  private async checkedRows(confirmation?: string): Promise<StatusRow[]> {
    const rows = await this.rows();
    if (confirmation !== undefined) {
      const adapter = this.reviewAdapter();
      await adapter.store.validateReview(confirmation, this.reviewState(await this.head(), rows), adapter.source);
      // Do not substitute an unreviewed path list if an external editor changes the folder.
      if (this.profile.source === 'local' && JSON.stringify(rows) !== JSON.stringify(await this.rows())) {
        throw new StudioError(409, '工作区已变化，请刷新并重新确认提交范围');
      }
    }
    return rows;
  }
  private async branchStatus(cache: object) {
    const head = await this.head();
    let remoteHead: string | null = null;
    try { remoteHead = await git.resolveRef({ ...this.options, ref: this.remoteRef }); } catch { /* No remote tip yet. */ }
    let ahead = 0, behind = 0;
    if (head !== remoteHead) {
      // The normal publish path is one new, non-merge commit above the fetched tip.
      const parents = head && remoteHead ? (await git.readCommit({ ...this.options, cache, oid: head })).commit.parent : [];
      if (parents.length === 1 && parents[0] === remoteHead) ahead = 1;
      else {
        const local = new Set(head ? (await git.log({ ...this.options, cache, ref: head })).map(entry => entry.oid) : []);
        const remote = new Set(remoteHead ? (await git.log({ ...this.options, cache, ref: remoteHead })).map(entry => entry.oid) : []);
        for (const oid of local) if (!remote.has(oid)) ahead++;
        for (const oid of remote) if (!local.has(oid)) behind++;
      }
    }
    return { head, remoteHead, ahead, behind, diverged: ahead > 0 && behind > 0 };
  }
  private async statusUnlocked(knownClean?: StatusRow[]): Promise<WorkspaceStatus> { return (await this.inspectUnlocked(knownClean)).status; }
  private async inspectUnlocked(knownClean?: StatusRow[]): Promise<{ status: WorkspaceStatus; review: ReviewState }> {
    // Only share Git's pack/index cache within this read, never across a mutation.
    const cache = {};
    const branch = await this.branchStatus(cache);
    let lastSync: string | null = null;
    try { lastSync = String(await this.files.readFile(this.stateRoot + '/last-sync', 'utf8')); }
    catch (error) { if (!missingFile(error)) throw error; }
    const rows = knownClean ?? await this.rows(cache);
    const review = this.reviewState(branch.head, rows);
    const managedChanges = review.rows.map(([path]) => path);
    const changes = rows.length;
    return {
      status: { branch: this.profile.branch, dirty: changes > 0, changes, ...branch, lastSync, canSync: this.canSync, canMerge: true, managedChanges },
      review,
    };
  }

  saveBranch(key: string, files: BranchFile[]): Promise<BranchSave> {
    return withWorkspaceLock(this.root, async () => {
      await this.openUnlocked(); await this.assertWritable();
      await assertBranchSnapshot(files, async path => {
        await this.safeFile(path);
        try { return new Uint8Array(await this.files.readFile(this.root + '/' + path) as Uint8Array); }
        catch (error) { if (missingFile(error)) return null; throw error; }
      });
      return commitBranchSnapshot({ ...this.options, author: { name: this.profile.authorName, email: this.profile.authorEmail } }, key, files);
    });
  }

  commit(message: string, confirmation?: string): Promise<WorkspaceStatus> {
    return withWorkspaceLock(this.root, async () => {
      await this.commitUnlocked(message, confirmation);
      return this.statusUnlocked();
    });
  }
  commitForReview(message: string, confirmation: string): Promise<void> {
    return withWorkspaceLock(this.root, async () => { await this.commitUnlocked(message, confirmation); });
  }
  commitTheme(change: ThemeCommit): Promise<string> {
    return withWorkspaceLock(this.root, () => this.commitUnlocked(change.message, undefined, change));
  }
  private async commitUnlocked(message: string, confirmation?: string, theme?: ThemeCommit, publishing = false) {
    await this.openUnlocked(); await this.assertWritable();
    if (!this.profile.authorName.trim() || !this.profile.authorEmail.trim()) throw new StudioError(400, '请在连接设置中填写提交者名称和邮箱');
    if (typeof message !== 'string' || !message.trim() || message.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) throw new StudioError(400, '请输入不超过 500 字的提交说明');
    const rows = await this.checkedRows(confirmation);
    if ((await git.listFiles(this.options)).some(internal)) throw new StudioError(409, 'Git 暂存区包含创作中心备份文件，请先在 Git 工具中处理');
    const included = (path: string) => theme ? theme.files.some(file => file.path === path) : managed(path);
    if (rows.some(([path, head, , stage]) => (theme || !included(path)) && head !== stage)) throw new StudioError(409, '暂存区含有创作中心以外的文件，请先在 Git 工具中处理');
    if (publishing && rows.some(([path]) => !managed(path))) throw new StudioError(409, '存在托管范围以外的修改，请先在 Git 工具中处理再同步。');
    const entries = rows.filter(([path]) => included(path));
    if (!entries.length) throw new StudioError(409, '没有可提交的内容修改');
    for (const [path] of entries) await this.safeFile(path);
    if (theme) await assertThemeCommit(this.options, theme, path => this.files.readFile(this.root + '/' + path));
    for (const [path, , worktree] of entries) {
      if (worktree) await git.add({ ...this.options, filepath: path });
      else await git.remove({ ...this.options, filepath: path });
    }
    return git.commit({ ...this.options, message: message.trim(), author: { name: this.profile.authorName, email: this.profile.authorEmail } });
  }

  private async fetchRemote() {
    validateRemote(this.profile.url);
    try {
      await git.fetch({ ...this.options, http: this.http, url: this.profile.url, remote: 'origin', ref: this.profile.branch,
        singleBranch: true, onAuth: this.credentials });
    } catch (error) { checkAuthError(error); throw new StudioError(502, '暂时无法连接 Git 远端，本地文件和提交已保留'); }
  }
  get canSync() {
    try { validateRemote(this.profile.url); return true; } catch { return false; }
  }
  get checkRemote() {
    if (!this.canSync) return undefined;
    return () => withWorkspaceLock(this.root, async () => {
      await this.openUnlocked();
      await this.fetchRemote();
      const { ahead, behind } = await this.branchStatus({});
      return { ahead, behind };
    });
  }

  publish(message: string, confirmation: string): Promise<void> {
    return withWorkspaceLock(this.root, async () => {
      validateRemote(this.profile.url);
      await this.commitUnlocked(message, requireWorkspaceConfirmation(confirmation), undefined, true);
      await this.syncUnlocked();
    });
  }

  sync(confirmation?: string): Promise<WorkspaceStatus> {
    return withWorkspaceLock(this.root, () => this.syncUnlocked(confirmation));
  }

  private async syncUnlocked(confirmation?: string): Promise<WorkspaceStatus> {
    await this.openUnlocked(); await this.assertWritable();
    try { validateRemote(this.profile.url); } catch { throw new StudioError(400, 'App 同步需要 HTTPS 远端；本地保存和提交仍可使用'); }
    const rows = await this.checkedRows(confirmation);
    if (rows.length) throw new StudioError(409, '请先提交本地修改，再同步远端；未保存到 Git 的内容不会被覆盖');
    await this.fetchRemote();
    const status = await this.branchStatus({});
    if (status.behind && status.remoteHead) {
      const target = status.diverged && status.head
        ? await mergeTarget(this.options.fs, this.root, status.head, status.remoteHead, { name: this.profile.authorName, email: this.profile.authorEmail })
        : status.remoteHead;
      await git.checkout({ ...this.options, ref: target, noUpdateHead: true, nonBlocking: true, batchSize: 8, dryRun: true });
      await this.files.writeFile(this.journal + '.tmp', JSON.stringify({ before: status.head, target }));
      await this.files.rename(this.journal + '.tmp', this.journal);
      await git.checkout({ ...this.options, ref: target, noUpdateHead: true, nonBlocking: true, batchSize: 8 });
      await git.writeRef({ ...this.options, ref: `refs/heads/${this.profile.branch}`, value: target, force: true });
      await this.files.unlink(this.journal);
    }
    if (status.ahead) {
      try {
        const pushed = await git.push({ ...this.options, http: this.http, url: this.profile.url, remote: 'origin', ref: this.profile.branch,
          force: false, onAuth: this.credentials });
        if (!pushed.ok) throw new Error('Push rejected');
      } catch (error) { checkAuthError(error); throw new StudioError(409, 'Git 推送未确认，请重试同步以核对远端；本地提交已保留'); }
    }
    await this.files.writeFile(this.stateRoot + '/last-sync', new Date().toISOString());
    // Fetch/push change refs only. Reinspect files after a checkout or in an externally editable folder.
    return this.statusUnlocked(status.behind || this.profile.source === 'local' ? undefined : rows);
  }
}
