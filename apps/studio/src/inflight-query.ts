export interface InflightQueryOptions {
  maxEntries?: number;
  timeoutMs?: number;
}

interface PendingQuery {
  work: Promise<unknown>;
  refresh: boolean;
}

/** Shares pending work only. Completed values are never cached. */
export class InflightQuery {
  private generation = 0;
  private changed = new AbortController();
  private readonly pending = new Map<string, PendingQuery>();
  private readonly maxEntries: number;
  private readonly timeoutMs: number;

  constructor({ maxEntries = 32, timeoutMs = 60_000 }: InflightQueryOptions = {}) {
    this.maxEntries = Math.max(1, maxEntries);
    this.timeoutMs = timeoutMs;
  }

  invalidate() {
    const previous = this.changed;
    this.generation++;
    this.changed = new AbortController();
    this.pending.clear();
    // Wake readers and cancel obsolete work even if its transport never settles.
    previous.abort(new DOMException('Content query superseded', 'AbortError'));
  }

  async read<T>(key: string, load: (signal: AbortSignal, isCurrent: () => boolean) => Promise<T>, options: { refresh?: boolean; assertCurrent?: () => void } = {}): Promise<T> {
    if (options.refresh) this.invalidate();
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      options.assertCurrent?.();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DOMException('Query timed out', 'TimeoutError');
      let entry = this.pending.get(key);
      // A refresh obligation survives mutation invalidation and retry ordering.
      // Only another forced loader may satisfy it, never an ordinary reader.
      if (options.refresh && entry && !entry.refresh) {
        this.invalidate();
        entry = undefined;
      }
      // Keep existing readers tracked: eviction could let an older response
      // overtake a newer request for the same key.
      if (!entry && this.pending.size >= this.maxEntries) throw new Error('Too many pending content queries');
      const generation = this.generation;
      const changed = this.changed.signal;
      if (!entry) {
        const work = this.start(signal => load(signal, () => generation === this.generation), remaining, changed);
        entry = { work, refresh: !!options.refresh };
        this.pending.set(key, entry);
        const cleanup = () => { if (this.pending.get(key) === entry) this.pending.delete(key); };
        void work.then(cleanup, cleanup);
      }
      try {
        const value = await this.wait(entry.work as Promise<T>, remaining, changed);
        options.assertCurrent?.();
        if (generation !== this.generation) continue;
        return structuredClone(value);
      } catch (error) {
        options.assertCurrent?.();
        if (generation !== this.generation) continue;
        throw error;
      }
    }
  }

  private wait<T>(work: Promise<T>, timeoutMs: number, changed: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); changed.removeEventListener('abort', superseded); };
      const superseded = () => { cleanup(); reject(changed.reason); };
      const timer = setTimeout(() => { cleanup(); reject(new DOMException('Query timed out', 'TimeoutError')); }, timeoutMs);
      changed.addEventListener('abort', superseded, { once: true });
      // Keep observing orphan work, including its eventual rejection.
      void work.then(
        value => { cleanup(); resolve(value); },
        error => { cleanup(); reject(error); },
      );
      if (changed.aborted) superseded();
    });
  }

  private start<T>(load: (signal: AbortSignal) => Promise<T>, timeoutMs: number, changed: AbortSignal): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); changed.removeEventListener('abort', superseded); };
      const cancel = (error: unknown) => { cleanup(); controller.abort(error); reject(error); };
      const superseded = () => cancel(changed.reason);
      const timer = setTimeout(() => cancel(new DOMException('Query timed out', 'TimeoutError')), timeoutMs);
      changed.addEventListener('abort', superseded, { once: true });
      // Observe both outcomes even when a transport ignores cancellation.
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return load(controller.signal); }).then(
        value => { cleanup(); resolve(value); },
        error => { cleanup(); reject(error); },
      );
      if (changed.aborted) superseded();
    });
  }
}
