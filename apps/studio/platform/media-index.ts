import { validateMediaPath } from '../core/media-validation';
import { imageMime, MAX_UPLOAD_SIZE, type MediaListing } from '../shared/media';
import type { Repository } from '../shared/repository';
import type { FileRepository } from './file-repository';
import { comparePathComponents, parentPath, type FileInfo, type WorkspaceFiles } from './filesystem';
import { withSnapshotLocks } from './snapshot-queue';
import { createNativeSnapshotStore } from './summary-store';

export type MediaSource = [mtime: number, birthtime: number, size: number, inode: number];
type Snapshot = { version: 1; scope: string; listing: MediaListing; sources?: Record<string, MediaSource> };

export function mediaSource({ mtimeMs, ctimeMs, size, ino }: FileInfo): MediaSource {
  return [mtimeMs, ctimeMs, size, ino];
}

function readSnapshot(value: unknown, scope: string): Snapshot | undefined {
  const record = value as Partial<Snapshot> | null;
  if (!record || record.version !== 1 || record.scope !== scope || typeof record.listing?.truncated !== 'boolean'
    || !Array.isArray(record.listing.items) || record.listing.items.length > 5000) return;
  const seen = new Set<string>();
  const sources: Record<string, MediaSource> = {};
  const items = [];
  for (const entry of record.listing.items) {
    if (!entry || typeof entry.path !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0 || seen.has(entry.path)) return;
    try { validateMediaPath(entry.path); } catch { return; }
    seen.add(entry.path);
    const source = record.sources?.[entry.path];
    if (Array.isArray(source) && source.length === 4 && source.every(Number.isFinite) && source[2] === entry.size)
      sources[entry.path] = source;
    items.push({ path: entry.path, name: entry.path.split('/').at(-1)!, directory: parentPath(entry.path),
      mime: imageMime(entry.path)!, size: entry.size,
      ...(entry.size > MAX_UPLOAD_SIZE ? { unavailable: '图片超过 20 MB 预览限制' } : {}) });
  }
  return { version: 1, scope, listing: { items, truncated: record.listing.truncated, maxFileSize: MAX_UPLOAD_SIZE }, sources };
}

/** The persisted list has no authority to read an image. All worktree mutations
 * that might change it clear the previous record before writing source files. */
export function createNativeMediaIndex(repository: Repository & Pick<FileRepository, 'listMedia' | 'root'>, files: WorkspaceFiles, state: string, base: string, scope: string, managed: boolean) {
  const store = createNativeSnapshotStore<Snapshot>(files, state, base, 'media-list-v1');
  const serialize = <T>(operation: () => Promise<T>) => withSnapshotLocks(state, ['media-list-v1'], operation);
  let closed = false;
  let cached: Snapshot | undefined;
  let loaded = false;
  let persistent = true;
  async function load() {
    if (!loaded) {
      loaded = true;
      if (persistent) cached = readSnapshot(await store.load().catch(() => null), scope);
    }
    return cached;
  }
  async function persist(listing: MediaListing, sources?: Snapshot['sources']) {
    if (closed) return;
    loaded = true;
    cached = { version: 1, scope, listing, sources };
    if (!persistent) return;
    try { await store.save(cached); }
    catch { persistent = false; }
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
      if (hit) return hit.listing;
    }
    if (refresh) await invalidate();
    const sources: Record<string, MediaSource> = {};
    const listing = await repository.listMedia(refresh, managed ? (path, info) => {
      sources[path] = mediaSource(info);
    } : undefined);
    void persist(listing, managed ? sources : undefined);
    return listing;
  });
  const uploadMedia: Repository['uploadMedia'] = (directory, name, data) => serialize(async () => {
    const previous = await load();
    await invalidate();
    const result = await repository.uploadMedia(directory, name, data);
    if (previous && !previous.listing.truncated && previous.listing.items.length < 5000) {
      const items = [...previous.listing.items, result.item].sort((a, b) =>
        Number(b.path.startsWith('public/')) - Number(a.path.startsWith('public/')) || comparePathComponents(a.path, b.path));
      let sources = previous.sources;
      if (managed && files.statChecked) {
        const info = await files.statChecked(repository.root + '/' + result.item.path).catch(() => undefined);
        if (info?.isFile() && info.size === result.item.size)
          sources = { ...sources, [result.item.path]: mediaSource(info) };
      }
      await persist({ ...previous.listing, items }, sources);
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
      if (property === 'discard' && workspace.discard) return (confirmation: string) => serialize(async () => {
        await invalidate();
        return workspace.discard!(confirmation);
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
    preview: () => serialize(async () => (await load())?.listing ?? null),
    thumbnailSource: (path: string) => !closed && managed ? cached?.sources?.[path] : undefined,
    dispose() { closed = true; },
  };
}
