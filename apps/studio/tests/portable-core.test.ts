import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { LocalRepository } from '../server/repository.js';
import { ContentService } from '../core/content-service.js';
import { createContentTransport } from '../core/transport.js';
import { revisionOf, isDeepStrictEqual, posix } from '../core/portable.js';
import type { Article, Settings } from '../shared/types.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'studio-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new LocalRepository(root);
  await repository.write('config.toml', 'title="Portable studio"\nbase_url="https://example.com"\ndefault_language="zh-CN"\ntaxonomies=[{name="tags"},{name="categories"}]\n[languages.en]\ntaxonomies=[{name="tags"},{name="categories"}]\n', null);
  await repository.write('data.toml', '', null);
  const transport = createContentTransport(repository, { identity: { id: 'workspace-a', name: 'My workspace' } });
  const request = (path: string, method = 'GET', body?: unknown) => transport(new Request('http://studio.local/api' + path, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { repository, transport, request };
}

test('portable content core bundles for the browser without Node polyfills or external modules', async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../core/transport.ts', import.meta.url))], bundle: true,
    platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.ok(result.outputFiles[0].text.includes('createContentTransport'));
  assert.equal(Object.keys(result.metafile.inputs).some(path => /\/server\//.test(path)), false);
  assert.equal(Object.values(result.metafile.outputs).some(output => output.imports.some(item => item.external)), false);
});

test('portable revisions match server SHA-256 and TOML comparisons preserve meaningful values', async () => {
  for (const text of ['', '文章\n😀', 'a'.repeat(5000)]) assert.equal(await revisionOf(text), createHash('sha256').update(text).digest('hex'));
  assert.equal(isDeepStrictEqual({ a: 1, b: ['x'] }, { b: ['x'], a: 1 }), true);
  assert.equal(isDeepStrictEqual([1, 2], [2, 1]), false);
  assert.equal(isDeepStrictEqual({ x: undefined }, {}), false);
  assert.equal(isDeepStrictEqual(new Date('2026-10-31'), new Date('2026-10-31')), true);
  assert.equal(isDeepStrictEqual(null, {}), false);
  assert.equal(posix.dirname('content/articles/story/index.md'), 'content/articles/story');
  assert.equal(posix.dirname('content'), '.');
});

test('in-process editing uses the same revision validation and multilingual rules as the server', async t => {
  const { request, repository } = await fixture(t);
  const session = await (await request('/auth/session')).json();
  assert.equal(session.identity.id, 'workspace-a');
  const bootstrap = await (await request('/bootstrap')).json();
  assert.equal(bootstrap.site.title, 'Portable studio');
  assert.equal(bootstrap.workspace, false);
  const path = 'content/articles/portable/index.md';
  const saved = await request('/document', 'PUT', { path, revision: null, changes: { title: '跨平台文章', draft: true }, body: '# 内容\n' });
  assert.equal(saved.status, 200);
  const document = await (await request('/document?path=' + encodeURIComponent(path))).json() as Article;
  assert.equal(document.body.trim(), '# 内容');
  const translation = await request('/translation/manual', 'POST', { path, revision: document.revision, language: 'en' });
  assert.equal(translation.status, 201);
  const translated = await translation.json();
  assert.equal(translated.path, 'content/articles/portable/index.en.md');
  assert.ok(await repository.read(translated.path));
  assert.equal((await (await request('/content-languages')).json()).languages.length, 2);
  const list = await (await request('/content')).json();
  assert.deepEqual(list[0].availableLanguages, ['en', 'zh-CN']);
  const stale = await request('/document', 'PUT', { path, revision: null, changes: { title: 'Stale' }, body: 'overwrite' });
  assert.equal(stale.status, 409);
  assert.equal((await repository.read(path))?.text.includes('overwrite'), false);
  assert.equal((await request('/translation/manual', 'POST', { path, revision: document.revision, language: 'en' })).status, 409);
  const removed = await request('/document', 'DELETE', { path, revision: document.revision });
  assert.equal(removed.status, 200);
  assert.equal(await repository.read(path), null);
  assert.ok(await repository.read(translated.path));
});

test('in-process settings, capability flags, path rejection and disconnect are explicit', async t => {
  const { request } = await fixture(t);
  const settings = await (await request('/settings/site')).json() as Settings;
  const saved = await request('/settings/site', 'PUT', { revision: settings.revision, changes: { title: 'Updated offline' } });
  assert.equal(saved.status, 200);
  assert.equal((await (await request('/settings/site')).json()).values.title, 'Updated offline');
  assert.deepEqual(await (await request('/ai/config')).json(), { text: false, image: false });
  assert.deepEqual(await (await request('/translation/config')).json(), { enabled: false });
  assert.equal((await request('/ai/text', 'POST', {})).status, 503);
  assert.equal((await request('/document?path=../../secrets')).status, 400);
  assert.equal((await request('/unknown')).status, 404);
  assert.equal((await request('/auth/logout', 'POST')).status, 200);
  assert.equal((await request('/content')).status, 401);
});

test('native media uses bounded bodies and the existing image validator', async t => {
  const { request, transport } = await fixture(t);
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...Array(16).fill(0)]);
  const upload = await transport(new Request('http://studio.local/api/media/upload?directory=public/uploads&filename=portable.png', { method: 'POST', body: image }));
  assert.equal(upload.status, 201);
  const listing = await (await request('/media')).json();
  assert.equal(listing.items.length, 1);
  const file = await request('/media/file?path=public/uploads/portable.png');
  assert.equal(file.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), image);
  const invalid = await transport(new Request('http://studio.local/api/media/upload?directory=public/uploads&filename=bad.png', { method: 'POST', body: 'not a png' }));
  assert.equal(invalid.status, 400);
});

// At 02:30 in Shanghai, the UTC calendar still shows the previous day.
test('new content records an exact publication instant and retains explicit or existing dates', async t => {
  const { repository } = await fixture(t);
  const now = new Date('2026-11-01T02:30:00+08:00');
  const service = new ContentService(repository, () => now);
  const path = 'content/articles/midnight/index.md';
  await service.saveDocument(path, { title: 'After midnight', draft: false }, 'Body', null);
  const created = await service.document(path);
  assert.equal(Date.parse(String(created.metadata.date)), now.getTime());
  const legacyPath = 'content/articles/legacy/index.md';
  await repository.write(legacyPath, '+++\ntitle="Legacy"\ndate=2026-10-01\n+++\nBody', null);
  const legacy = await service.document(legacyPath);
  await service.saveDocument(legacyPath, { title: 'Edited' }, legacy.body, legacy.revision);
  assert.match((await repository.read(legacyPath))!.text, /date=2026-10-01\n/);
  const scheduled = '2026-11-02T10:30:00+08:00';
  await service.saveDocument(path, { date: scheduled }, created.body, created.revision);
  assert.equal((await service.document(path)).metadata.date, scheduled);
});
