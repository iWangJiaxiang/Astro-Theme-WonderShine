import test from 'node:test';
import assert from 'node:assert/strict';
import { beginDeviceLogin, completeDeviceLogin, listRepositories, loadAccount, verificationUrl, delay, type ProviderFetch, type ProviderAccount } from '../platform/provider-auth.js';
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const signal = () => new AbortController().signal;
for (const provider of ['github', 'cnb'] as const) {
  test(`${provider}: public client login, pending, backoff, account and writable repositories`, async () => {
    const requests: { url: string; init?: RequestInit }[] = [], intervals: number[] = [];
    const origin = provider === 'github' ? 'https://github.com' : 'https://cnb.cool';
    const verify = origin + (provider === 'github' ? '/login/device' : '/oauth2/device/verify?user_code=ABCD');
    const answers = [response({ device_code: 'device-fixture', user_code: 'ABCD', verification_uri: verify, expires_in: 600, interval: 5 }),
      response({ error: 'authorization_pending' }, provider === 'github' ? 200 : 400), response({ error: 'slow_down' }, 400), response({ access_token: 'token-fixture', token_type: 'bearer' }),
      response(provider === 'github' ? { login: 'writer', name: 'Writer' } : { username: 'writer', nickname: 'Writer' }),
      response(provider === 'github' ? [{ id: 1, full_name: 'writer/blog', default_branch: 'main', private: true, permissions: { push: true } }, { id: 2, full_name: 'writer/archived', archived: true, permissions: { push: true } }, { id: 3, full_name: 'other/readonly', permissions: { push: false } }]
        : [{ id: '1', path: 'writer/blog', visibility_level: 'private' }, { id: '2', path: 'writer/frozen', freeze: true }])];
    const fetcher: ProviderFetch = async (url, init) => { requests.push({ url, init }); return answers.shift()!; };
    const grant = await beginDeviceLogin(provider, 'public-id', fetcher, signal());
    assert.equal(grant.verificationUrl, verify);
    const token = await completeDeviceLogin(provider, 'public-id', grant, fetcher, signal(), async ms => { intervals.push(ms); });
    assert.deepEqual(intervals, [5000, 5000, 10000]);
    const account = await loadAccount(provider, token, fetcher, signal());
    const result = await listRepositories(account, 1, fetcher, signal());
    assert.equal(result.repositories.length, 1); assert.equal(result.repositories[0].url, `${origin}/writer/blog.git`);
    assert.equal(result.repositories[0].branch, provider === 'github' ? 'main' : '');
    for (const { init } of requests) { assert.equal(init?.redirect, 'error'); assert.equal(String(init?.body).includes('client_secret'), false); }
    assert.equal(requests[0].url, origin + (provider === 'github' ? '/login/device/code' : '/oauth2/device/auth'));
    assert.equal(requests[4].init?.headers && new Headers(requests[4].init.headers).get('Authorization'), 'Bearer token-fixture');
  });
}
test('rejects authorization redirects to untrusted hosts', () => {
  for (const url of ['http://github.com/login/device', 'https://github.com.evil.test/login/device', 'https://user@github.com/login/device', 'https://github.com/logout']) assert.throws(() => verificationUrl('github', url));
  assert.throws(() => verificationUrl('cnb', 'https://evil.test/oauth2/device'));
});
test('cancel and expiry never issue a token request; denied errors never echo server text', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(delay(10000, controller.signal));
  const grant = { deviceCode: 'sensitive', userCode: '1234', verificationUrl: 'https://github.com/login/device', interval: 1, expiresAt: Date.now() - 1 };
  const fetcher: ProviderFetch = async () => { throw new Error('Unexpected network'); };
  await assert.rejects(completeDeviceLogin('github', 'id', grant, fetcher, signal()), /授权已过期/);
  await assert.rejects(beginDeviceLogin('github', '', fetcher, signal()), /尚未配置/);
  await assert.rejects(completeDeviceLogin('github', 'id', { ...grant, expiresAt: Date.now() + 60000 }, async () => response({ error: 'access_denied', error_description: 'sensitive-secret' }), signal(), async () => {}), error => error instanceof Error && error.message === '已取消授权');
});
test('repository pagination and origin are constrained', async () => {
  const account: ProviderAccount = { provider: 'cnb', token: 'secret', username: 'writer', name: 'Writer', email: '' };
  let url = '';
  const result = await listRepositories(account, 2, async input => { url = input; return response(Array.from({ length: 100 }, (_, id) => ({ id, path: `writer/blog${id}` }))); }, signal());
  assert.equal(result.more, true); assert.match(url, /page=2/);
  await assert.rejects(listRepositories(account, 0, async () => response([]), signal()));
  await assert.rejects(listRepositories(account, 1, async () => response([{ id: 1, path: '../evil' }]), signal()));
});
