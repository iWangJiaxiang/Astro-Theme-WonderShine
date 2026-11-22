import { convertFileSrc } from '@tauri-apps/api/core';
import { validateMediaPath } from '../core/media-validation';
import { MAX_UPLOAD_SIZE, type MediaItem } from '../shared/media';
import type { Repository } from '../shared/repository';
import type { WorkspaceFiles } from './filesystem';
import { mediaSource, type MediaSource } from './media-index';

const maxEntries = 160, maxBytes = 160 * 1024, maxSide = 360;
let database: Promise<IDBDatabase | null> | undefined;
function openThumbnails(): Promise<IDBDatabase | null> {
  return database ??= new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const request = indexedDB.open('wondershine-media-thumbnails', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('thumbnails', { keyPath: 'key' }).createIndex('usedAt', 'usedAt');
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => resolve(null);
  });
}
async function getThumbnail(key: string): Promise<Blob | undefined> {
  const db = await openThumbnails();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const store = db.transaction('thumbnails', 'readwrite').objectStore('thumbnails');
    const request = store.get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const image = request.result?.image;
      if (!(image instanceof Blob) || image.size > maxBytes) return resolve(undefined);
      store.put({ key, image, usedAt: Date.now() });
      resolve(image);
    };
  });
}
async function saveThumbnail(key: string, image: Blob) {
  const db = await openThumbnails();
  if (!db || image.size > maxBytes) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('thumbnails', 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    const store = transaction.objectStore('thumbnails');
    store.put({ key, image, usedAt: Date.now() });
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - maxEntries;
      if (excess <= 0) return;
      const cursor = store.index('usedAt').openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry || excess <= 0) return;
        entry.delete();
        excess--;
        entry.continue();
      };
    };
  });
}
async function imageSource(blob: Blob) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (bitmap) return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(blob);
  const release = () => URL.revokeObjectURL(url);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function shrink(image: Blob): Promise<Blob | null> {
  const { source, width, height, release } = await imageSource(image);
  try {
    if (Math.max(width, height) <= maxSide && image.size <= maxBytes) return image;
    const ratio = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .78));
  } finally { release(); }
}

export function createNativeMediaImageLoader(files: WorkspaceFiles, root: string, scope: string, repository: Repository, managed: boolean,
  indexedSource: (path: string) => MediaSource | undefined) {
  const slots = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
  let next = 0;
  async function load(item: MediaItem, resize: boolean, signal: AbortSignal, version: number, indexedKey?: string): Promise<Blob | string> {
    signal.throwIfAborted();
    const path = root + '/' + item.path;
    const info = await files.statChecked!(path);
    signal.throwIfAborted();
    if (!info.isFile() || info.size > MAX_UPLOAD_SIZE) throw new Error('Media file is unavailable');
    if (!resize) return convertFileSrc(path) + '?v=' + info.mtimeMs + '-' + info.size + '-' + version;
    const key = JSON.stringify([scope, item.path, ...mediaSource(info)]);
    const cached = managed && key !== indexedKey ? await getThumbnail(key).catch(() => undefined) : undefined;
    signal.throwIfAborted();
    if (cached) return cached;
    const file = await repository.readMedia(item.path);
    if (!file) throw new Error('Media file is unavailable');
    signal.throwIfAborted();
    const blob = new Blob([new Uint8Array(file.data)], { type: file.mime });
    const resized = await shrink(blob).catch(() => null);
    signal.throwIfAborted();
    if (resized && managed) void saveThumbnail(key, resized).catch(() => {});
    return resized || blob;
  }
  return async (item: MediaItem, thumbnail: boolean, signal: AbortSignal, version: number): Promise<Blob | string> => {
    signal.throwIfAborted();
    validateMediaPath(item.path);
    if (!thumbnail || !/^image\/(jpeg|png|webp|avif|bmp)$/.test(item.mime)) return load(item, false, signal, version);
    const source = indexedSource(item.path);
    const indexedKey = source && JSON.stringify([scope, item.path, ...source]);
    if (indexedKey) {
      const cached = await getThumbnail(indexedKey).catch(() => undefined);
      signal.throwIfAborted();
      // A refresh or checkout can invalidate the listing during the cache read.
      if (cached && indexedSource(item.path) === source) return cached;
    }
    const slot = next++ % slots.length;
    const request = slots[slot].then(() => load(item, true, signal, version, indexedKey));
    slots[slot] = request.then(() => {}, () => {});
    return request;
  };
}
