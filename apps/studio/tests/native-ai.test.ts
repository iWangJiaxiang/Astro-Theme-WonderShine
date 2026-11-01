import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepository } from '../server/repository.js';
import { NativeAiController } from '../platform/native-ai.js';
import { createContentTransport } from '../core/transport.js';

const settings = { baseUrl: 'http://127.0.0.1:12345/v1', model: 'fixture-text', imageModel: 'fixture-image', imageSize: '1024x1024', apiKey: 'fixture-secret' };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwinr/HwAE+AKLJh4rzQAAAABJRU5ErkJggg==';
async function fixture(t: { after(fn: () => Promise<void>): void }, fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), 'native-ai-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new LocalRepository(root);
  await repository.write('config.toml', 'title="Native AI"\ndefault_language="zh-CN"\n[languages.en]\n', null);
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const ai = new NativeAiController(repository, fetcher, storage, 'workspace-one');
  const transport = createContentTransport(repository, { ai });
  const request = (path: string, method = 'GET', body?: unknown) => transport(new Request('https://studio.local/api' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { ai, saved, storage, repository, request };
}

test('native API configuration persists only non-secret fields and isolates workspaces', async t => {
  const { ai, saved, storage, repository, request } = await fixture(t, async () => { throw new Error('unexpected network'); });
  assert.equal((await (await request('/bootstrap')).json()).nativeAi, true);
  assert.equal((await request('/native-ai', 'PUT', settings)).status, 200);
  assert.deepEqual(await (await request('/ai/config')).json(), { text: true, image: true });
  assert.equal(ai.configuration().hasKey, true);
  assert.equal(JSON.stringify([...saved.values()]).includes(settings.apiKey), false);
  assert.equal(JSON.stringify(ai.configuration()).includes(settings.apiKey), false);
  const reopened = new NativeAiController(repository, fetch, storage, 'workspace-one');
  assert.equal(reopened.configuration().model, 'fixture-text');
  assert.equal(reopened.configuration().hasKey, false);
  assert.equal(new NativeAiController(repository, fetch, storage, 'workspace-two').configuration().model, '');
  for (const baseUrl of ['http://example.com/v1', 'https://secret@example.com/v1', 'https://example.com/v1?key=x', 'https://example.com/v1#key', 'file:///etc/passwd']) {
    assert.throws(() => ai.configure({ ...settings, baseUrl }));
  }
  ai.configure({ ...settings, apiKey: '' });
  assert.equal(ai.configuration().hasKey, true);
  ai.configure({ ...settings, baseUrl: 'https://another.example/v1', apiKey: '' });
  assert.equal(ai.configuration().hasKey, false, 'changing endpoints must not forward the previous key');
  assert.equal((await request('/ai/text', 'POST', { task: 'summary', text: 'hello', title: '', language: 'en' })).status, 503);
});

test('native AI text, cover and translation share existing validation and draft review', async t => {
  const { ai, request, repository } = await fixture(t, async (url, init) => {
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-secret');
    const payload = JSON.parse(String(init?.body));
    if (String(url).endsWith('/images/generations')) return Response.json({ data: [{ b64_json: png }] });
    const content = payload.messages[0].content.includes('Translate the JSON')
      ? JSON.stringify({ title: 'Translated', description: '', body: 'Translated body.' }) : 'Generated summary.';
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
  });
  ai.configure(settings);
  const summary = await request('/ai/text', 'POST', { task: 'summary', title: '标题', text: '正文', language: 'en' });
  assert.equal(summary.status, 200); assert.deepEqual(await summary.json(), { text: 'Generated summary.' });
  const image = await request('/ai/image', 'POST', { prompt: 'A cover' });
  assert.equal(image.status, 200); assert.equal((await image.json()).base64, png);
  const source = await repository.write('content/articles/example/index.md', '+++\ntitle="标题"\ndraft=false\n+++\n正文\n', null);
  const translated = await request('/translation', 'POST', { path: 'content/articles/example/index.md', revision: source.revision, language: 'en' });
  assert.equal(translated.status, 201);
  const document = await repository.read((await translated.json()).path);
  assert.match(document!.text, /ai_translation = true/); assert.match(document!.text, /translation_reviewed = false/); assert.match(document!.text, /draft\s*=\s*true/);
});

test('logout cancels AI and never writes a late translation; updates cannot race an active request', async t => {
  let release!: (response: Response) => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const { ai, repository, request } = await fixture(t, async () => { started(); return new Promise(resolve => { release = resolve; }); });
  ai.configure(settings);
  const source = await repository.write('content/articles/example/index.md', '+++\ntitle="标题"\n+++\n正文\n', null);
  const result = request('/translation', 'POST', { path: 'content/articles/example/index.md', revision: source.revision, language: 'en' });
  await pending;
  assert.throws(() => ai.configure(settings), /正在生成/);
  await request('/auth/logout', 'POST');
  release(Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Late', description: '', body: 'Late body' }) } }] }));
  assert.notEqual((await result).status, 201);
  assert.equal(await repository.read('content/articles/example/index.en.md'), null);
  assert.equal(ai.configuration().hasKey, false);
});
