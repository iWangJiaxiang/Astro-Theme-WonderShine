import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArticleSummary } from '../shared/types.js';
import { noteReferences, publicContentUrl, metadataValue, isPublishedContent, previewLink } from '../src/note-detail.js';

const original: ArticleSummary = { path: 'content/articles/example/index.md', translationKey: 'content/articles/example/index.md', title: '原文', kind: 'article', lang: 'zh-CN', draft: false, date: '2020-01-01', tags: [], categories: [] };

test('Markdown preview resolves native content links and disables missing or private targets', () => {
  const article = { ...original, publicPath: '/articles/example/' };
  const resolve = (href: string, items = [article]) => previewLink(href, items, '/thread/123/', 'https://example.com');
  assert.equal(resolve('@/articles/example/index.md#section'), 'https://example.com/articles/example/#section');
  assert.equal(resolve('@/articles/missing.md'), undefined);
  assert.equal(resolve('@/articles/example/index.md', [{ ...article, draft: true }]), undefined);
  assert.equal(resolve('javascript:alert(1)'), undefined);
  assert.equal(resolve('#section'), '#section');
  assert.equal(resolve('/about/'), 'https://example.com/about/');
  const chinese = { ...article, path: 'content/articles/测试/index.md' };
  assert.equal(resolve('@/articles/%E6%B5%8B%E8%AF%95/index.md#%E8%AF%B4%E6%98%8E', [chinese]), 'https://example.com/articles/example/#%E8%AF%B4%E6%98%8E');
  assert.equal(resolve('@/articles/%ZZ/index.md'), undefined);
  const page: ArticleSummary = { ...article, kind: 'page', date: '', path: 'content/pages/about.md', publicPath: '/about/' };
  assert.equal(previewLink('@/pages/about.md', [page], '/thread/123/', 'https://example.com'), 'https://example.com/about/');
  assert.equal(isPublishedContent({ ...page, date: 'invalid' }), false);
});

test('detail references choose the current language without hiding draft status from the author', () => {
  const english = { ...original, path: 'content/articles/example/index.en.md', title: 'English draft', lang: 'en', draft: true };
  const refs = noteReferences([{ kind: 'internal', path: 'articles/example/index.md' }], [original, english], 'en', 'zh-CN');
  assert.equal(refs[0].path, english.path);
  assert.equal(refs[0].title, english.title);
  assert.equal(refs[0].draft, true);
  assert.equal(noteReferences([{ kind: 'internal', path: 'articles/example/index.md' }], [original], 'en', 'zh-CN')[0].language, 'zh-CN');
});

test('detail references preserve missing references and never produce unsafe external links', () => {
  const refs = noteReferences([{ kind: 'internal', path: 'articles/missing.md' }, { kind: 'external', url: 'javascript:alert(1)', title: 'Unsafe' }, { kind: 'external', url: 'https://example.com/story', title: 'Story' }], [], 'en', 'zh-CN');
  assert.equal(refs[0].missing, true);
  assert.equal(refs[1].href, undefined);
  assert.equal(refs[2].href, 'https://example.com/story');
  assert.deepEqual(noteReferences([null, 'bad', { kind: 'internal' }], [], 'en', 'zh-CN'), []);
});

test('public links stay on the configured site and draft/future content is not presented as public', () => {
  assert.equal(publicContentUrl('/en/thread/123/', 'https://blog.example.com'), 'https://blog.example.com/en/thread/123/');
  for (const path of ['//evil.example', 'https://evil.example', '/\\evil.example']) assert.equal(publicContentUrl(path, 'https://blog.example.com'), undefined);
  assert.equal(publicContentUrl('/thread/123/', 'javascript:alert(1)'), undefined);
  assert.equal(isPublishedContent(original, Date.parse('2026-01-01')), true);
  assert.equal(isPublishedContent({ ...original, draft: true }), false);
  assert.equal(isPublishedContent({ ...original, date: '2999-01-01' }), false);
  assert.equal(isPublishedContent({ ...original, render: false }), false);
  assert.deepEqual(metadataValue({ extra: { topics: ['one'] } }, 'extra.topics'), ['one']);
});
