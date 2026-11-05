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
test('native listing bounds in-flight reads, preserves walk order and filters vanished files', async () => fixture(async (_repo, root, state) => {
  await fs.mkdir(root + '/content/articles', { recursive: true });
  const paths = Array.from({ length: 25 }, (_, i) => `content/articles/story-${String(i).padStart(2, '0')}.md`);
  for (const file of paths) await fs.writeFile(root + '/' + file, file);
  let active = 0, peak = 0;
  const repository = new FileRepository(nativeFiles, root, state);
  const read = repository.read.bind(repository);
  repository.read = async file => {
    active++; peak = Math.max(peak, active);
    try {
      // Complete out of order while exercising the real safety/revision path.
      await new Promise(resolve => setTimeout(resolve, file.endsWith('00.md') ? 10 : 0));
      if (file === paths[3]) await fs.unlink(root + '/' + file);
      return await read(file);
    } finally { active--; }
  };
  const listed = await repository.list();
  assert.ok(peak > 1 && peak <= 8, `peak reads: ${peak}`);
  assert.equal(active, 0);
  assert.deepEqual(listed.map(file => file.path), paths.filter(file => file !== paths[3]));
  assert.equal(listed[0].revision, (await read(paths[0]))!.revision);
}));

test('native listing drains failed batches and retains size, UTF-8 and symlink checks', async () => fixture(async (_repo, root, state) => {
  await fs.mkdir(root + '/content/articles', { recursive: true });
  const paths = Array.from({ length: 17 }, (_, i) => `content/articles/story-${String(i).padStart(2, '0')}.md`);
  for (const file of paths) await fs.writeFile(root + '/' + file, 'valid');
  for (const fault of ['size', 'utf8', 'symlink']) {
    let active = 0, started = 0;
    const repository = new FileRepository(nativeFiles, root, state);
    const read = repository.read.bind(repository);
    repository.read = async file => {
      active++; started++;
      try {
        if (file === paths[0]) {
          if (fault === 'size') await fs.writeFile(root + '/' + file, 'x'.repeat(1024 * 1024 + 1));
          else if (fault === 'utf8') await fs.writeFile(root + '/' + file, new Uint8Array([0xff]));
          else { await fs.unlink(root + '/' + file); await fs.symlink(root + '/' + paths[1], root + '/' + file); }
        }
        return await read(file);
      } finally { active--; }
    };
    await assert.rejects(repository.list(), fault === 'size' ? /限制/ : fault === 'symlink' ? /符号链接/ : /encoded data|encoding/i);
    assert.equal(active, 0, 'failed listings must drain outstanding reads');
    assert.equal(started, 8, 'do not schedule later batches after failure');
    await fs.unlink(root + '/' + paths[0]);
    await fs.writeFile(root + '/' + paths[0], 'valid');
  }
}));

test('summary listing skips hashes but preserves fallback reads, order and full document revisions', async context => fixture(async (repo, root) => {
  await fs.mkdir(root + '/content/articles', { recursive: true });
  await fs.writeFile(root + '/content/articles/z.md', 'last');
  await fs.writeFile(root + '/content/articles/a.md', 'first');
  const digest = context.mock.method(crypto.subtle, 'digest');
  assert.deepEqual(await repo.listForSummary(), [
    { path: 'content/articles/a.md', text: 'first' }, { path: 'content/articles/z.md', text: 'last' },
  ]);
  assert.equal(digest.mock.callCount(), 0, 'summary-only reads do not hash file bodies');
  const full = await repo.list();
  assert.equal(digest.mock.callCount(), 2);
  assert.equal(full[0].revision, (await repo.read(full[0].path))!.revision);
  assert.equal(digest.mock.callCount(), 3);
}));

test('summary listing drains bounded fallback reads and preserves size, UTF-8 and fresh symlink checks', async () => fixture(async (_repo, root, state) => {
  await fs.mkdir(root + '/content/articles', { recursive: true });
  const paths = Array.from({ length: 17 }, (_, i) => `content/articles/story-${String(i).padStart(2, '0')}.md`);
  for (const file of paths) await fs.writeFile(root + '/' + file, 'valid');
  let active = 0, peak = 0, started = 0;
  const files: WorkspaceFiles = { ...nativeFiles, readFile: async (file, options) => {
    active++; started++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 1)); return await nativeFiles.readFile(file, options); }
    finally { active--; }
  } };
  const repository = new FileRepository(files, root, state);
  assert.deepEqual((await repository.listForSummary()).map(file => file.path), paths);
  assert.ok(peak > 1 && peak <= 8); assert.equal(active, 0);
  await fs.writeFile(root + '/' + paths[0], new Uint8Array([0xff])); started = 0;
  await assert.rejects(repository.listForSummary(), /encoded data|encoding/i);
  assert.equal(active, 0); assert.equal(started, 8, 'later batches must not start after invalid UTF-8');
  await fs.writeFile(root + '/' + paths[0], 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(repository.listForSummary(), /限制/); assert.equal(active, 0);
  await fs.unlink(root + '/' + paths[0]); await fs.writeFile(root + '/' + paths[0], 'valid');
  // Replace a parent after discovery and before any read, without a timing-dependent race.
  await fs.mkdir(root + '/content/topics');
  const fresh: WorkspaceFiles = { ...files, readdir: async directory => {
    const names = await nativeFiles.readdir(directory);
    if (directory === root + '/content/topics') {
      await fs.rename(root + '/content/articles', root + '/content/original');
      await fs.symlink(root + '/content/original', root + '/content/articles');
    }
    return names;
  } };
  await assert.rejects(new FileRepository(fresh, root, state).listForSummary(), /符号链接/);
  assert.equal(active, 0);
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
