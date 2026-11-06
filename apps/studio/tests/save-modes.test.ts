import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitBranchSnapshot } from '../platform/branch-save.js';
import { saveBatch, saveCapabilities } from '../core/save.js';
import { LocalRepository } from '../server/repository.js';
import type { Repository } from '../shared/repository.js';

test('branch snapshots preserve HEAD, index, unrelated edits and reuse the branch without duplicate commits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-save-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  run('init', '-b', 'main');
  const path = 'content/articles/example/index.md';
  await mkdir(join(root, 'content/articles/example'), { recursive: true });
  await writeFile(join(root, path), 'original');
  await writeFile(join(root, 'unrelated.txt'), 'original');
  await writeFile(join(root, 'content/articles/_index.md'), 'original section');
  run('add', '.'); run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'seed');
  const head = run('rev-parse', 'HEAD');
  await writeFile(join(root, 'unrelated.txt'), 'staged work'); run('add', 'unrelated.txt');
  await writeFile(join(root, path), 'newer unsaved external text');
  const index = await readFile(join(root, '.git/index'));
  const options = { fs, dir: root, author: { name: 'Studio', email: 'test@example.com' } };
  const entries = [{ path: 'content/articles/_index.md', data: new TextEncoder().encode('unrelated section draft'), onlyIfMissing: true }, { path, data: new TextEncoder().encode('saved snapshot') }, { path: 'public/uploads/cover.png', data: new Uint8Array([1, 2, 3]) }];
  const first = await commitBranchSnapshot(options, path, entries);
  assert.equal(run('rev-parse', 'HEAD'), head);
  assert.equal(run('branch', '--show-current'), 'main');
  assert.deepEqual(await readFile(join(root, '.git/index')), index);
  assert.equal(run('show', `${first.branch}:${path}`), 'saved snapshot');
  assert.equal(run('show', `${first.branch}:unrelated.txt`), 'original');
  assert.equal(run('show', `${first.branch}:content/articles/_index.md`), 'original section');
  assert.equal(await readFile(join(root, path), 'utf8'), 'newer unsaved external text');
  const again = await commitBranchSnapshot(options, path, entries);
  assert.deepEqual(again, first);
  const changed = await commitBranchSnapshot(options, path, [{ path, data: new TextEncoder().encode('updated') }]);
  assert.equal(changed.branch, first.branch);
  assert.notEqual(changed.commit, first.commit);
  assert.equal(run('rev-parse', `${changed.commit}^`), first.commit);
  assert.equal(run('show', `${changed.branch}:${path}`), 'updated');
  await assert.rejects(commitBranchSnapshot(options, path, [{ path: '.git/config', data: new Uint8Array() }]), /目录中的图片/);
});

test('save capability validation prevents unsupported modes from touching storage; partial success returns a usable revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-save-core-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  const local = new LocalRepository(root);
  const path = 'content/articles/example/index.md';
  const entries = [{ path, text: 'saved', expectedRevision: null }];
  assert.deepEqual(saveCapabilities(local).modes, ['local']);
  await assert.rejects(saveBatch(local, entries, undefined, 'branch'), /保存方式/);
  await assert.rejects(saveBatch(local, entries, undefined, 'invalid'), /保存方式/);
  assert.equal(await local.read(path), null);
  let fail = true;
  const repository: Repository = Object.assign(local, { workspace: {
    createReview: async () => { throw new Error('unused'); },
    status: async () => { throw new Error('unused'); }, commit: async () => { throw new Error('unused'); }, sync: async () => { throw new Error('unused'); },
    saveBranch: async () => { if (fail) throw new Error('disk full'); return { branch: 'studio/save-test', commit: 'abc' }; },
  } });
  const first = await saveBatch(repository, entries, undefined, 'branch');
  assert.equal(first.branchPending, true);
  assert.equal((await local.read(path))?.revision, first.revision);
  fail = false;
  const retry = await saveBatch(repository, [{ ...entries[0], expectedRevision: first.revision }], undefined, 'branch');
  assert.equal(retry.branch, 'studio/save-test');
  assert.equal(retry.branchPending, undefined);
  assert.equal(retry.commit, 'abc');
  const online = { mode: 'git', writeBatch: async () => { throw new Error('must not write'); } } as unknown as Repository;
  assert.deepEqual(saveCapabilities(online).modes, ['remote']);
  await assert.rejects(saveBatch(online, entries, undefined, 'local'), /保存方式/);
});

test('persistent server saves content, language sections and referenced media to a branch without pushing', async t => {
  const { GitWorkspaceRepository } = await import('../server/git-workspace.js');
  const { ContentService } = await import('../core/content-service.js');
  const root = await mkdtemp(join(tmpdir(), 'studio-save-workspace-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  run('init', '-b', 'main'); run('remote', 'add', 'origin', 'https://git.example.test/blog.git');
  await writeFile(join(root, 'config.toml'), 'title="Site"\ndefault_language="zh-CN"\n[languages.en]\n');
  await writeFile(join(root, 'data.toml'), '');
  run('add', '.'); run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'seed');
  await mkdir(join(root, 'public/uploads'), { recursive: true });
  await writeFile(join(root, 'public/uploads/new cover (1).png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwinr/HwAE+AKLJh4rzQAAAABJRU5ErkJggg==', 'base64'));
  const repository = new GitWorkspaceRepository({directory: root, url:'https://git.example.test/blog.git', branch:'main', username:'test',token:'',name:'Test',email:'test@example.com'});
  const content = new ContentService(repository);
  const path = 'content/articles/example/index.en.md';
  const head = run('rev-parse', 'HEAD');
  const result = await content.saveDocument(path, {title:'English',draft:true,'extra.cover':'/uploads/new cover (1).png'}, '![Image](</uploads/new cover (1).png>)', null, 'branch');
  assert.equal(result.branchPending, undefined);
  assert.ok(result.branch);
  assert.equal(run('rev-parse', 'HEAD'), head);
  assert.match(run('show', `${result.branch}:${path}`), /English/);
  assert.ok(run('ls-tree', '-r', result.branch!).includes('public/uploads/new cover (1).png'));
  const unchanged = await content.saveDocument(path, {}, '![Image](</uploads/new cover (1).png>)', result.revision, 'branch');
  assert.equal(unchanged.commit, result.commit);
  const old = (await repository.read(path))!;
  await repository.write(path, old.text + '\nNewer client edit', old.revision);
  await assert.rejects(repository.workspace.saveBranch!(path, [{ path, data: new TextEncoder().encode(old.text) }]), /文件在分支提交前已更新/);
  assert.equal(run('rev-parse', result.branch!), result.commit);
  assert.match((await repository.read(path))!.text, /Newer client edit/);

  const settings = await content.settings('site');
  const settingsResult = await content.saveSettings('site', {title:'Updated site'}, settings.revision, undefined, 'branch');
  assert.ok(settingsResult.branch);
  assert.notEqual(settingsResult.branch, result.branch);
  assert.match(run('show', `${settingsResult.branch}:config.toml`), /Updated site/);
  assert.equal(run('rev-parse', 'HEAD'), head);
  await assert.rejects(content.saveDocument(path, {}, 'stale', null, 'branch'), /文件已更新/);
});


test('media references preserve structured filenames, markdown references and HTML attributes', async () => {
  const { saveMediaValues } = await import('../core/save-media.js');
  const values = saveMediaValues('content/articles/a/index.md', '+++\n[extra]\ncover="/uploads/my cover (1).png"\n+++\n![one][photo]\n\n[photo]: </uploads/another image (2).png>\n\n<img src="/uploads/html cover.png">');
  assert.ok(values.includes('/uploads/my cover (1).png'));
  assert.ok(values.includes('/uploads/another image (2).png'));
  assert.ok(values.includes('/uploads/html cover.png'));
  assert.deepEqual(saveMediaValues('data.toml', 'logo="/img/my logo.svg"'), ['/img/my logo.svg']);
});
