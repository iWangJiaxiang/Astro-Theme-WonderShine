import * as native from '@tauri-apps/plugin-fs';
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
      const message = String(cause);
      const code = /not found|no such file|os error 2|系统找不到/i.test(message) ? 'ENOENT' : /already exists|os error 17/i.test(message) ? 'EEXIST' : 'EIO';
      throw Object.assign(new Error(message), { code });
    }
  }
  async function checked(path: string): Promise<string> {
    const result = scoped(path);
    const base = bases.find(base => result === base || result.startsWith(base + '/'))!;
    if ((await native.lstat(base)).isSymlink) throw new Error('工作区不允许符号链接');
    let current = base;
    for (const part of result.slice(base.length).split('/').filter(Boolean)) {
      current += '/' + part;
      try { if ((await native.lstat(current)).isSymlink) throw new Error('工作区不允许符号链接'); }
      catch (error) { if (/not found|no such file|os error 2/i.test(String(error))) break; throw error; }
    }
    return result;
  }
  return {
    readFile: (path, options) => run(async () => { const bytes = await native.readFile(await checked(path)); return options === 'utf8' || typeof options === 'object' && options !== null && 'encoding' in options ? new TextDecoder().decode(bytes) : bytes; }),
    writeFile: (path, data) => run(async () => native.writeFile(await checked(path), typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data))),
    readdir: path => run(async () => (await native.readDir(await checked(path))).map(item => item.name)),
    mkdir: (path, options) => run(async () => native.mkdir(await checked(path), options)),
    rmdir: path => run(async () => native.remove(await checked(path))),
    unlink: path => run(async () => native.remove(await checked(path))),
    rename: (from, to) => run(async () => native.rename(await checked(from), await checked(to))),
    stat: path => run(async () => nativeFileInfo(await native.stat(await checked(path)))),
    lstat: path => run(async () => nativeFileInfo(await native.lstat(scoped(path)))),
    readlink: async () => { throw new Error('工作区不支持符号链接'); },
    symlink: async () => { throw new Error('工作区不支持符号链接'); },
    chmod: async () => { /* Application sandbox owns file permissions; executable files are not content. */ },
  };
}
