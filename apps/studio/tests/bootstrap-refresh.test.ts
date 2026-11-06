import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { LocalRepository } from '../server/repository.js';
import { GitRepository } from '../server/git-repository.js';
import { MediaCheckout } from '../server/media-checkout.js';
import { FileState } from '../server/state.js';
import { hashPassword } from '../server/password.js';

// Separate immutable checkout snapshots model a remote update while the online
// adapter still has a warm checkout. No network or user repository is involved.
test('forced bootstrap refresh reads new config from a warm online checkout before content refresh', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-bootstrap-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['old', 'next'].map(name => mkdir(join(root, name))));
  const old = new LocalRepository(join(root, 'old'));
  const next = new LocalRepository(join(root, 'next'));
  const path = 'content/articles/example/index.md';
  for (const [repository, title, language] of [[old, 'Before', 'zh-CN'], [next, 'After', 'en']] as const) {
    await repository.write('config.toml', `title="${title}"\ndefault_language="${language}"\nbase_url="https://example.com"\n`, null);
    await repository.write(path, `+++\ntitle="${title}"\n+++\nBody`, null);
  }
  let remote = old, clones = 0;
  const checkout = new MediaCheckout(async () => { clones++; return remote; }, async () => {}, 30_000);
  t.after(async () => checkout.clear());
  const online = new GitRepository({ url: 'https://git.example/site.git', branch: 'main', username: 'fixture', token: 'fixture', name: 'Fixture', email: 'fixture@example.com' });
  online.read = path => checkout.use(repository => repository.read(path));
  online.listForSummary = () => checkout.use(repository => repository.listForSummary());
  online.clearReadCache = () => checkout.clear();
  const origin = 'http://localhost:5173';
  const app = createApp({ repository: online, state: new FileState(join(root, '.state')), config: {
    origin, secureCookies: false, sessionSecret: 's'.repeat(32), sessionSeconds: 3600,
    username: 'owner', passwordHash: await hashPassword('fixture-password-long'),
  } });
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'fixture-password-long' }) });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0] };
  const get = async (route: string) => {
    const response = await app.request('/api' + route, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control')!, /no-store/);
    return response.json();
  };
  assert.equal((await get('/bootstrap')).site.title, 'Before');
  assert.equal((await get('/content'))[0].title, 'Before');
  const warmed = clones;
  remote = next;
  assert.equal((await get('/bootstrap')).site.title, 'Before', 'ordinary bootstrap can reuse the bounded warm checkout');
  assert.equal(clones, warmed);
  const refreshed = await get('/bootstrap?refresh=1');
  assert.equal(refreshed.site.title, 'After');
  assert.equal(refreshed.site.default_language, 'en');
  assert.ok(clones > warmed, 'forced bootstrap invalidates the underlying checkout');
  const rows = await get('/content?refresh=1');
  assert.equal(rows[0].title, 'After');
  assert.equal(rows[0].lang, 'en');
});
