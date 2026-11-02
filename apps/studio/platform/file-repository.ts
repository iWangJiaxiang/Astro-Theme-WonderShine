import type { Repository, RepositoryWrite, WriteGuard } from '../shared/repository';
import type { FileSnapshot, SaveResult } from '../shared/types';
import { imageMime, MAX_UPLOAD_SIZE, type MediaFile, type MediaListing, type MediaUploadResult } from '../shared/media';
import { isRepositoryPath } from '../shared/repository-path';
import { StudioError } from '../core/errors';
import { validateUpload, validateMediaPath } from '../core/media-validation';
import { ensureDirectory, missingFile, parentPath, type WorkspaceFiles } from './filesystem';
import { withWorkspaceLock } from './queue';

async function revision(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
interface JournalEntry { path: string; previous: string | null; next: string | null }
export class FileRepository implements Repository {
  readonly mode: 'local' | 'git' = 'local';
  constructor(readonly files: WorkspaceFiles, readonly root: string, private stateRoot: string, private assertWritable: () => Promise<void> = async () => {}) {}
  private check(path: string): string {
    if (!isRepositoryPath(path)) throw new StudioError(400, '不允许访问此文件路径');
    return this.root + '/' + path;
  }
  private async safe(path: string): Promise<string> {
    if (path.split('/').some(part => !part || part === '..' || part === '.')) throw new StudioError(400, '不允许访问此文件路径');
    let current = this.root;
    for (const part of path.split('/')) {
      current += '/' + part;
      try { if ((await this.files.lstat(current)).isSymbolicLink()) throw new StudioError(400, '不允许读写符号链接'); }
      catch (error) { if (missingFile(error)) break; throw error; }
    }
    return current === this.root + '/' + path ? current : this.root + '/' + path;
  }
  private async bytes(path: string, limit: number): Promise<Uint8Array | null> {
    const location = await this.safe(path);
    try {
      const stat = await this.files.stat(location);
      if (!stat.isFile()) throw new StudioError(400, '请选择文件');
      if (stat.size > limit) throw new StudioError(413, '文件超过编辑或预览限制');
      const data = await this.files.readFile(location);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      if (bytes.byteLength > limit) throw new StudioError(413, '文件超过编辑或预览限制');
      return bytes;
    } catch (error) { if (missingFile(error)) return null; throw error; }
  }
  async read(path: string): Promise<FileSnapshot | null> {
    this.check(path);
    const bytes = await this.bytes(path, 1024 * 1024);
    if (!bytes) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { path, text, revision: await revision(text) };
  }
  private async walk(directory: string, accept: (path: string) => boolean, limit = 20000): Promise<{ paths: string[]; truncated: boolean }> {
    const paths: string[] = []; let visited = 0, truncated = false;
    const visit = async (relative: string): Promise<void> => {
      let names: string[];
      try { names = await this.files.readdir(await this.safe(relative)); } catch (error) { if (missingFile(error)) return; throw error; }
      for (const name of names.sort()) {
        if (++visited > limit) { truncated = true; return; }
        if (name.startsWith('.') || ['node_modules', 'dist', 'processed_images'].includes(name)) continue;
        const path = relative + '/' + name;
        const info = await this.files.lstat(this.root + '/' + path);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await visit(path);
        else if (info.isFile() && accept(path)) paths.push(path);
        if (truncated) return;
      }
    };
    await visit(directory); return { paths, truncated };
  }
  async list(): Promise<FileSnapshot[]> {
    const paths: string[] = [];
    for (const kind of ['articles', 'pages', 'collections', 'threads', 'topics']) {
      const result = await this.walk('content/' + kind, isRepositoryPath);
      if (result.truncated) throw new StudioError(413, '仓库文件过多，请缩小工作区');
      paths.push(...result.paths);
    }
    return (await Promise.all(paths.map(path => this.read(path)))).filter((value): value is FileSnapshot => !!value);
  }
  async listMedia(): Promise<MediaListing> {
    const result: MediaListing = { items: [], truncated: false, maxFileSize: MAX_UPLOAD_SIZE };
    for (const directory of ['public', 'content']) {
      const listing = await this.walk(directory, path => { try { validateMediaPath(path); return !!imageMime(path); } catch { return false; } });
      result.truncated ||= listing.truncated;
      for (const path of listing.paths) {
        if (result.items.length >= 5000) { result.truncated = true; break; }
        const info = await this.files.stat(await this.safe(path));
        result.items.push({ path, directory: parentPath(path), name: path.split('/').at(-1)!, size: info.size, mime: imageMime(path)!,
          ...(info.size > MAX_UPLOAD_SIZE ? { unavailable: '图片超过 20 MB 预览限制' } : {}) });
      }
    }
    return result;
  }
  async readMedia(path: string): Promise<MediaFile | null> {
    validateMediaPath(path); const bytes = await this.bytes(path, MAX_UPLOAD_SIZE);
    return bytes ? { data: bytes, mime: imageMime(path)! } : null;
  }
  async uploadMedia(directory: string, name: string, data: Uint8Array): Promise<MediaUploadResult> {
    validateUpload(directory, name, data);
    return withWorkspaceLock(this.root, async () => {
      await this.assertWritable();
      const dot = name.lastIndexOf('.');
      const filename = `${name.slice(0, dot)}-${crypto.randomUUID()}${name.slice(dot)}`;
      const path = directory + '/' + filename;
      const file = await this.safe(path);
      await ensureDirectory(this.files, parentPath(file));
      await this.files.writeFile(file, data);
      return { item: { path, directory, name: filename, size: data.length, mime: imageMime(path)! }, message: '图片已保存到设备，提交并同步后可发布' };
    });
  }
  async recover(): Promise<void> {
    return withWorkspaceLock(this.root, async () => { await this.assertWritable(); await this.recoverUnlocked(); });
  }
  private async recoverUnlocked(): Promise<void> {
    const journal = this.stateRoot + '/transaction.json';
    let entries: JournalEntry[];
    try {
      const text = await this.files.readFile(journal, 'utf8');
      entries = JSON.parse(String(text)) as JournalEntry[];
      if (!Array.isArray(entries) || entries.some(entry => !isRepositoryPath(entry.path) || entry.previous !== null && typeof entry.previous !== 'string' || entry.next !== null && typeof entry.next !== 'string')) throw new Error('工作区恢复记录无效');
    } catch (error) { if (missingFile(error)) return; throw error; }
    // Preflight every file before rollback: external edits after a crash must survive.
    for (const entry of entries) {
      const current = (await this.read(entry.path))?.text ?? null;
      if (current !== entry.previous && current !== entry.next) throw new StudioError(409, '恢复时发现新的本地修改，请先备份并检查工作区；现有文件未被覆盖');
    }
    for (const entry of entries) {
      const file = await this.safe(entry.path);
      if (entry.previous === null) { try { await this.files.unlink(file); } catch (error) { if (!missingFile(error)) throw error; } }
      else { await ensureDirectory(this.files, parentPath(file)); await this.files.writeFile(file, entry.previous); }
    }
    await this.files.unlink(journal);
  }
  write(path: string, text: string | null, expectedRevision: string | null, guard?: WriteGuard): Promise<SaveResult> {
    return this.writeBatch([{ path, text, expectedRevision }], guard);
  }
  async writeBatch(entries: RepositoryWrite[], guard?: WriteGuard): Promise<SaveResult> {
    return withWorkspaceLock(this.root, async () => {
      await this.assertWritable();
      await this.recoverUnlocked();
      if (!entries.length || new Set(entries.map(entry => entry.path)).size !== entries.length) throw new StudioError(400, '保存列表包含重复或空路径');
      const backup: JournalEntry[] = [];
      for (const entry of entries) {
        this.check(entry.path);
        if (entry.text !== null && new TextEncoder().encode(entry.text).byteLength > 1024 * 1024) throw new StudioError(413, '文件超过 1 MB 编辑限制');
        const previous = await this.read(entry.path);
        if ((previous?.revision ?? null) !== entry.expectedRevision) throw new StudioError(409, '文件已更新，请重新加载并合并修改');
        if (entry.text === null && /\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(entry.path)) {
          const children = await this.files.readdir(await this.safe(parentPath(entry.path)));
          if (children.some(name => !/^_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(name))) throw new StudioError(409, '专栏或合集仍有子内容，不能删除');
        }
        backup.push({ path: entry.path, previous: previous?.text ?? null, next: entry.text });
      }
      if (guard) await guard(this);
      await ensureDirectory(this.files, this.stateRoot);
      const journal = this.stateRoot + '/transaction.json';
      await this.files.writeFile(journal + '.tmp', JSON.stringify(backup));
      await this.files.rename(journal + '.tmp', journal);
      try {
        for (const entry of entries) {
          const file = await this.safe(entry.path);
          if (entry.text === null) { try { await this.files.unlink(file); } catch (error) { if (!missingFile(error)) throw error; } }
          else { await ensureDirectory(this.files, parentPath(file)); await this.files.writeFile(file, entry.text); }
        }
        // Keep immutable history outside the Git worktree; it is never published.
        await this.files.rename(journal, this.stateRoot + `/history-${crypto.randomUUID()}.json`);
      } catch (error) { await this.recoverUnlocked(); throw error; }
      return { revision: entries[0].text === null ? '' : await revision(entries[0].text), message: '已保存到设备；提交并同步后更新 Git 仓库' };
    });
  }
}
