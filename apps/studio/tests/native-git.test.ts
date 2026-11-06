import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import * as nodeFiles from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { NativeGitEngine } from '../platform/git-engine.js';
import { nodeReviewSource, nodeWorkspaceReviews } from '../server/review-store.js';
import { createGitHttp } from '../platform/git-http.js';
import type { WorkspaceFiles } from '../platform/filesystem.js';
import { validateProfile, type WorkspaceProfile } from '../platform/hosting.js';

const files: WorkspaceFiles = {
  readFile: (path, options) => (options === 'utf8' || typeof options === 'object' && options !== null && 'encoding' in options) ? nodeFiles.readFile(path, 'utf8') : nodeFiles.readFile(path),
  writeFile: async (path, bytes) => { await nodeFiles.writeFile(path, bytes); },
  readdir: path => nodeFiles.readdir(path),
  mkdir: async (path, options) => { await nodeFiles.mkdir(path, options); },
  rmdir: path => nodeFiles.rmdir(path), unlink: path => nodeFiles.unlink(path), rename: (from, to) => nodeFiles.rename(from, to),
  stat: path => nodeFiles.stat(path), lstat: path => nodeFiles.lstat(path), readlink: path => nodeFiles.readlink(path),
  symlink: (target, path) => nodeFiles.symlink(target, path), chmod: (path, mode) => nodeFiles.chmod(path, mode),
};

test('native Git engine bundles without external Node builtins', async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../platform/git-engine.ts', import.meta.url))], bundle: true,
    platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.equal(Object.values(result.metafile.outputs).some(output => output.imports.some(item => item.external)), false);
  assert.equal(Object.keys(result.metafile.inputs).some(path => /\/server\//.test(path)), false);
});

test('native Git persists offline commits, fast-forwards safely, preserves rejected/divergent history and interrupts safely', async t => {
  const base = await nodeFiles.mkdtemp(join(tmpdir(), 'studio-native-git-'));
  t.after(() => nodeFiles.rm(base, { recursive: true, force: true }));
  const run = (args: string[], cwd = base) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  run(['init', '--bare', '-b', 'main', 'remote.git']); run(['-C', 'remote.git', 'config', 'http.receivepack', 'true']);
  run(['init', '-b', 'main', 'seed']);
  const seed = join(base, 'seed'), article = 'content/articles/first/index.md';
  await nodeFiles.mkdir(join(seed, 'content/articles/first'), { recursive: true });
  await nodeFiles.writeFile(join(seed, article), '+++\ntitle="First"\n+++\nOriginal\n');
  await nodeFiles.writeFile(join(seed, 'config.toml'), 'title="Native"\n');
  const seedCommit = (message: string) => { run(['add', '.'], seed); run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message], seed); run(['push', '../remote.git', 'main'], seed); };
  seedCommit('initial');
  // The personal blog pins its Astro theme through a Git submodule.
  const themeCommit = run(['rev-parse', 'HEAD'], seed);
  await nodeFiles.mkdir(join(seed, 'themes/wondershine'), { recursive: true });
  await nodeFiles.writeFile(join(seed, '.gitmodules'), '[submodule "themes/wondershine"]\n\tpath = themes/wondershine\n\turl = https://git.test/theme.git\n');
  run(['add', '.gitmodules'], seed);
  run(['update-index', '--add', '--cacheinfo', `160000,${themeCommit},themes/wondershine`], seed);
  run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'pin theme submodule'], seed);
  run(['push', '../remote.git', 'main'], seed);
  const executable = join(run(['--exec-path']), 'git-http-backend');
  let requests = 0, authorized = false;
  const server = createServer((req, res) => {
    requests++;
    if (!req.headers.authorization) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm=Git' }).end(); return; }
    authorized = true;
    const url = new URL(req.url!, 'http://localhost');
    const child = spawn(executable, [], { env: { ...process.env, GIT_PROJECT_ROOT: base, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
      REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'tester', REMOTE_ADDR: '127.0.0.1' } });
    const parts: Buffer[] = []; child.stdout.on('data', chunk => parts.push(chunk)); child.stderr.resume(); req.pipe(child.stdin);
    child.on('close', () => {
      const bytes = Buffer.concat(parts), end = bytes.indexOf('\r\n\r\n');
      if (end < 0) { res.writeHead(500).end(); return; }
      for (const line of bytes.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':'), key = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (key === 'Status') res.statusCode = Number(value.split(' ')[0]); else res.setHeader(key, value);
      }
      res.end(bytes.subarray(end + 4));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  let offline = false;
  const localFetch: typeof fetch = async (input, init) => {
    if (offline) throw new Error('Offline');
    const url = new URL(String(input)); assert.equal(url.origin, 'https://git.test');
    const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const profile: WorkspaceProfile = { id: crypto.randomUUID(), label: 'Test', provider: 'generic', url: 'https://git.test/remote.git', branch: 'main', username: 'tester', authorName: 'Studio', authorEmail: 'studio@example.com' };
  // Remote HEAD may be a branch other than main; users need not know its name.
  run(['--git-dir=remote.git', 'branch', 'release/blog', 'main']);
  run(['--git-dir=remote.git', 'symbolic-ref', 'HEAD', 'refs/heads/release/blog']);
  const automatic = { ...profile, id: crypto.randomUUID(), branch: '' };
  assert.throws(() => validateProfile(automatic), /分支/, 'saved profiles still require a concrete branch');
  const progress: { phase: string; loaded: number; total?: number }[] = [];
  const autoRoot = join(base, 'automatic');
  const autoEngine = new NativeGitEngine(files, autoRoot, join(base, 'automatic-state'), automatic, createGitHttp(profile.url, localFetch), () => ({ username: 'tester', password: 'native-test-secret' }));
  await autoEngine.open(event => { progress.push(event); });
  assert.equal(automatic.branch, 'release/blog');
  assert.equal(run(['branch', '--show-current'], autoRoot), 'release/blog');
  validateProfile(automatic);
  assert.ok(progress.some(event => event.phase === 'Receiving objects' && event.loaded > 0));
  assert.ok(progress.some(event => event.phase === 'Updating workdir' && event.loaded > 0));
  offline = true; await autoEngine.open(); assert.equal((await autoEngine.status()).branch, 'release/blog'); offline = false;
  const missingBranch = new NativeGitEngine(files, autoRoot, join(base, 'automatic-state'), { ...automatic, branch: '' }, createGitHttp(profile.url, localFetch), () => ({ username: '', password: '' }));
  await assert.rejects(missingBranch.open(), /分支/, 'an existing checkout must never silently adopt a branch');
  assert.throws(() => new NativeGitEngine(files, autoRoot, join(base, 'automatic-state'), { ...automatic, source: 'local', localPath: autoRoot, branch: '' }, createGitHttp(profile.url, localFetch), () => ({ username: '', password: '' })), /分支/);
  const failed = { ...profile, id: crypto.randomUUID(), branch: '' };
  const retryRoot = join(base, 'retry');
  const retry = new NativeGitEngine(files, retryRoot, join(base, 'retry-state'), failed, createGitHttp(profile.url, localFetch), () => ({ username: 'tester', password: 'native-test-secret' }));
  offline = true; await assert.rejects(retry.open(), /首次下载/); assert.equal(failed.branch, '');
  assert.equal((await nodeFiles.readdir(base)).some(name => name.startsWith('retry.clone-')), false);
  offline = false; await retry.open(); assert.equal(failed.branch, 'release/blog');
  run(['--git-dir=remote.git', 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const root = join(base, 'workspace'), state = join(base, 'state');
  let reviewReads = 0;
  const create = (fileApi = files, directory = root, metadata = state) => new NativeGitEngine(fileApi, directory, metadata, profile, createGitHttp(profile.url, localFetch), () => ({ username: 'tester', password: 'native-test-secret' }), {
    store: nodeWorkspaceReviews(directory),
    source: async path => { reviewReads++; return nodeReviewSource(directory)(path); },
  });
  const beforeOpenRequests = requests;
  let engine = create(); await assert.rejects(engine.status(), /请先下载/); assert.equal(requests, beforeOpenRequests); await engine.open(); assert.equal((await engine.status()).dirty, false); assert.ok(authorized);
  const initialRequests = requests, initialHead = run(['--git-dir=remote.git', 'rev-parse', 'main']);
  offline = true;
  await nodeFiles.writeFile(join(root, article), 'Offline writing');
  engine = create(); await engine.open(); assert.equal((await engine.status()).dirty, true);
  await assert.rejects(engine.sync(), /先提交/);
  const ordinary = await engine.status();
  assert.equal(ordinary.confirmation, undefined);
  assert.equal(ordinary.confirmationExpiresAt, undefined);
  assert.equal(reviewReads, 0, 'ordinary status must not invoke the streaming review source');
  await assert.rejects(nodeFiles.stat(root + '.studio-reviews-v1'), { code: 'ENOENT' });
  const preview = await engine.createReview();
  assert.ok(preview.confirmation);
  assert.ok(reviewReads > 0);
  const reviewedReads = reviewReads;
  assert.deepEqual(await engine.status(), ordinary);
  assert.equal(reviewReads, reviewedReads, 'polling must not revalidate or recapture a review');
  assert.ok(preview.managedChanges?.length);
  await assert.rejects(engine.commit('stale', 'stale'), /重新确认/);
  assert.equal((await engine.status()).head, preview.head);
  engine = create(); // Another engine instance must validate the persisted review.
  const local = await engine.commit('docs(content): offline draft', preview.confirmation);
  assert.equal(local.confirmation, undefined);
  assert.equal(local.confirmationExpiresAt, undefined);
  await assert.rejects(engine.sync(preview.confirmation), /重新确认/);
  assert.equal(local.ahead, 1); assert.equal(requests, initialRequests);
  await assert.rejects(engine.sync(), /本地文件和提交已保留/);
  assert.equal(run(['--git-dir=remote.git', 'rev-parse', 'main']), initialHead);
  offline = false;
  const syncReview = await engine.createReview();
  assert.ok(syncReview.confirmation);
  assert.notEqual(syncReview.confirmation, preview.confirmation);
  const synced = await engine.sync(syncReview.confirmation); assert.equal(synced.ahead, 0); assert.ok(synced.lastSync);
  assert.equal(synced.confirmation, undefined);
  assert.match(run(['--git-dir=remote.git', 'show', `main:${article}`]), /Offline writing/);
  assert.equal(run(['--git-dir=remote.git', 'ls-tree', 'main', 'themes/wondershine']), `160000 commit ${themeCommit}\tthemes/wondershine`, 'native content commit must preserve the theme gitlink');
  run(['clone', '--no-checkout', seed, join(root, 'themes/wondershine')]);
  run(['checkout', themeCommit], join(root, 'themes/wondershine'));
  run(['submodule', 'absorbgitdirs'], root);
  assert.equal((await engine.status()).dirty, false, 'initialized theme submodule is not a content change');
  assert.doesNotMatch(await nodeFiles.readFile(join(root, '.git/config'), 'utf8'), /native-test-secret/);
  assert.doesNotMatch((await Promise.all((await nodeFiles.readdir(state)).map(file => nodeFiles.readFile(join(state, file), 'utf8')))).join(''), /native-test-secret/);

  run(['pull', '--ff-only', '../remote.git', 'main'], seed);
  await nodeFiles.writeFile(join(seed, 'config.toml'), 'title="Other device"\n'); seedCommit('other device');
  await engine.sync(); assert.match(await nodeFiles.readFile(join(root, 'config.toml'), 'utf8'), /Other device/);
  assert.equal(run(['branch', '--show-current'], root), 'main');

  await nodeFiles.writeFile(join(root, 'source.ts'), 'export {};'); run(['add', 'source.ts'], root);
  await nodeFiles.writeFile(join(root, article), 'More content');
  await assert.rejects(engine.commit('content only'), /暂存区/);
  assert.equal(run(['diff', '--cached', '--name-only'], root), 'source.ts');
  run(['reset', 'HEAD', '--', 'source.ts'], root); await nodeFiles.unlink(join(root, 'source.ts'));
  const committed = await engine.commit('more content');
  const hook = join(base, 'remote.git/hooks/pre-receive'); await nodeFiles.writeFile(hook, '#!/bin/sh\nexit 1\n'); await nodeFiles.chmod(hook, 0o700);
  await assert.rejects(engine.sync(), /本地提交已保留/); assert.equal((await engine.status()).head, committed.head);
  await nodeFiles.unlink(hook); await engine.sync();

  // An interrupted fast-forward keeps a journal and blocks subsequent writes.
  const interruptedRoot = join(base, 'interrupted'), interruptedState = join(base, 'interrupted-state');
  let failCheckout = false;
  const failingFiles = { ...files, writeFile: async (path: string, bytes: Uint8Array | string) => {
    if (failCheckout && path === interruptedRoot + '/config.toml') throw new Error('Simulated disk failure');
    return files.writeFile(path, bytes);
  } };
  const interrupted = create(failingFiles, interruptedRoot, interruptedState); await interrupted.open();
  run(['pull', '--ff-only', '../remote.git', 'main'], seed);
  await nodeFiles.writeFile(join(seed, 'config.toml'), 'title="Fast forward"\n'); seedCommit('fast forward');
  failCheckout = true; await assert.rejects(interrupted.sync());
  assert.ok(await nodeFiles.stat(interruptedState + '/sync.json'));
  await assert.rejects(interrupted.assertWritable(), /上次同步中断/);
  await assert.rejects(interrupted.commit('unsafe'), /上次同步中断/);
  await assert.rejects(interrupted.sync(), /上次同步中断/);

  // Distinct local and remote commits are retained, never force-pushed or reset.
  await engine.sync();
  await nodeFiles.writeFile(join(root, article), 'Local divergence'); const localDiverged = await engine.commit('local change');
  await nodeFiles.writeFile(join(seed, article), 'Remote divergence'); seedCommit('remote change');
  const remoteHead = run(['--git-dir=remote.git', 'rev-parse', 'main']);
  await assert.rejects(engine.sync(), /双方提交均已保留/);
  const divergent = await create().status(); assert.equal(divergent.diverged, true); assert.equal(divergent.head, localDiverged.head); assert.equal(divergent.remoteHead, remoteHead);
  assert.equal(await nodeFiles.readFile(join(root, article), 'utf8'), 'Local divergence');
  assert.equal(run(['--git-dir=remote.git', 'rev-parse', 'main']), remoteHead);
  const mismatched = new NativeGitEngine(files, root, state, { ...profile, branch: 'other' }, createGitHttp(profile.url, localFetch), () => ({ username: '', password: '' }));
  await assert.rejects(mismatched.open(), /地址或分支/);
});
