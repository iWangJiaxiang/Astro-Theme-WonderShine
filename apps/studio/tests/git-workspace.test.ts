import test from 'node:test';
import { StudioError } from '../core/errors.js';
import { createContentTransport } from '../core/transport.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitWorkspaceRepository } from '../server/git-workspace.js';
import { inspectConfig } from '../server/config.js';
import { LocalRepository } from '../server/repository.js';
import { createApp } from '../server/app.js';
import { FileState } from '../server/state.js';
import { hashPassword } from '../server/password.js';

test('persistent workspaces retain offline edits, recover on reopen and synchronize without overwriting conflicts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (args: string[], cwd = root) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  // The bare remote HEAD must match the seeded branch regardless of host defaults.
  run(['init', '--bare', '-b', 'main', 'repo.git']); run(['-C', 'repo.git', 'config', 'http.receivepack', 'true']);
  run(['init', '-b', 'main', 'seed']);
  await mkdir(join(root, 'seed/content/articles/first'), { recursive: true });
  await writeFile(join(root, 'seed/content/articles/first/index.md'), '+++\ntitle="First"\n+++\nHello\n');
  await writeFile(join(root, 'seed/config.toml'), 'title="Sample"\n');
  await mkdir(join(root, 'seed/public/img'), { recursive: true });
  const image = Buffer.from([0, 255, 128, 1, 254]);
  await writeFile(join(root, 'seed/public/img/git.png'), image);
  run(['add', '.'], join(root, 'seed')); run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'], join(root, 'seed'));
  // Match blog-new: a theme is pinned as a Git submodule, without recursively checking it out.
  const themeCommit = run(['rev-parse', 'HEAD'], join(root, 'seed'));
  await mkdir(join(root, 'seed/themes/wondershine'), { recursive: true });
  await writeFile(join(root, 'seed/.gitmodules'), '[submodule "themes/wondershine"]\n\tpath = themes/wondershine\n\turl = https://git.test/theme.git\n');
  run(['add', '.gitmodules'], join(root, 'seed'));
  run(['update-index', '--add', '--cacheinfo', `160000,${themeCommit},themes/wondershine`], join(root, 'seed'));
  run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'pin theme submodule'], join(root, 'seed'));
  run(['push', '../repo.git', 'main'], join(root, 'seed'));
  const executable = join(run(['--exec-path']), 'git-http-backend');
  let receivedAuth = false, cloneRequests = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization) receivedAuth = true;
    else { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm=Git' }).end(); return; }
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.endsWith('/git-upload-pack')) cloneRequests++;
    const child = spawn(executable, [], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'tester', REMOTE_ADDR: '127.0.0.1' } });
    const parts: Buffer[] = [];
    child.stdout.on('data', chunk => parts.push(chunk)); child.stderr.resume(); req.pipe(child.stdin);
    child.on('close', () => {
      const data = Buffer.concat(parts), end = data.indexOf('\r\n\r\n');
      if (end < 0) { res.writeHead(500).end(); return; }
      for (const line of data.subarray(0, end).toString().split('\r\n')) { const colon = line.indexOf(':'); const key = line.slice(0, colon), value = line.slice(colon + 1).trim(); if (key === 'Status') res.statusCode = Number(value.split(' ')[0]); else res.setHeader(key, value); }
      res.end(data.subarray(end + 4));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const originalFetch = globalThis.fetch;
  // Transport substitution is confined to this test process. Production remains HTTPS-only.
  let offline = false;
  globalThis.fetch = (input, init) => {
    if (offline) return Promise.reject(new Error('Offline')); 
    const url = new URL(String(input)); assert.equal(url.origin, 'https://git.test');
    return originalFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const directory = join(root, 'workspace');
  const options = { directory, url: 'https://git.test/repo.git', branch: 'main', username: 'tester', token: 'test-token', name: 'Studio', email: 'studio@example.com' };
  const workspace = new GitWorkspaceRepository(options);
  const articlePath = 'content/articles/first/index.md';
  const first = (await workspace.read(articlePath))!;
  assert.equal((await workspace.workspace.status()).dirty, false);
  assert.equal(cloneRequests, 1);
  offline = true;
  const originalRemote = run(['--git-dir=repo.git', 'rev-parse', 'main']);
  const saved = await workspace.write(articlePath, first.text.replace('Hello', 'Offline edit'), first.revision);
  assert.equal(saved.commit, undefined, 'saving does not create a commit or contact the network');
  const reopened = new GitWorkspaceRepository(options);
  assert.match((await reopened.read(articlePath))!.text, /Offline edit/);
  assert.equal((await reopened.workspace.status()).changes, 1, 'history backups are not content changes');
  await assert.rejects(workspace.write(articlePath, 'stale', first.revision), /已更新/);
  await assert.rejects(workspace.workspace.sync(), /先提交/);
  const ordinary = await reopened.workspace.status();
  assert.equal(ordinary.confirmation, undefined);
  assert.equal(ordinary.confirmationExpiresAt, undefined);
  await assert.rejects(stat(directory + '.studio-reviews-v1'), { code: 'ENOENT' }, 'status must not create review storage');
  const preview = await reopened.workspace.createReview();
  const manifest = await readFile(join(directory + '.studio-reviews-v1', 'manifest.json'));
  assert.deepEqual(await reopened.workspace.status(), ordinary);
  assert.deepEqual(await readFile(join(directory + '.studio-reviews-v1', 'manifest.json')), manifest, 'polling must not replace or renew a review');
  assert.deepEqual(preview.managedChanges, [articlePath]);
  assert.ok(preview.confirmation);
  await assert.rejects(reopened.workspace.commit('stale confirmation', 'stale'), /重新确认/);
  assert.equal((await reopened.workspace.status()).head, preview.head);
  const committed = await new GitWorkspaceRepository(options).workspace.commit('docs(content): offline edit', preview.confirmation);
  assert.equal(committed.confirmation, undefined);
  assert.equal(committed.confirmationExpiresAt, undefined);
  await assert.rejects(reopened.workspace.sync(preview.confirmation), /重新确认/);
  assert.equal(committed.ahead, 1);
  assert.equal(committed.dirty, false);
  await assert.rejects(reopened.workspace.sync(), /本地文件和提交已保留/);
  assert.equal((await reopened.workspace.status()).head, committed.head);
  assert.equal(run(['--git-dir=repo.git', 'rev-parse', 'main']), originalRemote);
  offline = false;
  const syncReview = await reopened.workspace.createReview();
  assert.ok(syncReview.confirmation);
  assert.notEqual(syncReview.confirmation, preview.confirmation);
  const synced = await reopened.workspace.sync(syncReview.confirmation);
  assert.equal(synced.confirmation, undefined);
  assert.equal(synced.ahead, 0);
  assert.equal(run(['--git-dir=repo.git', 'ls-tree', 'main', 'themes/wondershine']), `160000 commit ${themeCommit}\tthemes/wondershine`, 'content commits must preserve the pinned theme gitlink');
  assert.ok(synced.lastSync);
  assert.match(run(['--git-dir=repo.git', 'show', `main:${articlePath}`]), /Offline edit/);
  assert.equal(run(['--git-dir=repo.git', 'ls-tree', '-r', '--name-only', 'main']).includes('.studio-history'), false);
  assert.ok(receivedAuth);
  // Opening an already-initialized local submodule must not mark theme files as content changes.
  run(['clone', '--no-checkout', join(root, 'seed'), join(directory, 'themes/wondershine')]);
  run(['checkout', themeCommit], join(directory, 'themes/wondershine'));
  run(['submodule', 'absorbgitdirs'], directory);
  assert.equal((await reopened.workspace.status()).dirty, false, 'initialized theme submodule remains outside content changes');

  // A second device changes the remote. Fetch then checkout must retain the configured branch.
  run(['pull', '--ff-only', '../repo.git', 'main'], join(root, 'seed'));
  await writeFile(join(root, 'seed/config.toml'), 'title="Other device"\n');
  run(['add', 'config.toml'], join(root, 'seed'));
  run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'other device'], join(root, 'seed'));
  run(['push', '../repo.git', 'main'], join(root, 'seed'));
  const remoteUpdated = await reopened.workspace.sync();
  assert.equal(remoteUpdated.behind, 0);
  assert.equal(remoteUpdated.branch, 'main');
  assert.match((await reopened.read('config.toml'))!.text, /Other device/);
  assert.equal(run(['branch', '--show-current'], directory), 'main');

  // User-staged implementation files must never enter a content commit.
  await writeFile(join(directory, 'unrelated.ts'), 'export const value = 1;');
  run(['add', 'unrelated.ts'], directory);
  const second = (await reopened.read(articlePath))!;
  await reopened.write(articlePath, second.text + '\nMore writing', second.revision);
  await assert.rejects(reopened.workspace.commit('content only'), /暂存区/);
  assert.equal(run(['diff', '--cached', '--name-only'], directory), 'unrelated.ts');
  run(['reset', 'HEAD', '--', 'unrelated.ts'], directory);
  await rm(join(directory, 'unrelated.ts'));
  await reopened.workspace.commit('docs(content): more writing');

  // Rejected pushes preserve local commits and retries converge without duplicate commits.
  const hook = join(root, 'repo.git/hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o700);
  const beforeRejected = (await reopened.workspace.status()).head;
  await assert.rejects(reopened.workspace.sync(), /本地提交已保留/);
  assert.equal((await reopened.workspace.status()).head, beforeRejected);
  await rm(hook);
  await reopened.workspace.sync();
  assert.equal((await reopened.workspace.status()).ahead, 0);

  // Media uploads are local files first and join the next explicit content commit.
  offline = true;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwinr/HwAE+AKLJh4rzQAAAABJRU5ErkJggg==', 'base64');
  const upload = await reopened.uploadMedia('public/uploads', 'cover.png', png);
  assert.equal(upload.commit, undefined);
  assert.deepEqual(Buffer.from((await reopened.readMedia(upload.item.path))!.data), png);
  await reopened.workspace.commit('feat(media): cover');
  offline = false;
  await reopened.workspace.sync();
  assert.deepEqual(execFileSync('git', ['--git-dir=repo.git', 'show', `main:${upload.item.path}`], { cwd: root }), png);

  // Divergence stays unresolved until the owner explicitly merges with a Git tool.
  const third = (await reopened.read(articlePath))!;
  await reopened.write(articlePath, third.text + '\nLocal branch', third.revision);
  const localCommit = await reopened.workspace.commit('local divergence');
  run(['pull', '--ff-only', '../repo.git', 'main'], join(root, 'seed'));
  await writeFile(join(root, 'seed', articlePath), 'Remote branch');
  run(['add', articlePath], join(root, 'seed'));
  run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'remote divergence'], join(root, 'seed'));
  run(['push', '../repo.git', 'main'], join(root, 'seed'));
  const remoteCommit = run(['--git-dir=repo.git', 'rev-parse', 'main']);
  await assert.rejects(reopened.workspace.sync(), /双方提交均已保留/);
  const divergent = await reopened.workspace.status();
  assert.equal(divergent.diverged, true);
  assert.equal(divergent.head, localCommit.head);
  assert.equal(divergent.remoteHead, remoteCommit);
  assert.match((await reopened.read(articlePath))!.text, /Local branch/);
  assert.equal(run(['--git-dir=repo.git', 'rev-parse', 'main']), remoteCommit);
  assert.equal((await new GitWorkspaceRepository(options).workspace.status()).diverged, true);
  await writeFile(join(directory, '.git/shallow'), String(divergent.head));
  await assert.rejects(new GitWorkspaceRepository(options).workspace.status(), /补全浅克隆历史/);
  await rm(join(directory, '.git/shallow'));

  // An interrupted checkout must not allow further mutation before manual recovery.
  await writeFile(join(directory, '.git/wondershine-sync.json'), '{}');
  await assert.rejects(reopened.workspace.commit('unsafe retry'), /上次同步中断/);
  await assert.rejects(reopened.write(articlePath, 'overwrite', (await reopened.read(articlePath))!.revision), /上次同步中断/);
  assert.match(await readFile(join(directory, articlePath), 'utf8'), /Local branch/);
});

const configEnvironment = {
  STUDIO_SESSION_SECRET: 'x'.repeat(32), STUDIO_ADMIN_USER: 'owner',
  STUDIO_ADMIN_PASSWORD_HASH: `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`,
  STUDIO_GIT_URL: 'https://git.example/site.git', STUDIO_GIT_BRANCH: 'main',
};
test('persistent workspace is opt-in and forbidden on ephemeral cloud storage', () => {
  assert.equal(inspectConfig(configEnvironment).repository.workspace, undefined);
  assert.ok(inspectConfig({ ...configEnvironment, STUDIO_GIT_WORKSPACE: '/tmp/example-workspace' }).repository.workspace);
  assert.throws(() => inspectConfig({ ...configEnvironment, STUDIO_STATE: 'blob', STUDIO_GIT_WORKSPACE: '/tmp/example-workspace' }), /不能用于云函数/);
  assert.throws(() => inspectConfig({ ...configEnvironment, STUDIO_GIT_URL: '', STUDIO_SITE_ROOT: '/tmp/site', STUDIO_GIT_WORKSPACE: '/tmp/example-workspace' }), /需要 Git 地址/);
});
test('existing mismatched and non-repository directories are preserved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-workspace-existing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'repo'); await mkdir(directory);
  await writeFile(join(directory, 'important.txt'), 'Keep me');
  const options = { directory, url: 'https://git.example/site.git', branch: 'main', username: 'test', token: '', name: 'Test', email: 'test@example.com' };
  await assert.rejects(new GitWorkspaceRepository(options).list(), /已有文件/);
  assert.equal(await readFile(join(directory, 'important.txt'), 'utf8'), 'Keep me');
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://git.example/different.git'], { cwd: directory, stdio: 'pipe' });
  await assert.rejects(new GitWorkspaceRepository(options).list(), /地址或分支/);
  assert.equal(await readFile(join(directory, 'important.txt'), 'utf8'), 'Keep me');
});
test('workspace status requires authentication and commits/sync require CSRF', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-workspace-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let commits = 0, syncs = 0;
  const status = { branch: 'main', dirty: false, changes: 0, ahead: 0, behind: 0, diverged: false, head: null, remoteHead: null, lastSync: null };
  const repository = Object.assign(new LocalRepository(root), { workspace: {
    status: async () => status,
    createReview: async () => ({ ...status, confirmation: 'preview', confirmationExpiresAt: Date.now() + 60_000 }),
    commit: async (message: string, confirmation?: string) => { assert.equal(message, 'save content'); if (confirmation !== 'preview') throw new StudioError(409, '工作区已变化，请刷新并重新确认提交范围'); commits++; return status; },
    sync: async (confirmation?: string) => { if (confirmation !== 'committed') throw new StudioError(409, '工作区已变化，请刷新并重新确认提交范围'); syncs++; return status; },
  } });
  const config = { origin: 'http://localhost:5173', secureCookies: false, sessionSecret: 'x'.repeat(32), sessionSeconds: 3600, username: 'owner', passwordHash: await hashPassword('workspace-test-password') };
  const app = createApp({ config, repository, state: new FileState(join(root, '.state')) });
  for (const [url, method] of [['/api/workspace', 'GET'], ['/api/workspace/commit', 'POST'], ['/api/workspace/sync', 'POST']]) {
    assert.equal((await app.request(url, { method })).status, 401);
  }
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'workspace-test-password' }) });
  const session = await login.json();
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, origin: config.origin, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  assert.deepEqual(await (await app.request('/api/workspace', { headers })).json(), status);
  for (const endpoint of ['/api/workspace/commit', '/api/workspace/sync']) {
    assert.equal((await app.request(endpoint, { method: 'POST', headers: { cookie, origin: config.origin }, body: '{}' })).status, 403);
    assert.equal((await app.request(endpoint, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  }
  const native = createContentTransport(repository);
  for (const request of [
    (endpoint: string, body?: string) => app.request(endpoint, { method: 'POST', headers, body }),
    (endpoint: string, body?: string) => native(new Request('http://studio.local' + endpoint, { method: 'POST', body })),
  ]) {
    for (const endpoint of ['/api/workspace/commit', '/api/workspace/sync']) {
      assert.equal((await request(endpoint)).status, 400, 'empty body must not bypass confirmation');
      for (const confirmation of [undefined, null, '', '  ', 42, {}]) {
        assert.equal((await request(endpoint, JSON.stringify({ message: 'save content', confirmation }))).status, 400);
      }
      assert.equal((await request(endpoint, JSON.stringify({ message: 'save content', confirmation: 'stale' }))).status, 409);
    }
  }
  assert.equal(commits, 0); assert.equal(syncs, 0);
  assert.equal((await native(new Request('http://studio.local/api/workspace/commit', { method: 'POST', body: JSON.stringify({ message: 'save content', confirmation: 'preview' }) }))).status, 200);
  assert.equal((await native(new Request('http://studio.local/api/workspace/sync', { method: 'POST', body: JSON.stringify({ confirmation: 'committed' }) }))).status, 200);
  assert.equal((await app.request('/api/workspace/commit', { method: 'POST', headers, body: JSON.stringify({ message: 'save content', confirmation: 'preview' }) })).status, 200);
  assert.equal((await app.request('/api/workspace/sync', { method: 'POST', headers, body: JSON.stringify({ confirmation: 'committed' }) })).status, 200);
  assert.equal(commits, 2); assert.equal(syncs, 2);
  const localApp = createApp({ config, repository: new LocalRepository(root), state: new FileState(join(root, '.state')) });
  assert.equal((await localApp.request('/api/workspace', { headers })).status, 404);
  for (const endpoint of ['/api/workspace/commit', '/api/workspace/sync']) {
    assert.equal((await localApp.request(endpoint, { method: 'POST', headers, body: JSON.stringify({ message: 'save content', confirmation: 'preview' }) })).status, 404);
  }
});
