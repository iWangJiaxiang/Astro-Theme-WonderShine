import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRepository } from '../platform/file-repository.js';
import type { WorkspaceFiles } from '../platform/filesystem.js';
import type { Repository, RepositoryWrite } from '../shared/repository.js';
import type { WorkspaceControl } from '../shared/workspace.js';
import { observeRepository } from '../core/observed-repository.js';
import { createContentSummaryContext, projectContentSummaries, readContentSummaryFacts } from '../core/content-summary.js';
import { SummaryIndex, createSummaryIndexBuilder, SUMMARY_INDEX_CACHE_RECIPE, type SummaryFactsSnapshot, type SummaryIndexBuilder, type SummaryIndexCacheRecord, type SummaryIndexStore } from '../core/summary-index.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const path = 'content/articles/one/index.md';
const text = (title: string, body = 'PRIVATE_BODY') => `+++\ntitle=${JSON.stringify(title)}\n+++\n${body}`;
const snapshot = (title: string): SummaryFactsSnapshot => ({ facts: [readContentSummaryFacts({ path, text: text(title) })], context: createContentSummaryContext({ default_language: 'zh-CN', languages: { en: {} } }) });
const write = (title: string): RepositoryWrite => ({ path, text: text(title), expectedRevision: null });
const begin = (index: SummaryIndex, id: symbol) => index.onMutation({ type: 'begin', id, operation: 'write' });
const commit = (index: SummaryIndex, id: symbol, title: string, beginRecorded = true) => index.onMutation({ type: 'committed', id, operation: 'write', beginRecorded, changes: [write(title)] });
const options = { scope: 'test-session', yieldToUI: async () => {} };
function fixture() {
  let value = snapshot('Original'), fresh = 0, apply = 0;
  const builder: SummaryIndexBuilder = {
    async fresh() { fresh++; return value; },
    async apply(base, changes) {
      apply++;
      return { ...base, facts: changes.filter(change => change.text !== null).map(change => readContentSummaryFacts({ path: change.path, text: change.text! })) };
    },
  };
  return { builder, counts: () => ({ fresh, apply }), set: (title: string) => { value = snapshot(title); } };
}
function cacheRecord(title = 'Cached'): SummaryIndexCacheRecord {
  return { version: 1, recipe: SUMMARY_INDEX_CACHE_RECIPE, scope: options.scope, state: 'clean', rows: [{ path, title, date: '', draft: false, kind: 'article', tags: [], categories: [] }] };
}
function storeWith(load: () => Promise<unknown>): SummaryIndexStore {
  return { load, async save() {}, async clear() {} };
}

// Promise gates deliberately avoid filesystem timing and timer polling.
test('concurrent lists and forced refreshes deduplicate; consumer and builder data stay isolated', async () => {
  const gate = deferred<SummaryFactsSnapshot>(), started = deferred();
  let calls = 0;
  const builder: SummaryIndexBuilder = { async fresh() { calls++; started.resolve(); return gate.promise; }, async apply(base) { return base; } };
  const index = new SummaryIndex({ ...options, builder });
  const first = index.list(), second = index.list(), refresh = index.refresh();
  await started.promise;
  assert.equal(calls, 1);
  const original = snapshot('Original');
  gate.resolve(original);
  const [a, b, c] = await Promise.all([first, second, refresh]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  a[0].title = 'Consumer mutation'; a[0].tags.push('changed');
  original.facts[0].fields!.title = 'Builder mutation';
  assert.equal((await index.list())[0].title, 'Original');
  assert.deepEqual((await index.list())[0].tags, []);
  assert.equal(calls, 1);
});

test('begin invalidates before durable work; list waits and final writes apply once', async () => {
  const f = fixture(), clear = deferred(), clearing = deferred();
  const store: SummaryIndexStore = { ...storeWith(async () => null), async clear() { clearing.resolve(); await clear.promise; } };
  const index = new SummaryIndex({ ...options, builder: f.builder, store });
  await index.list();
  const id = Symbol(), beginning = begin(index, id);
  let resolved = false;
  const pending = index.list().then(rows => { resolved = true; return rows; });
  await clearing.promise;
  assert.equal(resolved, false);
  assert.equal(await index.preview(), null);
  clear.resolve(); await beginning;
  await commit(index, id, 'Saved');
  assert.equal((await pending)[0].title, 'Saved');
  assert.deepEqual(f.counts(), { fresh: 1, apply: 1 });
});

test('old fresh success cannot replace a new generation or leak through its old request', async () => {
  const old = deferred<SummaryFactsSnapshot>(), started = deferred();
  let calls = 0;
  const builder: SummaryIndexBuilder = { async fresh() { if (++calls === 1) { started.resolve(); return old.promise; } return snapshot('New'); }, async apply(base) { return base; } };
  const index = new SummaryIndex({ ...options, builder });
  const oldRequest = index.list(); await started.promise;
  index.invalidate();
  assert.equal((await index.list())[0].title, 'New');
  old.resolve(snapshot('Old'));
  assert.equal((await oldRequest)[0].title, 'New');
  assert.equal((await index.list())[0].title, 'New');
  assert.equal(calls, 2);
});

test('old callers follow new rows without waiting for an abandoned scan to settle', async () => {
  const abandoned = deferred<SummaryFactsSnapshot>(), started = deferred();
  let calls = 0;
  const index = new SummaryIndex({ ...options, builder: {
    async fresh() { if (++calls === 1) { started.resolve(); return abandoned.promise; } return snapshot('Replacement'); },
    async apply(base) { return base; },
  } });
  const old = index.list(); await started.promise;
  index.invalidate();
  assert.equal((await index.refresh())[0].title, 'Replacement');
  assert.equal((await old)[0].title, 'Replacement');
  abandoned.reject(new Error('Late orphan failure'));
});

test('disposal promptly rejects readers even when their repository scan never settles', async () => {
  const started = deferred();
  const index = new SummaryIndex({ ...options, builder: {
    async fresh() { started.resolve(); return new Promise<SummaryFactsSnapshot>(() => {}); },
    async apply(base) { return base; },
  } });
  const pending = index.list(); await started.promise;
  index.dispose();
  await assert.rejects(pending, /disposed/);
});

test('invalidated and disposed previews stop waiting for hung store loads', async () => {
  for (const dispose of [false, true]) {
    const loading = deferred(), abandoned = deferred<unknown>();
    const index = new SummaryIndex({ ...options, builder: fixture().builder,
      store: storeWith(async () => { loading.resolve(); return abandoned.promise; }),
    });
    const preview = index.preview(); await loading.promise;
    if (dispose) index.dispose(); else index.invalidate();
    assert.equal(await preview, null);
    abandoned.reject(new Error('Late orphan cache failure'));
  }
});

test('obsolete fresh failure is ignored; current failures remain retryable', async () => {
  const old = deferred<SummaryFactsSnapshot>(), started = deferred();
  let calls = 0;
  const builder: SummaryIndexBuilder = { async fresh() {
    calls++;
    if (calls === 1) { started.resolve(); return old.promise; }
    return snapshot('Recovered');
  }, async apply(base) { return base; } };
  const index = new SummaryIndex({ ...options, builder });
  const oldRequest = index.list(); await started.promise;
  index.invalidate();
  assert.equal((await index.list())[0].title, 'Recovered');
  assert.equal((await oldRequest)[0].title, 'Recovered');
  old.reject(new Error('Obsolete failure'));
  let attempts = 0;
  const retry = new SummaryIndex({ ...options, builder: {
    async fresh() { if (++attempts === 1) throw new Error('Current failure'); return snapshot('Recovered'); },
    async apply(base) { return base; },
  } });
  await assert.rejects(retry.list(), /Current failure/);
  assert.equal((await retry.list())[0].title, 'Recovered');
});

test('overlapping writes discard both delta bases; readers wait for every terminal event', async () => {
  const f = fixture(), index = new SummaryIndex({ ...options, builder: f.builder });
  await index.list();
  const a = Symbol(), b = Symbol(); await begin(index, a); await begin(index, b);
  let resolved = false;
  const pending = index.list().then(rows => { resolved = true; return rows; });
  await commit(index, a, 'A');
  assert.equal(resolved, false);
  f.set('Authoritative A+B'); await commit(index, b, 'B');
  assert.equal((await pending)[0].title, 'Authoritative A+B');
  assert.deepEqual(f.counts(), { fresh: 2, apply: 0 });
});

test('uncertain sync, unrecorded begin and unknown terminal events force fresh state', async () => {
  const f = fixture(), index = new SummaryIndex({ ...options, builder: f.builder });
  await index.list();
  const sync = Symbol();
  await index.onMutation({ type: 'begin', id: sync, operation: 'sync' });
  f.set('After failed sync');
  await index.onMutation({ type: 'uncertain', id: sync, operation: 'sync', beginRecorded: true });
  assert.equal((await index.list())[0].title, 'After failed sync');
  const id = Symbol(); await begin(index, id);
  f.set('After unrecorded write'); await commit(index, id, 'Untrusted delta', false);
  assert.equal((await index.list())[0].title, 'After unrecorded write');
  f.set('Unknown terminal'); await commit(index, Symbol(), 'Not authority');
  assert.equal((await index.list())[0].title, 'Unknown terminal');
  assert.deepEqual(f.counts(), { fresh: 4, apply: 0 });
});

test('external invalidation during a write prevents applying an old base', async () => {
  const f = fixture(), index = new SummaryIndex({ ...options, builder: f.builder });
  await index.list();
  const id = Symbol(); await begin(index, id);
  index.invalidate(); f.set('External change plus write'); await commit(index, id, 'Write only');
  assert.equal((await index.list())[0].title, 'External change plus write');
  assert.deepEqual(f.counts(), { fresh: 2, apply: 0 });
});

test('a suspended delta cannot publish after forced refresh', async () => {
  const delta = deferred<SummaryFactsSnapshot>(), applying = deferred(), f = fixture();
  f.builder.apply = async () => { applying.resolve(); return delta.promise; };
  const index = new SummaryIndex({ ...options, builder: f.builder });
  await index.list();
  const id = Symbol(); await begin(index, id);
  const committed = commit(index, id, 'Delta'); await applying.promise;
  f.set('Forced fresh');
  assert.equal((await index.refresh())[0].title, 'Forced fresh');
  delta.resolve(snapshot('Obsolete delta')); await committed;
  assert.equal((await index.list())[0].title, 'Forced fresh');
});

test('a second write beginning during delta application forces fresh reconciliation', async () => {
  const delta = deferred<SummaryFactsSnapshot>(), applying = deferred(), f = fixture();
  let applications = 0;
  f.builder.apply = async () => { applications++; applying.resolve(); return delta.promise; };
  const index = new SummaryIndex({ ...options, builder: f.builder }); await index.list();
  const a = Symbol(), b = Symbol(); await begin(index, a);
  const first = commit(index, a, 'A'); await applying.promise;
  await begin(index, b); f.set('A and B'); await commit(index, b, 'B');
  assert.equal((await index.list())[0].title, 'A and B');
  delta.resolve(snapshot('Old A')); await first;
  assert.equal((await index.list())[0].title, 'A and B');
  assert.equal(applications, 1);
});

test('failed delta context is swallowed and the next list rebuilds', async () => {
  const f = fixture(); f.builder.apply = async () => { throw new Error('Bad context'); };
  const index = new SummaryIndex({ ...options, builder: f.builder }); await index.list();
  const id = Symbol(); await begin(index, id);
  f.set('Repaired context'); await commit(index, id, 'Ignored delta');
  assert.equal((await index.list())[0].title, 'Repaired context');
  assert.equal(f.counts().fresh, 2);
});

test('disposal stops publication and releases mutation-waiting readers', async () => {
  const fresh = deferred<SummaryFactsSnapshot>(), started = deferred();
  let saves = 0;
  const index = new SummaryIndex({ ...options,
    builder: { async fresh() { started.resolve(); return fresh.promise; }, async apply(base) { return base; } },
    store: { ...storeWith(async () => null), async save() { saves++; } },
  });
  const pending = index.list(); await started.promise;
  index.dispose(); fresh.resolve(snapshot('Late'));
  await assert.rejects(pending, /disposed/); await assert.rejects(index.list(), /disposed/);
  assert.equal(saves, 0, 'late fresh completion cannot publish or begin persistence');
  const waiting = new SummaryIndex({ ...options, builder: fixture().builder });
  await begin(waiting, Symbol()); const reader = waiting.list(); waiting.dispose();
  await assert.rejects(reader, /disposed/);
});

test('generation checks protect projection across cooperative yields', async () => {
  const paused = deferred(), yielded = deferred(); let once = true, calls = 0;
  const large = snapshot('Old'); large.facts = Array.from({ length: 40 }, () => large.facts[0]);
  const index = new SummaryIndex({ ...options,
    builder: { async fresh() { return ++calls === 1 ? large : snapshot('New'); }, async apply(base) { return base; } },
    async yieldToUI() { if (once) { once = false; yielded.resolve(); await paused.promise; } },
  });
  const pending = index.list(); await yielded.promise;
  index.invalidate(); assert.equal((await index.list())[0].title, 'New');
  paused.resolve(); assert.deepEqual(await pending, await index.list());
});

test('persisted preview is scoped and isolated, never list or incremental authority', async () => {
  const f = fixture(); let loads = 0;
  const record = cacheRecord(), store = storeWith(async () => { loads++; return record; });
  const index = new SummaryIndex({ ...options, builder: f.builder, store });
  const [a, b] = await Promise.all([index.preview(), index.preview()]);
  assert.equal(loads, 1); assert.equal(a?.authoritative, false); assert.equal(a?.source, 'cache');
  a!.rows[0].title = 'Changed'; assert.equal(b?.rows[0].title, 'Cached');
  const id = Symbol(); await begin(index, id); await commit(index, id, 'Cannot apply to preview');
  assert.equal((await index.list())[0].title, 'Original');
  assert.deepEqual(f.counts(), { fresh: 1, apply: 0 });
  const other = new SummaryIndex({ ...options, scope: 'different-session', builder: f.builder, store });
  assert.equal(await other.preview(), null);
});

test('preview rejects dirty, wrong-recipe, unsafe, malformed and oversized records', async () => {
  const invalid = [
    { ...cacheRecord(), state: 'dirty' }, { ...cacheRecord(), version: 2 }, { ...cacheRecord(), recipe: 'old' },
    { ...cacheRecord(), rows: [{ ...cacheRecord().rows[0], tags: [3] }] },
    { ...cacheRecord(), rows: [{ ...cacheRecord().rows[0], path: 'content/articles/../private.md' }] },
    { ...cacheRecord(), rows: [{ ...cacheRecord().rows[0], path: 'config.toml' }] },
  ];
  for (const record of invalid) {
    const index = new SummaryIndex({ ...options, builder: fixture().builder, store: storeWith(async () => record) });
    assert.equal(await index.preview(), null);
  }
  for (const bounds of [{ maxCacheRows: 0 }, { maxCacheBytes: 10 }]) {
    const index = new SummaryIndex({ ...options, ...bounds, builder: fixture().builder, store: storeWith(async () => cacheRecord()) });
    assert.equal(await index.preview(), null);
  }
});

test('late preview loads and already resolved previews cannot survive invalidation', async () => {
  const loaded = deferred<unknown>(), loading = deferred();
  const index = new SummaryIndex({ ...options, builder: fixture().builder, store: storeWith(async () => { loading.resolve(); return loaded.promise; }) });
  const pending = index.preview(); await loading.promise;
  await begin(index, Symbol()); loaded.resolve(cacheRecord());
  assert.equal(await pending, null); index.dispose();
  const ready = new SummaryIndex({ ...options, builder: fixture().builder, store: storeWith(async () => cacheRecord()) });
  assert.ok(await ready.preview());
  const reused = ready.preview(); ready.invalidate();
  assert.equal(await reused, null);
});

test('persisted records are bounded projections without private body, revision or config', async () => {
  const saved = deferred<SummaryIndexCacheRecord>(), source = snapshot('Visible');
  source.context.config.secret = 'PRIVATE_CONFIG';
  const index = new SummaryIndex({ ...options, builder: { async fresh() { return source; }, async apply(base) { return base; } }, store: {
    ...storeWith(async () => null), async save(record) { saved.resolve(record); },
  } });
  await index.list(); const record = await saved.promise;
  assert.deepEqual(Object.keys(record.rows[0]).sort(), ['categories', 'date', 'draft', 'kind', 'path', 'tags', 'title']);
  assert.ok(!JSON.stringify(record).includes('PRIVATE_'));
  const cleared = deferred(); let saves = 0;
  const bounded = new SummaryIndex({ ...options, maxCacheRows: 0, builder: fixture().builder, store: {
    ...storeWith(async () => null), async save() { saves++; }, async clear() { cleared.resolve(); },
  } });
  assert.equal((await bounded.list()).length, 1, 'bounds never truncate authoritative lists');
  await cleared.promise; assert.equal(saves, 0);
});

test('dirty markers follow in-flight saves and marker failure disables incremental reuse', async () => {
  const saving = deferred(), saveDone = deferred(), cleared = deferred(), events: string[] = [], f = fixture();
  const index = new SummaryIndex({ ...options, builder: f.builder, store: {
    async load() { return cacheRecord(); },
    async save() { events.push('save-start'); saving.resolve(); await saveDone.promise; events.push('save-end'); },
    async clear() { events.push('clear'); cleared.resolve(); throw new Error('Disk full'); },
  } });
  await index.list(); await saving.promise;
  const id = Symbol(), beginning = begin(index, id);
  assert.deepEqual(events, ['save-start']); saveDone.resolve(); await cleared.promise; await beginning;
  f.set('Fresh after dirty failure'); await commit(index, id, 'Must not apply');
  assert.equal((await index.list())[0].title, 'Fresh after dirty failure');
  assert.deepEqual(f.counts(), { fresh: 2, apply: 0 });
  assert.deepEqual(events, ['save-start', 'save-end', 'clear']); assert.equal(await index.preview(), null);
});

test('clean disposal preserves the saved display-only preview for reopening', async () => {
  let record: SummaryIndexCacheRecord | null = null, clears = 0;
  const saved = deferred();
  const store: SummaryIndexStore = {
    async load() { return record; },
    async save(value) { record = structuredClone(value); saved.resolve(); },
    async clear() { clears++; record = null; },
  };
  const index = new SummaryIndex({ ...options, builder: fixture().builder, store });
  await index.list(); await saved.promise;
  index.dispose();
  const fresh = fixture(); fresh.set('Current repository');
  const reopened = new SummaryIndex({ ...options, builder: fresh.builder, store });
  const preview = await reopened.preview();
  assert.equal(preview?.rows[0].title, 'Original');
  assert.equal(preview?.authoritative, false);
  assert.equal(clears, 0);
  assert.equal((await reopened.list())[0].title, 'Current repository');
  assert.equal(fresh.counts().fresh, 1, 'retained preview still cannot satisfy authoritative reads');
});

test('an already-running save may finish after disposal as a stale-only preview', async () => {
  const saving = deferred(), release = deferred(), saved = deferred();
  let record: SummaryIndexCacheRecord | null = null, saves = 0, clears = 0;
  const store: SummaryIndexStore = {
    async load() { return record; },
    async save(value) { saves++; saving.resolve(); await release.promise; record = value; saved.resolve(); },
    async clear() { clears++; record = null; },
  };
  const index = new SummaryIndex({ ...options, builder: fixture().builder, store });
  await index.list(); await saving.promise;
  index.dispose(); release.resolve(); await saved.promise;
  await assert.rejects(index.list(), /disposed/);
  const reopened = new SummaryIndex({ ...options, builder: fixture().builder, store });
  assert.equal((await reopened.preview())?.rows[0].title, 'Original');
  assert.equal(saves, 1); assert.equal(clears, 0);
});

test('queued saves do not start after disposal', async () => {
  const clearing = deferred(), release = deferred();
  let saves = 0;
  const store: SummaryIndexStore = {
    async load() { return null; },
    async save() { saves++; },
    async clear() { clearing.resolve(); await release.promise; },
  };
  const index = new SummaryIndex({ ...options, builder: fixture().builder, store });
  index.invalidate(); await clearing.promise;
  await index.list(); // Publication queues its save behind the blocked clear.
  index.dispose(); release.resolve();
  const reopened = new SummaryIndex({ ...options, builder: fixture().builder, store });
  assert.equal(await reopened.preview(), null);
  assert.equal(saves, 0);
  await assert.rejects(index.list(), /disposed/);
});

test('disposal during an unknown mutation preserves dirty-marker ordering after a late save', async () => {
  const saving = deferred(), release = deferred();
  const events: string[] = [];
  let record: SummaryIndexCacheRecord | null = null;
  const store: SummaryIndexStore = {
    async load() { return record; },
    async save(value) { events.push('save-start'); saving.resolve(); await release.promise; record = value; events.push('save-end'); },
    async clear() { events.push('clear'); record = null; },
  };
  const index = new SummaryIndex({ ...options, builder: fixture().builder, store });
  await index.list(); await saving.promise;
  const id = Symbol('sync');
  const beginning = index.onMutation({ type: 'begin', id, operation: 'sync' });
  index.dispose(); release.resolve(); await beginning;
  await index.onMutation({ type: 'uncertain', id, operation: 'sync', beginRecorded: true });
  assert.deepEqual(events, ['save-start', 'save-end', 'clear']);
  const reopened = new SummaryIndex({ ...options, builder: fixture().builder, store });
  assert.equal(await reopened.preview(), null);
});

function memoryRepository(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial)); let summaryReads = 0, revisionLists = 0, clears = 0;
  const repository = {
    mode: 'local' as const,
    clearReadCache() { clears++; },
    async read(path: string) { const text = files.get(path); return text === undefined ? null : { path, text, revision: 'real-revision' }; },
    async listForSummary() { summaryReads++; return [...files].filter(([path]) => path.startsWith('content/articles/')).map(([path, text]) => ({ path, text })); },
    async list() { revisionLists++; throw new Error('Revision-bearing summary scan'); },
    async write(path: string, text: string | null) {
      if (text === null) files.delete(path); else files.set(path, text);
      return { revision: 'saved-revision', message: 'Saved' };
    },
    async writeBatch(changes: RepositoryWrite[]) {
      for (const change of changes) { if (change.text === null) files.delete(change.path); else files.set(change.path, change.text); }
      return { revision: 'saved-revision', message: 'Saved' };
    },
  } as unknown as Repository;
  return { repository, files, counts: () => ({ summaryReads, revisionLists, clears }) };
}

test('portable builder applies final writes/deletes and context without rereading documents', async () => {
  const memory = memoryRepository({ [path]: text('Original'), 'content/articles/one/index.en.md': text('English'), 'content/articles/one/index.fr.md': text('Existing French'), 'config.toml': 'default_language="zh-CN"\n[languages.en]' });
  const index = new SummaryIndex({ ...options, builder: createSummaryIndexBuilder(memory.repository, options.yieldToUI) });
  const observed = observeRepository(memory.repository, index.onMutation);
  assert.deepEqual((await index.list())[0].availableLanguages, ['en', 'zh-CN']);
  await observed.writeBatch([
    { path, text: text('Saved', 'x'.repeat(100000)), expectedRevision: null },
    { path: 'content/articles/one/index.en.md', text: null, expectedRevision: null },
    { path: 'content/articles/one/index.fr.md', text: text('French'), expectedRevision: null },
    { path: 'config.toml', text: 'broken=[', expectedRevision: null },
    { path: 'config.toml', text: 'default_language="zh-CN"\n[languages.fr]', expectedRevision: null },
  ]);
  const rows = await index.list(); assert.equal(rows[0].title, 'Saved');
  assert.deepEqual(rows[0].availableLanguages, ['fr', 'zh-CN']);
  assert.deepEqual(rows.map(row => row.path), [path, 'content/articles/one/index.fr.md']);
  assert.deepEqual(memory.counts(), { summaryReads: 1, revisionLists: 0, clears: 1 });
  assert.equal((await observed.read(path))?.revision, 'real-revision', 'edit reads remain authoritative');
  assert.equal((await observed.read(path))?.text, text('Saved', 'x'.repeat(100000)));
});

test('portable fresh parsing yields in 32-item slices and matches fresh baseline projection', async () => {
  const files = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`content/articles/${i}.md`, text(String(i))]));
  const memory = memoryRepository(files); let yields = 0;
  const fresh = await createSummaryIndexBuilder(memory.repository, async () => { yields++; }).fresh();
  assert.ok(yields >= 2, 'parsing yields before projection');
  assert.deepEqual(projectContentSummaries(fresh.facts, fresh.context), projectContentSummaries(Object.entries(files).map(([path, text]) => readContentSummaryFacts({ path, text })), createContentSummaryContext()));
});

test('new paths rediscover FileRepository traversal order instead of appending or globally sorting', async () => {
  const base = await fs.mkdtemp(join(tmpdir(), 'studio-summary-index-'));
  const root = join(base, 'repo');
  await fs.mkdir(root);
  const files: WorkspaceFiles = { ...fs as unknown as WorkspaceFiles, revisionNamespace: 'summary-index-order-test' };
  const repository = new FileRepository(files, root, join(base, 'state'));
  const index = new SummaryIndex({ ...options, builder: createSummaryIndexBuilder(repository, options.yieldToUI) });
  try {
    await repository.write('content/articles/z/index.md', text('Z'), null);
    await repository.write('content/pages/about.md', text('About'), null);
    assert.deepEqual((await index.list()).map(row => row.path), ['content/articles/z/index.md', 'content/pages/about.md']);
    const observed = observeRepository(repository, index.onMutation);
    await observed.write('content/articles/a/index.md', text('A'), null);
    const fresh = await createSummaryIndexBuilder(repository, options.yieldToUI).fresh();
    assert.deepEqual(await index.list(), projectContentSummaries(fresh.facts, fresh.context));
    assert.deepEqual((await index.list()).map(row => row.path), ['content/articles/a/index.md', 'content/articles/z/index.md', 'content/pages/about.md']);
  } finally {
    index.dispose();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('observed save survives cache failures and unknown failed sync triggers fresh scan', async () => {
  const memory = memoryRepository({ [path]: text('Original') }), syncError = new Error('Sync failed after changing files');
  const repository = Object.assign(memory.repository, { workspace: {
    async sync() { memory.files.set(path, text('Sync changed file')); throw syncError; },
  } as unknown as WorkspaceControl });
  const index = new SummaryIndex({ ...options, builder: createSummaryIndexBuilder(repository, options.yieldToUI), store: {
    async load() { throw new Error('Unavailable'); }, async save() { throw new Error('Unavailable'); }, async clear() { throw new Error('Unavailable'); },
  } });
  const observed = observeRepository(repository, index.onMutation); await index.list();
  assert.equal((await observed.write(path, text('Saved'), null)).revision, 'saved-revision');
  assert.equal((await index.list())[0].title, 'Saved');
  await assert.rejects(observed.workspace!.sync(), error => error === syncError);
  assert.equal((await index.list())[0].title, 'Sync changed file');
  assert.equal(memory.counts().summaryReads, 3);
});
