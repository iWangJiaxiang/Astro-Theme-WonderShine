import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function checkWorkspaceNotice(browser) {
  const fixture = await build({
    stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspacePanel } from './platform/WorkspacePanel';
import { setApiTransport } from './src/api';
import { locale } from './src/i18n';
locale.value = 'zh-CN';
let status = { branch: 'main', dirty: true, changes: 1, managedChanges: ['content/a.md'], ahead: 0, behind: 0, diverged: false };
let finish;
window.reviewCalls = 0;
window.syncCalls = 0;
setApiTransport(async (path, init) => {
  if (path === '/workspace/review') {
    if (init.method !== 'POST') throw new Error('Review must be explicit');
    window.reviewCalls++;
    return new Response(JSON.stringify({ ...status, confirmation: status.dirty ? 'preview' : 'committed' }));
  }
  if (path === '/workspace/commit') {
    if (JSON.parse(init.body).confirmation !== 'preview') throw new Error('Wrong commit token');
    status = { ...status, dirty: false, changes: 0, managedChanges: [], ahead: 1 };
  }
  if (path === '/workspace/sync') {
    window.syncCalls++;
    if (JSON.parse(init.body).confirmation !== 'committed') throw new Error('Wrong sync token');
    await new Promise((resolve, reject) => { finish = () => {
      // The push succeeds, but its response is lost; cached status is not proof of failure.
      reject(new Error('Lost sync response'));
    }; });
  }
  return new Response(JSON.stringify(status));
});
window.loseResponse = () => finish();
createRoot(document.getElementById('root')).render(<WorkspacePanel />);
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
  });
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: fixture.outputFiles[0].text });
    await page.waitForSelector('.workspace-sync-actions');
    await page.click('.workspace-sync-actions button:nth-child(3)');
    await page.waitForSelector('[role="group"] button');
    await page.click('[role="group"] button');
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('再确认同步 Git'));
    assert.equal(await page.evaluate(() => window.reviewCalls), 2);
    assert.equal(await page.evaluate(() => window.syncCalls), 0, 'committing must not silently push with a replacement token');
    await page.click('[role="group"] button');
    await page.waitForFunction(() => window.syncCalls === 1);
    await page.evaluate(() => window.loseResponse());
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('远端同步结果尚未确认'));
    assert.match(await page.$eval('[role="status"]', node => node.textContent), /本地提交已保留/);
    assert.doesNotMatch(await page.$eval('[role="status"]', node => node.textContent), /尚未推送|已与 Git/);
    await page.waitForFunction(() => !document.querySelector('.workspace-panel .page-heading button').disabled);
  } finally { await page.close(); }
}
