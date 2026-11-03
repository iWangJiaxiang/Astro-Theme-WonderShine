import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadSite } from '../src/lib/content';
import { feeds, renderFeed } from '../src/lib/feeds';
import { activeTimestamp, articles, descendants, events, internalReference, isPublic, threads, taxonomySlug, topicItems, topics } from '../src/lib/queries';
import { routes } from '../src/lib/routes';
import type { Document, Site } from '../src/lib/types';

const repository = path.resolve(import.meta.dirname, '../..');
function document(id: string, overrides: Partial<Document> = {}): Document {
  return { id, relativePath: `articles/${id}/index.md`, path: `/articles/${id}/`, url: `/articles/${id}/`,
    lang: 'zh-CN', title: id, description: `${id} summary`, date: '2020-01-01T00:00:00Z', draft: false,
    extra: { topics: ['topic'] }, taxonomies: { tags: ['Tech'] }, body: 'Body', html: '<p>Body</p>', toc: [], aliases: [], translations: [],
    kind: 'article', slug: id, weight: 0, render: true, transparent: false, paginateBy: 0, ancestors: [], frontmatter: {}, assets: [], wordCount: 1, readingTime: 1, ...overrides };
}
function fixture(documents: Document[] = [], sections: Document[] = []): Site {
  return { root: repository, config: { base_url: 'https://example.test', default_language: 'zh-CN', title: '中文 & Blog', description: '中文简介', author: 'A & B',
    generate_feeds: true, feed_filenames: ['atom.xml', 'rss.xml', 'threads.xml', 'timeline.xml'], taxonomies: [{ name: 'tags', feed: true, paginate_by: 2 }],
    languages: { en: { title: 'English', description: 'English summary', taxonomies: [{ name: 'tags', feed: true }] } },
    extra: { activity: { enable: true }, feed: { full_content_in_feed: false } } }, data: {}, localizedData: {}, documents, sections, languages: ['zh-CN', 'en'], defaultLanguage: 'zh-CN', assets: [] };
}

test('one visibility boundary excludes drafts, future dates, hidden pages and private ancestors', () => {
  const parent = document('private', { kind: 'section', relativePath: 'private/_index.md', draft: true });
  const publicArticle = document('public');
  const privateDocuments = [document('draft', { draft: true }), document('future', { date: '2999-01-01' }),
    document('hidden', { render: false }), document('child', { ancestors: [parent.relativePath] }), document('invalid', { date: 'bad-date' })];
  const site = fixture([publicArticle, ...privateDocuments], [parent]);
  assert.deepEqual(articles(site, 'zh-CN'), [publicArticle]);
  assert.deepEqual(events(site, 'zh-CN'), [publicArticle]);
  assert.ok(privateDocuments.every(doc => !isPublic(doc, site)));
  assert.ok(routes(site).every(route => !route.document || route.document === publicArticle));
  assert.ok(feeds(site).every(feed => feed.items.every(doc => doc === publicArticle)));
  for (const doc of privateDocuments) assert.equal(internalReference(site, doc.relativePath, 'zh-CN'), undefined);
  const root = document('root', { kind: 'section', relativePath: '_index.md', url: '/', path: '/' });
  assert.deepEqual(descendants(site, root), [publicArticle]);
});

test('activity visibility and topic membership respect language and publication state', () => {
  const topic = document('topic', { kind: 'topic', extra: { id: 'topic' }, taxonomies: {} });
  const article = document('article');
  const thread = document('thread', { kind: 'thread' });
  const english = document('english', { kind: 'thread', lang: 'en' });
  const site = fixture([topic, article, thread, english, document('future-thread', { kind: 'thread', date: '2999-01-01' })]);
  assert.deepEqual(topicItems(site, topic).map(doc => doc.id).sort(), ['article', 'thread']);
  assert.deepEqual(topics(site, 'zh-CN'), [topic]);
  site.config.extra.activity.enable = false;
  assert.deepEqual(threads(site, 'zh-CN'), []);
  assert.deepEqual(topics(site, 'zh-CN'), []);
  assert.deepEqual(topicItems(site, topic), []);
  assert.ok(routes(site).every(route => !route.document || route.document.kind === 'article'));
  assert.ok(feeds(site).every(feed => feed.items.every(doc => doc.kind === 'article')));
});

test('activity sorting accepts later published updates and ignores future or older updates', () => {
  const recent = document('recent', { kind: 'thread', date: '2021-01-01' });
  const updated = document('updated', { kind: 'thread', updated: '2022-01-01' });
  const futureUpdate = document('future-update', { kind: 'thread', updated: '2999-01-01' });
  assert.equal(activeTimestamp(document('older-update', { updated: '2019-01-01' })), Date.parse('2020-01-01') / 1000);
  const site = fixture([futureUpdate, recent, updated]);
  assert.deepEqual(threads(site, 'zh-CN').map(doc => doc.id), ['updated', 'recent', 'future-update']);
  assert.deepEqual(feeds(site).find(feed => feed.path === 'threads')!.items.map(doc => doc.id), ['updated', 'recent', 'future-update']);
  assert.equal(events(site, 'zh-CN')[0], recent);
});

test('internal article references resolve visible translations and reject unsupported paths', () => {
  const original = document('original');
  const translation = document('translation', { lang: 'en', relativePath: 'articles/original/index.en.md', url: '/en/articles/original/' });
  const chapter = document('chapter', { kind: 'page', relativePath: 'collections/column/chapter.md' });
  const album = document('album', { kind: 'page', relativePath: 'collections/album/song.md' });
  const site = fixture([original, translation, chapter, album]);
  assert.equal(internalReference(site, original.relativePath, 'en'), translation);
  assert.equal(internalReference(site, translation.relativePath, 'zh-CN'), original);
  translation.draft = true;
  assert.equal(internalReference(site, translation.relativePath, 'en'), original);
  assert.equal(internalReference(site, chapter.relativePath, 'en'), chapter);
  for (const source of [album.relativePath, 'articles/_index.md', 'articles/../secret.md', 'articles\\secret.md', 'https://other.test/article.md']) {
    assert.equal(internalReference(site, source, 'en'), undefined, source);
  }
});

test('routes preserve file aliases, custom pagination and nonempty localized taxonomies', () => {
  const site = fixture([document('one', { aliases: ['/old.html'] }), document('two'), document('three')]);
  site.config.taxonomies[0].paginate_path = 'p';
  const result = routes(site);
  assert.ok(result.some(route => route.path === '/old.html' && route.redirect === '/articles/one/'));
  assert.ok(result.some(route => route.path === '/tags/tech/p/2/'));
  assert.ok(result.some(route => route.path === '/tags/tech/p/1/' && route.redirect === '/tags/tech/'));
  assert.ok(!result.some(route => route.path === '/en/tags/'));
  assert.equal(taxonomySlug(site, '中文分类'), 'zhong-wen-fen-lei');
});

test('feeds include dated collection pages and preserve all taxonomy feed filenames', () => {
  const article = document('article');
  const chapter = document('chapter', { kind: 'page', relativePath: 'collections/column/chapter.md', taxonomies: { tags: ['Book'] } });
  const thread = document('thread', { kind: 'thread' });
  const site = fixture([article, chapter, thread, document('undated', { date: undefined, taxonomies: {} })]);
  const result = feeds(site);
  assert.deepEqual(result.find(feed => feed.path === 'atom')!.items.map(doc => doc.id), ['article', 'chapter']);
  assert.deepEqual(result.filter(feed => feed.path.startsWith('tags/book/')).map(feed => feed.kind).sort(), ['atom', 'rss', 'threads', 'timeline']);
  assert.deepEqual(result.find(feed => feed.path === 'tags/book/atom')!.items, [chapter]);
  assert.deepEqual(result.find(feed => feed.path === 'tags/book/threads')!.items, [thread]);
  assert.ok(result.find(feed => feed.path === 'tags/book/timeline')!.items.includes(article));
});

test('feed generation is opt-in, locale switches are honored and hidden sections can expose feeds', () => {
  const section = document('collection', { kind: 'section', relativePath: 'collections/_index.md', url: '/collections/', path: '/collections/', render: false, frontmatter: { generate_feeds: true } });
  const chapter = document('chapter', { kind: 'page', relativePath: 'collections/chapter.md', ancestors: [section.relativePath], taxonomies: {} });
  const site = fixture([chapter], [section]);
  delete site.config.generate_feeds;
  assert.deepEqual(feeds(site).map(feed => feed.path), ['collections/atom', 'collections/rss', 'collections/threads', 'collections/timeline']);
  site.config.generate_feeds = true;
  site.config.languages.en.generate_feeds = false;
  assert.ok(!feeds(site).some(feed => feed.path.startsWith('en/')));
  const root = document('home', { kind: 'section', relativePath: '_index.md', url: '/', path: '/', frontmatter: { generate_feeds: true } });
  site.sections.push(root);
  assert.equal(feeds(site).filter(feed => feed.path === 'atom').length, 1);
});

test('section feeds include transparent descendants without pulling in independent subsections', () => {
  const section = document('collection', { kind: 'section', relativePath: 'collections/_index.md', url: '/collections/', frontmatter: { generate_feeds: true } });
  const nested = document('nested', { kind: 'section', relativePath: 'collections/nested/_index.md', ancestors: [section.relativePath] });
  const chapter = document('chapter', { kind: 'page', relativePath: 'collections/nested/chapter.md', ancestors: [section.relativePath, nested.relativePath] });
  const site = fixture([chapter], [section, nested]);
  assert.deepEqual(feeds(site).find(feed => feed.path === 'collections/atom')!.items, []);
  nested.transparent = true;
  assert.deepEqual(feeds(site).find(feed => feed.path === 'collections/atom')!.items, [chapter]);
});

test('feed rendering respects locale, XML escaping, limits, authors and full-content preference', () => {
  const site = fixture([document('A < B', { title: 'A < B', description: 'One & two', html: '<p>Complete body</p>', frontmatter: { authors: ['Writer & Editor'] } }), document('second')]);
  site.config.feed_limit = 1;
  const atom = feeds(site).find(feed => feed.path === 'atom')!;
  const rendered = renderFeed(site, atom);
  assert.equal((rendered.match(/<entry>/g) || []).length, 1);
  assert.match(rendered, /<title>A &lt; B<\/title>/);
  assert.match(rendered, /<name>Writer &amp; Editor<\/name>/);
  assert.match(rendered, /One &amp; two/);
  assert.doesNotMatch(rendered, /<content /);
  site.config.extra.feed.full_content_in_feed = true;
  assert.match(renderFeed(site, atom), /&lt;p&gt;Complete body&lt;\/p&gt;/);
  const english = renderFeed(site, feeds(site).find(feed => feed.path === 'en/atom')!);
  assert.match(english, /<title>English<\/title>/);
  assert.match(english, /<subtitle>English summary<\/subtitle>/);
  assert.match(english, /xml:lang="en"/);
});
