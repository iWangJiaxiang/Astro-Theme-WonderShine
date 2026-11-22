import { validateMediaPath } from '../core/media-validation';
import { imageMime, MAX_UPLOAD_SIZE, type MediaListing } from '../shared/media';
import type { Repository } from '../shared/repository';
import { comparePathComponents, parentPath, type WorkspaceFiles } from './filesystem';
import { withSnapshotLocks } from './snapshot-queue';
import { createNativeSnapshotStore } from './summary-store';

type Snapshot = { version: 1; scope: string; listing: MediaListing };

function readSnapshot(value: unknown, scope: string): MediaListing | undefined {
  const record = value as Partial<Snapshot> | null;
  if (!record || record.version !== 1 || record.scope !== scope || typeof record.listing?.truncated !== 'boolean'
    || !Array.isArray(record.listing.items) || record.listing.items.length > 5000) return;
  const seen = new Set<string>();
  const items = [];
  for (const entry of record.listing.items) {
    if (!entry || typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0 || seen.has(entry.path)) return;
    try { validateMediaPath(entry.path); } catch { return; }
    seen.add(entry.path);
    items.push({ path: entry.path, name: entry.path.split('/').at(-1)!, directory: parentPath(entry.path),
      mime: imageMime(entry.path)!, size: entry.size,
      ...(entry.size > MAX_UPLOAD_SIZE ? { unavailable: '图片超过 20 MB 预览限制' } : {}) });
  }
  return { items, truncated: record.listing.truncated, maxFileSize: MAX_UPLOAD_SIZE };
}

/** The persisted list has no authority to read an image. All worktree mutations
 * that might change it clear the previous record before writing source files. */
export function createNativeMediaIndex(repository: Repository, files: WorkspaceFiles, state: string, base: string, scope: string, managed: boolean) {
  const store = createNativeSnapshotStore<Snapshot>(files, state, base, 'media-list-v1');
  const serialize = <T>(operation: () => Promise<T>) => withSnapshotLocks(state, ['media-list-v1'], operation);
  let closed = false;
  let cached: MediaListing | undefined;
  let loaded = false;
  let persistent = true;
  async function load() {
    if (!loaded) {
      loaded = true;
      if (persistent) cached = readSnapshot(await store.load().catch(() => null), scope);
    }
    return cached;
  }
  async function persist(listing: MediaListing) {
    if (closed) return;
    loaded = true;
    cached = listing;
    if (!persistent) return;
    try { await store.save({ version: 1, scope, listing }); }
    catch { await store.clear().catch(() => { persistent = false; }); }
  }
  async function invalidate() {
    cached = undefined;
    loaded = true;
    try { await store.clear(); }
    catch { persistent = false; }
  }
  const listMedia: Repository['listMedia'] = refresh => serialize(async () => {
    if (managed && !refresh) {
      const hit = await load();
      if (hit) return hit;
    }
    if (refresh) await invalidate();
    const listing = await repository.listMedia(refresh);
    await persist(listing);
    return listing;
  });
  const uploadMedia: Repository['uploadMedia'] = (directory, name, data) => serialize(async () => {
    const previous = await load();
    await invalidate();
    const result = await repository.uploadMedia(directory, name, data);
    if (previous && !previous.truncated && previous.items.length < 5000) {
      const items = [...previous.items, result.item].sort((a, b) =>
        Number(b.path.startsWith('public/')) - Number(a.path.startsWith('public/')) || comparePathComponents(a.path, b.path));
      await persist({ ...previous, items });
    }
    return result;
  });
  const workspace = repository.workspace;
  const indexedWorkspace = workspace && new Proxy(workspace, {
    get(target, property) {
      if (property === 'sync') return (confirmation?: string) => serialize(async () => {
        await invalidate();
        return workspace.sync(confirmation);
      });
      if (property === 'publish' && workspace.publish) return (message: string, confirmation: string) => serialize(async () => {
        await invalidate();
        return workspace.publish!(message, confirmation);
      });
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    repository: new Proxy(repository, {
      get(target, property) {
        if (property === 'workspace') return indexedWorkspace;
        if (property === 'listMedia') return listMedia;
        if (property === 'uploadMedia') return uploadMedia;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    preview: () => serialize(async () => await load() ?? null),
    dispose() { closed = true; },
  };
}
