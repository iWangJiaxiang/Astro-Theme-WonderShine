import { StudioError } from '../core/errors.js';

export const workspaceChanged = '工作区已变化或确认已过期，请刷新并重新确认提交范围';
export const workspaceReviewTooLarge = '工作区确认快照超过磁盘配额，请使用 Git 工具分批提交后重新确认；现有文件未被修改';
export const workspaceReviewUnavailable = '工作区确认存储不可用，请检查可用磁盘空间和访问权限后重新确认';
export const workspaceReviewBusy = '工作区确认正在进行，请稍后重试；若应用异常退出，请先确认没有运行中的操作，再清理确认存储的 lock 目录';

export function requireWorkspaceConfirmation(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new StudioError(400, workspaceChanged);
  return value;
}

export type ReviewRow = [string, number, number, number];
export interface ReviewState { scope: string; branch: string; head: string | null; rows: ReviewRow[] }
export interface WorkspaceReview { confirmation: string; expiresAt: number }
/** A reader must fill only the supplied buffer; null or zero denotes EOF. */
export interface ReviewReader { read(buffer: Uint8Array): Promise<number | null>; close(): Promise<void> }
export interface ReviewWriter { write(buffer: Uint8Array): Promise<number>; close(): Promise<void> }
export type ReviewSource = (path: string) => Promise<ReviewReader | null>;
export interface WorkspaceReviewService {
  createReview(state: ReviewState, source: ReviewSource): Promise<WorkspaceReview>;
  validateReview(token: unknown, state: ReviewState, source: ReviewSource): Promise<void>;
  cleanup(): Promise<void>;
}
export interface WorkspaceReviewAdapter { store: WorkspaceReviewService; source: ReviewSource }
/**
 * Dedicated private derived storage OUTSIDE the checkout, not general repository I/O.
 * Implementations reject symlinks, directories and unsafe names on every operation.
 * withLock is cross-process exclusive and must NOT steal locks based on age.
 * Engines additionally hold their workspace mutation lock across capture/validation
 * and the following Git mutation; this store lock is not a replacement for it.
 */
export interface ReviewDisk {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  openRead(name: string): Promise<ReviewReader | null>;
  openNew(name: string): Promise<ReviewWriter>;
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Fail if more than 16 entries, or if any entry is not an ordinary file. Excludes lock. */
  list(): Promise<string[]>;
}

interface Manifest extends ReviewState, WorkspaceReview { version: 1; sizes: Array<number | null>; bytes: number }
export interface ReviewLimits {
  maxSnapshotBytes?: number;
  /** Total payload + metadata budget, including the old review during replacement. */
  maxStoreBytes?: number;
  ttlMs?: number;
  now?: () => number;
}
export const reviewChunkBytes = 64 * 1024;
const maxManifestBytes = 2 * 1024 * 1024;
const maxRows = 10_000;
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isReviewToken(value: unknown): value is string { return typeof value === 'string' && tokenPattern.test(value); }
export function isReviewDiskName(name: string): boolean {
  return name === 'manifest.json' || name === 'manifest.pending'
    || /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?:bin|partial)$/.test(name);
}
const unavailable = () => new StudioError(503, workspaceReviewUnavailable);
const changed = () => new StudioError(409, workspaceChanged);

function canonical(state: ReviewState): ReviewState {
  if (!state.scope || state.scope.length > 8192 || state.branch.length > 1024
    || state.head !== null && (typeof state.head !== 'string' || state.head.length > 1024)
    || state.rows.length > maxRows) throw unavailable();
  let metadata = state.scope.length + state.branch.length + (state.head?.length ?? 0);
  const rows = state.rows.map(row => {
    if (!Array.isArray(row) || row.length !== 4 || typeof row[0] !== 'string' || !row[0]
      || row[0].includes('\\') || row[0].includes('\0') || row[0].split('/').some(part => !part || part === '.' || part === '..')
      || row.slice(1).some(flag => !Number.isInteger(flag) || Number(flag) < 0 || Number(flag) > 3)) throw unavailable();
    metadata += row[0].length + 64;
    if (metadata > maxManifestBytes / 8) throw new StudioError(413, workspaceReviewTooLarge);
    return [...row] as ReviewRow;
  }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (rows.some((row, index) => index > 0 && row[0] === rows[index - 1][0])) throw unavailable();
  return { scope: state.scope, branch: state.branch, head: state.head, rows };
}
function sameState(a: ReviewState, b: ReviewState): boolean {
  return a.scope === b.scope && a.branch === b.branch && a.head === b.head && a.rows.length === b.rows.length
    && a.rows.every((row, index) => row.every((part, column) => part === b.rows[index][column]));
}
async function readChunk(reader: ReviewReader, buffer: Uint8Array): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const count = await reader.read(buffer.subarray(offset, Math.min(buffer.length, offset + reviewChunkBytes)));
    if (count === null || count === 0) break;
    if (!Number.isSafeInteger(count) || count < 0 || count > Math.min(buffer.length - offset, reviewChunkBytes)) throw unavailable();
    offset += count;
  }
  return offset;
}
async function writeAll(writer: ReviewWriter, buffer: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const count = await writer.write(buffer.subarray(offset, Math.min(buffer.length, offset + reviewChunkBytes)));
    if (!Number.isSafeInteger(count) || count <= 0 || count > Math.min(buffer.length - offset, reviewChunkBytes)) throw unavailable();
    offset += count;
  }
}

/**
 * One published review and one staging file: default 512 MiB per snapshot and
 * 1 GiB TOTAL logical file bytes, reserving two bounded manifests during replacement.
 * Filesystem allocation overhead is not included. Tokens authorize only local state,
 * not a remote fetch/push plan. Native chunk IPC performance has not been measured.
 * Bytes never live in a process registry. Status polling must not call this service.
 * Explicit createReview compares only the current review, not a history of snapshots.
 * Validation performs direct token lookup and never creates/replaces a review.
 * All disk errors are sanitized: platform paths and unpublished content stay private.
 */
export function createWorkspaceReviewStore(disk: ReviewDisk, options: ReviewLimits = {}) {
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 512 * 1024 * 1024;
  const maxStoreBytes = options.maxStoreBytes ?? 1024 * 1024 * 1024;
  const metadataReserve = 2 * maxManifestBytes;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  if (![maxSnapshotBytes, maxStoreBytes, ttlMs].every(value => Number.isSafeInteger(value) && value > 0)
    || maxStoreBytes <= metadataReserve) throw unavailable();

  async function manifest(): Promise<Manifest | null> {
    const reader = await disk.openRead('manifest.json');
    if (!reader) return null;
    try {
      // Metadata is bounded independently of file payloads.
      const buffer = new Uint8Array(maxManifestBytes + 1);
      const count = await readChunk(reader, buffer);
      if (count > maxManifestBytes) throw unavailable();
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))) as Manifest;
      if (value.version !== 1 || !isReviewToken(value.confirmation) || !Number.isSafeInteger(value.expiresAt)
        || !Array.isArray(value.rows) || !Array.isArray(value.sizes) || value.sizes.length !== value.rows.length
        || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > maxSnapshotBytes) throw unavailable();
      const state = canonical(value);
      if (!sameState(state, value)) throw unavailable();
      let total = 0;
      value.sizes.forEach((size, index) => {
        if (!value.rows[index][2]) { if (size !== null) throw unavailable(); }
        else if (size === null || !Number.isSafeInteger(size) || size < 0) throw unavailable();
        else total += size;
      });
      if (total !== value.bytes) throw unavailable();
      return value;
    } finally { await reader.close(); }
  }

  async function compare(review: Manifest, state: ReviewState, source: ReviewSource): Promise<boolean> {
    if (review.expiresAt <= now() || !sameState(review, state)) return false;
    const saved = await disk.openRead(review.confirmation + '.bin');
    if (!saved) return false;
    const left = new Uint8Array(reviewChunkBytes), right = new Uint8Array(reviewChunkBytes);
    try {
      for (let index = 0; index < state.rows.length; index++) {
        const size = review.sizes[index];
        if (size === null) continue;
        const current = await source(state.rows[index][0]);
        if (!current) return false;
        try {
          let remaining = size;
          while (remaining > 0) {
            const length = Math.min(remaining, reviewChunkBytes);
            if (await readChunk(current, left.subarray(0, length)) !== length
              || await readChunk(saved, right.subarray(0, length)) !== length) return false;
            for (let offset = 0; offset < length; offset++) if (left[offset] !== right[offset]) return false;
            remaining -= length;
          }
          if (await readChunk(current, left.subarray(0, 1))) return false;
        } finally { await current.close(); }
      }
      return await readChunk(saved, right.subarray(0, 1)) === 0 && review.expiresAt > now();
    } finally { await saved.close(); }
  }

  async function cleanup(keep: Manifest | null) {
    const names = await disk.list();
    if (names.some(name => !isReviewDiskName(name))) throw unavailable();
    for (const name of names) {
      if (name === 'manifest.json' || name === keep?.confirmation + '.bin') continue;
      await disk.remove(name);
    }
  }
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    try { return await disk.withLock(action); }
    catch (error) { if (error instanceof StudioError) throw error; throw unavailable(); }
  }

  return {
    createReview(state: ReviewState, source: ReviewSource): Promise<WorkspaceReview> {
      return locked(async () => {
        state = canonical(state);
        let previous = await manifest();
        if (previous && previous.expiresAt <= now()) {
          await disk.remove('manifest.json');
          previous = null;
        }
        await cleanup(previous);
        if (previous && await compare(previous, state, source)) {
          return { confirmation: previous.confirmation, expiresAt: previous.expiresAt };
        }
        if ((previous?.bytes ?? 0) + metadataReserve > maxStoreBytes) throw new StudioError(413, workspaceReviewTooLarge);
        const confirmation = crypto.randomUUID();
        const partial = confirmation + '.partial', published = confirmation + '.bin';
        let writer: ReviewWriter | undefined;
        let metadata: ReviewWriter | undefined;
        let ownsPartial = false, ownsPayload = false, ownsMetadata = false;
        try {
          writer = await disk.openNew(partial);
          ownsPartial = true;
          const sizes: Array<number | null> = [];
          let bytes = 0;
          const buffer = new Uint8Array(reviewChunkBytes);
          for (const row of state.rows) {
            if (!row[2]) { sizes.push(null); continue; }
            const reader = await source(row[0]);
            if (!reader) throw changed();
            let size = 0;
            try {
              for (;;) {
                const count = await readChunk(reader, buffer);
                if (!count) break;
                bytes += count; size += count;
                if (bytes > maxSnapshotBytes || bytes + (previous?.bytes ?? 0) + metadataReserve > maxStoreBytes) {
                  throw new StudioError(413, workspaceReviewTooLarge);
                }
                await writeAll(writer, buffer.subarray(0, count));
              }
            } catch (error) {
              try { await reader.close(); } catch { /* Preserve the capture failure. */ }
              throw error;
            }
            await reader.close();
            sizes.push(size);
          }
          await writer.close(); writer = undefined;
          const review: Manifest = { version: 1, ...state, confirmation, expiresAt: now() + ttlMs, sizes, bytes };
          const encoded = new TextEncoder().encode(JSON.stringify(review));
          if (encoded.byteLength > maxManifestBytes) throw new StudioError(413, workspaceReviewTooLarge);
          await disk.rename(partial, published); ownsPartial = false; ownsPayload = true;
          metadata = await disk.openNew('manifest.pending'); ownsMetadata = true;
          await writeAll(metadata, encoded);
          await metadata.close(); metadata = undefined;
          // Only this atomic rename publishes. Never remove this payload after publication.
          await disk.rename('manifest.pending', 'manifest.json');
          ownsMetadata = false; ownsPayload = false;
          // A published token remains successful even if old derived data cannot be removed.
          // The next capture's mandatory cleanup must succeed before allocating new payloads.
          try { await cleanup(review); } catch { /* Retry derived cleanup on the next explicit review. */ }
          return { confirmation, expiresAt: review.expiresAt };
        } catch (error) {
          try { await writer?.close(); } catch { /* Preserve original failure. */ }
          try { await metadata?.close(); } catch { /* Preserve original failure. */ }
          for (const name of [ownsPartial ? partial : null, ownsPayload ? published : null, ownsMetadata ? 'manifest.pending' : null]) {
            if (name) { try { await disk.remove(name); } catch { /* Bounded orphan; next capture must clean it first. */ } }
          }
          throw error;
        }
      });
    },
    validateReview(token: unknown, state: ReviewState, source: ReviewSource): Promise<void> {
      return locked(async () => {
        if (!isReviewToken(token)) throw changed();
        const review = await manifest();
        if (!review || review.confirmation !== token || !await compare(review, canonical(state), source)) throw changed();
      });
    },
    /** Call only under the workspace lock, e.g. on open/explicit review, never delete user data. */
    cleanup(): Promise<void> {
      return locked(async () => {
        let review = await manifest();
        if (review && review.expiresAt <= now()) { await disk.remove('manifest.json'); review = null; }
        await cleanup(review);
      });
    },
  };
}
