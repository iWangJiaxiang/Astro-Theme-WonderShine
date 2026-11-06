import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InflightQuery } from '../src/inflight-query';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('pending queries share work but clone nested arrays for every caller and never cache completed values', async () => {
  const queries = new InflightQuery();
  const pending = deferred<{ tags: string[] }[]>();
  let calls = 0;
  const load = () => { calls++; return pending.promise; };
  const first = queries.read('content', load);
  const second = queries.read('content', load);
  pending.resolve([{ tags: ['original'] }]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  a[0].tags.push('edited'); a.reverse();
  assert.deepEqual(b, [{ tags: ['original'] }]);
  await queries.read('content', load);
  assert.equal(calls, 2);
});

test('rejections and timeouts evict pending work and permit retry even when cancellation is ignored', async () => {
  const queries = new InflightQuery({ timeoutMs: 15 });
  const pending = deferred<string>();
  let signal!: AbortSignal;
  const first = queries.read('content', current => { signal = current; return pending.promise; });
  const second = queries.read('content', () => Promise.resolve('wrong'));
  await Promise.all([assert.rejects(first, { name: 'TimeoutError' }), assert.rejects(second, { name: 'TimeoutError' })]);
  assert.equal(signal.aborted, true);
  pending.reject(new Error('late ignored transport failure'));
  await assert.rejects(queries.read('content', async () => { throw new Error('network'); }), /network/);
  assert.equal(await queries.read('content', async () => 'retry'), 'retry');
});

test('refresh wakes a never-settling normal read immediately and observes its orphan rejection', { timeout: 1000 }, async () => {
  const queries = new InflightQuery();
  const old = deferred<string>();
  const fresh = deferred<string>();
  let retries = 0;
  const first = queries.read('content', () => { retries++; return old.promise; });
  await Promise.resolve();
  const refresh = queries.read('content', () => fresh.promise, { refresh: true });
  const normal = queries.read('content', async () => 'incorrect');
  for (let i = 0; i < 12; i++) await Promise.resolve();
  fresh.resolve('fresh');
  assert.deepEqual(await Promise.all([first, refresh, normal]), ['fresh', 'fresh', 'fresh']);
  assert.equal(retries, 1);
  old.reject(new Error('orphan failure after callers have completed'));
});

test('late obsolete work cannot remove its replacement or force an unnecessary re-read', { timeout: 1000 }, async () => {
  const queries = new InflightQuery();
  const old = deferred<string>();
  let calls = 0;
  const first = queries.read('content', () => { calls++; return old.promise; });
  await Promise.resolve();
  assert.equal(await queries.read('content', async () => 'newer', { refresh: true }), 'newer');
  assert.equal(await first, 'newer');
  old.resolve('stale');
  assert.equal(calls, 1);
});

test('an unfulfilled forced loader cannot join an ordinary retry after invalidation', { timeout: 1000 }, async () => {
  const queries = new InflightQuery();
  let forcedLoads = 0;
  const forced = queries.read('content', async () => {
    if (++forcedLoads === 1) return new Promise<string>(() => {});
    return 'forced';
  }, { refresh: true });
  await Promise.resolve();
  queries.invalidate();
  // Insert an ordinary entry synchronously, before the forced reader wakes.
  const ordinary = queries.read('content', () => new Promise<string>(() => {}));
  assert.deepEqual(await Promise.all([forced, ordinary]), ['forced', 'forced']);
  assert.equal(forcedLoads, 2);
});

test('bounded keys preserve tracked readers and allow new variants after settlement', async () => {
  const queries = new InflightQuery({ maxEntries: 1 });
  const old = deferred<string>();
  const a = queries.read('a', () => old.promise);
  await assert.rejects(queries.read('b', async () => 'b'), /Too many pending/);
  const a2 = queries.read('a', async () => 'incorrect');
  old.resolve('a');
  assert.deepEqual(await Promise.all([a, a2]), ['a', 'a']);
  assert.equal(await queries.read('b', async () => 'b'), 'b');
});

test('scope invalidation promptly rejects a never-settling caller without retrying under a new identity', { timeout: 1000 }, async () => {
  const queries = new InflightQuery();
  const old = deferred<string>();
  let current = true;
  const first = queries.read('content', () => old.promise, { assertCurrent: () => { if (!current) throw new Error('scope changed'); } });
  const rejected = assert.rejects(first, /scope changed/);
  await Promise.resolve();
  current = false; queries.invalidate();
  assert.equal(await queries.read('content', async () => 'new identity'), 'new identity');
  await rejected;
});
