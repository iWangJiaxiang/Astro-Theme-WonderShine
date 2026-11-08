import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { SummaryIndexStore } from '../core/summary-index.js';

interface FileSummaryStoreDependencies {
  lstat?: (path: string) => Promise<Stats>;
  open?: (path: string, flags: number, mode?: number) => Promise<FileHandle>;
}

const publishedLinkCount = (nlink: number): boolean => Number.isSafeInteger(nlink) && (nlink === 0 || nlink === 1);
const MAX_BYTES = 8 * 1024 * 1024;
const unsafe = () => new Error('Unsafe summary preview storage path or permissions');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const inside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === '' || !rest.startsWith('..' + sep) && rest !== '..' && !isAbsolute(rest);
};

/**
 * Explicit private directory, outside all checkout AND HTTP/static serving roots.
 * Supply every such root, including the repository root; an empty list is refused.
 * The parent must already exist. POSIX only: chmod does not prove a Windows ACL,
 * so unsupported platforms fail closed and SummaryIndex falls back to fresh scans.
 * Records are untrusted display-only snapshots; validation belongs to SummaryIndex.
 *
 * Atomic rename makes concurrent readers see a complete old/new snapshot. Writers
 * are last-snapshot-wins, NOT CAS: even a "clean" snapshot is always stale preview.
 * Directory fsync provides durable replacement/removal on supporting filesystems.
 * lstat + O_NOFOLLOW protects leaves and rejects known ancestor symlinks, but Node
 * has no portable openat/renameat: hostile concurrent ancestor swaps remain outside
 * the guarantee. Provision a trusted parent, not a directory writable by attackers.
 */
export function createFileSummaryStore(privateDirectory: string, forbiddenRoots: readonly string[], dependencies: FileSummaryStoreDependencies = {}): SummaryIndexStore {
  const inspect = dependencies.lstat ?? lstat;
  const openFile = dependencies.open ?? open;
  if (!isAbsolute(privateDirectory) || privateDirectory.includes('\0')
    || privateDirectory.split(/[\\/]/).some(part => part === '.' || part === '..')
    || forbiddenRoots.length === 0 || forbiddenRoots.some(root => !isAbsolute(root) || root.includes('\0'))) throw unsafe();
  const directory = resolve(privateDirectory);
  if (directory === dirname(directory) || directory.split(/[\\/]/).some(part => part === 'public' || part === '.git')
    || forbiddenRoots.some(root => inside(resolve(root), directory) || inside(directory, resolve(root)))) throw unsafe();
  const target = join(directory, 'snapshot.json');

  async function checkBoundaries(): Promise<void> {
    // Resolve aliases of forbidden roots, never aliases of the permitted directory.
    // Roots must exist; an unprovable serving/checkout boundary fails closed.
    for (const root of forbiddenRoots) {
      const canonical = await realpath(root);
      if (inside(canonical, directory) || inside(directory, canonical)) throw unsafe();
    }
  }
  function privateMode(info: { mode: number; uid: number }, mode: number) {
    if (process.platform === 'win32' || typeof process.getuid !== 'function'
      || info.uid !== process.getuid() || (info.mode & 0o777) !== mode) throw unsafe();
  }
  async function ordinary(path: string, directoryEntry: boolean, privateEntry = false) {
    const root = parse(path).root;
    let current = root;
    const rootInfo = await inspect(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unsafe();
    const parts = path.slice(root.length).split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      const info = await inspect(current);
      const leaf = index === parts.length - 1;
      if (info.isSymbolicLink() || (leaf && !directoryEntry ? !info.isFile() : !info.isDirectory())) throw unsafe();
      if (current === directory || leaf && privateEntry) privateMode(info, leaf && !directoryEntry ? 0o600 : 0o700);
      if (leaf && !directoryEntry && (current === target ? !publishedLinkCount(info.nlink) : info.nlink !== 1)) throw unsafe();
    }
  }
  async function optionalFile(path: string): Promise<boolean> {
    try { await ordinary(path, false, true); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  async function ensure(): Promise<void> {
    if (process.platform === 'win32') throw unsafe();
    await ordinary(dirname(directory), true);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await ordinary(directory, true, true);
  }
  async function syncDirectory(): Promise<void> {
    await ordinary(directory, true, true);
    const handle = await openFile(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { privateMode(await handle.stat(), 0o700); await handle.sync(); }
    finally { await handle.close(); }
  }
  async function removeOwn(path: string): Promise<boolean> {
    if (!await optionalFile(path)) return false;
    try { await unlink(path); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  return {
    async load(): Promise<unknown> {
      await checkBoundaries();
      if (!await optionalFile(target)) return null;
      let handle: FileHandle;
      try { handle = await openFile(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if (missing(error)) return null; throw error; }
      try {
        const info = await handle.stat();
        privateMode(info, 0o600);
        // A concurrent atomic replacement may unlink this already-open inode.
        if (!info.isFile() || !publishedLinkCount(info.nlink)) throw unsafe();
        if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_BYTES) throw new Error('Summary preview exceeds byte limit');
        // Never use readFile: fstat followed by readFile can allocate without bound
        // if another process grows the file. Allocation and every read are bounded.
        const bytes = new Uint8Array(info.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const extra = await handle.read(new Uint8Array(1), 0, 1, null);
        const after = await handle.stat();
        if (extra.bytesRead || after.size > MAX_BYTES || after.size !== info.size || offset !== info.size) throw new Error('Summary preview changed during read');
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      } finally { await handle.close(); }
    },
    async save(record): Promise<void> {
      const text = JSON.stringify(record);
      if (text.length > MAX_BYTES || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Summary preview exceeds byte limit');
      await checkBoundaries();
      await ensure();
      const temporary = join(directory, '.snapshot-' + randomUUID() + '.tmp');
      await ordinary(directory, true, true);
      const handle = await openFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let owned = true;
      try {
        try {
          const info = await handle.stat();
          privateMode(info, 0o600);
          if (!info.isFile() || info.nlink !== 1) throw unsafe();
          await handle.writeFile(text, 'utf8');
          await handle.sync();
        } finally { await handle.close(); }
        await ordinary(temporary, false, true);
        await optionalFile(target); // Refuse an existing symlink rather than overwrite it.
        await rename(temporary, target);
        owned = false;
        await syncDirectory();
      } finally {
        // Bounded cleanup: only the single exclusive-created file from this call.
        // No sweeping abandoned temps, history, journals or other workers' files.
        if (owned) await removeOwn(temporary);
      }
    },
    async clear(): Promise<void> {
      // No creation on cache miss. Missing files are benign; every other I/O error
      // propagates so the index abandons incremental state and rebuilds safely.
      await checkBoundaries();
      await removeOwn(target);
      try { await ordinary(directory, true, true); }
      catch (error) { if (missing(error)) return; throw error; }
      await syncDirectory();
      // This is not a freshness barrier: another worker can publish after unlink.
    },
  };
}
