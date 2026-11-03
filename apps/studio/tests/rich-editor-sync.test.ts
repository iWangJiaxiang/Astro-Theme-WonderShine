import test from 'node:test';
import assert from 'node:assert/strict';
import { createRichEditorSync } from '../src/rich-editor-sync';

test('DOM input and click bursts read only the latest rich body once per interval', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let body = 'first', reads = 0;
  const applied: string[] = [];
  const sync = createRichEditorSync(() => { reads++; return body; }, value => applied.push(value));
  sync.schedule();
  t.mock.timers.tick(50);
  body = 'latest';
  sync.schedule();
  sync.schedule();
  assert.equal(reads, 0);
  t.mock.timers.tick(50);
  assert.equal(reads, 1);
  assert.deepEqual(applied, ['latest']);
  sync.schedule();
  t.mock.timers.tick(100);
  assert.equal(reads, 2);
});

test('Vditor input applies immediately and cancels queued serialization', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const applied: string[] = [];
  const sync = createRichEditorSync(() => { reads++; return 'fallback'; }, value => applied.push(value));
  sync.schedule();
  sync.accept('provided Markdown');
  assert.deepEqual(applied, ['provided Markdown']);
  t.mock.timers.tick(100);
  assert.equal(reads, 0);
});

test('save and lifecycle flush read synchronously even without a pending DOM event', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let body = 'last edit';
  const applied: string[] = [];
  const sync = createRichEditorSync(() => body, value => applied.push(value));
  sync.schedule();
  sync.flush();
  assert.deepEqual(applied, ['last edit']);
  t.mock.timers.tick(100);
  assert.deepEqual(applied, ['last edit']);
  body = 'toolbar change';
  sync.flush();
  assert.deepEqual(applied, ['last edit', 'toolbar change']);
});

test('destroy cancels old editor work and an unavailable editor never overwrites the body', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const applied: string[] = [];
  const sync = createRichEditorSync(() => { reads++; return undefined; }, value => applied.push(value));
  sync.schedule();
  sync.cancel();
  t.mock.timers.tick(100);
  assert.equal(reads, 0);
  sync.flush();
  assert.equal(reads, 1);
  assert.deepEqual(applied, []);
});
