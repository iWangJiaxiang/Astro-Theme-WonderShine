import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isSiteInput, prepareAssets } from '../scripts/astro-assets';

test('asset snapshots use the requested site, preserve precedence and remove stale files', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'astro-assets-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, 'site'), output = path.join(workspace, 'public');
  await mkdir(path.join(root, 'content/articles/example'), { recursive: true });
  await mkdir(path.join(root, 'public'), { recursive: true });
  await mkdir(path.join(root, 'static'), { recursive: true });
  await writeFile(path.join(root, 'config.toml'), 'base_url="https://assets.test"\ndefault_language="zh-CN"\ntheme="custom"\n[languages.en]\ntitle="English"');
  const content = path.join(root, 'content/articles/example/index.md');
  await writeFile(content, '+++\ntitle="Asset owner"\npath="custom-route"\n+++\nBody');
  await writeFile(path.join(root, 'content/articles/example/index.en.md'), '+++\ntitle="Translation"\npath="en/custom-route"\n+++\nBody');
  await writeFile(path.join(root, 'content/articles/example/cover.png'), 'bundle-image');
  await writeFile(path.join(root, 'static/shared.txt'), 'theme');
  await writeFile(path.join(root, 'public/shared.txt'), 'site');
  await writeFile(path.join(root, 'public/removed.txt'), 'old');
  await writeFile(path.join(root, 'public/.private'), 'hidden');
  await writeFile(path.join(workspace, 'outside.txt'), 'outside');
  await symlink(path.join(workspace, 'outside.txt'), path.join(root, 'public/linked.txt'));
  await writeFile(path.join(root, '_headers'), '/\n  X-Test: first');

  await prepareAssets(root, output);
  assert.equal(await readFile(path.join(output, 'shared.txt'), 'utf8'), 'site');
  assert.equal(await readFile(path.join(output, 'custom-route/cover.png'), 'utf8'), 'bundle-image');
  assert.equal(await readFile(path.join(output, 'en/custom-route/cover.png'), 'utf8'), 'bundle-image');
  await assert.rejects(access(path.join(output, '.private')));
  await assert.rejects(access(path.join(output, 'linked.txt')));

  await rm(path.join(root, 'public/shared.txt'));
  await rm(path.join(root, 'public/removed.txt'));
  await rm(path.join(root, '_headers'));
  await writeFile(content, '+++\ntitle="Moved owner"\npath="new-route"\n+++\nBody');
  await prepareAssets(root, output);
  assert.equal(await readFile(path.join(output, 'shared.txt'), 'utf8'), 'theme');
  assert.equal(await readFile(path.join(output, 'new-route/cover.png'), 'utf8'), 'bundle-image');
  await assert.rejects(access(path.join(output, 'custom-route/cover.png')));
  await assert.rejects(access(path.join(output, 'removed.txt')));
  await assert.rejects(access(path.join(output, '_headers')));

  await writeFile(content, '+++\ntitle=\n+++\nBroken');
  await assert.rejects(prepareAssets(root, output), /Invalid TOML/);
  assert.equal(await readFile(path.join(output, 'new-route/cover.png'), 'utf8'), 'bundle-image');
});

test('asset preparation refuses a destination that contains source content', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astro-assets-safe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'content'));
  await writeFile(path.join(root, 'config.toml'), 'base_url="https://assets.test"');
  await assert.rejects(prepareAssets(root, root), /outside source directories/);
  await assert.rejects(prepareAssets(root, path.join(root, 'public/output')), /outside source directories/);
  assert.equal(await readFile(path.join(root, 'config.toml'), 'utf8'), 'base_url="https://assets.test"');
});

test('dev watches source changes without looping over generated output', () => {
  const root = path.resolve('/tmp/site-inputs');
  for (const file of ['config.toml', 'data.en.toml', '_redirects', 'content/new/index.md', 'public/uploads/image.png', 'static/theme.css', 'compatibility/heading-aliases.json']) {
    assert.equal(isSiteInput(path.join(root, file), root), true, file);
  }
  assert.equal(isSiteInput(path.join(root, 'custom/i18n.toml'), root, 'custom/i18n.toml'), true);
  for (const file of ['dist/index.html', '.astro-assets/generated/image.png', 'node_modules/dependency/index.js', 'data.en.toml.backup']) {
    assert.equal(isSiteInput(path.join(root, file), root), false, file);
  }
});
