import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function checkLegacyRecovery(browser) {
  const fixture = await build({
    stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LegacyRecovery } from './platform/LegacyRecovery';
import { createRemoteTransport } from './platform/remote-transport';
import { session } from './src/api';
import { locale } from './src/i18n';
locale.value = 'zh-CN';
const transport = createRemoteTransport('https://studio.example', async () => new Response(JSON.stringify({ identity: { id: 'admin', name: 'Fixture editor', method: 'password' }, csrf: 'fixture-csrf', expires: 9999999999 })), undefined, 'record-id');
window.ready = (async () => {
  session.value = await (await transport('/auth/login', { method: 'POST' })).json();
  createRoot(document.getElementById('root')).render(<LegacyRecovery />);
})();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
  });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const source = 'studio-draft:password:remote:https://studio.example:admin:content/a.md';
  const target = 'studio-draft:password:remote:record-id:https://studio.example:admin:content/a.md';
  const existingSource = source.replace('a.md', 'existing.md');
  const existingTarget = target.replace('a.md', 'existing.md');
  const unrelated = source.replace('studio.example', 'other.example');
  const seed = { 'studio-language': 'zh-CN', [source]: 'legacy', [existingSource]: 'older', [existingTarget]: 'newer', [unrelated]: 'private' };
  try {
    // A routed origin enables real localStorage without contacting a service.
    await page.setRequestInterception(true);
    page.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
    await page.goto('https://recovery.example');
    await page.evaluate(seed => { localStorage.clear(); for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value); }, seed);
    await page.addScriptTag({ content: fixture.outputFiles[0].text });
    await page.evaluate(() => window.ready);
    await page.waitForSelector('.legacy-recovery summary');
    await page.click('.legacy-recovery summary');
    const snapshot = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
    assert.deepEqual(await snapshot(), seed, 'opening recovery must not copy data');

    for (const accept of [false, true]) {
      let dialogType;
      const handled = new Promise((resolve, reject) => page.once('dialog', dialog => {
        dialogType = dialog.type();
        (accept ? dialog.accept() : dialog.dismiss()).then(resolve, reject);
      }));
      await page.click('.legacy-recovery button');
      await handled;
      assert.equal(dialogType, 'confirm');
      if (!accept) {
        assert.deepEqual(await snapshot(), seed, 'cancelling must leave all storage unchanged');
        assert.equal(await page.$('.legacy-recovery [role="status"]'), null);
      } else {
        await page.waitForFunction(() => document.querySelector('.legacy-recovery [role="status"]')?.textContent.includes('恢复复制完成'));
        assert.deepEqual(await snapshot(), { ...seed, [target]: 'legacy' }, 'confirmation copies only matching data, retains originals and preserves existing targets');
      }
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}
