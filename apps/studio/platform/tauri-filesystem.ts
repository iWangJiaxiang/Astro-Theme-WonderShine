import * as native from '@tauri-apps/plugin-fs';
import { StudioError } from '../core/errors';
import type { FileInfo, WorkspaceFiles } from './filesystem';

export function nativeFileInfo(value: native.FileInfo): FileInfo {
  const mtimeMs = value.mtime?.getTime() || 0;
  return { size: value.size, mtimeMs, ctimeMs: value.birthtime?.getTime() ?? mtimeMs,
    mode: value.mode ?? (value.isDirectory ? 0o40755 : 0o100644),
    dev: value.dev ?? 0, ino: value.ino ?? 0, uid: value.uid ?? 0, gid: value.gid ?? 0,
    isFile: () => value.isFile, isDirectory: () => value.isDirectory, isSymbolicLink: () => value.isSymlink };
}

/** App-scoped filesystem only. Repository symlinks are deliberately unsupported. */
export function tauriFiles(root: string, additionalRoots: string[] = []): WorkspaceFiles {
  const bases = [root, ...additionalRoots].map(value => value.replace(/\\/g, '/').replace(/\/$/, '')).sort((a, b) => b.length - a.length);
  function scoped(path: string): string {
    const normalized = path.replace(/\\/g, '/').split('/').filter(part => part !== '.').join('/').replace(/\/$/, '');
    if (!bases.some(base => normalized === base || normalized.startsWith(base + '/')) || normalized.split('/').some(part => part === '..' || part === '.') || normalized.includes('\0')) throw new Error('文件路径超出工作区');
    return normalized;
  }
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (cause) {
      if (cause instanceof StudioError) throw cause;
      const message = String(cause);
      const code = /not found|no such file|os error 2|系统找不到/i.test(message) ? 'ENOENT' : /already exists|os error 17/i.test(message) ? 'EEXIST' : 'EIO';
      throw Object.assign(new Error(message), { code });
    }
  }
  async function checked(path: string): Promise<{ path: string; info?: native.FileInfo }> {
    const result = scoped(path);
    const base = bases.find(base => result === base || result.startsWith(base + '/'))!;
    let info = await native.lstat(base);
    if (info.isSymlink) throw new StudioError(400, '不允许读写符号链接');
    let current = base;
    for (const part of result.slice(base.length).split('/').filter(Boolean)) {
      current += '/' + part;
      try { info = await native.lstat(current); if (info.isSymlink) throw new StudioError(400, '不允许读写符号链接'); }
      catch (error) { if (/not found|no such file|os error 2/i.test(String(error))) return { path: result }; throw error; }
    }
    // Metadata lives only for this operation; never cache a safety check across calls.
    return { path: result, info };
  }
  return {
    readFile: (path, options) => run(async () => { const bytes = await native.readFile((await checked(path)).path); return options === 'utf8' || typeof options === 'object' && options !== null && 'encoding' in options ? new TextDecoder().decode(bytes) : bytes; }),
    readCheckedFile: (path, limit) => run(async () => {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('文件大小限制无效');
      const location = await checked(path);
      if (!location.info) throw new Error('no such file');
      if (!location.info.isFile) throw new StudioError(400, '请选择文件');
      if (location.info.size > limit) throw new StudioError(413, '文件超过编辑或预览限制');
      const bytes = await native.readFile(location.path);
      if (bytes.byteLength > limit) throw new StudioError(413, '文件超过编辑或预览限制');
      return bytes;
    }),
    readCheckedDirectory: path => run(async () => (await native.readDir((await checked(path)).path)).map(item => ({
      name: item.name, isFile: item.isFile, isDirectory: item.isDirectory, isSymbolicLink: item.isSymlink,
    }))),
    writeFile: (path, data) => run(async () => native.writeFile((await checked(path)).path, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data))),
    readdir: path => run(async () => (await native.readDir((await checked(path)).path)).map(item => item.name)),
    mkdir: (path, options) => run(async () => native.mkdir((await checked(path)).path, options)),
    rmdir: path => run(async () => native.remove((await checked(path)).path)),
    unlink: path => run(async () => native.remove((await checked(path)).path)),
    rename: (from, to) => run(async () => native.rename((await checked(from)).path, (await checked(to)).path)),
    stat: path => run(async () => {
      const location = await checked(path);
      // A checked, non-symlink leaf already has exactly the metadata stat needs.
      if (!location.info) throw new Error('no such file');
      return nativeFileInfo(location.info);
    }),
    lstat: path => run(async () => nativeFileInfo(await native.lstat(scoped(path)))),
    readlink: async () => { throw new Error('工作区不支持符号链接'); },
    symlink: async () => { throw new Error('工作区不支持符号链接'); },
    chmod: async () => { /* Application sandbox owns file permissions; executable files are not content. */ },
  };
}
