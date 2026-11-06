import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyWorkspaceChanged, subscribeWorkspaceChanged } from '../src/workspace-events';

test('workspace changes notify subscribers once and unsubscribe is idempotent', () => {
  let calls = 0;
  const stop = subscribeWorkspaceChanged(() => { calls++; });
  try {
    notifyWorkspaceChanged();
    assert.equal(calls, 1);
    stop(); stop();
    notifyWorkspaceChanged();
    assert.equal(calls, 1);
  } finally { stop(); }
});

test('a failed refresh cannot change sync outcome or block other subscribers', async () => {
  let calls = 0;
  const stops = [
    subscribeWorkspaceChanged(() => { throw new Error('disposed'); }),
    subscribeWorkspaceChanged(async () => { throw new Error('read failed'); }),
    subscribeWorkspaceChanged(() => { calls++; }),
  ];
  try {
    assert.doesNotThrow(notifyWorkspaceChanged);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally { stops.forEach(stop => stop()); }
});
