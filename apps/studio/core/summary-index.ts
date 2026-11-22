import { parse } from 'smol-toml';
import { validatePath, type Repository, type RepositoryWrite } from '../shared/repository.js';
import type { ArticleSummary, Json } from '../shared/types.js';
import type { RepositoryMutationEvent, RepositoryMutationListener } from './observed-repository.js';
import {
  contentSummarySteps, createContentSummaryContext, readContentSummaryFacts, updateContentSummaryFacts,
  type ContentSummaryContext, type ContentSummaryFacts,
} from './content-summary.js';

/** Only summary facts and projection context; never documents or edit revisions. */
export interface SummaryFactsSnapshot {
  facts: readonly ContentSummaryFacts[];
  context: ContentSummaryContext;
}
export interface SummaryIndexBuilder {
  /** Must read authoritative repository state, bypassing adapter read caches. */
  fresh(): Promise<SummaryFactsSnapshot>;
  /** Receives a private copy. Throw when the final writes cannot safely update context. */
  apply(snapshot: SummaryFactsSnapshot, changes: readonly Readonly<RepositoryWrite>[]): Promise<SummaryFactsSnapshot>;
  restore?(facts: ContentSummaryFacts[]): Promise<SummaryFactsSnapshot>;
}

const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Optional portable builder; timer slices cover parsing as well as projection. */
export function createSummaryIndexBuilder(repository: Repository, yieldToUI: () => Promise<void> = yieldTask,
  managedOrder?: (a: string, b: string) => number): SummaryIndexBuilder {
  const context = (text: string | null) => createContentSummaryContext(text === null ? {} : JSON.parse(JSON.stringify(parse(text))) as Record<string, Json>);
  return {
    restore: managedOrder && (async facts => ({ facts, context: context((await repository.read('config.toml'))?.text ?? null) })),
    async fresh() {
      repository.clearReadCache?.();
      const [files, config] = await Promise.all([
        repository.listForSummary ? repository.listForSummary() : repository.list(),
        repository.read('config.toml'),
      ]);
      const facts: ContentSummaryFacts[] = [];
      let sliceStarted = performance.now(), sliceItems = 0;
      for (const file of files) {
        facts.push(readContentSummaryFacts(file));
        if (++sliceItems >= 32 || performance.now() - sliceStarted >= 8) {
          await yieldToUI();
          sliceStarted = performance.now(); sliceItems = 0;
        }
      }
      return { facts, context: context(config?.text ?? null) };
    },
    async apply(snapshot, changes) {
      const updates = new Map<string, ContentSummaryFacts | null>();
      let nextContext = snapshot.context;
      const finalChanges = new Map(changes.map(change => [change.path, change]));
      const knownPaths = new Set(snapshot.facts.map(facts => facts.path));
      let sliceStarted = performance.now(), sliceItems = 0;
      for (const change of finalChanges.values()) {
        if (change.path === 'config.toml') nextContext = context(change.text);
        else if (/^content\/(articles|pages|collections|threads|topics)\/.+\.md$/.test(change.path)) {
          if (change.text !== null && !knownPaths.has(change.path)) {
            if (!managedOrder) throw new Error('New summary path requires repository discovery');
            if (change.path.split('/').some(part => ['node_modules', 'dist', 'processed_images'].includes(part))) continue;
          }
          updates.set(change.path, change.text === null ? null : readContentSummaryFacts({ path: change.path, text: change.text }));
        }
        if (++sliceItems >= 32 || performance.now() - sliceStarted >= 8) {
          await yieldToUI();
          sliceStarted = performance.now(); sliceItems = 0;
        }
      }
      const facts = updateContentSummaryFacts(snapshot.facts, updates);
      if (managedOrder && [...updates.keys()].some(path => !knownPaths.has(path))) facts.sort((a, b) => managedOrder(a.path, b.path));
      return { facts, context: nextContext };
    },
  };
}

/** Persist a display projection and, for private checkouts, the facts needed to rebuild it. */
export type SummaryPreviewRow = Pick<ArticleSummary, 'path' | 'title' | 'date' | 'draft' | 'kind' | 'tags' | 'categories'>;
export const SUMMARY_INDEX_CACHE_RECIPE = 'summary-preview-v1';
export interface SummaryIndexCacheRecord {
  version: 1;
  recipe: typeof SUMMARY_INDEX_CACHE_RECIPE;
  scope: string;
  state: 'clean';
  rows: SummaryPreviewRow[];
  facts?: ContentSummaryFacts[];
}
export interface SummaryIndexStore {
  load(): Promise<unknown>;
  save(record: SummaryIndexCacheRecord): Promise<void>;
  /** Must durably remove/dirty a previously clean record before resolving. */
  clear(): Promise<void>;
}
export interface SummaryIndexOptions {
  builder: SummaryIndexBuilder;
  /** An instance belongs to exactly one repository/session. No global cache registry. */
  scope: string;
  store?: SummaryIndexStore;
  maxCacheRows?: number;
  maxCacheBytes?: number;
  /** Cooperative projection scheduler; defaults to a timer every 32 units/8ms. */
  yieldToUI?: () => Promise<void>;
}
export interface SummaryIndexPreview {
  source: 'cache';
  authoritative: false;
  rows: SummaryPreviewRow[];
}

function previewRow(value: unknown): SummaryPreviewRow | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (typeof row.path !== 'string' || typeof row.title !== 'string' || typeof row.date !== 'string' || typeof row.draft !== 'boolean'
    || !['article', 'page', 'collection', 'thread', 'topic'].includes(String(row.kind))
    || !Array.isArray(row.tags) || !row.tags.every(tag => typeof tag === 'string')
    || !Array.isArray(row.categories) || !row.categories.every(category => typeof category === 'string')) return;
  try { validatePath(row.path); } catch { return; }
  if (!row.path.startsWith('content/')) return;
  return { path: row.path, title: row.title, date: row.date, draft: row.draft, kind: row.kind as ArticleSummary['kind'], tags: [...row.tags], categories: [...row.categories] };
}

function validFact(fact: ContentSummaryFacts): boolean {
  if (!fact || typeof fact.path !== 'string') return false;
  try { validatePath(fact.path); } catch { return false; }
  const root = { article: 'articles', page: 'pages', collection: 'collections', thread: 'threads', topic: 'topics' }[fact.kind];
  if (!root || !fact.path.startsWith(`content/${root}/`)) return false;
  const fields = fact.fields;
  if (fields === undefined) return true;
  return !!fields && [fields.threadTitle, fields.date, fields.updated, fields.id, fields.description].every(value => typeof value === 'string')
    && [fields.title, fields.layout, fields.link?.path, fields.link?.slug].every(value => value === undefined || typeof value === 'string')
    && !!fields.link && typeof fields.link === 'object' && typeof fields.draft === 'boolean' && typeof fields.render === 'boolean'
    && Number.isFinite(fields.weight) && Array.isArray(fields.references)
    && [fields.topics, fields.tags, fields.categories, fields.displayTags].every(value =>
      Array.isArray(value) && value.every(item => typeof item === 'string'));
}

/**
 * Summary acceleration. Only a private checkout with observed mutations can
 * restore facts. All persisted data is independent of edit authority.
 * Wire onMutation to observeRepository; external changes must call invalidate().
 * Repository.read(), write guards and revision checks must remain independent.
 */
export class SummaryIndex {
  private generation = 0;
  private readonly generationWaiters = new Set<() => void>();
  private disposed = false;
  private snapshot?: SummaryFactsSnapshot;
  private rows?: ArticleSummary[];
  private flight?: { generation: number; kind: 'fresh' | 'apply'; promise: Promise<void> };
  private mutations = new Map<symbol, { base?: SummaryFactsSnapshot }>();
  private idle?: { promise: Promise<void>; resolve: () => void };
  private persistence: Promise<void> = Promise.resolve();
  private storeHealthy = true;
  private previewFlight?: Promise<SummaryIndexPreview | null>;
  private readonly maxCacheRows: number;
  private readonly maxCacheBytes: number;

  constructor(private readonly options: SummaryIndexOptions) {
    if (!options.scope) throw new Error('Summary index requires a repository/session scope');
    this.maxCacheRows = options.maxCacheRows ?? 20000;
    this.maxCacheBytes = options.maxCacheBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxCacheRows) || this.maxCacheRows < 0 || !Number.isSafeInteger(this.maxCacheBytes) || this.maxCacheBytes < 0) {
      throw new Error('Invalid summary cache bounds');
    }
  }

  private assertActive() {
    if (this.disposed) throw new Error('Summary index disposed');
  }
  private current(generation: number) { return !this.disposed && generation === this.generation && this.mutations.size === 0; }
  /** Wake obsolete callers without waiting for uncancellable repository/store I/O. */
  private untilGenerationChanges<T>(work: Promise<T>): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const changed = () => { this.generationWaiters.delete(changed); resolve(undefined); };
      this.generationWaiters.add(changed);
      // Always attach both handlers: abandoned work can still reject much later.
      void work.then(value => {
        this.generationWaiters.delete(changed); resolve(value);
      }, error => {
        this.generationWaiters.delete(changed); reject(error);
      });
    });
  }
  private reset() {
    this.generation++;
    for (const changed of this.generationWaiters) changed();
    this.snapshot = undefined;
    this.rows = undefined;
    this.flight = undefined;
    this.previewFlight = undefined;
  }
  private discardBases() { for (const mutation of this.mutations.values()) mutation.base = undefined; }
  private releaseIdle() {
    if (!this.mutations.size || this.disposed) {
      this.idle?.resolve();
      this.idle = undefined;
    }
  }

  /** Serialize persistence so an old save cannot overtake a mutation's dirty marker. */
  private persist(action: (store: SummaryIndexStore) => Promise<void>): Promise<void> {
    const store = this.options.store;
    if (!store) return Promise.resolve();
    const pending = this.persistence.then(() => action(store));
    this.persistence = pending.catch(() => {
      // Cache failures cannot turn a successful repository write into a failure.
      // A failed dirty marker also disqualifies all pending incremental bases.
      this.storeHealthy = false;
      this.discardBases();
    });
    return this.persistence;
  }

  /** Synchronous invalidation, including while a refresh or projection is suspended. */
  invalidate(): void {
    if (this.disposed) return;
    this.reset();
    this.discardBases();
    void this.persist(store => store.clear());
  }

  private cacheRecord(rows: readonly ArticleSummary[], facts: readonly ContentSummaryFacts[]): SummaryIndexCacheRecord | undefined {
    if (rows.length > this.maxCacheRows) return;
    const record: SummaryIndexCacheRecord = { version: 1, recipe: SUMMARY_INDEX_CACHE_RECIPE, scope: this.options.scope, state: 'clean', rows: [] };
    for (const row of rows) {
      const preview = previewRow(row);
      if (!preview) return;
      record.rows.push(preview);
    }
    if (this.options.builder.restore) record.facts = [...facts];
    const fits = () => new TextEncoder().encode(JSON.stringify(record)).byteLength <= this.maxCacheBytes;
    if (!fits()) {
      delete record.facts;
      if (!fits()) return;
    }
    return record;
  }

  private asCacheRecord(value: unknown): Partial<SummaryIndexCacheRecord> | undefined {
    if (!value || typeof value !== 'object') return;
    const record = value as Partial<SummaryIndexCacheRecord>;
    if (record.version !== 1 || record.recipe !== SUMMARY_INDEX_CACHE_RECIPE || record.scope !== this.options.scope || record.state !== 'clean'
      || !Array.isArray(record.rows) || record.rows.length > this.maxCacheRows
      || new TextEncoder().encode(JSON.stringify(value)).byteLength > this.maxCacheBytes) return;
    return record;
  }

  private async initialBuild(): Promise<{ snapshot: SummaryFactsSnapshot; restored?: true }> {
    const { builder, store } = this.options;
    if (this.generation === 0 && builder.restore && store && this.storeHealthy) {
      const value = await store.load().catch(() => null);
      const facts = this.asCacheRecord(value)?.facts;
      if (Array.isArray(facts) && facts.length === (value as SummaryIndexCacheRecord).rows.length
        && facts.every(validFact) && new Set(facts.map(fact => fact.path)).size === facts.length) {
        return { snapshot: await builder.restore(facts), restored: true };
      }
    }
    return { snapshot: await builder.fresh() };
  }

  private async publish(snapshot: SummaryFactsSnapshot, generation: number, restored?: boolean) {
    if (!this.current(generation)) return;
    // Clone at the ownership boundary: builders and consumers cannot mutate the cache.
    const owned = structuredClone(snapshot);
    const steps = contentSummarySteps(owned.facts, owned.context);
    let step = steps.next(), units = 0, sliceStarted = performance.now();
    while (!step.done) {
      if (++units >= 32 || performance.now() - sliceStarted >= 8) {
        await (this.options.yieldToUI ?? yieldTask)();
        if (!this.current(generation)) return;
        units = 0; sliceStarted = performance.now();
      }
      step = steps.next();
    }
    if (!this.current(generation)) return;
    this.snapshot = owned;
    this.rows = step.value;
    if (!restored && this.options.store && this.storeHealthy) {
      const record = this.cacheRecord(step.value, owned.facts);
      void this.persist(async store => {
        if (!this.current(generation) || !this.storeHealthy) return;
        if (record) await store.save(record);
        else await store.clear();
      });
    }
  }

  private start(kind: 'fresh' | 'apply', build?: () => Promise<SummaryFactsSnapshot>) {
    const generation = this.generation;
    // Defer invoking injected code until flight is installed, including sync throws.
    const promise: Promise<void> = Promise.resolve().then(async () => {
      const { snapshot, restored } = build ? { snapshot: await build(), restored: undefined } : await this.initialBuild();
      await this.publish(snapshot, generation, restored);
    }).catch(error => {
      if (this.current(generation) && kind === 'fresh') throw error;
      // Failed or obsolete deltas never become authoritative; next list rebuilds.
    }).finally(() => {
      if (this.flight?.promise === promise) this.flight = undefined;
    });
    this.flight = { generation, kind, promise };
    return promise;
  }

  async list(): Promise<ArticleSummary[]> {
    for (;;) {
      this.assertActive();
      if (this.idle) { await this.untilGenerationChanges(this.idle.promise); continue; }
      if (this.rows) return structuredClone(this.rows);
      const work = this.flight?.promise ?? this.start('fresh');
      await this.untilGenerationChanges(work);
    }
  }

  /**
   * Zero-duration server lease: cold scans leave concurrent stale-preview reads
   * intact. Settled rows must be rescanned; this is not an explicit cache purge.
   */
  listFresh(): Promise<ArticleSummary[]> {
    this.assertActive();
    if (this.rows || this.flight?.kind === 'apply') this.reset();
    this.discardBases();
    return this.list();
  }

  /** Force an authoritative scan; simultaneous forced refreshes share one scan. */
  refresh(): Promise<ArticleSummary[]> {
    this.assertActive();
    if (this.flight?.kind !== 'fresh' || this.flight.generation !== this.generation) this.invalidate();
    return this.list();
  }

  /**
   * The only entry point for observed writes/sync. Begin invalidates before the
   * first await. Overlap or an unrecorded/uncertain terminal event forces a scan.
   */
  readonly onMutation: RepositoryMutationListener = async (event: RepositoryMutationEvent) => {
    if (this.disposed) return;
    if (event.type === 'begin') {
      const base = this.mutations.size === 0 ? this.snapshot : undefined;
      if (this.mutations.size) this.discardBases();
      this.reset();
      this.mutations.set(event.id, { base });
      if (!this.idle) {
        let resolve!: () => void;
        const promise = new Promise<void>(done => { resolve = done; });
        this.idle = { promise, resolve };
      }
      await this.persist(store => store.clear());
      return;
    }
    const mutation = this.mutations.get(event.id);
    this.mutations.delete(event.id);
    this.reset();
    if (!mutation || event.type === 'uncertain' || !event.beginRecorded) {
      this.discardBases();
      void this.persist(store => store.clear());
    }
    let applied: Promise<void> | undefined;
    if (event.type === 'committed' && event.beginRecorded && mutation?.base && this.mutations.size === 0) {
      // Final text lives only in this operation, never in the retained snapshot.
      const base = mutation.base;
      const changes = event.changes.map(change => ({ ...change }));
      applied = this.start('apply', () => this.options.builder.apply(structuredClone(base), changes));
    }
    this.releaseIdle();
    await applied;
  };

  /** Optional stale preview, explicitly separate from list()/refresh(). */
  async preview(): Promise<SummaryIndexPreview | null> {
    this.assertActive();
    if (!this.options.store || !this.storeHealthy || this.mutations.size || this.rows) return null;
    const generation = this.generation;
    if (!this.previewFlight) {
      this.previewFlight = this.persistence.then(async () => {
        if (!this.current(generation) || !this.storeHealthy || this.rows) return null;
        const value = await this.options.store!.load();
        if (!this.current(generation) || !this.storeHealthy || this.rows) return null;
        const record = this.asCacheRecord(value);
        if (!record?.rows) return null;
        const rows: SummaryPreviewRow[] = [];
        for (const value of record.rows) {
          const row = previewRow(value);
          if (!row) return null;
          rows.push(row);
        }
        return { source: 'cache' as const, authoritative: false as const, rows };
      }).catch(() => {
        if (this.current(generation)) this.storeHealthy = false;
        return null;
      });
    }
    const preview = await this.untilGenerationChanges(this.previewFlight);
    return preview && this.current(generation) && this.storeHealthy && !this.rows ? structuredClone(preview) : null;
  }

  /**
   * Stop publication without deleting the last display-only preview. A save that
   * already started may finish; queued saves check generation before starting.
   * Previously queued mutation dirty markers still run after any in-flight save.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.mutations.clear();
    this.releaseIdle();
  }
}
