import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContentService } from '../server/content-service.js';
import { LocalRepository } from '../server/repository.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'studio-threads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.toml'), 'default_language="zh"\n[languages.en]\n');
  const repo = new LocalRepository(root);
  return { repo, content: new ContentService(repo) };
}
const thread = (id: string) => ({ 'extra.kind': 'thread', 'extra.id': id, date: '2026-10-25T10:30:00+08:00', draft: false });

test('untitled localized threads are editable and appear with language links', async t => {
  const { content } = await fixture(t);
  await content.saveDocument('content/threads/first/index.md', thread('first'), '今天读到一个想法。', null);
  await content.saveDocument('content/threads/first/index.en.md', thread('first'), 'An idea from today.', null);
  const items = await content.list();
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.kind === 'thread' && item.id === 'first'));
  assert.deepEqual(items[0].availableLanguages, ['en', 'zh']);
  assert.equal(items.find(item => item.lang === 'en')?.publicPath, '/en/threads/first/');
  assert.equal(items.find(item => item.lang === 'zh')?.title, '今天读到一个想法。');
  assert.deepEqual(await content.languages(), { defaultLanguage: 'zh', languages: ['zh', 'en'] });
  await assert.rejects(() => content.saveDocument('content/articles/first/index.md', {}, '', null), /标题/);
});

test('independent threads can change dates, translate and delete without chain dependencies', async t => {
  const { content, repo } = await fixture(t);
  await content.saveDocument('content/threads/first/index.md', thread('first'), 'First thread', null);
  await content.saveDocument('content/threads/second/index.md', { ...thread('second'), date: '2026-10-24T10:30:00+08:00' }, 'Independent thread', null);
  await content.saveDocument('content/threads/second/index.en.md', { ...thread('second'), date: '2026-10-26T10:30:00+08:00' }, 'Independent translation', null);
  const first = await content.document('content/threads/first/index.md');
  await content.removeDocument(first.path, first.revision);
  assert.equal(await repo.read(first.path), null);
  const second = await content.document('content/threads/second/index.md');
  await content.saveDocument(second.path, { date: '2026-10-23T10:30:00+08:00' }, second.body, second.revision);
  await assert.rejects(() => content.saveDocument('content/threads/second/index.fr.md', thread('second'), '', null), /语言未配置/);
  await assert.rejects(() => content.saveDocument('content/threads/second/index.zh.md', thread('second'), '', null), /默认语言/);
  await assert.rejects(() => content.saveDocument('content/threads/bad/index.md', { ...thread('bad'), date: '2026-10-25' }, '', null), /时区/);
  await assert.rejects(() => content.saveDocument('content/threads/wrong/index.md', thread('different'), '', null), /目录一致/);
});

test('editing legacy threads removes obsolete chain fields and retains unknown TOML and shortcodes', async t => {
  const { content, repo } = await fixture(t);
  const path = 'content/threads/legacy/index.md';
  const source = '+++\ndate="2026-10-25T10:30:00+08:00"\n[extra]\nkind="thread"\nid="legacy"\nthread_root="missing"\nreply_to="missing"\ncustom="preserve" # retained\n+++\nOriginal';
  const saved = await repo.write(path, source, null);
  await content.saveDocument(path, { title: '' }, '{{ card(title="example") }}', saved.revision);
  const result = await content.document(path);
  assert.ok(result.text.includes('custom="preserve" # retained'));
  assert.equal(result.body, '{{ card(title="example") }}');
  assert.equal(Object.hasOwn(result.metadata.extra as object, 'thread_root'), false);
  assert.equal(Object.hasOwn(result.metadata.extra as object, 'reply_to'), false);
});

test('translated threads reuse bundle images and sort by actual publication instant', async t => {
  const { content, repo } = await fixture(t);
  const { mediaValue, storedMediaPath } = await import('../shared/media.js');
  const { sortLibrary, isLibraryItem } = await import('../shared/library.js');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const uploaded = await repo.uploadMedia('content/threads/photo', 'image.png', png);
  assert.equal(mediaValue(uploaded.item, 'document', 'content/threads/photo/index.en.md'), 'image.png');
  assert.equal(storedMediaPath('image.png', 'document', 'content/threads/photo/index.en.md'), uploaded.item.path);
  await content.saveDocument('content/threads/earlier/index.md', { ...thread('earlier'), date: '2026-10-25T10:00:00+08:00' }, 'Earlier', null);
  await content.saveDocument('content/threads/later/index.md', { ...thread('later'), date: '2026-10-25T04:00:00Z' }, 'Later', null);
  assert.equal(sortLibrary(await content.list(), 'thread')[0].id, 'later');
  assert.equal(isLibraryItem({ path: 'content/threads/_index.en.md', kind: 'thread', title: '', date: '', draft: false, tags: [], categories: [] }), false);
});

test('thread translations only write taxonomies configured for the target language', async t => {
  const { content, repo } = await fixture(t);
  const config = (await repo.read('config.toml'))!;
  await repo.write('config.toml', 'default_language="zh"\ntaxonomies=[{name="tags"},{name="categories"}]\n[languages.en]\n[languages.fr]\ntaxonomies=[{name="tags"}]\n', config.revision);
  await content.saveDocument('content/threads/tagged/index.md', { ...thread('tagged'), 'taxonomies.tags': ['Research'], 'taxonomies.categories': ['Work'] }, 'Tagged root', null);
  await content.saveDocument('content/threads/tagged/index.en.md', { ...thread('tagged'), 'taxonomies.tags': ['Research'], 'taxonomies.categories': ['Work'] }, 'Translation without inherited taxonomy', null);
  const english = await content.document('content/threads/tagged/index.en.md');
  assert.deepEqual(english.metadata.taxonomies ?? {}, {});
  await content.saveDocument('content/threads/tagged/index.fr.md', { ...thread('tagged'), 'taxonomies.tags': ['Recherche'], 'taxonomies.categories': ['Work'] }, 'Translation with configured tags', null);
  assert.deepEqual((await content.document('content/threads/tagged/index.fr.md')).metadata.taxonomies, { tags: ['Recherche'] });
  await assert.rejects(() => content.saveDocument(english.path, { 'taxonomies.tags': ['New unsupported tag'] }, english.body, english.revision), /未配置/);
  await content.saveDocument('content/threads/empty/index.en.md', { ...thread('empty'), 'taxonomies.tags': [], 'taxonomies.categories': [] }, 'Empty tags omitted', null);
  assert.deepEqual((await content.document('content/threads/empty/index.en.md')).metadata.taxonomies ?? {}, {});
});

test('saving old threads removes unsupported empty taxonomy fields without losing other metadata', async t => {
  const { content, repo } = await fixture(t);
  const headers = [
    'taxonomies.tags=[] # taxonomy comment\ntaxonomies.categories=[]\nextra.custom="keep"\n',
    '[taxonomies]\ntags=[] # taxonomy comment\ncategories=[]\n[extra]\ncustom="keep"\n',
    'taxonomies={tags=[], categories=[]}\nextra.custom="keep"\n',
  ];
  for (const [index, header] of headers.entries()) {
    const id = `legacy-${index}`, path = `content/threads/${id}/index.en.md`;
    const structural = header.includes('[extra]') ? `kind="thread"\nid="${id}"\n` : `extra.kind="thread"\nextra.id="${id}"\n`;
    const source = `+++\ndate="2026-10-25T10:30:00+08:00"\n${header}${structural}+++\nLegacy body`;
    const saved = await repo.write(path, source, null);
    await content.saveDocument(path, {}, 'Updated', saved.revision);
    const updated = await content.document(path);
    assert.deepEqual(updated.metadata.taxonomies ?? {}, {});
    assert.equal((updated.metadata.extra as Record<string, unknown>).custom, 'keep');
    if (header.includes('# taxonomy comment')) assert.ok(updated.text.includes('# taxonomy comment'));
  }
});

test('malformed threads stay visible while other independent threads remain editable', async t => {
  const { content, repo } = await fixture(t);
  const path = 'content/threads/broken/index.en.md';
  await repo.write(path, '+++\ninvalid TOML\n+++\nBroken', null);
  const broken = (await content.list()).find(item => item.path === path)!;
  assert.equal(broken.lang, 'en');
  assert.ok(broken.error);
  await content.saveDocument('content/threads/valid/index.md', thread('valid'), 'Valid', null);
  const brokenFile = (await repo.read(path))!;
  await assert.rejects(() => content.saveDocument(path, {}, 'Repair attempt', brokenFile.revision), (error: unknown) => {
    assert.equal((error as { params: { path: string } }).params.path, path);
    return true;
  });
});

test('thread saves reject layout and route overrides in both new and existing frontmatter', async t => {
  const { content, repo } = await fixture(t);
  await assert.rejects(() => content.saveDocument('content/threads/layout/index.md', { ...thread('layout'), layout: 'post' }, 'Hidden through another layout', null), /threads/);
  await assert.rejects(() => content.saveDocument('content/threads/path/index.md', { ...thread('path'), path: 'elsewhere' }, 'Hidden through another route', null), /公开路径/);
  assert.equal(await repo.read('content/threads/layout/index.md'), null);
  assert.equal(await repo.read('content/threads/path/index.md'), null);
  const { updateDocument } = await import('../server/content.js');
  const cases: [string, unknown, RegExp][] = [
    ['layout', 'post', /threads/], ['layout', false, /threads/],
    ['path', '/elsewhere/', /公开路径/], ['path', false, /公开路径/],
    ['slug', 'elsewhere', /slug/], ['slug', 7, /slug/],
  ];
  for (const [index, [field, value, message]] of cases.entries()) {
    const id = `override-${index}`, path = `content/threads/${id}/index.md`;
    await content.saveDocument(path, thread(id), 'Original', null);
    const original = (await repo.read(path))!;
    const imported = updateDocument(original.text, { [field]: value, 'extra.unknown': 'preserve' }, 'Imported');
    const saved = await repo.write(path, imported, original.revision);
    await assert.rejects(() => content.saveDocument(path, {}, 'Updated body', saved.revision), error => {
      assert.match((error as Error).message, message);
      assert.equal((error as { params: { path: string } }).params.path, path);
      return true;
    });
    assert.equal((await repo.read(path))!.text, imported);
    await repo.write(path, original.text, saved.revision);
  }
});

test('fixed thread templates and matching slugs preserve unrelated TOML through edits', async t => {
  const { content, repo } = await fixture(t);
  const { updateDocument } = await import('../server/content.js');
  for (const [index, overrides] of [
    { layout: '', path: '', slug: '' },
    { layout: 'thread', slug: 'allowed-1' },
  ].entries()) {
    const id = `allowed-${index}`, path = `content/threads/${id}/index.md`;
    await content.saveDocument(path, thread(id), 'Original', null);
    const original = (await repo.read(path))!;
    const source = updateDocument(original.text, { ...overrides, 'extra.custom': 'preserve me' }, 'Original');
    const saved = await repo.write(path, source, original.revision);
    await content.saveDocument(path, {}, 'Updated', saved.revision);
    const result = await content.document(path);
    assert.equal((result.metadata.extra as Record<string, unknown>).custom, 'preserve me');
    assert.equal(result.metadata.slug, overrides.slug);
    assert.equal(result.body, 'Updated');
  }
});
