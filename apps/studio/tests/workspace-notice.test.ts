import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceCommitNotice } from '../platform/workspace-notice.js';
import { translate } from '../shared/i18n.js';

test('commit-and-sync notices do not infer a remote outcome from a lost response', () => {
  assert.equal(translate(workspaceCommitNotice('pending'), 'en'), 'Committed locally.');
  const failure = translate(workspaceCommitNotice('unconfirmed'), 'en');
  assert.match(failure, /local commit is preserved/);
  assert.match(failure, /remote sync outcome is unconfirmed/);
  assert.doesNotMatch(failure, /not pushed|synced with Git/i);
  assert.match(translate(workspaceCommitNotice('none'), 'en'), /Not pushed/);
});
