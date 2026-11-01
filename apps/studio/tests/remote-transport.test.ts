import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteTransport } from '../platform/remote-transport';

test('native remote login isolates credentials per backend, retains CSRF and clears logout', async () => {
  let calls = 0, closed = false;
  const transport = createRemoteTransport('https://studio.example', async (input, init) => {
    assert.equal(new URL(String(input)).origin, 'https://studio.example');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Origin'), 'https://studio.example');
    if (calls++ === 0) {
      assert.equal(headers.get('Cookie'), null);
      return new Response(JSON.stringify({ identity: { id:'owner', name:'Owner', method:'password' }, csrf:'csrf-token' }), { headers: { 'set-cookie':'__Host-studio-session=session-token; Path=/; Secure; HttpOnly; SameSite=Lax' } });
    }
    assert.equal(headers.get('Cookie'), '__Host-studio-session=session-token');
    assert.equal(headers.get('X-CSRF-Token'), 'csrf-token');
    return new Response('{"ok":true}');
  }, () => { closed = true; });
  const data = await (await transport('/auth/login', { method:'POST', body:'{}' })).json();
  assert.equal(data.identity.id, 'remote:https://studio.example:owner'); assert.equal(data.csrf,'csrf-token');
  await transport('/auth/logout', { method:'POST', headers:{ 'X-CSRF-Token':'csrf-token' } }); assert.equal(closed,true);
});
test('native remote transport rejects unsafe addresses, path escape and redirect', async () => {
  for (const address of ['http://studio.example','https://token@studio.example','https://studio.example/subdir','https://studio.example?token=x']) assert.throws(() => createRemoteTransport(address, fetch));
  let called = false;
  const transport = createRemoteTransport('https://studio.example', async () => { called=true; return new Response(null, {status:302,headers:{location:'https://other.example'}}); });
  await assert.rejects(transport('//other.example', {})); assert.equal(called,false);
  await assert.rejects(transport('/../secret', {})); assert.equal(called,false);
  await assert.rejects(transport('/auth/login', {}), /重定向/);
});

test('remote media queries preserve spaces, parentheses and Unicode without escaping the API origin', async () => {
  let query = '';
  const transport = createRemoteTransport('https://studio.example', async input => { query = new URL(String(input)).searchParams.get('filename') || ''; return new Response('{}'); });
  const filename = "my photo (今天)'s.png";
  await transport('/media/upload?' + new URLSearchParams({directory:'public/uploads', filename}), {method:'POST'});
  assert.equal(query, filename);
  await assert.rejects(transport('/%2e%2e/secret', {}));
});

test('remote logout completes its response before showing another connection', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>, disconnected = false;
  const body = new ReadableStream<Uint8Array>({start(value) { controller = value; }});
  const transport = createRemoteTransport('https://studio.example', async () => new Response(body), () => { disconnected = true; });
  const pending = transport('/auth/logout', {method:'POST'});
  await new Promise(resolve => setTimeout(resolve,0)); assert.equal(disconnected,false);
  controller.enqueue(new TextEncoder().encode('{"ok":true}')); controller.close();
  assert.deepEqual(await (await pending).json(),{ok:true}); assert.equal(disconnected,true);
});


test('disposing a remote session aborts in-flight requests and rejects reuse', async () => {
  let active!: AbortSignal;
  let calls = 0;
  const transport = createRemoteTransport('https://studio.example', async (_input, init) => {
    calls++;
    active = init!.signal!;
    return new Promise<Response>((_resolve, reject) => active.addEventListener('abort', () => reject(active.reason), { once: true }));
  });
  const pending = transport('/content', { method: 'GET' });
  transport.dispose(); transport.dispose();
  assert.equal(active.aborted, true);
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(transport('/auth/session', {}), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('caller cancellation is retained and cancelled requests never reach native HTTP', async () => {
  const caller = new AbortController(); caller.abort();
  let calls = 0;
  const transport = createRemoteTransport('https://studio.example', async () => { calls++; return new Response('{}'); });
  await assert.rejects(transport('/content', { signal: caller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('remote requests have bounded deadlines without retrying writes', async context => {
  const deadlines: number[] = [];
  const controllers: AbortController[] = [];
  context.mock.method(AbortSignal, 'timeout', (duration: number) => {
    deadlines.push(duration);
    const controller = new AbortController(); controllers.push(controller); return controller.signal;
  });
  let calls = 0;
  const transport = createRemoteTransport('https://studio.example', async (_input, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject('Request cancelled'), { once: true }));
  });
  for (const [path, method] of [['/auth/config', 'GET'], ['/media/file?path=test.png', 'GET'], ['/ai/image', 'POST']]) {
    const pending = transport(path, { method });
    controllers.at(-1)!.abort(new DOMException('Timed out', 'TimeoutError'));
    await assert.rejects(pending, { name: 'TimeoutError' });
  }
  assert.deepEqual(deadlines, [15_000, 60_000, 300_000]);
  assert.equal(calls, 3);
});

test('discarded redirect and late response bodies release their native resources', async () => {
  for (const late of [false, true]) {
    let cancelled = false;
    let release!: (response: Response) => void;
    const transport = createRemoteTransport('https://studio.example', () => new Promise(resolve => { release = resolve; }));
    const pending = transport('/auth/login', { method: 'POST' });
    if (late) transport.dispose();
    release(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: late ? 200 : 302 }));
    await assert.rejects(pending, late ? { name: 'AbortError' } : /重定向/);
    assert.equal(cancelled, true);
  }
});

test('disconnect during authentication decoding cannot restore an old session', async () => {
  let release!: (data: unknown) => void;
  let entered!: () => void;
  const decoding = new Promise<void>(resolve => { entered = resolve; });
  const response = new Response();
  response.json = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const transport = createRemoteTransport('https://studio.example', async () => response);
  const pending = transport('/auth/login', { method: 'POST' });
  await decoding; transport.dispose();
  release({ identity: { id: 'old-user' } });
  await assert.rejects(pending, { name: 'AbortError' });
});


test('native authentication body cancellation preserves the timeout reason', async context => {
  const deadline = new AbortController();
  context.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  let entered!: () => void;
  const decoding = new Promise<void>(resolve => { entered = resolve; });
  const transport = createRemoteTransport('https://studio.example', async (_input, init) => {
    const response = new Response();
    response.json = () => {
      entered();
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject('Request cancelled'), { once: true }));
    };
    return response;
  });
  const pending = transport('/auth/config', { method: 'GET' });
  await decoding;
  deadline.abort(new DOMException('Timed out', 'TimeoutError'));
  await assert.rejects(pending, { name: 'TimeoutError' });
});
