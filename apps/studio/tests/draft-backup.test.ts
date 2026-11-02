import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftBackup } from '../src/draft-backup';

test('input backups serialize only the latest draft once per interval', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let body = 'first';
  const writes: string[] = [];
  const backup = createDraftBackup(() => writes.push(body));
  backup.schedule();
  t.mock.timers.tick(200);
  body = 'latest';
  backup.schedule();
  assert.deepEqual(writes, []);
  t.mock.timers.tick(100);
  assert.deepEqual(writes, ['latest']);
  backup.schedule();
  t.mock.timers.tick(300);
  assert.deepEqual(writes, ['latest', 'latest']);
});

test('explicit flush writes immediately and cancels the queued duplicate', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0;
  const backup = createDraftBackup(() => writes++);
  backup.schedule();
  backup.flush();
  assert.equal(writes, 1);
  t.mock.timers.tick(1000);
  assert.equal(writes, 1);
  backup.flush();
  assert.equal(writes, 2);
});

test('discard cancels pending backup without preventing later edits', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0;
  const backup = createDraftBackup(() => writes++);
  backup.schedule();
  backup.cancel();
  backup.cancel();
  t.mock.timers.tick(1000);
  assert.equal(writes, 0);
  backup.schedule();
  t.mock.timers.tick(300);
  assert.equal(writes, 1);
});
