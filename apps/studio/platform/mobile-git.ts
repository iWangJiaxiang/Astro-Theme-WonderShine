import { Channel, invoke } from '@tauri-apps/api/core';
import type { GitProgressEvent, ProgressCallback } from 'isomorphic-git';
import { StudioError } from '../core/errors';
import { validateMediaPath } from '../core/media-validation';
import { validatePath } from '../shared/repository';
import type { BranchFile, BranchSave } from '../shared/save';
import type { ReviewRow, WorkspaceReviewAdapter } from '../shared/workspace-confirmation';
import type { WorkspaceStatus } from '../shared/workspace';
import { missingFile, type WorkspaceFiles } from './filesystem';
import type { WorkspaceProfile } from './hosting';
import { withWorkspaceLock } from './queue';

type Inspection = Pick<WorkspaceStatus, 'head' | 'remoteHead' | 'ahead' | 'behind'> & { rows: ReviewRow[] };
function managed(path: string) {
  try { validatePath(path); return true; } catch { /* Try media. */ }
  try { validateMediaPath(path); return true; } catch { return false; }
}

function gitError(reason: unknown) {
  if (reason && typeof reason === 'object' && 'message' in reason && typeof reason.message === 'string'
    && 'gitDetail' in reason && typeof reason.gitDetail === 'string' && /^libgit2 (fetch|push) [A-Za-z]+\/[A-Za-z]+$/.test(reason.gitDetail)) {
    return new StudioError(409, reason.message, { gitDetail: reason.gitDetail });
  }
  return new StudioError(409, typeof reason === 'string' ? reason : '操作失败');
}

export function mobileGit(files: WorkspaceFiles, root: string, state: string, profile: WorkspaceProfile,
  password: () => string, reviews: WorkspaceReviewAdapter) {
  const owner = {};
  let handoff: { after: 'review' | 'commit'; paths: string[] } | undefined;
  async function command<T>(action: string, args: Record<string, unknown> = {}, progress?: ProgressCallback): Promise<T> {
    const channel = progress && new Channel<GitProgressEvent>(progress);
    try {
      return await invoke<T>('mobile_git', { profile, job: { action, ...args }, progress: channel ?? null,
        password: action === 'publish' || action === 'sync' || action === 'open' && args.clone ? password() : null });
    } catch (reason) { throw gitError(reason); }
  }
  const inspect = (paths?: string[], writable = false) => command<Inspection>('inspect', { paths, writable });
  function reviewState(current: Inspection) {
    return { scope: 'native:' + root, branch: profile.branch, head: current.head, rows: current.rows.filter(([path]) => managed(path)) };
  }
  async function status(current: Inspection): Promise<WorkspaceStatus> {
    const { rows, ...refs } = current;
    let lastSync = null;
    try { lastSync = String(await files.readFile(state + '/last-sync', 'utf8')); }
    catch (error) { if (!missingFile(error)) throw error; }
    return { ...refs, branch: profile.branch, lastSync, canSync: true, canMerge: true, diverged: refs.ahead > 0 && refs.behind > 0,
      changes: rows.length, dirty: !!rows.length, managedChanges: reviewState(current).rows.map(([path]) => path) };
  }
  // The connection owns a private checkout. Another lock holder, an error, an
  // explicit refresh or a reopened session invalidates the changed-path list.
  function run<T>(after: 'review' | 'commit' | null, operation: (paths?: string[]) => Promise<T>) {
    return withWorkspaceLock(root, uninterrupted => {
      const paths = uninterrupted && handoff?.after === after ? handoff?.paths : undefined;
      handoff = undefined;
      return operation(paths);
    }, owner);
  }
  async function validate(current: Inspection, confirmation?: string) {
    if (!confirmation) throw new StudioError(400, '工作区已变化，请刷新并重新确认提交范围');
    await reviews.store.validateReview(confirmation, reviewState(current), reviews.source);
  }
  function commit(message: string, confirmation: string | undefined, followUp: boolean) {
    return run('review', async paths => {
      const current = await inspect(paths, true);
      await validate(current, confirmation);
      await command('commit', { head: current.head, message, paths: reviewState(current).rows.map(([path]) => path) });
      const candidates = current.rows.map(([path]) => path);
      if (followUp) { handoff = { after: 'commit', paths: candidates }; return; }
      return status(await inspect(candidates));
    });
  }
  return {
    async open(progress?: ProgressCallback, allowClone = true) {
      profile.branch = await run(null, () => command<string>('open', { clone: allowClone }, progress));
    },
    // FileRepository already holds the workspace lock.
    assertWritable: () => command<void>('guard'),
    status: () => run(null, async () => status(await inspect())),
    createReview: () => run('commit', async paths => {
      const current = await inspect(paths, true);
      const result = await reviews.store.createReview(reviewState(current), reviews.source);
      const view = await status(current);
      handoff = { after: 'review', paths: current.rows.map(([path]) => path) };
      return { ...view, canPublish: true, confirmation: result.confirmation, confirmationExpiresAt: result.expiresAt };
    }),
    commit: async (message: string, confirmation?: string) => (await commit(message, confirmation, false))!,
    commitForReview: async (message: string, confirmation: string) => { await commit(message, confirmation, true); },
    publish: (message: string, confirmation: string) => run('review', async paths => {
      const current = await inspect(paths, true);
      await validate(current, confirmation);
      const managed = reviewState(current).rows;
      if (managed.length !== current.rows.length) throw new StudioError(409, '存在托管范围以外的修改，请先在 Git 工具中处理再同步。');
      const result = await command<{ syncError?: unknown }>('publish', { head: current.head, message, paths: managed.map(([path]) => path) });
      if (result.syncError) throw gitError(result.syncError);
      // A bookkeeping failure after a confirmed push must not turn it into an upload retry.
      await files.writeFile(state + '/last-sync', new Date().toISOString()).catch(() => {});
    }),
    sync: (confirmation?: string) => run('review', async paths => {
      const current = await inspect(paths, true);
      await validate(current, confirmation);
      if (current.rows.length) throw new StudioError(409, '请先提交本地修改，再同步远端；未保存到 Git 的内容不会被覆盖');
      const checkedOut = await command<boolean>('sync', { head: current.head });
      await files.writeFile(state + '/last-sync', new Date().toISOString());
      return status(await inspect(checkedOut ? undefined : []));
    }),
    saveBranch: (key: string, files: BranchFile[]) => run(null, async () => {
      validatePath(key);
      const expected = [];
      for (const { path, data, onlyIfMissing } of files) {
        if (!managed(path)) throw new StudioError(400, '不允许访问此文件路径');
        const bytes = data && new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));
        expected.push({ path, digest: bytes && Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''), onlyIfMissing });
      }
      return command<BranchSave>('branch', { key, files: expected });
    }),
  };
}
