import { fetch, listServerRefs, resolveRef } from 'isomorphic-git';
import { StudioError } from '../core/errors.js';
import { missingFile, type WorkspaceFiles } from './filesystem.js';

type WorkspaceFetch = Pick<Parameters<typeof fetch>[0], 'dir' | 'http' | 'url' | 'onAuth'> & {
  dir: string;
  url: string;
  branch: string;
};
type FetchFiles = Omit<WorkspaceFiles, 'mkdir'> & {
  mkdir(path: string): Promise<unknown>;
};

export async function fetchWorkspace(files: FetchFiles, { dir: directory, url, branch, ...network }: WorkspaceFetch, syncing: boolean) {
  const dir = directory.replaceAll('\\', '/');
  const options = { fs: { promises: files }, dir, url, remote: 'origin', ...network };
  const ref = `refs/heads/${branch}`;
  const tracking = `${dir}/.git/refs/remotes/origin/`;
  const shallow = dir + '/.git/shallow';
  let boundary = '';
  try { boundary = String(await files.readFile(shallow, 'utf8')).trim(); }
  catch (error) { if (!missingFile(error)) throw error; }

  if (!boundary) {
    await fetch({ ...options, ref: branch, remoteRef: ref, singleBranch: true });
    return;
  }

  let previous: string | undefined;
  try { previous = await resolveRef({ ...options, ref: 'refs/remotes/origin/' + branch }); }
  catch (error) { if ((error as { code?: string }).code !== 'NotFoundError') throw error; }
  const refs = await listServerRefs({ ...network, url, protocolVersion: 1, prefix: ref });
  const advertised = refs.find(entry => entry.ref === ref);
  if (!advertised) throw new StudioError(409, '远端分支不存在，本地文件和提交已保留');
  if (advertised.oid === previous && (!syncing || await resolveRef({ ...options, ref: 'HEAD' }) === previous)) return;

  // isomorphic-git saves refs and shallow markers before it finishes saving the pack.
  const pending = new Map<string, string | Uint8Array | null>();
  const metadata = (path: string) => path === shallow || path.startsWith(tracking);
  const staged: FetchFiles = Object.create(files);
  staged.writeFile = async (path, data, opts) => {
    if (metadata(path)) pending.set(path, data);
    else await files.writeFile(path, data, opts);
  };
  staged.unlink = async path => {
    if (metadata(path)) pending.set(path, null);
    else await files.unlink(path);
  };
  await fetch({ ...options, fs: { promises: staged }, ref: branch, remoteRef: ref, singleBranch: true, depth: 2_147_483_647 });
  const remaining = pending.get(shallow);
  if (remaining === undefined || remaining && String(remaining).trim()) {
    throw new StudioError(409, '远端未提供所需的 Git 历史，本地文件和提交已保留');
  }
  for (const [path, data] of pending) {
    if (data === null) {
      try { await files.unlink(path); } catch (error) { if (!missingFile(error)) throw error; }
    } else {
      const temp = path + '.studio-' + crypto.randomUUID() + '.lock';
      await files.writeFile(temp, data);
      try { await files.rename(temp, path); }
      finally { await files.unlink(temp).catch(() => {}); }
    }
  }
}
