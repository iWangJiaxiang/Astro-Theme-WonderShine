import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialLibraryState, libraryStateMemory } from '../src/library-state';

const state = { search: 'Unpublished series', status: 'draft', folder: 'content/collections/series/_index.md', page: 3 };

test('library remount restores selected language and independent list-kind/language state', () => {
  const memory = libraryStateMemory();
  memory.activate('password:owner:workspace-a');
  const first = memory.capture('collection');
  first.write('zh', state);
  first.write('en', { ...state, search: 'English', page: 2 });
  const remount = memory.capture('collection');
  assert.equal(remount.language(), 'en');
  assert.deepEqual(remount.read('zh'), state);
  assert.equal(remount.read('en')?.search, 'English');
  assert.equal(memory.capture('article').language(), undefined);
  assert.equal(memory.capture('article').read('zh'), undefined);
});

test('same account/workspace activation preserves state without sharing mutable references', () => {
  const memory = libraryStateMemory();
  memory.activate('password:owner:workspace-a');
  const lease = memory.capture('article');
  const input = { ...state };
  lease.write('zh', input);
  input.search = 'Changed outside memory';
  assert.equal(memory.activate('password:owner:workspace-a'), false);
  const restored = memory.capture('article').read('zh')!;
  assert.equal(restored.search, state.search);
  restored.page = 999;
  assert.equal(lease.read('zh')?.page, 3);
});

for (const transition of [null, 'oidc:owner:workspace-a', 'password:other:workspace-a', 'password:owner:workspace-b']) {
  test(`account/workspace boundary ${transition} erases memory and invalidates old writers`, () => {
    const memory = libraryStateMemory();
    memory.activate('password:owner:workspace-a');
    const old = memory.capture('page');
    old.write('zh', state);
    memory.activate(transition);
    assert.equal(old.current(), false);
    old.write('zh', state);
    assert.equal(memory.capture('page').read('zh'), undefined);
    memory.activate('password:owner:workspace-a');
    old.write('zh', state);
    assert.equal(memory.capture('page').read('zh'), undefined, 'returning to an earlier scope must not resurrect its old state');
  });
}

test('input during a delayed initial read overrides saved search without discarding untouched filters', () => {
  const memory = libraryStateMemory();
  memory.activate('password:owner:workspace-a');
  const saved = { ...state, search: '' };
  memory.capture('article').write('en', saved);
  const remount = memory.capture('article');
  const language = remount.language()!;
  const restored = initialLibraryState(remount.read(language), {
    search: '', status: 'all', folder: 'content/collections/_index.md', page: 1,
  }, { search: 'Navigation context' });
  assert.equal(language, 'en', 'Search editing must not reset the saved language');
  assert.deepEqual(restored, { ...state, search: 'Navigation context', page: 1 });
  assert.deepEqual(remount.read('en'), saved, 'Merging cannot mutate the previous snapshot');
});

test('explicit clears and default-valued filter edits during loading still override memory', () => {
  assert.deepEqual(initialLibraryState(state, state, { search: '', status: 'all' }), {
    ...state, search: '', status: 'all', page: 1,
  });
});

test('unmodified initial restoration retains its saved page, or clean defaults without a snapshot', () => {
  const fallback = { search: '', status: 'all', folder: 'content/collections/_index.md', page: 1 };
  assert.deepEqual(initialLibraryState(state, fallback), state);
  assert.deepEqual(initialLibraryState(undefined, fallback), fallback);
  assert.deepEqual(initialLibraryState(undefined, fallback, { search: 'Navigation context', status: 'draft' }), {
    ...fallback, search: 'Navigation context', status: 'draft',
  });
});

test('latest pending edits can be merged repeatedly and an explicit page is respected', () => {
  let edits = { search: 'Old input' };
  edits = { ...edits, search: 'Latest input' };
  assert.deepEqual(initialLibraryState(state, state, edits), { ...state, search: 'Latest input', page: 1 });
  assert.equal(initialLibraryState(state, state, { folder: 'content/collections/other/_index.md', page: 2 }).page, 2);
});

test('unknown scope never stores list or preferred-language state', () => {
  const memory = libraryStateMemory();
  const lease = memory.capture('article');
  lease.write('zh', state);
  assert.equal(lease.current(), false);
  assert.equal(lease.language(), undefined);
  assert.equal(lease.read('zh'), undefined);
});
