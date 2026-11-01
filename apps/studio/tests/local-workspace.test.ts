import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectLocalRepository } from '../platform/local-workspace.js';
import { NativeGitEngine } from '../platform/git-engine.js';
import type { WorkspaceFiles } from '../platform/filesystem.js';
import { validateProfile } from '../platform/hosting.js';
const files = fs as unknown as WorkspaceFiles;

test('selected local repository opens in place without a remote or a network request', async t => {
  const base = await fs.mkdtemp(join(tmpdir(), 'studio-local-folder-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, 'my blog'), state = join(base, 'state');
  await fs.mkdir(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim();
  git('init', '-b', 'writing'); git('config', 'user.name', 'Local writer'); git('config', 'user.email', 'local@example.test');
  await fs.mkdir(join(root, 'content/articles/test'), { recursive: true });
  await fs.writeFile(join(root, 'config.toml'), 'title="Local"\n');
  await fs.writeFile(join(root, 'data.toml'), '');
  await fs.writeFile(join(root, 'content/articles/test/index.md'), '+++\ntitle="First"\n+++\nHello');
  git('add', '.'); git('commit', '-m', 'initial');
  const head = git('rev-parse', 'HEAD');
  const profile = await inspectLocalRepository(files, root);
  assert.equal(profile.source, 'local'); assert.equal(profile.localPath, root);
  assert.equal(profile.branch, 'writing'); assert.equal(profile.url, ''); assert.equal(profile.authorName, 'Local writer');
  validateProfile(profile);
  const engine = new NativeGitEngine(files, root, state, profile, { request: async () => { throw new Error('Network forbidden'); } }, () => ({ username: '', password: '' }));
  await engine.open(); assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal((await inspectLocalRepository(files, root)).id, profile.id, 'reselecting a folder retains its recovery identity');
  git('update-index', '--assume-unchanged', 'config.toml');
  await fs.utimes(join(root, 'config.toml'), new Date(), new Date());
  const indexBefore = await fs.readFile(join(root, '.git/index'));
  assert.equal((await engine.status()).canSync, false);
  assert.deepEqual(await fs.readFile(join(root, '.git/index')), indexBefore, 'status must not refresh or rewrite the index');
  assert.match(git('ls-files', '-v', 'config.toml'), /^h/);
  git('update-index', '--no-assume-unchanged', 'config.toml');
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock']) {
    await fs.writeFile(join(root, '.git', marker), head);
    await assert.rejects(engine.commit('unsafe'), /Git 操作尚未完成/);
    await assert.rejects(engine.sync(), /Git 操作尚未完成/);
    assert.equal(git('rev-parse', 'HEAD'), head);
    await fs.unlink(join(root, '.git', marker));
  }
  await fs.writeFile(join(root, 'content/articles/test/index.md'), 'Edited locally');
  await engine.commit('docs: edit locally');
  assert.equal(git('log', '-1', '--format=%an'), 'Local writer');
  assert.equal(git('status', '--porcelain'), '');
  await assert.rejects(engine.sync(), /HTTPS/);
  git('remote', 'add', 'origin', 'git@example.test:owner/blog.git');
  const ssh = await inspectLocalRepository(files, root); assert.equal(ssh.url, 'git@example.test:owner/blog.git');
  await new NativeGitEngine(files, root, state, ssh, { request: async () => { throw new Error('Network forbidden'); } }, () => ({ username: '', password: '' })).open();
  const wrong = join(base, 'empty'); await fs.mkdir(wrong);
  await assert.rejects(inspectLocalRepository(files, wrong), /Git/);
  await fs.writeFile(join(root, 'config.toml'), 'not TOML = [');
  await assert.rejects(inspectLocalRepository(files, root));
});

test('local profile rejects traversal, root directories and invalid source types', () => {
  const base = { id: crypto.randomUUID(), label: 'Local', provider: 'generic' as const, url: '', branch: 'main', username: '', authorName: '', authorEmail: '', source: 'local' as const, localPath: '/Users/writer/blog' };
  assert.doesNotThrow(() => validateProfile(base));
  for (const localPath of ['/', 'C:/', '/Users/../private', 'relative/blog', '/blog\0path']) {
    assert.throws(() => validateProfile({ ...base, localPath }));
  }
});
