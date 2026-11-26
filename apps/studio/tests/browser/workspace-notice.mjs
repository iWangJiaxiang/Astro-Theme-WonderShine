import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function checkWorkspaceNotice(browser) {
  const fixture = await build({
    stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspacePanel } from './platform/WorkspacePanel';
import { nativeGitCredential } from './platform/git-credential';
import { setApiTransport, session } from './src/api';
import { locale } from './src/i18n';
locale.value = 'zh-CN';
const managedChanges = Array.from({length: 24}, (_, i) => 'content/article-' + i + '.md');
let status = { branch: 'main', dirty: true, changes: managedChanges.length, managedChanges, ahead: 1, behind: 1, diverged: true, canMerge: true, canPublish: true };
let finish, credential = '';
let publishDialog = false;
session.value = { identity: { id: 'local-fixture', method: 'password', name: 'Fixture' }, csrf: 'test', expires: 1 };
nativeGitCredential.current = { id: 'local-fixture', hasToken: () => !!credential, set: value => { credential = value; } };
window.reviewCalls = 0;
window.syncCalls = 0;
window.publishCalls = 0;
setApiTransport(async (path, init) => {
  if (path === '/workspace/review') {
    if (init.method !== 'POST') throw new Error('Review must be explicit');
    window.reviewCalls++;
    return new Response(JSON.stringify({ ...status, confirmation: status.dirty ? 'preview' : 'committed' }));
  }
  if (path === '/workspace/commit') throw new Error('Combined operation must use the reviewed publish endpoint');
  if (path === '/workspace/publish') {
    window.publishCalls++;
    if (JSON.parse(init.body).confirmation !== 'preview') throw new Error('Wrong publish token');
    if (!publishDialog) {
      status = { ...status, dirty: false, changes: 0, managedChanges: [], ahead: 2 };
      await new Promise((_, reject) => { finish = () => reject(new Error('Lost publish response')); });
    }
    return new Response(JSON.stringify({
      error: 'Git fetch failed: Authorization: Bearer fixture-secret',
      params: { gitDetail: 'libgit2 fetch Net/Auth', password: 'fixture-password' },
    }), { status: 409 });
  }
  if (path === '/workspace/sync') {
    window.syncCalls++;
    if (JSON.parse(init.body).confirmation !== 'committed') throw new Error('Wrong sync token');
    if (window.syncCalls === 1) return new Response(JSON.stringify({ error: 'Git 远端认证失败，请检查当前会话的访问令牌和仓库权限', params: { gitDetail: 'libgit2 fetch Callback/Auth' } }), {status: 409});
    if (window.syncCalls === 2) {
      if (credential !== 'replacement-fixture' || init.body.includes(credential)) throw new Error('Incorrect credential handoff');
      return new Response(JSON.stringify(status));
    }
    throw new Error('Unexpected sync request');
  }
  return new Response(JSON.stringify(status));
});
window.loseResponse = () => finish();
const root = createRoot(document.getElementById('root'));
root.render(<WorkspacePanel />);
window.openPublish = () => {
  publishDialog = true;
  status = { ...status, dirty: true, changes: 1, managedChanges: ['content/a.md'], canPublish: true };
  root.render(<WorkspacePanel key="publish" publishPath="content/a.md" />);
};
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } });
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    loader: { '.css': 'empty' },
  });
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: fixture.outputFiles[0].text });
    await page.waitForSelector('.workspace-sync-actions');
    const fileList = '.workspace-file-list';
    assert.equal(await page.$eval(fileList, details => details.open), false);
    assert.match(await page.$eval(fileList + ' summary', node => node.textContent), /24/);
    await page.click(fileList + ' summary');
    const paths = await page.$$eval(fileList + ' li', items => items.map(item => item.textContent));
    assert.equal(paths.length, 24);
    await page.click(fileList + ' summary');
    assert.equal(await page.$eval('.workspace-sync-actions button:nth-child(3)', button => button.disabled), false);
    await page.click('.workspace-sync-actions button:nth-child(3)');
    const confirmation = 'dialog.workspace-confirm:modal';
    await page.waitForSelector(confirmation);
    assert.deepEqual(await page.$$eval(confirmation + ' details[open] li', items => items.map(item => item.textContent)), paths);
    await page.click(confirmation + ' .primary');
    await page.waitForFunction(() => window.publishCalls === 1);
    assert.equal(await page.evaluate(() => window.reviewCalls), 1);
    assert.equal(await page.evaluate(() => window.syncCalls), 0);
    await page.evaluate(() => window.loseResponse());
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('请核对远端状态'));
    assert.equal(await page.$(confirmation), null, 'A lost response must not open another confirmation');
    await page.waitForFunction(() => document.querySelector('.workspace-panel .navigation-refresh')?.getAttribute('aria-disabled') === 'false');
    await page.click('.workspace-panel .page-heading button');
    await page.waitForSelector('.workspace-sync-actions');
    await page.click('.workspace-sync-actions button:nth-child(2)');
    await page.waitForSelector('dialog.workspace-confirm:modal .publish-actions');
    await page.click('dialog.workspace-confirm:modal .primary');
    const retry = '.workspace-panel > button.secondary';
    await page.waitForSelector(retry);
    await page.click(retry);
    await page.waitForSelector('dialog.workspace-confirm:modal details[open] input');
    assert.equal(await page.evaluate(() => window.syncCalls), 1);
    await page.type('dialog.workspace-confirm:modal details input', 'replacement-fixture');
    await page.click('dialog.workspace-confirm:modal .primary');
    await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent.includes('已与 Git 远端同步'));
    await page.evaluate(() => window.openPublish());
    await page.waitForFunction(() => document.querySelector('.publish-actions .primary')?.textContent === '确认发布');
    await page.click('.publish-actions .primary');
    await page.waitForSelector('.publish-dialog .error-more');
    await page.click('.publish-dialog .error-more');
    const field = '.error-dialog[open] textarea';
    await page.waitForSelector(field);
    const report = await page.$eval(field, node => node.value);
    for (const detail of ['POST /workspace/publish', 'HTTP 409', 'libgit2 fetch Net/Auth', 'WorkspacePanel']) assert.ok(report.includes(detail));
    assert.doesNotMatch(report, /fixture-secret|fixture-password/);
    await page.click('.error-actions .primary');
    await page.waitForFunction(() => document.querySelector('.error-dialog [role=status]')?.textContent === '详情已复制');
    assert.equal(await page.evaluate(() => window.copied), report);
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); };
      document.execCommand = () => false;
    });
    await page.click('.error-actions .primary');
    await page.waitForFunction(() => document.querySelector('.error-dialog [role=status]')?.textContent === '请选择详情文字手动复制');
    assert.equal(await page.$eval(field, node => node.selectionStart === 0 && node.selectionEnd === node.value.length), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.error-dialog[open]'));
    assert.ok(await page.$('dialog.publish-dialog[open]'), 'Closing details retains the publish dialog');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('error-more')), true);

  } finally { await page.close(); }
}
