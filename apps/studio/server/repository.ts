import type { MediaFile, MediaListing, MediaUploadResult } from '../shared/media.js';
import { uploadMediaFile } from './media-upload.js';
import { listMediaFiles, readMediaFile } from './media-files.js';
import type { FileSnapshot, SaveResult } from '../shared/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { StudioError } from './errors.js';
import { contentRevisions, type RevisionRegistry, type SnapshotRevisionStrategy } from '../core/revision.js';
import { DiskRevisionStore } from './revision-store.js';

export const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex');
export { validatePath } from '../shared/repository.js';
export type { Repository, RepositoryWrite, WriteGuard } from '../shared/repository.js';
import { validatePath, type Repository, type RepositoryWrite, type WriteGuard } from '../shared/repository.js';
export class LocalRepository implements Repository {
  readonly mode = 'local';
  constructor(public root: string, private snapshotRevisions?: SnapshotRevisionStrategy, private revisions?: RevisionRegistry) {
    // Explicit in-memory injection is reserved for adapters/tests. Node defaults
    // must work across workers and restarts, including direct constructor users.
    if (!snapshotRevisions && !revisions) this.snapshotRevisions = new DiskRevisionStore(root);
  }
  get saveScope() { return resolve(this.root); }
  private async revision(path: string, text: string): Promise<string> {
    return await this.snapshotRevisions?.revision(path, text)
      ?? (this.revisions ?? contentRevisions).revision('local:' + await realpath(resolve(this.root)), path, text);
  }
  private async safePath(path: string): Promise<string> {
    validatePath(path);
    const root = await realpath(resolve(this.root));
    let current = root;
    for (const part of path.split('/')) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new StudioError(400, '不允许读写符号链接');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return current;
  }
  private async readText(path: string): Promise<Pick<FileSnapshot, 'path' | 'text'> | null> {
    const file = await this.safePath(path);
    try {
      const info = await lstat(file);
      if (!info.isFile()) throw new StudioError(400, '请选择文件');
      if (info.size > 1024 * 1024) throw new StudioError(413, '文件超过 1 MB 编辑限制');
      const bytes = await readFile(file);
      if (bytes.byteLength > 1024 * 1024) throw new StudioError(413, '文件超过 1 MB 编辑限制');
      return { path, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async read(path: string): Promise<FileSnapshot | null> {
    const file = await this.readText(path);
    return file ? { ...file, revision: await this.revision(path, file.text) } : null;
  }
  async list(): Promise<FileSnapshot[]> { return this.listFiles(path => this.read(path)); }
  async listForSummary(): Promise<Pick<FileSnapshot, 'path' | 'text'>[]> { return this.listFiles(path => this.readText(path)); }
  private async listFiles<T>(read: (path: string) => Promise<T | null>): Promise<T[]> {
    const files: T[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(join(this.root, directory), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith('.md')) { const file = await read(path); if (file) files.push(file); }
      }
    };
    for (const kind of ['articles', 'pages', 'collections', 'threads', 'topics']) {
      // Check the top directory too, so a symlink cannot be used to list secrets.
      await this.safePath(`content/${kind}/placeholder.md`);
      await walk(`content/${kind}`);
    }
    return files;
  }
  async listMedia(): Promise<MediaListing> { return listMediaFiles(this.root); }
  async readMedia(path: string): Promise<MediaFile | null> { return readMediaFile(this.root, path); }
  async uploadMedia(directory: string, name: string, data: Uint8Array): Promise<MediaUploadResult> { return uploadMediaFile(this.root, directory, name, data); }
  async write(path: string, text: string | null, expectedRevision: string | null, guard?: WriteGuard): Promise<SaveResult> {
    return this.writeBatch([{ path, text, expectedRevision }], guard);
  }
  async writeBatch(entries: RepositoryWrite[], guard?: WriteGuard): Promise<SaveResult> {
    if (!entries.length || new Set(entries.map(entry => entry.path)).size !== entries.length) throw new StudioError(400, '保存列表包含重复或空路径');
    for (const entry of entries) {
      await this.safePath(entry.path);
      if (entry.text !== null && Buffer.byteLength(entry.text) > 1024 * 1024) throw new StudioError(413, '文件超过 1 MB 编辑限制');
    }
    const lock = join(this.root, '.studio-write-lock');
    let acquired = false;
    for (let i = 0; i < 80; i++) {
      try { await mkdir(lock); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise(r => setTimeout(r, 25));
      }
    }
    if (!acquired) throw new StudioError(423, '另一个保存任务正在执行，请稍后重试');
    try {
      const staged: { file: string; temporary: string; previous: FileSnapshot | null; text: string | null }[] = [];
      try {
        // All revisions and guards are checked before any content is changed.
        for (const { path, text, expectedRevision } of entries) {
          const file = await this.safePath(path);
          const previous = await this.read(path);
          if ((previous?.revision ?? null) !== expectedRevision) throw new StudioError(409, '文件已更新，请重新加载并合并修改');
          if (/\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(path) && text === null) {
            const children = await readdir(dirname(file));
            if (children.some(p => !/^_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(p))) throw new StudioError(409, '专栏或合集仍有子内容，不能删除');
          }
          staged.push({ file, temporary: `${file}.${randomUUID()}.tmp`, previous, text });
        }
        if (guard) await guard(this);
        for (const { file, temporary, previous, text } of staged) {
          if (previous) {
            const history = join(this.root, '.studio-history');
            const backup = join(history, revisionOf(previous.path));
            for (const directory of [history, backup]) {
              try { if ((await lstat(directory)).isSymbolicLink()) throw new StudioError(400, '历史备份不允许使用符号链接'); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
              await mkdir(directory, { recursive: true, mode: 0o700 });
            }
            // Immutable backups: exclusive creation must never follow an existing symlink.
            try { await writeFile(join(backup, `${randomUUID()}.txt`), previous.text, { mode: 0o600, flag: 'wx' }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          }
          if (text !== null) {
            await mkdir(dirname(file), { recursive: true });
            await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
          }
        }
        const applied: typeof staged = [];
        try {
          for (const item of staged) {
            if (item.text === null) await rm(item.file, { force: true });
            else await rename(item.temporary, item.file);
            applied.push(item);
          }
          // Revision publication is part of the transaction: a failed durable
          // baseline must never masquerade as a failed save after content changed.
          const text = entries[0].text;
          return { revision: text === null ? '' : await this.revision(entries[0].path, text), message: '已保存到站点文件；需要构建后更新公开网站' };
        } catch (error) {
          // Recover completed mutations while still holding the repository lock.
          let recoveryFailed = false;
          for (const item of applied.reverse()) {
            try {
              if (item.previous) {
                await writeFile(item.temporary, item.previous.text, { mode: 0o600 });
                await rename(item.temporary, item.file);
              } else await rm(item.file, { force: true });
            } catch { recoveryFailed = true; }
          }
          if (recoveryFailed) throw new StudioError(500, '保存或版本记录失败，部分文件回滚未完成；结果不确定，请备份并重新读取文件后检查，勿重复覆盖');
          throw error;
        }
      } finally { for (const item of staged) await rm(item.temporary, { force: true }); }
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
}
