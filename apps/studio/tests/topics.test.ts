import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContentService } from '../server/content-service.js';
import { LocalRepository } from '../server/repository.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'studio-topics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.toml'), 'default_language="zh"\n[languages.en]\n');
  const repo = new LocalRepository(root);
  let now = new Date('2026-10-27T01:00:00Z');
  return { repo, content: new ContentService(repo, () => now), setNow: (value: string) => { now = new Date(value); } };
}
const topic = (id: string) => ({ title: `Topic ${id}`, 'extra.kind': 'topic', 'extra.id': id, layout: 'topic' });

test('localized topics share a stable identity and creation date while Studio maintains update time', async t => {
  const { content, setNow } = await fixture(t);
  const path = 'content/topics/research/index.md';
  await content.saveDocument(path, topic('research'), 'Introduction', null);
  const created = await content.document(path);
  assert.equal(created.metadata.date, '2026-10-27T01:00:00.000Z');
  assert.equal(created.metadata.updated, '2026-10-27T01:00:00.000Z');
  assert.equal(created.metadata.taxonomies, undefined);
  setNow('2026-10-27T02:00:00Z');
  await content.saveDocument(path, { description: 'Updated description', date: '2000-01-01', updated: '2000-01-01' }, 'Updated body', created.revision);
  const edited = await content.document(path);
  assert.equal(edited.metadata.date, created.metadata.date);
  assert.equal(edited.metadata.updated, '2026-10-27T02:00:00.000Z');
  setNow('2026-10-27T03:00:00Z');
  await content.saveDocument('content/topics/research/index.en.md', { ...topic('research'), title: 'Research' }, 'English introduction', null);
  const translation = await content.document('content/topics/research/index.en.md');
  assert.equal(translation.metadata.date, created.metadata.date);
  assert.equal(translation.metadata.updated, '2026-10-27T03:00:00.000Z');
  const items = (await content.list()).filter(item => item.kind === 'topic');
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.id === 'research' && item.draft));
  assert.deepEqual(items[0].availableLanguages, ['en', 'zh']);
  assert.equal(items.find(item => item.lang === 'en')?.publicPath, '/en/topics/research/');
  assert.equal(items.find(item => item.lang === 'zh')?.updated, '2026-10-27T02:00:00.000Z');
});

test('articles and independent threads associate with stable topic IDs across drafts and missing translations', async t => {
  const { content, repo } = await fixture(t);
  await content.saveDocument('content/topics/research/index.md', topic('research'), 'Draft topic', null);
  const threadPath = 'content/threads/english/index.en.md';
  await content.saveDocument(threadPath, { 'extra.kind': 'thread', 'extra.id': 'english', 'extra.topics': ['research'], draft: false }, 'English thread linked to an untranslated draft topic', null);
  await content.saveDocument('content/articles/article/index.md', { title: 'Article', 'extra.topics': ['research'] }, 'Article', null);
  const items = await content.list();
  assert.deepEqual(items.find(item => item.path === threadPath)?.topics, ['research']);
  assert.deepEqual(items.find(item => item.kind === 'article')?.topics, ['research']);
  await assert.rejects(() => content.saveDocument('content/articles/invalid/index.md', { title: 'Invalid', 'extra.topics': ['missing'] }, '', null), /关联话题.*不存在/);
  assert.equal(await repo.read('content/articles/invalid/index.md'), null);
  const thread = await content.document(threadPath);
  for (const value of [['research', 'research'], [17], ['../research'], [{ id: 'research' }]]) {
    await assert.rejects(() => content.saveDocument(thread.path, { 'extra.topics': value }, thread.body, thread.revision), /话题关联/);
  }
  assert.equal((await content.document(threadPath)).revision, thread.revision);
});

test('only the last topic translation is protected by associations and stale revisions never delete it', async t => {
  const { content, repo } = await fixture(t);
  const path = 'content/topics/linked/index.md', translatedPath = 'content/topics/linked/index.en.md';
  await content.saveDocument(path, topic('linked'), '', null);
  await content.saveDocument(translatedPath, topic('linked'), '', null);
  const articlePath = 'content/articles/linked/index.md';
  await content.saveDocument(articlePath, { title: 'Associated article', 'extra.topics': ['linked'] }, '', null);
  const translation = await content.document(translatedPath);
  await content.removeDocument(translatedPath, translation.revision);
  const original = await content.document(path);
  await assert.rejects(() => content.removeDocument(path, original.revision), /仍被内容关联/);
  assert.equal((await content.document(path)).revision, original.revision);
  const article = await content.document(articlePath);
  await content.saveDocument(articlePath, { 'extra.topics': [] }, '', article.revision);
  await content.saveDocument(path, { title: 'Renamed title, same ID' }, '', original.revision);
  await assert.rejects(() => content.removeDocument(path, original.revision), /文件已更新/);
  const renamed = await content.document(path);
  await content.removeDocument(path, renamed.revision);
  assert.equal(await repo.read(path), null);
});

test('concurrent topic deletion and association creation cannot leave a dangling topic ID', async t => {
  const { content, repo } = await fixture(t);
  const topicPath = 'content/topics/race/index.md', articlePath = 'content/articles/race/index.md';
  await content.saveDocument(topicPath, topic('race'), '', null);
  const original = await content.document(topicPath);
  const results = await Promise.allSettled([
    content.removeDocument(topicPath, original.revision),
    content.saveDocument(articlePath, { title: 'Racing association', 'extra.topics': ['race'] }, '', null),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const article = await repo.read(articlePath), remainingTopic = await repo.read(topicPath);
  assert.ok(!article || remainingTopic);
});

test('topic identity and routing stay fixed, while unknown metadata and translated bundle images survive edits', async t => {
  const { content, repo, setNow } = await fixture(t);
  for (const [id, changes, message] of [
    ['empty', { title: ' ' }, /话题标题/],
    ['bad-kind', { 'extra.kind': 'thread' }, /kind.*topic/],
    ['bad-id', { 'extra.id': 'different' }, /目录一致/],
    ['bad-template', { layout: 'post' }, /topic/],
    ['bad-path', { path: 'outside' }, /公开路径/],
  ] as const) {
    await assert.rejects(() => content.saveDocument(`content/topics/${id}/index.md`, { ...topic(id), ...changes }, '', null), message);
  }
  await assert.rejects(() => content.saveDocument('content/topics/unknown/index.fr.md', topic('unknown'), '', null), /语言未配置/);
  const path = 'content/topics/media/index.md';
  await content.saveDocument(path, topic('media'), 'Original', null);
  const first = await content.document(path);
  const imported = first.text.replace('+++\n', '+++\nextra.custom="keep" # custom comment\n');
  const saved = await repo.write(path, imported, first.revision);
  setNow('2026-10-27T04:00:00Z');
  await content.saveDocument(path, { description: 'Changed' }, '{{ card(title="example") }}', saved.revision);
  const edited = await content.document(path);
  assert.ok(edited.text.includes('extra.custom="keep" # custom comment'));
  assert.equal(edited.body, '{{ card(title="example") }}');
  assert.equal(edited.metadata.date, first.metadata.date);
  await content.saveDocument('content/topics/media/index.en.md', topic('media'), '', null);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const image = await repo.uploadMedia('content/topics/media', 'cover.png', png);
  const { mediaValue, storedMediaPath } = await import('../shared/media.js');
  assert.equal(mediaValue(image.item, 'document', 'content/topics/media/index.en.md'), 'cover.png');
  assert.equal(storedMediaPath('cover.png', 'document', 'content/topics/media/index.en.md'), image.item.path);
  await assert.rejects(() => content.saveDocument(path, { title: 'Stale update' }, 'Old', first.revision), /文件已更新/);
  assert.equal((await content.document(path)).revision, edited.revision);
});
