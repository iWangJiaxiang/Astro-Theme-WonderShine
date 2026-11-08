import assert from 'node:assert/strict';
import { constants, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { SummaryIndex, SUMMARY_INDEX_CACHE_RECIPE, type SummaryIndexCacheRecord, type SummaryIndexOptions, type SummaryIndexStore } from '../core/summary-index.js';
import { createContentSummaryContext } from '../core/content-summary.js';
import { createNativeSummaryStore } from '../platform/summary-store.js';
import type { WorkspaceFiles } from '../platform/filesystem.js';
import { createFileSummaryStore } from '../server/summary-store.js';

const MAX_BYTES = 8 * 1024 * 1024;
const nativeFiles = fs as unknown as WorkspaceFiles;
function record(scope = 'workspace:one', title = 'Private draft'): SummaryIndexCacheRecord {
  return {
    version: 1, recipe: SUMMARY_INDEX_CACHE_RECIPE, scope, state: 'clean',
    rows: [{ path: 'content/articles/example.md', title, date: '2026-01-01', draft: true, kind: 'article', tags: [], categories: [] }],
  };
}
async function fixture(run: (base: string, repository: string) => Promise<void>) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'studio-summary-store-')));
  const repository = join(base, 'repository');
  await fs.mkdir(repository);
  try { await run(base, repository); }
  finally { await fs.rm(base, { recursive: true, force: true }); }
}
/** Preserve the first failure, but never let fixture cleanup race sibling I/O. */
async function drainConcurrent(work: readonly Promise<void>[]): Promise<void> {
  try { await Promise.all(work); }
  finally { await Promise.allSettled(work); }
}
/** Read-only index checks must finish background saves before fixture removal. */
async function withSummaryIndex(options: SummaryIndexOptions & { store: SummaryIndexStore }, run: (index: SummaryIndex) => Promise<void>) {
  const saves: Promise<void>[] = [];
  const index = new SummaryIndex({ ...options, store: {
    load: () => options.store.load(),
    clear: () => options.store.clear(),
    save: value => {
      const pending = options.store.save(value);
      saves.push(pending);
      return pending;
    },
  } });
  try { await run(index); }
  finally {
    // list() publishes rows without awaiting disk I/O. Disposal fences queued
    // saves, but a save already inside an adapter is intentionally uncancellable.
    index.dispose();
    await Promise.allSettled(saves);
  }
}
const adapters = [
  {
    name: 'file',
    create: (state: string, repository: string) => createFileSummaryStore(join(state, 'summary-preview-v1'), [repository]),
  },
  {
    name: 'native',
    create: (state: string, _repository: string) => createNativeSummaryStore(nativeFiles, state),
  },
];
const posix = { skip: process.platform === 'win32' ? 'Private POSIX filesystem tests; Windows fails closed' : false };

for (const adapter of adapters) {
  test(`${adapter.name} summary storage persists only a single bounded preview and clears only its own snapshot`, posix, async () => fixture(async (base, repository) => {
    const state = join(base, 'state'); await fs.mkdir(state, { mode: 0o700 });
    const store = adapter.create(state, repository);
    assert.equal(await store.load(), null);
    await store.clear();
    await store.save(record());
    const directory = join(state, 'summary-preview-v1');
    assert.deepEqual(await fs.readdir(directory), ['snapshot.json']);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(join(directory, 'snapshot.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await adapter.create(state, repository).load(), record());
    await fs.writeFile(join(directory, '.snapshot-unrelated.tmp'), 'other worker');
    await fs.writeFile(join(state, 'history-example.json'), 'history');
    await fs.writeFile(join(state, 'transaction.json'), 'journal');
    await fs.writeFile(join(repository, 'config.toml'), 'title="workspace"');
    await store.clear(); await store.clear();
    assert.equal(await store.load(), null);
    assert.equal(await fs.readFile(join(directory, '.snapshot-unrelated.tmp'), 'utf8'), 'other worker');
    assert.equal(await fs.readFile(join(state, 'history-example.json'), 'utf8'), 'history');
    assert.equal(await fs.readFile(join(state, 'transaction.json'), 'utf8'), 'journal');
    assert.equal(await fs.readFile(join(repository, 'config.toml'), 'utf8'), 'title="workspace"');
  }));

  test(`${adapter.name} rejects ancestor, directory and target symlinks without touching destinations`, posix, async () => fixture(async (base, repository) => {
    const state = join(base, 'state'); await fs.mkdir(state, { mode: 0o700 });
    const outside = join(base, 'outside'); await fs.mkdir(outside, { mode: 0o700 });
    const secret = join(outside, 'secret'); await fs.writeFile(secret, 'untouched', { mode: 0o600 });
    const alias = join(base, 'alias'); await fs.symlink(state, alias);
    const ancestorStore = adapter.create(alias, repository);
    await assert.rejects(ancestorStore.save(record()), /Unsafe/);
    await assert.rejects(ancestorStore.load(), /Unsafe/);
    await assert.rejects(ancestorStore.clear(), /Unsafe/);
    const directory = join(state, 'summary-preview-v1');
    await fs.symlink(outside, directory);
    const store = adapter.create(state, repository);
    await assert.rejects(store.save(record()), /Unsafe/);
    await assert.rejects(store.load(), /Unsafe/);
    await assert.rejects(store.clear(), /Unsafe/);
    await fs.unlink(directory); await fs.mkdir(directory, { mode: 0o700 });
    await fs.symlink(secret, join(directory, 'snapshot.json'));
    await assert.rejects(store.save(record()), /Unsafe/);
    await assert.rejects(store.load(), /Unsafe/);
    await assert.rejects(store.clear(), /Unsafe/);
    assert.equal(await fs.readFile(secret, 'utf8'), 'untouched');
    assert.deepEqual(await fs.readdir(directory), ['snapshot.json'], 'failed save removes only its own temp');
  }));

  test(`${adapter.name} rejects oversize, corrupt JSON and invalid UTF-8 but leaves schema validation to index`, posix, async () => fixture(async (base, repository) => {
    const state = join(base, 'state'); await fs.mkdir(state, { mode: 0o700 });
    const store = adapter.create(state, repository); await store.save(record());
    const target = join(state, 'summary-preview-v1/snapshot.json');
    await fs.truncate(target, MAX_BYTES + 1);
    await assert.rejects(store.load(), /byte limit/);
    await assert.rejects(store.save(record('workspace:one', 'x'.repeat(MAX_BYTES))), /byte limit/);
    await assert.rejects(store.save(record('workspace:one', '界'.repeat(MAX_BYTES / 2))), /byte limit/);
    await fs.writeFile(target, '{broken'); await assert.rejects(store.load(), SyntaxError);
    await fs.writeFile(target, new Uint8Array([0xff])); await assert.rejects(store.load(), /encoding|encoded/i);
    await fs.writeFile(target, '{"version":999,"rows":null}');
    assert.deepEqual(await store.load(), { version: 999, rows: null });
    let builds = 0;
    await withSummaryIndex({ scope: 'workspace:one', store, builder: {
      fresh: async () => { builds++; return { facts: [], context: createContentSummaryContext({}) }; },
      apply: async snapshot => snapshot,
    } }, async index => {
      assert.equal(await index.preview(), null);
      assert.deepEqual(await index.list(), []);
      assert.equal(builds, 1);
    });
    assert.deepEqual(await store.load(), { ...record(), rows: [] }, 'fresh preview is fully saved before fixture cleanup');
  }));

  test(`${adapter.name} concurrent writers and readers see whole snapshots, never freshness authority`, posix, async () => fixture(async (base, repository) => {
    const state = join(base, 'state'); await fs.mkdir(state, { mode: 0o700 });
    const first = adapter.create(state, repository), second = adapter.create(state, repository);
    const a = record('workspace:one', 'a'.repeat(4096)), b = record('workspace:one', 'b'.repeat(4096));
    await first.save(a);
    await drainConcurrent([
      (async () => { for (let i = 0; i < 12; i++) await first.save(a); })(),
      (async () => { for (let i = 0; i < 12; i++) await second.save(b); })(),
      (async () => {
        for (let i = 0; i < 30; i++) {
          const value = await first.load() as SummaryIndexCacheRecord;
          assert.ok(value.rows[0].title === a.rows[0].title || value.rows[0].title === b.rows[0].title);
          assert.deepEqual(value, value.rows[0].title === a.rows[0].title ? a : b);
        }
      })(),
    ]);
    await first.clear(); await second.save(b); // A clear cannot fence another worker.
    let builds = 0;
    await withSummaryIndex({ scope: b.scope, store: first, builder: {
      fresh: async () => { builds++; return { facts: [], context: createContentSummaryContext({}) }; },
      apply: async snapshot => snapshot,
    } }, async index => {
      assert.deepEqual(await index.preview(), { source: 'cache', authoritative: false, rows: b.rows });
      assert.deepEqual(await index.list(), [], 'authoritative listing must rebuild, never hydrate preview');
      assert.equal(builds, 1);
    });
    assert.deepEqual(await first.load(), { ...record(), rows: [] }, 'fresh preview is fully saved before fixture cleanup');
  }));

  test(`${adapter.name} separate directories isolate snapshots and exact scopes are checked by the index`, posix, async () => fixture(async (base, repository) => {
    const one = join(base, 'one'), two = join(base, 'two');
    await fs.mkdir(one, { mode: 0o700 }); await fs.mkdir(two, { mode: 0o700 });
    const a = adapter.create(one, repository), b = adapter.create(two, repository);
    await a.save(record('one')); await b.save(record('two'));
    const index = new SummaryIndex({ scope: 'two', store: a, builder: {
      fresh: async () => ({ facts: [], context: createContentSummaryContext({}) }), apply: async snapshot => snapshot,
    } });
    assert.equal(await index.preview(), null);
    await a.clear(); assert.deepEqual(await b.load(), record('two'));
  }));
}

test('concurrent fixture drains every worker and preserves the first writer or reader failure', async () => {
  for (const failedWorker of [0, 2]) { // Two writers and one reader, as above.
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const failure = new Error(failedWorker === 0 ? 'writer failed' : 'reader assertion failed');
    const settled: number[] = [];
    let directory = '', cleaned = false;
    const running = fixture(async base => {
      directory = base;
      const work = [0, 1, 2].map(async worker => {
        try {
          if (worker === failedWorker) throw failure;
          await gate;
          // A sibling is still using the fixture after the first rejection.
          await fs.writeFile(join(base, `worker-${worker}`), 'finished');
          if (worker === 1) throw new Error('later worker failure');
        } finally { settled.push(worker); }
      });
      const draining = drainConcurrent(work);
      started();
      await draining;
    }).finally(() => { cleaned = true; });
    // Observe rejection immediately, including a later sibling rejection.
    const finished = assert.rejects(running, error => error === failure);
    try {
      await ready;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(settled, [failedWorker]);
      assert.equal(cleaned, false, 'teardown must wait for all pending workers');
      assert.equal((await fs.stat(directory)).isDirectory(), true);
    } finally {
      release();
      await finished;
    }
    assert.deepEqual(settled.sort(), [0, 1, 2]);
    assert.equal(cleaned, true);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  }
});

test('index fixture waits for an in-flight save even when assertions or persistence fail', async () => {
  for (const fail of [false, true]) {
    let release!: () => void, started!: () => void, checked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const saving = new Promise<void>(resolve => { started = resolve; });
    const assertionsDone = new Promise<void>(resolve => { checked = resolve; });
    let saved = false, cleaned = false;
    const failure = new Error('assertion failed');
    const running = withSummaryIndex({ scope: 'fixture', store: {
      load: async () => null,
      clear: async () => {},
      save: async () => {
        started(); await gate;
        saved = true;
        if (fail) throw new Error('disk full');
      },
    }, builder: {
      fresh: async () => ({ facts: [], context: createContentSummaryContext({}) }),
      apply: async snapshot => snapshot,
    } }, async index => {
      assert.deepEqual(await index.list(), []);
      await saving;
      checked();
      if (fail) throw failure;
    }).finally(() => { cleaned = true; });
    // Attach the rejection assertion before releasing the deliberately failed save.
    const finished = fail ? assert.rejects(running, error => error === failure) : running;
    try {
      await assertionsDone;
      // Let promise continuations reach teardown; the save stays blocked by the
      // explicit gate, not by a filesystem delay or a wall-clock timeout.
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(saved, false, 'listing does not wait for preview persistence');
      assert.equal(cleaned, false, 'fixture cannot be removed while the adapter is writing');
    } finally {
      release();
      await finished;
    }
    assert.equal(saved, true);
    assert.equal(cleaned, true);
  }
});

test('file summary storage refuses repository/public boundaries, permissive modes and hardlinks', posix, async () => fixture(async (base, repository) => {
  for (const path of [repository, join(repository, 'cache'), base, join(base, 'public/cache')]) {
    assert.throws(() => createFileSummaryStore(path, [repository]), /Unsafe/);
  }
  assert.throws(() => createFileSummaryStore(join(base, 'state'), []), /Unsafe/);
  assert.throws(() => createFileSummaryStore('relative', [repository]), /Unsafe/);
  assert.throws(() => createFileSummaryStore(join(base, 'state'), ['relative']), /Unsafe/);
  const repositoryAlias = join(base, 'repository-alias'); await fs.symlink(repository, repositoryAlias);
  const aliasedBoundary = createFileSummaryStore(join(repository, 'private-cache'), [repositoryAlias]);
  await assert.rejects(aliasedBoundary.save(record()), /Unsafe/);
  await assert.rejects(aliasedBoundary.load(), /Unsafe/);
  await assert.rejects(aliasedBoundary.clear(), /Unsafe/);
  const directory = join(base, 'state'); await fs.mkdir(directory, { mode: 0o755 }); await fs.chmod(directory, 0o755);
  const store = createFileSummaryStore(directory, [repository]);
  await assert.rejects(store.save(record()), /Unsafe/);
  await fs.chmod(directory, 0o700); await store.save(record());
  const target = join(directory, 'snapshot.json'); await fs.chmod(target, 0o644);
  await assert.rejects(store.load(), /Unsafe/); await assert.rejects(store.save(record()), /Unsafe/); await assert.rejects(store.clear(), /Unsafe/);
  await fs.chmod(target, 0o600);
  await fs.link(target, join(base, 'linked'));
  await assert.rejects(store.load(), /Unsafe/); await assert.rejects(store.save(record()), /Unsafe/); await assert.rejects(store.clear(), /Unsafe/);
}));

test('native summary storage stays within the trusted state scope and rechecks root, children and target', posix, async () => fixture(async base => {
  const state = join(base, 'state'); await fs.mkdir(state, { mode: 0o700 });
  const directory = join(state, 'summary-preview-v1'), target = join(directory, 'snapshot.json');
  const inspected: string[] = [];
  const files: WorkspaceFiles = { ...nativeFiles, lstat: async path => {
    // Model Tauri's granted state scope: even inspecting an ancestor is forbidden.
    if (path !== state && !path.startsWith(state + '/')) throw new Error('Outside granted state scope');
    inspected.push(path);
    return nativeFiles.lstat(path);
  } };
  const store = createNativeSummaryStore(files, state);
  assert.equal(await store.load(), null);
  await store.clear();
  await store.save(record());
  assert.deepEqual(await store.load(), record());
  await store.save(record('workspace:one', 'Replacement'));
  assert.deepEqual(await createNativeSummaryStore(files, state).load(), record('workspace:one', 'Replacement'));
  await store.clear();
  assert.equal(await store.load(), null);
  assert.ok(inspected.includes(state));
  assert.ok(inspected.includes(directory));
  assert.ok(inspected.includes(target));
  assert.ok(inspected.some(path => path.startsWith(directory + '/.snapshot-')));

  const outside = join(base, 'outside'); await fs.mkdir(outside, { mode: 0o700 });
  const secret = join(outside, 'secret'); await fs.writeFile(secret, 'untouched', { mode: 0o600 });
  const rejectOperations = async () => {
    await assert.rejects(store.load(), /Unsafe/);
    await assert.rejects(store.save(record()), /Unsafe/);
    await assert.rejects(store.clear(), /Unsafe/);
  };
  await fs.symlink(secret, target);
  await rejectOperations();
  assert.deepEqual(await fs.readdir(directory), ['snapshot.json'], 'failed save removes its temp without replacing the target symlink');
  await fs.unlink(target); await fs.rmdir(directory);
  await fs.symlink(outside, directory);
  await rejectOperations();
  await fs.unlink(directory); await fs.rmdir(state);
  await fs.symlink(outside, state);
  await rejectOperations();
  await fs.unlink(state); await fs.writeFile(state, 'not a directory');
  await rejectOperations();
  assert.equal(await fs.readFile(secret, 'utf8'), 'untouched');
  assert.deepEqual(await fs.readdir(outside), ['secret']);
}));

test('native AppData authorization checks all ancestors inside the grant and rejects escaping state roots', posix, async () => fixture(async base => {
  const authorizationRoot = join(base, 'AppData');
  const workspaces = join(authorizationRoot, 'workspaces'), workspace = join(workspaces, 'id');
  const state = join(workspace, 'state');
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const inspected: string[] = [];
  const files: WorkspaceFiles = { ...nativeFiles, lstat: async path => {
    if (path !== authorizationRoot && !path.startsWith(authorizationRoot + '/')) throw new Error('Outside granted AppData scope');
    inspected.push(path);
    return nativeFiles.lstat(path);
  } };
  for (const invalid of [base, authorizationRoot + '-other/state', join(base, 'other/state')]) {
    assert.throws(() => createNativeSummaryStore(files, invalid, authorizationRoot), /Unsafe/);
  }
  assert.equal(inspected.length, 0, 'reject invalid boundaries before filesystem access');
  const store = createNativeSummaryStore(files, state, authorizationRoot);
  assert.equal(await store.load(), null);
  await store.clear();
  await store.save(record());
  assert.deepEqual(await createNativeSummaryStore(files, state, authorizationRoot).load(), record());
  for (const path of [authorizationRoot, workspaces, workspace, state, join(state, 'summary-preview-v1'), join(state, 'summary-preview-v1/snapshot.json')]) {
    assert.ok(inspected.includes(path), `must check ${path}`);
  }
  // Static symlink aliases remain inside the grant and resolve to the original
  // valid snapshot, so checking only state itself would incorrectly accept them.
  for (const path of [workspace, workspaces, authorizationRoot]) {
    const moved = path + '-original';
    await fs.rename(path, moved);
    await fs.symlink(moved, path);
    try {
      await assert.rejects(store.load(), /Unsafe/);
      await assert.rejects(store.save(record('changed')), /Unsafe/);
      await assert.rejects(store.clear(), /Unsafe/);
    } finally {
      await fs.unlink(path);
      await fs.rename(moved, path);
    }
    assert.deepEqual(await store.load(), record(), 'rejected operations must leave the existing snapshot untouched');
  }
  await store.clear();
  assert.equal(await store.load(), null);
}));

test('native checks size before reading and again after adapter reads', posix, async () => fixture(async (base, repository) => {
  const state = join(base, 'state'); await fs.mkdir(state, { mode: 0o700 });
  await createNativeSummaryStore(nativeFiles, state).save(record());
  const target = join(state, 'summary-preview-v1/snapshot.json');
  let reads = 0;
  const files: WorkspaceFiles = { ...nativeFiles, readFile: async (...args) => { reads++; return nativeFiles.readFile(...args); } };
  const store = createNativeSummaryStore(files, state);
  await fs.truncate(target, MAX_BYTES + 1);
  await assert.rejects(store.load(), /byte limit/); assert.equal(reads, 0);
  await fs.writeFile(target, '{}');
  const growing: WorkspaceFiles = { ...files, readFile: async () => new Uint8Array(MAX_BYTES + 1) };
  await assert.rejects(createNativeSummaryStore(growing, state).load(), /byte limit/);
  const checked: WorkspaceFiles = { ...files, readCheckedFile: async (_path, limit) => {
    assert.equal(limit, MAX_BYTES); return new Uint8Array(MAX_BYTES + 1);
  } };
  await assert.rejects(createNativeSummaryStore(checked, state).load(), /byte limit/);
}));

test('native write/rename faults preserve the old snapshot and cleanup is bounded to this operation', posix, async () => fixture(async (base, _repository) => {
  const state = join(base, 'state'); await fs.mkdir(state, { mode: 0o700 });
  const good = createNativeSummaryStore(nativeFiles, state); await good.save(record());
  const directory = join(state, 'summary-preview-v1');
  await fs.writeFile(join(directory, '.snapshot-other.tmp'), 'other worker');
  for (const fault of ['write', 'rename']) {
    const files: WorkspaceFiles = { ...nativeFiles,
      writeFile: async (path, data, options) => {
        if (fault === 'write') { await nativeFiles.writeFile(path, 'partial', options); throw new Error('disk full'); }
        await nativeFiles.writeFile(path, data, options);
      },
      rename: async (from, to) => { if (fault === 'rename') throw new Error('rename failed'); await fs.rename(from, to); },
    };
    await assert.rejects(createNativeSummaryStore(files, state).save(record('new')), /disk full|rename failed/);
    assert.deepEqual(await good.load(), record());
    assert.deepEqual((await fs.readdir(directory)).sort(), ['.snapshot-other.tmp', 'snapshot.json']);
  }
}));

test('storage failures are cache-only: index rebuilds and dirty failure does not authorize incremental updates', async () => {
  let fresh = 0, applied = 0;
  const store: SummaryIndexStore = {
    load: async () => { throw new Error('corrupt cache'); },
    save: async () => { throw new Error('disk full'); },
    clear: async () => { throw new Error('read-only filesystem'); },
  };
  const index = new SummaryIndex({ scope: 'one', store, builder: {
    fresh: async () => { fresh++; return { facts: [], context: createContentSummaryContext({}) }; },
    apply: async snapshot => { applied++; return snapshot; },
  } });
  assert.equal(await index.preview(), null);
  assert.deepEqual(await index.list(), []);
  const id = Symbol();
  await index.onMutation({ type: 'begin', operation: 'writeBatch', id });
  await index.onMutation({ type: 'committed', operation: 'writeBatch', id, beginRecorded: true, changes: [] });
  assert.deepEqual(await index.list(), []);
  assert.equal(applied, 0); assert.equal(fresh, 2);
  let saves = 0;
  const saveFailure = new SummaryIndex({ scope: 'one', store: { ...store,
    save: async () => { saves++; throw new Error('disk full'); },
  }, builder: {
    fresh: async () => ({ facts: [], context: createContentSummaryContext({}) }),
    apply: async snapshot => snapshot,
  } });
  assert.deepEqual(await saveFailure.list(), [], 'save failure cannot fail an authoritative scan');
  assert.equal(saves, 1);
});

// These overlays model metadata observations, not kernel pathname race traces.
function overlayStats(info: Stats, fields: Partial<Pick<Stats, 'nlink' | 'uid'>>): Stats {
  const copy = Object.create(Object.getPrototypeOf(info), Object.getOwnPropertyDescriptors(info)) as Stats;
  return Object.assign(copy, fields);
}
type HandleTrace = { events: string[]; completed: string[]; links: number[]; handle?: FileHandle };
function handleTrace(): HandleTrace { return { events: [], completed: [], links: [] }; }
async function observedOpen(path: string, flags: number, mode: number | undefined, trace: HandleTrace,
  prepare?: (handle: FileHandle) => Promise<void>, nlink?: number): Promise<FileHandle> {
  const handle = await fs.open(path, flags, mode);
  trace.handle = handle;
  try {
    await prepare?.(handle);
    return new Proxy(handle, { get(real, property) {
      const value = Reflect.get(real, property, real);
      if (typeof value !== 'function') return value;
      if (property === 'stat') return async (...args: unknown[]) => {
        trace.events.push('stat');
        const info = await Reflect.apply(value, real, args) as Stats;
        trace.links.push(info.nlink);
        trace.completed.push('stat');
        return nlink === undefined ? info : overlayStats(info, { nlink });
      };
      if (property === 'read' || property === 'writeFile' || property === 'sync' || property === 'close') return async (...args: unknown[]) => {
        trace.events.push(property);
        const result = await Reflect.apply(value, real, args);
        trace.completed.push(property);
        return result;
      };
      return value.bind(real);
    } });
  } catch (error) { await handle.close(); throw error; }
}
function assertClosed(trace: HandleTrace) {
  assert.ok(trace.handle, 'the real open boundary was reached');
  assert.equal(trace.handle.fd, -1, 'the real handle is closed, not merely a proxy call');
  assert.equal(trace.events.at(-1), 'close');
  assert.deepEqual(trace.completed, trace.events, 'every observed real I/O call completed successfully');
}
function assertTempPath(path: string, directory: string) {
  assert.equal(dirname(path), directory);
  assert.match(basename(path), /^\.snapshot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/);
}
const targetReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const tempWriteFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const invalidLinks = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
const operations = ['load', 'save', 'clear'] as const;
type StoreOperation = typeof operations[number];
async function operate(store: SummaryIndexStore, operation: StoreOperation, value: SummaryIndexCacheRecord) {
  if (operation === 'save') return store.save(value);
  return store[operation]();
}
async function linkFixture(run: (context: {
  base: string; repository: string; state: string; directory: string; target: string;
  good: SummaryIndexStore; a: SummaryIndexCacheRecord; b: SummaryIndexCacheRecord;
  original: Buffer; sentinels: () => Promise<void>;
}) => Promise<void>) {
  await fixture(async (base, repository) => {
    const state = join(base, 'state'); await fs.mkdir(state, { mode: 0o700 });
    const directory = join(state, 'summary-preview-v1'), target = join(directory, 'snapshot.json');
    const good = createFileSummaryStore(directory, [repository]);
    const a = record('workspace:one', 'a'.repeat(4096)), b = record('workspace:one', 'b'.repeat(4096));
    await good.save(a);
    const original = await fs.readFile(target);
    const files = [
      [join(directory, '.snapshot-other.tmp'), 'other worker'],
      [join(base, 'history-example.json'), 'history'],
      [join(base, 'transaction.json'), 'journal'],
      [join(repository, 'config.toml'), 'title="workspace"'],
    ];
    for (const [path, text] of files) await fs.writeFile(path, text, { mode: 0o600 });
    const sentinels = async () => {
      for (const [path, text] of files) assert.equal(await fs.readFile(path, 'utf8'), text);
    };
    await run({ base, repository, state, directory, target, good, a, b, original, sentinels });
    await sentinels();
  });
}

// A: each public operation must select the exact published pathname policy.
for (const operation of operations) {
  test(`file published pathname nlink 0 permits ${operation}`, posix, async () => linkFixture(async ({ directory, target, repository, good, a, b }) => {
    let hits = 0;
    const store = createFileSummaryStore(directory, [repository], { lstat: async path => {
      const info = await fs.lstat(path);
      if (path !== target) return info;
      hits++; assert.equal(info.nlink, 1);
      return overlayStats(info, { nlink: 0 });
    } });
    const result = await operate(store, operation, b);
    assert.equal(hits, 1);
    if (operation === 'load') assert.deepEqual(result, a);
    assert.deepEqual(await createFileSummaryStore(directory, [repository]).load(), operation === 'clear' ? null : operation === 'save' ? b : a);
    assert.deepEqual((await fs.readdir(directory)).sort(), operation === 'clear' ? ['.snapshot-other.tmp'] : ['.snapshot-other.tmp', 'snapshot.json']);
    if (operation === 'clear') assert.equal(await good.load(), null);
  }));
  for (const nlink of [2, ...invalidLinks]) {
    test(`file published pathname nlink ${nlink} refuses ${operation}`, posix, async () => linkFixture(async ({ directory, target, repository, good, a, b, original }) => {
      let hits = 0;
      const store = createFileSummaryStore(directory, [repository], { lstat: async path => {
        const info = await fs.lstat(path);
        if (path !== target) return info;
        hits++; return overlayStats(info, { nlink });
      } });
      await assert.rejects(operate(store, operation, b), /Unsafe/);
      assert.equal(hits, 1);
      assert.deepEqual(await fs.readFile(target), original);
      assert.deepEqual(await good.load(), a);
      assert.deepEqual((await fs.readdir(directory)).sort(), ['.snapshot-other.tmp', 'snapshot.json'], 'failed save cleans only its normal temp');
    }));
  }
}

// B: real old/unlinked and hardlinked opened inodes, plus numeric-domain overlays.
test('file opened published inode with real nlink 0 reads old A while new pathname contains B', posix, async () => linkFixture(async ({ directory, target, repository, good, a, b }) => {
  const trace = handleTrace(); let opens = 0, hits = 0;
  const store = createFileSummaryStore(directory, [repository], {
    lstat: async path => { const info = await fs.lstat(path); if (path === target) { hits++; assert.equal(info.nlink, 1); } return info; },
    open: async (path, flags, mode) => {
      assert.equal(path, target); assert.equal(flags, targetReadFlags); assert.equal(mode, undefined); opens++;
      return observedOpen(path, flags, mode, trace, async () => { await good.save(b); });
    },
  });
  assert.deepEqual(await store.load(), a);
  assert.equal(hits, 1); assert.equal(opens, 1);
  assert.deepEqual(trace.links, [0, 0]);
  assert.equal(trace.events[0], 'stat');
  assert.deepEqual(trace.events.filter(event => event !== 'read'), ['stat', 'stat', 'close'], 'load never writes or syncs the old inode');
  assert.ok(trace.events.filter(event => event === 'read').length >= 2, 'bounded content reads and extra-byte probe reached real I/O');
  assert.deepEqual(trace.events.slice(-2), ['stat', 'close']); assertClosed(trace);
  assert.deepEqual(await createFileSummaryStore(directory, [repository]).load(), b);
}));
for (const nlink of [2, ...invalidLinks]) {
  test(`file opened published inode nlink ${nlink} rejects before read and closes`, posix, async () => linkFixture(async ({ base, directory, target, repository, good, a, original }) => {
    const trace = handleTrace(); let hits = 0, opens = 0;
    const alias = join(base, 'published-alias');
    const store = createFileSummaryStore(directory, [repository], {
      lstat: async path => { const info = await fs.lstat(path); if (path === target) { hits++; assert.equal(info.nlink, 1); } return info; },
      open: async (path, flags, mode) => {
        assert.equal(path, target); assert.equal(flags, targetReadFlags); assert.equal(mode, undefined); opens++;
        return observedOpen(path, flags, mode, trace, nlink === 2 ? async () => { await fs.link(target, alias); } : undefined, nlink === 2 ? undefined : nlink);
      },
    });
    await assert.rejects(store.load(), /Unsafe/);
    assert.equal(hits, 1); assert.equal(opens, 1);
    assert.deepEqual(trace.links, [nlink === 2 ? 2 : 1], '2 is real hardlink metadata; invalid numbers are overlays');
    assert.deepEqual(trace.events, ['stat', 'close'], 'no read/write/sync on rejected handle'); assertClosed(trace);
    assert.deepEqual(await fs.readFile(target), original);
    if (nlink === 2) {
      assert.equal((await fs.lstat(alias)).ino, (await fs.lstat(target)).ino);
      assert.deepEqual(await fs.readFile(alias), original);
      await assert.rejects(good.load(), /Unsafe/);
    } else assert.deepEqual(await good.load(), a);
  }));
}

// C1: reject temp handle metadata before any write; cleanup cannot mask a lost guard.
for (const nlink of [0, 2]) {
  test(`file temp handle real nlink ${nlink} rejects before write and closes`, posix, async () => linkFixture(async ({ base, directory, target, repository, good, a, b, original }) => {
    const trace = handleTrace(), alias = join(base, 'temp-handle-alias');
    let temporary = '', targetHits = 0, tempHits = 0, cleanupMissing = 0;
    const store = createFileSummaryStore(directory, [repository], {
      open: async (path, flags, mode) => {
        assertTempPath(path, directory); assert.equal(flags, tempWriteFlags); assert.equal(mode, 0o600);
        assert.equal(temporary, ''); temporary = path;
        return observedOpen(path, flags, mode, trace, async () => {
          if (nlink === 0) await fs.unlink(path); else await fs.link(path, alias);
        });
      },
      lstat: async path => {
        if (path === target) targetHits++;
        if (path === temporary) {
          tempHits++; assert.deepEqual(trace.events, ['stat', 'close'], 'cleanup follows the handle guard, never write or pathname preflight');
        }
        try { return await fs.lstat(path); }
        catch (error) { if (path === temporary && (error as NodeJS.ErrnoException).code === 'ENOENT') cleanupMissing++; throw error; }
      },
    });
    await assert.rejects(store.save(b), /Unsafe/);
    assert.deepEqual(trace.links, [nlink]); assert.deepEqual(trace.events, ['stat', 'close']); assertClosed(trace);
    assert.equal(targetHits, 0); assert.equal(tempHits, 1); assert.equal(cleanupMissing, nlink === 0 ? 1 : 0);
    assert.deepEqual(await fs.readFile(target), original); assert.deepEqual(await good.load(), a);
    if (nlink === 0) {
      await assert.rejects(fs.lstat(temporary), { code: 'ENOENT' });
      assert.deepEqual((await fs.readdir(directory)).sort(), ['.snapshot-other.tmp', 'snapshot.json']);
    } else {
      assert.equal((await fs.lstat(temporary)).nlink, 2);
      assert.equal((await fs.lstat(alias)).ino, (await fs.lstat(temporary)).ino);
      assert.equal((await fs.readFile(temporary)).length, 0);
      assert.equal((await fs.readFile(alias)).length, 0);
    }
  }));
}

// C2: handle succeeds; the first temp pathname check is a separate rejection phase.
for (const nlink of [0, 2]) {
  test(`file temp pathname nlink ${nlink} remains strict after successful handle write`, posix, async () => linkFixture(async ({ base, directory, target, repository, good, a, b, original }) => {
    const trace = handleTrace(), alias = join(base, 'temp-path-alias');
    let temporary = '', tempHits = 0, targetHits = 0;
    const phases: string[] = [];
    const store = createFileSummaryStore(directory, [repository], {
      open: async (path, flags, mode) => {
        assertTempPath(path, directory); assert.equal(flags, tempWriteFlags); assert.equal(mode, 0o600);
        assert.equal(temporary, ''); temporary = path;
        return observedOpen(path, flags, mode, trace);
      },
      lstat: async path => {
        if (path === target) targetHits++;
        if (path === temporary) {
          tempHits++; phases.push(tempHits === 1 ? 'pathname' : 'cleanup');
          assert.deepEqual(trace.events, ['stat', 'writeFile', 'sync', 'close']); assertClosed(trace);
          if (tempHits === 1 && nlink === 2) await fs.link(path, alias);
        }
        const info = await fs.lstat(path);
        if (path === temporary && tempHits === 1 && nlink === 0) { assert.equal(info.nlink, 1); return overlayStats(info, { nlink: 0 }); }
        if (path === temporary) assert.equal(info.nlink, nlink === 2 ? 2 : 1);
        return info;
      },
    });
    await assert.rejects(store.save(b), /Unsafe/);
    assert.deepEqual(trace.links, [1]); assert.deepEqual(trace.events, ['stat', 'writeFile', 'sync', 'close']); assertClosed(trace);
    assert.deepEqual(phases, ['pathname', 'cleanup']); assert.equal(tempHits, 2); assert.equal(targetHits, 0);
    assert.deepEqual(await fs.readFile(target), original); assert.deepEqual(await good.load(), a);
    if (nlink === 0) {
      await assert.rejects(fs.lstat(temporary), { code: 'ENOENT' });
      assert.deepEqual((await fs.readdir(directory)).sort(), ['.snapshot-other.tmp', 'snapshot.json']);
    } else {
      assert.equal((await fs.lstat(temporary)).nlink, 2);
      assert.equal((await fs.lstat(alias)).ino, (await fs.lstat(temporary)).ino);
      assert.deepEqual(JSON.parse(await fs.readFile(temporary, 'utf8')), b);
      assert.deepEqual(JSON.parse(await fs.readFile(alias, 'utf8')), b);
    }
  }));
}

// C3: only cleanup sees the overlay; an unsafe rejection must replace the sentinel.
for (const nlink of [0, 2]) {
  test(`file own-temp cleanup nlink ${nlink} refuses deletion and does not propagate sentinel`, posix, async () => linkFixture(async ({ directory, target, repository, good, a, b, original }) => {
    const failure = new Error('target preflight sentinel'), trace = handleTrace();
    let temporary = '', targetHits = 0, tempHits = 0;
    const phases: string[] = [];
    const store = createFileSummaryStore(directory, [repository], {
      open: async (path, flags, mode) => {
        assertTempPath(path, directory); assert.equal(flags, tempWriteFlags); assert.equal(mode, 0o600);
        assert.equal(temporary, ''); temporary = path;
        return observedOpen(path, flags, mode, trace);
      },
      lstat: async path => {
        const info = await fs.lstat(path);
        if (path === target) {
          targetHits++; phases.push('target-failure'); assert.equal(tempHits, 1); throw failure;
        }
        if (path === temporary) {
          tempHits++; assert.equal(info.nlink, 1); assertClosed(trace);
          assert.deepEqual(trace.events, ['stat', 'writeFile', 'sync', 'close']);
          if (tempHits === 1) { phases.push('pathname'); return info; }
          phases.push('cleanup'); assert.equal(targetHits, 1);
          return overlayStats(info, { nlink });
        }
        return info;
      },
    });
    await assert.rejects(store.save(b), error => {
      assert.notEqual(error, failure); assert.match((error as Error).message, /Unsafe/); return true;
    });
    assert.equal(targetHits, 1); assert.equal(tempHits, 2);
    assert.deepEqual(phases, ['pathname', 'target-failure', 'cleanup']);
    assert.deepEqual(trace.links, [1]); assert.deepEqual(trace.events, ['stat', 'writeFile', 'sync', 'close']); assertClosed(trace);
    assert.equal((await fs.lstat(temporary)).nlink, 1, 'cleanup 0/2 are observations over a real still-linked own temp');
    assert.deepEqual(JSON.parse(await fs.readFile(temporary, 'utf8')), b);
    assert.deepEqual((await fs.readdir(directory)).sort(), [basename(temporary), '.snapshot-other.tmp', 'snapshot.json'].sort());
    assert.deepEqual(await fs.readFile(target), original); assert.deepEqual(await good.load(), a);
  }));
}

// D: real unsafe types/modes/ancestry still reject with zero links observed.
const unsafeZeroStates = ['target-symlink', 'target-mode', 'directory-mode', 'ancestor-symlink', 'owner-overlay', 'directory-leaf'] as const;
for (const stateKind of unsafeZeroStates) {
  for (const operation of operations) {
    test(`file zero links cannot bypass ${stateKind} for ${operation}`, posix, async () => linkFixture(async ({ base, state, directory, target, repository, good, a, b, original }) => {
      const secret = join(base, 'outside-sentinel'); await fs.writeFile(secret, 'untouched', { mode: 0o600 });
      const moved = state + '-original';
      let rejectedPath = target;
      if (stateKind === 'target-symlink') { await fs.unlink(target); await fs.symlink(secret, target); }
      if (stateKind === 'target-mode') await fs.chmod(target, 0o644);
      if (stateKind === 'directory-mode') { await fs.chmod(directory, 0o755); rejectedPath = directory; }
      if (stateKind === 'ancestor-symlink') { await fs.rename(state, moved); await fs.symlink(moved, state); rejectedPath = state; }
      if (stateKind === 'directory-leaf') { await fs.unlink(target); await fs.mkdir(target, { mode: 0o700 }); }
      let hits = 0;
      const opened: HandleTrace[] = [];
      const store = createFileSummaryStore(directory, [repository], {
        lstat: async path => {
          const info = await fs.lstat(path);
          if (path !== rejectedPath) return info;
          hits++;
          // Only this owner case changes two fields; it does not model real chown.
          return overlayStats(info, stateKind === 'owner-overlay' ? { nlink: 0, uid: process.getuid!() + 1 } : { nlink: 0 });
        },
        open: async (path, flags, mode) => {
          assertTempPath(path, directory); assert.equal(flags, tempWriteFlags); assert.equal(mode, 0o600);
          const trace = handleTrace(); opened.push(trace);
          return observedOpen(path, flags, mode, trace);
        },
      });
      await assert.rejects(operate(store, operation, b), /Unsafe/);
      assert.equal(hits, 1, 'the specifically unsafe entry was observed with zero links');
      const writesTemp = operation === 'save' && !['directory-mode', 'ancestor-symlink'].includes(stateKind);
      assert.equal(opened.length, writesTemp ? 1 : 0, 'unsafe ancestry/directory is rejected before open');
      for (const trace of opened) {
        assert.deepEqual(trace.links, [1]); assert.deepEqual(trace.events, ['stat', 'writeFile', 'sync', 'close']); assertClosed(trace);
      }
      assert.equal(await fs.readFile(secret, 'utf8'), 'untouched');
      assert.deepEqual((await fs.readdir(directory)).sort(), ['.snapshot-other.tmp', 'snapshot.json'], 'no retained safe own temp or replacement');
      if (stateKind === 'target-symlink') {
        assert.equal((await fs.lstat(target)).isSymbolicLink(), true); assert.equal(await fs.readlink(target), secret);
        await fs.unlink(target); await good.save(a);
      } else if (stateKind === 'directory-leaf') {
        assert.equal((await fs.lstat(target)).isDirectory(), true); assert.deepEqual(await fs.readdir(target), []);
        await fs.rmdir(target); await good.save(a);
      } else {
        assert.deepEqual(await fs.readFile(target), original);
        if (stateKind === 'target-mode') { assert.equal((await fs.lstat(target)).mode & 0o777, 0o644); await fs.chmod(target, 0o600); }
        if (stateKind === 'directory-mode') { assert.equal((await fs.lstat(directory)).mode & 0o777, 0o755); await fs.chmod(directory, 0o700); }
        if (stateKind === 'ancestor-symlink') {
          assert.equal((await fs.lstat(state)).isSymbolicLink(), true); assert.equal(await fs.readlink(state), moved);
          await fs.unlink(state); await fs.rename(moved, state);
        }
      }
      assert.deepEqual(await createFileSummaryStore(directory, [repository]).load(), a);
    }));
  }
}
