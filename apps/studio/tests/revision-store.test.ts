import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, chmod, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DiskRevisionStore } from '../server/revision-store.js';
import { LocalRepository } from '../server/repository.js';
import { inspectConfig } from '../server/config.js';

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'studio-disk-revisions-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), directory = join(base, 'private', 'revisions');
  await mkdir(root); await writeFile(join(root, 'config.toml'), 'aaaa');
  return { base, root, directory };
}
interface WorkerResult { result?: { revision: string; text?: string }; error?: { status: number } }
function worker(root: string, directory: string, action: string, revision = ''): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    // Each child has independent module state and a fresh registry epoch.
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/revision-worker.ts', import.meta.url)), root, directory, action, revision], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => { if (code) reject(new Error(errors)); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
  });
}

test('independent processes share stable baselines and serialize competing saves', async t => {
  const { root, directory } = await fixture(t);
  const reads = await Promise.all(Array.from({ length: 4 }, () => worker(root, directory, 'read')));
  const revision = reads[0].result!.revision;
  assert.ok(reads.every(read => read.result?.revision === revision));
  const writes = await Promise.all([worker(root, directory, 'bbbb', revision), worker(root, directory, 'cccc', revision)]);
  assert.equal(writes.filter(write => write.result).length, 1);
  assert.equal(writes.filter(write => write.error?.status === 409).length, 1);
  const saved = writes.find(write => write.result)!.result!;
  assert.equal((await worker(root, directory, 'read')).result!.revision, saved.revision, 'restart preserves the published baseline');
  assert.equal((await worker(root, directory, 'old-sha', 'a'.repeat(64))).error?.status, 409);
  const before = await stat(join(root, 'config.toml'));
  await writeFile(join(root, 'config.toml'), 'dddd'); await utimes(join(root, 'config.toml'), before.atime, before.mtime);
  assert.equal((await worker(root, directory, 'stale', saved.revision)).error?.status, 409);
  assert.equal(await readFile(join(root, 'config.toml'), 'utf8'), 'dddd');
});

test('canonical aliases share disk tokens, while roots and paths are isolated', async t => {
  const { base, root, directory } = await fixture(t);
  const alias = join(base, 'alias'), other = join(base, 'other');
  await symlink(root, alias); await mkdir(other);
  const a = new DiskRevisionStore(root, { directory }), b = new DiskRevisionStore(alias, { directory }), c = new DiskRevisionStore(other, { directory });
  const token = await a.revision('config.toml', 'same');
  assert.equal(await b.revision('config.toml', 'same'), token);
  assert.notEqual(await c.revision('config.toml', 'same'), token);
  assert.notEqual(await a.revision('data.toml', 'same'), token);
});

test('disk entry/byte/TTL eviction never rebinds old editor tokens', async t => {
  const { root, directory } = await fixture(t);
  let now = 1000;
  const store = new DiskRevisionStore(root, { directory, maxEntries: 2, maxBytes: 1200, ttlMs: 100, now: () => now });
  const token = await store.revision('config.toml', 'aaaa');
  await store.revision('data.toml', 'x'.repeat(300)); await store.revision('content/articles/a.md', 'x'.repeat(300));
  const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
  assert.ok(index.entries.reduce((sum: number, entry: { bytes: number }) => sum + entry.bytes, 0) <= 1200);
  assert.ok(index.entries.length <= 2);
  assert.notEqual(await store.revision('config.toml', 'aaaa'), token);
  const current = await store.revision('config.toml', 'aaaa'); now += 100;
  assert.notEqual(await store.revision('config.toml', 'aaaa'), current);
  await assert.rejects(store.revision('config.toml', 'x'.repeat(1200)), { status: 503 });
  await assert.rejects(store.revision('config.toml', 'x'.repeat(1024 * 1024 + 1)), { status: 413 });
});

test('disk state is private, outside worktree, rejects symlinks and corrupt state without overwriting content', async t => {
  const { root, directory, base } = await fixture(t);
  assert.throws(() => new DiskRevisionStore(root, { directory: join(root, 'public/state') }), /之外/);
  const store = new DiskRevisionStore(root, { directory });
  const first = await store.revision('config.toml', 'aaaa');
  const slot = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')).entries[0].slot;
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, slot))).mode & 0o777, 0o600);
  }
  await writeFile(join(directory, slot), '{broken');
  const repo = new LocalRepository(root, store);
  await assert.rejects(repo.write('config.toml', 'unsafe', first), { status: 503 });
  assert.equal(await readFile(join(root, 'config.toml'), 'utf8'), 'aaaa');
  await rm(join(directory, slot));
  const outside = join(base, 'outside'); await writeFile(outside, 'secret', { mode: 0o600 });
  await symlink(outside, join(directory, slot));
  await assert.rejects(store.revision('config.toml', 'aaaa'), { status: 503 });
  assert.equal(await readFile(outside, 'utf8'), 'secret');
  await rm(join(directory, slot));
  if (process.platform !== 'win32') {
    await chmod(directory, 0o755);
    await assert.rejects(store.revision('config.toml', 'aaaa'), { status: 503 });
    await chmod(directory, 0o700);
  }
  const linked = join(base, 'linked'); await symlink(join(base, 'private'), linked);
  await assert.rejects(new DiskRevisionStore(root, { directory: join(linked, 'state') }).revision('config.toml', 'aaaa'), { status: 503 });
});

test('interrupted publication cannot replace committed state and lost state never revives tokens', async t => {
  const { root, directory } = await fixture(t);
  const store = new DiskRevisionStore(root, { directory });
  const token = await store.revision('config.toml', 'aaaa');
  const slot = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')).entries[0].slot;
  await writeFile(join(directory, 'pending'), '{"version":2}', { mode: 0o600 });
  await assert.rejects(new DiskRevisionStore(root, { directory }).revision('config.toml', 'aaaa'), { status: 503 });
  // Simulate an operator inspecting an interrupted transaction before restoring.
  await rm(join(directory, 'pending'));
  assert.equal(await store.revision('config.toml', 'aaaa'), token);
  await rm(join(directory, slot));
  const repo = new LocalRepository(root, new DiskRevisionStore(root, { directory }));
  await assert.rejects(repo.write('config.toml', 'lost baseline', token), { status: 409 });
  await symlink(root, join(directory, 'lock'));
  await assert.rejects(store.revision('config.toml', 'aaaa'), { status: 503 });
  assert.equal(await readFile(join(root, 'config.toml'), 'utf8'), 'aaaa');
});

test('unchanged reads open only their slot and compact index, without body writes, fsync or TTL extension', async t => {
  const { root, directory } = await fixture(t);
  let now = 1000;
  const events: { operation: string; name: string; bytes: number }[] = [];
  const store = new DiskRevisionStore(root, { directory, ttlMs: 100, now: () => now, onIO: event => events.push(event) });
  const token = await store.revision('config.toml', 'aaaa');
  for (let i = 0; i < 12; i++) await store.revision(`content/articles/${i}.md`, 'x'.repeat(100_000));
  const indexBefore = await stat(join(directory, 'index.json'));
  events.length = 0;
  now = 1099;
  for (let i = 0; i < 5; i++) assert.equal(await store.revision('config.toml', 'aaaa'), token);
  assert.equal(events.length, 10);
  assert.equal(events.filter(event => event.name === 'index.json').length, 5);
  assert.equal(new Set(events.filter(event => event.name !== 'index.json').map(event => event.name)).size, 1);
  assert.ok(events.every(event => event.operation === 'read' && event.bytes < 4096));
  assert.equal((await stat(join(directory, 'index.json'))).mtimeMs, indexBefore.mtimeMs);
  now = 1100;
  assert.notEqual(await store.revision('config.toml', 'aaaa'), token, 'reads do not extend fixed TTL');
});

test('retired tokens are not resurrected by delayed reads with older text', async t => {
  const { root, directory } = await fixture(t);
  const a = new DiskRevisionStore(root, { directory }), b = new DiskRevisionStore(root, { directory });
  const old = await a.revision('config.toml', 'aaaa');
  const current = await b.revision('config.toml', 'bbbb');
  assert.notEqual(await a.revision('config.toml', 'aaaa'), old);
  assert.notEqual(await b.revision('config.toml', 'bbbb'), current);
  const repo = new LocalRepository(root, b);
  await assert.rejects(repo.write('config.toml', 'stale', old), { status: 409 });
  assert.equal(await readFile(join(root, 'config.toml'), 'utf8'), 'aaaa');
});

test('corrupt or missing manifest membership blocks saves before any content mutation', async t => {
  const { root, directory } = await fixture(t);
  const store = new DiskRevisionStore(root, { directory }), repo = new LocalRepository(root, store);
  const first = (await repo.read('config.toml'))!;
  for (const manifest of ['{broken', '{"version":2,"entries":[]}']) {
    await writeFile(join(directory, 'index.json'), manifest);
    await assert.rejects(repo.write('config.toml', 'bbbb', first.revision), { status: 503 });
    assert.equal(await readFile(join(root, 'config.toml'), 'utf8'), 'aaaa');
  }
});

test('revision publication failure after content rename rolls back the content transaction', async t => {
  const { root, directory } = await fixture(t);
  const store = new DiskRevisionStore(root, { directory });
  let observedApplied = false;
  const repo = new LocalRepository(root, { revision: async (path, text) => {
    if (text === 'bbbb') {
      assert.equal(await readFile(join(root, path), 'utf8'), 'bbbb');
      observedApplied = true; throw new Error('injected revision publication failure');
    }
    return store.revision(path, text);
  } });
  const first = (await repo.read('config.toml'))!;
  await assert.rejects(repo.write('config.toml', 'bbbb', first.revision), /publication failure/);
  assert.ok(observedApplied);
  assert.equal(await readFile(join(root, 'config.toml'), 'utf8'), 'aaaa');
  assert.equal((await repo.read('config.toml'))!.revision, first.revision);
});

test('real disk publication fault after durable pending rolls back exact bytes and leaves reads failclosed', async t => {
  const { root, directory } = await fixture(t);
  const original = Buffer.from('\ufefftitle="原文"\r\n', 'utf8');
  await writeFile(join(root, 'config.toml'), original);
  let armed = false, injected = false, pendingSynced = false, directorySynced = false;
  const store = new DiskRevisionStore(root, { directory, onIO: event => {
    if (!armed) return;
    if (event.operation === 'sync' && event.name === 'pending') pendingSynced = true;
    if (event.operation === 'sync' && event.name === '.' && pendingSynced) directorySynced = true;
    if (event.operation === 'write' && event.name === 'slot.tmp') {
      assert.ok(pendingSynced);
      if (process.platform !== 'win32') assert.ok(directorySynced);
      assert.equal(readFileSync(join(root, 'config.toml'), 'utf8'), 'title="changed"\n');
      assert.deepEqual(JSON.parse(readFileSync(join(directory, 'pending'), 'utf8')), { version: 2 });
      injected = true;
      throw new Error('injected real slot publication failure');
    }
  } });
  const repo = new LocalRepository(root, store);
  const first = (await repo.read('config.toml'))!;
  armed = true;
  await assert.rejects(repo.write('config.toml', 'title="changed"\n', first.revision), /injected real slot publication failure/);
  assert.ok(injected, 'fault must occur inside the real store after content rename and durable pending');
  assert.deepEqual(await readFile(join(root, 'config.toml')), original);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'pending'), 'utf8')), { version: 2 });
  await assert.rejects(repo.read('config.toml'), { status: 503 });
  await assert.rejects(new LocalRepository(root, new DiskRevisionStore(root, { directory })).read('config.toml'), { status: 503 });
});

test('failed rollback reports uncertain results without inventing a revision', async t => {
  const { root, directory } = await fixture(t);
  const store = new DiskRevisionStore(root, { directory });
  const repo = new LocalRepository(root, { revision: async (path, text) => {
    if (text === 'bbbb') {
      await rm(join(root, path)); await mkdir(join(root, path));
      throw new Error('publication failed after disk mutation');
    }
    return store.revision(path, text);
  } });
  const first = (await repo.read('config.toml'))!;
  await assert.rejects(repo.write('config.toml', 'bbbb', first.revision), error => {
    assert.match(String(error), /结果不确定/); assert.doesNotMatch(String(error), /未覆盖文件/); return true;
  });
});

test('configuration injects an explicit private store and rejects publishing it inside the checkout', async t => {
  const { root, directory } = await fixture(t);
  const env = { STUDIO_ORIGIN: 'http://localhost:5173', STUDIO_SESSION_SECRET: 's'.repeat(32), STUDIO_ADMIN_USER: 'test', STUDIO_ADMIN_PASSWORD_HASH: `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`, STUDIO_SITE_ROOT: root, STUDIO_STATE_DIR: directory };
  const a = inspectConfig(env), b = inspectConfig(env);
  const read = (await a.repository.read('config.toml'))!;
  assert.equal((await b.repository.read('config.toml'))!.revision, read.revision);
  assert.ok((await stat(join(directory, 'content-revisions-v1/index.json'))).isFile());
  assert.throws(() => inspectConfig({ ...env, STUDIO_STATE_DIR: join(root, '.state') }), /之外/);
});
