import { currentBranch, findMergeBase, resolveRef, writeRef, type FsClient } from 'isomorphic-git';
import { StudioError } from '../core/errors.js';
import { workspaceChanged } from '../shared/workspace-confirmation.js';

export async function uncommitBranch(options: { fs: FsClient; dir: string }, branch: string, head: string, remote: string, diverged: boolean) {
  const bases = diverged ? await findMergeBase({ ...options, oids: [head, remote] }) : [remote];
  if (bases.length !== 1) throw new StudioError(409, '找不到唯一的共同版本，请在 Git 工具中处理。');
  const ref = 'refs/heads/' + branch;
  if (await currentBranch(options) !== branch || await resolveRef({ ...options, ref }) !== head ||
      await resolveRef({ ...options, ref: 'refs/remotes/origin/' + branch }) !== remote) throw new StudioError(409, workspaceChanged);
  await writeRef({ ...options, ref: 'refs/wondershine/recovery/' + head, value: head, force: true });
  await writeRef({ ...options, ref, value: bases[0], force: true });
}
