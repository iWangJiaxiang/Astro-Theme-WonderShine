import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArticleSummary } from '../shared/types.js';
import { newThread, newTopic, contentId, contentLabel, contentLanguage, localizedPath, translationDraft, topicOptions, unclassifiedContentErrors } from '../src/content-model.js';
const thread: ArticleSummary = { path: 'content/threads/n_one/index.md', title: '', date: '2026-10-25T12:30:00+08:00', draft: false, kind: 'thread', tags: [], categories: [], id: 'n_one', lang: 'zh' };
const topic: ArticleSummary = { ...thread, kind: 'topic', id: 't_one', path: 'content/topics/t_one/index.md', title: '长期写作' };

test('independent threads need no title or thread relationships and default to draft', () => {
  assert.match(contentId('thread'), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.match(contentId('topic'), /^t_[a-f0-9]{32}$/);
  const draft = newThread('en', 'zh', 'n_test', '2026-10-25T05:00:00Z');
  assert.equal(draft.path, 'content/threads/n_test/index.en.md');
  assert.deepEqual(draft.initial, { draft: true, date: '2026-10-25T05:00:00Z', 'extra.kind': 'thread', 'extra.id': 'n_test' });
  assert.equal(contentLanguage(draft.path, 'zh'), 'en');
  assert.equal(contentLanguage(localizedPath('thread', 'n_test', 'zh', 'zh'), 'zh'), 'zh');
});

test('topics create native localized pages while leaving timestamps to the backend', () => {
  const draft = newTopic('zh', 'zh', 't_test');
  assert.equal(draft.path, 'content/topics/t_test/index.md');
  assert.deepEqual(draft.initial, { draft: true, 'extra.kind': 'topic', 'extra.id': 't_test', layout: 'topic' });
  assert.equal(Object.hasOwn(draft.initial, 'date'), false); assert.equal(Object.hasOwn(draft.initial, 'updated'), false);
});

test('thread translation keeps original identity, timestamp, topics and Markdown without obsolete chain metadata', () => {
  const draft = translationDraft(thread, 'en', 'zh', { title: '思考', taxonomies: { tags: ['web'] }, extra: { topics: ['t_one'], thread_root: 'obsolete', reply_to: 'obsolete' } }, '原文\n\n{{ image(src="x.png") }}');
  assert.equal(draft.path, 'content/threads/n_one/index.en.md');
  assert.equal(draft.initial.date, thread.date); assert.equal(draft.initial['extra.id'], 'n_one');
  assert.equal(draft.initial.draft, true); assert.deepEqual(draft.initial['extra.topics'], ['t_one']);
  assert.deepEqual(draft.initial['taxonomies.tags'], ['web']);
  assert.equal(draft.initial['extra.thread_root'], undefined); assert.equal(draft.initial['extra.reply_to'], undefined);
  assert.equal(draft.initialBody, '原文\n\n{{ image(src="x.png") }}');
  assert.throws(() => translationDraft({ ...thread, id: undefined }, 'en', 'zh', {}, ''));
});

test('topic translations copy editable metadata and preserve creation date but never inherit updated', () => {
  const draft = translationDraft(topic, 'en', 'zh', { title: '长期写作', description: '介绍', updated: '2026-10-27T00:00:00Z', extra: { cover: 'cover.png' } }, 'Topic introduction');
  assert.equal(draft.path, 'content/topics/t_one/index.en.md');
  assert.equal(draft.initial.layout, 'topic'); assert.equal(draft.initial['extra.kind'], 'topic');
  assert.equal(draft.initial.date, topic.date); assert.equal(draft.initial.updated, undefined);
  assert.equal(draft.initial.description, '介绍'); assert.equal(draft.initial['extra.cover'], 'cover.png');
});

test('topic choices deduplicate stable IDs, prefer the content locale and keep draft/untranslated options', () => {
  const translated = { ...topic, path: 'content/topics/t_one/index.en.md', title: 'Writing', lang: 'en', draft: true };
  const second = { ...topic, id: 't_two', title: '第二话题' };
  const options = topicOptions([topic, translated, thread, second, { ...topic, id: 't_invalid', error: 'broken' }], 'en');
  assert.deepEqual(options.map(item => item.id), ['t_one', 't_two']);
  assert.equal(options[0].title, 'Writing'); assert.equal(options[0].draft, true);
  assert.equal(options[1].lang, 'zh');
});

test('unclassifiable content errors stay reachable independently of language and publication filters', () => {
  const malformed = { ...thread, path: 'content/threads/broken/unknown.md', lang: undefined, error: 'Invalid document', draft: false };
  const unknownDraft = { ...malformed, path: 'content/threads/broken/draft.md', draft: true };
  const brokenTopic = { ...topic, lang: undefined, error: 'Invalid topic' };
  const items: ArticleSummary[] = [thread, malformed, unknownDraft, brokenTopic, { ...malformed, kind: 'article' }, { ...thread, lang: undefined }];
  assert.deepEqual(unclassifiedContentErrors(items, 'thread').map(item => item.path), [malformed.path, unknownDraft.path]);
  assert.deepEqual(unclassifiedContentErrors(items, 'topic'), [brokenTopic]);
});

test('body labels remain readable without requiring a title', () => {
  assert.equal(contentLabel('# **Hello**\nOther text'), 'Hello');
  assert.equal(contentLabel('![image](a.png)\nBody'), 'Body');
});
