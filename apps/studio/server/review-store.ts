import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { StudioError } from '../core/errors.js';
import {
  createWorkspaceReviewStore, isReviewDiskName, workspaceReviewBusy, workspaceReviewUnavailable,
  type ReviewDisk, type ReviewLimits, type ReviewReader, type ReviewSource,
} from '../shared/workspace-confirmation.js';

const unavailable = () => new StudioError(503, workspaceReviewUnavailable);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Recheck every ancestor; no realpath rewriting can grant access through a symlink. */
async function ordinaryPath(path: string, directory: boolean, privateEntry = false) {
  const absolute = resolve(path), base = parse(absolute).root;
  let current = base;
  const parts = absolute.slice(base.length).split(/[\\/]/).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const info = await lstat(current);
    const leaf = index === parts.length - 1;
    if (info.isSymbolicLink() || (leaf && !directory ? !info.isFile() : !info.isDirectory())) throw unavailable();
    if (leaf && privateEntry && process.platform !== 'win32'
      && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw unavailable();
    if (leaf && !directory && info.nlink !== 1) throw unavailable();
  }
}
async function checkedOpen(path: string, privateEntry: boolean): Promise<FileHandle | null> {
  try { await ordinaryPath(path, false, privateEntry); }
  catch (error) { if (missing(error)) return null; throw error; }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || privateEntry && process.platform !== 'win32'
      && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw unavailable();
    return file;
  } catch (error) { await file.close(); throw error; }
}
function reader(file: FileHandle): ReviewReader {
  return {
    read: async buffer => (await file.read(buffer, 0, buffer.byteLength, null)).bytesRead,
    close: () => file.close(),
  };
}

/**
 * One private sibling of a checkout, shared by Node workers and never served as content.
 * All workers must use the same resolved checkout root and existing workspace lock.
 * POSIX permissions are enforced. Windows deployments must provision the parent with
 * a service-account-only ACL; Node's mode bits do not provide a Windows ACL guarantee.
 */
export function nodeReviewDisk(checkout: string): ReviewDisk {
  const root = resolve(checkout);
  if (root === dirname(root)) throw unavailable();
  const directory = root + '.studio-reviews-v1';
  function path(name: string) { if (!isReviewDiskName(name)) throw unavailable(); return join(directory, name); }
  async function ensure() {
    await ordinaryPath(dirname(directory), true);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await ordinaryPath(directory, true, true);
  }
  return {
    async withLock(operation) {
      await ensure();
      const lock = join(directory, 'lock');
      try { await mkdir(lock, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StudioError(423, workspaceReviewBusy);
        throw error;
      }
      try { return await operation(); }
      finally { await ordinaryPath(lock, true, true); await rmdir(lock); }
    },
    async openRead(name) { const file = await checkedOpen(path(name), true); return file ? reader(file) : null; },
    async openNew(name) {
      await ordinaryPath(directory, true, true);
      const file = await open(path(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      return {
        write: async buffer => (await file.write(buffer, 0, buffer.byteLength, null)).bytesWritten,
        close: async () => { try { await file.sync(); } finally { await file.close(); } },
      };
    },
    async rename(from, to) {
      await ordinaryPath(path(from), false, true);
      try { await ordinaryPath(path(to), false, true); } catch (error) { if (!missing(error)) throw error; }
      await rename(path(from), path(to));
    },
    async remove(name) {
      try { await ordinaryPath(path(name), false, true); await unlink(path(name)); }
      catch (error) { if (!missing(error)) throw error; }
    },
    async list() {
      await ordinaryPath(directory, true, true);
      const names: string[] = [];
      const stream = await opendir(directory);
      for await (const entry of stream) {
        if (entry.name === 'lock') continue;
        if (names.length >= 16 || !isReviewDiskName(entry.name)) throw unavailable();
        await ordinaryPath(path(entry.name), false, true);
        names.push(entry.name);
      }
      return names;
    },
  };
}

/** Source checks are in addition to the engine's managed-path authorization. */
export function nodeReviewSource(checkout: string): ReviewSource {
  const root = resolve(checkout);
  return async relative => {
    if (!relative || relative.includes('\\') || relative.includes('\0')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) throw unavailable();
    const file = await checkedOpen(join(root, relative), false);
    return file ? reader(file) : null;
  };
}
export function nodeWorkspaceReviews(checkout: string, options?: ReviewLimits) {
  return createWorkspaceReviewStore(nodeReviewDisk(checkout), options);
}
