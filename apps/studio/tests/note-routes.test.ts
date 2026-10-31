import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalNativeNoteRoute, noteRouteId } from '../shared/note-routes.js';
import { contentLink } from '../shared/content-links.js';
import { LocalRepository } from '../server/repository.js';
import { ContentService } from '../server/content-service.js';
import { TranslationService } from '../server/translation.js';
import { getValue } from '../server/content.js';

const uuid = '8d7af1f2-de97-40fc-8909-b42954e689a9';
const legacy = 'n_8d7af1f2de9740fc8909b42954e689a9';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'studio-thread-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.toml'), 'base_url="https://example.test"\ndefault_language="zh"\ncompile_sass=false\n[languages.en]\n');
  const repo = new LocalRepository(root);
  return { root, repo, content: new ContentService(repo), translation: new TranslationService(repo) };
}
const note = (id: string) => ({ 'extra.kind': 'note', 'extra.id': id, draft: false, date: '2020-01-01T00:00:00Z' });
async function imported(repo: LocalRepository, id = legacy, language = '') {
  const path = `content/notes/${id}/index${language ? '.' + language : ''}.md`;
  await repo.write(path, `+++\ndate=2020-01-01T00:00:00Z\ndraft=false\n[extra]\nkind="note"\nid="${id}"\ncustom="keep"\n+++\nOriginal body`, null);
  return path;
}

test('thread routes use UUIDs without changing legacy storage identity or arbitrary imported slugs', () => {
  assert.equal(noteRouteId(legacy), uuid);
  assert.equal(noteRouteId(uuid.toUpperCase()), uuid);
  assert.equal(canonicalNativeNoteRoute(legacy, 'zh', 'zh'), `/thread/${uuid}/`);
  assert.equal(canonicalNativeNoteRoute(uuid, 'en', 'zh'), `/en/thread/${uuid}/`);
  assert.equal(canonicalNativeNoteRoute('imported-note', 'zh', 'zh'), '/thread/imported-note/');
  assert.throws(() => canonicalNativeNoteRoute('../secret', 'zh', 'zh'));
  assert.equal(contentLink(`content/notes/${legacy}/index.en.md`, {}, { default_language: 'zh', languages: { en: {} } }).publicPath, `/en/thread/${uuid}/`);
});

test('saving legacy notes migrates native paths and aliases without moving content or comment identity', async t => {
  const { repo, content } = await fixture(t);
  for (const language of ['', 'en']) {
    const path = await imported(repo, legacy, language), before = await content.document(path);
    await content.saveDocument(path, {}, before.body, before.revision);
    const saved = await content.document(path), expected = canonicalNativeNoteRoute(legacy, language || 'zh', 'zh');
    assert.equal(saved.metadata.path, expected.slice(1, -1));
    assert.deepEqual(saved.metadata.aliases, [`/${language ? language + '/' : ''}notes/${legacy}/`]);
    assert.equal(getValue(saved.metadata, 'extra.comment_path'), `/notes/${legacy}/`);
    assert.equal(getValue(saved.metadata, 'extra.id'), legacy);
    assert.equal(getValue(saved.metadata, 'extra.custom'), 'keep');
    assert.equal(saved.body, before.body);
    await content.saveDocument(path, {}, saved.body, saved.revision);
    assert.equal((await content.document(path)).revision, saved.revision);
    assert.equal(await repo.read(`content/notes/${uuid}/index${language ? '.' + language : ''}.md`), null);
  }
});

test('new UUID notes and translations get native language routes without source aliases', async t => {
  const { content, translation } = await fixture(t);
  const path = `content/notes/${uuid}/index.en.md`;
  await content.saveDocument(path, note(uuid), 'English first', null);
  const source = await content.document(path);
  assert.equal(source.metadata.path, `en/thread/${uuid}`);
  assert.equal(source.metadata.aliases, undefined);
  const result = await translation.createManual({ path, revision: source.revision, language: 'zh' });
  const target = await content.document(result.path);
  assert.equal(target.metadata.path, `thread/${uuid}`);
  assert.equal(target.metadata.draft, true);
  assert.equal(target.metadata.aliases, undefined);
  assert.equal(getValue(target.metadata, 'extra.comment_path'), undefined);
  await assert.rejects(translation.createManual({ path, revision: source.revision, language: 'zh' }), /译文已存在/);
});

test('translations of migrated legacy notes retain shared comments but never copy source aliases', async t => {
  const { repo, content, translation } = await fixture(t);
  const path = await imported(repo), before = await content.document(path);
  await content.saveDocument(path, {}, before.body, before.revision);
  const source = await content.document(path);
  const result = await translation.createManual({ path, revision: source.revision, language: 'en' });
  const target = await content.document(result.path);
  assert.equal(target.metadata.path, `en/thread/${uuid}`);
  assert.equal(target.metadata.aliases, undefined);
  assert.equal(getValue(target.metadata, 'extra.comment_path'), `/notes/${legacy}/`);
});

test('two storage IDs cannot claim the same UUID route and stale migrations never overwrite content', async t => {
  const { repo, content } = await fixture(t);
  const path = await imported(repo), source = await content.document(path);
  await assert.rejects(content.saveDocument(`content/notes/${uuid}/index.md`, note(uuid), 'Collision', null), /公开路径已被/);
  await content.saveDocument(path, {}, 'Newer body', source.revision);
  await assert.rejects(content.saveDocument(path, {}, source.body, source.revision), /文件已更新/);
  assert.equal((await content.document(path)).body, 'Newer body');
});
