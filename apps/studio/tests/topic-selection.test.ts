import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArticleSummary } from '../shared/types.js';
import { createOrFindTopic, topicName, topicNameKey } from '../src/topic-selection.js';

const languages = async () => ({ defaultLanguage: 'zh-CN', languages: ['zh-CN', 'en'] });
const topic = (title: string, lang = 'zh-CN', id = 't_existing'): ArticleSummary => ({
  path: `content/topics/${id}/index${lang === 'zh-CN' ? '' : `.${lang}`}.md`, title, lang, id,
  kind: 'topic', draft: true, date: '', tags: [], categories: [],
});

test('quick creation saves a topic draft in the content language without saving the parent document', async () => {
  const writes: unknown[] = [];
  const result = await createOrFindTopic('  Long   writing  ', 'en', { languages, list: async () => [], save: async input => { writes.push(input); } });
  assert.equal(result.created, true);
  assert.match(result.item.path, /^content\/topics\/t_[a-f0-9]+\/index.en.md$/);
  assert.equal(result.item.title, 'Long writing');
  assert.equal(result.item.lang, 'en');
  assert.equal(result.item.draft, true);
  assert.deepEqual(writes, [{ path: result.item.path, changes: { draft: true, 'extra.kind': 'topic', 'extra.id': result.item.id, layout: 'topic', title: 'Long writing' }, body: '', revision: null }]);
  assert.deepEqual(result.items, [result.item]);
});

test('matching titles reuse stable IDs across translations and prefer the content language', async () => {
  const original = topic('长期写作'), translated = topic('Long Writing', 'en');
  const result = await createOrFindTopic(' 长期写作 ', 'en', { languages, list: async () => [original, translated], save: async () => assert.fail('must reuse existing topic') });
  assert.equal(result.item, translated);
  assert.equal(result.created, false);
  const normalized = await createOrFindTopic('ｌｏｎｇ　ｗｒｉｔｉｎｇ', 'en', { languages, list: async () => [original, translated], save: async () => assert.fail('must normalize existing title') });
  assert.equal(normalized.item.id, original.id);
  assert.equal(topicName(' a\n b '), 'a b');
  assert.equal(topicNameKey('  LONG Writing '), 'long writing');
});

test('empty, overlong and unconfigured-language names cannot create a topic', async () => {
  const gateway = { languages, list: async () => [], save: async () => assert.fail('must not save invalid input') };
  await assert.rejects(createOrFindTopic(' \n ', 'en', gateway), /请输入/);
  await assert.rejects(createOrFindTopic('a'.repeat(101), 'en', gateway), /100/);
  await assert.rejects(createOrFindTopic('Name', 'fr', gateway), /语言未配置/);
});

test('failed reads never save, and retrying a saved-but-lost response reuses the topic', async () => {
  await assert.rejects(createOrFindTopic('Name', 'en', { languages, list: async () => { throw new Error('offline'); }, save: async () => assert.fail('must not save') }), /offline/);
  const items: ArticleSummary[] = []; let saves = 0;
  const gateway = { languages, list: async () => [...items], save: async (input: { path: string; changes: Record<string, unknown> }) => {
    saves++; items.push({ ...topic(String(input.changes.title), 'en', String(input.changes['extra.id'])), path: input.path });
    throw new Error('response lost');
  } };
  await assert.rejects(createOrFindTopic('Name', 'en', gateway), /response lost/);
  const retry = await createOrFindTopic('Name', 'en', gateway);
  assert.equal(retry.created, false); assert.equal(retry.item.id, items[0].id); assert.equal(saves, 1);
});
