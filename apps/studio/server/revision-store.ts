import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, isAbsolute } from 'node:path';
import type { SnapshotRevisionStrategy } from '../core/revision.js';
import { StudioError } from './errors.js';
import { validatePath } from '../shared/repository.js';

export interface DiskRevisionOptions {
  directory?: string;
  maxEntries?: number;
  /** Combined baseline-file byte budget; the compact index has a separate bounded overhead. */
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
  /** Diagnostics contain only operation counts/lengths and internal filenames. */
  onIO?: (event: { operation: 'read' | 'write' | 'sync'; name: string; bytes: number }) => void;
}
interface Slot { scope: string; path: string; text: string; token: string; expires: number }
interface IndexEntry { slot: string; bytes: number; expires: number }
const unavailable = () => new StudioError(503, '内容版本状态不可用，请检查私有状态目录权限或恢复备份');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const privateMode = (info: { mode: number; uid: number }) => process.platform === 'win32'
  || (info.mode & 0o077) === 0 && info.uid === process.getuid?.();
const slotName = /^[a-f0-9]{64}\.json$/;
const maxSlotBytes = 6 * 1024 * 1024 + 64 * 1024;

export function assertRevisionDirectoryOutside(checkout: string, directory: string): void {
  const path = relative(resolve(checkout), resolve(directory));
  if (!path || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) {
    throw new Error('内容版本私有状态目录必须位于站点或 Git 工作区之外，请配置 STUDIO_STATE_DIR');
  }
}
async function directoryPath(path: string, create = false): Promise<void> {
  const absolute = resolve(path), base = parse(absolute).root;
  let current = base;
  for (const part of absolute.slice(base.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || current === absolute && !privateMode(info)) throw unavailable();
  }
}
async function ordinaryFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !privateMode(info)) throw unavailable();
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}

/** Per-scope/path exact-text slots, serialized across processes. Unchanged reads
 * open only the requested slot and the compact quota index; they never rewrite/touch
 * bodies or read unrelated document text. Fixed TTL and FIFO quota eviction avoid write amplification on reads.
 * The index contains no document bodies. The only hash names the scope/path,
 * never content. Tokens never become filesystem paths.
 *
 * Publication uses a durable pending marker. Interrupted mutations fail closed,
 * even if an operator removes the crashed lock; restore/inspect the private store
 * before clearing pending. No automatic lock stealing or retired-token revival.
 * Windows requires service-account-only parent ACLs; mode bits are insufficient.
 */
export class DiskRevisionStore implements SnapshotRevisionStrategy {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(private readonly checkout: string, private readonly options: DiskRevisionOptions = {}) {
    this.maxEntries = options.maxEntries ?? 512;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
    if (![this.maxEntries, this.maxBytes, this.ttlMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid revision store limits');
    if (options.directory) assertRevisionDirectoryOutside(checkout, options.directory);
  }
  private report(operation: 'read' | 'write' | 'sync', name: string, bytes = 0) {
    this.options.onIO?.({ operation, name, bytes });
  }
  private async read(directory: string, name: string, limit: number, size?: (bytes: number) => void): Promise<unknown | null> {
    const file = join(directory, name);
    if (!await ordinaryFile(file)) return null;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || !privateMode(info) || info.size > limit) throw unavailable();
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      this.report('read', name, length);
      size?.(length);
      if (length !== info.size) throw unavailable();
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
      catch { throw unavailable(); }
    } finally { await handle.close(); }
  }
  private async write(directory: string, name: string, text: string): Promise<void> {
    const file = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(text, 'utf8'); this.report('write', name, Buffer.byteLength(text));
      await file.sync(); this.report('sync', name);
    } finally { await file.close(); }
  }
  private async sync(directory: string): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); this.report('sync', '.'); } finally { await handle.close(); }
  }
  private async remove(directory: string, name: string): Promise<void> {
    if (await ordinaryFile(join(directory, name))) await unlink(join(directory, name));
  }
  private index(data: unknown): IndexEntry[] {
    if (data === null) return [];
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 2
      || !('entries' in data) || !Array.isArray(data.entries) || data.entries.length > this.maxEntries) throw unavailable();
    const names = new Set<string>(); let bytes = 0;
    for (const entry of data.entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.slot !== 'string' || !slotName.test(entry.slot)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > maxSlotBytes
        || !Number.isSafeInteger(entry.expires) || entry.expires < 0 || names.has(entry.slot)) throw unavailable();
      names.add(entry.slot); bytes += entry.bytes;
    }
    if (bytes > this.maxBytes) throw unavailable();
    return data.entries as IndexEntry[];
  }
  async revision(path: string, text: string): Promise<string> {
    validatePath(path);
    if (Buffer.byteLength(text) > 1024 * 1024) throw new StudioError(413, '文件超过 1 MB 编辑限制');
    const scope = await realpath(resolve(this.checkout));
    if (scope === dirname(scope)) throw unavailable();
    const directory = resolve(this.options.directory ?? scope + '.studio-revisions-v1');
    assertRevisionDirectoryOutside(scope, directory);
    try { await directoryPath(directory); } catch (error) { if (!missing(error)) throw error; await directoryPath(directory, true); }
    const lock = join(directory, 'lock');
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let info;
        try { info = await lstat(lock); } catch (error) { if (missing(error)) continue; throw error; }
        if (!info.isDirectory() || info.isSymbolicLink() || !privateMode(info)) throw unavailable();
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!acquired) throw new StudioError(423, '内容版本状态正在使用；若进程已退出，请检查私有版本目录中的残留 lock');
    try {
      await directoryPath(directory);
      if (await ordinaryFile(join(directory, 'pending')) || await ordinaryFile(join(directory, 'baselines.json'))) throw unavailable();
      const slot = createHash('sha256').update(JSON.stringify([scope, path])).digest('hex') + '.json';
      const now = this.now();
      let slotBytes = 0;
      const raw = await this.read(directory, slot, Math.min(maxSlotBytes, this.maxBytes), bytes => { slotBytes = bytes; });
      // Validate the small quota manifest even on reuse: an orphan or retired
      // body must never authorize a save merely because its bytes survived.
      const index = this.index(await this.read(directory, 'index.json', this.maxEntries * 256 + 128));
      if (raw !== null) {
        if (!raw || typeof raw !== 'object' || !('scope' in raw) || raw.scope !== scope || !('path' in raw) || raw.path !== path
          || !('text' in raw) || typeof raw.text !== 'string' || Buffer.byteLength(raw.text) > 1024 * 1024
          || !('token' in raw) || typeof raw.token !== 'string' || !/^disk-baseline:[0-9a-f-]{36}$/.test(raw.token)
          || !('expires' in raw) || typeof raw.expires !== 'number' || !Number.isSafeInteger(raw.expires) || raw.expires < 0) throw unavailable();
        const indexed = index.find(entry => entry.slot === slot);
        if (!indexed || indexed.expires !== raw.expires || indexed.bytes !== slotBytes) throw unavailable();
        if (raw.text === text && raw.expires > now) return raw.token;
      }
      const entry: Slot = { scope, path, text, token: `disk-baseline:${randomUUID()}`, expires: now + this.ttlMs };
      const body = JSON.stringify(entry), bytes = Buffer.byteLength(body);
      if (bytes > Math.min(this.maxBytes, maxSlotBytes)) throw new StudioError(503, '私有版本状态配额不足，无法保留此文件的编辑基线');
      const retained = index.filter(entry => entry.slot !== slot && entry.expires > now);
      let used = retained.reduce((sum, entry) => sum + entry.bytes, 0);
      while (retained.length >= this.maxEntries || used + bytes > this.maxBytes) used -= retained.shift()!.bytes;
      const keep = new Set(retained.map(entry => entry.slot));
      // Publish intent before touching any slot. Crash recovery never guesses which
      // old token remains valid from a partially committed metadata/body pair.
      await this.write(directory, 'pending', '{"version":2}'); await this.sync(directory);
      for (const old of index) if (!keep.has(old.slot)) await this.remove(directory, old.slot);
      await this.remove(directory, 'slot.tmp'); await this.remove(directory, 'index.tmp');
      await this.write(directory, 'slot.tmp', body);
      await ordinaryFile(join(directory, slot)); await rename(join(directory, 'slot.tmp'), join(directory, slot));
      retained.push({ slot, bytes, expires: entry.expires });
      await this.write(directory, 'index.tmp', JSON.stringify({ version: 2, entries: retained }));
      await ordinaryFile(join(directory, 'index.json')); await rename(join(directory, 'index.tmp'), join(directory, 'index.json'));
      await this.sync(directory);
      await this.remove(directory, 'pending'); await this.sync(directory);
      return entry.token;
    } finally { await directoryPath(lock); await rmdir(lock); }
  }
}
