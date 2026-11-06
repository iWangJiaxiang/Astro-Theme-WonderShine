import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepository } from '../server/repository.js';
import { createContentTransport, type ContentTransportOptions } from '../core/transport.js';
import type { Repository } from '../shared/repository.js';

const path = 'content/articles/cache/index.md';
const text = (title: string) => `+++\ntitle="${title}"\ndate=2026-11-01\n+++\nBody`;
function client(repository: Repository, options: ContentTransportOptions = {}) {
  const transport = createContentTransport(repository, options);
  return (route = '/content', method = 'GET', body?: unknown) => transport(new Request('http://studio.local/api' + route, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'studio-summary-cache-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  const repository = new LocalRepository(root);
  await repository.write('config.toml', 'default_language="zh-CN"\n[languages.en]\n', null);
  await repository.write(path, text('Original'), null);
  let scans = 0;
  const list = repository.listForSummary.bind(repository);
  repository.listForSummary = () => { scans++; return list(); };
  return { repository, request: client(repository), scans: () => scans };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('navigation and concurrent native reads share one scan, not a Response body', async t => {
  const { request, scans } = await fixture(t);
  const responses = await Promise.all([request(), request(), request()]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(bodies[0], bodies[1]);
  bodies[0][0].title = 'Client mutation';
  assert.equal((await (await request()).json())[0].title, 'Original');
  assert.equal(scans(), 1);
});

test('external edits require refresh; documents and conflict checks are never cached', async t => {
  const { request, repository, scans } = await fixture(t);
  await request();
  const original = (await repository.read(path))!;
  await repository.write(path, text('External'), original.revision);
  assert.equal((await (await request()).json())[0].title, 'Original');
  const document = await (await request('/document?path=' + path)).json();
  assert.equal(document.metadata.title, 'External');
  assert.equal((await request('/document', 'PUT', { path, revision: original.revision, changes: { title: 'Stale' }, body: '' })).status, 409);
  assert.equal((await (await request('/content?refresh=1')).json())[0].title, 'External');
  assert.equal(scans(), 2);
  await repository.write(path, text('Bootstrap refresh'), document.revision);
  await request('/bootstrap?refresh=1');
  assert.equal((await (await request()).json())[0].title, 'Bootstrap refresh');
});

test('existing edits, deletes and settings use deltas; new translations discover repository order', async t => {
  const { request, repository, scans } = await fixture(t);
  await request();
  const incrementalRows = async () => {
    const before = scans();
    const rows = await (await request()).json();
    assert.equal(scans(), before, 'summary reads after observed writes must not scan again');
    return rows;
  };
  const original = (await repository.read(path))!;
  assert.equal((await request('/document', 'PUT', { path, revision: original.revision, changes: { title: 'Saved' }, body: 'Body' })).status, 200);
  assert.equal((await incrementalRows())[0].title, 'Saved');
  const revision = (await repository.read(path))!.revision;
  assert.equal((await request('/translation/manual', 'POST', { path, revision, language: 'en' })).status, 201);
  const afterTranslation = scans();
  assert.equal((await (await request()).json()).length, 2);
  assert.equal(scans(), afterTranslation + 1, 'new paths require discovery of adapter enumeration order');
  assert.equal((await request('/document', 'DELETE', { path, revision })).status, 200);
  assert.equal((await incrementalRows()).length, 1);
  const settings = await (await request('/settings/site')).json();
  assert.equal((await request('/settings/site', 'PUT', { revision: settings.revision, changes: { base_url: 'https://new.example.com' } })).status, 200);
  const before = scans();
  assert.equal((await request()).status, 200);
  assert.equal(scans(), before, 'the list projection must reuse observed deltas; write guards may scan authoritative text');
});

test('failed scan retries and separate transports/workspaces never share snapshots', async t => {
  const a = await fixture(t), b = await fixture(t);
  const list = a.repository.listForSummary.bind(a.repository);
  let fail = true;
  a.repository.listForSummary = async () => { if (fail) { fail = false; throw new Error('Unavailable'); } return list(); };
  assert.equal((await a.request()).status, 500);
  assert.equal((await a.request()).status, 200);
  await b.repository.write(path, text('Other workspace'), (await b.repository.read(path))!.revision);
  assert.equal((await (await b.request()).json())[0].title, 'Other workspace');
  assert.equal((await (await a.request()).json())[0].title, 'Original');
  await client(a.repository)();
  assert.equal(a.scans(), 2);
});

test('late pre-refresh scan cannot replace the refreshed snapshot', async t => {
  const { repository } = await fixture(t);
  const list = repository.listForSummary.bind(repository), started = gate(), release = gate();
  let first = true;
  repository.listForSummary = async () => {
    const files = await list();
    if (first) { first = false; started.resolve(); await release.promise; }
    return files;
  };
  const request = client(repository);
  const old = request();
  await started.promise;
  await repository.write(path, text('Fresh'), (await repository.read(path))!.revision);
  assert.equal((await (await request('/content?refresh=1')).json())[0].title, 'Fresh');
  release.resolve();
  assert.equal((await (await old).json())[0].title, 'Fresh');
  assert.equal((await (await request()).json())[0].title, 'Fresh');
});

test('AI translation invalidates even when a gateway partially writes then fails', async t => {
  const { repository } = await fixture(t);
  const configuration = () => ({ baseUrl: '', model: '', imageModel: '', imageSize: 'auto', hasKey: false });
  const request = client(repository, { ai: {
    configuration, configure: configuration, clearKey: configuration,
    capabilities: () => ({ text: false, image: false }),
    translationCapabilities: () => ({ enabled: false }),
    text: async () => { throw new Error('Unused'); },
    image: async () => { throw new Error('Unused'); },
    translate: async () => {
      await repository.write(path, text('AI partial write'), (await repository.read(path))!.revision);
      throw new Error('Partial failure');
    },
    dispose: () => {},
  } });
  await request();
  assert.equal((await request('/translation', 'POST', {})).status, 500);
  assert.equal((await (await request()).json())[0].title, 'AI partial write');
  assert.equal((await request('/auth/logout', 'POST')).status, 200);
  assert.equal((await request()).status, 401);
});

test('reads during failed sync cannot seed a persistent stale snapshot', async t => {
  const { repository } = await fixture(t);
  const started = gate(), release = gate();
  const wrapped = Object.create(repository) as Repository;
  Object.defineProperty(wrapped, 'workspace', { configurable: true, value: {
    sync: async () => {
      started.resolve(); await release.promise;
      await repository.write(path, text('Partial sync'), (await repository.read(path))!.revision);
      throw new Error('Sync failed after local change');
    },
  } });
  const request = client(wrapped);
  await request();
  const sync = request('/workspace/sync', 'POST', { confirmation: 'SYNC' });
  await started.promise;
  const duringSync = request();
  release.resolve();
  assert.equal((await sync).status, 500);
  assert.equal((await (await duringSync).json())[0].title, 'Partial sync');
  assert.equal((await (await request()).json())[0].title, 'Partial sync');
});
