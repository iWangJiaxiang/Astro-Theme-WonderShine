import { commitBranchSnapshot, assertBranchSnapshot } from './branch-save.js';
import type { BranchFile, BranchSave } from '../shared/save.js';
import './buffer.js';
import { add, checkout, clone, commit, currentBranch, fetch, getConfig, listFiles, log, push, remove, resolveRef, statusMatrix, writeRef, type HttpClient, type ProgressCallback } from 'isomorphic-git';
import { StudioError } from '../core/errors.js';
import { validateMediaPath } from '../core/media-validation.js';
import { validatePath } from '../shared/repository.js';
import type { WorkspaceControl, WorkspaceStatus } from '../shared/workspace.js';
import { confirmationMatches, workspaceChanged, workspaceConfirmation } from '../shared/workspace-confirmation.js';
import { ensureDirectory, missingFile, parentPath, type WorkspaceFiles } from './filesystem.js';
import { validateBranch, validateProfile, validateRemote, type WorkspaceProfile } from './hosting.js';
import { withWorkspaceLock } from './queue.js';
const git = { add, checkout, clone, commit, currentBranch, fetch, getConfig, listFiles, log, push, remove, resolveRef, statusMatrix, writeRef };

const internal = (path: string) => path === '.studio-history' || path.startsWith('.studio-history/') || path === '.studio-write-lock' || path.startsWith('.studio-write-lock/');
function managed(path: string): boolean {
  try { validatePath(path); return true; } catch { /* Check media next. */ }
  try { validateMediaPath(path); return true; } catch { return false; }
}

/** Persistent Git operations with injected filesystem/network; no embedded Node runtime. */
export class NativeGitEngine implements WorkspaceControl {
  constructor(private files: WorkspaceFiles, private root: string, private stateRoot: string,
    private profile: WorkspaceProfile, private http: HttpClient,
    private credentials: () => { username: string; password: string }) {
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

  open(onProgress?: ProgressCallback): Promise<void> { return withWorkspaceLock(this.root, () => this.openUnlocked(true, onProgress)); }
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
          ...(this.profile.branch ? { ref: this.profile.branch } : {}), singleBranch: true, onAuth: this.credentials, onProgress });
        const detectedBranch = await git.currentBranch({ fs: { promises: this.files }, dir: staging });
        validateBranch(detectedBranch || '');
        if (this.profile.branch && detectedBranch !== this.profile.branch) throw new Error('Clone branch mismatch');
        // Keep partial downloads outside the selected workspace until clone fully succeeds.
        await this.files.rename(staging, this.root);
        this.profile.branch = detectedBranch!;
      } catch {
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
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'index.lock']) {
      if (await this.exists(this.root + '/.git/' + marker)) throw new StudioError(409, 'Git 操作尚未完成，请先在 Git 工具中完成合并、变基或其他操作');
    }
  }
  private async rows() {
    return (await git.statusMatrix({ ...this.options, refresh: false, filter: path => !internal(path) }))
      .filter(([, head, worktree, stage]) => head !== worktree || head !== stage);
  }
  status(): Promise<WorkspaceStatus> {
    return withWorkspaceLock(this.root, async () => { await this.openUnlocked(); return this.statusUnlocked(); });
  }
  private async statusUnlocked(): Promise<WorkspaceStatus> {
    let head: string | null = null;
    try { head = await git.resolveRef({ ...this.options, ref: 'HEAD' }); } catch (error) {
      if ((error as { code?: string }).code !== 'NotFoundError') throw error;
    }
    let remoteHead: string | null = null;
    try { remoteHead = await git.resolveRef({ ...this.options, ref: this.remoteRef }); } catch { /* No remote tip yet. */ }
    let ahead = 0, behind = 0;
    if (head !== remoteHead) {
      const local = new Set(head ? (await git.log({ ...this.options, ref: head })).map(entry => entry.oid) : []);
      const remote = new Set(remoteHead ? (await git.log({ ...this.options, ref: remoteHead })).map(entry => entry.oid) : []);
      ahead = [...local].filter(oid => !remote.has(oid)).length;
      behind = [...remote].filter(oid => !local.has(oid)).length;
    }
    let lastSync: string | null = null;
    try { lastSync = String(await this.files.readFile(this.stateRoot + '/last-sync', 'utf8')); }
    catch (error) { if (!missingFile(error)) throw error; }
    const rows = await this.rows();
    const managedChanges = rows.filter(([path]) => managed(path)).map(([path]) => path);
    const confirmation = await workspaceConfirmation(this.profile.branch, head, rows.filter(([path]) => managed(path)), async path => {
      await this.safeFile(path);
      return new Uint8Array(await this.files.readFile(this.root + '/' + path) as Uint8Array);
    });
    const changes = rows.length;
    let canSync = true;
    try { validateRemote(this.profile.url); } catch { canSync = false; }
    return { branch: this.profile.branch, dirty: changes > 0, changes, head, remoteHead, ahead, behind, diverged: ahead > 0 && behind > 0, lastSync, canSync, managedChanges, confirmation };
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
      await this.openUnlocked(); await this.assertWritable();
      if (confirmation !== undefined && !confirmationMatches(confirmation, await this.statusUnlocked())) throw new StudioError(409, workspaceChanged);
      if (!this.profile.authorName.trim() || !this.profile.authorEmail.trim()) throw new StudioError(400, '请在连接设置中填写提交者名称和邮箱');
      if (typeof message !== 'string' || !message.trim() || message.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) throw new StudioError(400, '请输入不超过 500 字的提交说明');
      const rows = await this.rows();
      if ((await git.listFiles(this.options)).some(internal)) throw new StudioError(409, 'Git 暂存区包含创作中心备份文件，请先在 Git 工具中处理');
      if (rows.some(([path, head, , stage]) => !managed(path) && head !== stage)) throw new StudioError(409, '暂存区含有创作中心以外的文件，请先在 Git 工具中处理');
      const entries = rows.filter(([path]) => managed(path));
      if (!entries.length) throw new StudioError(409, '没有可提交的内容修改');
      for (const [path] of entries) await this.safeFile(path);
      for (const [path, , worktree] of entries) {
        if (worktree) await git.add({ ...this.options, filepath: path });
        else await git.remove({ ...this.options, filepath: path });
      }
      await git.commit({ ...this.options, message: message.trim(), author: { name: this.profile.authorName, email: this.profile.authorEmail } });
      return this.statusUnlocked();
    });
  }

  sync(confirmation?: string): Promise<WorkspaceStatus> {
    return withWorkspaceLock(this.root, async () => {
      await this.openUnlocked(); await this.assertWritable();
      if (confirmation !== undefined && !confirmationMatches(confirmation, await this.statusUnlocked())) throw new StudioError(409, workspaceChanged);
      try { validateRemote(this.profile.url); } catch { throw new StudioError(400, 'App 同步需要 HTTPS 远端；本地保存和提交仍可使用'); }
      if ((await this.rows()).length) throw new StudioError(409, '请先提交本地修改，再同步远端；未保存到 Git 的内容不会被覆盖');
      try {
        await git.fetch({ ...this.options, http: this.http, url: this.profile.url, remote: 'origin', ref: this.profile.branch,
          singleBranch: true, onAuth: this.credentials });
      } catch { throw new StudioError(502, '暂时无法连接 Git 远端，本地文件和提交已保留'); }
      let status = await this.statusUnlocked();
      if (status.diverged) throw new StudioError(409, '本地与远端都有新提交，请先在 Git 工具中合并；双方提交均已保留');
      if (status.behind && status.remoteHead) {
        await git.checkout({ ...this.options, ref: status.remoteHead, noUpdateHead: true, dryRun: true });
        await this.files.writeFile(this.journal + '.tmp', JSON.stringify({ before: status.head, target: status.remoteHead }));
        await this.files.rename(this.journal + '.tmp', this.journal);
        await git.checkout({ ...this.options, ref: status.remoteHead, noUpdateHead: true });
        await git.writeRef({ ...this.options, ref: `refs/heads/${this.profile.branch}`, value: status.remoteHead, force: true });
        await this.files.unlink(this.journal);
        status = await this.statusUnlocked();
      }
      if (status.ahead) {
        try {
          const pushed = await git.push({ ...this.options, http: this.http, url: this.profile.url, remote: 'origin', ref: this.profile.branch,
            force: false, onAuth: this.credentials });
          if (!pushed.ok) throw new Error('Push rejected');
        } catch { throw new StudioError(409, 'Git 推送未确认，请重试同步以核对远端；本地提交已保留'); }
      }
      await this.files.writeFile(this.stateRoot + '/last-sync', new Date().toISOString());
      return this.statusUnlocked();
    });
  }
}
