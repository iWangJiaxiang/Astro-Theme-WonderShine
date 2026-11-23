import { discardState } from '../shared/workspace-discard.js';
import { discardFiles, discardRows } from '../platform/discard-files.js';
import { mergeTarget } from '../platform/merge-target.js';
import { assertThemeCommit } from '../platform/theme-commit.js';
import type { ThemeCommit } from '../shared/theme-update.js';
import { commitBranchSnapshot, assertBranchSnapshot } from '../platform/branch-save.js';
import fs from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import git, { type StatusRow } from 'isomorphic-git';
import type { Repository, RepositoryWrite, WriteGuard } from '../shared/repository.js';
import type { WorkspaceControl, WorkspaceStatus } from '../shared/workspace.js';
import { LocalRepository, validateRepositoryPath } from './repository.js';
import { DiskRevisionStore } from './revision-store.js';
import { safeMediaPath, validateMediaPath } from './media-files.js';
import { validateUpload } from './media-upload.js';
import { gitHttp, validateGitOptions, type GitOptions } from './git-repository.js';
import { StudioError } from './errors.js';
import { requireWorkspaceConfirmation, type ReviewState } from '../shared/workspace-confirmation.js';
import { nodeReviewSource, nodeWorkspaceReviews } from './review-store.js';
import { fetchWorkspace } from '../platform/fetch-workspace.js';

function managed(path: string): boolean {
  try { validateRepositoryPath(path); return true; } catch { /* Try media paths next. */ }
  try { validateMediaPath(path); return true; } catch { return false; }
}
const internal = (path: string) => path === '.studio-history' || path.startsWith('.studio-history/') || path === '.studio-write-lock' || path.startsWith('.studio-write-lock/');

/** Persistent checkout. Saving never contacts the remote; synchronization is explicit. */
export class GitWorkspaceRepository implements Repository {
  readonly mode = 'git';
  readonly workspace: WorkspaceControl;
  private readonly root: string;
  private readonly local: LocalRepository;
  private readonly http;
  private readonly auth;

  constructor(private readonly options: GitOptions & { directory: string; revisionDirectory?: string }) {
    validateGitOptions(options);
    this.root = resolve(options.directory);
    if (this.root === dirname(this.root)) throw new Error('Git 工作区不能使用文件系统根目录');
    this.local = new LocalRepository(this.root, new DiskRevisionStore(this.root, { directory: options.revisionDirectory }));
    this.http = gitHttp(options.url);
    this.auth = () => ({ username: options.username, password: options.token });
    this.workspace = {
      saveBranch: (key, files) => this.run(async () => {
        await this.mutable();
        await this.assertGitIdle();
        await assertBranchSnapshot(files, async path => {
          let content = true;
          try { validateRepositoryPath(path); } catch { content = false; }
          if (!content) return (await this.local.readMedia(path))?.data ?? null;
          const file = await this.local.read(path);
          return file ? new TextEncoder().encode(file.text) : null;
        });
        return commitBranchSnapshot({ ...this.gitOptions, author: { name: this.options.name, email: this.options.email } }, key, files);
      }),
      checkRemote: () => this.run(async () => {
        await this.fetchRemote();
        const { ahead, behind } = await this.branchStatus({});
        return { ahead, behind };
      }),
      status: () => this.run(() => this.status()),
      createReview: () => this.run(() => this.createReview()),
      commit: (message, confirmation) => this.run(() => this.commit(message, confirmation)),
      commitForReview: (message, confirmation) => this.run(async () => {
        await this.commitFiles(message, requireWorkspaceConfirmation(confirmation));
      }),
      publish: (message, confirmation) => this.run(async () => {
        await this.commitFiles(message, requireWorkspaceConfirmation(confirmation), undefined, true);
        await this.sync();
      }),
      reviewDiscard: () => this.run(() => this.discard()),
      discard: token => this.run(() => this.discard(requireWorkspaceConfirmation(token))),
      commitTheme: change => this.run(() => this.commitFiles(change.message, undefined, change)),
      sync: confirmation => this.run(() => this.sync(confirmation)),
    };
  }

  get saveScope() { return this.root + ':' + this.options.branch; }
  private get gitOptions() { return { fs, dir: this.root }; }
  private get remoteRef() { return `refs/remotes/origin/${this.options.branch}`; }
  private get journal() { return join(this.root, '.git', 'wondershine-sync.json'); }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.root), { recursive: true });
    const lock = `${this.root}.studio-lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!acquired) throw new StudioError(423, '工作区正在保存或同步，请稍后重试');
    try { await this.open(); return await operation(); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }

  private async open(): Promise<void> {
    let exists = false;
    try {
      const stat = await lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StudioError(400, 'Git 工作区必须是普通目录，不能使用符号链接');
      exists = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let hasGit = false;
    if (exists) {
      try {
        const stat = await lstat(join(this.root, '.git'));
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StudioError(400, '工作区不支持符号链接或外部 Git 目录');
        hasGit = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!hasGit) {
      if (exists && (await readdir(this.root)).length) throw new StudioError(409, '工作区目录已有文件，请选择空目录或匹配的 Git 仓库');
      const staging = await mkdtemp(`${this.root}.clone-`);
      try {
        await git.clone({ fs, http: this.http, dir: staging, url: this.options.url, ref: this.options.branch, singleBranch: true, depth: 1, noTags: true, onAuth: this.auth });
        // The destination is empty, and it remains untouched until the complete clone is ready.
        await rename(staging, this.root);
      } catch (error) {
        if (error instanceof StudioError) throw error;
        throw new StudioError(502, '首次下载 Git 工作区失败，请检查连接；已有文件未被替换');
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    const origin = await git.getConfig({ ...this.gitOptions, path: 'remote.origin.url' });
    const branch = await git.currentBranch(this.gitOptions);
    if (origin !== this.options.url || branch !== this.options.branch) throw new StudioError(409, '本地仓库的地址或分支与工作区配置不一致，请检查配置');
  }

  private async mutable(): Promise<void> {
    try { await lstat(this.journal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new StudioError(409, '上次同步中断，请先在本地检查 Git 工作区并完成恢复；现有内容已保留');
  }

  private async assertGitIdle() {
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'index.lock']) {
      try { await lstat(join(this.root, '.git', marker)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new StudioError(409, 'Git 操作尚未完成，请先在 Git 工具中完成合并、变基或其他操作');
    }
  }

  private async rows(cache = {}) {
    return (await git.statusMatrix({ ...this.gitOptions, cache, refresh: false, filter: path => !internal(path) }))
      .filter(([, head, worktree, stage]) => head !== worktree || head !== stage);
  }
  private async createReview(): Promise<WorkspaceStatus> {
    await this.mutable();
    await this.assertGitIdle();
    const { status, review } = await this.inspect();
    const result = await nodeWorkspaceReviews(this.root).createReview(review, nodeReviewSource(this.root));
    return { ...status, canPublish: true, confirmation: result.confirmation, confirmationExpiresAt: result.expiresAt };
  }
  private async validateReview(confirmation: string, rows: StatusRow[]) {
    const head = await git.resolveRef({ ...this.gitOptions, ref: 'HEAD' });
    const review: ReviewState = { scope: 'server:' + this.root, branch: this.options.branch, head, rows: rows.filter(([path]) => managed(path)) };
    await nodeWorkspaceReviews(this.root).validateReview(confirmation, review, nodeReviewSource(this.root));
    if (JSON.stringify(rows) !== JSON.stringify(await this.rows())) throw new StudioError(409, '工作区已变化，请刷新并重新确认提交范围');
  }
  private async status(): Promise<WorkspaceStatus> { return (await this.inspect()).status; }
  private async branchStatus(cache: object) {
    const head = await git.resolveRef({ ...this.gitOptions, ref: 'HEAD' });
    let remoteHead: string | null = null;
    try { remoteHead = await git.resolveRef({ ...this.gitOptions, ref: this.remoteRef }); } catch { /* A local branch may not have a remote tip yet. */ }
    let ahead = 0, behind = 0;
    if (remoteHead !== head) {
      const localHistory = new Set((await git.log({ ...this.gitOptions, cache, ref: head })).map(entry => entry.oid));
      const remoteHistory = new Set(remoteHead ? (await git.log({ ...this.gitOptions, cache, ref: remoteHead })).map(entry => entry.oid) : []);
      ahead = [...localHistory].filter(oid => !remoteHistory.has(oid)).length;
      behind = [...remoteHistory].filter(oid => !localHistory.has(oid)).length;
    }
    return { head, remoteHead, ahead, behind };
  }
  private async inspect(): Promise<{ status: WorkspaceStatus; review: ReviewState }> {
    // In isomorphic-git 1.44.4, logs populate only the pack cache. Share it with
    // one final matrix, then discard: never carry its index cache across mutations.
    const cache = {};
    const { head, remoteHead, ahead, behind } = await this.branchStatus(cache);
    let lastSync: string | null = null;
    try { lastSync = await readFile(join(this.root, '.git', 'wondershine-last-sync'), 'utf8'); } catch { /* Never synchronized yet. */ }
    const rows = await this.rows(cache);
    const managedChanges = rows.filter(([path]) => managed(path)).map(([path]) => path);
    const changes = rows.length;
    return {
      status: { branch: this.options.branch, dirty: changes > 0, changes, head, remoteHead, ahead, behind, diverged: ahead > 0 && behind > 0, lastSync, canDiscard: true, canMerge: true, managedChanges },
      review: { scope: 'server:' + this.root, branch: this.options.branch, head, rows: rows.filter(([path]) => managed(path)) },
    };
  }

  private async discard(token?: string): Promise<WorkspaceStatus> {
    await this.mutable();
    await this.assertGitIdle();
    const rows = await discardRows(this.gitOptions);
    const status = await this.status();
    const state = await discardState({ scope: 'server:' + this.root, head: status.head, branch: status.branch, rows },
      await readFile(join(this.root, '.git', 'index')));
    const store = nodeWorkspaceReviews(this.root), source = nodeReviewSource(this.root);
    if (token === undefined) {
      const review = await store.createReview(state, source);
      return { ...status, discardPaths: rows.map(([path]) => path), confirmation: review.confirmation };
    }
    await store.validateReview(token, state, source);
    for (const [path] of rows) await safeMediaPath(this.root, path);
    await discardFiles(this.gitOptions, rows);
    return this.status();
  }

  private async commit(message: string, confirmation?: string): Promise<WorkspaceStatus> {
    await this.commitFiles(message, confirmation);
    return this.status();
  }

  private async commitFiles(message: string, confirmation?: string, theme?: ThemeCommit, publishing = false): Promise<string> {
    await this.mutable();
    await this.assertGitIdle();
    if (typeof message !== 'string' || !message.trim() || message.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) throw new StudioError(400, '请输入不超过 500 字的提交说明');
    const rows = await this.rows();
    if (confirmation !== undefined) await this.validateReview(confirmation, rows);
    if ((await git.listFiles(this.gitOptions)).some(internal)) throw new StudioError(409, 'Git 暂存区包含创作中心备份文件，请先在 Git 工具中处理');
    // Existing staged source/config changes must never silently enter a content commit.
    const included = (path: string) => theme ? theme.files.some(file => file.path === path) : managed(path);
    if (rows.some(([path, head, , stage]) => (theme || !included(path)) && head !== stage)) throw new StudioError(409, '暂存区含有创作中心以外的文件，请先在 Git 工具中处理');
    if (publishing && rows.some(([path]) => !managed(path))) throw new StudioError(409, '存在托管范围以外的修改，请先在 Git 工具中处理再同步。');
    const entries = rows.filter(([path]) => included(path));
    if (!entries.length) throw new StudioError(409, '没有可提交的内容修改');
    for (const [path] of entries) await safeMediaPath(this.root, path);
    if (theme) await assertThemeCommit(this.gitOptions, theme, path => readFile(join(this.root, path)));
    for (const [path, , worktree] of entries) {
      if (!worktree) await git.remove({ ...this.gitOptions, filepath: path });
      else await git.add({ ...this.gitOptions, filepath: path });
    }
    return git.commit({ ...this.gitOptions, message: message.trim(), author: { name: this.options.name, email: this.options.email } });
  }

  private async fetchRemote(syncing = false) {
    try {
      await fetchWorkspace(fs.promises, { dir: this.root, http: this.http, url: this.options.url,
        branch: this.options.branch, onAuth: this.auth }, syncing);
    } catch (error) {
      if (error instanceof StudioError) throw error;
      throw new StudioError(502, '暂时无法连接 Git 远端，本地文件和提交已保留');
    }
  }

  private async sync(confirmation?: string): Promise<WorkspaceStatus> {
    await this.mutable();
    await this.assertGitIdle();
    const rows = await this.rows();
    if (confirmation !== undefined) await this.validateReview(confirmation, rows);
    if (rows.length) throw new StudioError(409, '请先提交本地修改，再同步远端；未保存到 Git 的内容不会被覆盖');
    await this.fetchRemote(true);
    let status = await this.status();
    if (status.behind && status.remoteHead) {
      const target = status.diverged && status.head
        ? await mergeTarget(fs, this.root, status.head, status.remoteHead, { name: this.options.name, email: this.options.email })
        : status.remoteHead;
      // Detect collisions before changing either the branch or working files.
      await git.checkout({ ...this.gitOptions, ref: target, noUpdateHead: true, dryRun: true });
      await writeFile(this.journal, JSON.stringify({ before: status.head, target }), { flag: 'wx', mode: 0o600 });
      await git.checkout({ ...this.gitOptions, ref: target, noUpdateHead: true });
      await git.writeRef({ ...this.gitOptions, ref: `refs/heads/${this.options.branch}`, value: target, force: true });
      await rm(this.journal);
      status = await this.status();
    }
    if (status.ahead) {
      try {
        const result = await git.push({ ...this.gitOptions, http: this.http, url: this.options.url, remote: 'origin', ref: this.options.branch, onAuth: this.auth, force: false });
        if (!result.ok) throw new Error('Push rejected');
      } catch { throw new StudioError(409, 'Git 推送未确认，请重试同步以核对远端；本地提交已保留'); }
    }
    await writeFile(join(this.root, '.git', 'wondershine-last-sync'), new Date().toISOString(), { mode: 0o600 });
    return this.status();
  }

  read(path: string) { return this.run(() => this.local.read(path)); }
  list() { return this.run(() => this.local.list()); }
  listForSummary() { return this.run(() => this.local.listForSummary()); }
  listMedia() { return this.run(() => this.local.listMedia()); }
  readMedia(path: string) { return this.run(() => this.local.readMedia(path)); }
  uploadMedia(directory: string, name: string, data: Uint8Array) {
    validateUpload(directory, name, data);
    return this.run(async () => { await this.mutable(); return this.local.uploadMedia(directory, name, data); });
  }
  write(path: string, text: string | null, expectedRevision: string | null, guard?: WriteGuard) {
    return this.writeBatch([{ path, text, expectedRevision }], guard);
  }
  writeBatch(entries: RepositoryWrite[], guard?: WriteGuard) {
    return this.run(async () => {
      await this.mutable();
      const result = await this.local.writeBatch(entries, guard);
      return { ...result, message: '已保存到本地工作区；提交并同步后才会更新 Git 远端' };
    });
  }
}
