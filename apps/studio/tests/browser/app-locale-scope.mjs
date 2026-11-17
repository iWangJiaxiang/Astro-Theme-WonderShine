import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { fixtureAssetPlugin } from './fixture-asset-plugin.mjs';

const studio = fileURLToPath(new URL('../../', import.meta.url));
const timeout = 5_000;

// Scheduling evidence for the real App/api/InflightQuery/reactivity boundary,
// not editor preservation, pointer interaction, native acceptance or a live site.
// Only unrelated App children are isolated, as in dashboard-preview.mjs.
async function bundleFixture() {
  return build({
    stdin: { resolveDir: studio, loader: 'tsx', sourcefile: 'app-locale-scope-fixture.tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './src/App';
import { api, session, pendingMutations, setApiTransport } from './src/api';
import { setLocale } from './src/i18n';
import { notifyWorkspaceChanged } from './src/workspace-events';
setLocale('zh-CN');
const identity = (id = 'synthetic') => ({ identity: { id, name: id, method: 'password' }, csrf: 'fixture-csrf', expires: 9999999999 });
const rows = title => [{ path: 'content/articles/example/index.md', title, date: '2026-01-01', draft: false, kind: 'article', tags: [], categories: [] }];
const bootstrap = title => ({ site: { base_url: 'https://synthetic.example/' + title }, appearance: {}, mode: 'local', workspace: true, saveScope: title, saveCapabilities: { modes: ['local'], defaultMode: 'local' }, groups: [{ id: 'site', title }] });
const requests = [];
let mutationStarted = false, mutationResult = 'idle';
const classify = path => path === '/auth/session' ? 'auth' : path.startsWith('/bootstrap') ? 'bootstrap' : path === '/settings/site' ? 'mutation' : path.startsWith('/content?') || path === '/content' ? 'content' : 'other';
setApiTransport((path, init) => {
  // The optional preview endpoint is unrelated to authoritative content ownership.
  if (path === '/content-preview') return Promise.resolve(Response.json(null));
  const kind = classify(path);
  if (kind === 'other') throw new Error('Unexpected fixture endpoint');
  if (requests.length >= 80) throw new Error('Fixture request bound exceeded');
  return new Promise((resolve, reject) => requests.push({
    id: requests.length + 1, kind, refresh: path.includes('refresh=1'),
    language: new Headers(init.headers).get('Accept-Language'), method: init.method,
    signal: init.signal, resolve, reject, released: false, jsonStarted: false, jsonReleased: false,
  })); // Deliberately ignore abort: stale callbacks must be safe even if native transport ignores it.
});
const root = createRoot(document.getElementById('root'));
let mounted = true;
window.fixture = {
  observe() {
    // Bounded, synthetic endpoint categories only; no production path/payload trace.
    return { requests: requests.map(({ id, kind, refresh, language, method, signal, released, jsonStarted, jsonReleased }) => ({ id, kind, refresh, language, method, aborted: !!signal?.aborted, released, jsonStarted, jsonReleased })), pendingMutations: pendingMutations.value, mutationResult };
  },
  event(kind, value) {
    if (kind === 'locale') setLocale(value);
    else if (kind === 'login') session.value = identity(value);
    else if (kind === 'logout') session.value = null;
    else if (kind === 'session-field') {
      if (!session.value) throw new Error('Missing session');
      if (value === 'id') session.value.identity.id += '-next';
      else if (value === 'method') session.value.identity.method = 'oidc';
      else if (value === 'csrf') session.value.csrf += '-next';
      else if (value === 'expires') session.value.expires++;
      else throw new Error('Unknown session field');
    }
    else if (kind === 'workspace') notifyWorkspaceChanged();
    else if (kind === 'unmount') { if (mounted) { mounted = false; root.unmount(); } }
    else if (kind === 'mutation') {
      if (mutationStarted) throw new Error('Mutation must be initiated only once');
      mutationStarted = true;
      mutationResult = 'pending';
      // One real settings endpoint, no save wrapper, replay, or state injection.
      void api('/settings/site', 'PUT', { values: { title: 'Synthetic' }, revision: 'fixture' }).then(
        () => { mutationResult = 'success'; }, () => { mutationResult = 'failure'; },
      );
    }
    else throw new Error('Unknown fixture event');
  },
  release(id, options = {}) {
    const item = requests.find(item => item.id === id);
    if (!item || item.released) throw new Error('Missing held transport');
    item.released = true;
    if (options.timeout) { item.reject(new DOMException('Synthetic timeout', 'TimeoutError')); return; }
    const status = options.status || 200;
    const data = status !== 200 ? { error: options.error || 'fixture-current-' + status }
      : item.kind === 'auth' ? identity()
      : item.kind === 'bootstrap' ? bootstrap(options.title || 'Config')
      : item.kind === 'content' ? rows(options.title || 'Fresh') : { ok: true };
    // A genuine HTTP 200 Response, not a fake status/ok wrapper. Hold the JSON
    // boundary separately to exercise api.request's second scope check.
    const response = Response.json(data, { status });
    const json = response.json.bind(response);
    response.json = () => {
      item.jsonStarted = true;
      if (!options.holdJSON) { item.jsonReleased = true; return json(); }
      return new Promise((resolve, reject) => { item.releaseJSON = () => { item.jsonReleased = true; json().then(resolve, reject); }; });
    };
    item.resolve(response);
  },
  releaseJSON(id) {
    const item = requests.find(item => item.id === id);
    if (!item?.releaseJSON || item.jsonReleased) throw new Error('Missing held JSON');
    item.releaseJSON();
  },
};
root.render(<App />);
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    loader: { '.css': 'empty' },
    plugins: [fixtureAssetPlugin(), {
      name: 'isolate-unrelated-app-children',
      setup(builder) {
        builder.onResolve({ filter: /(?:components\/|platform\/(?:LegacyRecovery|NativeAiSettings|WorkspacePanel))/ }, args => {
          if (args.path === './components/Icon' || args.path === './components/LoadingState') return;
          if (args.importer.endsWith('/src/App.tsx')) return { path: args.path, namespace: 'app-locale-child' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'app-locale-child' }, args => ({
          loader: 'tsx', resolveDir: studio, contents: `
import React from 'react';
function Child() { return ${JSON.stringify(args.path)}.endsWith('LoginView') ? <div data-fixture-login /> : null; }
export default Child;
export { Child as LegacyRecovery, Child as NativeAiSettings, Child as WorkspacePanel };
`,
        }));
      },
    }],
  });
}

async function fixtureStyles() {
  const stylesheets = [
    'platform/native.css', 'platform/mobile.css',
    '../../packages/theme/styles/components/common/variables.css',
    'src/style.css', 'src/forms.css', 'src/composer.css', 'src/workspace.css',
    'src/creation-tools.css', 'src/accessibility.css',
  ];
  const font = await readFile(join(studio, '../../packages/theme/assets/icon/fonts/icomoon.woff'));
  return (await Promise.all(stylesheets.map(path => readFile(join(studio, path), 'utf8')))).join('\n')
    .replace(/^@import ['"](?:\.\.\/\.\.\/\.\.\/packages\/theme\/styles\/components\/common\/variables\.css|vditor\/dist\/index\.css)['"];\s*$/gm, '')
    .replace("url('../../../packages/theme/assets/icon/fonts/icomoon.woff')", `url('data:font/woff;base64,${font.toString('base64')}')`);
}

async function withFixture(browser, script, css, check) {
  const page = await browser.newPage(), errors = [], warnings = [];
  page.setDefaultTimeout(timeout);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') warnings.push(message.text()); });
  let primary;
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (request.isNavigationRequest()
        ? request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div></body></html>' })
        : request.abort()).catch(error => errors.push(error.message));
    });
    await page.goto('https://app-locale.example');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: script });
    const state = () => page.evaluate(() => window.fixture.observe());
    const event = (kind, value) => page.evaluate((kind, value) => window.fixture.event(kind, value), kind, value);
    const release = (item, options = {}) => page.evaluate((id, options) => window.fixture.release(id, options), item.id, options);
    const releaseJSON = item => page.evaluate(id => window.fixture.releaseJSON(id), item.id);
    const tick = () => page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 0)));
    const requests = async (kind, refresh = false) => (await state()).requests.filter(item => item.kind === kind && item.refresh === refresh);
    const request = async (kind, ordinal = 1, refresh = false) => {
      await page.waitForFunction((kind, ordinal, refresh) => window.fixture.observe().requests.filter(item => item.kind === kind && item.refresh === refresh).length >= ordinal, { timeout }, kind, ordinal, refresh);
      return (await requests(kind, refresh))[ordinal - 1];
    };
    const visible = title => page.waitForFunction(title => document.querySelector('.home-grid')?.textContent.includes(title), { timeout }, title);
    const config = title => page.waitForFunction(title => [...document.querySelectorAll('aside nav button')].some(node => node.textContent === title), { timeout }, title);
    const alert = text => page.waitForFunction(text => document.querySelector('main .notice.error')?.textContent.includes(text), { timeout }, text);
    const noError = async () => assert.equal(await page.$('main .notice.error'), null, 'obsolete errors must not reach the current App');
    const start = async () => {
      await release(await request('auth'));
      await page.waitForSelector('.studio-shell');
      return { bootstrap: await request('bootstrap'), content: await request('content') };
    };
    const warm = async () => {
      const initial = await start();
      await release(initial.bootstrap, { title: 'Initial config' });
      await release(initial.content, { title: 'Initial content' });
      await visible('Initial content');
      await config('Initial config');
      return initial;
    };
    await check({ page, state, event, release, releaseJSON, tick, requests, request, visible, config, alert, noError, start, warm });
  } catch (error) { primary = error; }
  // Drain late rejections before closing, and preserve the original assertion if
  // independent cleanup/error assertions fail. No raw DOM/network artifacts.
  try {
    await page.evaluate(() => window.fixture?.event('unmount'));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.deepEqual(errors, [], 'no page errors or unhandled rejections');
    assert.deepEqual(warnings, [], 'no React/console errors');
  } catch (error) { if (primary) primary = new AggregateError([primary, error], 'App locale check and cleanup failed'); else primary = error; }
  try { await page.close(); }
  catch (error) { if (primary) primary = new AggregateError([primary, error], 'App locale check and page close failed'); else primary = error; }
  if (primary) throw primary;
}

export async function checkAppLocaleScope(browser) {
  const [fixture, css] = await Promise.all([bundleFixture(), fixtureStyles()]);
  const run = check => withFixture(browser, fixture.outputFiles[0].text, css, check);

  await run(async ({ page, start, event, request, requests, release, releaseJSON, visible, config, tick, noError, state }) => {
    const old = await start();
    await release(old.bootstrap, { title: 'Obsolete config', holdJSON: true });
    await page.waitForFunction(id => window.fixture.observe().requests.find(item => item.id === id)?.jsonStarted, { timeout }, old.bootstrap.id);
    await event('locale', 'en');
    const freshBootstrap = await request('bootstrap', 2), freshContent = await request('content', 2);
    assert.equal(freshBootstrap.language, 'en');
    assert.equal(freshContent.language, 'en');
    assert.equal((await state()).requests.find(item => item.id === old.content.id).aborted, true);
    await release(freshBootstrap, { title: 'English config' });
    await release(freshContent, { title: 'English content' });
    await visible('English content');
    await config('English config');
    await releaseJSON(old.bootstrap);
    await release(old.content, { title: 'Obsolete content' });
    await tick();
    await noError();
    assert.doesNotMatch(await page.$eval('main', node => node.textContent), /Obsolete/);
    assert.equal(await page.$eval('.visit-site', node => new URL(node.href).pathname), '/English%20config');
    // Once loaded, locale is not a blanket reload/reset. Roundtripping must not
    // reuse old scope work or discard the authoritative data already displayed.
    await event('locale', 'zh-CN');
    await tick();
    await visible('English content');
    await config('English config');
    await event('locale', 'en');
    await tick();
    assert.equal((await requests('bootstrap')).length, 2);
    assert.equal((await requests('content')).length, 2);
    await noError();
  });

  // Readiness is independent: restart only the pending/missing App resource.
  for (const missing of ['bootstrap', 'content']) {
    await run(async ({ start, release, event, request, requests, visible, config, tick, noError }) => {
      const initial = await start();
      const loaded = missing === 'bootstrap' ? 'content' : 'bootstrap';
      await release(initial[loaded], { title: 'Retained ' + loaded });
      if (loaded === 'content') await visible('Retained content');
      else await config('Retained bootstrap');
      await event('locale', 'en');
      const replacement = await request(missing, 2);
      assert.equal(replacement.language, 'en');
      await release(initial[missing], { status: 409, error: 'obsolete-missing-error' });
      await tick();
      assert.equal((await requests(loaded)).length, 1, 'loaded resource must not be replaced');
      await noError();
      await release(replacement, { title: 'Replacement ' + missing });
      await visible(missing === 'content' ? 'Replacement content' : 'Retained content');
      await config(missing === 'bootstrap' ? 'Replacement bootstrap' : 'Retained bootstrap');
      await noError();
    });
  }

  // Exercise both App catches with actual ApiErrors, including 409. These are
  // current failures, not stale-scope cancellation; no automatic retry is valid.
  for (const kind of ['bootstrap', 'content']) {
    for (const status of [409, 408, 502]) {
      await run(async ({ start, release, alert, requests, tick, page }) => {
        const initial = await start();
        const other = kind === 'bootstrap' ? 'content' : 'bootstrap';
        await release(initial[other]);
        await release(initial[kind], status === 408 ? { timeout: true } : { status });
        await alert(status === 408 ? '连接超时，请重试。' : 'fixture-current-' + status);
        await tick();
        assert.equal((await requests(kind)).length, 1, 'a current error does not retry itself');
        assert.equal((await requests(kind, true)).length, 0);
        assert.equal(await page.$eval('main .notice.error button', node => node.disabled), false, 'current finally releases loading ownership');
      });
    }
  }

  await run(async ({ warm, event, request, requests, release, releaseJSON, page, tick, visible, noError }) => {
    await warm();
    await event('workspace');
    const oldBootstrap = await request('bootstrap', 1, true);
    await release(oldBootstrap, { title: 'Old forced config', holdJSON: true });
    await page.waitForFunction(id => window.fixture.observe().requests.find(item => item.id === id)?.jsonStarted, { timeout }, oldBootstrap.id);
    await event('locale', 'en');
    const middleBootstrap = await request('bootstrap', 2, true);
    assert.equal(middleBootstrap.language, 'en');
    assert.equal((await requests('content', true)).length, 0, 'forced content waits for the new forced bootstrap');
    await releaseJSON(oldBootstrap);
    await tick();
    await noError();
    // An old refresh finally must not clear the newer chain's pending owner.
    await event('locale', 'zh-CN');
    const latestBootstrap = await request('bootstrap', 3, true);
    assert.equal(latestBootstrap.language, 'zh-CN');
    await release(middleBootstrap, { status: 502, error: 'obsolete-forced-bootstrap' });
    await tick();
    assert.equal((await requests('content', true)).length, 0);
    await release(latestBootstrap, { title: 'Roundtrip config' });
    const content = await request('content', 1, true);
    assert.equal(content.language, 'zh-CN');
    await release(content, { title: 'Roundtrip forced content' });
    await visible('Roundtrip forced content');
    assert.equal((await requests('bootstrap')).length, 1, 'no ordinary bootstrap substitution');
    assert.equal((await requests('content')).length, 1, 'no ordinary content substitution');
    await noError();
  });

  await run(async ({ warm, event, request, requests, release, tick, visible, alert, page, noError }) => {
    await warm();
    await event('workspace');
    await release(await request('bootstrap', 1, true));
    const oldContent = await request('content', 1, true);
    await event('locale', 'en');
    const middleBootstrap = await request('bootstrap', 2, true);
    await release(oldContent, { title: 'Obsolete forced content' });
    await tick();
    await noError();
    await event('locale', 'zh-CN');
    const currentBootstrap = await request('bootstrap', 3, true);
    await release(middleBootstrap, { status: 409, error: 'obsolete-forced-error' });
    await tick();
    assert.equal((await requests('content', true)).length, 1, 'old chain cannot advance');
    await release(currentBootstrap, { status: 502 });
    await alert('fixture-current-502');
    const failedChainContent = await request('content', 2, true);
    // Locale continuation calls refreshWorkspace(false): it must not erase an
    // already-visible error while restarting either phase of a forced chain.
    await event('locale', 'en');
    const finalBootstrap = await request('bootstrap', 4, true);
    await alert('fixture-current-502');
    assert.equal((await requests('content', true)).length, 2, 'content cannot skip bootstrap');
    await release(failedChainContent, { title: 'Obsolete failed-chain content' });
    await release(finalBootstrap, { title: 'Recovered config' });
    const finalContent = await request('content', 3, true);
    assert.equal(finalContent.language, 'en');
    await release(finalContent, { title: 'Recovered forced content' });
    await visible('Recovered forced content');
    await alert('fixture-current-502');
    assert.doesNotMatch(await page.$eval('main', node => node.textContent), /Obsolete/);
    assert.equal((await requests('bootstrap')).length, 1);
    assert.equal((await requests('content')).length, 1);
    assert.equal(await page.$eval('main .notice.error button', node => node.disabled), false);
  });

  await run(async ({ start, event, request, requests, release, tick, page, visible, noError }) => {
    const initial = await start();
    await release(initial.bootstrap);
    // Keep an ordinary content transport alive while sync and locale supersede
    // it. It cannot satisfy the forced obligation or populate the fresh shell.
    await event('workspace');
    const oldBootstrap = await request('bootstrap', 1, true);
    await event('locale', 'en');
    const currentBootstrap = await request('bootstrap', 2, true);
    await release(initial.content, { title: 'Ordinary obsolete content' });
    await release(oldBootstrap);
    await tick();
    assert.equal((await requests('content', true)).length, 0);
    assert.equal((await requests('content')).length, 1);
    assert.equal(await page.$('.home-grid .content-row'), null);
    await noError();
    await release(currentBootstrap);
    const forced = await request('content', 1, true);
    assert.equal(forced.language, 'en');
    await release(forced, { title: 'Forced authoritative content' });
    await visible('Forced authoritative content');
    await noError();
  });

  await run(async ({ start, event, request, release, tick, page, visible, noError }) => {
    const old = await start();
    await event('logout');
    await page.waitForSelector('[data-fixture-login]');
    await event('login', 'replacement-account');
    const nextBootstrap = await request('bootstrap', 2), nextContent = await request('content', 2);
    await release(old.bootstrap, { title: 'Old account config' });
    await release(old.content, { title: 'Old account content' });
    await tick();
    assert.equal(await page.$('.home-grid .content-row'), null);
    assert.equal(await page.$('.visit-site'), null);
    await noError();
    await release(nextBootstrap, { title: 'Replacement account config' });
    await release(nextContent, { title: 'Replacement account content' });
    await visible('Replacement account content');
    await noError();
  });

  await run(async ({ warm, event, request, requests, release, visible, state, page }) => {
    await warm();
    await event('mutation');
    const mutation = await request('mutation');
    assert.equal(mutation.method, 'PUT');
    assert.equal((await state()).pendingMutations, 1);
    await event('workspace');
    await release(await request('bootstrap', 1, true));
    await event('locale', 'en');
    await release(await request('bootstrap', 2, true));
    assert.equal((await requests('content', true)).length, 0, 'content transport waits for the held PUT');
    await release(mutation);
    const content = await request('content', 1, true);
    assert.equal(content.language, 'en');
    await release(content, { title: 'After single PUT' });
    await visible('After single PUT');
    await page.waitForFunction(() => window.fixture.observe().mutationResult === 'success', { timeout });
    assert.equal((await state()).pendingMutations, 0);
    assert.equal((await requests('mutation')).length, 1, 'locale/refresh may restart GETs but must never replay PUT');
  });

  await run(async ({ warm, event, request, release, page, visible, config, noError, tick, requests }) => {
    await warm();
    // All first five tuple members remain session boundaries, even if the
    // session object is replaced with equal fields, or fields mutate in place.
    for (const [index, field] of ['object', 'id', 'method', 'csrf', 'expires'].entries()) {
      await event(field === 'object' ? 'login' : 'session-field', field === 'object' ? 'synthetic' : field);
      const boot = await request('bootstrap', index + 2), content = await request('content', index + 2);
      assert.equal(await page.$('.home-grid .content-row'), null, 'session boundary clears authoritative rows');
      assert.equal(await page.$('.visit-site'), null, 'session boundary clears bootstrap data');
      await release(boot, { title: 'Session config ' + index });
      await release(content, { title: 'Session content ' + index });
      await visible('Session content ' + index);
      await config('Session config ' + index);
    }
    await event('workspace');
    const old = await request('bootstrap', 1, true);
    await event('logout');
    await page.waitForSelector('[data-fixture-login]');
    await event('locale', 'en');
    await release(old, { status: 502, error: 'old-account-error' });
    await tick();
    assert.equal((await requests('content', true)).length, 0, 'logout stops queued forced content');
    await event('login', 'after-logout');
    await release(await request('bootstrap', 7), { title: 'New account config' });
    await release(await request('content', 7), { title: 'New account content' });
    await visible('New account content');
    await noError();
    await event('workspace');
    const unmounted = await request('bootstrap', 2, true);
    await event('unmount');
    await page.waitForFunction(() => !document.querySelector('#root').childElementCount, { timeout });
    const before = (await requests('bootstrap', true)).length;
    await release(unmounted);
    await event('workspace');
    await event('locale', 'zh-CN');
    await tick();
    assert.equal((await requests('content', true)).length, 0, 'unmount stops queued forced content');
    assert.equal((await requests('bootstrap', true)).length, before, 'unmount removes workspace and locale subscriptions');
  });

  // Startup auth is a read in the same API scope. Locale must replace it;
  // generation churn must not strand checking or let stale auth log back in.
  await run(async ({ event, request, requests, release, tick, page, visible, noError }) => {
    const oldAuth = await request('auth');
    await event('locale', 'en');
    const currentAuth = await request('auth', 2);
    assert.equal(currentAuth.language, 'en');
    await release(oldAuth);
    await tick();
    assert.equal((await requests('bootstrap')).length, 0, 'stale auth must not establish a session');
    assert.equal(await page.$('[data-fixture-login]'), null, 'old auth finally must not end the current checking owner');
    await page.waitForSelector('#root > .loading-panel');
    await release(currentAuth);
    await release(await request('bootstrap'));
    await release(await request('content'), { title: 'Startup recovered' });
    await visible('Startup recovered');
    assert.equal(await page.$('[data-fixture-login]'), null);
    await noError();
  });

  for (const boundary of ['login', 'unmount']) {
    await run(async ({ event, request, requests, release, tick, page }) => {
      const oldAuth = await request('auth');
      await event(boundary, 'explicit-session');
      if (boundary === 'login') await page.waitForSelector('.studio-shell');
      else await page.waitForFunction(() => !document.querySelector('#root').childElementCount, { timeout });
      await release(oldAuth);
      await event('locale', 'en');
      await tick();
      assert.equal((await requests('auth')).length, 1, 'auth cannot restart after explicit session or unmount');
      assert.equal((await requests('bootstrap')).length, boundary === 'login' ? 2 : 0, 'late auth cannot replace an explicit session or remount App');
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const executablePath = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to Chrome/Chromium.');
  const browser = await puppeteer.launch({ headless: true, executablePath });
  try {
    await checkAppLocaleScope(browser);
    console.log('PASS: App locale/session ownership, forced refresh ordering, current errors, startup auth and mutation non-replay (isolated synthetic fixture).');
  } finally { await browser.close(); }
}
