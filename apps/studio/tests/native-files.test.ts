import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRepository } from '../platform/file-repository';
import type { WorkspaceFiles } from '../platform/filesystem';
import { hostingProviders, validateBranch, validateProfile, validateRemote } from '../platform/hosting';
import { createGitHttp } from '../platform/git-http';
const nativeFiles = fs as unknown as WorkspaceFiles;
const path = 'content/articles/hello/index.md';
async function fixture(run: (repo: FileRepository, root: string, state: string) => Promise<void>) {
  const base = await fs.mkdtemp(join(tmpdir(), 'studio-native-files-'));
  const root = base + '/repo', state = base + '/state';
  await fs.mkdir(root);
  try { await run(new FileRepository(nativeFiles, root, state), root, state); }
  finally { await fs.rm(base, { recursive: true, force: true }); }
}
test('native files preserve offline saves, revisions and backups across reopen', async () => fixture(async (repo, root, state) => {
  const first = await repo.write(path, 'hello', null);
  const second = new FileRepository(nativeFiles, root, state);
  assert.equal((await second.read(path))?.revision, first.revision);
  await assert.rejects(second.write(path, 'stale', null), /文件已更新/);
  const results = await Promise.allSettled([repo.write(path, 'one', first.revision), second.write(path, 'two', first.revision)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await repo.list()).length, 1);
  assert.equal((await fs.readdir(state)).filter(name => name.startsWith('history-')).length, 2);
  assert.equal((await fs.readdir(root)).includes('.studio-history'), false);
}));
test('native batch rolls back all writes after a disk failure and recovers interrupted writes on reopen', async () => fixture(async (repo, root, state) => {
  const first = await repo.write(path, 'original', null);
  let fail = true;
  const faultFiles: WorkspaceFiles = { ...nativeFiles, writeFile: async (file, data, options) => {
    if (file.endsWith('data.toml') && fail) { fail = false; throw new Error('disk full'); }
    await nativeFiles.writeFile(file, data, options);
  } };
  const failing = new FileRepository(faultFiles, root, state);
  await assert.rejects(failing.writeBatch([{ path, text: 'changed', expectedRevision: first.revision }, { path: 'data.toml', text: 'title="test"', expectedRevision: null }]), /disk full/);
  assert.equal((await repo.read(path))?.text, 'original'); assert.equal(await repo.read('data.toml'), null);
  await fs.writeFile(state + '/transaction.json', JSON.stringify([{ path, previous: 'original', next: 'interrupted' }]));
  await fs.writeFile(root + '/' + path, 'interrupted');
  await new FileRepository(nativeFiles, root, state).recover();
  assert.equal((await repo.read(path))?.text, 'original');
  await fs.writeFile(state + '/transaction.json', JSON.stringify([{ path, previous: 'original', next: 'interrupted' }]));
  await fs.writeFile(root + '/' + path, 'external edit after crash');
  await assert.rejects(repo.recover(), /新的本地修改/);
  assert.equal((await repo.read(path))?.text, 'external edit after crash');
}));
test('native files reject traversal, symlinks, unsafe uploads and interrupted Git mutation', async () => fixture(async (repo, root, state) => {
  await assert.rejects(repo.read('../secret'));
  await fs.mkdir(root + '/content'); await fs.symlink(state, root + '/content/articles');
  await assert.rejects(repo.write(path, 'unsafe', null), /符号链接/);
  await assert.rejects(repo.uploadMedia('public/uploads', 'x.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')));
  const blocked = new FileRepository(nativeFiles, root, state, async () => { throw new Error('sync interrupted'); });
  await assert.rejects(blocked.write('config.toml', 'title="test"', null), /sync interrupted/);
}));
test('all hosting providers support explicit Git remotes without pretending API discovery exists', () => {
  assert.equal(hostingProviders.length, 7);
  for (const provider of hostingProviders) { assert.equal(provider.validateRemote('https://git.example/team/site.git').host, 'git.example'); assert.equal(provider.capabilities.discovery, false); }
  for (const invalid of ['http://git.example/a', 'https://token@git.example/a', 'https://git.example/a?token=secret', 'https://git.example/']) assert.throws(() => validateRemote(invalid));
  for (const invalid of ['a..b','a.lock','/main','main/','a@{b','-main']) assert.throws(() => validateBranch(invalid));
  assert.equal(validateBranch('feature/studio'), 'feature/studio');
  assert.throws(() => validateProfile({ id:'../../', label:'x', url:'https://a/b', branch:'main', provider:'generic', username:'u', authorName:'n', authorEmail:'a@b' }));
});
test('Git HTTP refuses cross-origin requests and disables redirects before forwarding auth', async () => {
  let calls = 0;
  const http = createGitHttp('https://git.example/owner/repo', async (url, init) => { calls++; assert.equal(init?.redirect, 'error'); return new Response('ok'); });
  await assert.rejects(http.request({ url: 'https://evil.example/repo', method: 'GET', headers: { authorization: 'secret' } }));
  assert.equal(calls, 0);
  const result = await http.request({ url: 'https://git.example/owner/repo/info/refs', method:'GET' });
  assert.equal(result.statusCode, 200); assert.equal(calls, 1);
});

test('Git HTTP exposes chunks before the download ends and releases an abandoned stream', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  const http = createGitHttp('https://git.example/owner/repo', async () => new Response(stream));
  const response = await http.request({ url: 'https://git.example/owner/repo/git-upload-pack', method: 'POST' });
  const iterator = response.body![Symbol.asyncIterator]();
  controller.enqueue(new Uint8Array([1, 2, 3]));
  assert.deepEqual((await iterator.next()).value, new Uint8Array([1, 2, 3]));
  controller.enqueue(new Uint8Array([4, 5]));
  assert.deepEqual((await iterator.next()).value, new Uint8Array([4, 5]));
  await iterator.return?.();
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test('Git HTTP releases authentication and error responses even when Git never reads their bodies', async () => {
  for (const status of [203, 401, 403, 404, 503, 302]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
    const http = createGitHttp('https://git.example/owner/repo', async () => response);
    if (status === 302) await assert.rejects(http.request({url:'https://git.example/owner/repo/info/refs'}), /重定向/);
    else assert.equal((await http.request({url:'https://git.example/owner/repo/info/refs'})).statusCode, status);
    assert.equal(cancelled, true, `status ${status} must release its body`);
    assert.equal(response.body!.locked, false);
  }
});
