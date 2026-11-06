import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSummaryRuntime } from '../core/summary-runtime.js';
import { createContentTransport } from '../core/transport.js';
import { SUMMARY_INDEX_CACHE_RECIPE, type SummaryIndexStore } from '../core/summary-index.js';
import { NativeAiController } from '../platform/native-ai.js';
import { LocalRepository } from '../server/repository.js';
import { GitRepository } from '../server/git-repository.js';
import { MediaCheckout } from '../server/media-checkout.js';
import { createApp } from '../server/app.js';
import { FileState } from '../server/state.js';
import { hashPassword } from '../server/password.js';
import type { WorkspaceControl } from '../shared/workspace.js';

const path = 'content/articles/runtime/index.md';
const text = (title: string) => `+++\ntitle="${title}"\ndate=2026-11-01\n+++\nBody`;
const scope = 'summary-integration';
function storeFixture() {
  let value: unknown = { version: 1, recipe: SUMMARY_INDEX_CACHE_RECIPE, scope, state: 'clean', rows: [
    { path, title: 'Stale preview', date: '2026-11-01', draft: false, kind: 'article', tags: [], categories: [], revision: 'must-not-leak', body: 'must-not-leak' },
  ] };
  let loads = 0;
  const store: SummaryIndexStore = {
    load: async () => { loads++; return structuredClone(value); },
    save: async record => { value = structuredClone(record); },
    clear: async () => { value = null; },
  };
  return { store, loads: () => loads };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'summary-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new LocalRepository(root);
  await repository.write('config.toml', 'default_language="zh-CN"\n[languages.en]\n', null);
  await repository.write(path, text('Authoritative'), null);
  let scans = 0;
  const scan = repository.listForSummary.bind(repository);
  repository.listForSummary = () => { scans++; return scan(); };
  return { root, repository, scans: () => scans };
}
function native(repository: LocalRepository, runtime: ReturnType<typeof createSummaryRuntime>, ai?: NativeAiController) {
  const transport = createContentTransport(repository, { runtime, ai, aiUsesObservedRepository: !!ai });
  return (route: string, method = 'GET', body?: unknown) => transport(new Request('https://studio.local/api' + route, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
async function server(root: string, repository: LocalRepository | GitRepository, store?: SummaryIndexStore) {
  const config = { origin: 'http://localhost:5173', secureCookies: false, sessionSecret: 's'.repeat(32), sessionSeconds: 3600,
    username: 'owner', passwordHash: await hashPassword('fixture-password-long') };
  const app = createApp({ config, repository, state: new FileState(join(root, '.state')), summaryStore: store, summaryScope: scope });
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'fixture-password-long' }) });
  assert.equal(login.status, 200);
  const session = await login.json();
  const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0], origin: config.origin, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  return { app, headers };
}

test('native preview is display-only; document authority and disposal never use stored rows', async t => {
  const { repository, scans } = await fixture(t), cache = storeFixture();
  const runtime = createSummaryRuntime(repository, { scope, store: cache.store });
  const request = native(repository, runtime);
  const previewResponse = await request('/content-preview');
  assert.match(previewResponse.headers.get('cache-control')!, /no-store/);
  const preview = await previewResponse.json();
  assert.equal(preview.authoritative, false);
  assert.equal(preview.rows[0].title, 'Stale preview');
  assert.equal('revision' in preview.rows[0], false);
  assert.equal('body' in preview.rows[0], false);
  assert.equal(scans(), 0);
  assert.equal((await (await request('/document?path=' + path)).json()).metadata.title, 'Authoritative');
  assert.equal((await (await request('/content')).json())[0].title, 'Authoritative');
  assert.equal(await (await request('/content-preview')).json(), null);
  assert.equal((await request('/auth/logout', 'POST')).status, 200);
  assert.equal((await request('/content-preview')).status, 401);
  await assert.rejects(runtime.list(), /disposed/);
});

test('injected runtime shares one observer with native AI and content transport', async t => {
  const { repository, scans } = await fixture(t);
  const runtime = createSummaryRuntime(repository, { scope });
  t.after(async () => runtime.dispose());
  const ai = new NativeAiController(runtime.repository, async () => Response.json({ choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ title: 'AI translated', description: '', body: 'Translated body' }),
  } }] }), { getItem: () => null, setItem: () => {} }, scope);
  ai.configure({ baseUrl: 'https://ai.example/v1', model: 'fixture', imageModel: '', imageSize: '1024x1024', apiKey: 'fixture' });
  const request = native(repository, runtime, ai);
  await request('/content');
  const source = (await repository.read(path))!;
  assert.equal((await request('/translation', 'POST', { path, revision: source.revision, language: 'en' })).status, 201);
  const afterWrite = scans();
  const rows = await (await request('/content')).json();
  assert.equal(rows.length, 2);
  assert.equal(rows.some((row: { title: string }) => row.title === 'AI translated'), true);
  assert.equal(scans(), afterWrite + 1, 'new translation paths require one ordered discovery scan');
  const translated = rows.find((row: { path: string }) => row.path !== path);
  const translatedFile = (await repository.read(translated.path))!;
  await runtime.repository.write(translated.path, text('Edited through shared observer'), translatedFile.revision);
  const afterEdit = scans();
  assert.equal((await (await request('/content')).json()).some((row: { title: string }) => row.title === 'Edited through shared observer'), true);
  assert.equal(scans(), afterEdit, 'existing writes retain incremental bases');
  const secondTransport = createContentTransport(runtime.repository, { runtime });
  assert.equal((await secondTransport(new Request('https://studio.local/api/content'))).status, 200);
  assert.equal(scans(), afterEdit, 'injecting the observed repository must not double-wrap it');
  assert.throws(() => createContentTransport(new LocalRepository('/unrelated-fixture'), { runtime }), /different repository/);
});

test('real native AI partial repository failure cannot retain a stale summary', async t => {
  const { repository, scans } = await fixture(t);
  const runtime = createSummaryRuntime(repository, { scope });
  t.after(async () => runtime.dispose());
  const ai = new NativeAiController(runtime.repository, async () => Response.json({ choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ title: 'Persisted before failure', description: '', body: 'Translated body' }),
  } }] }), { getItem: () => null, setItem: () => {} }, scope);
  ai.configure({ baseUrl: 'https://ai.example/v1', model: 'fixture', imageModel: '', imageSize: '1024x1024', apiKey: 'fixture' });
  const request = native(repository, runtime, ai);
  await request('/content');
  const write = repository.writeBatch.bind(repository);
  repository.writeBatch = async (entries, guard) => { await write(entries, guard); throw new Error('Partial storage failure'); };
  const source = (await repository.read(path))!;
  assert.equal((await request('/translation', 'POST', { path, revision: source.revision, language: 'en' })).status, 500);
  const afterFailure = scans();
  assert.equal((await (await request('/content')).json()).length, 2);
  assert.equal(scans(), afterFailure + 1, 'uncertain terminal events force an authoritative scan');
});

test('server preview and cached reads remain behind authentication; ordinary requests see external changes', async t => {
  const { root, repository, scans } = await fixture(t), cache = storeFixture();
  const { app, headers } = await server(root, repository, cache.store);
  assert.equal((await app.request('/api/content-preview')).status, 401);
  assert.equal((await app.request('/api/content')).status, 401);
  assert.equal(cache.loads(), 0);
  assert.equal(scans(), 0);
  const previewResponse = await app.request('/api/content-preview', { headers });
  assert.match(previewResponse.headers.get('cache-control')!, /no-store/);
  assert.equal((await previewResponse.json()).authoritative, false);
  assert.equal((await (await app.request('/api/content', { headers })).json())[0].title, 'Authoritative');
  await repository.write(path, text('Changed by another worker'), (await repository.read(path))!.revision);
  assert.equal((await (await app.request('/api/content', { headers })).json())[0].title, 'Changed by another worker');
  assert.equal(scans(), 2, 'settled server rows have a zero-duration freshness lease');
  assert.equal((await app.request('/api/document', { method: 'PUT', headers: { cookie: headers.cookie }, body: '{}' })).status, 403);
  assert.equal(scans(), 2);
});

test('cold server content scan preserves a concurrent slow stale-preview load', async t => {
  const { root, repository, scans } = await fixture(t), cache = storeFixture();
  let releaseLoad!: () => void, loaded!: () => void, releaseScan!: () => void, scanning!: () => void;
  const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
  const loadStarted = new Promise<void>(resolve => { loaded = resolve; });
  const scanGate = new Promise<void>(resolve => { releaseScan = resolve; });
  const scanStarted = new Promise<void>(resolve => { scanning = resolve; });
  let clears = 0;
  const store: SummaryIndexStore = {
    ...cache.store,
    async load() { loaded(); await loadGate; return cache.store.load(); },
    async clear() { clears++; await cache.store.clear(); },
  };
  const scan = repository.listForSummary.bind(repository);
  repository.listForSummary = async () => { scanning(); await scanGate; return scan(); };
  const { app, headers } = await server(root, repository, store);
  const preview = app.request('/api/content-preview', { headers });
  await loadStarted;
  const content = app.request('/api/content', { headers });
  await scanStarted;
  releaseLoad();
  const cached = await (await preview).json();
  assert.equal(cached?.authoritative, false);
  assert.equal(cached?.rows[0].title, 'Stale preview');
  assert.equal(clears, 0, 'cold authoritative scan is not an explicit invalidation');
  releaseScan();
  assert.equal((await (await content).json())[0].title, 'Authoritative');
  await repository.write(path, text('External change after first request'), (await repository.read(path))!.revision);
  assert.equal((await (await app.request('/api/content', { headers })).json())[0].title, 'External change after first request');
  assert.equal(scans(), 2, 'settled server requests still have a zero-duration lease');
});

test('fresh server callers only share concurrent work', async t => {
  const { repository, scans } = await fixture(t);
  const runtime = createSummaryRuntime(repository, { scope });
  t.after(async () => runtime.dispose());
  const rows = await Promise.all([runtime.list({ fresh: true }), runtime.list({ fresh: true }), runtime.list({ fresh: true })]);
  assert.equal(scans(), 1);
  rows[0][0].title = 'Caller-local change';
  assert.equal(rows[1][0].title, 'Authoritative');
  await runtime.list({ fresh: true });
  assert.equal(scans(), 2);
});

test('explicit runtime refresh wakes readers abandoned on an unresponsive old scan', async t => {
  const { repository } = await fixture(t);
  const scan = repository.listForSummary.bind(repository);
  let started!: () => void;
  const scanning = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  repository.listForSummary = () => {
    if (first) { first = false; started(); return new Promise(() => {}); }
    return scan();
  };
  const runtime = createSummaryRuntime(repository, { scope });
  t.after(async () => runtime.dispose());
  const abandoned = runtime.list(); await scanning;
  assert.equal((await runtime.refresh())[0].title, 'Authoritative');
  assert.equal((await abandoned)[0].title, 'Authoritative');
});

test('concurrent explicit refreshes share one new scan and native reads reuse it', async t => {
  const { repository, scans } = await fixture(t);
  const runtime = createSummaryRuntime(repository, { scope });
  t.after(async () => runtime.dispose());
  await runtime.list();
  await repository.write(path, text('External edit'), (await repository.read(path))!.revision);
  const refreshed = await Promise.all([runtime.refresh(), runtime.refresh(), runtime.list()]);
  assert.equal(scans(), 2);
  assert.equal(refreshed.every(rows => rows[0].title === 'External edit'), true);
  await runtime.list();
  assert.equal(scans(), 2);
});

test('online Git bootstrap shares checkout; explicit refresh and mutation require a new checkout', async t => {
  const { root, repository } = await fixture(t);
  let clones = 0;
  const checkout = new MediaCheckout(async () => { clones++; return repository; }, async () => {}, 30_000);
  t.after(async () => checkout.clear());
  // Exercise the actual GitRepository cache policy without network or live remotes.
  const online = new GitRepository({ url: 'https://git.example/site.git', branch: 'main', username: 'fixture', token: 'fixture', name: 'Fixture', email: 'fixture@example.com' });
  online.read = name => checkout.use(repo => repo.read(name));
  online.listForSummary = () => checkout.use(repo => repo.listForSummary());
  online.clearReadCache = () => checkout.clear();
  online.writeBatch = (entries, guard) => repository.writeBatch(entries, guard);
  const { app, headers } = await server(root, online);
  await Promise.all(['/api/bootstrap', '/api/content-languages', '/api/content'].map(route => app.request(route, { headers })));
  assert.equal(clones, 1, 'normal bootstrap siblings must not discard the shared checkout');
  await app.request('/api/content?refresh=1', { headers });
  assert.equal(clones, 2);
  const revision = (await repository.read(path))!.revision;
  assert.equal((await app.request('/api/document', { method: 'PUT', headers, body: JSON.stringify({ path, revision, changes: { title: 'Saved' }, body: 'Body' }) })).status, 200);
  const afterMutation = clones;
  assert.equal((await (await app.request('/api/content', { headers })).json())[0].title, 'Saved');
  assert.ok(clones > afterMutation, 'mutation terminal event retires the preflight checkout');
});

test('review is explicit, CSRF protected and does not invalidate native summaries', async t => {
  const { root, repository, scans } = await fixture(t);
  let reviews = 0;
  const status = { branch: 'main', dirty: false, changes: 0, ahead: 0, behind: 0, diverged: false, head: null, remoteHead: null, lastSync: null };
  const workspace: WorkspaceControl = {
    status: async () => status,
    createReview: async () => { reviews++; return { ...status, confirmation: 'explicit-review' }; },
    commit: async () => status, sync: async () => status,
  };
  Object.defineProperty(repository, 'workspace', { configurable: true, value: workspace });
  const runtime = createSummaryRuntime(repository, { scope });
  t.after(async () => runtime.dispose());
  const request = native(repository, runtime);
  await request('/content');
  assert.equal((await (await request('/workspace', 'GET')).json()).confirmation, undefined);
  assert.equal((await (await request('/workspace/review', 'POST')).json()).confirmation, 'explicit-review');
  await request('/content');
  assert.equal(scans(), 1);
  const { app, headers } = await server(root, repository);
  assert.equal((await app.request('/api/workspace/review', { method: 'POST' })).status, 401);
  assert.equal((await app.request('/api/workspace/review', { method: 'POST', headers: { cookie: headers.cookie } })).status, 403);
  assert.equal(reviews, 1);
  assert.equal((await app.request('/api/workspace/review', { method: 'POST', headers })).status, 200);
  assert.equal(reviews, 2);
});
