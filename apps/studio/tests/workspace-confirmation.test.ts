import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceConfirmation } from '../shared/workspace-confirmation.js';

test('workspace confirmations detect changed bytes, branch, HEAD, staging and deleted paths', async () => {
  const rows: Array<[string, number, number, number]> = [['content/articles/a/index.md', 1, 2, 1]];
  const token = (text: string, branch = 'main', head = 'head', entries = rows) =>
    workspaceConfirmation(branch, head, entries, async () => new TextEncoder().encode(text));
  const initial = await token('first edit');
  assert.equal(await token('first edit'), initial);
  assert.notEqual(await token('second edit'), initial);
  assert.notEqual(await token('first edit', 'other'), initial);
  assert.notEqual(await token('first edit', 'main', 'new-head'), initial);
  assert.notEqual(await token('first edit', 'main', 'head', [[rows[0][0], 1, 2, 2]]), initial);
  assert.notEqual(await token('', 'main', 'head', [[rows[0][0], 1, 0, 1]]), initial);
  await workspaceConfirmation('main', null, [[rows[0][0], 1, 0, 1]], async () => { throw new Error('Deleted files must not be read'); });
});
