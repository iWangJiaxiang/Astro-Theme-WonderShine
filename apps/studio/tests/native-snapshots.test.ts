import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRepository } from '../platform/file-repository';
import { RevisionRegistry } from '../core/revision';
import { withSnapshotLocks } from '../platform/snapshot-queue';
import type { WorkspaceFiles } from '../platform/filesystem';

const path = 'content/articles/hello.md';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
// Drain runnable work without releasing a deliberately suspended filesystem response.
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(run: (root: string, state: string, files: WorkspaceFiles, registry: RevisionRegistry) => Promise<void>) {
  const base = await fs.mkdtemp(join(tmpdir(), 'studio-native-snapshots-'));
  const root = base + '/repo', state = base + '/state';
  await fs.mkdir(root + '/content/articles', { recursive: true });
  await fs.mkdir(state);
  await fs.writeFile(root + '/' + path, 'A');
  await fs.writeFile(root + '/config.toml', 'other');
  const files: WorkspaceFiles = { ...fs as unknown as WorkspaceFiles, revisionNamespace: base };
  try { await run(root, state, files, new RevisionRegistry()); }
  finally { await fs.rm(base, { recursive: true, force: true }); }
}

test('snapshot batches reserve overlapping paths without cycles and isolate authorities', { timeout: 5000 }, async () => {
  const scope = crypto.randomUUID(), entered = deferred(), release = deferred();
  const events: string[] = [];
  const first = withSnapshotLocks(scope, ['b', 'a', 'a'], async () => {
    events.push('first'); entered.resolve(); await release.promise;
  });
  await entered.promise;
  const second = withSnapshotLocks(scope, ['a', 'b'], async () => { events.push('second'); });
  try {
    await withSnapshotLocks(scope + '-other', ['a', 'b'], async () => { events.push('independent'); });
    assert.deepEqual(events, ['first', 'independent']);
  } finally { release.resolve(); }
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'independent', 'second']);
});

for (const checked of [false, true]) {
  test(`native ${checked ? 'checked' : 'fallback'} snapshots serialize captured responses across adapters and instances`, { timeout: 5000 }, async () => fixture(async (root, state, files, registry) => {
    const captured = deferred(), release = deferred();
    let reads = 0;
    const capture = async <T>(file: string, read: () => Promise<T>): Promise<T> => {
      const pause = file === root + '/' + path && ++reads === 1;
      const data = await read();
      if (pause) { captured.resolve(); await release.promise; }
      return data;
    };
    // Make fallback metadata checks immediately runnable; only the byte response is gated.
    const metadata = new Map(await Promise.all(['content', 'content/articles', path].map(async relative => {
      const file = root + '/' + relative;
      return [file, await files.lstat(file)] as const;
    })));
    const delayed: WorkspaceFiles = checked
      ? { ...files, readCheckedFile: file => capture(file, () => fs.readFile(file)) }
      : { ...files,
        lstat: async file => metadata.get(file) ?? await files.lstat(file),
        stat: async file => metadata.get(file) ?? await files.stat(file),
        readFile: (file, options) => capture(file, () => files.readFile(file, options)),
      };
    const first = new FileRepository(delayed, root, state, undefined, registry);
    const second = new FileRepository({ ...delayed }, root, state, undefined, registry);
    const old = first.read(path);
    await captured.promise;
    let fresh!: ReturnType<FileRepository['read']>;
    try {
      await fs.writeFile(root + '/' + path, 'B');
      fresh = second.read(path);
      assert.equal((await second.read('config.toml'))?.text, 'other', 'unrelated paths must not wait');
      await turn();
      assert.equal(reads, 1, 'the second read must not start its filesystem snapshot yet');
    } finally { release.resolve(); }
    assert.equal((await old)?.text, 'A');
    const current = (await fresh)!;
    assert.equal(current.text, 'B');
    assert.equal((await first.read(path))?.revision, current.revision);
    await first.write(path, 'C', current.revision);
    assert.equal(await fs.readFile(root + '/' + path, 'utf8'), 'C');
  }));
}

test('native writer waits for captured reads and guards can read and list without reentry', { timeout: 5000 }, async () => fixture(async (root, state, files, registry) => {
  const captured = deferred(), release = deferred();
  let block = false;
  const delayed: WorkspaceFiles = { ...files, readFile: async (file, options) => {
    const data = await files.readFile(file, options);
    if (block && file === root + '/' + path) { block = false; captured.resolve(); await release.promise; }
    return data;
  } };
  const repo = new FileRepository(delayed, root, state, undefined, registry);
  const writer = new FileRepository({ ...delayed }, root, state, undefined, registry);
  const original = (await repo.read(path))!;
  block = true;
  const old = repo.read(path);
  await captured.promise;
  let guarded = false;
  const save = writer.write(path, 'B', original.revision, async repository => {
    assert.equal((await repository.read(path))?.text, 'A');
    assert.equal((await repository.list())[0].text, 'A');
    guarded = true;
  });
  try {
    await turn();
    assert.equal(guarded, false);
    assert.equal(await fs.readFile(root + '/' + path, 'utf8'), 'A');
  } finally { release.resolve(); }
  await old;
  const result = await save;
  assert.ok(guarded);
  assert.equal((await repo.read(path))?.revision, result.revision);
}));

test('native mutation holds snapshot paths through publication and releases them after successful rollback of a history failure', { timeout: 5000 }, async () => fixture(async (root, state, files, registry) => {
  for (const fail of [false, true]) {
    const publishing = deferred(), release = deferred();
    let documentReads = 0;
    const delayed: WorkspaceFiles = { ...files,
      readFile: async (file, options) => {
        if (file === root + '/' + path) documentReads++;
        return files.readFile(file, options);
      },
      rename: async (from, to) => {
        if (to.startsWith(state + '/history-')) {
          publishing.resolve(); await release.promise;
          if (fail) throw new Error('history failure');
        }
        return files.rename(from, to);
      },
    };
    const writer = new FileRepository(delayed, root, state, undefined, registry);
    const reader = new FileRepository({ ...delayed, readCheckedFile: async file => {
      if (file === root + '/' + path) documentReads++;
      return fs.readFile(file);
    } }, root, state, undefined, registry);
    const previous = (await reader.read(path))!;
    const save = writer.write(path, fail ? 'failed' : 'B', previous.revision);
    const outcome = save.then(value => ({ value, error: null }), error => ({ value: null, error }));
    await publishing.promise;
    const before = documentReads;
    const read = reader.read(path);
    try {
      await turn();
      assert.equal(documentReads, before, 'no filesystem snapshot between mutation and publication/rollback');
    } finally { release.resolve(); }
    const result = await outcome;
    const snapshot = (await read)!;
    if (fail) {
      assert.match(String(result.error), /history failure/);
      assert.equal(snapshot.text, previous.text);
      assert.equal(snapshot.revision, previous.revision);
    } else {
      assert.equal(result.error, null);
      assert.equal(snapshot.text, 'B');
      assert.equal(snapshot.revision, result.value!.revision);
    }
    assert.equal((await reader.read(path))?.revision, snapshot.revision);
  }
}));

test('native mutation rechecks baselines after a guard and waiting snapshot, preserving external edits', { timeout: 5000 }, async () => fixture(async (root, state, files, registry) => {
  const captured = deferred(), release = deferred();
  let block = false;
  const delayed: WorkspaceFiles = { ...files, readFile: async (file, options) => {
    const data = await files.readFile(file, options);
    if (block && file === root + '/' + path) { block = false; captured.resolve(); await release.promise; }
    return data;
  } };
  const repo = new FileRepository(delayed, root, state, undefined, registry);
  const reader = new FileRepository({ ...delayed }, root, state, undefined, registry);
  const original = (await repo.read(path))!;
  let pending!: ReturnType<FileRepository['read']>;
  const save = repo.write(path, 'must not overwrite', original.revision, async () => {
    block = true; pending = reader.read(path); await captured.promise;
  });
  const rejected = assert.rejects(save, /文件已更新/);
  await captured.promise;
  try { await fs.writeFile(root + '/' + path, 'external'); }
  finally { release.resolve(); }
  await pending;
  await rejected;
  assert.equal(await fs.readFile(root + '/' + path, 'utf8'), 'external');
  assert.deepEqual(await fs.readdir(state), [], 'conflicts must precede journal publication');
}));

test('native failed reads release the shared snapshot queue', { timeout: 5000 }, async () => fixture(async (root, state, files, registry) => {
  const captured = deferred(), release = deferred();
  let fail = true;
  const delayed: WorkspaceFiles = { ...files, readFile: async (file, options) => {
    if (file === root + '/' + path && fail) {
      fail = false; captured.resolve(); await release.promise; throw new Error('read failure');
    }
    return files.readFile(file, options);
  } };
  const first = new FileRepository(delayed, root, state, undefined, registry);
  const second = new FileRepository({ ...delayed }, root, state, undefined, registry);
  const failed = assert.rejects(first.read(path), /read failure/);
  await captured.promise;
  const next = second.read(path);
  release.resolve();
  await failed;
  assert.equal((await next)?.text, 'A');
}));

test('native independent recovery shares snapshot locks and preflights every path before rollback', { timeout: 5000 }, async () => fixture(async (root, state, files, registry) => {
  await fs.writeFile(root + '/' + path, 'B');
  const entry = { path, previous: 'A', next: 'B' };
  await fs.writeFile(state + '/transaction.json', JSON.stringify([entry]));
  const captured = deferred(), release = deferred(), journalRead = deferred();
  let block = true, documentReads = 0;
  const delayed: WorkspaceFiles = { ...files,
    readFile: async (file, options) => {
      const data = await files.readFile(file, options);
      if (file === state + '/transaction.json') journalRead.resolve();
      return data;
    },
    readCheckedFile: async file => {
      if (file === root + '/' + path) documentReads++;
      const data = await fs.readFile(file);
      if (block && file === root + '/' + path) { block = false; captured.resolve(); await release.promise; }
      return data;
    },
  };
  const repo = new FileRepository(delayed, root, state, undefined, registry);
  const other = new FileRepository({ ...delayed }, root, state, undefined, registry);
  const old = repo.read(path);
  await captured.promise;
  const recovery = other.recover();
  try {
    await journalRead.promise;
    await turn();
    assert.equal(documentReads, 1, 'recovery preflight must wait for the older snapshot');
    assert.equal(await fs.readFile(root + '/' + path, 'utf8'), 'B');
  } finally { release.resolve(); }
  await old;
  await recovery;
  assert.equal((await repo.read(path))?.text, 'A');
  await fs.writeFile(root + '/' + path, 'B');
  await fs.writeFile(state + '/transaction.json', JSON.stringify([entry, { path: 'config.toml', previous: 'before', next: 'after' }]));
  await assert.rejects(other.recover(), /新的本地修改/);
  assert.equal(await fs.readFile(root + '/' + path, 'utf8'), 'B', 'later conflicts must prevent earlier rollback writes');
  assert.equal((await repo.read('config.toml'))?.text, 'other', 'failed recovery releases all paths');
}));
