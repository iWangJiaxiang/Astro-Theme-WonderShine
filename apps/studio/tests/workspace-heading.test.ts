import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const studio = new URL('../', import.meta.url);

test('Workspace heading opts out of Settings stickiness without relying on stylesheet order', async () => {
  const [native, workspace, panel] = await Promise.all([
    readFile(new URL('platform/native.css', studio), 'utf8'),
    readFile(new URL('src/workspace.css', studio), 'utf8'),
    readFile(new URL('platform/WorkspacePanel.tsx', studio), 'utf8'),
  ]);

  // Source contract only: computed styles and keyboard landings require the browser fixture.
  assert.match(panel, /<section className="settings-page workspace-panel">\s*<div className="page-heading">/);
  const overrides = [...native.matchAll(/\.settings-page\.workspace-panel\s*>\s*\.page-heading\s*\{([^}]*)\}/g)];
  assert.equal(overrides.length, 1, 'one Workspace-only override with greater specificity than the shared rule');
  assert.match(overrides[0][1], /^\s*position:\s*static;\s*$/);
  assert.match(workspace, /\.settings-page\s*>\s*\.page-heading\s*\{[^}]*\bposition:\s*sticky;/);
});
