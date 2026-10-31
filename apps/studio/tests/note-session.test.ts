import test from 'node:test';
import assert from 'node:assert/strict';
import type { Json } from '../shared/types.js';
import { retainNoteDraft, retargetNoteDraft, unsavedNoteChanged, richEditorBody } from '../src/note-session.js';

test('empty rich editor sentinel does not create a backup while intentional whitespace is preserved', () => {
  assert.equal(richEditorBody('', '\n'), '');
  assert.equal(unsavedNoteChanged(undefined, richEditorBody('', '\n'), {}, '{}'), false);
  assert.equal(richEditorBody('Text', '\n'), '\n');
  assert.equal(richEditorBody('', '\n\n'), '\n\n');
  assert.equal(richEditorBody('', '  Text\n'), '  Text\n');
});

test('an untouched composer stays pristine when choosing its first language', () => {
  const values = { title: '', 'extra.id': 'n_test', draft: true };
  const draft = retargetNoteDraft('content/notes/n_test/index.en.md', { initial: values, initialBody: '' }, false);
  assert.equal(draft.initialBody, undefined);
  assert.equal(unsavedNoteChanged(draft.initialBody, '', values, JSON.stringify(values)), false);
});

test('title-only and reference-only drafts remain dirty across language changes and recovery', () => {
  const cases: Record<string, Json>[] = [{ title: 'A thought' }, { 'extra.references': [{ kind: 'internal', path: 'articles/demo/index.md' }] }];
  for (const values of cases) {
    const draft = retargetNoteDraft('content/notes/n_test/index.en.md', { initial: values, initialBody: '' }, true);
    assert.equal(unsavedNoteChanged(draft.initialBody, '', values, JSON.stringify(values)), true);
  }
});

test('switching between unsaved notes retains every identity and replaces only its own snapshot', () => {
  const first = { path: 'content/notes/custom-id/index.md', initial: { title: 'First' }, initialBody: '' };
  const second = { path: 'content/notes/n_other/index.en.md', initial: {}, initialBody: 'Second' };
  const updated = { ...first, initialBody: 'Changed' };
  const drafts = retainNoteDraft(retainNoteDraft([first], second), updated);
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts.find(item => item.path === first.path), updated);
  assert.deepEqual(drafts.find(item => item.path === second.path), second);
});
