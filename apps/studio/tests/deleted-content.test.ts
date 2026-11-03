import test from 'node:test';
import assert from 'node:assert/strict';
import { forgetDeletedContent } from '../src/deleted-content.js';

const identity = { method: 'password' as const, id: 'owner' };
const path = 'content/threads/n_one/index.md';
const translated = 'content/threads/n_one/index.en.md';
const sessionKey = 'studio-thread-session:password:owner';
const backupKey = (path: string) => `studio-draft:password:owner:${path}`;
const draft = (path: string) => ({ path, initial: { draft: true }, initialBody: 'Unsaved work' });

function memory(entries: Record<string, string>) {
  const values = new Map(Object.entries(entries));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test('deleting from a list or detail removes recoverable copies of only the exact language and account', () => {
  const otherPath = 'content/threads/n_other/index.md';
  const otherSession = 'studio-thread-session:oidc:owner';
  const otherBackup = `studio-draft:oidc:owner:${path}`;
  const storage = memory({
    [backupKey(path)]: 'deleted backup', [backupKey(translated)]: 'English backup', [backupKey(otherPath)]: 'Other backup',
    [sessionKey]: JSON.stringify(draft(path)),
    [`${sessionKey}:unsaved`]: JSON.stringify([draft(path), draft(translated), draft(otherPath), draft(path)]),
    [otherSession]: JSON.stringify(draft(path)), [otherBackup]: 'Other account backup',
    [`${otherSession}:unsaved`]: JSON.stringify([draft(path)]),
  });
  forgetDeletedContent(storage, identity, path);
  assert.equal(storage.getItem(backupKey(path)), null);
  assert.equal(storage.getItem(sessionKey), null);
  assert.deepEqual(JSON.parse(storage.getItem(`${sessionKey}:unsaved`)!), [draft(translated), draft(otherPath)]);
  assert.equal(storage.getItem(backupKey(translated)), 'English backup');
  assert.equal(storage.getItem(backupKey(otherPath)), 'Other backup');
  assert.equal(storage.getItem(otherSession), JSON.stringify(draft(path)));
  assert.equal(storage.getItem(otherBackup), 'Other account backup');
  assert.equal(storage.getItem(`${otherSession}:unsaved`), JSON.stringify([draft(path)]));
});

test('an unrelated active composer and its draft queue remain unchanged', () => {
  const active = JSON.stringify(draft(translated));
  const pending = JSON.stringify([draft(translated)]);
  const storage = memory({ [sessionKey]: active, [`${sessionKey}:unsaved`]: pending });
  forgetDeletedContent(storage, identity, path);
  assert.equal(storage.getItem(sessionKey), active);
  assert.equal(storage.getItem(`${sessionKey}:unsaved`), pending);
  assert.equal(storage.values.size, 2);
});

test('all content kinds clear their editor backup and repeated cleanup is harmless', () => {
  const article = 'content/articles/example/index.en.md';
  const storage = memory({ [backupKey(article)]: 'Recovered article', [sessionKey]: JSON.stringify(draft(path)) });
  forgetDeletedContent(storage, identity, article);
  forgetDeletedContent(storage, identity, article);
  assert.equal(storage.getItem(backupKey(article)), null);
  assert.equal(storage.getItem(sessionKey), JSON.stringify(draft(path)));
});

test('malformed session data is preserved while other matching copies are removed', () => {
  const storage = memory({ [backupKey(path)]: 'Backup', [sessionKey]: '{broken', [`${sessionKey}:unsaved`]: JSON.stringify([null, 'unknown', draft(path), draft(translated)]) });
  forgetDeletedContent(storage, identity, path);
  assert.equal(storage.getItem(backupKey(path)), null);
  assert.equal(storage.getItem(sessionKey), '{broken');
  assert.deepEqual(JSON.parse(storage.getItem(`${sessionKey}:unsaved`)!), [null, 'unknown', draft(translated)]);
  storage.setItem(`${sessionKey}:unsaved`, '{broken');
  assert.doesNotThrow(() => forgetDeletedContent(storage, identity, path));
  assert.equal(storage.getItem(`${sessionKey}:unsaved`), '{broken');
});

test('one failed storage operation does not skip cleanup of the remaining keys', () => {
  const storage = memory({ [sessionKey]: JSON.stringify(draft(path)), [`${sessionKey}:unsaved`]: JSON.stringify([draft(path)]) });
  const remove = storage.removeItem;
  storage.removeItem = key => { if (key === backupKey(path)) throw new Error('Storage denied'); remove(key); };
  assert.doesNotThrow(() => forgetDeletedContent(storage, identity, path));
  assert.equal(storage.getItem(sessionKey), null);
  assert.deepEqual(JSON.parse(storage.getItem(`${sessionKey}:unsaved`)!), []);
});
