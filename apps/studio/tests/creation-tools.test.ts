import test from 'node:test';
import assert from 'node:assert/strict';
import { AiService } from '../server/ai.js';
import { inspectImageSettings } from '../server/ai-config.js';
import { canAutosave, readAutosave, writeAutosave } from '../src/autosave.js';
import { mediaDirectoryTree, inMediaDirectory } from '../src/media-tree.js';
import type { MediaItem } from '../shared/media.js';
const settings = { baseUrl: 'https://ai.example/v1', model: 'fixture-model', apiKey: 'fixture-secret' };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/ZkAAAAASUVORK5CYII=';
const summary = { task: 'summary' as const, title: 'Title', text: 'Article text', language: 'en' };
const completion = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
test('AI summary and cover prompt use current content and language without writing documents', async () => {
  const sent: { messages: { content: string }[] }[] = [];
  const service = new AiService(settings, undefined, async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return completion('A concise summary.'); });
  assert.equal((await service.text(summary)).text, 'A concise summary.');
  assert.match(sent[0].messages[0].content, /in en/);
  assert.match(sent[0].messages[0].content, /untrusted data/);
  assert.deepEqual(JSON.parse(sent[0].messages[1].content), { title: 'Title', content: 'Article text' });
  await service.text({ ...summary, task: 'cover-prompt', language: 'zh-CN' });
  assert.match(sent[1].messages[0].content, /image generation prompt in zh-CN/);
});
test('AI handles missing configuration, invalid input, provider errors and incomplete results safely', async () => {
  await assert.rejects(new AiService().text(summary), /尚未配置/);
  for (const fetcher of [async () => new Response('fixture-secret', { status: 401 }), async () => completion(''), async () => { throw new Error('fixture-secret'); }, async () => new Response('{}')]) {
    await assert.rejects(new AiService(settings, undefined, fetcher).text(summary), error => { assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /fixture-secret/); return true; });
  }
  const service = new AiService(settings, undefined, async () => { throw new Error('must not call'); });
  await assert.rejects(service.text({ ...summary, text: 'x'.repeat(80_001) }), /长度限制/);
  await assert.rejects(service.text({ ...summary, text: '' }), /请填写/);
});
test('image generation validates binary output and never fetches provider URLs', async () => {
  let calls = 0;
  const service = new AiService(settings, { ...settings, size: '1024x1024' }, async (url, init) => {
    calls++; assert.match(String(url), /\/images\/generations$/);
    assert.equal(JSON.parse(String(init?.body)).response_format, 'b64_json');
    return new Response(JSON.stringify({ data: [{ b64_json: png }] }));
  });
  assert.deepEqual(await service.image({ prompt: 'Landscape with books' }), { base64: png, mime: 'image/png', extension: 'png' });
  assert.equal(calls, 1);
  for (const data of [{ url: 'http://169.254.169.254/secret' }, { b64_json: Buffer.from('not image').toString('base64') }]) {
    let count = 0;
    const invalid = new AiService(settings, { ...settings, size: '1024x1024' }, async () => { count++; return new Response(JSON.stringify({ data: [data] })); });
    await assert.rejects(invalid.image({ prompt: 'x' })); assert.equal(count, 1);
  }
  await assert.rejects(new AiService(settings, { ...settings, size: '1024x1024' }, async () => new Response(JSON.stringify({ data: [{ b64_json: png }] })), 10).image({ prompt: 'x' }), /大小限制/);
});
test('AI concurrent requests are rejected and failure releases the lock', async () => {
  let finish: (response: Response) => void = () => {};
  const service = new AiService(settings, undefined, () => new Promise(resolve => { finish = resolve; }));
  const pending = service.text(summary);
  await assert.rejects(service.text(summary), /正在生成/);
  finish(completion('Done')); await pending;
  const next = service.text(summary); finish(completion('Again')); assert.equal((await next).text, 'Again');
});
test('image configuration reuses server credentials, permits separate provider, validates URL and size', () => {
  assert.equal(inspectImageSettings({}), undefined);
  const env = { STUDIO_AI_BASE_URL: settings.baseUrl, STUDIO_AI_API_KEY: settings.apiKey, STUDIO_AI_IMAGE_MODEL: 'gpt-image-1' };
  assert.equal(inspectImageSettings(env)?.size, '1536x1024');
  assert.equal(inspectImageSettings({ ...env, STUDIO_AI_IMAGE_BASE_URL: 'https://images.example/v1', STUDIO_AI_IMAGE_API_KEY: 'image-key' })?.apiKey, 'image-key');
  assert.throws(() => inspectImageSettings({ ...env, STUDIO_AI_IMAGE_BASE_URL: 'http://untrusted.example' }), /HTTPS/);
  assert.throws(() => inspectImageSettings({ ...env, STUDIO_AI_IMAGE_SIZE: 'invalid' }), /尺寸/);
});
test('autosave defaults off, persists only allowed intervals and respects blockers', () => {
  assert.equal(readAutosave(''), 0);
  assert.equal(readAutosave('other=1; studio-autosave=300; last=2'), 300);
  assert.equal(readAutosave('studio-autosave=3'), 0);
  assert.match(writeAutosave(30, true), /^studio-autosave=30; Path=\/; Max-Age=31536000; SameSite=Strict; Secure$/);
  const state = { ready: true, dirty: true, busy: false, blocked: false, authenticated: true };
  assert.equal(canAutosave(state), true);
  for (const override of [{ busy: true }, { blocked: true }, { dirty: false }, { ready: false }, { authenticated: false }]) assert.equal(canAutosave({ ...state, ...override }), false);
});
test('media tree counts descendants and filters folders without matching similar prefixes', () => {
  const item = (directory: string, name: string): MediaItem => ({ directory, name, path: `${directory}/${name}`, size: 4, mime: 'image/png' });
  const items = [item('public/img/a', 'one.png'), item('public/img/ab', 'two.png'), item('content/articles/a', 'cover.png')];
  const tree = mediaDirectoryTree(items);
  assert.deepEqual(tree.map(node => [node.path, node.count]), [['content', 1], ['public', 2]]);
  assert.equal(tree[1].children[0].count, 2);
  assert.equal(inMediaDirectory(items[0], 'public/img'), true);
  assert.equal(inMediaDirectory(items[1], 'public/img/a'), false);
  assert.equal(inMediaDirectory(items[2], ''), true);
});
