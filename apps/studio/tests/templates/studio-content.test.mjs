import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { LocalRepository } from '../../server/repository.ts';
import { ContentService } from '../../server/content-service.ts';
import { TranslationService } from '../../server/translation.ts';
import { loadSite } from '../../../../packages/theme/src/lib/content.ts';
import { localizeConfig, localizeData } from '../../../../packages/theme/src/lib/locale.ts';
import { internalReference, isPublic, topicItems, cover } from '../../../../packages/theme/src/lib/queries.ts';
import { routes } from '../../../../packages/theme/src/lib/routes.ts';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-astro-compatibility-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  await writeFile(path.join(root, 'config.toml'), `base_url="https://example.test"
default_language="zh-CN"
taxonomies=[{name="tags"},{name="categories"}]
[languages.en]
taxonomies=[{name="tags"},{name="categories"}]
[extra.activity]
enable=true
`);
  const repository = new LocalRepository(root), service = new ContentService(repository);
  for (const [directory, layout] of [['', 'index'], ['articles/', 'archives'], ['threads/', 'threads'], ['topics/', 'topics'], ['collections/', 'collection-list']]) {
    await repository.write(`content/${directory}_index.md`, `+++\ntitle="${layout}"\nlayout="${layout}"\n+++\n`, null);
  }
  return { root, repository, service, translations: new TranslationService(repository) };
}

const id = 'fecc309a-5b6a-4a9d-bcd0-01f833edfa33';
const article = 'content/articles/compatibility/index.md';
const thread = `content/threads/${id}/index.md`;

test('Studio writes multilingual content that Astro routes, links and filters consistently', async t => {
  const { root, repository, service, translations } = await fixture(t);
  await service.saveDocument(article, { title: '中文文章', description: '中文摘要', draft: false, date: '2020-01-01', 'extra.cover': 'cover.svg', 'taxonomies.tags': ['tech'] }, '![图片](cover.svg)', null);
  await mkdir(path.join(root, 'public/uploads'), { recursive: true });
  await writeFile(path.join(root, 'public/uploads/shared.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(root, 'content/articles/compatibility/cover.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const source = await service.document(article);
  const translated = await translations.createManual({ path: article, revision: source.revision, language: 'en' });
  const english = await service.document(translated.path);
  await service.saveDocument(translated.path, { title: 'English article', description: 'English description', draft: false }, english.body, english.revision);
  const topic = 'content/topics/t_compatibility/index.md';
  await service.saveDocument(topic, { title: '话题', draft: false, 'extra.kind': 'topic', 'extra.id': 't_compatibility', layout: 'topic' }, '话题介绍', null);
  const topicSource = await service.document(topic);
  const topicTranslation = await translations.createManual({ path: topic, revision: topicSource.revision, language: 'en' });
  const topicEnglish = await service.document(topicTranslation.path);
  await service.saveDocument(topicTranslation.path, { title: 'Topic', draft: false }, 'Topic description', topicEnglish.revision);
  await service.saveDocument(thread, { draft: false, date: '2020-01-01T00:00:00Z', 'extra.kind': 'thread', 'extra.id': id,
    'taxonomies.tags': ['tech'], 'extra.topics': ['t_compatibility'], 'extra.disable_comment': true,
    'extra.references': [{ kind: 'internal', path: article.slice(8) }, { kind: 'external', title: 'External article', url: 'https://example.org/article' }],
  }, '中文动态\n\n![公共图片](/uploads/shared.svg)', null);
  const originalThread = await service.document(thread);
  const translatedThread = await translations.createManual({ path: thread, revision: originalThread.revision, language: 'en' });
  const threadEnglish = await service.document(translatedThread.path);
  await service.saveDocument(translatedThread.path, { draft: false }, 'English thread', threadEnglish.revision);
  await service.saveDocument('content/articles/private/index.md', { title: 'Draft article', draft: true }, 'Private', null);
  await service.saveDocument('content/articles/future/index.md', { title: 'Future article', draft: false, date: '2999-01-01' }, 'Future', null);
  await service.saveDocument('content/collections/series/_index.md', { title: 'Series', draft: false, layout: 'collection-detail', child_layout: 'collection-content' }, 'Series introduction', null);
  await service.saveDocument('content/collections/series/chapter/index.md', { title: 'Chapter', draft: false, date: '2020-01-01' }, 'Chapter body', null);
  let site = await loadSite({ root });
  const available = routes(site);
  for (const item of await service.list()) {
    const doc = [...site.sections, ...site.documents].find(doc => `content/${doc.relativePath}` === item.path);
    if (doc && isPublic(doc, site)) assert.equal(item.publicPath, doc.url, item.path);
  }
  assert.ok(available.some(route => route.path === '/en/'));
  assert.ok(available.some(route => route.path === `/en/threads/${id}/`));
  assert.ok(available.some(route => route.path === '/en/tags/tech/'));
  assert.ok(!available.some(route => /\/(private|future)\//.test(route.path)));
  assert.equal(internalReference(site, article.slice(8), 'en')?.title, 'English article');
  const englishArticle = site.documents.find(doc => doc.relativePath === translated.path.slice(8));
  assert.equal(cover(englishArticle, site), '/en/articles/compatibility/cover.svg');
  assert.ok(site.assets.some(asset => asset.path === cover(englishArticle, site)));
  assert.match(englishArticle.html, /src="\/en\/articles\/compatibility\/cover.svg"/);
  const englishThread = site.documents.find(doc => doc.relativePath === translatedThread.path.slice(8));
  assert.equal(englishThread.extra.disable_comment, true);
  assert.equal(englishThread.extra.references.length, 2);
  const englishTopic = site.documents.find(doc => doc.relativePath === topicTranslation.path.slice(8));
  assert.ok(topicItems(site, englishTopic).some(doc => doc === englishThread));
  assert.equal(site.documents.find(doc => doc.title === 'Chapter')?.layout, 'collection-content');
  // Deleting one language preserves its sibling and reference fallback.
  await service.removeDocument(translated.path, (await service.document(translated.path)).revision);
  site = await loadSite({ root });
  assert.equal(internalReference(site, article.slice(8), 'en')?.title, '中文文章');
  assert.ok(!routes(site).some(route => route.path === '/en/articles/compatibility/'));
  await assert.rejects(service.removeDocument(article, source.revision), /引用/);
  await service.removeDocument(translatedThread.path, (await service.document(translatedThread.path)).revision);
  assert.ok(!routes(await loadSite({ root })).some(route => route.path === `/en/threads/${id}/`));
  assert.ok(await repository.read(thread));
});

test('Studio localized navigation and page settings use the Astro locale overlays', async t => {
  const { root, service } = await fixture(t);
  for (const [id, changes, language] of [
    ['navigation', { 'menu.nav_menu': [{ name: 'English menu', url: '/en/' }] }, 'en'],
    ['page-wechat', { 'extra.wechat.name': 'English author', 'extra.wechat.description': 'English introduction' }, 'en'],
    ['page-equipment-items', { 'equipment.groups': [{ title: 'English equipment', items: [] }] }, 'en'],
  ]) {
    const settings = await service.settings(id, language);
    await service.saveSettings(id, changes, settings.revision, language);
  }
  const site = await loadSite({ root });
  assert.equal(localizeConfig(site, 'en').extra.wechat.name, 'English author');
  assert.notEqual(localizeConfig(site, 'zh-CN').extra.wechat?.name, 'English author');
  assert.equal(localizeData(site, 'en').menu.nav_menu[0].name, 'English menu');
  assert.equal(localizeData(site, 'en').equipment.groups[0].title, 'English equipment');
});
