import type { Repository } from '../shared/repository.js';
import type { ArticleSummary } from '../shared/types.js';
import { observeRepository, type RepositoryMutationEvent } from './observed-repository.js';
import { SummaryIndex, createSummaryIndexBuilder, type SummaryIndexStore } from './summary-index.js';

export interface SummaryRuntimeOptions {
  scope: string;
  store?: SummaryIndexStore;
  yieldToUI?: () => Promise<void>;
  /** Online Git owns a bounded shared read checkout; ordinary scans may reuse it. */
  preserveReadCacheOnScan?: boolean;
}

/** Explicitly owned by one connection/app, not a global repository cache registry. */
export function createSummaryRuntime(rawRepository: Repository, options: SummaryRuntimeOptions) {
  // Do not clear an online checkout between sibling bootstrap/content requests.
  // Explicit refresh and observed writes still invalidate the real adapter below.
  const builderRepository = options.preserveReadCacheOnScan ? new Proxy(rawRepository, {
    get(target, property) {
      if (property === 'clearReadCache') return undefined;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) : rawRepository;
  const index = new SummaryIndex({
    builder: createSummaryIndexBuilder(builderRepository, options.yieldToUI),
    scope: options.scope, store: options.store, yieldToUI: options.yieldToUI,
  });
  let pending: Promise<ArticleSummary[]> | undefined;
  let refreshing: Promise<ArticleSummary[]> | undefined;
  const forgetFlights = () => { pending = undefined; refreshing = undefined; };
  const onMutation = async (event: RepositoryMutationEvent) => {
    forgetFlights();
    // Invalidate synchronously before any fallible adapter/cache work.
    const notification = index.onMutation(event);
    try {
      // Adapter caching is independent of summary deltas and revision authority.
      rawRepository.clearReadCache?.();
    } catch {
      index.invalidate();
    }
    await notification;
  };
  const repository = observeRepository(rawRepository, onMutation);
  const invalidate = () => {
    forgetFlights();
    index.invalidate();
    rawRepository.clearReadCache?.();
  };
  const list = (options: { fresh?: boolean } = {}): Promise<ArticleSummary[]> => {
    if (!pending) {
      // A fresh server request has a zero-duration summary lease. Only callers
      // arriving during this operation share work; settled rows are never reused.
      const flight = options.fresh ? index.listFresh() : index.list();
      pending = flight;
      void flight.finally(() => { if (pending === flight) pending = undefined; }).catch(() => {});
    }
    // Keep consumer ownership separate even when the underlying work is shared.
    return pending.then(rows => structuredClone(rows));
  };
  return {
    rawRepository, repository, index,
    list,
    invalidate,
    refresh(): Promise<ArticleSummary[]> {
      if (!refreshing) {
        invalidate();
        const flight = list();
        refreshing = flight;
        void flight.finally(() => { if (refreshing === flight) refreshing = undefined; }).catch(() => {});
      }
      return refreshing.then(rows => structuredClone(rows));
    },
    preview: () => index.preview(),
    /** Custom gateways may write outside the observed repository, including on failure. */
    async withUnobservedMutation<T>(operation: () => Promise<T>): Promise<T> {
      const id = Symbol('external mutation');
      await onMutation({ type: 'begin', operation: 'sync', id });
      try { return await operation(); }
      finally { await onMutation({ type: 'uncertain', operation: 'sync', id, beginRecorded: true }); }
    },
    dispose() { forgetFlights(); index.dispose(); },
  };
}

export type SummaryRuntime = ReturnType<typeof createSummaryRuntime>;

/** Catch accidental cross-workspace injection without ever wrapping an observer twice. */
export function requireSummaryRuntime(repository: Repository, runtime: SummaryRuntime): SummaryRuntime {
  if (repository !== runtime.rawRepository && repository !== runtime.repository) throw new Error('Summary runtime belongs to a different repository');
  return runtime;
}
