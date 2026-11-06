import type { SummaryIndexStore } from '../core/summary-index.js';
import { missingFile, type FileInfo, type WorkspaceFiles } from './filesystem.js';

const MAX_BYTES = 8 * 1024 * 1024;
const DIRECTORY = 'summary-preview-v1';
const SNAPSHOT = 'snapshot.json';
const unsafe = () => new Error('Unsafe summary preview storage path');

function absolutePath(value: string): string {
  const path = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path || path.includes('\0') || !/^(\/|[A-Za-z]:\/)/.test(path)
    || path.includes('//') || path.split('/').some(part => part === '.' || part === '..' || part === 'public' || part === '.git')) throw unsafe();
  return path;
}

/**
 * One display-only snapshot in a trusted, application-private state directory.
 * The caller MUST keep stateDirectory outside every checkout/public directory and
 * provision its sandbox/ACL. It must already exist. No BlobState or document data.
 * Production callers MUST pass the granted AppData base as authorizationRoot so
 * every component between AppData and the workspace state is checked as well.
 * The default boundary is only for explicitly caller-provisioned trusted state
 * directories. The authorization root's ancestry and sandbox/ACL protection are
 * caller prerequisites. Never inspect ancestors outside that granted boundary;
 * this does not require whole-filesystem access.
 *
 * WorkspaceFiles has no openat/O_NOFOLLOW, exclusive-create or fsync contract.
 * Random names and repeated checks protect ordinary concurrent workers, not a
 * hostile process swapping ancestors between syscalls or power-loss durability.
 * Native platform sandbox/ACL isolation is therefore a prerequisite, not inferred
 * from chmod (which is a no-op on some native adapters).
 */
export function createNativeSummaryStore(files: WorkspaceFiles, stateDirectory: string, authorizationRoot: string = stateDirectory): SummaryIndexStore {
  const state = absolutePath(stateDirectory);
  const boundary = absolutePath(authorizationRoot);
  if (state !== boundary && !state.startsWith(boundary + '/')) throw unsafe();
  const directory = state + '/' + DIRECTORY;
  const target = directory + '/' + SNAPSHOT;

  async function ordinary(path: string, directoryEntry: boolean): Promise<FileInfo> {
    if (path !== state && !path.startsWith(state + '/')) throw unsafe();
    let current = boundary;
    let info = await files.lstat(boundary);
    if (info.isSymbolicLink() || !info.isDirectory() || path === boundary && !directoryEntry) throw unsafe();
    const parts = path === boundary ? [] : path.slice(boundary.length + 1).split('/');
    for (let index = 0; index < parts.length; index++) {
      if (!parts[index] || parts[index] === '.' || parts[index] === '..') throw unsafe();
      current += '/' + parts[index];
      info = await files.lstat(current);
      if (info.isSymbolicLink() || (index === parts.length - 1 && !directoryEntry ? !info.isFile() : !info.isDirectory())) throw unsafe();
    }
    return info;
  }
  async function optionalFile(path: string): Promise<FileInfo | null> {
    try { return await ordinary(path, false); }
    catch (error) { if (missingFile(error)) return null; throw error; }
  }
  async function ensure(): Promise<void> {
    await ordinary(state, true);
    try { await files.mkdir(directory); }
    catch (error) { if ((error as { code?: string })?.code !== 'EEXIST') throw error; }
    await ordinary(directory, true);
    await files.chmod(directory, 0o700);
  }
  async function removeOwn(path: string): Promise<void> {
    await ordinary(directory, true);
    if (await optionalFile(path)) {
      try { await files.unlink(path); }
      catch (error) { if (!missingFile(error)) throw error; }
    }
  }
  return {
    async load(): Promise<unknown> {
      const info = await optionalFile(target);
      if (!info) return null;
      if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_BYTES) throw new Error('Summary preview exceeds byte limit');
      // Checked reads can provide stronger platform-specific bounds. The fallback
      // stat/read/stat checks cannot bound allocation during hostile file growth.
      const data = files.readCheckedFile ? await files.readCheckedFile(target, MAX_BYTES) : await files.readFile(target);
      if (typeof data === 'string' && data.length > MAX_BYTES) throw new Error('Summary preview exceeds byte limit');
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      if (bytes.byteLength > MAX_BYTES) throw new Error('Summary preview exceeds byte limit');
      const after = await ordinary(target, false);
      if (!Number.isSafeInteger(after.size) || after.size < 0 || after.size > MAX_BYTES) throw new Error('Summary preview exceeds byte limit');
      // Validation (including exact scope and recipe) belongs solely to the index.
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    },
    async save(record): Promise<void> {
      const text = JSON.stringify(record);
      if (text.length > MAX_BYTES) throw new Error('Summary preview exceeds byte limit');
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > MAX_BYTES) throw new Error('Summary preview exceeds byte limit');
      await ensure();
      const temporary = directory + '/.snapshot-' + crypto.randomUUID() + '.tmp';
      if (await optionalFile(temporary)) throw unsafe();
      let attempted = false;
      try {
        await ordinary(directory, true);
        attempted = true;
        try { await files.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if ((error as { code?: string })?.code === 'EEXIST') attempted = false;
          throw error;
        }
        await ordinary(temporary, false);
        await files.chmod(temporary, 0o600);
        await ordinary(temporary, false);
        await optionalFile(target); // Never knowingly replace a symlink target.
        await files.rename(temporary, target);
        attempted = false;
      } finally {
        // At most this operation's random file; never scan/delete old temps,
        // another worker's snapshot, history, journals or workspace files.
        if (attempted) await removeOwn(temporary);
      }
    },
    async clear(): Promise<void> {
      try { await removeOwn(target); }
      catch (error) { if (!missingFile(error)) throw error; }
      // Another worker may publish immediately afterwards. Even "clean" is stale
      // preview only; clearing is NOT a cross-worker freshness barrier or CAS.
    },
  };
}
