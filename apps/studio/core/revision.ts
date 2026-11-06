/** Process-local exact-text baselines. Tokens are identities, never content digests.
 * Eviction/restart deliberately invalidates old drafts; callers must not rebind them. */
export interface RevisionRegistryOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}
interface Baseline { text: string; token: string; bytes: number; touched: number }
export class RevisionRegistry {
  private readonly entries = new Map<string, Baseline>();
  private readonly epoch = crypto.randomUUID();
  private sequence = 0;
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(options: RevisionRegistryOptions = {}) {
    this.maxEntries = options.maxEntries ?? 512;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
    if (![this.maxEntries, this.maxBytes, this.ttlMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid revision registry limits');
  }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
  private expire(now: number): void {
    // Map order is LRU order; a read touches both timestamp and position.
    for (const [key, entry] of this.entries) {
      if (now - entry.touched < this.ttlMs) break;
      this.remove(key);
    }
  }
  revision(scope: string, path: string, text: string): string {
    const now = this.now();
    this.expire(now);
    const key = JSON.stringify([scope, path]);
    const previous = this.entries.get(key);
    if (previous?.text === text) {
      previous.touched = now;
      this.entries.delete(key); this.entries.set(key, previous);
      return previous.token;
    }
    this.remove(key);
    const token = `baseline:${this.epoch}:${++this.sequence}`;
    // Account for retained UTF-16 strings plus conservative per-entry overhead.
    const bytes = 2 * (key.length + text.length + token.length) + 256;
    if (bytes > this.maxBytes) return token; // Unretainable baselines always fail closed on save.
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { text, token, bytes, touched: now }); this.bytes += bytes;
    return token;
  }
  get size(): number { this.expire(this.now()); return this.entries.size; }
  get retainedBytes(): number { this.expire(this.now()); return this.bytes; }
}

// One bounded registry, not one unbounded map of registries per workspace.
export const contentRevisions = new RevisionRegistry();

/** Immutable snapshot adapters may return an existing storage identity. Returning
 * null falls back to an exact-text baseline (e.g. an uncommitted working file). */
export interface SnapshotRevisionStrategy {
  revision(path: string, text: string): Promise<string | null>;
}

/** Preserve URL/branch/path identity across cold online Git instances without
 * hashing file bodies or conflating identical blobs in different documents. */
export function gitBlobRevision(scope: string, path: string, oid: string): string {
  return `git-blob:${JSON.stringify([scope, path, oid])}`;
}
