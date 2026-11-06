import assert from 'node:assert/strict';
import { test } from 'node:test';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// These modules intentionally use browser globals at initialization.
Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: '' }, title: '' } });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
const { api, setApiTransport, session, reauthentication, pendingMutations } = await import('../src/api');
const { locale } = await import('../src/i18n');
const identity = (id: string) => ({ identity: { id, name: id, method: 'password' as const }, csrf: `csrf-${id}`, expires: 12345 });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function reset() {
  setApiTransport(); session.value = null; reauthentication.value = false; locale.value = 'zh-CN';
}

test('content GET shares one transport and JSON parse with isolated results, but not completed responses or other endpoints', async t => {
  t.after(reset);
  const response = deferred<Response>();
  let requests = 0, parses = 0;
  setApiTransport(() => { requests++; return response.promise; });
  const a = api<{ tags: string[] }[]>('/content');
  const b = api<{ tags: string[] }[]>('/content');
  const result = new Response();
  result.json = async () => { parses++; return [{ tags: ['original'] }]; };
  response.resolve(result);
  const [first, second] = await Promise.all([a, b]);
  assert.equal(requests, 1); assert.equal(parses, 1);
  first[0].tags.push('edited'); first.push({ tags: [] });
  assert.deepEqual(second, [{ tags: ['original'] }]);
  await api('/content'); assert.equal(requests, 2);
  await Promise.all([api('/document?path=a'), api('/document?path=a')]);
  assert.equal(requests, 4); assert.equal(pendingMutations.value, 0);
});

test('transport, session replacement, csrf, identity and locale changes promptly reject stuck old readers', { timeout: 1000 }, async t => {
  t.after(reset);
  for (const change of ['transport', 'transport-reused', 'session', 'csrf', 'identity', 'locale', 'session-roundtrip']) {
    session.value = identity('old'); locale.value = 'zh-CN'; reauthentication.value = false;
    const old = deferred<Response>();
    const headers: Headers[] = [];
    let calls = 0;
    const transport = async (_path: string, init: RequestInit) => {
      headers.push(new Headers(init.headers));
      return ++calls === 1 ? old.promise : Response.json(['new']);
    };
    setApiTransport(transport);
    const pending = api('/content');
    const rejected = assert.rejects(pending, /连接已更换/);
    await tick();
    if (change === 'transport') setApiTransport(async () => Response.json(['new']));
    if (change === 'transport-reused') setApiTransport(transport);
    if (change === 'session') session.value = identity('new');
    if (change === 'csrf') session.value!.csrf = 'rotated';
    if (change === 'identity') session.value!.identity.id = 'new';
    if (change === 'locale') locale.value = 'en';
    if (change === 'session-roundtrip') { const previous = session.value; session.value = null; session.value = previous; }
    assert.deepEqual(await api('/content'), ['new']);
    await rejected;
    old.resolve(Response.json({ error: 'expired' }, { status: 401 }));
    await tick();
    assert.equal(reauthentication.value, false, change);
    if (change === 'csrf') assert.equal(headers[1].get('X-CSRF-Token'), 'rotated');
    if (change === 'locale') assert.equal(headers[1].get('Accept-Language'), 'en');
  }
});

test('scope switches promptly reject even when JSON decoding never settles', { timeout: 1000 }, async t => {
  t.after(reset); session.value = identity('old');
  const decoded = deferred<unknown>();
  const entered = deferred<void>();
  const response = new Response();
  response.json = () => { entered.resolve(); return decoded.promise; };
  setApiTransport(async () => response);
  const old = api('/content');
  const rejected = assert.rejects(old, /连接已更换/);
  await entered.promise;
  session.value = identity('new');
  await rejected;
});

test('explicit refresh wakes a never-settling ordinary transport and redirects its readers', { timeout: 1000 }, async t => {
  t.after(reset);
  const old = deferred<Response>(), fresh = deferred<Response>();
  const paths: string[] = [];
  setApiTransport(path => { paths.push(path); return path.includes('refresh=1') ? fresh.promise : old.promise; });
  const a = api('/content'); await tick();
  const b = api('/content?refresh=1');
  const c = api('/content'); await tick();
  assert.deepEqual(paths, ['/content', '/content?refresh=1']);
  fresh.resolve(Response.json(['fresh']));
  assert.deepEqual(await Promise.all([a, b, c]), [['fresh'], ['fresh'], ['fresh']]);
});

test('each explicit refresh starts a new generation even if another refresh is pending', async t => {
  t.after(reset);
  const first = deferred<Response>(), second = deferred<Response>();
  let calls = 0;
  setApiTransport(() => ++calls === 1 ? first.promise : second.promise);
  const a = api('/content?refresh=1'); await tick();
  const b = api('/content?refresh=1'); await tick();
  assert.equal(calls, 2);
  first.resolve(Response.json(['superseded'])); await tick();
  second.resolve(Response.json(['latest']));
  assert.deepEqual(await Promise.all([a, b]), [['latest'], ['latest']]);
});

test('writes invalidate both boundaries; overlapping reads wait and cannot restore pre-write lists', async t => {
  t.after(reset);
  const old = deferred<Response>(), write = deferred<Response>();
  let reads = 0, writes = 0;
  setApiTransport(async (_path, init) => {
    if (init.method !== 'GET') { writes++; return write.promise; }
    return ++reads === 1 ? old.promise : Response.json(['saved']);
  });
  const before = api('/content'); await tick();
  const save = api('/document', 'PUT', { title: 'saved' });
  const during = api('/content'); await tick();
  assert.equal(pendingMutations.value, 1); assert.equal(reads, 1); assert.equal(writes, 1);
  await assert.rejects(api('/auth/logout', 'POST'), /正在保存/);
  old.resolve(Response.json(['old'])); await tick();
  assert.equal(reads, 1);
  write.resolve(Response.json({})); await save;
  assert.deepEqual(await Promise.all([before, during]), [['saved'], ['saved']]);
  assert.equal(pendingMutations.value, 0); assert.equal(writes, 1);
});

test('a refresh waiting behind mutations retains refresh=1 when an ordinary retry wins the key', { timeout: 1000 }, async t => {
  t.after(reset);
  for (const refreshFirst of [false, true]) {
    const write = deferred<Response>();
    const paths: string[] = [];
    setApiTransport(async (path, init) => {
      if (init.method !== 'GET') return write.promise;
      paths.push(path);
      // A normal transport deliberately never settles. The forced read must
      // supersede it rather than depend on its response or timeout.
      if (!path.includes('refresh=1')) return new Promise<Response>(() => {});
      return Response.json(['forced']);
    });
    const save = api('/document', 'PUT', {});
    const first = api(refreshFirst ? '/content?refresh=1' : '/content');
    await tick();
    const second = api(refreshFirst ? '/content' : '/content?refresh=1');
    await tick();
    assert.deepEqual(paths, []);
    write.resolve(Response.json({})); await save;
    assert.deepEqual(await Promise.all([first, second]), [['forced'], ['forced']]);
    assert.ok(paths.includes('/content?refresh=1'));
    assert.equal(pendingMutations.value, 0);
  }
});

test('failed mutations also release waiting readers and logout retains its transport-switch exception', async t => {
  t.after(reset);
  const write = deferred<Response>();
  setApiTransport(async (_path, init) => init.method === 'GET' ? Response.json(['current']) : write.promise);
  const save = api('/document', 'PUT', {});
  const rejected = assert.rejects(save, /conflict/);
  const read = api('/content');
  write.resolve(Response.json({ error: 'conflict' }, { status: 409 }));
  await rejected; assert.deepEqual(await read, ['current']); assert.equal(pendingMutations.value, 0);
  const logoutResponse = deferred<Response>();
  setApiTransport(() => logoutResponse.promise);
  const logout = api('/auth/logout', 'POST');
  await assert.rejects(api('/content'), /正在保存/);
  await assert.rejects(api('/document', 'PUT', {}), /正在保存/);
  setApiTransport(async () => Response.json({}));
  logoutResponse.resolve(Response.json({})); await logout;
  assert.equal(pendingMutations.value, 0);
});

test('multiple writes count once each and readers wait for the final writer', async t => {
  t.after(reset);
  const first = deferred<Response>(), second = deferred<Response>();
  let writes = 0, reads = 0;
  setApiTransport(async (_path, init) => {
    if (init.method !== 'GET') return ++writes === 1 ? first.promise : second.promise;
    reads++; return Response.json(['final']);
  });
  const a = api('/document', 'PUT', {}), b = api('/settings/site', 'PUT', {});
  const read = api('/content'); await tick();
  assert.equal(pendingMutations.value, 2); assert.equal(reads, 0);
  first.resolve(Response.json({})); await a; await tick();
  assert.equal(pendingMutations.value, 1); assert.equal(reads, 0);
  second.resolve(Response.json({})); await b;
  assert.deepEqual(await read, ['final']);
  assert.equal(pendingMutations.value, 0); assert.equal(reads, 1); assert.equal(writes, 2);
});

test('an old list reader receives refresh data before its obsolete transport settles', { timeout: 1000 }, async t => {
  t.after(reset);
  const old = deferred<Response>();
  let calls = 0;
  setApiTransport(async () => ++calls === 1 ? old.promise : Response.json(['current']));
  const before = api('/content'); await tick();
  assert.deepEqual(await api('/content?refresh=1'), ['current']);
  assert.deepEqual(await before, ['current']); assert.equal(calls, 2);
  old.reject(new Error('orphan transport failure')); await tick();
});

test('query variants are separate while equivalent parameter order shares pending work', async t => {
  t.after(reset);
  const pending = deferred<Response>();
  let calls = 0;
  setApiTransport(async () => { calls++; return pending.promise; });
  const a = api('/content?language=en&type=article');
  const b = api('/content?type=article&language=en');
  const c = api('/content?language=zh&type=article');
  const response = new Response(); response.json = async () => [];
  pending.resolve(response);
  await Promise.all([a, b, c]); assert.equal(calls, 2);
});

test('network and timeout failures are shared but retry starts a new request', async t => {
  t.after(reset);
  for (const error of [new Error('network'), new DOMException('timeout', 'TimeoutError')]) {
    const response = deferred<Response>();
    let calls = 0;
    setApiTransport(() => { calls++; return response.promise; });
    const a = api('/content'), b = api('/content');
    const failures = Promise.all([assert.rejects(a, { status: 408 }), assert.rejects(b, { status: 408 })]);
    response.reject(error); await failures; assert.equal(calls, 1);
    await assert.rejects(api('/content'), { status: 408 }); assert.equal(calls, 2);
  }
});
