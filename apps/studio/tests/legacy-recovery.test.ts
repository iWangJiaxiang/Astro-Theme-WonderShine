import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteTransport } from '../platform/remote-transport';
import { importLegacyRecovery, legacyRecovery } from '../platform/legacy-recovery';

test('401 clears the authenticated legacy recovery context', async t => {
  const transport = createRemoteTransport('https://studio.example', async input => new URL(String(input)).pathname === '/api/auth/session'
    ? new Response(JSON.stringify({ identity: { id: 'admin', method: 'password' } }))
    : new Response('{"error":"Unauthorized"}', { status: 401 }), undefined, 'record-id');
  t.after(() => transport.dispose());
  await transport('/auth/session', { method: 'GET' });
  assert.equal(legacyRecovery.value?.current.id, 'remote:record-id:https://studio.example:admin');
  const response = await transport('/content', { method: 'GET' });
  assert.equal(response.status, 401);
  assert.equal(legacyRecovery.value, null);
});

test('disposing an old transport cannot clear a newer transport recovery context', async t => {
  const authenticate = async () => new Response(JSON.stringify({ identity: { id: 'admin', method: 'password' } }));
  const old = createRemoteTransport('https://studio.example', authenticate, undefined, 'old-record');
  const current = createRemoteTransport('https://studio.example', authenticate, undefined, 'new-record');
  t.after(() => { old.dispose(); current.dispose(); });
  await old('/auth/login', { method: 'POST' });
  const previous = legacyRecovery.value;
  await current('/auth/login', { method: 'POST' });
  const context = legacyRecovery.value;
  assert.notEqual(context, previous);
  assert.equal(context?.current.id, 'remote:new-record:https://studio.example:admin');
  old.dispose(); old.dispose();
  assert.equal(legacyRecovery.value, context);
  current.dispose();
  assert.equal(legacyRecovery.value, null);
});

for (const stage of ['fetch', 'decoding'] as const) {
  test(`disposed transport cannot authorize legacy recovery after late authentication ${stage}`, async t => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const identity = { id: 'admin', method: 'password' };
    const transport = createRemoteTransport('https://studio.example', async () => {
      if (stage === 'fetch') {
        entered();
        return new Promise<Response>(resolve => { release = () => resolve(new Response(JSON.stringify({ identity }))); });
      }
      const response = new Response();
      response.json = () => {
        entered();
        return new Promise(resolve => { release = () => resolve({ identity }); });
      };
      return response;
    }, undefined, 'record-id');
    t.after(() => transport.dispose());
    assert.equal(legacyRecovery.value, null);
    const pending = transport('/auth/login', { method: 'POST' });
    await started;
    transport.dispose();
    release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(legacyRecovery.value, null, 'late authenticated identity must not restore recovery authorization');
  });
}

test('authenticated legacy recovery copies only exact scopes, retains originals and never overwrites targets', async () => {
  const transport = createRemoteTransport('https://studio.example', async () => new Response(JSON.stringify({ identity: { id: 'admin', method: 'password' } })), undefined, 'record-id');
  await transport('/auth/config', { method: 'GET' });
  assert.equal(legacyRecovery.value, null, 'config alone cannot authorize recovery');
  const auth = await (await transport('/auth/login', { method: 'POST' })).json();
  const context = legacyRecovery.value!;
  const old = 'password:remote:https://studio.example:admin';
  const next = `password:${auth.identity.id}`;
  const sourceKeys = [`studio-draft:${old}:content/a.md`, `studio-thread-session:${old}`, `studio-thread-session:${old}:unsaved`, `studio-settings:${old}:site:default`, `studio-guide:v1:${old}`, 'studio.save-default.v1:remote:https://studio.example:admin:site'];
  const entries = new Map(sourceKeys.map(key => [key, 'legacy']));
  for (const other of ['password:remote:https://other.example:admin', 'oidc:remote:https://studio.example:admin', 'password:remote:https://studio.example:someone']) entries.set(`studio-draft:${other}:content/a.md`, 'private');
  entries.set(`studio-draft:${next}:content/a.md`, 'newer');
  const storage = { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  assert.throws(() => importLegacyRecovery(storage, context, undefined));
  assert.throws(() => importLegacyRecovery(storage, context, { ...auth.identity, method: 'oidc' }));
  assert.throws(() => importLegacyRecovery(storage, context, { ...auth.identity, id: 'other' }));
  assert.equal(importLegacyRecovery(storage, context, auth.identity), 5);
  assert.equal(entries.get(`studio-draft:${next}:content/a.md`), 'newer');
  for (const key of sourceKeys) assert.equal(entries.get(key), 'legacy');
  assert.equal(importLegacyRecovery(storage, context, auth.identity), 0, 'retry is idempotent');
  transport.dispose();
  assert.equal(legacyRecovery.value, null);
});
