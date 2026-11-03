import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkspaces, writeWorkspaces, cleanWorkspace, serviceAddress } from '../platform/workspace-registry';
import { createRemoteTransport } from '../platform/remote-transport';

const profile = { id: 'f6347560-bbe9-4c35-9d89-b0429108882b', label: 'Blog', provider: 'generic' as const, url: 'https://git.example/blog.git', branch: 'main', username: '', authorName: '', authorEmail: '' };
test('v1 native IDs survive mixed registry round trips and only allowed fields persist', () => {
  let json = JSON.stringify([{ ...profile, token: 'secret' }]);
  const storage = { getItem: () => json, setItem: (_key: string, value: string) => { json = value; } };
  const records = readWorkspaces(storage);
  const service = cleanWorkspace({ id: 'a6347560-bbe9-4c35-9d89-b0429108882b', label: 'Studio', source: 'service', address: 'https://studio.example/' });
  writeWorkspaces(storage, [...records, service]);
  assert.equal(readWorkspaces(storage)[0].id, profile.id);
  assert.equal(json.includes('secret'), false);
  writeWorkspaces(storage, [{ ...service, label: 'Renamed' }]);
  assert.equal(readWorkspaces(storage)[0].id, service.id);
});
test('invalid storage and write failures are not silently replaced', () => {
  assert.throws(() => readWorkspaces({ getItem: () => '{' }));
  assert.throws(() => readWorkspaces({ getItem: () => JSON.stringify([profile, profile]) }));
  assert.throws(() => writeWorkspaces({ setItem: () => { throw new Error('quota'); } }, [profile]), /quota/);
  for (const address of ['http://studio.example', 'https://user:secret@studio.example', 'https://studio.example/?token=secret', 'https://studio.example/path']) assert.throws(() => serviceAddress(address));
});
test('service scopes separate identical accounts, cookies never cross workspace instances', async () => {
  const cookies: (string | null)[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    cookies.push(new Headers(init?.headers).get('Cookie'));
    return new Response(JSON.stringify({ identity: { id: 'admin' }, csrf: 'csrf-original' }), { headers: { 'set-cookie': '__Host-studio-session=secret; Secure' } });
  };
  const a = createRemoteTransport('https://studio.example', fetcher, undefined, 'workspace-a');
  const b = createRemoteTransport('https://studio.example', fetcher, undefined, 'workspace-b');
  const first = await (await a('/auth/login', { method: 'POST' })).json();
  const second = await (await b('/auth/login', { method: 'POST' })).json();
  assert.notEqual(first.identity.id, second.identity.id);
  assert.equal(first.csrf, 'csrf-original');
  assert.deepEqual(cookies, [null, null]);
  a.dispose(); b.dispose();
  await assert.rejects(() => a('/auth/session', { method: 'GET' }));
});
