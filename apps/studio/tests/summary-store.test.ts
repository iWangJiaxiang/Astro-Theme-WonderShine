import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SummaryIndex, SUMMARY_INDEX_CACHE_RECIPE, type SummaryIndexCacheRecord, type SummaryIndexStore } from '../core/summary-index.js';
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
    const index = new SummaryIndex({ scope: 'workspace:one', store, builder: {
      fresh: async () => { builds++; return { facts: [], context: createContentSummaryContext({}) }; },
      apply: async snapshot => snapshot,
    } });
    assert.equal(await index.preview(), null);
    assert.deepEqual(await index.list(), []);
    assert.equal(builds, 1);
  }));

  test(`${adapter.name} concurrent writers and readers see whole snapshots, never freshness authority`, posix, async () => fixture(async (base, repository) => {
    const state = join(base, 'state'); await fs.mkdir(state, { mode: 0o700 });
    const first = adapter.create(state, repository), second = adapter.create(state, repository);
    const a = record('workspace:one', 'a'.repeat(4096)), b = record('workspace:one', 'b'.repeat(4096));
    await first.save(a);
    await Promise.all([
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
    const index = new SummaryIndex({ scope: b.scope, store: first, builder: {
      fresh: async () => { builds++; return { facts: [], context: createContentSummaryContext({}) }; },
      apply: async snapshot => snapshot,
    } });
    assert.deepEqual(await index.preview(), { source: 'cache', authoritative: false, rows: b.rows });
    assert.deepEqual(await index.list(), [], 'authoritative listing must rebuild, never hydrate preview');
    assert.equal(builds, 1);
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
