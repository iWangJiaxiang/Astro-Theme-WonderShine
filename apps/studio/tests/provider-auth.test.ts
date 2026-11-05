import test from 'node:test';
import assert from 'node:assert/strict';
import { translate } from '../shared/i18n.js';
import { beginDeviceLogin, completeDeviceLogin, listRepositories, loadAccount, verificationUrl, delay, ProviderAuthError, type ProviderFetch, type ProviderAccount } from '../platform/provider-auth.js';
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
    for (const { init } of requests) { assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('User-Agent'), 'WonderShine-Studio'); assert.equal(String(init?.body).includes('client_secret'), false); }
    assert.equal(requests[0].url, origin + (provider === 'github' ? '/login/device/code' : '/oauth2/device/auth'));
    assert.equal(requests[4].init?.headers && new Headers(requests[4].init.headers).get('Authorization'), 'Bearer token-fixture');
  });
}
test('CNB uses the official CLI public-client form contract without a secret or requested scope', async () => {
  const fetcher: ProviderFetch = async (url, init) => {
    assert.equal(url, 'https://cnb.cool/oauth2/device/auth');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/x-www-form-urlencoded');
    assert.equal(init?.body, 'client_id=public-id');
    return response({ error: 'invalid_client', error_description: 'sensitive-server-detail' }, 401);
  };
  await assert.rejects(beginDeviceLogin('cnb', 'public-id', fetcher, signal()), error => error instanceof Error && error.message === '账号登录应用配置无效，请联系应用维护者');
});
test('OAuth client configuration errors are safe at both device and token endpoints', async () => {
  const grant = { deviceCode: 'device-fixture', userCode: 'ABCD', verificationUrl: 'https://cnb.cool/oauth2/device/verify', interval: 1, expiresAt: Date.now() + 60000 };
  for (const provider of ['github', 'cnb'] as const) for (const status of [400, 401]) for (const code of ['invalid_client', 'unauthorized_client']) {
    const fetcher: ProviderFetch = async () => response({ error: code, error_description: 'sensitive-server-detail', access_token: 'sensitive-token' }, status);
    const safe = (error: unknown) => error instanceof Error && error.message === '账号登录应用配置无效，请联系应用维护者';
    await assert.rejects(beginDeviceLogin(provider, 'public-id', fetcher, signal()), safe);
    await assert.rejects(completeDeviceLogin(provider, 'public-id', grant, fetcher, signal(), async () => {}), safe);
  }
  await assert.rejects(loadAccount('cnb', 'fixture', async () => response({ error: 'invalid_client' }, 401), signal()), /无法读取账号资料/);
  await assert.rejects(beginDeviceLogin('cnb', 'public-id', async () => response({ error: 'unknown', error_description: 'sensitive-server-detail' }, 401), signal()), error => error instanceof ProviderAuthError && error.message === '无法启动设备授权，请重试' && error.diagnostics === 'stage=device; HTTP=401');
});
test('provider failures identify all request stages without exposing response or transport secrets', async () => {
  const grant = { deviceCode: 'device-fixture', userCode: 'ABCD', verificationUrl: 'https://cnb.cool/oauth2/device/verify', interval: 5000, expiresAt: Date.now() + 60000 };
  const account: ProviderAccount = { provider: 'cnb', token: 'token-fixture', username: 'writer', name: 'Writer', email: '' };
  const stages = {
    device: (fetcher: ProviderFetch) => beginDeviceLogin('cnb', 'public-id', fetcher, signal()),
    token: (fetcher: ProviderFetch) => completeDeviceLogin('cnb', 'public-id', grant, fetcher, signal(), async () => {}),
    account: (fetcher: ProviderFetch) => loadAccount('cnb', 'token-fixture', fetcher, signal()),
    repos: (fetcher: ProviderFetch) => listRepositories(account, 1, fetcher, signal()),
  };
  for (const [stage, call] of Object.entries(stages)) {
    for (const status of [401, 403, 428, 429, 500]) {
      const trace = '0123456789abcdef0123456789abcdef';
      await assert.rejects(call(async () => new Response(JSON.stringify({ error: 'unknown', error_description: 'sensitive-body', access_token: 'sensitive-token' }), {
        status, headers: { 'X-Trace-Id': trace, traceparent: `00-${trace}-0123456789abcdef-01`, 'Set-Cookie': 'sensitive-cookie', 'X-Request-Id': 'sensitive-header' },
      })), error => {
        assert.ok(error instanceof ProviderAuthError);
        assert.equal(error.diagnostics, `stage=${stage}; HTTP=${status}; x-trace-id=${trace}; traceparent=00-${trace}-0123456789abcdef-01`);
        assert.doesNotMatch(error.message + error.diagnostics, /sensitive/);
        const message = { key: `${error.message}（{diagnostics}）`, params: { diagnostics: error.diagnostics } };
        assert.doesNotMatch(translate(message, 'en'), /[\u4e00-\u9fff]|\{diagnostics\}/);
        assert.match(translate(message, 'zh-CN'), /无法/);
        return true;
      });
    }
    for (const redirected of [false, true]) {
      const trace = '0123456789abcdef0123456789abcdef';
      const status = redirected ? 200 : 503;
      let cancelled = false;
      const rejected = new Response(new ReadableStream({
        cancel() { cancelled = true; throw new Error('sensitive-cleanup access_token=secret-fixture'); },
      }), { status, headers: { 'X-Trace-Id': trace } });
      if (redirected) Object.defineProperty(rejected, 'url', { value: 'https://untrusted.example/secret-fixture' });
      await assert.rejects(call(async () => rejected), error => {
        assert.ok(error instanceof ProviderAuthError);
        assert.equal(error.message, redirected ? '平台返回了无效响应' : {
          device: '无法启动设备授权，请重试', token: '无法获取授权结果，请重新登录',
          account: '无法读取账号资料，请检查授权权限', repos: '无法读取仓库，请检查授权权限',
        }[stage as keyof typeof stages]);
        assert.equal(error.diagnostics, `stage=${stage}; HTTP=${status}; x-trace-id=${trace}`);
        assert.doesNotMatch(String(error) + JSON.stringify(error), /sensitive|secret-fixture|access_token|untrusted/);
        return true;
      });
      assert.equal(cancelled, true);
    }
    await assert.rejects(call(async () => { throw new Error('sensitive-transport-url'); }), error => error instanceof ProviderAuthError && error.diagnostics === `stage=${stage}; HTTP=unavailable` && !error.message.includes('sensitive'));
    await assert.rejects(call(async () => new Response('sensitive-malformed-json', { status: 200, headers: { 'X-Trace-Id': 'sensitive-value', traceparent: 'secret', 'X-GitHub-Request-Id': 'secret' } })), error => error instanceof ProviderAuthError && error.message === '平台返回了无效响应' && error.diagnostics === `stage=${stage}; HTTP=200`);
  }
});
test('CNB pending 400 keeps polling at the prescribed interval; unknown 428 is not silently retried', async () => {
  const grant = { deviceCode: 'device-fixture', userCode: 'ABCD', verificationUrl: 'https://cnb.cool/oauth2/device/verify', interval: 5000, expiresAt: Date.now() + 60000 };
  let requests = 0;
  const waits: number[] = [];
  const token = await completeDeviceLogin('cnb', 'public-id', grant, async (_url, init) => {
    assert.equal(init?.body, 'client_id=public-id&device_code=device-fixture&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    return ++requests === 1 ? response({ error: 'authorization_pending' }, 400) : response({ access_token: 'token-fixture', token_type: 'Bearer' });
  }, signal(), async ms => { waits.push(ms); });
  assert.equal(token, 'token-fixture');
  assert.deepEqual(waits, [5000, 5000]);
  let unexpected = 0;
  await assert.rejects(completeDeviceLogin('cnb', 'public-id', grant, async () => { unexpected++; return response({ error: 'authorization_pending' }, 428); }, signal(), async () => {}), error => error instanceof ProviderAuthError && error.diagnostics === 'stage=token; HTTP=428');
  assert.equal(unexpected, 1);
});
test('local expiry after pending has no fabricated HTTP status or stale trace', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  for (const expireDuringResponse of [false, true]) {
    const grant = { deviceCode: 'device-fixture', userCode: 'ABCD', verificationUrl: 'https://cnb.cool/oauth2/device/verify', interval: 5000, expiresAt: Date.now() + 10000 };
    let requests = 0;
    const waits: number[] = [];
    await assert.rejects(completeDeviceLogin('cnb', 'public-id', grant, async () => {
      requests++;
      if (expireDuringResponse) t.mock.timers.tick(5000);
      return new Response(JSON.stringify({ error: 'authorization_pending' }), {
        status: 400, headers: { 'X-Trace-Id': '0123456789abcdef0123456789abcdef' },
      });
    }, signal(), async ms => { waits.push(ms); t.mock.timers.tick(ms); }), error => {
      assert.ok(error instanceof ProviderAuthError);
      assert.equal(error.message, '授权已过期，请重新登录');
      assert.equal(error.diagnostics, 'stage=token; HTTP=unavailable');
      return true;
    });
    assert.equal(requests, 1);
    assert.deepEqual(waits, expireDuringResponse ? [5000] : [5000, 5000]);
  }
});
test('cleanup failures preserve explicit cancellation for rejected statuses and redirects', async () => {
  for (const redirected of [false, true]) {
    const controller = new AbortController();
    const rejected = new Response(new ReadableStream({
      cancel() { controller.abort(); throw new Error('sensitive-cleanup access_token=secret-fixture'); },
    }), { status: redirected ? 200 : 503 });
    if (redirected) Object.defineProperty(rejected, 'url', { value: 'https://untrusted.example/' });
    await assert.rejects(beginDeviceLogin('cnb', 'public-id', async () => rejected, controller.signal), error => error === controller.signal.reason);
  }
});
test('cancellation remains cancellation rather than a transport diagnostic', async () => {
  const controller = new AbortController();
  await assert.rejects(beginDeviceLogin('cnb', 'public-id', async () => {
    controller.abort(); throw new Error('sensitive-transport');
  }, controller.signal), error => error === controller.signal.reason);
});
test('rejects authorization redirects to untrusted hosts', () => {
  for (const url of ['http://github.com/login/device', 'https://github.com.evil.test/login/device', 'https://user@github.com/login/device', 'https://github.com/logout']) assert.throws(() => verificationUrl('github', url));
  assert.throws(() => verificationUrl('cnb', 'https://evil.test/oauth2/device'));
});
test('cancel and expiry never issue a token request; denied errors never echo server text', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(delay(10000, controller.signal));
  const grant = { deviceCode: 'sensitive', userCode: '1234', verificationUrl: 'https://github.com/login/device', interval: 1, expiresAt: Date.now() - 1 };
  const fetcher: ProviderFetch = async () => { throw new Error('Unexpected network'); };
  await assert.rejects(completeDeviceLogin('github', 'id', grant, fetcher, signal()), error => error instanceof ProviderAuthError && error.message === '授权已过期，请重新登录' && error.diagnostics === 'stage=token; HTTP=unavailable');
  await assert.rejects(completeDeviceLogin('github', 'id', grant, fetcher, controller.signal), error => error === controller.signal.reason);
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
