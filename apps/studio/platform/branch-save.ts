import './buffer.js';
import { commit, currentBranch, readCommit, readTree, resolveRef, writeBlob, writeTree, type FsClient, type TreeEntry } from 'isomorphic-git';
import { revisionOf } from '../core/portable.js';
import { StudioError } from '../core/errors.js';
import { validatePath } from '../shared/repository.js';
import { validateMediaPath } from '../core/media-validation.js';
import type { BranchFile, BranchSave } from '../shared/save.js';

/** Caller holds the workspace lock. This never reads the worktree or modifies the index/HEAD. */
export async function commitBranchSnapshot(options: { fs: FsClient; dir: string; author: { name: string; email: string } }, key: string, files: BranchFile[]): Promise<BranchSave> {
  validatePath(key);
  if (!options.author.name.trim() || !options.author.email.trim()) throw new StudioError(400, '请在连接设置中填写提交者名称和邮箱');
  if (!files.length) throw new StudioError(400, '没有可提交的内容修改');
  for (const file of files) {
    try { validatePath(file.path); } catch { validateMediaPath(file.path); }
  }
  const branch = 'studio/save-' + (await revisionOf(key)).slice(0, 24);
  if (await currentBranch(options) === branch) throw new StudioError(409, '请先切回工作区主分支，再使用分支保存');
  const ref = `refs/heads/${branch}`;
  let parent: string;
  let existing = true;
  try { parent = await resolveRef({ ...options, ref }); }
  catch (error) {
    if ((error as { code?: string }).code !== 'NotFoundError') throw error;
    parent = await resolveRef({ ...options, ref: 'HEAD' }); existing = false;
  }
  const original = (await readCommit({ ...options, oid: parent })).commit.tree;
  async function update(oid: string | undefined, entries: BranchFile[]): Promise<string> {
    const tree: TreeEntry[] = oid ? [...(await readTree({ ...options, oid })).tree] : [];
    const groups = new Map<string, BranchFile[]>();
    for (const entry of entries) {
      const [name, ...rest] = entry.path.split('/');
      const group = groups.get(name) ?? [];
      group.push({ ...entry, path: rest.join('/') }); groups.set(name, group);
    }
    for (const [name, group] of groups) {
      const index = tree.findIndex(entry => entry.path === name), before = tree[index];
      let next: TreeEntry | undefined;
      if (group[0].path) {
        if (before && before.type !== 'tree') throw new StudioError(409, '分支中的路径类型冲突，请在 Git 工具中处理');
        next = { path: name, type: 'tree', mode: '040000', oid: await update(before?.oid, group) };
      } else if (before && group[0].onlyIfMissing) {
        continue;
      } else if (group[0].data !== null) {
        if (before && (before.type !== 'blob' || before.mode === '120000')) throw new StudioError(409, '分支中的路径类型冲突，请在 Git 工具中处理');
        next = { path: name, type: 'blob', mode: before?.mode ?? '100644', oid: await writeBlob({ ...options, blob: group[0].data }) };
      }
      if (index >= 0) tree.splice(index, 1);
      if (next) tree.push(next);
    }
    return writeTree({ ...options, tree });
  }
  const tree = await update(original, files);
  if (tree === original && existing) return { branch, commit: parent };
  const oid = await commit({ ...options, ref, tree, parent: [parent], message: `content: save ${key}` });
  return { branch, commit: oid };
}

/** Must run under the same workspace lock as the branch commit. */
export async function assertBranchSnapshot(files: BranchFile[], read: (path: string) => Promise<Uint8Array | null>): Promise<void> {
  for (const file of files) {
    const current = await read(file.path);
    if (current === null && file.data === null) continue;
    if (!current || !file.data || current.length !== file.data.length || current.some((byte, index) => byte !== file.data![index])) {
      throw new StudioError(409, '文件在分支提交前已更新，请重新加载并合并修改');
    }
  }
}
