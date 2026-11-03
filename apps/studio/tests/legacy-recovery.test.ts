import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteTransport } from '../platform/remote-transport';
import { importLegacyRecovery, legacyRecovery } from '../platform/legacy-recovery';

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
