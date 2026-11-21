import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkspaces, writeWorkspaces, cleanWorkspace, serviceAddress, matchWorkspace } from '../platform/workspace-registry';
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
test('archive round trips preserve full sanitized records and restore the exact ID', () => {
  let json = '';
  const storage = { getItem: () => json, setItem: (_key: string, value: string) => { json = value; } };
  const records = [profile, { ...profile, id: 'b6347560-bbe9-4c35-9d89-b0429108882b', source: 'local' as const, localPath: '/sites/blog' }, { id: 'a6347560-bbe9-4c35-9d89-b0429108882b', source: 'service' as const, label: 'Studio', address: 'https://studio.example' }];
  writeWorkspaces(storage, records.map(record => ({ ...record, archived: true, token: 'secret' })));
  const archived = readWorkspaces(storage);
  assert.ok(archived.every(record => record.archived));
  assert.equal(json.includes('secret'), false);
  writeWorkspaces(storage, archived.map(record => ({ ...record, archived: false })));
  assert.deepEqual(readWorkspaces(storage), records);
});
test('adding an existing connection reuses only an unambiguous workspace identity', () => {
  const newId = 'b6347560-bbe9-4c35-9d89-b0429108882b';
  const again = { ...profile, id: newId, label: 'Other label', url: profile.url + '/', branch: '' };
  const release = { ...profile, id: 'c6347560-bbe9-4c35-9d89-b0429108882b', branch: 'release' };
  assert.equal(matchWorkspace([profile], again), profile);
  assert.equal(matchWorkspace([profile], { ...again, branch: 'release' }), undefined);
  assert.throws(() => matchWorkspace([profile, release], again), /多个/);
  assert.equal(matchWorkspace([profile, release], { ...again, branch: 'release' }), release);
  assert.equal(matchWorkspace([{ ...profile, archived: true }], again)?.archived, true);
  const local = { ...profile, source: 'local' as const, localPath: '/sites/blog' };
  assert.equal(matchWorkspace([local], again), undefined);
  assert.equal(matchWorkspace([local], { ...local, id: newId, localPath: '/sites/blog/' }), local);
  const service = { id: profile.id, label: 'Studio', source: 'service' as const, address: 'https://studio.example' };
  assert.equal(matchWorkspace([service], { ...service, id: newId, address: 'https://STUDIO.example/' }), service);
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
