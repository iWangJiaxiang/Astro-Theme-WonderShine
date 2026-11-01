import './buffer';
import { currentBranch, getConfig } from 'isomorphic-git';
import { parse } from 'smol-toml';
import type { WorkspaceFiles } from './filesystem';
import { validateLocalPath, validateProfile, type WorkspaceProfile } from './hosting';

/** Read only: selecting a folder must never clone, checkout or replace its files. */
export async function inspectLocalRepository(files: WorkspaceFiles, directory: string): Promise<WorkspaceProfile> {
  const root = validateLocalPath(directory);
  const ordinary = async (path: string) => { const info = await files.lstat(path); return info.isDirectory() && !info.isSymbolicLink(); };
  try {
    if (!await ordinary(root) || !await ordinary(root + '/.git')) throw new Error();
  } catch { throw new Error('请选择包含 .git 目录的 Git 仓库；暂不支持 Git worktree 或符号链接'); }
  const options = { fs: { promises: files }, dir: root };
  const branch = await currentBranch(options);
  if (!branch) throw new Error('仓库处于 detached HEAD，请先切换到一个分支');
  try {
    if (!await ordinary(root + '/content')) throw new Error();
    parse(String(await files.readFile(root + '/config.toml', 'utf8')));
    parse(String(await files.readFile(root + '/data.toml', 'utf8')));
  } catch { throw new Error('请选择博客根目录，需要 content、config.toml 和 data.toml'); }
  const config = async (path: string) => String(await getConfig({ ...options, path }) || '');
  // Recovery state must remain discoverable even if the recent-list storage is cleared.
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(root))), byte => byte.toString(16).padStart(2, '0')).join('');
  const id = `${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`;
  return validateProfile({ id, source: 'local', localPath: root, label: root.split('/').at(-1)!, provider: 'generic',
    branch, url: await config('remote.origin.url'), username: '', authorName: await config('user.name'), authorEmail: await config('user.email') });
}
