import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import puppeteer from 'puppeteer-core';
import { fixtureAssetPlugin } from './fixture-asset-plugin.mjs';

const studio = fileURLToPath(new URL('../../', import.meta.url));
const timeout = 10_000;
const section = '[data-settings-group]';
const input = `${section} input[name="title"]`;
const save = `${section} .save-button-main`;
const retry = `${section} .settings-card > .notice.error button`;
const post = '[data-field="post.today_recommend.post_path"]';
const link = '[data-field="site.url-site-link"]';
const baseline = { title: 'Synthetic site', 'post.today_recommend.post_path': '', 'site.url': '/' };
const draft = (title = 'Synthetic site dirty', original = baseline, revision = 'settings-r1') => ({ values: { ...baseline, title }, baseline: original, revision });

// Outer finally probes observe the real caller and orphan request completion.
// They neither replace outcomes nor equate transport release with component finally.
function completionProbe(text, filename, names) {
  const tree = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true,
    filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [], found = new Set();
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
      const name = node.name.text;
      assert.ok(node.body && node.modifiers?.some(item => item.kind === ts.SyntaxKind.AsyncKeyword), 'Probe requires a real async function');
      assert.ok(!found.has(name), 'Probe function is unique');
      found.add(name);
      edits.push([node.body.getStart(tree) + 1, `\nconst __relationsCompletion = globalThis.__relationsTrace.begin(${JSON.stringify(name)}); try {\n`]);
      edits.push([node.body.end - 1, '\n} finally { globalThis.__relationsTrace.end(__relationsCompletion); }\n']);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(found.size, names.length, 'Every requested production function is observed');
  for (const [position, insertion] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, position) + insertion + text.slice(position);
  return text;
}

async function bundleFixture() {
  return build({
    stdin: { resolveDir: studio, loader: 'tsx', sourcefile: 'settings-relations-ownership-fixture.tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import SettingsView from './src/components/SettingsView';
import LanguageSwitcher from './src/components/LanguageSwitcher';
import { api, setApiTransport, session, reauthentication, pendingMutations } from './src/api';
import { setLocale, t } from './src/i18n';
setLocale('zh-CN');
session.value = { identity: { id: 'settings-relations', name: 'Synthetic editor', method: 'password' }, csrf: 'synthetic-csrf', expires: 9999999999 };
const initialValues = { title: 'Synthetic site', 'post.today_recommend.post_path': '', 'site.url': '/' };
const tokens = [], jobs = [], contexts = [], unexpected = [], dirtyEvents = [];
let armed = true, mounted = true, group = 'site', language, unhandled = 0, supplementalDone = false, supplementalCurrent = false;
window.addEventListener('unhandledrejection', () => { unhandled++; });
globalThis.__relationsTrace = {
  begin(kind) { if (tokens.length >= 160) throw new Error('Synthetic completion bound exceeded'); const token = { kind, done: false }; tokens.push(token); return token; },
  end(token) { if (token.done) throw new Error('Duplicate completion'); token.done = true; },
  capture(context) { if (!context) throw new Error('Missing real form context'); if (!contexts.includes(context)) contexts.push(context); },
};
const row = (marker, props = {}) => ({ path: 'content/articles/' + marker + '.md', title: marker, date: '2026-01-01', draft: false, kind: 'article', tags: [], categories: [], publicPath: '/' + marker, ...props });
const rows = marker => [
  row(marker),
  row('page-' + marker, { kind: 'page', path: 'content/pages/' + marker + '.md' }),
  row('index-' + marker, { path: 'content/articles/_index.en.md', publicPath: undefined }),
  row('error-' + marker, { error: 'Synthetic invalid file' }),
  row('duplicate-' + marker, { kind: 'page', publicPath: '/' + marker }),
  row('hidden-' + marker, { kind: 'page', render: false }),
  row('warning-' + marker, { kind: 'page', publicPath: undefined, linkWarning: '无法解析文章地址' }),
];
const dataFor = (job, marker) => job.kind === 'content' ? rows(marker || 'current') : job.kind === 'save'
  ? { revision: 'settings-r2', message: 'Synthetic saved' }
  : { id: group, title: '站点信息', description: '', file: 'config.toml', fields: [
      { path: 'title', label: '标题', kind: 'text', default: '' },
      { path: 'post.today_recommend.post_path', label: '文章', kind: 'text', default: '' },
      { path: 'site.url', label: '链接', kind: 'text', default: '/' },
    ], values: initialValues, revision: 'settings-r1' };
function release(id, options = {}) {
  const job = jobs[id - 1];
  if (!job || job.released) throw new Error('Missing held transport');
  job.released = true;
  if (options.timeout) { job.reject(new DOMException('Synthetic transport timeout', 'TimeoutError')); return; }
  const status = options.status || 200;
  const response = Response.json(status === 200 ? dataFor(job, options.marker) : { error: 'Synthetic current failure', revision: 'do-not-adopt' }, { status });
  const decode = response.json.bind(response);
  response.json = () => {
    job.jsonStarted = true;
    const read = () => { job.jsonReleased = true; return options.badJSON ? Promise.reject(new SyntaxError('Synthetic invalid JSON')) : decode(); };
    if (!options.holdJSON) return read();
    return new Promise((resolve, reject) => { job.decode = () => { read().then(resolve, reject); }; });
  };
  job.resolve(response);
}
setApiTransport((endpoint, init) => {
  if (jobs.length >= 40) throw new Error('Synthetic request bound exceeded');
  const kind = endpoint === '/content' || endpoint === '/content?refresh=1' ? 'content'
    : endpoint.startsWith('/settings/') ? (init.method === 'PUT' ? 'save' : 'settings') : 'unexpected';
  if (kind === 'unexpected') unexpected.push(kind);
  return new Promise((resolve, reject) => {
    const job = { id: jobs.length + 1, kind, method: init.method, language: new Headers(init.headers).get('Accept-Language'), refresh: endpoint.includes('refresh=1'), body: init.body ? JSON.parse(String(init.body)) : null, released: false, jsonStarted: false, jsonReleased: false, resolve, reject };
    job.requestToken = tokens.filter(token => token.kind === 'request' && !token.done).at(-1);
    if (!job.requestToken) throw new Error('Transport lacks a real request completion token');
    jobs.push(job);
    if (kind === 'settings' || (kind === 'content' && !armed)) release(job.id);
  }); // Deliberately ignores AbortSignal: stale orphan work must still drain.
});
const root = createRoot(document.getElementById('root'));
const storageKey = () => 'studio-settings:password:settings-relations:' + group + ':' + (language || 'default');
sessionStorage.clear();
function render() { root.render(<><LanguageSwitcher />{mounted ? <SettingsView key={group + ':' + (language || 'default')} group={group} language={language} embedded={!!language} onDirty={value => dirtyEvents.push(value)} /> : null}</>); }
const model = context => ({ loading: context.loading.value, error: typeof context.error.value === 'string' ? context.error.value : context.error.value.key,
  posts: context.posts.value.map(item => item.value), links: context.links.value.map(item => item.value), unresolved: context.unresolved.value.length });
window.relations = {
  start() { flushSync(render); },
  arm(value = true) { armed = value; },
  observe() { return {
    jobs: jobs.map(({ id, kind, method, language, refresh, released, jsonStarted, jsonReleased, requestToken, body }) => ({ id, kind, method, language, refresh, released, jsonStarted, jsonReleased, requestDone: requestToken.done, body })),
    tokens: tokens.map(({ kind, done }) => ({ kind, done })), models: contexts.map(model),
    pendingMutations: pendingMutations.value, reauthentication: reauthentication.value, hasSession: !!session.value, unhandled, unexpected: unexpected.length, dirty: dirtyEvents.at(-1), supplementalDone, supplementalCurrent,
  }; },
  release,
  decode(id) { const job = jobs[id - 1]; if (!job?.decode || job.jsonReleased) throw new Error('Missing held JSON'); job.decode(); },
  draft() { return JSON.parse(sessionStorage.getItem(storageKey()) || 'null'); },
  remember() { window.relationsNodes = ['[data-settings-group]', 'input[name="title"]', '.settings-save-actions .save-button-main'].map(selector => document.querySelector(selector)); return window.relationsNodes.every(Boolean); },
  same() { return ['[data-settings-group]', 'input[name="title"]', '.settings-save-actions .save-button-main'].every((selector, index) => window.relationsNodes[index]?.isConnected && document.querySelector(selector) === window.relationsNodes[index]); },
  hasError(key) { return document.querySelector('.settings-card > .notice.error')?.textContent.includes(t(key)) || false; },
  boundary(kind) {
    if (kind === 'unmount') mounted = false;
    else if (kind === 'mount') mounted = true;
    else if (kind === 'group') group = 'recommendations';
    else if (kind === 'group-return') group = 'site';
    else if (kind === 'language') language = 'en';
    else if (kind === 'language-return') language = undefined;
    else throw new Error('Unknown instance boundary');
    flushSync(render);
  },
  ordinaryContent() { void api('/content').then(items => { supplementalCurrent = items[0]?.title === 'current'; }, () => {}).finally(() => { supplementalDone = true; }); },
  retryThenLocale() {
    const button = document.querySelector('.settings-card > .notice.error button');
    if (!button) throw new Error('Missing real retry control');
    // Explicit same-task synthetic scheduling, not trusted-input acceptance.
    button.click();
    setLocale('en');
  },
  cleanup() {
    armed = false;
    flushSync(() => root.unmount());
    for (const job of jobs) if (!job.released) release(job.id);
    for (const job of jobs) if (job.decode && !job.jsonReleased) job.decode();
  },
};
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    loader: { '.css': 'empty' },
    plugins: [fixtureAssetPlugin(), {
      name: 'settings-relations-completion-and-consumer-observers',
      setup(builder) {
        builder.onLoad({ filter: /\/src\/(?:api\.ts|components\/SettingsView\.tsx)$/ }, async args => ({
          loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
          contents: completionProbe(await readFile(args.path, 'utf8'), args.path,
            args.path.endsWith('/api.ts') ? ['api', 'request'] : ['loadRelations', 'load', 'save']),
        }));
        // A genuine descendant injects the provided refs. Retaining those refs
        // also observes writes into retired models, not just a new instance's DOM.
        builder.onResolve({ filter: /^\.\/FormField$/ }, args => {
          if (args.importer.endsWith('/src/components/SettingsView.tsx')) return { path: args.path, namespace: 'relations-observed-field' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'relations-observed-field' }, () => ({
          loader: 'tsx', resolveDir: studio, contents: `
import React from 'react';
import RealFormField from './src/components/FormField';
import { component } from './src/react-component';
import { inject } from './src/reactivity';
import { formContext } from './src/form-context';
const Observer = component('RelationsContextConsumer', () => {
  globalThis.__relationsTrace.capture(inject(formContext));
  return () => null;
});
export default function ObservedField(props) { return <><Observer /><RealFormField {...props} /></>; }
`,
        }));
      },
    }],
  });
}

const observe = page => page.evaluate(() => window.relations.observe());
const release = (page, id, options = {}) => page.evaluate((id, options) => window.relations.release(id, options), id, options);
const decode = (page, id) => page.evaluate(id => window.relations.decode(id), id);
const boundary = (page, kind) => page.evaluate(kind => window.relations.boundary(kind), kind);
const wait = (page, predicate, ...args) => page.waitForFunction(predicate, { timeout }, ...args);
async function checkpoint(page) {
  // Task delivery catches late unhandled rejection events; it never substitutes
  // for the outer-finally tokens used by completion assertions below.
  await page.evaluate(limit => new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const close = () => { channel.port1.close(); channel.port2.close(); };
    const timer = setTimeout(() => { close(); reject(new Error('Synthetic task checkpoint timed out')); }, limit);
    channel.port1.onmessage = () => { clearTimeout(timer); close(); resolve(); };
    channel.port2.postMessage(null);
  }), timeout);
}
async function completed(page, kind, count) {
  await wait(page, (kind, count) => window.relations.observe().tokens.filter(token => token.kind === kind && token.done).length >= count, kind, count);
  assert.equal((await observe(page)).tokens.filter(token => token.kind === kind && token.done).length, count, 'Exact real function completion count');
  await checkpoint(page);
}
async function idle(page) {
  await wait(page, () => { const state = window.relations.observe(); return state.tokens.every(token => token.done) && state.pendingMutations === 0; });
  await checkpoint(page);
}
async function held(page, kind, ordinal) {
  await wait(page, (kind, ordinal) => window.relations.observe().jobs.filter(job => job.kind === kind).length >= ordinal, kind, ordinal);
  const jobs = (await observe(page)).jobs.filter(job => job.kind === kind);
  assert.equal(jobs.length, ordinal, 'Exact synthetic transport ordinal');
  return jobs[ordinal - 1];
}
async function atBoundary(page, job, phase, options) {
  if (phase === 'json') {
    await release(page, job.id, { ...options, holdJSON: true });
    await wait(page, id => window.relations.observe().jobs[id - 1].jsonStarted, job.id);
  }
}
async function finishBoundary(page, job, phase, options) {
  if (phase === 'json') await decode(page, job.id);
  else await release(page, job.id, options);
  await wait(page, id => window.relations.observe().jobs[id - 1].requestDone, job.id);
}
async function locale(page, language) {
  await page.select('.language-switcher select', language);
  await wait(page, language => document.documentElement.lang === language, language);
  await checkpoint(page);
}
async function formReady(page) {
  await page.waitForSelector(input, { timeout });
  await wait(page, () => window.relations.observe().models.length > 0);
  assert.equal(await page.$eval(input, node => node.value), 'Synthetic site');
}
async function append(page, text) {
  await page.focus(input);
  await page.$eval(input, node => node.setSelectionRange(node.value.length, node.value.length));
  await page.type(input, text);
}
async function makeDirty(page) {
  await append(page, ' dirty');
  await wait(page, () => window.relations.draft()?.values.title === 'Synthetic site dirty');
  assert.deepEqual(await page.evaluate(() => window.relations.draft()), draft());
  assert.equal(await page.evaluate(() => window.relations.remember()), true);
}
async function dirtyIntact(page) {
  assert.equal(await page.evaluate(() => window.relations.same()), true, 'Same mounted form, title input and save control');
  assert.equal(await page.$eval(input, node => node.value), 'Synthetic site dirty');
  assert.deepEqual(await page.evaluate(() => window.relations.draft()), draft(), 'Exact values, original baseline and revision remain owned by the dirty form');
  assert.equal((await observe(page)).dirty, true, 'Real child dirty callback remains true');
  assert.equal(await page.$eval(save, node => node.disabled), false);
}
async function controls(page, loading, error) {
  await wait(page, (loading, error) => {
    const model = window.relations.observe().models.at(-1);
    return model?.loading === loading && !!model.error === error;
  }, loading, error);
  for (const [selector, disabled] of [[post, loading || error], [link, loading]]) {
    await wait(page, (selector, disabled) => {
      const nodes = [...document.querySelectorAll(selector + ' button, ' + selector + ' input')];
      return nodes.length > 0 && nodes.every(node => node.matches(':disabled') === disabled);
    }, selector, disabled);
  }
  assert.equal(await page.$eval(`${section} input[name="site.url"]`, node => node.disabled), false, 'Manual link text remains editable');
}
async function latest(page, marker = 'current') {
  await controls(page, false, false);
  const model = (await observe(page)).models.at(-1);
  assert.deepEqual(model.posts, [`articles/${marker}.md`], 'Post choices exclude pages, index files and invalid files');
  assert.deepEqual(model.links, ['/', `/${marker}`, `/page-${marker}`], 'Internal links retain home, filter render=false/errors and deduplicate public paths');
  assert.equal(model.unresolved, 1, 'Current unresolved content is retained');
  assert.equal(await page.$(`${section} .settings-card > .notice.error`), null);
}
function readCounts(state) {
  return { settings: state.jobs.filter(job => job.kind === 'settings').length, saves: state.jobs.filter(job => job.kind === 'save').length };
}

async function inRealm(browser, bundle, scenario) {
  const page = await browser.newPage();
  let pageErrors = 0, initialized = false, failed = false, failure;
  const cleanupFailures = [];
  page.on('pageerror', () => pageErrors++);
  page.setDefaultTimeout(timeout);
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => request.isNavigationRequest()
      ? request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
      : request.abort());
    await page.goto('https://settings-relations.example');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    initialized = true;
    await page.evaluate(() => window.relations.start());
    await formReady(page);
    await scenario(page);
    assert.equal(pageErrors, 0, 'No uncaught browser exception');
    assert.equal((await observe(page)).unexpected, 0, 'Only declared synthetic routes are used');
  } catch (error) { failed = true; failure = error; }
  finally {
    if (initialized) {
      try {
        await page.evaluate(() => window.relations.cleanup());
        await wait(page, () => {
          const state = window.relations.observe();
          return state.tokens.every(token => token.done) && state.pendingMutations === 0 && state.jobs.every(job => job.released && (!job.jsonStarted || job.jsonReleased));
        });
      } catch { cleanupFailures.push('unmount-drain'); }
      try {
        await checkpoint(page);
        const state = await observe(page);
        assert.equal(state.unhandled, 0, 'Realm closure cannot hide an orphan rejection');
        assert.equal(state.unexpected, 0);
        assert.equal(pageErrors, 0, 'Cleanup observes late uncaught errors');
      } catch { cleanupFailures.push('checkpoint'); }
    }
    try { await page.close(); } catch { cleanupFailures.push('page-close'); }
  }
  if (cleanupFailures.length) console.error(JSON.stringify({ fixture: 'settings-relations-ownership', cleanupFailed: true, stages: cleanupFailures }));
  if (failed) throw failure;
  if (cleanupFailures.length) throw new Error('Settings relations cleanup failed: ' + cleanupFailures[0]);
}

// Direct SettingsView realms are deliberately not App authentication/navigation,
// cross-session/transport recovery, CSS, server persistence or native acceptance.
export async function checkSettingsRelationsOwnership(browser) {
  const bundle = await bundleFixture();
  const designedCases = [];
  const run = async (description, scenario) => {
    designedCases.push(description);
    await inRealm(browser, bundle, scenario);
  };

  await run('loaded dirty form: locale roundtrip preserves data, exact draft, DOM and no GET/PUT', async page => {
    await release(page, (await held(page, 'content', 1)).id);
    await completed(page, 'loadRelations', 1);
    await idle(page);
    await latest(page);
    await makeDirty(page);
    const before = await observe(page);
    for (const language of ['en', 'zh-CN']) {
      await locale(page, language);
      await dirtyIntact(page);
      await latest(page);
      assert.deepEqual((await observe(page)).jobs, before.jobs, 'Settled loaded locale is not a GET or mutation boundary');
    }
  });

  for (const phase of ['transport', 'json']) for (const outcome of ['success', '502', '401', 'json-rejection']) for (const timing of ['pending', 'after-success']) {
    await run(`${phase}: locale zh/en/zh, late ${outcome} ${timing}, explicit caller/orphan completion and dirty form preservation`, async page => {
      const old = await held(page, 'content', 1);
      const options = outcome === 'success' ? { marker: 'obsolete' } : outcome === 'json-rejection' ? { badJSON: true } : { status: Number(outcome) };
      await atBoundary(page, old, phase, options);
      await makeDirty(page);
      await locale(page, 'en');
      const middle = await held(page, 'content', 2);
      await atBoundary(page, middle, phase, { status: 502 });
      // API invalidation can finish the caller before the held transport/body.
      await completed(page, 'loadRelations', 1);
      assert.equal((await observe(page)).jobs[old.id - 1].requestDone, false, 'Component completion is not orphan transport completion');
      await controls(page, true, false);
      await dirtyIntact(page);
      if (timing === 'pending') {
        await finishBoundary(page, old, phase, options);
        await completed(page, 'loadRelations', 1);
        await controls(page, true, false);
        assert.deepEqual((await observe(page)).models.at(-1).posts, [], 'Old transport/body cannot populate replacement choices');
        assert.deepEqual((await observe(page)).models.at(-1).links, ['/']);
        await dirtyIntact(page);
      }
      await locale(page, 'zh-CN');
      const current = await held(page, 'content', 3);
      await completed(page, 'loadRelations', 2);
      await controls(page, true, false);
      if (timing === 'pending') {
        await finishBoundary(page, middle, phase, { status: 502 });
        await controls(page, true, false);
      }
      await release(page, current.id);
      await completed(page, 'loadRelations', 3);
      await latest(page);
      if (timing === 'after-success') {
        await finishBoundary(page, old, phase, options);
        await finishBoundary(page, middle, phase, { status: 502 });
      }
      await idle(page);
      await latest(page);
      await dirtyIntact(page);
      const state = await observe(page);
      assert.equal(state.reauthentication, false, 'Late old-scope 401 cannot request reauthentication');
      assert.equal(state.hasSession, true);
      assert.deepEqual(readCounts(state), { settings: 1, saves: 0 }, 'Locale replacements touch relations only');
      assert.deepEqual(state.jobs.filter(job => job.kind === 'content').map(job => [job.refresh, job.language]), [[false, 'zh-CN'], [false, 'en'], [false, 'zh-CN']], 'Pending locale replacements are ordinary current-locale reads');
      const settled = state.jobs;
      await locale(page, 'en');
      assert.deepEqual((await observe(page)).jobs, settled, 'After current success another locale switch has no GET');
    });
  }

  for (const failure of ['409', '502', 'timeout', 'json-rejection']) {
    await run(`current ${failure}: retained nonempty choices/error across locale, actual forced retry only, failure then recovery`, async page => {
      await release(page, (await held(page, 'content', 1)).id);
      await completed(page, 'loadRelations', 1);
      await idle(page);
      await latest(page);
      // Explicit discard/reload is setup only: it is the public control that can
      // refresh already-loaded relations. Its main GET is counted before retry.
      await makeDirty(page);
      page.once('dialog', dialog => dialog.accept());
      await page.click(`${section} .settings-discard`);
      const refresh = await held(page, 'content', 2);
      assert.equal(refresh.refresh, true);
      await completed(page, 'load', 2);
      await wait(page, () => document.querySelector('input[name="title"]')?.value === 'Synthetic site' && window.relations.draft() === null);
      await makeDirty(page);
      const retained = (await observe(page)).models.at(-1);
      assert.deepEqual(retained.posts, ['articles/current.md']);
      assert.equal(retained.loading, true);
      const options = failure === 'timeout' ? { timeout: true } : failure === 'json-rejection' ? { badJSON: true } : { status: Number(failure) };
      await release(page, refresh.id, options);
      await completed(page, 'loadRelations', 2);
      await idle(page);
      const errorKey = failure === 'timeout' ? '连接超时，请重试。' : failure === 'json-rejection' ? '请求失败，请稍后再试' : 'Synthetic current failure';
      await controls(page, false, true);
      assert.equal(await page.evaluate(key => window.relations.hasError(key), errorKey), true, 'Real current error remains visible with API mapping');
      const failed = await observe(page);
      assert.deepEqual(failed.models.at(-1), { ...retained, loading: false, error: errorKey });
      for (const language of ['en', 'zh-CN']) {
        await locale(page, language);
        await controls(page, false, true);
        await dirtyIntact(page);
        assert.equal(await page.evaluate(key => window.relations.hasError(key), errorKey), true);
        assert.deepEqual((await observe(page)).models.at(-1), failed.models.at(-1), 'Locale retains both choices and settled error');
        assert.deepEqual((await observe(page)).jobs, failed.jobs, 'Settled error is not automatically retried');
      }
      await page.click(retry);
      const forced = await held(page, 'content', 3);
      assert.equal(forced.refresh, true);
      await controls(page, true, false);
      assert.deepEqual(readCounts(await observe(page)), readCounts(failed), 'Real retry control does not reload settings or save');
      assert.deepEqual((await observe(page)).models.at(-1), { ...retained, error: '' }, 'Retry clears error but retains previous choices');
      await release(page, forced.id, { status: 502 });
      await completed(page, 'loadRelations', 3);
      await controls(page, false, true);
      await dirtyIntact(page);
      await page.click(retry);
      const recovery = await held(page, 'content', 4);
      assert.equal(recovery.refresh, true);
      await release(page, recovery.id);
      await completed(page, 'loadRelations', 4);
      await idle(page);
      await latest(page);
      await dirtyIntact(page);
      assert.deepEqual(readCounts(await observe(page)), { settings: 2, saves: 0 }, 'Only the intentional setup reload fetched main settings');
      assert.deepEqual((await observe(page)).jobs.filter(job => job.kind === 'content').map(job => job.refresh), [false, true, true, true]);
    });
  }

  for (const phase of ['transport', 'json']) {
    await run(`${phase}: actual forced retry supersedes supplemental ordinary query without waiting for its orphan transport`, async page => {
      await release(page, (await held(page, 'content', 1)).id, { status: 502 });
      await completed(page, 'loadRelations', 1);
      await idle(page);
      await controls(page, false, true);
      await makeDirty(page);
      await page.evaluate(() => window.relations.ordinaryContent());
      const ordinary = await held(page, 'content', 2);
      await atBoundary(page, ordinary, phase, { marker: 'obsolete' });
      await page.click(retry);
      const forced = await held(page, 'content', 3);
      assert.equal(forced.refresh, true);
      await release(page, forced.id);
      await completed(page, 'loadRelations', 2);
      await wait(page, () => window.relations.observe().supplementalDone);
      assert.equal((await observe(page)).supplementalCurrent, true, 'Ordinary reader follows the actual forced InflightQuery result');
      assert.equal((await observe(page)).jobs[ordinary.id - 1].requestDone, false, 'Current success does not require obsolete transport/body completion');
      await latest(page);
      await finishBoundary(page, ordinary, phase, { marker: 'obsolete' });
      await idle(page);
      await latest(page);
      await dirtyIntact(page);
      assert.deepEqual(readCounts(await observe(page)), { settings: 1, saves: 0 });
    });

    await run(`${phase}: pending forced retry locale replacement retains refresh obligation, no mutation or main reload`, async page => {
      await release(page, (await held(page, 'content', 1)).id, { status: 502 });
      await completed(page, 'loadRelations', 1);
      await idle(page);
      await page.click(retry);
      const forced = await held(page, 'content', 2);
      await atBoundary(page, forced, phase, { marker: 'obsolete' });
      await locale(page, 'en');
      const replacement = await held(page, 'content', 3);
      await completed(page, 'loadRelations', 2);
      assert.equal(replacement.refresh, true, 'Locale retains the unfinished explicit refresh obligation');
      await atBoundary(page, replacement, phase, { status: 502 });
      await finishBoundary(page, forced, phase, { marker: 'obsolete' });
      await controls(page, true, false);
      await locale(page, 'zh-CN');
      const current = await held(page, 'content', 4);
      assert.equal(current.refresh, true, 'Locale A/B/A cannot downgrade the still-pending refresh');
      await completed(page, 'loadRelations', 3);
      await finishBoundary(page, replacement, phase, { status: 502 });
      await controls(page, true, false);
      await release(page, current.id);
      await completed(page, 'loadRelations', 4);
      await idle(page);
      await latest(page);
      assert.deepEqual(readCounts(await observe(page)), { settings: 1, saves: 0 });
      assert.deepEqual((await observe(page)).jobs.filter(job => job.kind === 'content').map(job => job.refresh), [false, true, true, true]);
      const settled = (await observe(page)).jobs;
      await locale(page, 'en');
      assert.deepEqual((await observe(page)).jobs, settled, 'Current forced completion ends loading without an automatic followup GET');
    });
  }

  await run('same dispatch task: native retry click then locale before transport executes, refresh survives roundtrip', async page => {
    await release(page, (await held(page, 'content', 1)).id, { status: 502 });
    await completed(page, 'loadRelations', 1);
    await idle(page);
    await makeDirty(page);
    await page.evaluate(() => window.relations.retryThenLocale());
    const replacement = await held(page, 'content', 2);
    await completed(page, 'loadRelations', 2);
    assert.equal((await observe(page)).tokens.filter(token => token.kind === 'loadRelations').length, 3, 'Both real retry and locale invocation started');
    assert.deepEqual([replacement.refresh, replacement.language], [true, 'en'], 'Forced caller retired before its transport executes; replacement is still forced');
    await controls(page, true, false);
    await locale(page, 'zh-CN');
    const current = await held(page, 'content', 3);
    await completed(page, 'loadRelations', 3);
    assert.deepEqual([current.refresh, current.language], [true, 'zh-CN']);
    await release(page, replacement.id, { status: 502 });
    await wait(page, id => window.relations.observe().jobs[id - 1].requestDone, replacement.id);
    await controls(page, true, false);
    await release(page, current.id);
    await completed(page, 'loadRelations', 4);
    await idle(page);
    await latest(page);
    await dirtyIntact(page);
    assert.deepEqual(readCounts(await observe(page)), { settings: 1, saves: 0 });
    const settled = (await observe(page)).jobs;
    await locale(page, 'en');
    assert.deepEqual((await observe(page)).jobs, settled, 'Settling current forced work clears the obligation without automatic GET');
  });

  for (const putPhase of ['transport', 'json']) {
    await run(`${putPhase}: real pending PUT fences forced retry transport, locale roundtrip retains refresh before any content transport`, async page => {
      await release(page, (await held(page, 'content', 1)).id, { status: 502 });
      await completed(page, 'loadRelations', 1);
      await idle(page);
      await makeDirty(page);
      await page.click(save);
      const put = await held(page, 'save', 1);
      await atBoundary(page, put, putPhase, {});
      await wait(page, () => window.relations.observe().pendingMutations === 1);
      await page.click(retry);
      await controls(page, true, false);
      assert.equal((await observe(page)).tokens.filter(token => token.kind === 'loadRelations').length, 2, 'Forced retry starts behind the real mutation fence');
      assert.equal((await observe(page)).jobs.filter(job => job.kind === 'content').length, 1, 'Forced retry has no transport yet');
      for (const [index, language] of ['en', 'zh-CN'].entries()) {
        await locale(page, language);
        await completed(page, 'loadRelations', index + 2);
        await controls(page, true, false);
        assert.equal((await observe(page)).jobs.filter(job => job.kind === 'content').length, 1, 'Locale replacement remains fenced, not silently downgraded');
        assert.equal(await page.evaluate(() => window.relations.same()), true);
        assert.deepEqual(await page.evaluate(() => window.relations.draft()), draft());
        assert.deepEqual(readCounts(await observe(page)), { settings: 1, saves: 1 }, 'Pending retry cannot replay settings PUT or GET');
      }
      assert.deepEqual(put.body, { revision: 'settings-r1', changes: { title: 'Synthetic site dirty' }, saveMode: 'local' });
      await finishBoundary(page, put, putPhase, {});
      await completed(page, 'save', 1);
      const current = await held(page, 'content', 2);
      assert.deepEqual([current.refresh, current.language], [true, 'zh-CN'], 'First post-fence transport preserves the forced obligation of the retired caller');
      await release(page, current.id);
      await completed(page, 'loadRelations', 4);
      await idle(page);
      await latest(page);
      assert.equal(await page.evaluate(() => window.relations.same()), true);
      assert.equal(await page.evaluate(() => window.relations.draft()), null, 'Only the explicit successful save clears the submitted draft');
      assert.deepEqual(readCounts(await observe(page)), { settings: 1, saves: 1 });
    });
  }

  for (const phase of ['transport', 'json']) for (const outcome of ['success', '502', 'json-rejection']) {
    await run(`${phase}: unmount permanently retires the actual model before late ${outcome}, then fresh same-key mount`, async page => {
      const old = await held(page, 'content', 1);
      const options = outcome === 'success' ? { marker: 'obsolete' } : outcome === 'json-rejection' ? { badJSON: true } : { status: 502 };
      await atBoundary(page, old, phase, options);
      await makeDirty(page);
      await boundary(page, 'unmount');
      const retired = (await observe(page)).models[0];
      assert.equal(await page.$(section), null);
      await finishBoundary(page, old, phase, options);
      await completed(page, 'loadRelations', 1);
      await idle(page);
      assert.deepEqual((await observe(page)).models[0], retired, 'Retired model refs do not receive success, catch or finally writes');
      await boundary(page, 'mount');
      const current = await held(page, 'content', 2);
      await release(page, current.id);
      await completed(page, 'loadRelations', 2);
      await idle(page);
      await latest(page);
      assert.equal((await observe(page)).models.length, 2, 'Fresh same-key mount is a distinct model');
      assert.deepEqual((await observe(page)).models[0], retired);
      assert.deepEqual(await page.evaluate(() => window.relations.draft()), draft(), 'Same-owner draft recovers with original revision/baseline');
    });
  }

  for (const kind of ['group', 'language']) for (const phase of ['transport', 'json']) {
    await run(`${phase}: keyed ${kind} roundtrip shares pending API work but never revives retired model authority`, async page => {
      const shared = await held(page, 'content', 1);
      await atBoundary(page, shared, phase, { marker: 'current' });
      await makeDirty(page);
      await boundary(page, kind);
      await wait(page, () => window.relations.observe().models.length === 2);
      const first = (await observe(page)).models[0];
      await boundary(page, kind + '-return');
      await wait(page, () => window.relations.observe().models.length === 3);
      const second = (await observe(page)).models[1];
      assert.equal((await observe(page)).jobs.filter(job => job.kind === 'content').length, 1, 'Content-language/group keys do not invent API scope invalidation');
      await finishBoundary(page, shared, phase, { marker: 'current' });
      await completed(page, 'loadRelations', 3);
      await idle(page);
      await latest(page);
      const models = (await observe(page)).models;
      assert.deepEqual(models[0], first, 'Initial retired controller stays frozen after A/B/A');
      assert.deepEqual(models[1], second, 'Middle retired controller stays frozen');
      assert.deepEqual(await page.evaluate(() => window.relations.draft()), draft(), 'Returning to the original key restores only that key\'s draft');
      assert.equal((await observe(page)).jobs.filter(job => job.kind === 'save').length, 0);
    });
  }

  for (const outcome of ['success', '409']) for (const phase of ['transport', 'json']) {
    await run(`${phase}: pending settings PUT ${outcome} and post-submit edit survive locale/relations overlap exactly once`, async page => {
      await makeDirty(page);
      const old = await held(page, 'content', 1);
      await atBoundary(page, old, phase, { marker: 'obsolete' });
      await page.click(save);
      const put = await held(page, 'save', 1);
      await wait(page, () => window.relations.observe().pendingMutations === 1);
      const options = outcome === '409' ? { status: 409 } : {};
      await atBoundary(page, put, phase, options);
      await append(page, ' later');
      await wait(page, () => window.relations.draft()?.values.title === 'Synthetic site dirty later');
      for (const language of ['en', 'zh-CN']) {
        await locale(page, language);
        assert.equal(await page.evaluate(() => window.relations.same()), true);
        assert.equal(await page.$eval(save, node => node.disabled), true, 'Only the pending save owns busy');
        assert.deepEqual(await page.evaluate(() => window.relations.draft()), draft('Synthetic site dirty later'));
      }
      assert.deepEqual(put.body, { revision: 'settings-r1', changes: { title: 'Synthetic site dirty' }, saveMode: 'local' }, 'PUT carries the submitted snapshot and original revision');
      assert.deepEqual(readCounts(await observe(page)), { settings: 1, saves: 1 }, 'Locale neither replays PUT nor refetches settings');
      await finishBoundary(page, old, phase, { marker: 'obsolete' });
      // Real InflightQuery gates replacement transports behind pending mutations.
      assert.equal((await observe(page)).jobs.filter(job => job.kind === 'content').length, 1);
      await finishBoundary(page, put, phase, options);
      await completed(page, 'save', 1);
      const current = await held(page, 'content', 2);
      await release(page, current.id);
      await idle(page);
      await latest(page);
      assert.equal(await page.evaluate(() => window.relations.same()), true);
      assert.equal(await page.$eval(input, node => node.value), 'Synthetic site dirty later');
      assert.equal(await page.$eval(save, node => node.disabled), false);
      const original = outcome === 'success' ? { ...baseline, title: 'Synthetic site dirty' } : baseline;
      assert.deepEqual(await page.evaluate(() => window.relations.draft()), draft('Synthetic site dirty later', original, outcome === 'success' ? 'settings-r2' : 'settings-r1'), 'Success advances only submitted baseline; conflict adopts no server revision; later edits stay dirty');
      if (outcome === '409') assert.equal(await page.$eval(`${section} > [role="alert"]`, node => node.textContent.includes('Synthetic current failure')), true);
      assert.deepEqual(readCounts(await observe(page)), { settings: 1, saves: 1 });
    });
  }

  return { realmCount: designedCases.length, designedCases };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const executablePath = process.env.STUDIO_TEST_BROWSER || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to Chrome/Chromium.');
  const browser = await puppeteer.launch({ headless: true, executablePath });
  try {
    const result = await checkSettingsRelationsOwnership(browser);
    console.log(JSON.stringify({ fixture: 'settings-relations-ownership', realmCount: result.realmCount }));
    console.log('PASS: Settings relations locale/invocation ownership, actual retry, retired models, drafts and save isolation (synthetic scheduling; not cross-session/transport recovery or visual/native acceptance).');
  } finally { await browser.close(); }
}
