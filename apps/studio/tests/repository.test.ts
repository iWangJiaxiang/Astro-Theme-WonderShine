import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat, utimes } from 'node:fs/promises';
import { RevisionRegistry } from '../core/revision.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepository } from '../server/repository.js';

test('local repository persists content and rejects stale versions across instances', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  const a = new LocalRepository(root), b = new LocalRepository(root);
  await a.write('content/articles/hello/index.md', 'one', null);
  const snapshot = await b.read('content/articles/hello/index.md');
  assert.equal(snapshot?.text, 'one');
  await a.write(snapshot!.path, 'two', snapshot!.revision);
  await assert.rejects(b.write(snapshot!.path, 'stale', snapshot!.revision), /已更新/);
  assert.equal((await a.read(snapshot!.path))?.text, 'two');
});
test('rejects path traversal, secrets and symlink escapes for both read and write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-path-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  await mkdir(join(root, 'content/articles'), { recursive: true });
  await symlink(tmpdir(), join(root, 'content/articles/out'));
  const repo = new LocalRepository(root);
  for (const path of ['../config.toml', '.env', 'content/articles/../../config.toml', 'content/articles/out/secret.md', 'content/articles/.hidden.md', 'content/articles/a\\b.md']) {
    await assert.rejects(repo.read(path), /路径|链接/);
    await assert.rejects(repo.write(path, 'x', null), /路径|链接/);
  }
});
test('only one concurrent save from the same base succeeds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-race-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  await writeFile(join(root, 'config.toml'), 'title="old"');
  const a = new LocalRepository(root), b = new LocalRepository(root);
  const snapshot = (await a.read('config.toml'))!;
  const results = await Promise.allSettled([a.write('config.toml', 'title="a"', snapshot.revision), b.write('config.toml', 'title="b"', snapshot.revision)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(await readFile(join(root, 'config.toml'), 'utf8'), /title="[ab]"/);
});
test('history backup cannot follow a symlink outside the repository', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-history-'));
  const outside = await mkdtemp(join(tmpdir(), 'studio-outside-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await writeFile(join(root, 'config.toml'), 'title="old"');
  await symlink(outside, join(root, '.studio-history'));
  const repo = new LocalRepository(root), before = (await repo.read('config.toml'))!;
  await assert.rejects(() => repo.write('config.toml', 'title="new"', before.revision), /链接/);
  assert.equal((await repo.read('config.toml'))!.text, before.text);
});
test('a batch restores earlier file contents when applying a later file fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-batch-rollback-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  const repo = new LocalRepository(root);
  const first = 'content/articles/first.md', second = 'content/articles/second.md';
  await repo.write(first, 'Original content', null);
  const revision = (await repo.read(first))!.revision;
  await assert.rejects(repo.writeBatch([
    { path: first, text: 'Changed content', expectedRevision: revision },
    { path: second, text: 'New content', expectedRevision: null },
  ], async () => { await mkdir(join(root, second)); }));
  assert.equal((await repo.read(first))?.text, 'Original content');
  assert.equal((await repo.read(first))?.revision, revision);
});

test('canonical roots share baselines, while paths and separate roots cannot reuse tokens', async t => {
  const base = await mkdtemp(join(tmpdir(), 'studio-revision-scope-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), other = join(base, 'other'), alias = join(base, 'alias');
  await mkdir(root); await mkdir(other); await symlink(root, alias);
  for (const directory of [root, other]) {
    await writeFile(join(directory, 'config.toml'), 'same');
    await writeFile(join(directory, 'data.toml'), 'same');
  }
  const a = new LocalRepository(root), b = new LocalRepository(alias), c = new LocalRepository(other);
  const snapshot = (await a.read('config.toml'))!;
  assert.equal((await b.read(snapshot.path))!.revision, snapshot.revision);
  await assert.rejects(c.write(snapshot.path, 'wrong scope', snapshot.revision), /已更新/);
  await assert.rejects(a.write('data.toml', 'wrong path', snapshot.revision), /已更新/);
  const saved = await b.write(snapshot.path, 'saved', snapshot.revision);
  assert.equal((await a.read(snapshot.path))!.revision, saved.revision);
});

test('fresh locked reads detect same-size, same-mtime external edits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-revision-mtime-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  const file = join(root, 'config.toml'); await writeFile(file, 'aaaa');
  const repo = new LocalRepository(root), first = (await repo.read('config.toml'))!, info = await stat(file);
  await writeFile(file, 'bbbb'); await utimes(file, info.atime, info.mtime);
  await assert.rejects(repo.write(first.path, 'cccc', first.revision), /已更新/);
  assert.equal(await readFile(file, 'utf8'), 'bbbb');
});

test('restart and eviction fail closed, and summary reads do not evict editor baselines', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-revision-eviction-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  await mkdir(join(root, 'content/articles'), { recursive: true });
  for (const name of ['a', 'b', 'c']) await writeFile(join(root, `content/articles/${name}.md`), name);
  const registry = new RevisionRegistry({ maxEntries: 1 });
  const repo = new LocalRepository(root, undefined, registry);
  const first = (await repo.read('content/articles/a.md'))!;
  assert.equal((await repo.listForSummary()).length, 3);
  assert.equal(registry.size, 1);
  assert.equal((await repo.read(first.path))!.revision, first.revision);
  const restarted = new LocalRepository(root, undefined, new RevisionRegistry());
  await assert.rejects(restarted.write(first.path, 'lost baseline', first.revision), /已更新/);
  await repo.read('content/articles/b.md');
  await assert.rejects(repo.write(first.path, 'evicted', first.revision), /已更新/);
  await assert.rejects(repo.write(first.path, 'unknown', 'unknown-token'), /已更新/);
  assert.equal(await readFile(join(root, first.path), 'utf8'), first.text);
});
