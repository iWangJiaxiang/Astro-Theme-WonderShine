import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepository } from '../server/repository.js';
import { ContentService } from '../server/content-service.js';
import { TranslationService } from '../server/translation.js';
import { inspectTranslationSettings } from '../server/translation-config.js';
import { translationLocation, translationTextChanged } from '../shared/translation.js';

const settings = { baseUrl: 'https://translator.example/v1', model: 'example-model', apiKey: 'test-only-secret' };
const response = (text: string) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] }));
const successfulFetch: typeof fetch = async (_url, init) => {
  const payload = JSON.parse(String(init?.body));
  const source = JSON.parse(payload.messages[1].content);
  return response(JSON.stringify({ title: 'Translated title', description: 'Translated description', body: source.body.replace('你好', 'Hello') }));
};
async function fixture(t: { after(fn: () => Promise<void>): void }, fetcher = successfulFetch) {
  const root = await mkdtemp(join(tmpdir(), 'studio-translation-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  await writeFile(join(root, 'config.toml'), 'default_language="zh-CN"\n[languages.en]\n');
  const repo = new LocalRepository(root), content = new ContentService(repo);
  const path = 'content/articles/story/index.md';
  const body = '你好\n\n```js\nconst text = "你好";\n```\n\n`你好` [链接](https://example.com/a)\n\n{{ image(src="photo.png") }}';
  await repo.write(path, '+++\ntitle="原文"\ndescription="摘要"\ndate=2020-01-01\ndraft=false\n[extra]\ncustom="preserve"\n+++\n' + body, null);
  const source = await content.document(path);
  return { root, repo, content, source, service: new TranslationService(repo, settings, fetcher) };
}
test('AI translation creates a new review-required draft and preserves source and protected Markdown', async t => {
  const { repo, content, source, service } = await fixture(t);
  const result = await service.create({ path: source.path, revision: source.revision, language: 'en' });
  assert.equal(result.path, 'content/articles/story/index.en.md');
  const translated = await content.document(result.path);
  assert.equal(translated.metadata.draft, true);
  assert.deepEqual(translated.metadata.extra, { custom: 'preserve', ai_translation: true, translation_reviewed: false, translation_source: source.path });
  assert.match(translated.body, /^Hello/);
  assert.match(translated.body, /const text = "你好"/);
  assert.ok(translated.body.includes('`你好` [链接](https://example.com/a)'));
  assert.ok(translated.body.includes('{{ image(src="photo.png") }}'));
  assert.equal((await repo.read(source.path))?.revision, source.revision);
  await assert.rejects(service.create({ path: source.path, revision: source.revision, language: 'en' }), /译文已存在/);
});
test('source changes during generation are rejected without creating a translation', async t => {
  const { repo, content, source } = await fixture(t);
  const service = new TranslationService(repo, settings, async (url, init) => {
    await content.saveDocument(source.path, {}, 'Someone edited the source', source.revision);
    return successfulFetch(url, init);
  });
  await assert.rejects(service.create({ path: source.path, revision: source.revision, language: 'en' }), /原文已更新/);
  assert.equal(await repo.read('content/articles/story/index.en.md'), null);
});
test('provider errors, malformed JSON and missing protected tokens never create documents or leak credentials', async t => {
  for (const fetcher of [
    async () => new Response('test-only-secret', { status: 401 }),
    async () => response('not-json'),
    async () => response(JSON.stringify({ title: 'T', description: '', body: 'Dropped code' })),
    async () => { throw new Error('test-only-secret'); },
  ]) {
    const { repo, source, service } = await fixture(t, fetcher);
    await assert.rejects(service.create({ path: source.path, revision: source.revision, language: 'en' }), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /test-only-secret/); return true;
    });
    assert.equal(await repo.read('content/articles/story/index.en.md'), null);
  }
});
test('unreviewed translations cannot publish; text edits reset review unless explicitly reviewed again', async t => {
  const { content, source, service } = await fixture(t);
  const result = await service.create({ path: source.path, revision: source.revision, language: 'en' });
  let translated = await content.document(result.path);
  await assert.rejects(content.saveDocument(result.path, { draft: false }, translated.body, translated.revision), /审核/);
  await content.saveDocument(result.path, { 'extra.translation_reviewed': true, draft: false }, translated.body, translated.revision);
  translated = await content.document(result.path);
  await assert.rejects(content.saveDocument(result.path, {}, translated.body + '\nChanged', translated.revision), /审核/);
  await content.saveDocument(result.path, { draft: true }, translated.body + '\nChanged', translated.revision);
  translated = await content.document(result.path);
  assert.equal((translated.metadata.extra as Record<string, unknown>).translation_reviewed, false);
  await content.saveDocument(result.path, { 'extra.ai_translation': false, 'extra.translation_reviewed': true, draft: false }, translated.body, translated.revision);
});
test('translation config is optional and validates endpoint without reflecting secrets', () => {
  assert.equal(inspectTranslationSettings({}), undefined);
  assert.throws(() => inspectTranslationSettings({ STUDIO_AI_MODEL: 'model' }), /配置/);
  assert.throws(() => inspectTranslationSettings({ STUDIO_AI_BASE_URL: 'http://public.example/v1', STUDIO_AI_MODEL: 'm', STUDIO_AI_API_KEY: 's' }), /HTTPS/);
  assert.equal(inspectTranslationSettings({ STUDIO_AI_BASE_URL: settings.baseUrl, STUDIO_AI_MODEL: settings.model, STUDIO_AI_API_KEY: settings.apiKey })?.model, settings.model);
});
test('localized paths keep dotted article filenames and detect actual translatable edits', () => {
  const config = { defaultLanguage: 'zh-CN', languages: ['zh-CN', 'en'] };
  assert.equal(translationLocation('content/articles/my.story.md', 'en', config).path, 'content/articles/my.story.en.md');
  assert.equal(translationLocation('content/threads/n_one/index.en.md', 'zh-CN', config).path, 'content/threads/n_one/index.md');
  assert.equal(translationLocation('content/articles/_index.md', 'en', config).path, 'content/articles/_index.en.md');
  assert.equal(translationTextChanged({ title: 'A', weight: 1 }, { title: 'A', weight: 2 }, 'B', 'B'), false);
  assert.equal(translationTextChanged({ title: 'A' }, { title: 'C' }, 'B', 'B'), true);
});

test('thread and topic translations preserve identity, dates and configured target taxonomies', async t => {
  const { repo, content, service } = await fixture(t);
  await writeFile(join(repo.root, 'config.toml'), 'default_language="zh-CN"\ntaxonomies=[{name="tags"},{name="categories"}]\n[languages.en]\ntaxonomies=[{name="tags"}]\n');
  for (const kind of ['thread', 'topic'] as const) {
    const path = `content/${kind === 'thread' ? 'threads' : 'topics'}/example/index.md`;
    await content.saveDocument(path, { title: '你好', date: '2020-01-01T00:00:00Z', 'extra.kind': kind, 'extra.id': 'example', ...(kind === 'topic' ? { layout: 'topic' } : { 'taxonomies.tags': ['keep'], 'taxonomies.categories': ['omit'] }) }, '你好', null);
    const source = await content.document(path);
    const saved = await service.create({ path, revision: source.revision, language: 'en' });
    const doc = await content.document(saved.path);
    assert.equal((doc.metadata.extra as Record<string, unknown>).id, 'example');
    assert.equal(doc.metadata.date, source.metadata.date);
    if (kind === 'thread') {
      assert.deepEqual(doc.metadata.taxonomies, { tags: ['keep'] });
      assert.equal(doc.metadata.path, 'en/threads/example');
      assert.equal(doc.metadata.aliases, undefined);
    }
    await content.saveDocument(saved.path, { 'extra.translation_reviewed': true, draft: false }, doc.body, doc.revision);
  }
});

test('article translations remove taxonomies not configured in target language', async t => {
  const { repo, content, source, service } = await fixture(t);
  await content.saveDocument(source.path, { 'taxonomies.tags': ['source-only'] }, source.body, source.revision);
  const updated = await content.document(source.path);
  const saved = await service.create({ path: source.path, revision: updated.revision, language: 'en' });
  const doc = await content.document(saved.path);
  assert.equal((doc.metadata.taxonomies as Record<string, unknown> | undefined)?.tags, undefined);
});

test('simultaneous requests are bounded and a destination created during generation is not overwritten', async t => {
  const { repo, source } = await fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let providerCalls = 0;
  const service = new TranslationService(repo, settings, async (url, init) => {
    providerCalls++;
    entered();
    await gate;
    return successfulFetch(url, init);
  });
  const input = { path: source.path, revision: source.revision, language: 'en' };
  const destination = 'content/articles/story/index.en.md';
  const existingText = '+++\ntitle="Existing"\n+++\nDo not overwrite';
  const first = service.create(input);
  // Observe rejection immediately, including failures before the provider is reached.
  const settled = Promise.allSettled([first]);
  let existingRevision!: string;
  try {
    await Promise.race([
      started,
      settled.then(() => { assert.fail('Translation settled before reaching the provider gate'); }),
    ]);
    await assert.rejects(service.create(input), { status: 429, message: /另一份译文/ });
    // Create the competing destination only after the initial absence check has passed.
    existingRevision = (await repo.write(destination, existingText, null)).revision;
  } finally {
    release();
    await settled;
  }
  await assert.rejects(first, { status: 409, message: /文件已更新/ });
  assert.equal(providerCalls, 1);
  const existing = await repo.read(destination);
  assert.equal(existing?.text, existingText);
  assert.equal(existing?.revision, existingRevision);
});

test('changed configuration and moved protected tokens reject provider results', async t => {
  const fixtureOne = await fixture(t);
  const service = new TranslationService(fixtureOne.repo, settings, async (url, init) => {
    const current = await fixtureOne.repo.read('config.toml');
    await fixtureOne.repo.write('config.toml', current!.text + '# changed\n', current!.revision);
    return successfulFetch(url, init);
  });
  await assert.rejects(service.create({ path: fixtureOne.source.path, revision: fixtureOne.source.revision, language: 'en' }), /语言配置已更新/);
  const fixtureTwo = await fixture(t, async (_url, init) => {
    const fields = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    return response(JSON.stringify({ title: fields.body, body: 'Hello', description: '' }));
  });
  await assert.rejects(fixtureTwo.service.create({ path: fixtureTwo.source.path, revision: fixtureTwo.source.revision, language: 'en' }), /保留代码或链接/);
});

test('translation provenance cannot be cleared to bypass future review', async t => {
  const { content, source, service } = await fixture(t);
  const result = await service.create({ path: source.path, revision: source.revision, language: 'en' });
  let doc = await content.document(result.path);
  await content.saveDocument(doc.path, { 'extra.translation_reviewed': true }, doc.body, doc.revision);
  doc = await content.document(doc.path);
  await assert.rejects(content.saveDocument(doc.path, { 'extra.ai_translation': false, 'extra.translation_source': '', draft: true }, doc.body, doc.revision), /系统维护/);
  await content.saveDocument(doc.path, { 'extra.ai_translation': false }, doc.body, doc.revision);
  doc = await content.document(doc.path);
  await assert.rejects(content.saveDocument(doc.path, { draft: false }, doc.body + '\nEdited', doc.revision), /审核/);
});

test('longer closing fences, multiline code spans and unclosed fences remain byte-identical', async t => {
  for (const body of ['你好\n\n    const s = \"你好\";\n', '你好\n```js\nconst text="你好";\n````\n', '你好\n~~~\n你好\n~~~~\n', '你好\n``code\n你好 ` more``\n', '你好\n```\n你好\n']) {
    const { content, repo, source } = await fixture(t);
    await content.saveDocument(source.path, {}, body, source.revision);
    const current = await content.document(source.path);
    const service = new TranslationService(repo, settings, async (_url, init) => {
      const fields = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return response(JSON.stringify({ ...fields, body: fields.body.replaceAll('你好', 'Hello') }));
    });
    const result = await service.create({ path: current.path, revision: current.revision, language: 'en' });
    assert.equal((await content.document(result.path)).body, body.replace('你好', 'Hello'));
  }
});
