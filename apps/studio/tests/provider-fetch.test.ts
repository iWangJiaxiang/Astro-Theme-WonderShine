import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderFetch } from '../platform/provider-fetch.js';
import { loadAccount, listRepositories, ProviderAuthError } from '../platform/provider-auth.js';

const token = 'fixture-token';
const init = () => ({ headers: { Authorization: `Bearer ${token}` } });
const repos = 'https://api.cnb.cool/user/repos?page_size=100&page=2&role=Developer&status=active';
const noFallback = async (): Promise<Response> => { throw new Error('Unexpected generic HTTP'); };

test('CNB account and paginated repositories use the actual command contract', async () => {
  const calls: unknown[] = [];
  const fetcher = createProviderFetch(noFallback, async (command, args) => {
    calls.push([command, args]);
    return { status: 200, headers: [], body: JSON.stringify(args.resource === 'account'
      ? { username: 'fixture' } : [{ id: 1, path: 'fixture/blog', visibility_level: 'public' }]) };
  });
  const account = await loadAccount('cnb', token, fetcher, new AbortController().signal);
  const result = await listRepositories(account, 2, fetcher, new AbortController().signal);
  assert.equal(result.repositories[0].url, 'https://cnb.cool/fixture/blog.git');
  assert.deepEqual(calls, [
    ['cnb_account_get', { resource: 'account', token }],
    ['cnb_account_get', { resource: 'repos', page: 2, token }],
  ]);
  const response = await fetcher(repos, init());
  assert.equal(response.url, repos);
});

test('only exact CNB discovery URLs are routed; all other HTTP is unchanged', async () => {
  const fetcher = createProviderFetch(async (url, options) => {
    assert.equal(options, optionsByReference);
    return new Response(url);
  }, async () => { throw new Error('Unexpected native discovery'); });
  const optionsByReference = init();
  for (const url of [
    'https://api.github.com/user', 'https://cnb.cool/oauth2/token', 'https://git.example.test/repo.git',
    'https://api.cnb.cool/other', 'http://api.cnb.cool/user', 'https://api.cnb.cool:443/user',
    'https://user@api.cnb.cool/user', 'https://api.cnb.cool/user#x', 'https://api.cnb.cool/a/../user',
    repos + '&extra=1', repos.replace('page=2', 'page=0'), repos.replace('page=2', 'page=1000001'),
    repos.replace('page=2', 'page=02'), repos.replace('Developer', 'Owner'),
  ]) assert.equal(await (await fetcher(url, optionsByReference)).text(), url);
});

test('native discovery refuses method/body/header/cookie overrides before IPC', async () => {
  let calls = 0;
  const fetcher = createProviderFetch(noFallback, async () => { calls++; throw new Error('must not invoke'); });
  for (const options of [
    { ...init(), method: 'POST' }, { ...init(), body: 'x' }, { ...init(), credentials: 'include' as const },
    { ...init(), redirect: 'follow' as const }, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://cnb.cool' } },
    { headers: { Authorization: `Bearer ${token}`, Cookie: 'x=y' } }, { headers: { Authorization: 'Bearer a b' } },
    { headers: { Authorization: `Bearer ${'x'.repeat(8193)}` } }, {},
  ]) await assert.rejects(fetcher('https://api.cnb.cool/user', options), /Invalid CNB discovery request/);
  assert.equal(calls, 0);
});

test('safe HTTP status/trace metadata and sanitized invoke errors reach provider stages', async () => {
  const fetcher = createProviderFetch(noFallback, async () => ({
    status: 403, headers: [['x-trace-id', '0123456789abcdef']], body: '',
  }));
  await assert.rejects(loadAccount('cnb', token, fetcher, new AbortController().signal), error => {
    assert.ok(error instanceof ProviderAuthError);
    assert.equal(error.diagnostics, 'stage=account; HTTP=403; x-trace-id=0123456789abcdef');
    return true;
  });
  for (const call of [async () => { throw new Error('secret-network-token'); }, () => { throw 'secret-ipc-token'; }]) {
    const broken = createProviderFetch(noFallback, call);
    await assert.rejects(broken('https://api.cnb.cool/user', init()), /^Error: CNB discovery unavailable$/);
    await assert.rejects(loadAccount('cnb', token, broken, new AbortController().signal), error => {
      assert.ok(error instanceof ProviderAuthError);
      assert.equal(error.diagnostics, 'stage=account; HTTP=unavailable');
      return true;
    });
  }
});

test('cancellation skips pre-aborted IPC and rejects promptly while consuming late results/errors', async () => {
  let calls = 0;
  const aborted = new AbortController(); aborted.abort();
  const never = createProviderFetch(noFallback, async () => { calls++; return new Promise(() => {}); });
  await assert.rejects(never('https://api.cnb.cool/user', { ...init(), signal: aborted.signal }));
  assert.equal(calls, 0);
  const immediate = new AbortController();
  const beforeInvoke = never('https://api.cnb.cool/user', { ...init(), signal: immediate.signal });
  immediate.abort();
  await assert.rejects(beforeInvoke, { name: 'AbortError' });
  assert.equal(calls, 0);
  for (const fail of [false, true]) {
    let finish!: () => void;
    const fetcher = createProviderFetch(noFallback, () => new Promise((resolve, reject) => {
      finish = () => fail ? reject('secret-late-error') : resolve({ status: 200, headers: [], body: '{}' });
    }));
    const controller = new AbortController();
    const pending = fetcher('https://api.cnb.cool/user', { ...init(), signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    finish();
    await new Promise(resolve => setImmediate(resolve));
  }
});
