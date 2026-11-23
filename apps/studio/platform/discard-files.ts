import { checkout, getConfig, hashBlob, isIgnored, remove, STAGE, TREE, walk, WORKDIR, type FsClient, type StatusRow } from 'isomorphic-git';
import { StudioError } from '../core/errors.js';

type GitDirectory = { fs: FsClient; dir: string };
const unsupported = () => new StudioError(409, '此工作区包含无法安全还原的路径，请使用 Git 工具处理。');

/** statusMatrix can reuse an index OID for same-size edits within one second.
 * Destructive reviews compare the actual bytes even when Git's stat cache hits. */
export async function discardRows(options: GitDirectory): Promise<StatusRow[]> {
  const fileMode = await getConfig({ ...options, path: 'core.filemode' });
  return walk({ ...options, trees: [TREE({ ref: 'HEAD' }), WORKDIR({ refresh: false }), STAGE()],
    map: async (path, [head, work, stage]) => {
      if (path === '.') return;
      if (['.studio-history', '.studio-write-lock', '.git'].includes(path.split('/')[0])) return null;
      // A nested repository owns its untracked files and its separate history.
      if (path.split('/').some(part => part.toLowerCase() === '.git')) throw unsupported();
      if (!head && !stage && await isIgnored({ ...options, filepath: path })) return null;
      const types = await Promise.all([head?.type(), work?.type(), stage?.type()]);
      if (types.includes('commit')) return null; // Submodule checkouts are independent repositories.
      if (types.every(type => !type || type === 'tree')) return;
      if (types.some(type => type && type !== 'blob')) throw unsupported();
      const [headMode, workMode, stageMode] = await Promise.all([head?.mode(), work?.mode(), stage?.mode()]);
      const workingBytes = work && (head || stage) ? await work.content() : undefined;
      const workingOid = workingBytes ? (await hashBlob({ object: workingBytes })).oid : work ? 'untracked' : undefined;
      const keys = [undefined, await head?.oid(), workingOid, await stage?.oid()];
      if (String(fileMode) !== 'false') {
        for (const [i, mode] of [headMode, workMode, stageMode].entries()) {
          if (keys[i + 1]) keys[i + 1] += ':' + mode;
        }
      }
      const [h, w, s] = keys.slice(1).map(key => keys.indexOf(key));
      if (h === w && h === s) return;
      if ([headMode, workMode, stageMode].some(mode => mode && ![0o100644, 0o100755].includes(mode))) throw unsupported();
      return [path, h, w, s];
    },
    // Keep at most one working blob in flight when reviewing a large checkout.
    iterate: async (walkEntry, entries) => {
      const results = [];
      for (const entry of entries) results.push(await walkEntry(entry));
      return results;
    },
  });
}

export async function discardFiles(options: GitDirectory, rows: StatusRow[]) {
  if (!rows.length) return;
  const restore = { ...options, ref: 'HEAD', filepaths: rows.map(([path]) => path), force: true, noUpdateHead: true };
  await checkout({ ...restore, dryRun: true });
  // Removing only the reviewed tracked entries forces checkout to read their
  // worktree bytes instead of reusing the same racy index OIDs.
  for (const [path, head, , stage] of rows) {
    if (head && stage) await remove({ ...options, filepath: path });
  }
  await checkout(restore);
}
