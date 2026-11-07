import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { fixtureAssetPlugin } from './fixture-asset-plugin.mjs';

// Real App, API/InflightQuery, SettingsView/FormField/SaveButton and DocumentEditor.
// Only unrelated direct App children and the unused Vditor dependency are isolated.
// This is a synthetic source-editor lifecycle fixture, not CSS, rich-editor,
// translation, native WebView, authentication or server-persistence acceptance.
export async function checkAppLocaleEditors(browser) {
  const studio = fileURLToPath(new URL('../../', import.meta.url));
  const fixture = await build({
    stdin: { resolveDir: studio, loader: 'tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './src/App';
import { setApiTransport, pendingMutations } from './src/api';
import { locale, t } from './src/i18n';
locale.value = 'zh-CN';
const path = 'content/articles/locale-fixture/index.md';
const settingsKey = 'studio-settings:password:locale-editor:site:default';
const documentKey = 'studio-draft:password:locale-editor:' + path;
sessionStorage.removeItem(settingsKey);
localStorage.removeItem(documentKey);
document.cookie = 'studio-autosave=0; Path=/; SameSite=Strict';
const requests = [], pending = [], unexpected = [];
const row = { path, title: 'Fixture article', date: '2026-01-01', draft: false, kind: 'article', tags: [], categories: [] };
const bootstrap = { site: {}, appearance: {}, mode: 'local', saveScope: 'locale-editor-fixture', saveCapabilities: { modes: ['local'], defaultMode: 'local' }, groups: [{ id: 'site', title: '站点信息' }] };
const settings = { id: 'site', title: '站点信息', description: '', file: 'config.toml', fields: [{ path: 'title', label: '标题', kind: 'text', default: '' }], values: { title: 'Fixture site' }, revision: 'settings-r1' };
setApiTransport(async (endpoint, init) => {
  const record = { path: endpoint, method: init.method, language: new Headers(init.headers).get('Accept-Language'), body: init.body ? JSON.parse(String(init.body)) : null };
  requests.push(record);
  if (init.method === 'PUT' && ['/settings/site', '/document'].includes(endpoint)) {
    return new Promise(resolve => pending.push({ ...record, resolve }));
  }
  if (init.method === 'GET') {
    if (endpoint === '/auth/session') return Response.json({ identity: { id: 'locale-editor', name: 'Fixture editor', method: 'password' }, csrf: 'fixture-only', expires: 9999999999 });
    if (endpoint === '/bootstrap') return Response.json(bootstrap);
    if (endpoint === '/content') return Response.json([row]);
    if (endpoint === '/content-preview') return Response.json(null);
    if (endpoint === '/settings/site') return Response.json(settings);
    if (endpoint === '/document?path=' + encodeURIComponent(path)) return Response.json({ path, text: 'Fixture article file', metadata: { title: row.title, draft: false }, body: 'Fixture saved body', revision: 'document-r1' });
    if (endpoint === '/content-languages') return Response.json({ defaultLanguage: 'zh-CN', languages: ['zh-CN'] });
    if (endpoint === '/translation/config') return Response.json({ enabled: false });
    if (endpoint === '/settings/taxonomies?language=zh-CN') return Response.json({ id: 'taxonomies', title: '分类', fields: [], values: { 'post.tags': [], 'post.categories': [] }, revision: 'taxonomy-r1' });
  }
  unexpected.push(record);
  return Response.json({ error: 'Unexpected synthetic fixture request' }, { status: 500 });
});
window.localeEditors = {
  requests, unexpected, path, settingsKey, documentKey,
  translated: t,
  pendingMutations: () => pendingMutations.value,
  countPending: endpoint => pending.filter(item => item.path === endpoint).length,
  resolve(endpoint, result, status = 200) {
    const index = pending.findIndex(item => item.path === endpoint);
    if (index < 0) throw new Error('Missing synthetic pending mutation');
    pending.splice(index, 1)[0].resolve(Response.json(result, { status }));
  },
};
createRoot(document.getElementById('root')).render(<App />);
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    loader: { '.css': 'empty' },
    plugins: [fixtureAssetPlugin(), {
      name: 'locale-editors-isolate-unrelated-app-children',
      setup(builder) {
        const isolated = new Set([
          './components/LoginView', './components/ContentLibrary', './components/ThreadComposer',
          './components/ThreadDetail', './components/LocalizedContentLibrary',
          './components/MediaLibrary', './components/GettingStarted',
          '../platform/LegacyRecovery', '../platform/NativeAiSettings', '../platform/WorkspacePanel',
        ]);
        builder.onResolve({ filter: /(?:components\/|platform\/)/ }, args => {
          if (args.importer.endsWith('/src/App.tsx') && isolated.has(args.path)) {
            return { path: args.path, namespace: 'locale-editor-app-child' };
          }
        });
        builder.onLoad({ filter: /.*/, namespace: 'locale-editor-app-child' }, () => ({
          loader: 'tsx', resolveDir: studio,
          contents: `import React from 'react';
const Child = React.forwardRef(() => null);
export default Child;
export { Child as LegacyRecovery, Child as NativeAiSettings, Child as WorkspacePanel };`,
        }));
        builder.onResolve({ filter: /^vditor$/ }, () => ({ path: 'vditor', namespace: 'locale-editor-unused-rich' }));
        builder.onLoad({ filter: /.*/, namespace: 'locale-editor-unused-rich' }, () => ({
          loader: 'js', contents: 'export default class UnusedRichEditor { constructor() { throw new Error("Rich editor is outside this source-mode fixture"); } }',
        }));
      },
    }],
  });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => request.isNavigationRequest()
      ? request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
      : request.abort());
    await page.goto('https://locale-editors.example');
    await page.addScriptTag({ content: fixture.outputFiles[0].text });
    const settingsPage = '[data-settings-group="site"]';
    const settingsInput = `${settingsPage} input[name="title"]`;
    const settingsSave = `${settingsPage} .save-button-main`;
    const documentInput = '.editor-page .markdown-source';
    const documentSave = '.editor-page .editor-save-actions .save-button-main';
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const append = async (selector, text) => {
      await page.focus(selector);
      await page.$eval(selector, node => node.setSelectionRange(node.value.length, node.value.length));
      await page.type(selector, text);
    };
    const requests = () => page.evaluate(() => window.localeEditors.requests);
    const count = async (path, method = 'GET') => (await requests()).filter(item => item.path === path && item.method === method).length;
    const mutations = async path => (await requests()).filter(item => item.path === path && item.method === 'PUT');
    const draft = kind => page.evaluate(kind => {
      const fixture = window.localeEditors;
      return JSON.parse((kind === 'settings' ? sessionStorage.getItem(fixture.settingsKey) : localStorage.getItem(fixture.documentKey)) || 'null');
    }, kind);
    const switchLocale = async value => {
      await page.select('.language-switcher select', value);
      await page.waitForFunction(value => document.documentElement.lang === value, {}, value);
      await settle();
    };
    const remember = (name, selectors) => page.evaluate((name, selectors) => {
      window[name] = selectors.map(selector => document.querySelector(selector));
      if (window[name].some(node => !node)) throw new Error('Missing editor identity target');
    }, name, selectors);
    const same = (name, selectors) => page.evaluate((name, selectors) => selectors.every((selector, i) => window[name][i].isConnected && window[name][i] === document.querySelector(selector)), name, selectors);
    const unsavedGuard = () => page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    const resolveSave = (path, revision) => page.evaluate((path, revision) => window.localeEditors.resolve(path, { revision, message: 'Fixture saved' }), path, revision);
    const pendingSave = path => page.waitForFunction(path => window.localeEditors.countPending(path) === 1 && window.localeEditors.pendingMutations() === 1, {}, path);
    const idle = () => page.waitForFunction(() => window.localeEditors.pendingMutations() === 0);

    await page.waitForSelector('.home-grid .content-row');
    await page.waitForSelector('aside nav[aria-label="站点设置"] button');
    await page.click('aside nav[aria-label="站点设置"] button');
    await page.waitForSelector(settingsInput);
    await page.waitForFunction(() => !document.querySelector('.settings-card .notice.error'));
    assert.equal(await page.$eval(settingsInput, node => node.value), 'Fixture site');
    assert.equal(await count('/settings/site'), 1);
    await append(settingsInput, ' draft');
    await page.waitForSelector(`${settingsPage} .settings-state.pending`);
    await remember('settingsNodes', [settingsPage, settingsInput, settingsSave]);
    const firstDraft = await draft('settings');
    assert.deepEqual(firstDraft, { values: { title: 'Fixture site draft' }, baseline: { title: 'Fixture site' }, revision: 'settings-r1' });
    const beforeLocale = await requests();
    await switchLocale('en');
    assert.equal(await same('settingsNodes', [settingsPage, settingsInput, settingsSave]), true, 'loaded dirty SettingsView and controls stay mounted');
    assert.equal(await page.$eval(settingsInput, node => node.value), 'Fixture site draft');
    assert.deepEqual(await draft('settings'), firstDraft, 'locale does not rebase or discard the settings draft');
    assert.deepEqual(await requests(), beforeLocale, 'loaded locale change issues no settings GET/PUT or App reload');
    assert.equal(await unsavedGuard(), true, 'App retains the real child dirty notification');
    assert.equal(await page.$eval(`${settingsPage} .settings-state`, node => node.textContent), await page.evaluate(() => window.localeEditors.translated('有未保存的更改')));
    page.once('dialog', dialog => dialog.dismiss());
    await page.click('aside nav button');
    assert.equal(await same('settingsNodes', [settingsPage, settingsInput, settingsSave]), true, 'declining App leave keeps the settings draft');

    await page.click(settingsSave);
    await pendingSave('/settings/site');
    assert.deepEqual((await mutations('/settings/site'))[0], { path: '/settings/site', method: 'PUT', language: 'en', body: { revision: 'settings-r1', changes: { title: 'Fixture site draft' }, saveMode: 'local' } });
    await resolveSave('/settings/site', 'settings-r2');
    await idle();
    await page.waitForSelector(`${settingsPage} .settings-state:not(.pending)`);
    assert.equal(await draft('settings'), null, 'real successful save clears its tab draft');
    assert.equal(await unsavedGuard(), false);

    // A mutation is not a locale-scoped read: settle its actual HTTP 409 after
    // switching language, then retain the original baseline/revision for retry.
    await append(settingsInput, ' conflict');
    await page.waitForSelector(`${settingsPage} .settings-state.pending`);
    const conflictDraft = await draft('settings');
    assert.equal(conflictDraft.revision, 'settings-r2');
    assert.deepEqual(conflictDraft.baseline, { title: 'Fixture site draft' });
    await page.click(settingsSave);
    await pendingSave('/settings/site');
    const beforePendingLocale = await requests();
    await switchLocale('zh-CN');
    assert.deepEqual(await requests(), beforePendingLocale, 'pending save is neither retried nor replaced on locale change');
    assert.equal(await page.$eval(settingsSave, node => node.disabled), true);
    assert.equal(await same('settingsNodes', [settingsPage, settingsInput, settingsSave]), true);
    await page.evaluate(() => window.localeEditors.resolve('/settings/site', { error: 'Fixture settings revision conflict', revision: 'must-not-adopt-conflict-revision' }, 409));
    await idle();
    await page.waitForFunction(() => document.querySelector('[data-settings-group="site"] [role="alert"]')?.textContent.includes('Fixture settings revision conflict'));
    assert.equal((await mutations('/settings/site')).length, 2, 'one transport mutation per explicit save');
    assert.deepEqual(await draft('settings'), conflictDraft);
    assert.equal(await page.$eval(settingsInput, node => node.value), 'Fixture site draft conflict');
    assert.equal(await unsavedGuard(), true);
    assert.equal(await page.$eval(settingsSave, node => node.disabled), false, 'conflict leaves save available');
    const beforeErrorLocale = await requests();
    await switchLocale('en');
    assert.match(await page.$eval(`${settingsPage} [role="alert"]`, node => node.textContent), /Fixture settings revision conflict/);
    assert.equal(await same('settingsNodes', [settingsPage, settingsInput, settingsSave]), true);
    assert.deepEqual(await draft('settings'), conflictDraft);
    assert.deepEqual(await requests(), beforeErrorLocale, 'current conflict remains visible without automatic reload/retry');
    await page.click(settingsSave);
    await pendingSave('/settings/site');
    const settingsWrites = await mutations('/settings/site');
    assert.deepEqual(settingsWrites.slice(1).map(item => item.body), [
      { revision: 'settings-r2', changes: { title: 'Fixture site draft conflict' }, saveMode: 'local' },
      { revision: 'settings-r2', changes: { title: 'Fixture site draft conflict' }, saveMode: 'local' },
    ], '409 never advances the revision or baseline, and explicit retry retains the exact changes');
    await resolveSave('/settings/site', 'settings-r3');
    await idle();
    await page.waitForSelector(`${settingsPage} .settings-state:not(.pending)`);
    assert.equal(await draft('settings'), null);
    assert.equal(await page.$(`${settingsPage} [role="alert"]`), null);
    assert.equal(await count('/settings/site'), 1, 'no settings refetch throughout edits, locale changes or saves');

    await page.click('aside nav button');
    await page.waitForSelector('.home-grid .content-row');
    await page.click('.home-grid .content-row');
    await page.waitForSelector(documentInput);
    await page.waitForSelector('.language-version-tabs');
    await page.waitForSelector('.editor-aside button[name="extra.topics"]:enabled');
    assert.equal(await page.$('.editor-aside .notice.error'), null);
    assert.equal(await page.$eval(documentInput, node => node.value), 'Fixture saved body');
    assert.equal(await page.$eval(documentSave, node => node.disabled), true);
    await remember('documentNodes', ['.editor-page', documentInput, '.title-field input', documentSave]);
    const docGet = '/document?path=' + encodeURIComponent(await page.evaluate(() => window.localeEditors.path));
    assert.equal(await count(docGet), 1);
    const beforeCleanDocumentLocale = await requests();
    await switchLocale('zh-CN');
    assert.equal(await same('documentNodes', ['.editor-page', documentInput, '.title-field input', documentSave]), true, 'saved real DocumentEditor stays mounted');
    assert.equal(await page.$eval(documentInput, node => node.value), 'Fixture saved body');
    assert.equal(await page.$eval('.title-field input', node => node.value), 'Fixture article');
    assert.equal(await page.$eval(documentSave, node => node.disabled), true);
    assert.equal(await unsavedGuard(), false);
    assert.deepEqual(await requests(), beforeCleanDocumentLocale, 'loaded saved document has no locale GET');

    await append(documentInput, ' dirty');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem(window.localeEditors.documentKey) || 'null')?.body === 'Fixture saved body dirty');
    const documentDraft = await draft('document');
    assert.equal(documentDraft.revision, 'document-r1');
    assert.equal(documentDraft.originalBody, 'Fixture saved body');
    const beforeDirtyDocumentLocale = await requests();
    await switchLocale('en');
    assert.equal(await same('documentNodes', ['.editor-page', documentInput, '.title-field input', documentSave]), true, 'dirty real DocumentEditor and source control stay mounted');
    assert.equal(await page.$eval(documentInput, node => node.value), 'Fixture saved body dirty');
    assert.deepEqual(await draft('document'), documentDraft, 'real body backup and baseline survive locale change');
    assert.deepEqual(await requests(), beforeDirtyDocumentLocale);
    assert.equal(await page.$eval(documentSave, node => node.disabled), false);
    assert.equal(await unsavedGuard(), true);

    await page.click(documentSave);
    await pendingSave('/document');
    const beforeDocumentSaveLocale = await requests();
    await switchLocale('zh-CN');
    assert.deepEqual(await requests(), beforeDocumentSaveLocale, 'pending document save runs once across locale');
    assert.equal(await same('documentNodes', ['.editor-page', documentInput, '.title-field input', documentSave]), true);
    assert.equal(await page.$eval(documentInput, node => node.value), 'Fixture saved body dirty');
    await resolveSave('/document', 'document-r2');
    await idle();
    await page.waitForFunction(() => document.querySelector('.editor-save-actions .save-button-main')?.disabled && !localStorage.getItem(window.localeEditors.documentKey));
    assert.equal(await unsavedGuard(), false);
    assert.equal(await page.$eval(documentInput, node => node.value), 'Fixture saved body dirty');
    assert.equal(await same('documentNodes', ['.editor-page', documentInput, '.title-field input', documentSave]), true);
    await append(documentInput, ' next');
    await page.click(documentSave);
    await pendingSave('/document');
    const documentWrites = await mutations('/document');
    assert.deepEqual(documentWrites.map(item => ({ ...item.body, path: '<synthetic-document>' })), [
      { path: '<synthetic-document>', body: 'Fixture saved body dirty', changes: {}, revision: 'document-r1', saveMode: 'local' },
      { path: '<synthetic-document>', body: 'Fixture saved body dirty next', changes: {}, revision: 'document-r2', saveMode: 'local' },
    ], 'the real child advances its revision only after successful save');
    assert.ok(documentWrites.every(item => item.body.path === 'content/articles/locale-fixture/index.md'));
    await resolveSave('/document', 'document-r3');
    await idle();
    await page.waitForFunction(() => document.querySelector('.editor-save-actions .save-button-main')?.disabled && !localStorage.getItem(window.localeEditors.documentKey));
    await settle();
    assert.equal(await count(docGet), 1, 'saved/dirty switches and ordinary article saves do not reload the document');
    assert.equal(await count('/document', 'PUT'), 2);
    assert.equal(await count('/settings/site', 'PUT'), 3);
    assert.equal(await page.$('.editor-page [role="alert"]'), null);
    assert.deepEqual(await page.evaluate(() => window.localeEditors.unexpected), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const executablePath = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to Chrome/Chromium.');
  const browser = await puppeteer.launch({ headless: true, executablePath });
  try {
    await checkAppLocaleEditors(browser);
    console.log('PASS: real App settings/source-document locale preservation, dirty drafts, actual pending mutations, settings HTTP 409 and revision-correct saves.');
  } finally { await browser.close(); }
}
