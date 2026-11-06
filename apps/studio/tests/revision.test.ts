import test from 'node:test';
import assert from 'node:assert/strict';
import { RevisionRegistry, gitBlobRevision } from '../core/revision.js';

test('exact-text baselines are stable, scope/path bound and contain no content digest', context => {
  const digest = context.mock.method(crypto.subtle, 'digest', () => { throw new Error('content hashing forbidden'); });
  const registry = new RevisionRegistry();
  const token = registry.revision('one', 'config.toml', 'same');
  assert.equal(registry.revision('one', 'config.toml', 'same'), token);
  assert.notEqual(registry.revision('two', 'config.toml', 'same'), token);
  assert.notEqual(registry.revision('one', 'data.toml', 'same'), token);
  assert.notEqual(registry.revision('one', 'config.toml', 'edit'), token);
  assert.equal(digest.mock.callCount(), 0);
});

test('entry and byte budgets evict least-recently-used baselines without reviving old tokens', () => {
  const registry = new RevisionRegistry({ maxEntries: 2 });
  const first = registry.revision('scope', 'first', 'text');
  const second = registry.revision('scope', 'second', 'text');
  assert.equal(registry.revision('scope', 'first', 'text'), first);
  registry.revision('scope', 'third', 'text');
  assert.equal(registry.size, 2);
  assert.equal(registry.revision('scope', 'first', 'text'), first);
  assert.notEqual(registry.revision('scope', 'second', 'text'), second);
  const bounded = new RevisionRegistry({ maxBytes: 1500 });
  for (let index = 0; index < 20; index++) bounded.revision('scope', String(index), 'x'.repeat(100));
  assert.ok(bounded.retainedBytes <= 1500); assert.ok(bounded.size < 20);
  const huge = bounded.revision('scope', 'huge', 'x'.repeat(1000));
  assert.notEqual(bounded.revision('scope', 'huge', 'x'.repeat(1000)), huge);
  assert.ok(bounded.retainedBytes <= 1500);
});

test('TTL and registry restart invalidate baselines even for unchanged text', () => {
  let now = 0;
  const registry = new RevisionRegistry({ ttlMs: 100, now: () => now });
  const token = registry.revision('scope', 'path', 'same');
  now = 99; assert.equal(registry.revision('scope', 'path', 'same'), token);
  now = 199; assert.equal(registry.size, 0);
  assert.notEqual(registry.revision('scope', 'path', 'same'), token);
  assert.notEqual(new RevisionRegistry().revision('scope', 'path', 'same'), token);
});

test('existing Git blob identities are deterministic and bound to scope and path', () => {
  const token = gitBlobRevision('remote/main', 'one.md', 'existing-oid');
  assert.equal(gitBlobRevision('remote/main', 'one.md', 'existing-oid'), token);
  assert.notEqual(gitBlobRevision('remote/other', 'one.md', 'existing-oid'), token);
  assert.notEqual(gitBlobRevision('remote/main', 'two.md', 'existing-oid'), token);
  assert.notEqual(gitBlobRevision('remote/main', 'one.md', 'changed-oid'), token);
});
