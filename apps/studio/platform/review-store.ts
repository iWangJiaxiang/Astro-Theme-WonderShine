import * as fs from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { StudioError } from '../core/errors.js';
import {
  createWorkspaceReviewStore, isReviewDiskName, workspaceReviewUnavailable,
  type ReviewDisk, type ReviewLimits, type ReviewSource,
} from '../shared/workspace-confirmation.js';

const unavailable = () => new StudioError(503, workspaceReviewUnavailable);
const missing = (error: unknown) => /not found|no such file|os error 2|系统找不到/i.test(String(error));
function absolute(path: string) {
  const value = path.replace(/\\/g, '/').replace(/\/$/, '');
  if (!/^(?:\/|[a-zA-Z]:\/)/.test(value) || value.includes('\0')
    || value.split('/').some(part => part === '..' || part === '.')) throw unavailable();
  return value;
}
async function checked(path: string, directory: boolean, privateEntry = false, boundary = path) {
  // Tauri must not inspect ancestors outside the granted AppData/selected-root scope.
  if (path !== boundary && !path.startsWith(boundary + '/')) throw unavailable();
  const root = await fs.lstat(boundary);
  if (root.isSymlink || (path === boundary && !directory ? !root.isFile : !root.isDirectory)) throw unavailable();
  if (path === boundary && !directory && root.nlink !== null && root.nlink !== 1) throw unavailable();
  if (path === boundary && privateEntry && root.mode !== null && (root.mode & 0o077) !== 0) throw unavailable();
  let current = boundary;
  const parts = path.slice(boundary.length).split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current += '/' + parts[index];
    const info = await fs.lstat(current);
    const leaf = index === parts.length - 1;
    if (info.isSymlink || (leaf && !directory ? !info.isFile : !info.isDirectory)) throw unavailable();
    if (leaf && privateEntry && info.mode !== null && (info.mode & 0o077) !== 0) throw unavailable();
    if (leaf && !directory && info.nlink !== null && info.nlink !== 1) throw unavailable();
  }
}
async function openReader(path: string, privateEntry = false, boundary = path) {
  try { await checked(path, false, privateEntry, boundary); }
  catch (error) { if (missing(error)) return null; throw error; }
  const handle = await fs.open(path, { read: true });
  try {
    const info = await handle.stat();
    if (!info.isFile || info.isSymlink || info.nlink !== null && info.nlink !== 1
      || privateEntry && info.mode !== null && (info.mode & 0o077) !== 0) throw unavailable();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/**
 * stateRoot must be the trusted AppData workspace state directory, outside checkout.
 * Requires fs:allow-open/read/write/fstat and core resource-close permissions in
 * addition to existing scoped filesystem permissions. Never fall back to readFile.
 * plugin-fs has no O_NOFOLLOW open flag: lstat + handle.stat checks match the current
 * native filesystem adapter's safety model, not protection against a hostile local
 * process racing ancestor replacement. AppData sandbox/ACL must protect this store.
 */
const restart = '创作窗口已重新加载，请完全退出并重启应用后重新确认工作区';
const ownerUnavailable = '工作区确认所有权不可用，请完全退出其他 Studio 实例后重启应用';
// A new module/webview lifetime gets a new epoch. Never persist it across reloads.
let epoch: string | undefined;
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
  // Separate from the outer workspace mutation queue to avoid reentrant deadlock.
  const next = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
  queues.set(id, next);
  void next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => undefined);
  return next;
}
async function authorize(workspaceId: string, claimRecovery: boolean): Promise<boolean> {
  epoch ??= crypto.randomUUID();
  try {
    const result = await invoke<unknown>('native_review_owner', { workspaceId, epoch, claimRecovery });
    if (typeof result !== 'boolean') throw unavailable();
    return result;
  } catch (error) {
    // Never expose arbitrary IPC errors, paths or private payloads.
    throw new StudioError(503, error === restart ? restart : ownerUnavailable);
  }
}

// Private: no exported raw disk or injected queue-only ownership escape hatch.
function nativeReviewDisk(stateRoot: string, authorizationRoot: string): ReviewDisk {
  const state = absolute(stateRoot), base = absolute(authorizationRoot), directory = state + '/reviews-v1';
  if (!state.startsWith(base + '/') || base === '/' || /^[a-zA-Z]:$/.test(base)) throw unavailable();
  const path = (name: string) => { if (!isReviewDiskName(name)) throw unavailable(); return directory + '/' + name; };
  async function ensure() {
    await checked(state, true, false, base);
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch { await checked(directory, true, true, base); }
    await checked(directory, true, true, base);
  }
  return {
    async withLock(operation) {
      await ensure();
      const lock = directory + '/lock';
      try { await fs.mkdir(lock, { mode: 0o700 }); }
      catch {
        try { await checked(lock, true, true, base); } catch { throw unavailable(); }
        // The local review queue excludes a live review in this epoch. Never
        // steal a leftover lock after the once-only connect recovery was spent.
        throw new StudioError(503, restart);
      }
      try { return await operation(); }
      finally { await checked(lock, true, true, base); await fs.remove(lock); }
    },
    openRead: name => openReader(path(name), true, base),
    async openNew(name) {
      await checked(directory, true, true, base);
      return fs.open(path(name), { write: true, createNew: true, mode: 0o600 });
    },
    async rename(from, to) {
      await checked(path(from), false, true, base);
      try { await checked(path(to), false, true, base); } catch (error) { if (!missing(error)) throw error; }
      await fs.rename(path(from), path(to));
    },
    async remove(name) {
      try { await checked(path(name), false, true, base); await fs.remove(path(name)); }
      catch (error) { if (!missing(error)) throw error; }
    },
    async list() {
      await checked(directory, true, true, base);
      const names = (await fs.readDir(directory)).filter(entry => entry.name !== 'lock');
      if (names.length > 16) throw unavailable();
      for (const entry of names) {
        if (!isReviewDiskName(entry.name)) throw unavailable();
        await checked(path(entry.name), false, true, base);
      }
      return names.map(entry => entry.name);
    },
  };
}
export function nativeReviewSource(checkout: string): ReviewSource {
  const root = absolute(checkout);
  return relative => {
    if (!relative || relative.includes('\\') || relative.includes('\0')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) throw unavailable();
    return openReader(root + '/' + relative, false, root);
  };
}
/**
 * Await after creating stateRoot and BEFORE exposing the runtime. Both arguments
 * come from trusted native runtime paths, not content or an IPC caller. Rust uses
 * its own AppData path; only the validated workspace UUID crosses the boundary.
 * Recovery is claimed once per workspace per process, including failed attempts.
 */
export async function openNativeWorkspaceReviews(
  stateRoot: string, authorizationRoot: string, options?: ReviewLimits,
) {
  const state = absolute(stateRoot), base = absolute(authorizationRoot);
  const relative = state.slice(base.length);
  const match = /^\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/state$/.exec(relative);
  if (!state.startsWith(base + '/') || !match) throw unavailable();
  const id = match[1];
  const disk = nativeReviewDisk(state, base);
  // Validate options before consuming a once-only recovery claim.
  const rawStore = createWorkspaceReviewStore(disk, options);
  const directory = state + '/reviews-v1', lock = directory + '/lock';
  try { await serialized(id, async () => {
    const recover = await authorize(id, true);
    await checked(state, true, false, base);
    try { await checked(directory, true, true, base); }
    catch (error) { if (missing(error)) return; throw unavailable(); }
    const entries = await fs.readDir(directory);
    if (entries.length > 17) throw unavailable();
    for (const entry of entries) {
      if (entry.name === 'lock') {
        await checked(lock, true, true, base);
        if ((await fs.readDir(lock)).length) throw unavailable();
      } else {
        if (!isReviewDiskName(entry.name)) throw unavailable();
        await checked(directory + '/' + entry.name, false, true, base);
      }
    }
    if (entries.some(entry => entry.name === 'lock')) {
      if (!recover) throw new StudioError(503, restart);
      await fs.remove(lock);
    }
    await rawStore.cleanup();
  }); } catch (error) { if (error instanceof StudioError) throw error; throw unavailable(); }
  return createWorkspaceReviewStore({ ...disk,
    withLock: operation => serialized(id, async () => {
      await authorize(id, false);
      return disk.withLock(operation);
    }),
  }, options);
}
