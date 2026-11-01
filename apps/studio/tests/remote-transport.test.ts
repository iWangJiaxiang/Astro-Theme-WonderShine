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
