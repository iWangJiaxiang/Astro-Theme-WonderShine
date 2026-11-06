import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

// Dedicated App orchestration test. Child editors are deliberately isolated so
// assertions cover whether App remounts them or supplies cached editing props.
export async function checkDashboardPreview(browser) {
  const studio = fileURLToPath(new URL('../../', import.meta.url));
  const screenshots = join(studio, 'test-results');
  // Match App + main.ts stylesheet order without invoking a CSS build. The
  // isolated fixture has no rich editor, so its Vditor-only import is omitted.
  const stylesheets = [
    'platform/native.css', 'platform/mobile.css',
    '../../packages/theme/styles/components/common/variables.css',
    'src/style.css', 'src/forms.css', 'src/composer.css', 'src/workspace.css',
    'src/creation-tools.css', 'src/accessibility.css',
  ];
  const iconFont = await readFile(join(studio, '../../packages/theme/assets/icon/fonts/icomoon.woff'));
  const css = (await Promise.all(stylesheets.map(path => readFile(join(studio, path), 'utf8')))).join('\n')
    .replace(/^@import ['"](?:\.\.\/\.\.\/\.\.\/packages\/theme\/styles\/components\/common\/variables\.css|vditor\/dist\/index\.css)['"];\s*$/gm, '')
    .replace("url('../../../packages/theme/assets/icon/fonts/icomoon.woff')", `url('data:font/woff;base64,${iconFont.toString('base64')}')`);
  await mkdir(screenshots, { recursive: true });
  const fixture = await build({
    stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './src/App';
import { session, setApiTransport } from './src/api';
import { locale } from './src/i18n';
import { notifyWorkspaceChanged } from './src/workspace-events';
locale.value = 'zh-CN';
const identity = id => ({ identity: { id, name: id, method: 'password' }, csrf: id, expires: 9999999999 });
const pending = [], requests = [];
const row = title => ({ path: 'content/articles/example/index.md', title, date: '2026-01-01', draft: false, kind: 'article', tags: [], categories: [] });
const bootstrap = () => ({ site: {}, appearance: {}, mode: 'local', saveScope: 'test', saveCapabilities: { modes: ['local'], defaultMode: 'local' }, groups: [] });
setApiTransport(async path => {
  requests.push(path);
  if (path === '/auth/session') return Response.json(identity('first'));
  if (path === '/bootstrap') return Response.json(bootstrap());
  if (path === '/bootstrap?refresh=1' || path.startsWith('/content')) return new Promise(resolve => pending.push({ path, resolve }));
  return Response.json({});
});
window.fixture = {
  requests,
  count(path) { return pending.filter(item => item.path === path).length; },
  resolve(path, title, status = 200) {
    const index = pending.findIndex(item => item.path === path);
    if (index < 0) throw new Error('Missing pending ' + path);
    const [item] = pending.splice(index, 1);
    item.resolve(Response.json(status !== 200 ? { error: 'Unavailable' } : path.startsWith('/bootstrap') ? bootstrap() : path === '/content-preview' ? { source: 'cache', authoritative: false, rows: [row(title)] } : [row(title)], { status }));
  },
  logout() { session.value = null; },
  login(id) { session.value = identity(id); },
  changed: notifyWorkspaceChanged,
};
createRoot(document.getElementById('root')).render(<App />);
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    loader: { '.css': 'empty' },
    plugins: [{ name: 'isolate-app-children', setup(build) {
      build.onResolve({ filter: /(?:components\/|platform\/(?:LegacyRecovery|NativeAiSettings|WorkspacePanel))/ }, args => {
        // Keep real shell icons for layout captures; stateful child views stay isolated.
        if (args.path === './components/Icon') return;
        if (args.importer.endsWith('/src/App.tsx')) return { path: args.path, namespace: 'app-child' };
      });
      build.onLoad({ filter: /.*/, namespace: 'app-child' }, args => ({ loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
import React, { useState } from 'react';
function Child(props) {
  const [text, setText] = useState('');
  return ${JSON.stringify(args.path)}.endsWith('DocumentEditor')
    ? <input id="test-editor" value={text} data-initial={JSON.stringify(props.initial || null)} onChange={event => { setText(event.target.value); props.onDirty(true); }} />
    : ${JSON.stringify(args.path)}.endsWith('LoginView') ? <div id="test-login" /> : null;
}
export default Child;
export { Child as LegacyRecovery, Child as NativeAiSettings, Child as WorkspacePanel };
` }));
    } }],
  });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => request.isNavigationRequest()
      ? request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><p class="notice" data-fixture-caption>测试 fixture · 合成数据 · 子组件已隔离；非完整 App / native 验收。</p></body></html>' })
      : request.abort());
    await page.goto('https://dashboard.example');
    assert.equal(await page.evaluate(() => document.characterSet), 'UTF-8');
    assert.equal(await page.$eval('[data-fixture-caption]', node => node.textContent), '测试 fixture · 合成数据 · 子组件已隔离；非完整 App / native 验收。');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: fixture.outputFiles[0].text });
    const pending = path => page.waitForFunction(path => window.fixture.count(path) > 0, {}, path);
    const resolve = (path, title, status) => page.evaluate((path, title, status) => window.fixture.resolve(path, title, status), path, title, status);
    const recent = () => page.$eval('.home-grid', node => node.textContent);

    await pending('/content-preview');
    await resolve('/content-preview', 'Cached first');
    await page.waitForSelector('[data-dashboard-preview]');
    assert.match(await page.$eval('[data-dashboard-preview]', node => node.textContent), /可能已过期/);
    assert.match(await recent(), /Cached first.*缓存摘要/);
    assert.doesNotMatch(await recent(), /已发布/);
    assert.equal(await page.$eval('.stat-card strong', node => node.textContent), '1');
    // Capture the actual stale display before releasing the authoritative read.
    // A caption within the captured main area makes the fixture boundary visible.
    await page.evaluate(() => {
      document.querySelector('main').append(document.querySelector('[data-fixture-caption]'));
      return document.fonts.ready;
    });
    for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]]) {
      await page.setViewport({ width, height });
      await page.waitForFunction(mobile => document.querySelector('.mobile-menu')?.hidden === !mobile, {}, width <= 760);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} stale preview fits viewport`);
      assert.equal(await page.evaluate(() => window.fixture.count('/content')), 1, 'fresh content stays gated during screenshots');
      await page.screenshot({ path: join(screenshots, `dashboard-stale-preview-fixture-${name}.png`), fullPage: true });
    }
    await page.setViewport({ width: 1280, height: 900 });
    await page.waitForFunction(() => document.querySelector('.mobile-menu')?.hidden === true);
    await resolve('/content', 'Fresh first');
    await page.waitForFunction(() => document.querySelector('.home-grid')?.textContent.includes('Fresh first'));
    assert.equal(await page.$('[data-dashboard-preview]'), null);

    // Sync refresh keeps a dirty active editor mounted and passes no preview baseline.
    await page.click('.home-grid .content-row');
    await page.waitForSelector('#test-editor');
    assert.equal(await page.$eval('#test-editor', node => node.dataset.initial), 'null');
    await page.type('#test-editor', 'Unsaved text');
    await page.evaluate(() => { window.originalEditor = document.querySelector('#test-editor'); window.fixture.changed(); });
    await pending('/bootstrap?refresh=1');
    assert.equal(await page.evaluate(() => window.fixture.count('/content?refresh=1')), 0, 'content refresh waits for bootstrap checkout invalidation');
    await resolve('/bootstrap?refresh=1');
    await pending('/content?refresh=1');
    await resolve('/content?refresh=1', 'After sync');
    assert.equal(await page.$eval('#test-editor', node => node.value), 'Unsaved text');
    assert.equal(await page.evaluate(() => window.originalEditor === document.querySelector('#test-editor')), true);
    assert.ok(await page.evaluate(() => window.fixture.requests.includes('/bootstrap?refresh=1')));
    // Dirty flag is retained, not merely the input DOM.
    page.once('dialog', dialog => dialog.dismiss());
    await page.click('aside nav button');
    assert.notEqual(await page.$('#test-editor'), null);

    // Logout clears the dashboard and invalidates both late request channels.
    await page.evaluate(() => { window.fixture.logout(); });
    await page.waitForSelector('#test-login');
    await page.evaluate(() => window.fixture.login('second'));
    await pending('/content-preview');
    await page.evaluate(() => window.fixture.logout());
    await page.waitForSelector('#test-login');
    await page.evaluate(() => window.fixture.login('third'));
    await page.waitForFunction(() => window.fixture.count('/content-preview') === 2);
    await resolve('/content-preview', 'Private second');
    await resolve('/content', 'Private second fresh');
    await resolve('/content', 'Fresh third');
    await page.waitForFunction(() => document.querySelector('.home-grid')?.textContent.includes('Fresh third'));
    await resolve('/content-preview', 'Late third cache');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.doesNotMatch(await recent(), /Private second|Late third cache/);
    assert.equal(await page.$('[data-dashboard-preview]'), null);

    // Older services need no preview endpoint; normal content still loads.
    await page.evaluate(() => window.fixture.logout());
    await page.waitForSelector('#test-login');
    await page.evaluate(() => window.fixture.login('legacy'));
    await pending('/content-preview');
    await resolve('/content-preview', '', 404);
    await resolve('/content', 'Legacy fresh');
    await page.waitForFunction(() => document.querySelector('.home-grid')?.textContent.includes('Legacy fresh'));
    assert.equal(await page.$('.notice.error'), null);

    // A failed authoritative read keeps the cache explicitly stale, never empty.
    await page.evaluate(() => window.fixture.logout());
    await page.waitForSelector('#test-login');
    await page.evaluate(() => window.fixture.login('offline'));
    await pending('/content-preview');
    await resolve('/content-preview', 'Offline cache');
    await resolve('/content', '', 502);
    await page.waitForFunction(() => document.querySelector('[data-dashboard-preview]')?.textContent.includes('最新内容读取失败'));
    assert.equal(await page.$('.home-grid .empty-state'), null);
    await page.click('.notice.error button');
    await pending('/bootstrap?refresh=1');
    assert.equal(await page.evaluate(() => window.fixture.count('/content?refresh=1')), 0);
    await resolve('/bootstrap?refresh=1');
    await pending('/content?refresh=1');
    await resolve('/content?refresh=1', 'Recovered fresh');
    await page.waitForFunction(() => document.querySelector('.home-grid')?.textContent.includes('Recovered fresh'));
    assert.equal(await page.$('[data-dashboard-preview]'), null);

    // A sync notification supersedes an in-flight preview in the SAME session.
    await page.evaluate(() => window.fixture.logout());
    await page.waitForSelector('#test-login');
    await page.evaluate(() => window.fixture.login('syncing'));
    await pending('/content-preview');
    await page.evaluate(() => window.fixture.changed());
    await pending('/bootstrap?refresh=1');
    await resolve('/content-preview', 'Before sync cache');
    await resolve('/content', 'Before sync fresh');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.equal(await page.$('[data-dashboard-preview]'), null);
    assert.doesNotMatch(await recent(), /Before sync/);
    await resolve('/bootstrap?refresh=1');
    await pending('/content?refresh=1');
    await resolve('/content?refresh=1', 'Synced fresh');
    await page.waitForFunction(() => document.querySelector('.home-grid')?.textContent.includes('Synced fresh'));

    // Failed bootstrap must still attempt content; it must not clear a retained editor.
    await page.evaluate(() => window.fixture.changed());
    await pending('/bootstrap?refresh=1');
    await resolve('/bootstrap?refresh=1', '', 502);
    await pending('/content?refresh=1');
    await resolve('/content?refresh=1', 'Content despite config error');
    await page.waitForFunction(() => document.querySelector('.home-grid')?.textContent.includes('Content despite config error'));
    assert.notEqual(await page.$('.notice.error'), null);

    // A queued second step must not start under another account after logout.
    await page.evaluate(() => window.fixture.changed());
    await pending('/bootstrap?refresh=1');
    const refreshes = await page.evaluate(() => window.fixture.requests.filter(path => path === '/content?refresh=1').length);
    await page.evaluate(() => window.fixture.logout());
    await page.waitForSelector('#test-login');
    await page.evaluate(() => window.fixture.login('after-refresh'));
    await pending('/content-preview');
    await resolve('/bootstrap?refresh=1');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.equal(await page.evaluate(() => window.fixture.requests.filter(path => path === '/content?refresh=1').length), refreshes);
    await resolve('/content-preview', '', 404);
    await resolve('/content', 'New account');
    await page.waitForFunction(() => document.querySelector('.home-grid')?.textContent.includes('New account'));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const executablePath = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to Chrome/Chromium.');
  const browser = await puppeteer.launch({ headless: true, executablePath });
  try { await checkDashboardPreview(browser); console.log('PASS: dashboard cache label, fresh precedence, session isolation, sync refresh and dirty editor preservation.'); }
  finally { await browser.close(); }
}
