import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoadDiagnostics } from '../platform/load-diagnostics.js';

test('load diagnostics throttle progress while preserving transitions and completion', async () => {
  let time = 0, report = '';
  const diagnostics = createLoadDiagnostics({ setItem: (_key, value) => { report = value; } }, () => time);
  const events: string[] = [];
  const progress = diagnostics.progress(event => { events.push(`${event.phase}:${event.loaded}`); });
  await progress.onProgress({ phase: 'Updating workdir', loaded: 1, total: 10 });
  time = 20;
  await progress.onProgress({ phase: 'Updating workdir', loaded: 2, total: 10 });
  time = 100;
  await progress.onProgress({ phase: 'Updating workdir', loaded: 3, total: 10 });
  time = 110;
  await progress.onProgress({ phase: 'Updating workdir', loaded: 10, total: 10 });
  time = 120;
  await progress.onProgress({ phase: 'Resolving deltas', loaded: 1, total: 2 });
  time = 140; progress.finish();
  assert.deepEqual(events, ['Updating workdir:1', 'Updating workdir:3', 'Updating workdir:10', 'Resolving deltas:1']);
  assert.deepEqual(JSON.parse(report).timings, {
    'Updating workdir': { count: 1, totalMs: 120 },
    'Resolving deltas': { count: 1, totalMs: 20 },
  });
});

test('diagnostics preserve results/errors without storing private data and ignore disposed work', async () => {
  let time = 0, report = '';
  const diagnostics = createLoadDiagnostics({ setItem: (_key, value) => { report = value; } }, () => time);
  assert.equal(await diagnostics.measure('content-request', async () => { time = 25; return 'private-body'; }), 'private-body');
  const failure = new Error('private-repository-url');
  await assert.rejects(diagnostics.measure('git-open', async () => { time = 40; throw failure; }), error => error === failure);
  assert.ok(!report.includes('private'));
  const previous = report;
  diagnostics.dispose();
  await diagnostics.measure('recovery', async () => { time = 50; });
  assert.equal(report, previous);
  const unavailable = createLoadDiagnostics({ setItem: () => { throw new Error('storage denied'); } });
  assert.equal(await unavailable.measure('git-open', async () => 42), 42);
  const brokenClock = createLoadDiagnostics({ setItem: () => {} }, () => { throw new Error('clock unavailable'); });
  assert.equal(await brokenClock.measure('git-open', async () => 42), 42);
  await assert.rejects(brokenClock.measure('recovery', async () => { throw failure; }), error => error === failure);
  const progress = brokenClock.progress();
  await progress.onProgress({ phase: 'Updating workdir', loaded: 1, total: 2 });
  progress.finish();
});
