import assert from 'node:assert/strict';
import { test } from 'node:test';

test('switching backend during JSON decoding cannot return the previous session', async () => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: '' }, title: '' } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
  const { api, setApiTransport, session, reauthentication } = await import('../src/api');
  let release!: () => void;
  let decoding!: () => void;
  const entered = new Promise<void>(resolve => { decoding = resolve; });
  const response = new Response();
  response.json = () => { decoding(); return new Promise(resolve => { release = () => resolve({ identity: {id:'old-user'}, csrf:'old-token' }); }); };
  setApiTransport(async () => response);
  const pending = api('/auth/login', 'POST', {});
  await entered;
  setApiTransport(async () => new Response('{}'));
  release();
  await assert.rejects(pending, /连接已更换/);
  assert.equal(session.value, null); assert.equal(reauthentication.value, false);
  setApiTransport();
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'localStorage');
});

test('native autosave preferences persist without WebView cookies', async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable:true, value:{__TAURI_INTERNALS__:{}} });
  Object.defineProperty(globalThis, 'localStorage', { configurable:true, value:{getItem:(key:string)=>storage.get(key) ?? null, setItem:(key:string,value:string)=>storage.set(key,value)} });
  const { readAutosavePreference, writeAutosavePreference } = await import('../src/autosave');
  assert.equal(readAutosavePreference(),0); writeAutosavePreference(300); assert.equal(readAutosavePreference(),300);
  writeAutosavePreference(123); assert.equal(readAutosavePreference(),0);
  Reflect.deleteProperty(globalThis,'window'); Reflect.deleteProperty(globalThis,'localStorage');
});
