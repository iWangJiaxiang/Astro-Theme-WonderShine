import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRepository } from '../server/repository.js';
import { ContentService } from '../server/content-service.js';
import { TranslationService } from '../server/translation.js';
import { contentLink } from '../shared/content-links.js';
import { collectionChoices } from '../shared/choices.js';
import { isLibraryItem, parentSection, sectionTrail } from '../shared/library.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'studio-content-locales-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  await writeFile(join(root, 'config.toml'), 'default_language="zh"\ntaxonomies=[{name="tags"},{name="categories"}]\n[slugify]\npaths="safe"\n[languages.en]\ntaxonomies=[{name="tags"}]\n');
  const repo = new LocalRepository(root);
  return { repo, content: new ContentService(repo), translations: new TranslationService(repo) };
}
const thread = { 'extra.kind': 'thread', 'extra.id': 'n_one', draft: true };

test('manual translations preserve full source metadata and create translated ancestor scaffolds in one batch', async t => {
  const { repo, content, translations } = await fixture(t);
  await repo.write('content/_index.md', '+++\ntitle="Home"\n+++\nHome body', null);
  await repo.write('content/articles/_index.md', '+++\ntitle="Articles"\nsort_by="date"\nchild_layout="post"\npaginate_by=12\n+++\nOriginal section', null);
  const path = 'content/articles/my.story.md';
  await repo.write(path, '+++\ntitle="Story"\ndate=2020-01-01\npath="custom"\naliases=["old"]\nupdated=2020-01-02\n[taxonomies]\ntags=["keep"]\ncategories=["omit"]\n[extra]\ncustom={nested=[1,2]}\n+++\nOriginal body', null);
  const source = await content.document(path);
  const result = await translations.createManual({ path, revision: source.revision, language: 'en' });
  const translated = await content.document(result.path);
  assert.equal(result.path, 'content/articles/my.story.en.md');
  assert.equal(translated.body, source.body);
  assert.equal(translated.metadata.draft, true);
  assert.deepEqual(translated.metadata.extra, { custom: { nested: [1, 2] } });
  assert.deepEqual(translated.metadata.taxonomies, { tags: ['keep'] });
  for (const key of ['path', 'aliases', 'updated']) assert.equal(translated.metadata[key], undefined);
  assert.match((await repo.read('content/articles/_index.en.md'))!.text, /paginate_by=12/);
  assert.doesNotMatch((await repo.read('content/articles/_index.en.md'))!.text, /Original section/);
  assert.ok(await repo.read('content/_index.en.md'));
  const items = (await content.list()).filter(item => item.path.includes('my.story'));
  assert.deepEqual(items.map(item => item.lang).sort(), ['en', 'zh']);
  assert.ok(items.every(item => item.translationKey === path && item.availableLanguages?.join(',') === 'en,zh'));
  assert.equal(items.find(item => item.lang === 'en')?.publicPath, '/en/articles/my.story/');
  await assert.rejects(translations.createManual({ path, revision: source.revision, language: 'en' }), /译文已存在/);
});

test('all content kinds support English-first creation, translated sections and canonical links', async t => {
  const { repo, content, translations } = await fixture(t);
  await repo.write('content/collections/_index.md', '+++\ntitle="Collections"\n+++\n', null);
  for (const path of ['content/articles/only.en.md', 'content/pages/about.en.md', 'content/collections/book/_index.en.md']) {
    await content.saveDocument(path, { title: 'English first' }, 'English content', null);
    const source = await content.document(path);
    assert.equal((source.metadata.taxonomies as Record<string, unknown> | undefined)?.categories, undefined);
    await assert.rejects(content.saveDocument(path, { 'taxonomies.categories': ['unsupported'] }, source.body, source.revision), /分类.*未配置/);
    const result = await translations.createManual({ path, revision: source.revision, language: 'zh' });
    assert.ok(result.path.endsWith('.md') && !result.path.endsWith('.en.md'));
    assert.equal((await content.document(result.path)).metadata.draft, true);
  }
  const items = await content.list();
  assert.equal(isLibraryItem(items.find(item => item.path === 'content/collections/_index.en.md')!), false);
  assert.deepEqual(collectionChoices(items, false, 'en').map(item => item.value), ['book']);
  const book = items.find(item => item.path === 'content/collections/book/_index.en.md')!;
  assert.equal(parentSection(book, items), 'content/collections/_index.en.md');
  assert.deepEqual(sectionTrail(book.path, items).map(item => item.path), [book.path]);
  const config = { default_language: 'zh', languages: { en: {} }, slugify: { paths: 'safe' } };
  assert.equal(contentLink('content/pages/about.en.md', {}, config).publicPath, '/en/pages/about/');
  assert.equal(contentLink('content/pages/about.en.md', { path: 'about-custom' }, config).publicPath, '/about-custom/');
  assert.equal(contentLink('content/collections/book/_index.en.md', {}, config).publicPath, '/en/collections/book/');
});

test('failed validation and stale batches leave no translated sections or content behind', async t => {
  const { repo, content } = await fixture(t);
  await repo.write('content/threads/_index.md', '+++\ntitle="Threads"\n+++\n', null);
  await assert.rejects(content.saveDocument('content/threads/n_one/index.en.md', { ...thread, 'extra.references': [{ kind: 'internal', path: 'articles/missing.md' }] }, 'Missing reference', null));
  assert.equal(await repo.read('content/threads/_index.en.md'), null);
  assert.equal(await repo.read('content/threads/n_one/index.en.md'), null);
  await repo.write('content/pages/existing.md', 'Original', null);
  await assert.rejects(repo.writeBatch([
    { path: 'content/pages/new.md', text: 'New', expectedRevision: null },
    { path: 'content/pages/existing.md', text: 'Changed', expectedRevision: null },
  ]), /已更新/);
  assert.equal(await repo.read('content/pages/new.md'), null);
  assert.equal((await repo.read('content/pages/existing.md'))?.text, 'Original');
});

test('article references resolve logical identities, survive translation, reject unsafe data and protect last translations', async t => {
  const { content, translations } = await fixture(t);
  const article = 'content/articles/first/index.en.md', threadPath = 'content/threads/n_one/index.md';
  await content.saveDocument(article, { title: 'English-only article' }, 'Text', null);
  const refs = [{ kind: 'internal', path: 'articles/first/index.md' }, { kind: 'external', url: 'https://example.com/article', title: 'External article' }];
  await content.saveDocument(threadPath, { ...thread, 'extra.references': refs }, 'Referenced', null);
  const source = await content.document(threadPath);
  const result = await translations.createManual({ path: threadPath, revision: source.revision, language: 'en' });
  assert.deepEqual((await content.document(result.path)).metadata.extra, { ...source.metadata.extra as object });
  for (const references of [
    [{ kind: 'internal', path: 'articles/first/index.en.md' }],
    [{ kind: 'internal', path: 'articles/../secret.md' }],
    [{ kind: 'external', url: 'javascript:alert(1)', title: '' }],
    [{ kind: 'external', url: 'https://user:pass@example.com', title: '' }],
    [refs[0], refs[0]], Array.from({ length: 13 }, (_, index) => ({ kind: 'external', url: `https://example.com/${index}`, title: '' })),
  ]) await assert.rejects(content.saveDocument(threadPath, { 'extra.references': references }, 'Unsafe', source.revision));
  const articleSource = await content.document(article);
  await assert.rejects(content.removeDocument(article, articleSource.revision), /仍被.*引用/);
  const second = await translations.createManual({ path: article, revision: articleSource.revision, language: 'zh' });
  await content.removeDocument(article, articleSource.revision);
  const last = await content.document(second.path);
  await assert.rejects(content.removeDocument(last.path, last.revision), /最后一个语言版本/);
});

test('concurrent article deletion and reference creation never leave dangling references', async t => {
  const { content, repo } = await fixture(t);
  const article = 'content/articles/race.md';
  await content.saveDocument(article, { title: 'Racing article' }, 'Text', null);
  const source = await content.document(article);
  const outcomes = await Promise.allSettled([
    content.removeDocument(article, source.revision),
    content.saveDocument('content/threads/n_one/index.md', { ...thread, 'extra.references': [{ kind: 'internal', path: 'articles/race.md' }] }, 'Reference', null),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(!await repo.read('content/threads/n_one/index.md') || await repo.read(article));
});
test('threads reject empty submissions but allow title-only and reference-only content', async t => {
  const { content, repo } = await fixture(t);
  const path = 'content/threads/n_one/index.md';
  await assert.rejects(content.saveDocument(path, thread, '  \n', null), /正文、标题或引用文章/);
  assert.equal(await repo.read(path), null);
  await content.saveDocument(path, { ...thread, title: 'A short thought' }, '', null);
  const source = await content.document(path);
  await content.saveDocument(path, { title: '', 'extra.references': [{ kind: 'external', url: 'https://example.com/story', title: 'Story' }] }, '', source.revision);
  assert.equal((await content.document(path)).body, '');
});
test('series chapters can be referenced across languages while album tracks and grouping sections cannot', async t => {
  const { content, repo } = await fixture(t);
  await repo.write('content/collections/column/series/_index.md', '+++\ntitle="Series"\n+++\n', null);
  await repo.write('content/collections/column/series/chapter.en.md', '+++\ntitle="Chapter"\n+++\nText', null);
  await repo.write('content/collections/album/song.md', '+++\ntitle="Track"\n+++\n', null);
  const path = 'content/threads/n_one/index.md';
  await content.saveDocument(path, { ...thread, 'extra.references': [{ kind: 'internal', path: 'collections/column/series/chapter.md' }] }, '', null);
  const saved = await content.document(path);
  for (const target of ['collections/column/series/_index.md', 'collections/album/song.md']) await assert.rejects(content.saveDocument(path, { 'extra.references': [{ kind: 'internal', path: target }] }, '', saved.revision));
  const chapter = await content.document('content/collections/column/series/chapter.en.md');
  await assert.rejects(content.removeDocument(chapter.path, chapter.revision), /引用/);
});
